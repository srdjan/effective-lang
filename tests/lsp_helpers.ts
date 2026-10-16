// An in-process harness for the language server: a memory file system with
// absolute paths, a manual scheduler, and recorders for the sent messages, the
// exit codes, and stderr. `deliver` frames each message, decodes it, and calls
// the server as the stdio loop does.

import type { CliFs } from "../src/cli/io.ts";
import type { ReadError, Result } from "../src/core/source.ts";
import {
  FrameDecoder,
  type OutgoingMessage,
  type ResponseMessage,
} from "../src/lsp/jsonrpc.ts";
import { pathToUri } from "../src/lsp/positions.ts";
import type {
  LogMessageParams,
  PublishDiagnosticsParams,
} from "../src/lsp/protocol.ts";
import {
  LanguageServer,
  type RequestHandler,
  type ServerPorts,
} from "../src/lsp/server.ts";
import { memoryIo } from "./cli_helpers.ts";
import { FIXTURES } from "./helpers.ts";

/** Where the harness puts the example project. */
export const ROOT = "/work/examples";

function readTree(url: URL, prefix: string, out: Record<string, string>): void {
  for (const entry of Deno.readDirSync(url)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), url);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory) readTree(child, `${name}/`, out);
    else out[name] = Deno.readTextFileSync(child);
  }
}

let cachedExamples: Record<string, string> | undefined;

/** The files of `fixtures/examples`, by root-relative path. */
export function exampleFiles(): Readonly<Record<string, string>> {
  if (cachedExamples === undefined) {
    cachedExamples = {};
    readTree(new URL("examples/", FIXTURES), "", cachedExamples);
  }
  return cachedExamples;
}

/** The file URI of an absolute path. */
export function uriOf(absolute: string): string {
  const uri = pathToUri(absolute);
  if (uri === undefined) throw new Error(`not absolute: ${absolute}`);
  return uri;
}

/** The URI of a file of the example project. */
export function exampleUri(path: string, root = ROOT): string {
  return uriOf(`${root}/${path}`);
}

export interface Timer {
  readonly callback: () => void;
  readonly ms: number;
  cancelled: boolean;
  fired: boolean;
}

export interface Harness {
  readonly server: LanguageServer;
  /** Every message the server sent, in order. */
  readonly sent: OutgoingMessage[];
  readonly stderr: string[];
  readonly exits: number[];
  readonly timers: Timer[];
  /** Every file by full path. A test may change it between messages. */
  readonly files: Map<string, string>;
  /** Paths whose read throws. */
  readonly throwOnRead: Set<string>;
  /** Frames the messages, decodes them, calls `handle` for each, then `afterBatch`. */
  deliver(...messages: readonly unknown[]): void;
  /** Runs each timer that is not cancelled and not yet fired. */
  runTimers(): void;
  /** Forgets the messages sent so far. */
  clearSent(): void;
  /** The responses with this id. */
  responses(id: number | string | null): ResponseMessage[];
  /** The params of each notification with this method. */
  notifications(method: string): unknown[];
  /** The `publishDiagnostics` params sent so far, in order. */
  published(): PublishDiagnosticsParams[];
  /** The `window/logMessage` params sent so far. */
  logs(): LogMessageParams[];
  /** Sends `initialize` and `initialized`, then forgets what the server sent. */
  start(options?: unknown): void;
}

export interface HarnessOptions {
  /** Files by full path. The default is the example project under `ROOT`. */
  readonly files?: Readonly<Record<string, string>>;
  readonly extraRequests?: ReadonlyMap<string, RequestHandler>;
}

const encoder = new TextEncoder();

/** The bytes of one frame around any JSON value. */
export function frameOf(value: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(value));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  return bytes;
}

/** The example project with its files under `root`. */
export function exampleFilesAt(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(exampleFiles())) {
    files[`${root}/${path}`] = text;
  }
  return files;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const memory = memoryIo(options.files ?? exampleFilesAt(ROOT));
  const throwOnRead = new Set<string>();
  const baseFs = memory.io.fs;
  const fs: CliFs = {
    ...baseFs,
    readText(path: string): Result<string, ReadError> {
      if (throwOnRead.has(path)) throw new Error(`disk failure at ${path}`);
      return baseFs.readText(path);
    },
  };
  const sent: OutgoingMessage[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const timers: Timer[] = [];
  const ports: ServerPorts = {
    send: (message) => {
      sent.push(message);
    },
    fs,
    schedule: (callback, ms) => {
      const timer: Timer = { callback, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    exit: (code) => {
      exits.push(code);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  };
  const server = new LanguageServer(
    ports,
    options.extraRequests === undefined
      ? {}
      : { extraRequests: options.extraRequests },
  );
  const harness: Harness = {
    server,
    sent,
    stderr,
    exits,
    timers,
    files: memory.files,
    throwOnRead,
    deliver(...messages) {
      const decoder = new FrameDecoder();
      for (const message of messages) {
        for (const frame of decoder.push(frameOf(message))) {
          server.handle(frame);
        }
      }
      server.afterBatch();
    },
    runTimers() {
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.fired) continue;
        timer.fired = true;
        timer.callback();
      }
    },
    clearSent() {
      sent.length = 0;
    },
    responses(id) {
      return sent.filter((m): m is ResponseMessage =>
        "id" in m && !("method" in m) && m.id === id
      );
    },
    notifications(method) {
      return sent.flatMap((m) =>
        !("id" in m) && "method" in m && m.method === method ? [m.params] : []
      );
    },
    published() {
      return harness.notifications("textDocument/publishDiagnostics")
        .map((p) => p as PublishDiagnosticsParams);
    },
    logs() {
      return harness.notifications("window/logMessage")
        .map((p) => p as LogMessageParams);
    },
    start(initializationOptions) {
      harness.deliver(
        request(
          0,
          "initialize",
          initializationOptions === undefined
            ? { capabilities: {} }
            : { capabilities: {}, initializationOptions },
        ),
        notification("initialized", {}),
      );
      sent.length = 0;
    },
  };
  return harness;
}

// ---- Message builders -------------------------------------------------------

export function request(
  id: number | string,
  method: string,
  params?: unknown,
): unknown {
  return { jsonrpc: "2.0", id, method, params };
}

export function notification(method: string, params?: unknown): unknown {
  return { jsonrpc: "2.0", method, params };
}

export function didOpen(uri: string, version: number, text: string): unknown {
  return notification("textDocument/didOpen", {
    textDocument: { uri, languageId: "effective", version, text },
  });
}

/** A whole-text change. */
export function didChangeFull(
  uri: string,
  version: number,
  text: string,
): unknown {
  return notification("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

export function didClose(uri: string): unknown {
  return notification("textDocument/didClose", { textDocument: { uri } });
}

export function watched(
  ...events: readonly { readonly uri: string; readonly type: number }[]
): unknown {
  return notification("workspace/didChangeWatchedFiles", {
    changes: events,
  });
}

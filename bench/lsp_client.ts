// A client over a spawned language server process, for the measurements M1, M3,
// and M4 (plan section 8). It spawns `Deno.execPath()` with the arguments of
// the VS Code client. The client reads stdout from the start into a
// `FrameDecoder` and keeps reading while it sends. Otherwise a large response
// could fill the pipe and block the synchronous server. It drains stderr too.
//
// Requests, waits, and the exit all have a timeout. A failure rejects with an
// `LspClientError`, a tagged error with a clear message.

import {
  encodeMessage,
  FrameDecoder,
  type FrameError,
  type OutgoingMessage,
  type RequestId,
} from "../src/lsp/jsonrpc.ts";

type Timer = ReturnType<typeof setTimeout>;

const REPOSITORY = new URL("../", import.meta.url).pathname;

/** The default time limit of a request, a wait, or the exit, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The kinds of client failure. */
export type LspClientErrorTag =
  | "timeout"
  | "server-error"
  | "closed"
  | "write";

export class LspClientError extends Error {
  constructor(
    readonly tag: LspClientErrorTag,
    message: string,
  ) {
    super(message);
    this.name = "LspClientError";
  }
}

export function describeLspClientError(error: LspClientError): string {
  return `${error.tag}: ${error.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: LspClientError) => void;
  readonly timer: Timer;
}

interface DiagnosticsWaiter {
  readonly uri: string;
  readonly version: number;
  readonly resolve: (params: unknown) => void;
  readonly reject: (error: LspClientError) => void;
  readonly timer: Timer;
}

export interface LspClientOptions {
  /** The working directory of the server process. */
  readonly cwd?: string;
  /** The limit of each request, wait, and exit, in milliseconds. */
  readonly timeoutMs?: number;
}

/** A running server with a continuous reader on its stdout and stderr. */
export class LspClient {
  /** The frames of stdout that did not decode. Empty on a healthy run. */
  readonly frameErrors: FrameError[] = [];
  readonly #process: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #timeoutMs: number;
  readonly #pending = new Map<RequestId, Pending>();
  readonly #waiters = new Set<DiagnosticsWaiter>();
  readonly #reading: Promise<void>;
  readonly #draining: Promise<void>;
  #nextId = 1;
  #writeChain: Promise<void> = Promise.resolve();
  #closed = false;
  #stderrTail = "";

  constructor(options: LspClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#process = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--config",
        `${REPOSITORY}deno.json`,
        `${REPOSITORY}src/lsp/main.ts`,
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#writer = this.#process.stdin.getWriter();
    this.#reading = this.#read();
    this.#draining = this.#drain();
  }

  async #read(): Promise<void> {
    const decoder = new FrameDecoder();
    try {
      for await (const chunk of this.#process.stdout) {
        for (const frame of decoder.push(chunk)) {
          if (frame.ok) this.#dispatch(frame.value);
          else this.frameErrors.push(frame.error);
        }
      }
    } finally {
      this.#closed = true;
      const error = new LspClientError(
        "closed",
        `the server closed its output${this.#stderrNote()}`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      for (const waiter of this.#waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.#waiters.clear();
    }
  }

  async #drain(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.#process.stderr) {
      this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, {
        stream: true,
      })).slice(-2000);
    }
  }

  #stderrNote(): string {
    const text = this.#stderrTail.trim();
    return text === "" ? "" : `; last stderr: ${text}`;
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message)) return;
    if (typeof message.method === "string") {
      if (message.method === "textDocument/publishDiagnostics") {
        this.#publish(message.params);
      }
      return; // Other notifications and server requests need no answer here.
    }
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(
        new LspClientError(
          "server-error",
          `${pending.method} failed: ${JSON.stringify(message.error)}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #publish(params: unknown): void {
    if (!isRecord(params)) return;
    for (const waiter of this.#waiters) {
      if (params.uri === waiter.uri && params.version === waiter.version) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(params);
      }
    }
  }

  /** Writes one frame completely. Frames go out in call order. */
  notify(method: string, params?: unknown): Promise<void> {
    return this.#send(
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params },
    );
  }

  #send(message: OutgoingMessage): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new LspClientError(
          "closed",
          `the server is closed${this.#stderrNote()}`,
        ),
      );
    }
    const frame = encodeMessage(message);
    const written = this.#writeChain.then(async () => {
      try {
        await this.#writer.write(frame);
      } catch (error) {
        throw new LspClientError(
          "write",
          `cannot write to the server: ${
            error instanceof Error ? error.message : String(error)
          }${this.#stderrNote()}`,
        );
      }
    });
    this.#writeChain = written.catch(() => {});
    return written;
  }

  /** Sends a request. The promise rejects on an error response or a timeout. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new LspClientError(
            "timeout",
            `no response to ${method} within ${this.#timeoutMs} ms${this.#stderrNote()}`,
          ),
        );
      }, this.#timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    // The caller sees the rejection through the chain below. This guard keeps
    // an early timeout from counting as unhandled while the write is pending.
    response.catch(() => {});
    const sent = this.#send(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );
    return sent.then(() => response, (error) => {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
      throw error;
    });
  }

  /**
   * Registers a wait for the first `publishDiagnostics` of `uri` with
   * `version`. The registration is synchronous, so call this before the write
   * that triggers the publish. It resolves with the notification params.
   */
  waitForDiagnostics(
    uri: string,
    version: number,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closed) {
        reject(new LspClientError("closed", "the server is closed"));
        return;
      }
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(
          new LspClientError(
            "timeout",
            `no diagnostics for ${uri} version ${version} within ${timeoutMs} ms${this.#stderrNote()}`,
          ),
        );
      }, timeoutMs);
      const waiter: DiagnosticsWaiter = {
        uri,
        version,
        resolve,
        reject,
        timer,
      };
      this.#waiters.add(waiter);
    });
  }

  /** The `initialize` request and the `initialized` notification. */
  async initialize(initializationOptions: unknown): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
      initializationOptions,
    });
    await this.notify("initialized", {});
    return result;
  }

  /**
   * Sends `shutdown` and `exit`, then waits for the process. Returns the exit
   * status. A wait over the timeout kills the process and rejects.
   */
  async shutdown(): Promise<number> {
    await this.request("shutdown");
    await this.notify("exit");
    let timer: Timer | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new LspClientError(
            "timeout",
            `the server did not exit within ${this.#timeoutMs} ms`,
          ),
        );
      }, this.#timeoutMs);
    });
    try {
      const status = await Promise.race([this.#process.status, limit]);
      await this.#settle();
      return status.code;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits for the readers and closes stdin. The process has exited. */
  async #settle(): Promise<void> {
    await this.#reading;
    await this.#draining;
    try {
      await this.#writer.close();
    } catch {
      // The server already exited and closed the pipe.
    }
  }

  /** Ends the process if it still runs, and waits for its resources. */
  async dispose(): Promise<void> {
    try {
      this.#process.kill();
    } catch {
      // The process already ended.
    }
    await this.#process.status;
    await this.#settle();
  }
}

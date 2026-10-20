// The language server: lifecycle, message dispatch, and flush scheduling
// (plan 5.1, 5.4, and 5.10). The server has no I/O of its own. It reaches the
// outside through the ports of `ServerPorts`, so that tests drive it in process.
//
// The server handles one message at a time. A change marks its project dirty.
// `afterBatch` flushes after the messages of one read. A request flushes the
// project of its document first, through `ProjectSet.forRequest`.
//
// The feature handlers are in `features.ts`. This file wires them to the method
// names and sends `effective/generatedChanged` after a flush.

import type { CliFs } from "../host/io.ts";
import type { Result } from "../core/mod.ts";
import {
  definitionRequest,
  didSave,
  documentSymbolRequest,
  GeneratedTexts,
  generatedTypeScriptRequest,
  hoverRequest,
  statsRequest,
} from "./features.ts";
import {
  classifyMessage,
  ErrorCodes,
  errorResponse,
  type FrameError,
  type NotificationMessage,
  notificationMessage,
  type OutgoingMessage,
  type RequestMessage,
  successResponse,
} from "./jsonrpc.ts";
import {
  DEFAULT_INITIALIZATION_OPTIONS,
  type InitializationOptions,
  narrowDidChange,
  narrowDidChangeWatchedFiles,
  narrowDidOpen,
  type Narrowed,
  narrowInitializeParams,
  narrowPositionParams,
  narrowTextDocumentParams,
  type PublishDiagnosticsParams,
  SERVER_CAPABILITIES,
} from "./protocol.ts";
import { GENERATED_TYPESCRIPT_METHOD, STATS_METHOD } from "./methods.ts";
import {
  type FlushOutcome,
  type LogType,
  ProjectSet,
  type ProjectState,
} from "./projects.ts";

/** The ports of the server. */
export interface ServerPorts {
  /** Sends one message to the client. */
  send(message: OutgoingMessage): void;
  readonly fs: CliFs;
  /** Runs `callback` after `ms` milliseconds. Returns a function that cancels it. */
  schedule(callback: () => void, ms: number): () => void;
  /** Ends the process. */
  exit(code: number): void;
  /** Writes text to stderr as given. */
  stderr(text: string): void;
  /** The memory use of the process, in bytes. */
  memory(): { readonly rss: number; readonly heapUsed: number };
}

/** What a handler can read and do. */
export interface ServerContext {
  readonly projects: ProjectSet;
  readonly fs: CliFs;
  /** The generated TypeScript of the subscribed modules. */
  readonly generated: GeneratedTexts;
  /** The memory use of the process, in bytes. */
  memory(): { readonly rss: number; readonly heapUsed: number };
  /** The options from `initialize`. */
  readonly options: InitializationOptions;
  log(type: LogType, message: string): void;
  notify(method: string, params: unknown): void;
}

/** A failed request: the code and the message of the error response. */
export interface RequestFailure {
  readonly code: number;
  readonly message: string;
}

export type RequestHandler = (
  params: unknown,
  ctx: ServerContext,
) => Result<unknown, RequestFailure>;

/** A failed notification: the text goes to stderr and the notification is dropped. */
type NotificationHandler = (
  params: unknown,
  ctx: ServerContext,
) => Result<void, string>;

/** Runs `use` on narrowed params. A narrowing error becomes -32602. */
export function withParams<T>(
  narrow: (params: unknown) => Narrowed<T>,
  use: (value: T, ctx: ServerContext) => Result<unknown, RequestFailure>,
): RequestHandler {
  return (params, ctx) => {
    const narrowed = narrow(params);
    if (!narrowed.ok) {
      return {
        ok: false,
        error: { code: ErrorCodes.invalidParams, message: narrowed.error },
      };
    }
    return use(narrowed.value, ctx);
  };
}

function withNotificationParams<T>(
  narrow: (params: unknown) => Narrowed<T>,
  use: (value: T, ctx: ServerContext) => void,
): NotificationHandler {
  return (params, ctx) => {
    const narrowed = narrow(params);
    if (!narrowed.ok) return narrowed;
    use(narrowed.value, ctx);
    return { ok: true, value: undefined };
  };
}

/**
 * The request table. `initialize` and `shutdown` have their own code in the
 * lifecycle.
 */
const REQUEST_HANDLERS: ReadonlyMap<string, RequestHandler> = new Map<
  string,
  RequestHandler
>([
  ["textDocument/hover", withParams(narrowPositionParams, hoverRequest)],
  [
    "textDocument/definition",
    withParams(narrowPositionParams, definitionRequest),
  ],
  [
    "textDocument/documentSymbol",
    withParams(narrowTextDocumentParams, documentSymbolRequest),
  ],
  [
    GENERATED_TYPESCRIPT_METHOD,
    withParams(narrowTextDocumentParams, generatedTypeScriptRequest),
  ],
  [STATS_METHOD, withParams(narrowTextDocumentParams, statsRequest)],
]);

const NOTIFICATION_HANDLERS: ReadonlyMap<string, NotificationHandler> = new Map<
  string,
  NotificationHandler
>([
  [
    "textDocument/didOpen",
    withNotificationParams(
      narrowDidOpen,
      (params, ctx) => ctx.projects.didOpen(params),
    ),
  ],
  [
    "textDocument/didChange",
    withNotificationParams(
      narrowDidChange,
      (params, ctx) => ctx.projects.didChange(params),
    ),
  ],
  [
    "textDocument/didClose",
    withNotificationParams(
      narrowTextDocumentParams,
      (params, ctx) => ctx.projects.didClose(params.textDocument.uri),
    ),
  ],
  [
    "textDocument/didSave",
    withNotificationParams(narrowTextDocumentParams, didSave),
  ],
  [
    "workspace/didChangeWatchedFiles",
    withNotificationParams(
      narrowDidChangeWatchedFiles,
      (params, ctx) => ctx.projects.didChangeWatchedFiles(params.changes),
    ),
  ],
]);

type Phase = "uninitialized" | "running" | "shutdown";

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ServerOptions {
  /** Request handlers added to the table. A test hook. */
  readonly extraRequests?: ReadonlyMap<string, RequestHandler>;
}

export class LanguageServer {
  #phase: Phase = "uninitialized";
  #options: InitializationOptions = DEFAULT_INITIALIZATION_OPTIONS;
  #cancelFlush: (() => void) | undefined;
  readonly #projects: ProjectSet;
  readonly #generated = new GeneratedTexts();
  readonly #requests: ReadonlyMap<string, RequestHandler>;
  readonly #context: ServerContext;

  constructor(
    private readonly ports: ServerPorts,
    serverOptions: ServerOptions = {},
  ) {
    this.#requests = new Map([
      ...REQUEST_HANDLERS,
      ...(serverOptions.extraRequests ?? []),
    ]);
    this.#projects = new ProjectSet({
      fs: ports.fs,
      publish: (params: PublishDiagnosticsParams) =>
        this.#notify("textDocument/publishDiagnostics", params),
      log: (type, message) => this.#log(type, message),
      stderr: (text) => this.#stderr(text),
      flushed: (project, outcome) => this.#flushed(project, outcome),
    });
    const currentOptions = (): InitializationOptions => this.#options;
    this.#context = {
      projects: this.#projects,
      fs: ports.fs,
      generated: this.#generated,
      memory: () => ports.memory(),
      get options() {
        return currentOptions();
      },
      log: (type, message) => this.#log(type, message),
      notify: (method, params) => this.#notify(method, params),
    };
  }

  /** True after the client sent `shutdown`. The entry reads it at end of input. */
  get shutdownSeen(): boolean {
    return this.#phase === "shutdown";
  }

  /** The projects, for tests. */
  get projects(): ProjectSet {
    return this.#projects;
  }

  /** Handles one decoded frame or one frame error. */
  handle(frame: Result<unknown, FrameError>): void {
    if (!frame.ok) {
      if (frame.error.tag === "bad-json") {
        this.ports.send(
          errorResponse(null, ErrorCodes.parseError, frame.error.message),
        );
      } else {
        this.#stderr(`bad frame header: ${frame.error.message}`);
      }
      return;
    }
    const message = classifyMessage(frame.value);
    switch (message.tag) {
      case "invalid":
        this.ports.send(
          errorResponse(message.id, ErrorCodes.invalidRequest, message.reason),
        );
        return;
      case "response":
        return; // The server sends no request, so no response is expected.
      case "request":
        this.#handleRequest(message.message);
        return;
      case "notification":
        this.#handleNotification(message.message);
        return;
    }
  }

  /** Call after the messages of one read. Plan 5.4. */
  afterBatch(): void {
    if (this.#phase !== "running") return;
    if (this.#projects.dirtyProjects().length === 0) return;
    const wait = this.#options.debounceMs;
    if (wait === 0) {
      this.#cancelPending();
      this.#contain("flush", () => this.#projects.flushDirty());
      return;
    }
    this.#cancelPending();
    this.#cancelFlush = this.ports.schedule(() => {
      this.#cancelFlush = undefined;
      if (this.#phase !== "running") return;
      this.#contain("flush", () => this.#projects.flushDirty());
    }, wait);
  }

  // ---- Requests -----------------------------------------------------------

  #handleRequest(request: RequestMessage): void {
    const { id, method } = request;
    const fail = (code: number, message: string) =>
      this.ports.send(errorResponse(id, code, message));
    switch (this.#phase) {
      case "uninitialized":
        if (method !== "initialize") {
          fail(
            ErrorCodes.serverNotInitialized,
            "the server is not initialized",
          );
          return;
        }
        this.#initialize(request);
        return;
      case "shutdown":
        fail(ErrorCodes.invalidRequest, "the server is shut down");
        return;
      case "running":
        break;
    }
    if (method === "initialize") {
      fail(ErrorCodes.invalidRequest, "initialize was already called");
      return;
    }
    if (method === "shutdown") {
      this.#cancelPending();
      this.#phase = "shutdown";
      this.ports.send(successResponse(id, null));
      return;
    }
    const handler = this.#requests.get(method);
    if (handler === undefined) {
      fail(ErrorCodes.methodNotFound, `method not found: ${method}`);
      return;
    }
    try {
      const result = handler(request.params, this.#context);
      this.ports.send(
        result.ok
          ? successResponse(id, result.value)
          : errorResponse(id, result.error.code, result.error.message),
      );
    } catch (error) {
      this.#stderr(`request ${method} failed: ${describeError(error)}`);
      this.ports.send(
        errorResponse(id, ErrorCodes.internalError, messageOf(error)),
      );
    }
  }

  #initialize(request: RequestMessage): void {
    const narrowed = narrowInitializeParams(request.params);
    if (!narrowed.ok) {
      this.ports.send(
        errorResponse(request.id, ErrorCodes.invalidParams, narrowed.error),
      );
      return;
    }
    this.#options = narrowed.value.options;
    this.#phase = "running";
    this.ports.send(successResponse(request.id, {
      capabilities: SERVER_CAPABILITIES,
      serverInfo: { name: "effective" },
    }));
    for (const warning of narrowed.value.warnings) this.#log(2, warning);
  }

  // ---- Notifications ------------------------------------------------------

  #handleNotification(notification: NotificationMessage): void {
    const { method } = notification;
    if (method === "exit") {
      this.ports.exit(this.#phase === "shutdown" ? 0 : 1);
      return;
    }
    if (this.#phase !== "running") return;
    if (method === "initialized" || method.startsWith("$/")) return;
    const handler = NOTIFICATION_HANDLERS.get(method);
    if (handler === undefined) return;
    this.#contain(method, () => {
      const result = handler(notification.params, this.#context);
      if (!result.ok) {
        this.#stderr(`${method}: invalid params: ${result.error}`);
      }
    });
  }

  // ---- Helpers ------------------------------------------------------------

  /** The only exception boundary of notifications and flushes. */
  #contain(label: string, body: () => void): void {
    try {
      body();
    } catch (error) {
      this.#stderr(`${label} failed: ${describeError(error)}`);
    }
  }

  #cancelPending(): void {
    this.#cancelFlush?.();
    this.#cancelFlush = undefined;
  }

  /** Sends `effective/generatedChanged` for the subscribed modules that changed. */
  #flushed(project: ProjectState, outcome: FlushOutcome): void {
    this.#generated.afterFlush(
      project,
      outcome,
      (method, params) => this.#notify(method, params),
    );
  }

  #notify(method: string, params: unknown): void {
    this.ports.send(notificationMessage(method, params));
  }

  #log(type: LogType, message: string): void {
    this.#notify("window/logMessage", { type, message });
  }

  #stderr(text: string): void {
    this.ports.stderr(`${text}\n`);
  }
}

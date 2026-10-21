// The edit script and the server session that M1, M3, and M4 share (plan
// section 8). An input is a project: the five examples or a synthetic size. A
// session is one server process on a temporary copy of the project. It opens
// the requested documents, waits for their first diagnostics, and then replays
// one edit per step as a full-text `didChange`.
//
// Gate: after every step the diagnostics of the edited file must be an empty
// list. Any other list stops the run with an error value. This is the
// checksum-like gate of the protocol.

import { errorMessage } from "../src/core/mod.ts";
import type { Result } from "../src/core/source.ts";
import { STATS_METHOD } from "../src/lsp/methods.ts";
import {
  allFiles,
  applyAliasEdit,
  applyBodyEdit,
  applyExamplesBodyEdit,
  applyInterfaceEdit,
  applyModeFlipEdit,
  generateSize,
  type SizeName,
} from "./generate.ts";
import {
  describeLspClientError,
  LspClient,
  LspClientError,
} from "./lsp_client.ts";

// ------------------------------------------------------------------ errors

export type LspBenchError =
  | { readonly tag: "setup"; readonly message: string }
  | { readonly tag: "server"; readonly message: string }
  | {
    readonly tag: "diagnostics";
    readonly where: string;
    readonly count: number;
    readonly first: string;
  }
  | { readonly tag: "edit"; readonly kind: EditKind; readonly message: string }
  | { readonly tag: "hover-null"; readonly where: string }
  | { readonly tag: "protocol"; readonly message: string };

export function describeLspBenchError(error: LspBenchError): string {
  switch (error.tag) {
    case "setup":
      return `setup failed: ${error.message}`;
    case "server":
      return `server failure: ${error.message}`;
    case "diagnostics":
      return `${error.where} gave ${error.count} diagnostics, first: ${error.first}`;
    case "edit":
      return `the ${error.kind} edit failed: ${error.message}`;
    case "hover-null":
      return `${error.where}: the hover result is null`;
    case "protocol":
      return `unexpected server reply: ${error.message}`;
  }
}

function fail<T>(error: LspBenchError): Result<T, LspBenchError> {
  return { ok: false, error };
}

function succeed<T>(value: T): Result<T, LspBenchError> {
  return { ok: true, value };
}

/** Maps a client failure to an error value. Other exceptions propagate. */
function serverError(error: unknown): LspBenchError {
  if (error instanceof LspClientError) {
    return { tag: "server", message: describeLspClientError(error) };
  }
  throw error;
}

// ------------------------------------------------------------------ inputs

export type LspInputName = "examples" | SizeName;

export type EditKind = "body" | "header" | "alias" | "flip";

/** The four kinds in the order that M4 cycles them. */
export const EDIT_KINDS: readonly EditKind[] = [
  "body",
  "header",
  "alias",
  "flip",
];

export interface LspInput {
  readonly name: LspInputName;
  /** Every file of the project by root-relative path, host modules included. */
  readonly files: ReadonlyMap<string, string>;
  /** The edited module. */
  readonly editPath: string;
  /** The function that the hover round trip names. */
  readonly hoverName: string;
  /** The edit kinds that apply to this input. */
  readonly kinds: readonly EditKind[];
}

function readTree(
  root: URL,
  prefix: string,
  into: Map<string, string>,
): void {
  for (const entry of Deno.readDirSync(root)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), root);
    if (entry.isDirectory) readTree(child, `${prefix}${entry.name}/`, into);
    else into.set(`${prefix}${entry.name}`, Deno.readTextFileSync(child));
  }
}

/** Loads an input. The examples come from `fixtures/examples`. */
export function loadInput(name: LspInputName, seed: number): LspInput {
  if (name === "examples") {
    const files = new Map<string, string>();
    readTree(new URL("../fixtures/examples/", import.meta.url), "", files);
    return {
      name,
      files,
      editPath: "users.eff",
      hoverName: "displayName",
      kinds: ["body"],
    };
  }
  const project = generateSize(name, seed);
  return {
    name,
    files: allFiles(project),
    editPath: project.edit.path,
    hoverName: "bump",
    kinds: EDIT_KINDS,
  };
}

/**
 * The next text of the edited module. `revision` is a number that is new at
 * every step, so a body edit always changes the text.
 */
export function applyEdit(
  input: LspInput,
  kind: EditKind,
  text: string,
  revision: number,
): Result<string, LspBenchError> {
  if (!input.kinds.includes(kind)) {
    return fail({
      tag: "edit",
      kind,
      message: `the input ${input.name} has no ${kind} edit`,
    });
  }
  let next: string;
  if (input.name === "examples") {
    next = applyExamplesBodyEdit(text, revision);
  } else {
    switch (kind) {
      case "body":
        next = applyBodyEdit(text, revision);
        break;
      case "header":
        next = applyInterfaceEdit(text);
        break;
      case "alias":
        next = applyAliasEdit(text);
        break;
      case "flip":
        next = applyModeFlipEdit(text);
        break;
    }
  }
  return next === text
    ? fail({ tag: "edit", kind, message: "the edit did not change the text" })
    : succeed(markRevision(next, revision));
}

/** One marker per document makes every submitted revision distinct without growing its text. */
function markRevision(text: string, revision: number): string {
  const body = text.replace(/\n\/\/ effective-bench revision \d+\n?$/, "");
  return `${body}\n// effective-bench revision ${revision}\n`;
}

/** Companion feature modules have a fixed, annotated `link` body we can edit. */
export function applyCompanionEdit(text: string, revision: number): string {
  const next = text.replace(
    /(export const link\d+ = \(n: Int\): Int => n \+ )\d+/,
    `$1${revision}`,
  );
  // Small inputs also open base/app modules without that body; their edits are comments.
  return markRevision(next, revision);
}

// ------------------------------------------------------------------ temporary projects

/** The prefix of every temporary directory of the harness. */
export const TEMP_PREFIX = "effective-bench-lsp-";

function writeProject(
  files: ReadonlyMap<string, string>,
): Result<string, LspBenchError> {
  const dir = Deno.makeTempDirSync({ prefix: TEMP_PREFIX });
  try {
    for (const [path, text] of files) {
      const full = `${dir}/${path}`;
      Deno.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      Deno.writeTextFileSync(full, text);
    }
  } catch (e) {
    Deno.removeSync(dir, { recursive: true });
    return fail({
      tag: "setup",
      message: errorMessage(e),
    });
  }
  return succeed(dir);
}

// ------------------------------------------------------------------ session

/** The numbers of one `effective/stats` reply that the measurements use. */
export interface StepStats {
  readonly parses: number;
  readonly checks: number;
  readonly lowerings: number;
  readonly emits: number;
  /** The number of modules in the interface delta of the last flush. */
  readonly interfaceChanged: number;
  /** The number of modules in the mode delta of the last flush. */
  readonly modeChanged: number;
  readonly rss: number;
  /** Null only for older stats producers that omit this metric. */
  readonly heapUsed: number | null;
  readonly typeTableSize: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Narrows a stats reply. */
export function parseStats(value: unknown): Result<StepStats, LspBenchError> {
  const bad = (message: string) =>
    fail<StepStats>({ tag: "protocol", message });
  if (!isRecord(value)) return bad("stats is not an object");
  const { counts, delta, memory, typeTableSize } = value;
  if (!isRecord(counts) || !isRecord(delta) || !isRecord(memory)) {
    return bad("stats lacks counts, delta, or memory");
  }
  const { parses, checks, lowerings, emits } = counts;
  const { interfaceChanged, modeChanged } = delta;
  const { rss, heapUsed } = memory;
  if (
    typeof parses !== "number" || typeof checks !== "number" ||
    typeof lowerings !== "number" || typeof emits !== "number" ||
    typeof rss !== "number" || !Number.isFinite(rss) || rss < 0 ||
    !isStringArray(interfaceChanged) ||
    !isStringArray(modeChanged)
  ) {
    return bad("stats has a field of the wrong type");
  }
  for (
    const [name, metric] of [["heapUsed", heapUsed], [
      "typeTableSize",
      typeTableSize,
    ]]
  ) {
    if (
      metric !== undefined &&
      (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)
    ) {
      return bad(`stats ${name} is not a finite nonnegative number`);
    }
  }
  if (typeof typeTableSize === "number" && !Number.isInteger(typeTableSize)) {
    return bad("stats typeTableSize is not an integer");
  }
  return succeed({
    parses,
    checks,
    lowerings,
    emits,
    interfaceChanged: interfaceChanged.length,
    modeChanged: modeChanged.length,
    rss,
    heapUsed: typeof heapUsed === "number" ? heapUsed : null,
    typeTableSize: typeof typeTableSize === "number" ? typeTableSize : null,
  });
}

function positionOf(
  text: string,
  offset: number,
): { line: number; character: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

/** One server process on a temporary copy of one input. */
export class Session {
  readonly #client: LspClient;
  readonly #input: LspInput;
  readonly #uri: string;
  readonly #timeoutMs: number;
  #text: string;
  #version = 1;
  /** Starts at 1, so the first body edit writes 2: the generated literal is 1. */
  #revision = 1;
  readonly #companions = new Map<
    string,
    { uri: string; text: string; version: number }
  >();
  readonly #editCounts = new Map<string, number>();

  private constructor(
    client: LspClient,
    input: LspInput,
    uri: string,
    timeoutMs: number,
  ) {
    this.#client = client;
    this.#input = input;
    this.#uri = uri;
    this.#timeoutMs = timeoutMs;
    this.#text = input.files.get(input.editPath) ?? "";
    this.#editCounts.set(input.editPath, 0);
  }

  /**
   * Starts a server on the project at `dir`, initializes it, opens all requested
   * documents, and waits for each one's first diagnostics. The caller owns `dir`.
   */
  static async start(
    dir: string,
    input: LspInput,
    timeoutMs: number,
    openPaths: readonly string[] = [input.editPath],
  ): Promise<
    Result<{ session: Session; client: LspClient }, LspBenchError>
  > {
    for (const path of openPaths) {
      if (!path.endsWith(".eff") || !input.files.has(path)) {
        return fail({ tag: "setup", message: `no source document ${path}` });
      }
    }
    const client = new LspClient({ cwd: dir, timeoutMs });
    const uri = new URL(`file://${dir}/${input.editPath}`).href;
    const session = new Session(client, input, uri, timeoutMs);
    try {
      await client.initialize({ writeOnSave: false, debounceMs: 0 });
      for (const path of new Set([input.editPath, ...openPaths])) {
        const documentUri = new URL(`file://${dir}/${path}`).href;
        const text = input.files.get(path) ?? "";
        const first = client.waitForDiagnostics(documentUri, 1, timeoutMs);
        first.catch(() => {});
        await client.notify("textDocument/didOpen", {
          textDocument: {
            uri: documentUri,
            languageId: "effective",
            version: 1,
            text,
          },
        });
        const gate = session.#gate(
          await first,
          `the first diagnostics of ${path}`,
        );
        if (!gate.ok) {
          await client.dispose();
          return gate;
        }
        if (path !== input.editPath) {
          session.#companions.set(path, { uri: documentUri, text, version: 1 });
          session.#editCounts.set(path, 0);
        }
      }
      return succeed({ session, client });
    } catch (e) {
      await client.dispose();
      return fail(serverError(e));
    }
  }

  #gate(params: unknown, where: string): Result<null, LspBenchError> {
    if (!isRecord(params) || !Array.isArray(params.diagnostics)) {
      return fail({
        tag: "protocol",
        message: "publishDiagnostics has no list",
      });
    }
    if (params.diagnostics.length === 0) return succeed(null);
    const first = params.diagnostics[0];
    return fail({
      tag: "diagnostics",
      where,
      count: params.diagnostics.length,
      first: isRecord(first) ? String(first.message) : "",
    });
  }

  /**
   * One edit step. Sends one full-text `didChange` with the next version and
   * returns the time in milliseconds from just before the write to the receipt
   * of the matching `publishDiagnostics`.
   */
  async step(
    kind: EditKind,
    path = this.#input.editPath,
  ): Promise<Result<number, LspBenchError>> {
    const companion = this.#companions.get(path);
    if (
      path !== this.#input.editPath &&
      (companion === undefined || kind !== "body")
    ) {
      return fail({
        tag: "edit",
        kind,
        message: `no ${kind} edit for ${path}`,
      });
    }
    const next = companion === undefined
      ? applyEdit(this.#input, kind, this.#text, ++this.#revision)
      : succeed(applyCompanionEdit(companion.text, ++this.#revision));
    if (!next.ok) return next;
    const version = (companion?.version ?? this.#version) + 1;
    const uri = companion?.uri ?? this.#uri;
    const waiting = this.#client.waitForDiagnostics(
      uri,
      version,
      this.#timeoutMs,
    );
    waiting.catch(() => {});
    try {
      const start = performance.now();
      await this.#client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: next.value }],
      });
      const params = await waiting;
      const elapsed = performance.now() - start;
      if (companion === undefined) {
        this.#text = next.value;
        this.#version = version;
      } else {
        companion.text = next.value;
        companion.version = version;
      }
      this.#editCounts.set(path, (this.#editCounts.get(path) ?? 0) + 1);
      const gate = this.#gate(params, `${kind} edit, version ${version}`);
      return gate.ok ? succeed(elapsed) : gate;
    } catch (e) {
      return fail(serverError(e));
    }
  }

  /** Successful submissions, each with a unique global revision marker. */
  get editCounts(): ReadonlyMap<string, number> {
    return this.#editCounts;
  }

  /** One hover round trip on the fixed function name. The result must not be null. */
  async hover(): Promise<Result<number, LspBenchError>> {
    const declaration = `export const ${this.#input.hoverName} `;
    const at = this.#text.indexOf(declaration);
    if (at < 0) {
      return fail({
        tag: "setup",
        message: `no declaration of ${this.#input.hoverName}`,
      });
    }
    const position = positionOf(this.#text, at + "export const ".length + 1);
    try {
      const start = performance.now();
      const result = await this.#client.request("textDocument/hover", {
        textDocument: { uri: this.#uri },
        position,
      });
      const elapsed = performance.now() - start;
      return result === null
        ? fail({
          tag: "hover-null",
          where: `hover on ${this.#input.hoverName}`,
        })
        : succeed(elapsed);
    } catch (e) {
      return fail(serverError(e));
    }
  }

  /** The stats of the project of the edited document. */
  async stats(): Promise<Result<StepStats, LspBenchError>> {
    try {
      const reply = await this.#client.request(STATS_METHOD, {
        textDocument: { uri: this.#uri },
      });
      return parseStats(reply);
    } catch (e) {
      return fail(serverError(e));
    }
  }

  /** Shuts the server down. The exit code must be 0 and stdout must be all frames. */
  async finish(): Promise<Result<null, LspBenchError>> {
    try {
      const code = await this.#client.shutdown();
      if (code !== 0) {
        return fail({ tag: "server", message: `exit code ${code}` });
      }
      if (this.#client.frameErrors.length > 0) {
        return fail({
          tag: "protocol",
          message: `stdout held ${this.#client.frameErrors.length} bad frames`,
        });
      }
      return succeed(null);
    } catch (e) {
      return fail(serverError(e));
    }
  }
}

// ------------------------------------------------------------------ workspace

/**
 * The temporary directories and servers of one measurement. `dispose` ends the
 * servers and removes the directories. It is safe to call twice, and it runs
 * on failure too.
 */
export class Workspace {
  readonly #dirs: string[] = [];
  readonly #clients: LspClient[] = [];
  readonly #sessions: Session[] = [];

  /** Writes a copy of the input to a new temporary directory and starts a session on it. */
  async open(
    input: LspInput,
    timeoutMs: number,
    openPaths?: readonly string[],
  ): Promise<Result<Session, LspBenchError>> {
    const written = writeProject(input.files);
    if (!written.ok) return written;
    this.#dirs.push(written.value);
    const started = await Session.start(
      written.value,
      input,
      timeoutMs,
      openPaths,
    );
    if (!started.ok) return started;
    this.#clients.push(started.value.client);
    this.#sessions.push(started.value.session);
    return succeed(started.value.session);
  }

  /** Shuts down every session in order. */
  async finish(): Promise<Result<null, LspBenchError>> {
    for (const session of this.#sessions) {
      const done = await session.finish();
      if (!done.ok) return done;
    }
    return succeed(null);
  }

  async dispose(): Promise<void> {
    for (const client of this.#clients.splice(0)) await client.dispose();
    this.#sessions.length = 0;
    for (const dir of this.#dirs.splice(0)) {
      Deno.removeSync(dir, { recursive: true });
    }
  }
}

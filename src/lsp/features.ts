// The request handlers of the language features (plan 5.6 to 5.9 and 5.11):
// hover, definition, document symbols, generated TypeScript, save, and stats.
// Each handler calls `ctx.projects.forRequest`, which flushes a dirty project
// first, so that no answer comes from an old revision.
//
// This file imports only types from `server.ts`. The server imports the values
// of this file, so a value import back would form a cycle.

import { writeGenerated } from "../host/outputs.ts";
import {
  definitionAt,
  documentSymbols,
  type EditorSymbol,
  type EditorSymbolKind,
  hoverAt,
  joinPath,
  lineStarts,
  type Result,
  type Revision,
  type Span,
} from "../core/mod.ts";
import { pathToUri, positionToOffset, spanToRange } from "./positions.ts";
import type {
  DocumentSymbol,
  GeneratedChangedParams,
  GeneratedTypeScriptResult,
  Hover,
  Location,
  PositionParams,
  Range,
  StatsResult,
  TextDocumentParams,
} from "./protocol.ts";
import { GENERATED_CHANGED_METHOD } from "./methods.ts";
import { SymbolKind } from "./protocol.ts";
import type { ProjectState } from "./projects.ts";
import type { RequestFailure, ServerContext } from "./server.ts";

type Answer = Result<unknown, RequestFailure>;

function answer(value: unknown): Answer {
  return { ok: true, value };
}

/** The module name of the `.eff` file `path` in the revision, or undefined. */
function effModuleOf(revision: Revision, path: string): string | undefined {
  for (const [name, info] of revision.project.modules) {
    if (info.path === path && info.mode === "eff") return name;
  }
  return undefined;
}

/** The range of a span, against the text that the revision used for the span's file. */
function rangeOfSpan(revision: Revision, span: Span): Range | undefined {
  const text = revision.sourceTexts().get(span.source);
  if (text === undefined) return undefined;
  return spanToRange(text, lineStarts(text), span);
}

/** The place of a request: the project, its newest good revision, the file, and the offset. */
interface Cursor {
  readonly project: ProjectState;
  readonly revision: Revision;
  readonly path: string;
  readonly offset: number;
}

/** The cursor of a position request, or undefined when there is no good revision or text. */
function cursorOf(
  params: PositionParams,
  ctx: ServerContext,
): Cursor | undefined {
  const found = ctx.projects.forRequest(params.textDocument.uri);
  const revision = found?.project.lastGood;
  if (found === undefined || revision === undefined) return undefined;
  const text = revision.sourceTexts().get(found.path);
  if (text === undefined) return undefined;
  const offset = positionToOffset(text, lineStarts(text), params.position);
  return { project: found.project, revision, path: found.path, offset };
}

// ---- Hover ------------------------------------------------------------------

function fenced(language: string, body: string): string {
  return "```" + language + "\n" + body + "\n```";
}

/** `textDocument/hover` (plan 5.6). */
export function hoverRequest(
  params: PositionParams,
  ctx: ServerContext,
): Answer {
  const cursor = cursorOf(params, ctx);
  if (cursor === undefined) return answer(null);
  const { revision } = cursor;
  const hit = hoverAt(revision, cursor.path, cursor.offset);
  if (hit === undefined) return answer(null);
  const range = rangeOfSpan(revision, hit.span);
  if (range === undefined) return answer(null);
  let value = fenced("effective", hit.contract);
  if (hit.backend?.tag === "type") {
    value += "\n\n" + fenced("typescript", hit.backend.text);
  } else if (hit.backend?.tag === "unavailable") {
    value += "\n\nbackend type: not available while the module has errors";
  }
  const result: Hover = { contents: { kind: "markdown", value }, range };
  return answer(result);
}

// ---- Definition -------------------------------------------------------------

/** `textDocument/definition` (plan 5.7). */
export function definitionRequest(
  params: PositionParams,
  ctx: ServerContext,
): Answer {
  const cursor = cursorOf(params, ctx);
  if (cursor === undefined) return answer(null);
  const { revision } = cursor;
  const span = definitionAt(revision, cursor.path, cursor.offset);
  if (span === undefined) return answer(null);
  const range = rangeOfSpan(revision, span);
  const uri = pathToUri(joinPath(cursor.project.root, span.source));
  if (range === undefined || uri === undefined) return answer(null);
  const location: Location = { uri, range };
  return answer(location);
}

// ---- Document symbols -------------------------------------------------------

const SYMBOL_KINDS: Readonly<Record<EditorSymbolKind, number>> = {
  function: SymbolKind.Function,
  constant: SymbolKind.Constant,
  type: SymbolKind.Struct,
  error: SymbolKind.Class,
  service: SymbolKind.Interface,
  method: SymbolKind.Method,
  provider: SymbolKind.Variable,
};

function convertSymbol(
  symbol: EditorSymbol,
  text: string,
  starts: Uint32Array,
): DocumentSymbol {
  const base = {
    name: symbol.name,
    kind: SYMBOL_KINDS[symbol.kind],
    range: spanToRange(text, starts, symbol.span),
    selectionRange: spanToRange(text, starts, symbol.nameSpan),
  };
  return symbol.children.length === 0 ? base : {
    ...base,
    children: symbol.children.map((child) =>
      convertSymbol(child, text, starts)
    ),
  };
}

/**
 * `textDocument/documentSymbol` (plan 5.7). The text is the open document, else
 * the disk text, else the text of the revision. Without a revision, the file is
 * parsed on its own.
 */
export function documentSymbolRequest(
  params: TextDocumentParams,
  ctx: ServerContext,
): Answer {
  const found = ctx.projects.forRequest(params.textDocument.uri);
  if (found === undefined) return answer(null);
  const { project, path } = found;
  const text = project.open.get(path)?.text ?? project.disk.get(path) ??
    project.lastGood?.sourceTexts().get(path);
  if (text === undefined) return answer(null);
  const starts = lineStarts(text);
  const symbols = documentSymbols(project.lastGood, path, text);
  return answer(symbols.map((symbol) => convertSymbol(symbol, text, starts)));
}

// ---- Generated TypeScript ---------------------------------------------------

interface GeneratedEntry {
  /** The URI that the client used in its request. */
  uri: string;
  /** The text of the newest emit that succeeded in this server session. */
  lastGood: string | undefined;
  /** What the client has now, through a response or a notification. */
  received: GeneratedTypeScriptResult | undefined;
}

/**
 * The generated TypeScript of the subscribed modules (plan 5.8). A request
 * subscribes the module. After each flush that produced a revision, the tracker
 * sends `effective/generatedChanged` for each subscribed module whose text or
 * stale flag differs from what the client has.
 */
export class GeneratedTexts {
  readonly #entries = new WeakMap<
    ProjectState,
    Map<string, GeneratedEntry>
  >();

  #entriesOf(project: ProjectState): Map<string, GeneratedEntry> {
    let entries = this.#entries.get(project);
    if (entries === undefined) {
      entries = new Map();
      this.#entries.set(project, entries);
    }
    return entries;
  }

  #current(
    revision: Revision,
    path: string,
    entry: GeneratedEntry,
  ): GeneratedTypeScriptResult | null {
    const name = effModuleOf(revision, path);
    const emitted = name === undefined ? undefined : revision.emitted(name);
    if (emitted !== undefined && emitted.ok) {
      entry.lastGood = emitted.value.text;
      return { text: emitted.value.text, stale: false };
    }
    return entry.lastGood === undefined
      ? null
      : { text: entry.lastGood, stale: true };
  }

  /** Answers `effective/generatedTypeScript` and subscribes the module. */
  request(
    project: ProjectState,
    path: string,
    uri: string,
  ): GeneratedTypeScriptResult | null {
    if (!path.endsWith(".eff")) return null;
    const entries = this.#entriesOf(project);
    let entry = entries.get(path);
    if (entry === undefined) {
      entry = { uri, lastGood: undefined, received: undefined };
      entries.set(path, entry);
    }
    entry.uri = uri;
    const revision = project.lastGood;
    if (revision === undefined) return null;
    const result = this.#current(revision, path, entry);
    if (result !== null) entry.received = result;
    return result;
  }

  /** Called after a flush that produced a revision. */
  afterFlush(
    project: ProjectState,
    revision: Revision,
    notify: (method: string, params: unknown) => void,
  ): void {
    const entries = this.#entries.get(project);
    if (entries === undefined) return;
    for (const [path, entry] of entries) {
      const result = this.#current(revision, path, entry);
      if (result === null) continue;
      const before = entry.received;
      if (
        before !== undefined && before.text === result.text &&
        before.stale === result.stale
      ) continue;
      entry.received = result;
      const params: GeneratedChangedParams = { uri: entry.uri };
      notify(GENERATED_CHANGED_METHOD, params);
    }
  }
}

/** `effective/generatedTypeScript` (plan 5.8). */
export function generatedTypeScriptRequest(
  params: TextDocumentParams,
  ctx: ServerContext,
): Answer {
  const uri = params.textDocument.uri;
  const found = ctx.projects.forRequest(uri);
  if (found === undefined) return answer(null);
  return answer(ctx.generated.request(found.project, found.path, uri));
}

// ---- Save -------------------------------------------------------------------

/**
 * `textDocument/didSave` (plan 5.9). Writes the files of the saved `.eff`
 * module when `writeOnSave` is true. A module with errors keeps its last good
 * files, because `writeGenerated` skips it.
 */
export function didSave(params: TextDocumentParams, ctx: ServerContext): void {
  if (!ctx.options.writeOnSave) return;
  const found = ctx.projects.forRequest(params.textDocument.uri);
  if (found === undefined || !found.path.endsWith(".eff")) return;
  const { project, path } = found;
  const revision = project.lastGood;
  if (project.configError !== undefined || revision === undefined) return;
  const name = effModuleOf(revision, path);
  if (name === undefined) return;
  const outputs = writeGenerated(ctx.fs, project.root, revision, [name], true);
  for (const note of outputs.notes) ctx.log(1, note);
}

// ---- Stats ------------------------------------------------------------------

/** `effective/stats` (plan 5.11). */
export function statsRequest(
  params: TextDocumentParams,
  ctx: ServerContext,
): Answer {
  const found = ctx.projects.forRequest(params.textDocument.uri);
  if (found === undefined) return answer(null);
  const { project } = found;
  const revision = project.lastGood;
  const { parses, checks, lowerings, emits } = project.program.counts;
  const result: StatsResult = {
    revision: revision?.number ?? 0,
    rechecked: revision === undefined ? [] : [...revision.rechecked],
    counts: { parses, checks, lowerings, emits },
    delta: {
      interfaceChanged: [...(project.lastDelta?.interfaceChanged ?? [])],
      modeChanged: [...(project.lastDelta?.modeChanged ?? [])],
    },
    memory: ctx.memory(),
  };
  return answer(result);
}

// The subset of the Language Server Protocol that this server uses: the wire
// types, and narrowing functions from `unknown` for every incoming params
// shape. A narrowing function returns a Result. Its error text is fit for the
// message of a -32602 response.

import type { Result } from "../core/mod.ts";

// ---- Wire types -----------------------------------------------------------

/** Zero-based line and zero-based UTF-16 character. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

interface TextDocumentIdentifier {
  readonly uri: string;
}

interface VersionedTextDocumentIdentifier {
  readonly uri: string;
  readonly version: number;
}

interface TextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

/** A change with a range replaces that range. A change without one replaces the whole text. */
export interface TextChange {
  readonly range?: Range;
  readonly text: string;
}

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

export const FileChangeType = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const;

type FileChangeTypeValue = 1 | 2 | 3;

/** The symbol kinds of plan section 5.7. */
export const SymbolKind = {
  Class: 5,
  Method: 6,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  Struct: 23,
} as const;

export interface InitializationOptions {
  /** Milliseconds to wait before a flush. 0 flushes after each batch. */
  readonly debounceMs: number;
  /** Write `<module>.ts` and its map on save. */
  readonly writeOnSave: boolean;
}

export const DEFAULT_INITIALIZATION_OPTIONS: InitializationOptions = {
  debounceMs: 0,
  writeOnSave: true,
};

interface ServerCapabilities {
  readonly positionEncoding: "utf-16";
  readonly textDocumentSync: {
    readonly openClose: true;
    readonly change: typeof TextDocumentSyncKind.Incremental;
    readonly save: { readonly includeText: false };
  };
  readonly hoverProvider: true;
  readonly definitionProvider: true;
  readonly documentSymbolProvider: true;
}

export const SERVER_CAPABILITIES: ServerCapabilities = {
  positionEncoding: "utf-16",
  textDocumentSync: {
    openClose: true,
    change: TextDocumentSyncKind.Incremental,
    save: { includeText: false },
  },
  hoverProvider: true,
  definitionProvider: true,
  documentSymbolProvider: true,
};

interface InitializeResult {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo?: { readonly name: string; readonly version?: string };
}

interface DiagnosticRelatedInformation {
  readonly location: Location;
  readonly message: string;
}

export interface Diagnostic {
  readonly range: Range;
  /** 1 for an error, 2 for a warning. */
  readonly severity: 1 | 2;
  readonly code: string;
  readonly source: string;
  readonly message: string;
  readonly relatedInformation?: readonly DiagnosticRelatedInformation[];
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  /** The version of the open document that the diagnostics used. Absent for a closed file. */
  readonly version?: number;
  readonly diagnostics: readonly Diagnostic[];
}

interface MarkupContent {
  readonly kind: "markdown" | "plaintext";
  readonly value: string;
}

export interface Hover {
  readonly contents: MarkupContent;
  readonly range?: Range;
}

export interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

export interface LogMessageParams {
  readonly type: 1 | 2 | 3 | 4;
  readonly message: string;
}

/** The result of `effective/generatedTypeScript`. */
export interface GeneratedTypeScriptResult {
  readonly text: string;
  readonly stale: boolean;
}

/** The params of `effective/generatedChanged`. */
export interface GeneratedChangedParams {
  readonly uri: string;
}

/** The result of `effective/stats` (plan 5.11). */
export interface StatsResult {
  /** The number of the newest good revision, or 0 before the first one. */
  readonly revision: number;
  /** The modules that the newest good revision checked again. */
  readonly rechecked: string[];
  /** The cumulative query counts of the project. */
  readonly counts: {
    readonly parses: number;
    readonly checks: number;
    readonly lowerings: number;
    readonly emits: number;
  };
  /** The delta of the newest good flush. */
  readonly delta: {
    readonly interfaceChanged: string[];
    readonly modeChanged: string[];
  };
  readonly memory: { readonly rss: number; readonly heapUsed: number };
}

// `shutdown` takes no params and returns null. `exit` takes no params.

// ---- Incoming params, narrowed --------------------------------------------

export type Narrowed<T> = Result<T, string>;

function ok<T>(value: T): Narrowed<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Narrowed<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function narrowPosition(value: unknown, where: string): Narrowed<Position> {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  if (!isIndex(value.line)) {
    return fail(`${where}.line must be a non-negative integer`);
  }
  if (!isIndex(value.character)) {
    return fail(`${where}.character must be a non-negative integer`);
  }
  return ok({ line: value.line, character: value.character });
}

function narrowRange(value: unknown, where: string): Narrowed<Range> {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  const start = narrowPosition(value.start, `${where}.start`);
  if (!start.ok) return start;
  const end = narrowPosition(value.end, `${where}.end`);
  if (!end.ok) return end;
  return ok({ start: start.value, end: end.value });
}

function narrowUri(value: unknown, where: string): Narrowed<string> {
  return typeof value === "string" && value !== ""
    ? ok(value)
    : fail(`${where} must be a non-empty string`);
}

function narrowDocument(
  value: unknown,
  where: string,
): Narrowed<TextDocumentIdentifier> {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  const uri = narrowUri(value.uri, `${where}.uri`);
  return uri.ok ? ok({ uri: uri.value }) : uri;
}

function narrowParamsRecord(
  params: unknown,
  method: string,
): Narrowed<Record<string, unknown>> {
  return isRecord(params)
    ? ok(params)
    : fail(`${method}: params must be an object`);
}

/**
 * Initialization options. An invalid value never fails the message: the option
 * takes its default and the warning list says why.
 */
function narrowOptions(value: unknown): {
  readonly options: InitializationOptions;
  readonly warnings: readonly string[];
} {
  const defaults = DEFAULT_INITIALIZATION_OPTIONS;
  if (value === undefined || value === null) {
    return { options: defaults, warnings: [] };
  }
  if (!isRecord(value)) {
    return {
      options: defaults,
      warnings: ["initializationOptions must be an object; using the defaults"],
    };
  }
  const warnings: string[] = [];
  let debounceMs = defaults.debounceMs;
  if (value.debounceMs !== undefined) {
    const v = value.debounceMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) debounceMs = v;
    else {
      warnings.push(
        `initializationOptions.debounceMs must be a finite number of at least 0; using ${defaults.debounceMs}`,
      );
    }
  }
  let writeOnSave = defaults.writeOnSave;
  if (value.writeOnSave !== undefined) {
    if (typeof value.writeOnSave === "boolean") writeOnSave = value.writeOnSave;
    else {
      warnings.push(
        `initializationOptions.writeOnSave must be a boolean; using ${defaults.writeOnSave}`,
      );
    }
  }
  return { options: { debounceMs, writeOnSave }, warnings };
}

interface InitializeParams {
  readonly options: InitializationOptions;
  /** Messages for `window/logMessage`, one per invalid option. */
  readonly warnings: readonly string[];
}

export function narrowInitializeParams(
  params: unknown,
): Narrowed<InitializeParams> {
  const record = narrowParamsRecord(params, "initialize");
  if (!record.ok) return record;
  return ok(narrowOptions(record.value.initializationOptions));
}

export interface DidOpenParams {
  readonly textDocument: TextDocumentItem;
}

export function narrowDidOpen(params: unknown): Narrowed<DidOpenParams> {
  const record = narrowParamsRecord(params, "textDocument/didOpen");
  if (!record.ok) return record;
  const item = record.value.textDocument;
  if (!isRecord(item)) return fail("textDocument must be an object");
  const uri = narrowUri(item.uri, "textDocument.uri");
  if (!uri.ok) return uri;
  if (typeof item.languageId !== "string") {
    return fail("textDocument.languageId must be a string");
  }
  if (!isInteger(item.version)) {
    return fail("textDocument.version must be an integer");
  }
  if (typeof item.text !== "string") {
    return fail("textDocument.text must be a string");
  }
  return ok({
    textDocument: {
      uri: uri.value,
      languageId: item.languageId,
      version: item.version,
      text: item.text,
    },
  });
}

export interface DidChangeParams {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly contentChanges: readonly TextChange[];
}

export function narrowDidChange(params: unknown): Narrowed<DidChangeParams> {
  const record = narrowParamsRecord(params, "textDocument/didChange");
  if (!record.ok) return record;
  const document = record.value.textDocument;
  if (!isRecord(document)) return fail("textDocument must be an object");
  const uri = narrowUri(document.uri, "textDocument.uri");
  if (!uri.ok) return uri;
  if (!isInteger(document.version)) {
    return fail("textDocument.version must be an integer");
  }
  const raw = record.value.contentChanges;
  if (!Array.isArray(raw)) return fail("contentChanges must be an array");
  const changes: TextChange[] = [];
  for (let i = 0; i < raw.length; i++) {
    const change: unknown = raw[i];
    const where = `contentChanges[${i}]`;
    if (!isRecord(change)) return fail(`${where} must be an object`);
    if (typeof change.text !== "string") {
      return fail(`${where}.text must be a string`);
    }
    if (change.range === undefined) {
      changes.push({ text: change.text });
      continue;
    }
    const range = narrowRange(change.range, `${where}.range`);
    if (!range.ok) return range;
    changes.push({ range: range.value, text: change.text });
  }
  return ok({
    textDocument: { uri: uri.value, version: document.version },
    contentChanges: changes,
  });
}

export interface TextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
}

/**
 * `{ textDocument: { uri } }`. It serves `didSave`, `didClose`, `documentSymbol`,
 * `effective/generatedTypeScript`, and `effective/stats`. Other fields are
 * ignored, so `didSave` with `text` passes.
 */
export function narrowTextDocumentParams(
  params: unknown,
): Narrowed<TextDocumentParams> {
  const record = narrowParamsRecord(params, "request");
  if (!record.ok) return record;
  const document = narrowDocument(record.value.textDocument, "textDocument");
  return document.ok ? ok({ textDocument: document.value }) : document;
}

export interface PositionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

/** `textDocument/hover` and `textDocument/definition`. */
export function narrowPositionParams(
  params: unknown,
): Narrowed<PositionParams> {
  const record = narrowParamsRecord(params, "request");
  if (!record.ok) return record;
  const document = narrowDocument(record.value.textDocument, "textDocument");
  if (!document.ok) return document;
  const position = narrowPosition(record.value.position, "position");
  if (!position.ok) return position;
  return ok({ textDocument: document.value, position: position.value });
}

export interface FileEvent {
  readonly uri: string;
  readonly type: FileChangeTypeValue;
}

interface DidChangeWatchedFilesParams {
  readonly changes: readonly FileEvent[];
}

export function narrowDidChangeWatchedFiles(
  params: unknown,
): Narrowed<DidChangeWatchedFilesParams> {
  const record = narrowParamsRecord(
    params,
    "workspace/didChangeWatchedFiles",
  );
  if (!record.ok) return record;
  const raw = record.value.changes;
  if (!Array.isArray(raw)) return fail("changes must be an array");
  const changes: FileEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const event: unknown = raw[i];
    const where = `changes[${i}]`;
    if (!isRecord(event)) return fail(`${where} must be an object`);
    const uri = narrowUri(event.uri, `${where}.uri`);
    if (!uri.ok) return uri;
    const type = event.type;
    if (type !== 1 && type !== 2 && type !== 3) {
      return fail(`${where}.type must be 1, 2, or 3`);
    }
    changes.push({ uri: uri.value, type });
  }
  return ok({ changes });
}

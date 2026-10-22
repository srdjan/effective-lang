// The subset of the Language Server Protocol that this server uses: the wire
// types, and narrowing functions from `unknown` for every incoming params
// shape. Ordered field schemas share primitive, object, array and optional
// checks. Narrowers return a Result whose error text fits a -32602 response.

import {
  isRecord,
  type Result,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
} from "../core/mod.ts";

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
  readonly referencesProvider: true;
  readonly renameProvider: { readonly prepareProvider: true };
  readonly completionProvider: {
    readonly triggerCharacters: readonly string[];
  };
  readonly semanticTokensProvider: {
    readonly legend: {
      readonly tokenTypes: readonly string[];
      readonly tokenModifiers: readonly string[];
    };
    readonly full: true;
  };
  readonly codeActionProvider: { readonly codeActionKinds: readonly string[] };
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
  referencesProvider: true,
  renameProvider: { prepareProvider: true },
  completionProvider: { triggerCharacters: ["."] },
  semanticTokensProvider: {
    legend: {
      tokenTypes: SEMANTIC_TOKEN_TYPES,
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
    },
    full: true,
  },
  codeActionProvider: { codeActionKinds: ["quickfix"] },
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
  readonly typeTableSize: number;
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

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

type Check<T> = (value: unknown, where: string) => Narrowed<T>;
type Shape = Readonly<Record<string, Check<unknown>>>;
type Checked<C> = C extends Check<infer T> ? T : never;
type Out<S extends Shape> =
  & {
    readonly [K in keyof S as undefined extends Checked<S[K]> ? never : K]:
      Checked<S[K]>;
  }
  & {
    readonly [K in keyof S as undefined extends Checked<S[K]> ? K : never]?:
      Exclude<Checked<S[K]>, undefined>;
  };

function primitive<T>(
  test: (value: unknown) => value is T,
  description: string,
): Check<T> {
  return (value, where) =>
    test(value) ? ok(value) : fail(`${where} must be ${description}`);
}

function object<S extends Shape>(shape: S): Check<Out<S>> {
  return (value, where) => {
    if (!isRecord(value)) return fail(`${where} must be an object`);
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const field = check(value[key], where === "" ? key : `${where}.${key}`);
      if (!field.ok) return field;
      if (field.value !== undefined) out[key] = field.value;
    }
    // Every field passed its check; undefined optional fields stay absent.
    return ok(out as Out<S>);
  };
}

function array<T>(check: Check<T>): Check<readonly T[]> {
  return (value, where) => {
    if (!Array.isArray(value)) return fail(`${where} must be an array`);
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = check(value[i], `${where}[${i}]`);
      if (!item.ok) return item;
      out.push(item.value);
    }
    return ok(out);
  };
}

function optional<T>(check: Check<T>): Check<T | undefined> {
  return (value, where) =>
    value === undefined ? ok(undefined) : check(value, where);
}

function params<S extends Shape>(
  method: string,
  shape: S,
): (value: unknown) => Narrowed<Out<S>> {
  const check = object(shape);
  return (value) => {
    const record = narrowParamsRecord(value, method);
    return record.ok ? check(record.value, "") : record;
  };
}

const string = primitive(
  (value): value is string => typeof value === "string",
  "a string",
);
const uri = primitive(
  (value): value is string => typeof value === "string" && value !== "",
  "a non-empty string",
);
const integer = primitive(isInteger, "an integer");
const index = primitive(isIndex, "a non-negative integer");
const fileChangeType = primitive(
  (value): value is FileChangeTypeValue =>
    value === 1 || value === 2 || value === 3,
  "1, 2, or 3",
);
const narrowPosition = object({ line: index, character: index });
const narrowRange = object({ start: narrowPosition, end: narrowPosition });
const narrowDocument = object({ uri });

// Validate text before range, but retain the wire result's range/text key order.
const changeFields = object({ text: string, range: optional(narrowRange) });
const narrowChange: Check<TextChange> = (value, where) => {
  const change = changeFields(value, where);
  if (!change.ok) return change;
  const { text, range } = change.value;
  return ok(range === undefined ? { text } : { range, text });
};

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

const didOpen = params("textDocument/didOpen", {
  textDocument: object({
    uri,
    languageId: string,
    version: integer,
    text: string,
  }),
});

export function narrowDidOpen(params: unknown): Narrowed<DidOpenParams> {
  return didOpen(params);
}

export interface DidChangeParams {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly contentChanges: readonly TextChange[];
}

const didChange = params("textDocument/didChange", {
  textDocument: object({ uri, version: integer }),
  contentChanges: array(narrowChange),
});

export function narrowDidChange(params: unknown): Narrowed<DidChangeParams> {
  return didChange(params);
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
  return textDocumentParams(params);
}

const textDocumentParams = params("request", { textDocument: narrowDocument });

export interface PositionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

/** `textDocument/hover` and `textDocument/definition`. */
export function narrowPositionParams(
  params: unknown,
): Narrowed<PositionParams> {
  return positionParams(params);
}

const positionParams = params("request", {
  textDocument: narrowDocument,
  position: narrowPosition,
});

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
  return didChangeWatchedFiles(params);
}

const didChangeWatchedFiles = params("workspace/didChangeWatchedFiles", {
  changes: array(object({ uri, type: fileChangeType })),
});

/** Editor mutation requests may carry an explicit document version. */
export interface EditorPositionParams extends PositionParams {
  readonly documentVersion?: number;
}
export interface ReferencesParams extends EditorPositionParams {
  readonly includeDeclaration: boolean;
}
export interface RenameParams extends EditorPositionParams {
  readonly newName: string;
}
export interface CodeActionParams extends TextDocumentParams {
  readonly range: Range;
}

// Editor requests validate the position before an optional document version.
export function narrowEditorPositionParams(
  params: unknown,
): Narrowed<EditorPositionParams> {
  const position = narrowPositionParams(params);
  if (!position.ok) return position;
  if (
    !isRecord(params) || !isRecord(params.textDocument) ||
    params.textDocument.version === undefined
  ) return position;
  const version = params.textDocument.version;
  if (!isInteger(version)) {
    return fail("textDocument.version must be an integer");
  }
  return ok({ ...position.value, documentVersion: version });
}

export function narrowReferencesParams(
  params: unknown,
): Narrowed<ReferencesParams> {
  const position = narrowEditorPositionParams(params);
  if (!position.ok) return position;
  if (
    !isRecord(params) || !isRecord(params.context) ||
    typeof params.context.includeDeclaration !== "boolean"
  ) return fail("context.includeDeclaration must be a boolean");
  return ok({
    ...position.value,
    includeDeclaration: params.context.includeDeclaration,
  });
}

export function narrowRenameParams(params: unknown): Narrowed<RenameParams> {
  const position = narrowEditorPositionParams(params);
  if (!position.ok) return position;
  if (!isRecord(params) || typeof params.newName !== "string") {
    return fail("newName must be a string");
  }
  return ok({ ...position.value, newName: params.newName });
}

const codeActionParams = params("request", {
  textDocument: narrowDocument,
  range: narrowRange,
});

export function narrowCodeActionParams(
  params: unknown,
): Narrowed<CodeActionParams> {
  return codeActionParams(params);
}

// The public API of the core. This file is a list of re-exports. The core is
// synchronous and pure: it reads files only through `SourceHost`.

// The program with module cutoff.
export { Program, Revision, revisionDelta } from "./db.ts";
export type { ProgramChanges, QueryCounts, RevisionDelta } from "./db.ts";

// The editor queries.
export { definitionAt, documentSymbols, hoverAt } from "./editor.ts";
export type {
  EditorSymbol,
  EditorSymbolKind,
  Hover,
  HoverBackend,
} from "./editor.ts";
export { methodOfCapability, moduleOfId, nameOfId } from "./ids.ts";

// The pipeline functions.
export { checkProject } from "./check_project.ts";
export type { CheckedModule, CheckedProject } from "./check_project.ts";
export { lowerModule, lowerProject } from "./lower.ts";
export type { LowerError } from "./lower.ts";
export { serializeModule } from "./serialize.ts";
export { validateProject } from "./validate_project.ts";
export { emitModule, emitProject } from "./emit/emit.ts";
export type {
  EmitContext,
  EmitError,
  EmitProjectError,
  EmittedModule,
} from "./emit/emit.ts";

// The span table and the source map.
export {
  buildSpanTable,
  hostImportSpans,
  mapGenerated,
  mapOffset,
} from "./emit/spans.ts";
export type { SpanTable } from "./emit/spans.ts";
export {
  buildSourceMap,
  decodeMappings,
  lookupMapping,
  serializeSourceMap,
} from "./emit/sourcemap.ts";
export type {
  SourceMapError,
  SourceMapOptions,
  SourceMapV3,
} from "./emit/sourcemap.ts";

// The `deno check` output parser and the mapping to Effective spans.
export {
  hostModulePaths,
  mapTscDiagnostic,
  parseDenoCheck,
} from "./emit/tsc.ts";
export type { DenoCheckOutput, TscDiagnostic, TscMapping } from "./emit/tsc.ts";

// The project file and the source host.
export { describeConfigError, readConfig } from "./project.ts";
export type { ConfigError, Project, ProjectConfig } from "./project.ts";
export { memoryHost } from "./source.ts";
export type { ReadError, Result, SourceHost } from "./source.ts";

// Diagnostics.
export {
  categoryOf,
  describeCode,
  makeDiagnostic,
  normalizeDiagnostics,
  registeredCodes,
} from "./diagnostics.ts";
export type {
  Category,
  Diagnostic,
  DiagnosticCode,
  RelatedSpan,
  Severity,
} from "./diagnostics.ts";

// The IR types.
export type * from "./ir.ts";

// Concrete TypeScript orchestration. Frontend queries do not import this module.
import type { Revision } from "./db.ts";
import type { ModuleIR, Result } from "./ir.ts";
import type { LowerError } from "./lower.ts";
import {
  type EmitContext,
  type EmitError,
  emitModule,
  type EmittedModule,
} from "./emit/emit.ts";
import { buildSpanTable, type SpanTable } from "./emit/spans.ts";
import {
  buildSourceMap,
  type SourceMapError,
  type SourceMapV3,
} from "./emit/sourcemap.ts";
import { type Doc, render } from "./emit/doc.ts";
import { constantTypeDoc, functionHeaderDoc } from "./emit/decls.ts";
import { EmitFailure, Scope } from "./emit/scope.ts";
import { sourceHoverAt } from "./editor.ts";
import type { Span } from "./source.ts";

export type EmitProjectError =
  | EmitError
  | {
    readonly tag: "lowering";
    readonly module: string;
    readonly error: LowerError;
  };

/**
 * Emits every lowered module of a project, in the order of `lowered`. A module
 * whose lowering failed gives a `lowering` error and no text.
 */
export function emitProject(
  lowered: ReadonlyMap<string, Result<ModuleIR, LowerError>>,
  context: EmitContext,
): ReadonlyMap<string, Result<EmittedModule, EmitProjectError>> {
  const results = new Map<string, Result<EmittedModule, EmitProjectError>>();
  for (const [name, result] of lowered) {
    if (!result.ok) {
      results.set(name, {
        ok: false,
        error: { tag: "lowering", module: name, error: result.error },
      });
      continue;
    }
    results.set(name, emitModule(result.value, context));
  }
  return results;
}

interface OutputEntry {
  emitted?: Result<EmittedModule, EmitProjectError>;
  table?: Result<SpanTable, EmitProjectError>;
  map?: Result<SourceMapV3, EmitProjectError | SourceMapError>;
}

/** One output cache per program/session. Reused lowerings reuse outputs without retaining revisions. */
export class TypeScriptOutputs {
  private readonly entries = new WeakMap<
    Result<ModuleIR, LowerError>,
    OutputEntry
  >();
  private emits = 0;

  get counts(): { readonly emits: number } {
    return { emits: this.emits };
  }

  private entry(revision: Revision, name: string): OutputEntry | undefined {
    const lowered = revision.lowered(name);
    if (lowered === undefined) return undefined;
    let entry = this.entries.get(lowered);
    if (entry === undefined) {
      entry = {};
      this.entries.set(lowered, entry);
    }
    return entry;
  }

  emitted(
    revision: Revision,
    name: string,
  ): Result<EmittedModule, EmitProjectError> | undefined {
    const entry = this.entry(revision, name);
    if (entry === undefined) return undefined;
    if (entry.emitted === undefined) {
      const lowered = revision.lowered(name)!;
      this.emits++;
      entry.emitted = lowered.ok
        ? emitModule(lowered.value, { config: revision.config })
        : {
          ok: false,
          error: { tag: "lowering", module: name, error: lowered.error },
        };
    }
    return entry.emitted;
  }

  spanTable(
    revision: Revision,
    name: string,
  ): Result<SpanTable, EmitProjectError> | undefined {
    const entry = this.entry(revision, name);
    const emitted = this.emitted(revision, name);
    if (entry === undefined || emitted === undefined) return undefined;
    if (entry.table === undefined) {
      const names = new Map<string, Span>();
      for (const link of revision.moduleInfo(name)?.links ?? []) {
        if (!link.isHost) continue;
        for (const imported of link.entry.names) {
          names.set(imported.name, imported.span);
        }
      }
      entry.table = emitted.ok
        ? { ok: true, value: buildSpanTable(emitted.value, names) }
        : emitted;
    }
    return entry.table;
  }

  sourceMap(
    revision: Revision,
    name: string,
  ): Result<SourceMapV3, EmitProjectError | SourceMapError> | undefined {
    const entry = this.entry(revision, name);
    const table = this.spanTable(revision, name);
    if (entry === undefined || table === undefined) return undefined;
    if (entry.map === undefined) {
      entry.map = table.ok
        ? buildSourceMap(table.value, revision.sourceTexts())
        : table;
    }
    return entry.map;
  }
}

export type HoverBackend = { readonly tag: "type"; readonly text: string } | {
  readonly tag: "unavailable";
};
export interface Hover {
  readonly span: Span;
  readonly contract: string;
  readonly backend: HoverBackend | undefined;
}

/** One line, as the emitter prints the declaration header, without the width limit. */
const FLAT_WIDTH = 1_000_000;

function renderDoc(doc: Doc): string {
  return render(doc, FLAT_WIDTH).text;
}

function backendOf(
  revision: Revision,
  module: string,
  id: string,
  outputs: TypeScriptOutputs,
): HoverBackend {
  const unavailable: HoverBackend = { tag: "unavailable" };
  if (!outputs.emitted(revision, module)?.ok) return unavailable;
  const lowered = revision.lowered(module);
  if (lowered === undefined || !lowered.ok) return unavailable;
  const ir: ModuleIR = lowered.value;
  const declaration = ir.declarations.find((d) => d.id === id);
  if (declaration === undefined) return unavailable;
  try {
    const scope = new Scope(ir, revision.config);
    if (declaration.kind === "function") {
      return {
        tag: "type",
        text: renderDoc(functionHeaderDoc(scope, declaration, "always")),
      };
    }
    if (declaration.kind === "constant") {
      return {
        tag: "type",
        text: renderDoc(constantTypeDoc(scope, declaration)),
      };
    }
    return unavailable;
  } catch (error) {
    if (error instanceof EmitFailure) return unavailable;
    throw error;
  }
}

export function hoverAt(
  revision: Revision,
  path: string,
  offset: number,
  outputs: TypeScriptOutputs,
): Hover | undefined {
  const source = sourceHoverAt(revision, path, offset);
  if (source === undefined) return undefined;
  const { span, contract, declaration } = source;
  const module = revision.moduleInfoAt(path)!;
  return {
    span,
    contract,
    backend: declaration === undefined
      ? undefined
      : backendOf(revision, module.name, declaration, outputs),
  };
}

export { emitModule } from "./emit/emit.ts";
export type { EmitContext, EmitError, EmittedModule } from "./emit/emit.ts";
export * from "./emit/spans.ts";
export * from "./emit/sourcemap.ts";
export * from "./emit/tsc.ts";

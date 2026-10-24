import type { TypeScriptOutputs } from "../core/typescript.ts";
// Adapt the revision's lazy queries to one complete generation result.
// File writing consumes this port without depending on a concrete Revision.

import type {
  EmitProjectError,
  EmittedModule,
  LowerError,
  Revision,
  SourceMapV3,
  SpanTable,
} from "../core/mod.ts";

export type Generation =
  | { readonly kind: "skip" }
  | {
    readonly kind: "lower";
    readonly error: Exclude<LowerError, { readonly tag: "diagnostics" }>;
  }
  | { readonly kind: "emit"; readonly error: EmitProjectError }
  | { readonly kind: "map" }
  | {
    readonly kind: "ready";
    readonly emitted: EmittedModule;
    readonly table: SpanTable;
    readonly map: SourceMapV3;
  };

export interface GeneratedSource {
  generated(name: string): Generation;
}

export function generationSource(
  revision: Revision,
  outputs: Pick<TypeScriptOutputs, "emitted" | "spanTable" | "sourceMap">,
): GeneratedSource {
  return {
    generated(name) {
      const lowered = revision.lowered(name);
      if (lowered === undefined) return { kind: "skip" };
      if (!lowered.ok) {
        return lowered.error.tag === "diagnostics"
          ? { kind: "skip" }
          : { kind: "lower", error: lowered.error };
      }
      // Preserve the query order, including queries after an earlier failure.
      const emitted = outputs.emitted(revision, name);
      const table = outputs.spanTable(revision, name);
      const map = outputs.sourceMap(revision, name);
      if (emitted === undefined || table === undefined || map === undefined) {
        return { kind: "skip" };
      }
      if (!emitted.ok) return { kind: "emit", error: emitted.error };
      if (!map.ok || !table.ok) return { kind: "map" };
      return {
        kind: "ready",
        emitted: emitted.value,
        table: table.value,
        map: map.value,
      };
    },
  };
}

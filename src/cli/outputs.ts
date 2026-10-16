// The emit-and-write step of a build, shared by `build`, `watch`, and the
// language server: emit each named module, build its source map, and write the
// generated file and the map when their text changed.

import type { Revision } from "../core/db.ts";
import { serializeSourceMap } from "../core/emit/sourcemap.ts";
import type { SpanTable } from "../core/emit/spans.ts";
import type { LowerError } from "../core/lower.ts";
import { joinPath } from "../core/project.ts";
import type { CliFs } from "./io.ts";

export interface GeneratedOutputs {
  /** The root-relative paths of the files that changed on disk. */
  readonly written: string[];
  /** The root-relative paths of the generated modules, in the order of `names`. */
  readonly generated: string[];
  /** The span table of each generated path. */
  readonly tables: Map<string, SpanTable>;
  /** Messages for stderr. */
  readonly notes: string[];
  /** True when a module failed to lower, emit, map, or write. */
  readonly failed: boolean;
}

export function describeLowerError(error: LowerError): string {
  switch (error.tag) {
    case "diagnostics":
      return `${error.module} has ${error.count} diagnostics`;
    case "unknown-module":
    case "host-interface":
      return `${error.module}: ${error.tag}`;
    case "no-interface":
      return `${error.module} imports ${error.imported}, which has no interface`;
    case "unsupported":
    case "internal":
      return `${error.module}: ${error.message}`;
  }
}

/**
 * Emits the named modules of the revision. With `write` true, it writes
 * `<module>.ts` and `<module>.ts.map` under `root` for each module whose text
 * changed. A module with diagnostics is skipped without a note: the caller
 * reports it. The caller also leaves out the modules that failed validation.
 */
export function writeGenerated(
  fs: CliFs,
  root: string,
  revision: Revision,
  names: readonly string[],
  write: boolean,
): GeneratedOutputs {
  const written: string[] = [];
  const generated: string[] = [];
  const tables = new Map<string, SpanTable>();
  const notes: string[] = [];
  let failed = false;
  for (const name of names) {
    const lowered = revision.lowered(name);
    if (lowered === undefined) continue;
    if (!lowered.ok) {
      // A module with diagnostics is already reported. Any other reason is a defect.
      if (lowered.error.tag !== "diagnostics") {
        notes.push(
          `error: cannot lower ${describeLowerError(lowered.error)}`,
        );
        failed = true;
      }
      continue;
    }
    const emitted = revision.emitted(name);
    const table = revision.spanTable(name);
    const map = revision.sourceMap(name);
    if (emitted === undefined || table === undefined || map === undefined) {
      continue;
    }
    if (!emitted.ok) {
      notes.push(`error: cannot emit ${name}: ${emitted.error.tag}`);
      failed = true;
      continue;
    }
    if (!map.ok || !table.ok) {
      notes.push(`error: cannot build the source map of ${name}`);
      failed = true;
      continue;
    }
    if (write) {
      const outputs: [string, string][] = [
        [emitted.value.path, emitted.value.text],
        [`${emitted.value.path}.map`, serializeSourceMap(map.value)],
      ];
      for (const [path, text] of outputs) {
        const full = joinPath(root, path);
        const old = fs.readText(full);
        if (old.ok && old.value === text) continue;
        const result = fs.writeText(full, text);
        if (result.ok) {
          written.push(path);
        } else {
          notes.push(`error: cannot write ${path}: ${result.error.message}`);
          failed = true;
        }
      }
    }
    generated.push(emitted.value.path);
    tables.set(emitted.value.path, table.value);
  }
  return { written, generated, tables, notes, failed };
}

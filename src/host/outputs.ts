// The emit-and-write step of a build, shared by `build`, `watch`, and the
// language server: emit each named module, build its source map, and write the
// generated file and the map when their text changed.

import {
  type Diagnostic,
  joinPath,
  type LowerError,
  type Revision,
  serializeSourceMap,
  type SpanTable,
} from "../core/mod.ts";
import type { CliFs } from "./io.ts";
import type { GeneratedSource } from "./generation.ts";

interface GeneratedOutputs {
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

function describeLowerError(error: LowerError): string {
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
 * The modules that a build writes, in the order of `revision.effModuleNames()`.
 * A module that lowered and failed validation is reported, and not written.
 * A module that imports a module that is not written is not written either,
 * because its generated import would not load.
 */
export function writableModules(
  revision: Revision,
  validation: ReadonlyMap<string, readonly Diagnostic[]> = new Map(),
): string[] {
  const passed = new Set(
    revision.effModuleNames().filter((name) => {
      const lowered = revision.lowered(name);
      return lowered === undefined || !lowered.ok ||
        (validation.get(name) ?? []).length === 0;
    }),
  );
  const writable = (name: string): boolean => {
    const lowered = revision.lowered(name);
    return lowered !== undefined && lowered.ok && passed.has(name);
  };
  // A fixpoint, because one forward pass is wrong inside an import cycle.
  // The graph also holds host interface targets, which the build does not write.
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...passed]) {
      if (
        revision.imports(name).some((target) =>
          revision.moduleInfo(target)?.mode === "eff" && !writable(target)
        )
      ) {
        passed.delete(name);
        changed = true;
      }
    }
  }
  return [...passed];
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
  source: GeneratedSource,
  names: readonly string[],
  write: boolean,
): GeneratedOutputs {
  const written: string[] = [];
  const generated: string[] = [];
  const tables = new Map<string, SpanTable>();
  const notes: string[] = [];
  let failed = false;
  for (const name of names) {
    const output = source.generated(name);
    switch (output.kind) {
      case "skip":
        continue;
      case "lower":
        notes.push(
          `error: cannot lower ${describeLowerError(output.error)}`,
        );
        failed = true;
        continue;
      case "emit":
        notes.push(`error: cannot emit ${name}: ${output.error.tag}`);
        failed = true;
        continue;
      case "map":
        notes.push(`error: cannot build the source map of ${name}`);
        failed = true;
        continue;
      case "ready":
        break;
      default: {
        const unreachable: never = output;
        return unreachable;
      }
    }
    const { emitted, table, map } = output;
    if (write) {
      const outputs: [string, string][] = [
        [emitted.path, emitted.text],
        [`${emitted.path}.map`, serializeSourceMap(map)],
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
    generated.push(emitted.path);
    tables.set(emitted.path, table);
  }
  return { written, generated, tables, notes, failed };
}

/** The first line that the emitter writes for a module. Keep it equal to `emit.ts`. */
function generatedHeader(module: string): string {
  return `// Generated from ${module}.eff by the Effective compiler. Do not edit.`;
}

/**
 * Removes the outputs of modules that left the project. Each named module has
 * a `<module>.ts` and a `<module>.ts.map`. A `.ts` file goes only when its
 * first line is the emitter header of that module, so a hand-written file at
 * the same path stays. The map goes only together with its `.ts` file, and
 * before it. Returns the root-relative paths that it removed, and messages for
 * stderr.
 */
export function removeStaleOutputs(
  fs: CliFs,
  root: string,
  modules: readonly string[],
): { readonly removed: string[]; readonly notes: string[] } {
  const removed: string[] = [];
  const notes: string[] = [];
  for (const module of modules) {
    const path = `${module}.ts`;
    const read = fs.readText(joinPath(root, path));
    if (!read.ok) {
      if (read.error.tag === "unreadable") {
        notes.push(`error: cannot read ${path}: ${read.error.message}`);
      }
      continue;
    }
    if (read.value.split("\n", 1)[0] !== generatedHeader(module)) continue;
    // The map goes first. When it fails, the `.ts` file keeps the header that
    // proves ownership, so a later call can retry. A missing file counts as removed.
    for (const target of [`${path}.map`, path]) {
      const full = joinPath(root, target);
      const existed = fs.kind(full) !== "missing";
      const result = fs.remove(full);
      if (result.ok) {
        if (existed) removed.push(target);
      } else {
        notes.push(`error: cannot remove ${target}: ${result.error.message}`);
        break;
      }
    }
  }
  return { removed, notes };
}

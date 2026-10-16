// One build of a revision: print the diagnostics, and for `build` and `watch`
// also validate the IR, write the generated files, and run `deno check`.

import type { Diagnostic } from "../core/diagnostics.ts";
import type { Revision } from "../core/db.ts";
import type { SpanTable } from "../core/emit/spans.ts";
import { serializeSourceMap } from "../core/emit/sourcemap.ts";
import type { ModuleIR, Result } from "../core/ir.ts";
import type { LowerError } from "../core/lower.ts";
import { joinPath } from "../core/project.ts";
import { validateProject } from "../core/validate_project.ts";
import { formatDiagnostics, type TextOf } from "./format.ts";
import type { CliIo } from "./io.ts";
import { runTsc } from "./tsc.ts";

export interface BuildOptions {
  /** Write `<module>.ts` and `<module>.ts.map` for each module without an error. */
  readonly write: boolean;
  /** Run the IR validator and report its diagnostics. */
  readonly validate: boolean;
  /** Run `deno check` over the written files and the host modules. */
  readonly tsc: boolean;
}

export interface BuildOutcome {
  /** One line per diagnostic, for stdout. */
  readonly lines: readonly string[];
  /** Other messages, for stderr. */
  readonly notes: readonly string[];
  /** The number of diagnostics: Effective, validation, and `deno check`. */
  readonly diagnosticCount: number;
  /** True when anything went wrong: a diagnostic, or a failure to emit or to write. */
  readonly failed: boolean;
  /** The root-relative paths of the files that changed on disk. */
  readonly written: readonly string[];
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
 * Prints nothing itself. Returns the lines and notes for the caller. With
 * `write` false, only the diagnostics of the revision count.
 */
export async function buildRevision(
  io: CliIo,
  root: string,
  revision: Revision,
  textOf: TextOf,
  options: BuildOptions,
): Promise<BuildOutcome> {
  const notes: string[] = [];
  const diagnostics: Diagnostic[] = [...revision.diagnostics];
  let failed = false;
  const written: string[] = [];
  const lines: string[] = [];

  const names = revision.effModuleNames();
  const wanted = options.write || options.validate;

  // Validation reads the lowered IR of each module that lowered.
  const validation = new Map<string, readonly Diagnostic[]>();
  if (options.validate) {
    const lowered = new Map<string, Result<ModuleIR, LowerError>>();
    for (const name of names) {
      const result = revision.lowered(name);
      if (result !== undefined) lowered.set(name, result);
    }
    for (const [name, found] of validateProject(revision.project, lowered)) {
      validation.set(name, found);
      diagnostics.push(...found);
    }
  }

  const generated: string[] = [];
  const tables = new Map<string, SpanTable>();
  if (wanted) {
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
      if ((validation.get(name) ?? []).length > 0) continue;
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
      if (options.write) {
        const outputs: [string, string][] = [
          [emitted.value.path, emitted.value.text],
          [`${emitted.value.path}.map`, serializeSourceMap(map.value)],
        ];
        for (const [path, text] of outputs) {
          const full = joinPath(root, path);
          const old = io.fs.readText(full);
          if (old.ok && old.value === text) continue;
          const result = io.fs.writeText(full, text);
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
  }

  lines.push(...formatDiagnostics(diagnostics, textOf));
  let count = diagnostics.length;
  if (diagnostics.length > 0) failed = true;

  if (options.tsc) {
    if (failed) {
      notes.push("deno check skipped: the build has errors");
    } else {
      const outcome = await runTsc(
        io,
        root,
        revision.project.config,
        generated,
        tables,
        textOf,
      );
      lines.push(...outcome.lines);
      notes.push(...outcome.notes);
      count += outcome.lines.length;
      if (outcome.failed) failed = true;
    }
  }
  return { lines, notes, diagnosticCount: count, failed, written };
}

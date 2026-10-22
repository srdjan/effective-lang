// One build of a revision: print the diagnostics, and for `build` and `watch`
// also validate the IR, write the generated files, and run `deno check`.

import type {
  Diagnostic,
  LowerError,
  ModuleIR,
  Result,
  Revision,
  SpanTable,
} from "../core/mod.ts";
import { formatDiagnostics, type TextOf } from "./format.ts";
import type { CliIo } from "../host/io.ts";
import { writableModules, writeGenerated } from "../host/outputs.ts";
import { generationSource } from "../host/generation.ts";
import { runTsc } from "./tsc.ts";

export interface BuildOptions {
  /** Write `<module>.ts` and `<module>.ts.map` for each module without an error whose imported modules are also written. */
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
    for (const [name, found] of revision.validate(lowered)) {
      validation.set(name, found);
      diagnostics.push(...found);
    }
  }

  let generated: string[] = [];
  let tables = new Map<string, SpanTable>();
  if (wanted) {
    const outputs = writeGenerated(
      io.fs,
      root,
      generationSource(revision),
      writableModules(revision, validation),
      options.write,
    );
    written.push(...outputs.written);
    notes.push(...outputs.notes);
    if (outputs.failed) failed = true;
    generated = outputs.generated;
    tables = outputs.tables;
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
        revision.config,
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

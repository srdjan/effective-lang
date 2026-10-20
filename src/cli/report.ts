// Printing of a build outcome: diagnostics on stdout, everything else on stderr.

import type { BuildOutcome } from "./build.ts";
import type { CliIo } from "../host/io.ts";

/** The modules a revision checked, as one line of text. */
export function rechecked(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Writes the diagnostics to stdout, then the notes and a summary line to stderr. */
export function printOutcome(
  io: CliIo,
  outcome: BuildOutcome,
  moduleCount: number,
): void {
  for (const line of outcome.lines) io.stdout(`${line}\n`);
  for (const note of outcome.notes) io.stderr(`${note}\n`);
  const wrote = outcome.written.length === 0
    ? ""
    : `, wrote ${plural(outcome.written.length, "file")}`;
  io.stderr(
    `${plural(moduleCount, "module")}, ${
      plural(outcome.diagnosticCount, "diagnostic")
    }${wrote}\n`,
  );
}

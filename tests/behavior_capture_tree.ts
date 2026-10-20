// Test helper for the behavior capture tests: writes an instrumented copy of
// the sources into a directory, as the capture does for an exported revision.

import { assert } from "@std/assert";
import { instrumentSources } from "../scripts/behavior_capture.ts";
import { copyDirectory } from "./helpers.ts";

const ROOT = new URL("../", import.meta.url);

/**
 * Copies `src/`, `deno.json`, and `deno.lock` of the repository into `dir`,
 * and applies the hooks that append to `records`.
 */
export function writeInstrumentedTree(dir: string, records: string): void {
  copyDirectory(new URL("src/", ROOT), `${dir}/src`);
  for (const name of ["deno.json", "deno.lock"]) {
    Deno.copyFileSync(new URL(name, ROOT), `${dir}/${name}`);
  }
  const files = instrumentSources(
    (path) => Deno.readTextFileSync(new URL(path, ROOT)),
    records,
  );
  assert(files.ok, files.ok ? "" : files.error.join("\n"));
  for (const [path, text] of files.value) {
    Deno.writeTextFileSync(`${dir}/${path}`, text);
  }
}

/** The record kinds in the text of a records file, with the count of each. */
export function countKinds(records: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of records.split("\n")) {
    if (line === "") continue;
    const kind = line.split(" ", 1)[0];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

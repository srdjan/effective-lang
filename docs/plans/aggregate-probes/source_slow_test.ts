// deno test --no-lock --allow-read docs/plans/aggregate-probes/source_slow_test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../../../src/core/mod.ts";

Deno.test("aggregateStream checks, validates, and emits after Sink leftovers", () => {
  const source = Deno.readTextFileSync(new URL("source.eff", import.meta.url));
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
  const lowered = lowerProject(result.value);
  for (const value of lowered.values()) assert(value.ok, JSON.stringify(value));
  for (
    const diagnostics of validateProject(
      result.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  const emitted = emitProject(lowered, {
    config: result.value.analysis.project.config,
  }).get("main");
  assert(emitted?.ok, JSON.stringify(emitted));
  assertStringIncludes(emitted.value.text, "Stream.aggregate");
});

// Slow tests for M1, M3, and M4. They run each measurement through its
// exported function at a tiny scale: the examples and the small size, a few
// steps. They start the real server as a subprocess. They check the shape of
// the report and that no temporary directory stays behind. They make no claim
// about the time values.

import { assert, assertEquals } from "@std/assert";
import { formatM1, runM1 } from "../bench/m1.ts";
import { formatM3, runM3 } from "../bench/m3.ts";
import { formatM4, runM4 } from "../bench/m4.ts";
import { describeLspBenchError, TEMP_PREFIX } from "../bench/lsp_script.ts";
import { parseOptions } from "../bench/main.ts";

const TIMEOUT_MS = 30_000;

/** The names of the harness directories in the system temporary directory. */
function tempLeftovers(): string[] {
  const probe = Deno.makeTempDirSync();
  const parent = probe.slice(0, probe.lastIndexOf("/"));
  Deno.removeSync(probe);
  return [...Deno.readDirSync(parent)]
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(TEMP_PREFIX))
    .sort();
}

Deno.test("M1 returns a change row and a hover row for each input and edit kind", async () => {
  const before = tempLeftovers();
  const result = await runM1({
    seed: 1,
    timeoutMs: TIMEOUT_MS,
    inputs: [
      { input: "examples", warmups: 1, steps: 2 },
      { input: "small", warmups: 1, steps: 2 },
    ],
  });
  assert(result.ok, result.ok ? "" : describeLspBenchError(result.error));
  // The examples have one kind, the small size has four.
  assertEquals(
    result.value.rows.map((r) => `${r.input} ${r.kind} ${r.metric}`),
    [
      "examples body change",
      "examples body hover",
      ...["body", "header", "alias", "flip"].flatMap((kind) => [
        `small ${kind} change`,
        `small ${kind} hover`,
      ]),
    ],
  );
  for (const row of result.value.rows) {
    assertEquals(row.pairs.length, 2);
    assertEquals(row.samples.length, 4);
    assert(row.samples.every((ms) => ms > 0));
  }
  const text = formatM1(result.value);
  assert(text.includes("floor %"));
  assert(text.includes("small flip hover"));
  assert(text.includes("elapsed"));
  assertEquals(tempLeftovers(), before);
});

Deno.test("M3 returns exact count deltas for each input and edit kind", async () => {
  const before = tempLeftovers();
  const result = await runM3({
    seed: 1,
    timeoutMs: TIMEOUT_MS,
    inputs: [
      { input: "examples", steps: 2 },
      { input: "small", steps: 2 },
    ],
  });
  assert(result.ok, result.ok ? "" : describeLspBenchError(result.error));
  assertEquals(
    result.value.rows.map((r) => `${r.input} ${r.kind}`),
    [
      "examples body",
      "small body",
      "small header",
      "small alias",
      "small flip",
    ],
  );
  for (const row of result.value.rows) {
    assertEquals(row.steps.length, 2);
    for (const step of row.steps) {
      assertEquals(step.parses, 1);
      assert(step.checks >= 1);
      assertEquals(step.lowerings, 0);
      assertEquals(step.emits, 0);
    }
  }
  const byName = new Map(
    result.value.rows.map((r) => [`${r.input} ${r.kind}`, r]),
  );
  assert(byName.get("small body")?.steps.every((s) => !s.interfaceChanged));
  assert(byName.get("small alias")?.steps.every((s) => s.interfaceChanged));
  assert(byName.get("small flip")?.steps.every((s) => s.modeChanged));
  assert(byName.get("small header")?.steps.every((s) => !s.modeChanged));
  const text = formatM3(result.value);
  assert(text.includes("no noise floor"));
  assertEquals(tempLeftovers(), before);
});

Deno.test("M4 returns the rss peak and the last rss of each side for each step count", async () => {
  const before = tempLeftovers();
  const result = await runM4({
    seed: 1,
    size: "small",
    timeoutMs: TIMEOUT_MS,
    stepCounts: [4, 5],
  });
  assert(result.ok, result.ok ? "" : describeLspBenchError(result.error));
  assertEquals(result.value.rows.map((r) => r.steps), [4, 5]);
  for (const row of result.value.rows) {
    assertEquals(row.samplesA.length, row.steps);
    assertEquals(row.samplesB.length, row.steps);
    assert(row.peakA >= row.lastA && row.lastA > 0);
    assert(row.peakB >= row.lastB && row.lastB > 0);
  }
  const text = formatM4(result.value);
  assert(text.includes("sampled only at step ends"));
  assertEquals(tempLeftovers(), before);
});

Deno.test("a failed measurement removes its temporary directory", async () => {
  const before = tempLeftovers();
  // A timeout of 1 ms makes the first request fail.
  const result = await runM3({
    seed: 1,
    timeoutMs: 1,
    inputs: [{ input: "small", steps: 1 }],
  });
  assert(!result.ok);
  assertEquals(tempLeftovers(), before);
});

Deno.test("the bench options accept m1, m3, and m4", () => {
  const parsed = parseOptions(["m1", "m3", "m4"]);
  assert(parsed.ok);
  assertEquals(parsed.value.measurements, ["m1", "m3", "m4"]);
  const all = parseOptions([]);
  assert(all.ok);
  assertEquals(all.value.measurements.length, 6);
});

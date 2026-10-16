// A smoke test for the measurement harness. It runs M2 on the small size with
// a tiny iteration count through its exported function and checks the shape
// of the result. It makes no claim about the time values. It also tests the
// statistics helpers.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  ChecksumGate,
  formatM2,
  type M2Result,
  runM2,
  STAGES,
  TOKEN_NOTE,
} from "../bench/m2.ts";
import { formatM6 } from "../bench/m6.ts";
import { parseOptions } from "../bench/main.ts";
import { SIZES } from "../bench/generate.ts";
import { checksum, noiseFloor, quantile, summarize } from "../bench/stats.ts";

function smallRun(): M2Result {
  const result = runM2({
    seed: 1,
    incremental: true,
    sizes: [{
      name: "small",
      declarations: SIZES.small,
      iterations: 2,
      warmups: 1,
      editsPerKind: 1,
    }],
  });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("M2 on the small size returns the stages, the pairs, and the incremental steps", () => {
  const result = smallRun();
  assertEquals(result.sizes.length, 1);
  const size = result.sizes[0];
  assert(size !== undefined);
  assertEquals(size.name, "small");
  assertEquals(size.iterations, 2);
  assert(size.checksum.length > 0);
  assertEquals(size.stages.map((s) => s.stage), [...STAGES, "total"]);
  for (const stage of size.stages) {
    // Two timed iterations, two sides each.
    assertEquals(stage.samples.length, 4);
    assertEquals(stage.pairs.length, 2);
    for (const sample of stage.samples) assert(sample >= 0);
  }
  assertEquals(size.steps.map((s) => s.kind), ["cold", "body", "interface"]);
  const [cold, body, change] = size.steps;
  assert(cold !== undefined && body !== undefined && change !== undefined);
  assert(cold.rechecked.length >= 3);
  assertEquals(body.rechecked.length, 1);
  assert(change.rechecked.length >= 1);
  for (const step of size.steps) {
    assertEquals(step.update.samples.length, 4);
    assertEquals(step.emit.pairs.length, 2);
  }
});

Deno.test("the checksum is equal in two runs of the same project", () => {
  const a = smallRun().sizes[0]?.checksum;
  const b = smallRun().sizes[0]?.checksum;
  assert(a !== undefined);
  assertEquals(a, b);
});

Deno.test("the reports print a floor column, the rechecked sets, and the token note", () => {
  const result = smallRun();
  const m2 = formatM2(result);
  assert(m2.includes("floor %"));
  assert(m2.includes("rechecked after body"));
  assert(m2.includes(TOKEN_NOTE));
  const m6 = formatM6(result);
  assert(m6.includes("M6: noise floor"));
  assert(m6.includes("M2 size small"));
});

Deno.test("M2 reports a configuration error for zero iterations", () => {
  const result = runM2({
    seed: 1,
    incremental: false,
    sizes: [{
      name: "small",
      declarations: SIZES.small,
      iterations: 0,
      warmups: 0,
      editsPerKind: 1,
    }],
  });
  assert(!result.ok);
  assertEquals(result.error.tag, "config");
});

Deno.test("quantile and summarize interpolate between samples", () => {
  assertEquals(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assertAlmostEquals(quantile([0, 10], 0.1), 1);
  const d = summarize([5, 1, 3, 2, 4]);
  assertEquals([d.n, d.min, d.median, d.max], [5, 1, 3, 5]);
});

Deno.test("the noise floor of equal pairs is zero and of unequal pairs is the p90 deviation", () => {
  assertEquals(noiseFloor([[2, 2], [3, 3], [5, 5]]).floorPercent, 0);
  const floor = noiseFloor([[11, 10], [10, 10], [9, 10], [10, 10]]);
  assertAlmostEquals(floor.ratio.median, 1);
  // The deviations are 0, 0, 0.1, and 0.1. Their p90 is 0.1.
  assertAlmostEquals(floor.floorPercent, 10);
});

Deno.test("the checksum differs for different text and agrees for equal text", () => {
  assertEquals(checksum("abc"), checksum("abc"));
  assert(checksum("abc") !== checksum("abd"));
  assertEquals(checksum("").length, 14);
});

Deno.test("the checksum gate accepts an equal checksum and rejects a different one", () => {
  const gate = new ChecksumGate();
  assertEquals(gate.check("pipeline", "aa"), undefined);
  assertEquals(gate.check("pipeline", "aa"), undefined);
  assertEquals(gate.check("other", "bb"), undefined);
  assertEquals(gate.check("pipeline", "cc"), {
    tag: "checksum-mismatch",
    where: "pipeline",
    expected: "aa",
    actual: "cc",
  });
});

Deno.test("the bench arguments select the profile, the measurements, and the options", () => {
  const defaults = parseOptions([]);
  assert(defaults.ok);
  assertEquals(defaults.value.profile, "quick");
  assertEquals(defaults.value.measurements, ["m2", "m5", "m6"]);
  assertEquals(defaults.value.variants, true);
  const full = parseOptions([
    "--full",
    "m6",
    "m2",
    "--no-variants",
    "--json",
    "x.json",
  ]);
  assert(full.ok);
  assertEquals(full.value.profile, "full");
  assertEquals(full.value.measurements, ["m6", "m2"]);
  assertEquals(full.value.variants, false);
  assertEquals(full.value.json, "x.json");
  assert(!parseOptions(["--bogus"]).ok);
  assert(!parseOptions(["--json"]).ok);
});

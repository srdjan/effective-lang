// A slow smoke test for M5. It runs the cold `deno check` over the emitted
// examples once, with no variants, and checks the shape of the result. The
// examples must also equal the golden files, which the target builder checks.

import { assert, assertEquals } from "@std/assert";
import { formatM5, runM5 } from "../bench/m5.ts";
import { describeM5Error } from "../bench/m5_target.ts";

Deno.test("M5 times a cold deno check of the emitted examples", async () => {
  const config = {
    seed: 1,
    sizes: [],
    pairs: 1,
    warmups: 0,
    variants: false,
  };
  const result = await runM5(config);
  assert(result.ok, result.ok ? "" : describeM5Error(result.error));
  assertEquals(result.value.targets.length, 1);
  const target = result.value.targets[0];
  assert(target !== undefined);
  assertEquals(target.name, "examples");
  // The five examples, the companion module of the host interface, and users-live.ts.
  assertEquals(target.files, 7);
  assertEquals(target.samples.length, 2);
  assertEquals(target.pairs.length, 1);
  assert(target.samples.every((ms) => ms > 0));
  assert(formatM5(result.value, config).includes("control"));
});

import { assert, assertEquals } from "@std/assert";
import {
  bodyEditP90,
  formatM7,
  M7_SCENARIOS,
  type M7Result,
  type M7Row,
} from "../bench/m7.ts";
import { m4Config, m4DiskConfig, m7Config } from "../bench/profile.ts";

function row(
  size: "small" | "large",
  scenario: M7Row["scenario"],
  pairs: M7Row["pairs"],
): M7Row {
  return {
    size,
    scenario,
    saves: 1,
    samples: pairs.flatMap(([a, b]) => [a, b]),
    pairs,
  };
}

const result: M7Result = {
  seed: 1,
  presets: [{
    size: "large",
    coldPairs: 1,
    warmups: 1,
    steps: 2,
    saveAllSteps: 1,
  }],
  rows: [
    row("large", "body", [[10, 10], [20, 20], [30, 30], [40, 40], [50, 50]]),
    row("small", "body", [[1, 1]]),
  ],
  elapsedMs: 2000,
};

Deno.test("the body edit p90 comes from the large preset rows only", () => {
  assertEquals(bodyEditP90(result), 50);
  assertEquals(
    bodyEditP90({ ...result, rows: [row("small", "body", [[1, 1]])] }),
    undefined,
  );
});

Deno.test("the M7 report names the completion signal, the floor, and the budget verdict", () => {
  const text = formatM7(result);
  assert(text.includes("effektive/stats reply"));
  assert(text.includes("floor %"));
  assert(text.includes("large body"));
  assert(text.includes("p90 50.000 ms against the budget of 100 ms: within"));
  const over = formatM7({
    ...result,
    rows: [row("large", "body", [[200, 200]])],
  });
  assert(over.includes("over the budget"));
});

Deno.test("the M7 profiles cover every preset and Save All counts shrink on the large preset", () => {
  for (const profile of ["quick", "full"] as const) {
    const config = m7Config(profile);
    assertEquals(config.presets.map((p) => p.size), [
      "small",
      "medium",
      "large",
    ]);
    for (const p of config.presets) {
      assert(p.steps > 0 && p.coldPairs > 0 && p.saveAllSteps > 0);
    }
  }
  assert(
    m7Config("full").presets.every((p, i) =>
      p.steps > (m7Config("quick").presets[i]?.steps ?? 0)
    ),
  );
  assertEquals(M7_SCENARIOS.length, 6);
});

Deno.test("the M4 disk configuration differs from M4 only in writeOnSave", () => {
  for (const profile of ["quick", "full"] as const) {
    assertEquals(m4DiskConfig(profile), {
      ...m4Config(profile),
      writeOnSave: true,
    });
  }
});

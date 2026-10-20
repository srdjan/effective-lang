import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

Deno.test("pure functions lift through alias chains up to the accepted depth", async () => {
  const depths = [63, 64, 70, 125];
  const source = [
    "type Int = int",
    "type A0 = (n: Int) => Int",
    ...Array.from({ length: 125 }, (_, i) => `type A${i + 1} = A${i}`),
    "const plain = (n: Int): Int => n",
    ...depths.map((depth) => `export const lifted${depth}: A${depth} = plain`),
  ].join("\n");
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value);
  for (
    const diagnostics of validateProject(
      checked.value.analysis.project,
      lowered,
    ).values()
  ) {
    assertEquals(diagnostics, []);
  }
  const output = await runStrictTarget(
    emitProject(lowered, { config: checked.value.analysis.project.config }),
    `import { Effect } from "effect";
import { ${
      depths.map((depth) => `lifted${depth}`).join(", ")
    } } from "./main.ts";
const values = await Promise.all([${
      depths.map((depth) => `Effect.runPromise(lifted${depth}(${depth}))`).join(
        ", ",
      )
    }]);
console.log(JSON.stringify(values));`,
    "effective-alias-resolution-",
  );
  assertEquals(JSON.parse(output), depths);
});

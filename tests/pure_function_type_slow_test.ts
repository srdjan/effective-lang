import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("pure function contracts pass strict checking and run", async () => {
  const stdout = await compileStrictTarget(
    {
      "lib.eff": `
export type Int = int
export const increment = (value: Int): Int => value + 1
`,
      "main.eff": `
import { Int, increment } from "./lib.eff"
export const apply = (value: Int, callback: pure (value: Int) => Int): Int => callback(value)
export const imported = (value: Int): Int => apply(value, increment)
export const inline = (value: Int): Int => apply(value, (item) => item + 2)
export const applyEffect = (value: Int, callback: (value: Int) => Int): Int => callback(value)
export const lifted = (value: Int): Int => applyEffect(value, increment)
`,
    },
    ["main.eff"],
    `import { Effect } from "effect";
import { imported, inline, lifted } from "./main.ts";
console.log(JSON.stringify({ imported: imported(1), inline: inline(1), lifted: await Effect.runPromise(lifted(1)) }));`,
    "effektive-pure-function-type-",
  );
  assertEquals(JSON.parse(stdout), { imported: 2, inline: 3, lifted: 2 });
});

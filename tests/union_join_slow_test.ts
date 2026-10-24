import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("an inferred union of nominal records type-checks under the strict target", async () => {
  const stdout = await compileStrictTarget(
    {
      "main.eff": `
type Text = string
type Bool = boolean
type Circle = { radius: Text }
type Square = { side: Text }
type Shape = Circle | Square
const pick = (flag: Bool) => if (flag) { Circle({ radius: "r" }) } else { Square({ side: "s" }) }
export const describe = (flag: Bool): Text =>
  match pick(flag) {
    Circle(c) => c.radius,
    Square(s) => s.side
  }
`,
    },
    ["main.eff"],
    `import { describe } from "./main.ts";

console.log(JSON.stringify([describe(true), describe(false)]));`,
    "effektive-union-join-",
  );
  assertEquals(JSON.parse(stdout), ["r", "s"]);
});

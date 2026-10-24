import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("an error set alias builds into strict generated TypeScript and runs", async () => {
  const stdout = await compileStrictTarget(
    {
      "errors.eff": `export error NotFound = { id: Text }
export error Declined = { id: Text }
export type Text = string
export type PayFailure = NotFound | Declined
`,
      "pay.eff":
        `import { Declined, NotFound, PayFailure, Text } from "./errors.eff"
type Charge = (id: Text) => Text fails PayFailure
service Bank {
  charge(id: Text): Text fails PayFailure
}
export const pay = (id: Text): Text fails PayFailure uses Bank.charge => Bank.charge(id)
export const apply = (f: Charge, id: Text): Text fails PayFailure => f(id)
`,
    },
    ["pay.eff"],
    `import { Effect } from "effect";
import { Bank, pay } from "./pay.ts";
const result = await Effect.runPromise(
  pay("a").pipe(
    Effect.provideService(Bank, { charge: (id) => Effect.succeed(id + "!") }),
  ),
);
console.log(JSON.stringify({ result }));`,
    "effektive-error-set-alias-",
  );
  assertEquals(JSON.parse(stdout), { result: "a!" });
});

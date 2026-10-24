import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("a module constant of a function type alias passes strict checking and runs", async () => {
  const source = `type Count = int
error Boom = { code: int }
service Svc {
  m(x: Count): Count fails Boom
}
type F = (x: Count) => Count fails Boom uses Svc.m
type G = (x: Count) => Count
export const f: F = (x: Count): Count fails Boom uses Svc.m => Svc.m(x)
export const g: G = (x: Count): Count => x
export const h: G = (x) => x
`;
  const stdout = await compileStrictTarget(
    { "main.eff": source },
    ["main.eff"],
    `import { Effect } from "effect";
import { f, g, h, Svc } from "./main.ts";
const viaService = await Effect.runPromise(
  f(2).pipe(Effect.provideService(Svc, { m: (x) => Effect.succeed(x + 1) })),
);
console.log(JSON.stringify({ viaService, g: g(3), h: h(4) }));`,
    "effektive-function-alias-",
  );
  assertEquals(JSON.parse(stdout), { viaService: 3, g: 3, h: 4 });
});

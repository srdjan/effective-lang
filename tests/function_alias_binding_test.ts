import { assertEquals } from "@std/assert";
import { checkModule } from "./helpers.ts";

const HEAD = `type Count = int
error Boom = { code: int }
service Svc {
  m(x: Count): Count fails Boom
}
`;

function messages(text: string): string[] {
  return checkModule(HEAD + text).diagnostics.map((d) =>
    `${d.code} ${d.message}`
  );
}

Deno.test("a module constant accepts an arrow through a function type alias", () => {
  assertEquals(
    messages(`type G = (x: Count) => Count
export const g: G = (x: Count): Count => x
export const h: G = (x) => x
`),
    [],
  );
});

Deno.test("a module constant accepts an arrow with fails and uses through an alias", () => {
  assertEquals(
    messages(`type F = (x: Count) => Count fails Boom uses Svc.m
export const f: F = (x: Count): Count fails Boom uses Svc.m => Svc.m(x)
`),
    [],
  );
});

Deno.test("an alias of a function type reports an arity mismatch with the alias name", () => {
  assertEquals(
    messages(`type G = (x: Count) => Count
const g: G = (x: Count, y: Count) => x
`),
    ["type-mismatch/003 the function takes 2 parameters, but G is expected"],
  );
});

Deno.test("a brand of a function type still rejects an arrow", () => {
  assertEquals(
    messages(`type G = Brand<(x: Count) => Count>
export const g: G = (x: Count): Count => x
`),
    ["type-mismatch/003 the value is a function, but G is expected"],
  );
});

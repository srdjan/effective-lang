import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkModule, emitFiles } from "./helpers.ts";

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

Deno.test("a type over a function type has identity and holds a function", () => {
  assertEquals(
    messages(`type G = (x: Count) => Count
export const g: G = (x: Count): Count => x
`),
    [],
  );
});

Deno.test("a written function type keeps its source order for inferred parameters", () => {
  const module = emitFiles({
    "effektive.json": "{}",
    "m.eff": `type B = string
type A = int
export const g: (x: B | A) => A = (x) => 2
`,
  }, ["m.eff"]).get("m");
  assert(module !== undefined, "module m was not emitted");
  assertStringIncludes(module.text, "export const g = (x: B | A): A => 2;");
});

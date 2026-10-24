// Tests for rule R1: a primitive type node can occur only inside a type or
// error declaration. Each test runs through the public entry `checkProject`.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";

/** Checks one module `m.eff` and returns its diagnostics as `code message` lines. */
function diagnosticsOf(text: string): string[] {
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.map((d) => `${d.code} ${d.message}`);
}

Deno.test("a string parameter outside a type declaration gives declaration/013 with the exact message", () => {
  assertEquals(
    diagnosticsOf(
      "type Count = int\nconst f = (name: string): Count => 1\n",
    ),
    [
      "declaration/013 the primitive type `string` can occur only inside a type, nominal, or error declaration",
    ],
  );
});

Deno.test("a literal type outside a type declaration gives declaration/013 with its source text", () => {
  assertEquals(
    diagnosticsOf(
      'type Count = int\nconst f = (s: "paid"): Count => 1\n',
    ),
    [
      'declaration/013 the primitive type `"paid"` can occur only inside a type, nominal, or error declaration',
    ],
  );
});

Deno.test("primitives inside type and error bodies give no diagnostic", () => {
  const source = [
    "type Name = string",
    'type Status = "pending" | "paid"',
    "type Item = { name: string, tags: string[], count: int }",
    "error Declined = { reason: string }",
    "const f = (name: Name, item: Item): Name => name",
    "",
  ].join("\n");
  assertEquals(diagnosticsOf(source), []);
});

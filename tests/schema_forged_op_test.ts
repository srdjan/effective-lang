// A forged Schema operation through the validator. The IR type names 18 valid
// Schema operations. Source programs never produce another one, so the final
// fallback of the Schema rule in src/core/validate/expr.ts gives the only
// diagnostic for it. This test pins that diagnostic: the code, the IR path of
// the node, the message, and the span of the node.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { ModuleIR } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { declarationPath } from "./schema_diagnostics.ts";

function lowerFixture(name: string): {
  readonly text: string;
  readonly module: ModuleIR;
} {
  const text = Deno.readTextFileSync(
    new URL(`../fixtures/emit/${name}.eff`, import.meta.url),
  );
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": text }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  return { text, module: structuredClone(lowered.value) };
}

// One constant for each argument shape: none, callbacks, and a self reference.
for (const name of ["integer", "shifted", "tree"]) {
  Deno.test(`a Schema expression with an unknown operation gives validation/002 (${name})`, () => {
    const { text, module } = lowerFixture("schema-composition");
    const declaration = module.declarations.find((d) => d.name === name);
    assert(
      declaration?.kind === "constant" && declaration.value.kind === "schema",
      name,
    );
    // The IR type forbids this value, so the forgery writes through a wider type.
    const forged: { op: string } = declaration.value;
    forged.op = "bogus";
    const found = validateModule(module, new Map([["main.eff", text]]));
    assertEquals(
      found.map((d) => [d.code, d.message]),
      [[
        "validation/002",
        `${declarationPath(module, name)}.value: unknown schema constructor`,
      ]],
    );
    assertEquals(found[0].span, declaration.value.span);
  });
}

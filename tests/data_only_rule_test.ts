// The three data-only rules ("value", "codec", and "schema") on both sides.
// They differ in two decisions: whether `void` is data, and whether the
// reserved Schema errors are data.
//
//   value:  void is data, reserved errors are data.
//   codec:  void is data, reserved errors are not data.
//   schema: void is not data, reserved errors are not data.
//
// The codec rule has its own tests in codec_reserved_error_test.ts. This file
// pins the schema rule against the value rule: a `Schema<...>` annotation
// over `void` or a reserved error is rejected by the schema rule, and the
// value rule at the `schema()` site must not add a second report. Each test
// runs once through the checker (`checkProject`) and once through the
// validator (forged IR).

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { ModuleIR, Type } from "../src/core/ir.ts";
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";

const DATA_ONLY = "Schema decoded and encoded types must be data only";

const NOT_DATA: readonly (readonly [string, Type])[] = [
  ["void", { kind: "primitive", name: "unit" }],
  ["SchemaIssue", { kind: "named", id: SCHEMA_ISSUE_ID }],
  ["SchemaError", { kind: "named", id: SCHEMA_ERROR_ID }],
];

// ------------------------------------------------------------------ checker

function check(text: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics;
}

for (const [name] of NOT_DATA) {
  Deno.test(`the checker rejects a Schema annotation over ${name} once`, () => {
    const text = `export const s: Schema<${name}> = schema()`;
    const found = check(text);
    assertEquals(
      found.map((d) => [d.code, d.message]),
      [["type-mismatch/010", DATA_ONLY]],
    );
    const span = found[0].span;
    assertEquals(text.slice(span.start, span.end), `Schema<${name}>`);
  });

  // A `void` array element has its own report, so only the reserved errors
  // reach the schema rule through an array.
  if (name === "void") continue;
  Deno.test(`the checker rejects a Schema annotation over an array of ${name}`, () => {
    const found = check(
      `type Many = ${name}[]\nexport const s: Schema<Many> = schema()`,
    );
    assertEquals(
      found.map((d) => [d.code, d.message]),
      [["type-mismatch/010", DATA_ONLY]],
    );
  });
}

// ---------------------------------------------------------------- validator

const BASE = `type Int = int
export const ok: Schema<Int> = schema()
`;

function lowerBase(): ModuleIR {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": BASE }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  return structuredClone(lowered.value);
}

/** Replaces every use of `Int` in the constant `ok` with `replacement`. */
function retype(module: ModuleIR, replacement: Type): void {
  const index = module.declarations.findIndex((d) => d.name === "ok");
  assert(index >= 0);
  const swapped = JSON.stringify(module.declarations[index]).replaceAll(
    JSON.stringify({ kind: "named", id: "type:m#Int" }),
    JSON.stringify(replacement),
  );
  const forged: unknown = JSON.parse(swapped);
  (module.declarations as unknown[])[index] = forged;
}

Deno.test("the validator accepts the Schema over Int", () => {
  assertEquals(
    validateModule(lowerBase(), new Map([["m.eff", BASE]])),
    [],
  );
});

for (const [name, replacement] of NOT_DATA) {
  Deno.test(`the validator reports a forged Schema over ${name} as not data only`, () => {
    const module = lowerBase();
    retype(module, replacement);
    const found = validateModule(module, new Map([["m.eff", BASE]]));
    // Every report is the schema rule at a Schema type. The value rule at the
    // `schema()` expression adds nothing for any of the three.
    assert(found.length > 0, name);
    assertEquals(
      [
        ...new Set(
          found.map((d) => d.message.slice(d.message.indexOf(": ") + 2)),
        ),
      ],
      [DATA_ONLY],
      JSON.stringify(found.map((d) => d.message)),
    );
  });
}

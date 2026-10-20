// A codec over a reserved Schema error (decision D1). `SchemaIssue` and
// `SchemaError` have no compiler-derived schema, so the emitted TypeScript
// does not compile. The checker and the validator must both reject a codec
// whose decoded or encoded type is, or contains, one of them. A codec over
// `void` stays valid, although a `Schema<...>` over `void` is rejected.
//
// The checker tests run through `checkProject`. The checker stops before
// lowering, so the validator tests lower a valid codec over `Int`, replace
// `Int` in that one constant with another type, and run `validateModule`.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { Diagnostic } from "../src/core/mod.ts";
import type { ModuleIR, Type } from "../src/core/ir.ts";
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { checkModule } from "./helpers.ts";
import { declarationPath } from "./schema_diagnostics.ts";

const MESSAGE = "codec types need compiler-derived schemas";

// ------------------------------------------------------------------ checker

function check(text: string): readonly Diagnostic[] {
  return checkModule(text).diagnostics;
}

/** A codec constant whose two sides both have type `t`. */
function codecOf(t: string): string {
  return `export const c: Codec<${t}, ${t}> = codec((n: ${t}): ${t} => n, (n: ${t}): ${t} => n)`;
}

function assertCodecRejected(text: string, label: string): void {
  const diagnostics = check(text);
  assertEquals(
    diagnostics.map((d) => [d.code, d.message]),
    [["type-mismatch/010", MESSAGE]],
    label,
  );
  // The diagnostic stands on the codec call node.
  const call = text.slice(text.indexOf("codec("));
  const span = diagnostics[0].span;
  assertEquals(text.slice(span.start, span.end), call, label);
}

for (const name of ["SchemaIssue", "SchemaError"]) {
  Deno.test(`the checker rejects a codec over ${name}`, () => {
    assertCodecRejected(codecOf(name), name);
  });

  Deno.test(`the checker rejects a codec over a record with a ${name} field`, () => {
    assertCodecRejected(
      `type Wrapped = { inner: ${name} }\n${codecOf("Wrapped")}`,
      `record with ${name}`,
    );
  });

  Deno.test(`the checker rejects a codec over an array of ${name}`, () => {
    assertCodecRejected(
      `type Many = ${name}[]\n${codecOf("Many")}`,
      `array of ${name}`,
    );
  });
}

Deno.test("the checker accepts a codec over void", () => {
  assertEquals(check(codecOf("void")), []);
});

Deno.test("the checker accepts a codec over an ordinary data type", () => {
  assertEquals(
    check(`type Int = int\n${codecOf("Int")}`),
    [],
  );
});

// ---------------------------------------------------------------- validator

const BASE = `type Int = int
export const c: Codec<Int, Int> = codec((n: Int): Int => n, (n: Int): Int => n)
export const v: Codec<void, void> = codec((n: void): void => n, (n: void): void => n)
`;

const INT_ID = "type:m#Int";

function lowerBase(): { readonly text: string; readonly module: ModuleIR } {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": BASE }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  return { text: BASE, module: structuredClone(lowered.value) };
}

/** Replaces every use of `Int` in the constant named `name` with `replacement`. */
function retype(module: ModuleIR, name: string, replacement: Type): void {
  const index = module.declarations.findIndex((d) => d.name === name);
  assert(index >= 0, name);
  const swapped = JSON.stringify(module.declarations[index]).replaceAll(
    JSON.stringify({ kind: "named", id: INT_ID }),
    JSON.stringify(replacement),
  );
  // The forgery writes through a wider type: the IR type allows the result.
  const forged: unknown = JSON.parse(swapped);
  (module.declarations as unknown[])[index] = forged;
}

const FORGED: readonly (readonly [string, Type])[] = [
  ["SchemaIssue", { kind: "named", id: SCHEMA_ISSUE_ID }],
  ["SchemaError", { kind: "named", id: SCHEMA_ERROR_ID }],
  [
    "a record with a SchemaIssue field",
    {
      kind: "record",
      fields: [{
        name: "inner",
        type: { kind: "named", id: SCHEMA_ISSUE_ID },
        optional: false,
      }],
    },
  ],
  [
    "an option of SchemaError",
    { kind: "option", element: { kind: "named", id: SCHEMA_ERROR_ID } },
  ],
];

for (const [label, replacement] of FORGED) {
  Deno.test(`the validator rejects a forged codec over ${label}`, () => {
    const { text, module } = lowerBase();
    retype(module, "c", replacement);
    const found = validateModule(module, new Map([["m.eff", text]]));
    assertEquals(
      found.map((d) => [d.code, d.message]),
      [[
        "validation/002",
        `${declarationPath(module, "c")}.value: ${MESSAGE}`,
      ]],
    );
  });
}

Deno.test("the validator accepts the codec over void", () => {
  const { text, module } = lowerBase();
  assertEquals(validateModule(module, new Map([["m.eff", text]])), []);
});

Deno.test("the validator accepts the codec over an ordinary data type", () => {
  const { text, module } = lowerBase();
  retype(module, "c", {
    kind: "record",
    fields: [{
      name: "inner",
      type: { kind: "primitive", name: "string" },
      optional: false,
    }],
  });
  assertEquals(validateModule(module, new Map([["m.eff", text]])), []);
});

// A type that already has a reported error must not produce a second report
// at a Schema derivation site. Other data-only checks keep rejecting it.

import { assert } from "@std/assert";
import { checkProject, memoryHost } from "../src/core/mod.ts";
import { assertDiagnostics, type Expected } from "./schema_diagnostics.ts";

function diagnosticsOf(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics;
}

function assertChecks(
  source: string,
  expected: readonly Expected[],
  label: string,
): void {
  assertDiagnostics(source, diagnosticsOf(source), expected, label);
}

const CALLBACK = `(self: Schema<T>): Schema<T> =>
  schemaUnion([schemaStruct({ tag: lit_a, next: self }), schemaStruct({ tag: lit_a })])`;

const GUARD =
  "recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch";

Deno.test("a poisoned recursive alias gives only its own causes", () => {
  const source = `export type Int = int
export type T = { tag: "a", next: T } | { tag: "a" }
const lit_a: Schema<"a"> = schema()
export const t: Schema<T> = schemaRecursive((self: Schema<T>): Schema<T> =>
  schemaUnion([schemaStruct({ tag: lit_a, next: self }), schemaStruct({ tag: lit_a })]))
`;
  assertChecks(source, [
    ["declaration/007", "defined in terms of itself", "T"],
    [
      "declaration/013",
      "can occur only inside a type or error declaration",
      '"a"',
    ],
    ["type-mismatch/010", GUARD, CALLBACK],
  ], "poisoned recursive alias");
});

Deno.test("a Schema annotation over a data type has no diagnostic", () => {
  assertChecks(
    `export type Int = int
export const ok: Schema<Int> = schema()
export const list: Schema<Int[]> = schema()
`,
    [],
    "data Schema annotation",
  );
});

Deno.test("a Schema annotation over a function type still reports data only", () => {
  assertChecks(
    `export type Int = int
export const s: Schema<() => Int> = schema()
`,
    [
      [
        "type-mismatch/010",
        "Schema decoded and encoded types must be data only",
        "Schema<() => Int>",
      ],
      ["type-mismatch/010", "Schema data must be compiler-derived", "schema()"],
    ],
    "function Schema annotation",
  );
});

Deno.test("a Schema over an unknown type reports only the unknown name", () => {
  assertChecks(
    `export const s: Schema<Missing> = schema()
`,
    [["unknown-name/001", "unknown type `Missing`", "Missing"]],
    "unknown Schema payload",
  );
});

Deno.test("a poisoned fiber use result keeps its data-only report", () => {
  assertChecks(
    `export type Int = int
export const f = (): Int => withFiber(defer(() => 1), (fiber) => Missing)
`,
    [
      [
        "type-mismatch/010",
        "the fiber use result must be data only",
        "(fiber) => Missing",
      ],
      ["unknown-name/001", "unknown name `Missing`", "Missing"],
    ],
    "fiber use result",
  );
});

Deno.test("a guarded recursive alias with an unknown field keeps declaration/007", () => {
  assertChecks(
    `export type R = { tag: "a", next: R, extra: Missing } | { tag: "a" }
`,
    [
      ["declaration/007", "defined in terms of itself", "R"],
      ["unknown-name/001", "unknown type `Missing`", "Missing"],
    ],
    "guarded alias with unknown field",
  );
});

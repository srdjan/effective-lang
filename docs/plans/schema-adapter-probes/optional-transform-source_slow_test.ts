// deno test --no-lock --allow-all docs/plans/schema-adapter-probes/optional-transform-source_slow_test.ts
import { assert, assertEquals } from "@std/assert";
import { checkProject, memoryHost } from "../../../src/core/mod.ts";

function diagnostics(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok);
  return result.value.diagnostics.map(({ code, message }) => ({
    code,
    message,
  }));
}

const prefix = `type Int = int
error Other = {}
service Need { next(value: Int): Int }
const integer: Schema<Int> = schema()
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
`;

Deno.test("encoded-only optional descriptors and pure or effectful callbacks are accepted", () => {
  assertEquals(
    diagnostics(
      prefix +
        `const option: SchemaEncodedOptional<Option<Int>, Int> = schemaOptionFromOptionalKey(integer)
const defaulted: SchemaEncodedOptional<Int> = schemaDefaultKey(integer, (): Int => 1)
const normalized: SchemaOptional<Int> = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> => value,
  (value: Option<Int>): Option<Int> => value)
const record = schemaStruct({ option, defaulted, normalized })`,
    ),
    [],
  );
  assertEquals(
    diagnostics(
      prefix +
        `const failingDefault = schemaDefaultKey(integer, (): Int fails SchemaIssue => fail(schemaInvalid("x")))
const effectfulDefault = schemaDefaultKey(integer, (): Int uses Need.next => Need.next(1))
const existingError = schemaDefaultKey(integer, (): Int fails SchemaError => schemaDecode(integer, 1))
const failingOptional = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")),
  (value: Option<Int>): Option<Int> => value)
const effectfulOptional = schemaOptionalTransform(optional, optional,
  (value: Option<Int>): Option<Int> uses Need.next => { const tick = Need.next(1)
    value },
  (value: Option<Int>): Option<Int> => value)`,
    ),
    [],
  );
});

Deno.test("descriptors cannot run and callback failures and types remain bounded", () => {
  const cases = {
    descriptorRunner:
      "const bad = schemaDecode(schemaOptionFromOptionalKey(integer), {})",
    missingDefaultCallback: "const bad = schemaDefaultKey(integer, 1)",
    wrongDefaultType:
      'const bad = schemaDefaultKey(integer, (): string => "x")',
    unrelatedDefaultFailure:
      "const bad = schemaDefaultKey(integer, (): Int fails Other => fail(Other()))",
    wrongOptionalInput:
      "const bad = schemaOptionalTransform(integer, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    wrongOptionalResult:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Int => 1, (value: Option<Int>): Option<Int> => value)",
    unrelatedOptionalFailure:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other()), (value: Option<Int>): Option<Int> => value)",
    wrongOptionalFailure:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaError => schemaDecode(integer, 1) |> map((n) => Some(n)), (value: Option<Int>): Option<Int> => value)",
  };
  for (const [name, source] of Object.entries(cases)) {
    const found = diagnostics(prefix + source);
    assert(found.length > 0, `${name} was unexpectedly accepted`);
  }
});

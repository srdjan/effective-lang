// deno test --no-lock --allow-all docs/plans/schema-adapter-probes/required-optional-source_slow_test.ts
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

const prefix = `type Text = string
error Other = {}
service Read { next(value: Text): Text }
const text: Schema<Text> = schema()
const optional: SchemaOptional<Text> = schemaOptionalKey(text)
`;

Deno.test("required-to-optional field forms and shadowing are accepted", () => {
  assertEquals(
    diagnostics(prefix +
      `const field: SchemaDecodedOptional<Text, Text, Read.next> =
  schemaOptionalFromRequired(text, optional,
    (value: Text): Option<Text> uses Read.next => Some(Read.next(value)),
    (value: Option<Text>): Text => match value { Some(name) => name, None => "" })
const record: Schema<{ name?: Text }, { name: Text }, Read.next> =
  schemaStruct({ name: field })`),
    [],
  );
  assertEquals(
    diagnostics(
      `type Int = int
const schemaOptionalFromRequired = (): Int => 7
const value = schemaOptionalFromRequired()`,
    ),
    [],
  );
});

Deno.test("required-to-optional fields reject mismatched callbacks and descriptors", () => {
  const goodDecode = "(value: Text): Option<Text> => Some(value)";
  const goodEncode =
    '(value: Option<Text>): Text => match value { Some(name) => name, None => "" }';
  const cases = {
    optionalSource:
      `const bad = schemaOptionalFromRequired(optional, optional, ${goodDecode}, ${goodEncode})`,
    requiredTarget:
      `const bad = schemaOptionalFromRequired(text, text, ${goodDecode}, ${goodEncode})`,
    wrongDecodeResult:
      `const bad = schemaOptionalFromRequired(text, optional, (value: Text): Text => value, ${goodEncode})`,
    wrongEncodeResult:
      `const bad = schemaOptionalFromRequired(text, optional, ${goodDecode}, (value: Option<Text>): Option<Text> => value)`,
    unrelatedFailure:
      `const bad = schemaOptionalFromRequired(text, optional, (value: Text): Option<Text> fails Other => fail(Other()), ${goodEncode})`,
    schemaErrorFailure:
      `const bad = schemaOptionalFromRequired(text, optional, (value: Text): Option<Text> fails SchemaError => { const decoded = schemaDecode(text, value)\n Some(decoded) }, ${goodEncode})`,
    descriptorRunner:
      `const field = schemaOptionalFromRequired(text, optional, ${goodDecode}, ${goodEncode})\nconst bad = schemaDecode(field, {})`,
  };
  for (const [name, source] of Object.entries(cases)) {
    const found = diagnostics(prefix + source);
    assert(found.length > 0, `${name} was unexpectedly accepted`);
  }
});

// deno test --no-lock --allow-all docs/plans/schema-adapter-probes/optional-union-source_slow_test.ts
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

Deno.test("optional and tagged recursion, general Schema unions, and issue values are accepted", () => {
  assertEquals(
    diagnostics(`type Int = int
type Text = string
type LeftTag = "left"
type RightTag = "right"
type Left = { kind: LeftTag, value: Int }
type Right = { kind: RightTag, value: Int }
type OptionalNode = { next?: OptionalNode }
type TaggedNode = { kind: "end" } | { kind: "more", next: TaggedNode }
const integer: Schema<Int> = schema()
const text: Schema<Text> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
const record = schemaStruct({ value: optional })
const union = schemaUnion([left, right])
const primitives = schemaUnion([integer, text])
const overlapping = schemaUnion([left, left])
const issue = schemaAt("value", schemaBoth(integer, schemaInvalid("a"), schemaInvalid("b")))`),
    [],
  );
});

Deno.test("malformed union inputs, descriptor use, issue construction, and unguarded recursion are rejected", () => {
  const prefix = `type Int = int
type LeftTag = "left"
type RightTag = "right"
type Left = { kind: LeftTag, value: Int }
type Right = { kind: RightTag, value: Int }
const integer: Schema<Int> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
`;
  const cases = {
    oneBranch: "const bad = schemaUnion([integer])",
    notAList: "const bad = schemaUnion(integer)",
    nonSchema: "const bad = schemaUnion([integer, 3])",
    descriptor:
      "const bad = schemaUnion([integer, schemaOptionalKey(integer)])",
    optionalRunner: "const bad = schemaDecode(schemaOptionalKey(integer), 1)",
    issueKey: 'const bad = schemaAt(true, schemaInvalid("x"))',
    issueConstructor: "const bad = SchemaIssue({})",
    errorConstructor: 'const bad = SchemaError({ message: "x" })',
    requiredCycle: "type Loop = { next: Loop }",
    noTerminal:
      'type Loop = { kind: "a", next: Loop } | { kind: "b", next: Loop }',
    immediateUnionSelf: `type Node = { next?: Node }
const base: Schema<Node> = schema()
const bad: Schema<Node> = schemaRecursive(
  (self: Schema<Node>): Schema<Node> => schemaUnion([self, base]))`,
  };
  for (const [name, source] of Object.entries(cases)) {
    const found = diagnostics(prefix + source);
    assert(found.length > 0, `${name} was unexpectedly accepted`);
    if (["oneBranch", "notAList", "nonSchema", "descriptor"].includes(name)) {
      assert(
        found.some((diagnostic) => diagnostic.message.includes("schemaUnion")),
        `${name}: ${JSON.stringify(found)}`,
      );
    }
  }
});

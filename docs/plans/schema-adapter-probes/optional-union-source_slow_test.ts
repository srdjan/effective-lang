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

Deno.test("optional and tagged recursion, SchemaOptional, union, and issue values are accepted", () => {
  assertEquals(
    diagnostics(`type Int = int
type LeftTag = "left"
type RightTag = "right"
type Left = { kind: LeftTag, value: Int }
type Right = { kind: RightTag, value: Int }
type OptionalNode = { next?: OptionalNode }
type TaggedNode = { kind: "end" } | { kind: "more", next: TaggedNode }
const integer: Schema<Int> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
const record = schemaStruct({ value: optional })
const union = schemaUnion([left, right])
const issue = schemaAt("value", schemaBoth(integer, schemaInvalid("a"), schemaInvalid("b")))`),
    [],
  );
});

Deno.test("malformed unions, descriptor use, issue construction, and unguarded recursion are rejected", () => {
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
    untagged: "const bad = schemaUnion([integer, integer])",
    duplicateTag: "const bad = schemaUnion([left, left])",
    tagChangesDirection: `type WireTag = "wire"
type Wire = { kind: WireTag, value: Int }
const wireTag: Schema<WireTag> = schema()
const wire: Schema<Wire> = schemaStruct({ kind: wireTag, value: integer })
const changed: Schema<Left, Wire> = schemaTransform(wire, left,
  (value: Wire): Option<Left> => Some({ kind: "left", value: value.value }),
  (value: Left): Option<Wire> => Some({ kind: "wire", value: value.value }))
const bad = schemaUnion([changed, right])`,
    optionalRunner: "const bad = schemaDecode(schemaOptionalKey(integer), 1)",
    issueKey: 'const bad = schemaAt(true, schemaInvalid("x"))',
    issueConstructor: "const bad = SchemaIssue({})",
    errorConstructor: 'const bad = SchemaError({ message: "x" })',
    requiredCycle: "type Loop = { next: Loop }",
    noTerminal:
      'type Loop = { kind: "a", next: Loop } | { kind: "b", next: Loop }',
  };
  for (const [name, source] of Object.entries(cases)) {
    const found = diagnostics(prefix + source);
    assert(found.length > 0, `${name} was unexpectedly accepted`);
    if (["untagged", "duplicateTag", "tagChangesDirection"].includes(name)) {
      assert(
        found.some((diagnostic) => diagnostic.message.includes("schemaUnion")),
        `${name}: ${JSON.stringify(found)}`,
      );
    }
  }
});

import { assert, assertEquals } from "@std/assert";
import { lowerProject, validateProject } from "../src/core/mod.ts";
import { checkModule } from "./helpers.ts";

const checked = (source: string) => checkModule(source, "main.eff");

Deno.test("null stays a singleton in inference, arrays, equality, and finite matches", () => {
  const project = checked(`type Text = string
type Nil = null
type Bool = boolean
type Flag = "yes" | null
type Nullable = Text | null
const inferred = null
const nil: Nil = inferred
const values: Nil[] = [null, inferred]
const maybe: Nullable = nil
const compare = (value: Nullable): Bool => value === null
const reverse = (value: Nullable): Bool => null !== value
const finite = (value: Flag): Bool => match value { null => false, "yes" => true }
const justNull = (value: Nil): Nil => match value { null => null }`);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
});

Deno.test("null does not fit nonnullable values, arithmetic, unit, or group keys", () => {
  for (
    const source of [
      "const bad: Text = null",
      "const bad: void = null",
      "const bad = null + 1",
      "const bad = null === 1",
      "const bad: Option<Text> = Some(null)",
      "const bad = (value: Nil): Int => match value { true => 1 }",
      "const bad = (source: Stream<Int>) => mapGroups(source, (value: Int): Nil => null, (key, group) => key, { bufferSize: 1 })",
    ]
  ) {
    const project = checked(
      "type Text = string\ntype Int = int\ntype Nil = null\n" + source,
    );
    assert(
      project.diagnostics.some((diagnostic) =>
        diagnostic.code.startsWith("type-mismatch/") ||
        diagnostic.code.startsWith("pattern/")
      ),
      source + "\n" + JSON.stringify(project.diagnostics),
    );
  }
});

Deno.test("null-to-missing fields are shadowable and reject nullable sources or descriptor misuse", () => {
  assertEquals(
    checked(`type Text = string
const schemaNullToMissingKey = (value: Text): Text => value
const result: Text = schemaNullToMissingKey("Ada")`).diagnostics,
    [],
  );
  const prefix = `type Text = string
type Nil = null
type Nullable = Text | Nil
const text: Schema<Text> = schema()
const nil: Schema<Nil> = schema()
const nullable: Schema<Nullable> = schemaUnion([text, nil])
`;
  for (
    const source of [
      "const bad = schemaNullToMissingKey(nullable)",
      "const bad = schemaNullToMissingKey(schemaOptionalKey(text))",
      "const bad = schemaDecode(schemaNullToMissingKey(text), null)",
      "const bad = schemaNullToMissingKey(3)",
      `const fromNull: Schema<Text, Nil> = schemaTransform(nil, text,
  (value: Nil): Option<Text> => Some("Ada"),
  (value: Text): Option<Nil> => Some(null))
const bad = schemaNullToMissingKey(fromNull)`,
    ]
  ) {
    assert(
      checked(prefix + source).diagnostics.some((diagnostic) =>
        diagnostic.code.startsWith("type-mismatch/")
      ),
      source,
    );
  }
});

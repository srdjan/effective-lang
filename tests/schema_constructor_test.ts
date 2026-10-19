import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const prefix = `type Text = string
type Int = int
type D = { score: Int }
type E = { score: Text }
service Read { parse(value: Text): Int }
service Write { print(value: Int): Text }
const text: Schema<Text> = schema()
const integer: Schema<Int> = schema()
const field: Schema<Int, Text, Read.parse, Write.print> = schemaTransform(text, integer,
  (value: Text): Option<Int> uses Read.parse => Some(Read.parse(value)),
  (value: Int): Option<Text> uses Write.print => Some(Write.print(value)))
const record: Schema<D, E, Read.parse, Write.print> = schemaStruct({ score: field })
`;

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("type-side Schema construction requires D and only SchemaIssue", () => {
  const project = checked(
    prefix + `
const make = (input: D): D fails SchemaIssue => schemaMake(record, input)
const shadow = (): Int => { const schemaMake = (): Int => 4; schemaMake() }
`,
  );
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

Deno.test("type-side construction rejects encoded or partial inputs, descriptors and wrong failures", () => {
  for (
    const declaration of [
      'const bad = (): D fails SchemaIssue => schemaMake(record, { score: "4" })',
      "const bad = (): D fails SchemaIssue => schemaMake(record, {})",
      "const bad = (): D fails SchemaError => schemaMake(record, { score: 4 })",
      "const bad = (): D => schemaMake(record, { score: 4 })",
      "const bad = (input: unknown): D fails SchemaIssue => schemaMake(record, input)",
      "const bad = (): Int fails SchemaIssue => schemaMake(schemaOptionalKey(integer), 4)",
      "const bad = (): Int fails SchemaIssue => schemaMake(schemaDefaultKey(integer, (): Int => 4), 4)",
      "const bad = schemaMake",
      "const bad = (): D fails SchemaIssue => schemaMake(record)",
    ]
  ) assert(checked(prefix + declaration).diagnostics.length > 0, declaration);
});

Deno.test("independent validation recomputes constructor input and failure channels", () => {
  const source = prefix +
    "const make = (input: D): D fails SchemaIssue => schemaMake(record, input)";
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (const mutation of ["runner", "input", "failure"]) {
    const module = structuredClone(result.value);
    const declaration = module.declarations.find((d) =>
      d.kind === "function" && d.name === "make"
    );
    assert(
      declaration?.kind === "function" &&
        declaration.body.kind === "schema-make",
    );
    if (mutation === "runner") {
      Object.assign(declaration.body, { kind: "schema-decode" });
    } else if (mutation === "input") {
      Object.assign(declaration.body, {
        input: {
          ...declaration.body.input,
          kind: "literal",
          value: "4",
          type: { kind: "literal", value: "4" },
        },
      });
    } else Object.assign(declaration.body.effects, { failures: [] });
    assert(
      validateModule(module, new Map([["main.eff", source]])).length > 0,
      mutation,
    );
  }
});

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
type Nil = null
type Nullable = Text | Nil
type Encoded = { name?: Nullable }
type Decoded = { name: Text }
const text: Schema<Text> = schema()
const nullable: Schema<Nullable> = schema()
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

Deno.test("null defaults retain required decoded and nullable optional encoded fields", () => {
  const project = checked(
    prefix + `
const implicit: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultNullKey(text, (): Text => "Ada") })
const omitted: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "omit" }) })
const passed: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "passthrough" }) })
const shadow = (): Text => { const schemaDefaultNullKey = (): Text => "shadowed"; schemaDefaultNullKey() }
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

Deno.test("null defaults reject nullable wrapped channels, descriptors, bad callbacks and options", () => {
  for (
    const declaration of [
      "const bad = schemaDefaultNullKey(nullable, (): Nullable => null)",
      'const bad = schemaDefaultNullKey(schemaOptionalKey(text), (): Text => "Ada")',
      "const bad = schemaDefaultNullKey(text, (): Int => 1)",
      "const bad = schemaDefaultNullKey(text, (value: Text): Text => value)",
      'const make = (): Text => "Ada"\nconst bad = schemaDefaultNullKey(text, make)',
      'const bad = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "other" })',
      'const policy = { encodingStrategy: "omit" }\nconst bad = schemaDefaultNullKey(text, (): Text => "Ada", policy)',
      'const bad = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "omit", extra: true })',
      "error Other {}\nconst bad = schemaDefaultNullKey(text, (): Text fails Other => fail(Other {}))",
      "const bad = schemaDefaultNullKey",
      'const codec: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultNullKey(text, (): Text => "Ada") })\nconst bad = schemaEncode(codec, {})',
      'const bad = schemaDecode(schemaDefaultNullKey(text, (): Text => "Ada"), {})',
    ]
  ) {
    assert(checked(prefix + declaration).diagnostics.length > 0, declaration);
  }
  for (
    const [decoded, encoded] of [["Nullable", "Text"], ["Text", "Nullable"]]
  ) {
    const source = prefix +
      `const codec: Schema<${decoded}, ${encoded}> = schemaTransform(
  ${encoded === "Text" ? "text" : "nullable"}, ${
        decoded === "Text" ? "text" : "nullable"
      },
  (value: ${encoded}): Option<${decoded}> => Some("Ada"),
  (value: ${decoded}): Option<${encoded}> => Some("Ada"))
const bad = schemaDefaultNullKey(codec, (): ${decoded} => "Ada")`;
    assert(
      checked(source).diagnostics.some((d) =>
        d.message.includes("nonnullable")
      ),
      source,
    );
  }
});

Deno.test("independent validator rejects null-default channel and policy mutations", () => {
  const source = prefix +
    'const field = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "omit" })';
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok, JSON.stringify(result));
  const sources = new Map([["main.eff", source]]);
  for (const change of ["encoded", "decoded", "callback", "options"]) {
    const module = structuredClone(result.value);
    const field = module.declarations.find((d) =>
      d.kind === "constant" && d.name === "field"
    );
    assert(field?.kind === "constant" && field.value.kind === "schema");
    const expr = field.value;
    if (change === "encoded" || change === "decoded") {
      assert(expr.arguments[0].type.kind === "schema");
      const schema = expr.arguments[0].type;
      Object.assign(schema, {
        [change]: {
          kind: "union",
          members: [schema[change], { kind: "literal", value: null }],
        },
      });
    } else if (change === "callback") {
      assert(expr.arguments[1].type.kind === "function");
      Object.assign(expr.arguments[1].type, {
        result: { kind: "literal", value: null },
      });
    } else {
      assert(expr.arguments[2].kind === "record");
      Object.assign(expr.arguments[2].fields[0].value, {
        value: "other",
        type: { kind: "literal", value: "other" },
      });
    }
    assert(validateModule(module, sources).length > 0, change);
  }
  // Changing only the operation keeps the nullable input and callback well typed.
  // The new operation must independently reject the previously valid channels.
  const nullableSource = prefix +
    "const field = schemaDefaultKey(nullable, (): Nullable => null)";
  const nullableProject = checked(nullableSource);
  assertEquals(nullableProject.diagnostics, []);
  const nullableModule = [...lowerProject(nullableProject).values()][0];
  assert(nullableModule.ok);
  const nullableField = nullableModule.value.declarations.find((d) =>
    d.kind === "constant" && d.name === "field"
  );
  assert(
    nullableField?.kind === "constant" && nullableField.value.kind === "schema",
  );
  Object.assign(nullableField.value, { op: "default-null-key" });
  assert(
    validateModule(
      nullableModule.value,
      new Map([["main.eff", nullableSource]]),
    ).some((d) => d.message.includes("nonnullable")),
  );
});

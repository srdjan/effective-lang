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
type Decoded = { score: Int }
type Encoded = { score?: Text }
const text: Schema<Text> = schema()
const integer: Schema<Int> = schema()
const converted: Schema<Int, Text> = schemaTransform(text, integer,
  (value: Text): Option<Int> => Some(1),
  (value: Int): Option<Text> => Some("1"))
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

Deno.test("encoded defaults check callbacks against E and retain field directionality", () => {
  const project = checked(
    prefix + `
const implicit: Schema<Decoded, Encoded> = schemaStruct({ score: schemaDefaultEncodedKey(converted, (): Text => "1") })
const omitted: Schema<Decoded, Encoded> = schemaStruct({ score: schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "omit" }) })
const passed: Schema<Decoded, Encoded> = schemaStruct({ score: schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "passthrough" }) })
const shadow = (): Text => { const schemaDefaultEncodedKey = (): Text => "local"; schemaDefaultEncodedKey() }
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

Deno.test("encoded defaults reject decoded callbacks and invalid construction boundaries", () => {
  for (
    const declaration of [
      "const bad = schemaDefaultEncodedKey(converted, (): Int => 1)",
      'const bad = schemaDefaultEncodedKey(schemaOptionalKey(text), (): Text => "1")',
      'const make = (): Text => "1"\nconst bad = schemaDefaultEncodedKey(converted, make)',
      "const bad = schemaDefaultEncodedKey(converted, (value: Text): Text => value)",
      'const bad = schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "other" })',
      'const policy = { encodingStrategy: "omit" }\nconst bad = schemaDefaultEncodedKey(converted, (): Text => "1", policy)',
      'const bad = schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "omit", extra: true })',
      "const bad = schemaDefaultEncodedKey",
      'const bad = schemaDecode(schemaDefaultEncodedKey(converted, (): Text => "1"), {})',
      'const s: Schema<Decoded, Encoded> = schemaStruct({ score: schemaDefaultEncodedKey(converted, (): Text => "1") })\nconst bad = schemaEncode(s, {})',
    ]
  ) assert(checked(prefix + declaration).diagnostics.length > 0, declaration);
});

Deno.test("encoded default callbacks may fail only with SchemaIssue or SchemaError", () => {
  for (
    const failures of ["SchemaIssue", "SchemaError"]
  ) {
    const accepted = checked(
      prefix +
        `const ok = schemaDefaultEncodedKey(converted, (): Text fails ${failures} => "1")`,
    );
    assertEquals(accepted.diagnostics, [], failures);
  }
  for (
    const [failures, body] of [
      ["Other", "fail(Other({}))"],
      ["SchemaIssue | SchemaError", '"1"'],
    ]
  ) {
    const callback = `(): Text fails ${failures} => ${body}`;
    const source = prefix + "error Other = {}\n" +
      `const bad = schemaDefaultEncodedKey(converted, ${callback})`;
    const { diagnostics } = checked(source);
    assertEquals(
      diagnostics.map((d) => d.code),
      ["type-mismatch/010"],
      failures,
    );
    assert(
      diagnostics[0].message.includes(
        "callback may fail only with SchemaIssue or SchemaError",
      ),
      diagnostics[0].message,
    );
    assertEquals(
      source.slice(diagnostics[0].span.start, diagnostics[0].span.end),
      callback,
    );
  }
});

Deno.test("validator distinguishes encoded defaults from decoded defaults and checks policies", () => {
  const source = prefix +
    'const field = schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "omit" })';
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (const mutation of ["operation", "options", "optional"]) {
    const module = structuredClone(result.value);
    const field = module.declarations.find((d) =>
      d.kind === "constant" && d.name === "field"
    );
    assert(field?.kind === "constant" && field.value.kind === "schema");
    if (mutation === "operation") {
      Object.assign(field.value, { op: "default-key" });
    } else if (mutation === "optional") {
      Object.assign(field.value.type, { encodedOptionalKey: false });
    } else {
      const options = field.value.arguments[2];
      assert(options.kind === "record");
      Object.assign(options.fields[0].value, {
        value: "other",
        type: { kind: "literal", value: "other" },
      });
    }
    assert(
      validateModule(module, new Map([["main.eff", source]])).length > 0,
      mutation,
    );
  }
  // Mutating only the operation leaves a valid decoded callback and its body intact.
  const decodedSource = prefix +
    "const field = schemaDefaultKey(converted, (): Int => 1)";
  const decoded = [...lowerProject(checked(decodedSource)).values()][0];
  assert(decoded.ok);
  const field = decoded.value.declarations.find((d) =>
    d.kind === "constant" && d.name === "field"
  );
  assert(field?.kind === "constant" && field.value.kind === "schema");
  Object.assign(field.value, { op: "default-encoded-key" });
  assert(
    validateModule(decoded.value, new Map([["main.eff", decodedSource]])).some((
      d,
    ) => d.message.includes("encoded field type")),
  );
});

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import {
  assertRejected,
  assertValidation,
  type Case,
  declarationPath,
  PURE_CONSTANT,
} from "./schema_diagnostics.ts";

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
  const cases: readonly Case[] = [
    [
      "const bad = schemaDefaultEncodedKey(converted, (): Int => 1)",
      [
        "type-mismatch/003",
        "schemaDefaultEncodedKey callback must return the encoded field type",
        "(): Int => 1",
      ],
    ],
    [
      'const bad = schemaDefaultEncodedKey(schemaOptionalKey(text), (): Text => "1")',
      [
        "type-mismatch/010",
        "`schemaDefaultEncodedKey` needs a Schema value",
        "schemaOptionalKey(text)",
      ],
    ],
    [
      'const make = (): Text => "1"\nconst bad = schemaDefaultEncodedKey(converted, make)',
      [
        "type-mismatch/010",
        "schemaDefaultEncodedKey needs an inline default callback",
        "make",
      ],
    ],
    [
      "const bad = schemaDefaultEncodedKey(converted, (value: Text): Text => value)",
      [
        "type-mismatch/004",
        "the callback of `schemaDefaultEncodedKey` takes 0 parameters, but the function takes 1",
        "(value: Text): Text => value",
      ],
    ],
    [
      'const bad = schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "other" })',
      [
        "type-mismatch/010",
        'schemaDefaultEncodedKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        '{ encodingStrategy: "other" }',
      ],
      [
        "type-mismatch/003",
        "the field `encodingStrategy` has type string",
        '"other"',
      ],
    ],
    [
      'const policy = { encodingStrategy: "omit" }\nconst bad = schemaDefaultEncodedKey(converted, (): Text => "1", policy)',
      [
        "type-mismatch/010",
        'schemaDefaultEncodedKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        "policy",
      ],
    ],
    [
      'const bad = schemaDefaultEncodedKey(converted, (): Text => "1", { encodingStrategy: "omit", extra: true })',
      [
        "type-mismatch/010",
        'schemaDefaultEncodedKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        '{ encodingStrategy: "omit", extra: true }',
      ],
      ["type-mismatch/005", "has no field `extra`", "extra"],
    ],
    [
      "const bad = schemaDefaultEncodedKey",
      [
        "unknown-name/004",
        "can only be called or used as a pipeline stage",
        "schemaDefaultEncodedKey",
      ],
    ],
    [
      'const bad = schemaDecode(schemaDefaultEncodedKey(converted, (): Text => "1"), {})',
      [
        "execution-mode/002",
        PURE_CONSTANT,
        'schemaDecode(schemaDefaultEncodedKey(converted, (): Text => "1"), {})',
      ],
      [
        "type-mismatch/010",
        "`schemaDecode` needs a Schema value",
        'schemaDefaultEncodedKey(converted, (): Text => "1")',
      ],
    ],
    [
      'const s: Schema<Decoded, Encoded> = schemaStruct({ score: schemaDefaultEncodedKey(converted, (): Text => "1") })\nconst bad = schemaEncode(s, {})',
      ["execution-mode/002", PURE_CONSTANT, "schemaEncode(s, {})"],
      ["type-mismatch/005", "the record is missing the field `score`", "{}"],
    ],
  ];
  assertRejected(
    cases,
    (declaration) => prefix + declaration,
    (source) => checked(source).diagnostics,
  );
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
  for (
    const [mutation, path, fragment] of [
      [
        "operation",
        ".value",
        "schemaDefaultKey needs a callback returning the decoded field type",
      ],
      ["options", ".value", "schemaDefaultEncodedKey options need one literal"],
      ["optional", ".value.type", "expected SchemaEncodedOptional<"],
    ] as const
  ) {
    const module = structuredClone(result.value);
    const field = module.declarations.find((d) =>
      d.kind === "constant" && d.name === "field"
    );
    assert(field?.kind === "constant" && field.value.kind === "schema");
    if (mutation === "operation") {
      Object.assign(field.value, { op: "default-key" });
    } else if (mutation === "optional") {
      Reflect.deleteProperty(field.value.type, "encodedOptionalKey");
    } else {
      const options = field.value.arguments[2];
      assert(options.kind === "record");
      Object.assign(options.fields[0].value, {
        value: "other",
        type: { kind: "literal", value: "other" },
      });
    }
    assertValidation(
      validateModule(module, new Map([["main.eff", source]])),
      "validation/002",
      `${declarationPath(module, "field")}${path}`,
      fragment,
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

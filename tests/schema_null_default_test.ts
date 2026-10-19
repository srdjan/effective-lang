import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import {
  assertDiagnostics,
  assertRejected,
  assertValidation,
  type Case,
  declarationPath,
  PURE_CONSTANT,
} from "./schema_diagnostics.ts";

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
  const cases: readonly Case[] = [
    [
      "const bad = schemaDefaultNullKey(nullable, (): Nullable => null)",
      [
        "type-mismatch/010",
        "schemaDefaultNullKey needs nonnullable decoded and encoded field types",
        "nullable",
      ],
    ],
    [
      'const bad = schemaDefaultNullKey(schemaOptionalKey(text), (): Text => "Ada")',
      [
        "type-mismatch/010",
        "`schemaDefaultNullKey` needs a Schema value",
        "schemaOptionalKey(text)",
      ],
    ],
    [
      "const bad = schemaDefaultNullKey(text, (): Int => 1)",
      [
        "type-mismatch/003",
        "schemaDefaultNullKey callback must return the decoded field type",
        "(): Int => 1",
      ],
    ],
    [
      "const bad = schemaDefaultNullKey(text, (value: Text): Text => value)",
      [
        "type-mismatch/004",
        "the callback of `schemaDefaultNullKey` takes 0 parameters, but the function takes 1",
        "(value: Text): Text => value",
      ],
    ],
    [
      'const make = (): Text => "Ada"\nconst bad = schemaDefaultNullKey(text, make)',
      [
        "type-mismatch/010",
        "schemaDefaultNullKey needs an inline default callback",
        "make",
      ],
    ],
    [
      'const bad = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "other" })',
      [
        "type-mismatch/010",
        'schemaDefaultNullKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        '{ encodingStrategy: "other" }',
      ],
      [
        "type-mismatch/003",
        "the field `encodingStrategy` has type string",
        '"other"',
      ],
    ],
    [
      'const policy = { encodingStrategy: "omit" }\nconst bad = schemaDefaultNullKey(text, (): Text => "Ada", policy)',
      [
        "type-mismatch/010",
        'schemaDefaultNullKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        "policy",
      ],
    ],
    [
      'const bad = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "omit", extra: true })',
      [
        "type-mismatch/010",
        'schemaDefaultNullKey options must be an inline { encodingStrategy: "omit" | "passthrough" } record',
        '{ encodingStrategy: "omit", extra: true }',
      ],
      ["type-mismatch/005", "has no field `extra`", "extra"],
    ],
    [
      "const bad = schemaDefaultNullKey",
      [
        "unknown-name/004",
        "can only be called or used as a pipeline stage",
        "schemaDefaultNullKey",
      ],
    ],
    [
      'const wire: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultNullKey(text, (): Text => "Ada") })\nconst bad = schemaEncode(wire, {})',
      ["execution-mode/002", PURE_CONSTANT, "schemaEncode(wire, {})"],
      ["type-mismatch/005", "the record is missing the field `name`", "{}"],
    ],
    [
      'const bad = schemaDecode(schemaDefaultNullKey(text, (): Text => "Ada"), {})',
      [
        "execution-mode/002",
        PURE_CONSTANT,
        'schemaDecode(schemaDefaultNullKey(text, (): Text => "Ada"), {})',
      ],
      [
        "type-mismatch/010",
        "`schemaDecode` needs a Schema value",
        'schemaDefaultNullKey(text, (): Text => "Ada")',
      ],
    ],
  ];
  assertRejected(
    cases,
    (declaration) => prefix + declaration,
    (source) => checked(source).diagnostics,
  );
  for (
    const [decoded, encoded] of [["Nullable", "Text"], ["Text", "Nullable"]]
  ) {
    const source = prefix +
      `const wire: Schema<${decoded}, ${encoded}> = schemaTransform(
  ${encoded === "Text" ? "text" : "nullable"}, ${
        decoded === "Text" ? "text" : "nullable"
      },
  (value: ${encoded}): Option<${decoded}> => Some("Ada"),
  (value: ${decoded}): Option<${encoded}> => Some("Ada"))
const bad = schemaDefaultNullKey(wire, (): ${decoded} => "Ada")`;
    assertDiagnostics(source, checked(source).diagnostics, [[
      "type-mismatch/010",
      "schemaDefaultNullKey needs nonnullable decoded and encoded field types",
      "wire",
    ]], source);
  }
});

Deno.test("null default callbacks may fail only with SchemaIssue or SchemaError", () => {
  for (
    const failures of ["SchemaIssue", "SchemaError"]
  ) {
    const accepted = checked(
      prefix +
        `const ok = schemaDefaultNullKey(text, (): Text fails ${failures} => "Ada")`,
    );
    assertEquals(accepted.diagnostics, [], failures);
  }
  for (
    const [failures, body] of [
      ["Other", "fail(Other({}))"],
      ["SchemaIssue | SchemaError", '"Ada"'],
    ]
  ) {
    const callback = `(): Text fails ${failures} => ${body}`;
    const source = prefix + "error Other = {}\n" +
      `const bad = schemaDefaultNullKey(text, ${callback})`;
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

Deno.test("independent validator rejects null-default channel and policy mutations", () => {
  const source = prefix +
    'const field = schemaDefaultNullKey(text, (): Text => "Ada", { encodingStrategy: "omit" })';
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok, JSON.stringify(result));
  const sources = new Map([["main.eff", source]]);
  for (
    const [change, path, fragment] of [
      ["encoded", ".value.arguments[0].type", "expected Schema<"],
      ["decoded", ".value.arguments[0].type", "expected Schema<"],
      [
        "callback",
        ".value",
        "schemaDefaultNullKey needs a callback returning the decoded field type",
      ],
      ["options", ".value", "schemaDefaultNullKey options need one literal"],
    ] as const
  ) {
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
    assertValidation(
      validateModule(module, sources),
      "validation/002",
      `${declarationPath(module, "field")}${path}`,
      fragment,
      change,
    );
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

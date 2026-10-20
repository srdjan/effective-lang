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
const implicit: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { on: "null" }) })
const omitted: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { on: "null", encodingStrategy: "omit" }) })
const passed: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { on: "null", encodingStrategy: "passthrough" }) })
const shadow = (): Text => { const schemaDefaultKey = (): Text => "shadowed"; schemaDefaultKey() }
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
      'const bad = schemaDefaultKey(nullable, (): Nullable => null, { on: "null" })',
      [
        "type-mismatch/010",
        "schemaDefaultKey needs nonnullable decoded and encoded field types",
        "nullable",
      ],
    ],
    [
      'const bad = schemaDefaultKey(schemaOptionalKey(text), (): Text => "Ada", { on: "null" })',
      [
        "type-mismatch/010",
        "`schemaDefaultKey` needs a Schema value",
        "schemaOptionalKey(text)",
      ],
    ],
    [
      'const bad = schemaDefaultKey(text, (): Int => 1, { on: "null" })',
      [
        "type-mismatch/003",
        "schemaDefaultKey callback must return the decoded field type",
        "(): Int => 1",
      ],
    ],
    [
      'const bad = schemaDefaultKey(text, (value: Text): Text => value, { on: "null" })',
      [
        "type-mismatch/004",
        "the callback of `schemaDefaultKey` takes 0 parameters, but the function takes 1",
        "(value: Text): Text => value",
      ],
    ],
    [
      'const make = (): Text => "Ada"\nconst bad = schemaDefaultKey(text, make, { on: "null" })',
      [
        "type-mismatch/010",
        "schemaDefaultKey needs an inline default callback",
        "make",
      ],
    ],
    [
      'const bad = schemaDefaultKey(text, (): Text => "Ada", { on: "null", encodingStrategy: "other" })',
      [
        "type-mismatch/010",
        'schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values',
        '{ on: "null", encodingStrategy: "other" }',
      ],
      [
        "type-mismatch/003",
        "the field `encodingStrategy` has type string",
        '"other"',
      ],
    ],
    [
      'const policy = { encodingStrategy: "omit" }\nconst bad = schemaDefaultKey(text, (): Text => "Ada", policy)',
      [
        "type-mismatch/010",
        'schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values',
        "policy",
      ],
    ],
    [
      'const bad = schemaDefaultKey(text, (): Text => "Ada", { on: "null", encodingStrategy: "omit", extra: true })',
      [
        "type-mismatch/010",
        'schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values',
        '{ on: "null", encodingStrategy: "omit", extra: true }',
      ],
      ["type-mismatch/005", "has no field `extra`", "extra"],
    ],
    [
      "const bad = schemaDefaultKey",
      [
        "unknown-name/004",
        "can only be called or used as a pipeline stage",
        "schemaDefaultKey",
      ],
    ],
    [
      'const wire: Schema<Decoded, Encoded> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { on: "null" }) })\nconst bad = schemaEncode(wire, {})',
      ["execution-mode/002", PURE_CONSTANT, "schemaEncode(wire, {})"],
      ["type-mismatch/005", "the record is missing the field `name`", "{}"],
    ],
    [
      'const bad = schemaDecode(schemaDefaultKey(text, (): Text => "Ada", { on: "null" }), {})',
      [
        "execution-mode/002",
        PURE_CONSTANT,
        'schemaDecode(schemaDefaultKey(text, (): Text => "Ada", { on: "null" }), {})',
      ],
      [
        "type-mismatch/010",
        "`schemaDecode` needs a Schema value",
        'schemaDefaultKey(text, (): Text => "Ada", { on: "null" })',
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
const bad = schemaDefaultKey(wire, (): ${decoded} => "Ada", { on: "null" })`;
    assertDiagnostics(source, checked(source).diagnostics, [[
      "type-mismatch/010",
      "schemaDefaultKey needs nonnullable decoded and encoded field types",
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
        `const ok = schemaDefaultKey(text, (): Text fails ${failures} => "Ada", { on: "null" })`,
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
      `const bad = schemaDefaultKey(text, ${callback}, { on: "null" })`;
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
    'const field = schemaDefaultKey(text, (): Text => "Ada", { on: "null", encodingStrategy: "omit" })';
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

function loweredField(source: string) {
  const project = checked(prefix + source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok, JSON.stringify(result));
  const field = result.value.declarations.find((d) =>
    d.kind === "constant" && d.name === "field"
  );
  assert(field?.kind === "constant" && field.value.kind === "schema");
  return field.value;
}

Deno.test("the on option selects the operation and lowers without the on field", () => {
  const cases = [
    ['{ on: "missing" }', "default-key", 2],
    ['{ on: "null" }', "default-null-key", 2],
    ['{ on: "encoded" }', "default-encoded-key", 2],
    ['{ encodingStrategy: "omit" }', "default-key", 3],
    ['{ on: "null", encodingStrategy: "omit" }', "default-null-key", 3],
    ['{ encodingStrategy: "omit", on: "encoded" }', "default-encoded-key", 3],
  ] as const;
  for (const [options, op, count] of cases) {
    const expr = loweredField(
      `const field = schemaDefaultKey(text, (): Text => "Ada", ${options})`,
    );
    assertEquals(expr.op, op, options);
    assertEquals(expr.arguments.length, count, options);
    const record = expr.arguments[2];
    if (record !== undefined) {
      assert(record.kind === "record" && record.type.kind === "record");
      assertEquals(record.fields.map((f) => f.name), ["encodingStrategy"]);
      assertEquals(record.type.fields.map((f) => f.name), ["encodingStrategy"]);
    }
  }
});

Deno.test("the on option must be a literal of the three operations", () => {
  const cases = [
    '{ on: "other" }',
    "{ on: 1 }",
    '{ on: "null", on: "encoded" }',
  ];
  for (const options of cases) {
    const source = prefix +
      `const bad = schemaDefaultKey(text, (): Text => "Ada", ${options})`;
    const result = checkProject(
      memoryHost({ "effective.json": "{}", "main.eff": source }),
      "",
      ["main.eff"],
    );
    assert(result.ok);
    const messages = result.value.diagnostics.map((d) => d.message);
    assert(
      messages.some((m) =>
        m.includes("`on` must be a literal") || m.includes("options must be")
      ),
      `${options}: ${messages.join("\n")}`,
    );
  }
  const variable = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": prefix +
        `const mode = "null"\nconst bad = schemaDefaultKey(text, (): Text => "Ada", { on: mode })`,
    }),
    "",
    ["main.eff"],
  );
  assert(variable.ok);
  assert(
    variable.value.diagnostics.some((d) =>
      d.message.includes("`on` must be a literal")
    ),
  );
});

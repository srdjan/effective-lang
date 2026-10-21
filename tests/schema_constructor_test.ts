import { assert, assertEquals } from "@std/assert";
import { lowerProject, validateProject } from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import {
  assertRejected,
  assertValidation,
  type Case,
  declarationPath,
} from "./schema_diagnostics.ts";
import { checkModule } from "./helpers.ts";

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

const checked = (source: string) => checkModule(source, "main.eff");

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
  const missingIssue =
    "the body can fail with error:effect/SchemaIssue, which the `fails` clause does not list";
  const cases: readonly Case[] = [
    [
      'const bad = (): D fails SchemaIssue => schemaMake(record, { score: "4" })',
      [
        "type-mismatch/003",
        "the field `score` has type string, but Int is expected",
        '"4"',
      ],
    ],
    [
      "const bad = (): D fails SchemaIssue => schemaMake(record, {})",
      ["type-mismatch/005", "the record is missing the field `score`", "{}"],
    ],
    [
      "const bad = (): D fails SchemaError => schemaMake(record, { score: 4 })",
      [
        "failure-contract/001",
        missingIssue,
        "schemaMake(record, { score: 4 })",
      ],
    ],
    [
      "const bad = (): D => schemaMake(record, { score: 4 })",
      [
        "failure-contract/001",
        missingIssue,
        "schemaMake(record, { score: 4 })",
      ],
    ],
    [
      "const bad = (input: unknown): D fails SchemaIssue => schemaMake(record, input)",
      [
        "type-mismatch/003",
        "the schema make input has type unknown, but D is expected",
        "input",
      ],
    ],
    [
      "const bad = (): Int fails SchemaIssue => schemaMake(schemaOptionalKey(integer), 4)",
      [
        "type-mismatch/010",
        "`schemaMake` needs a Schema value",
        "schemaOptionalKey(integer)",
      ],
    ],
    [
      "const bad = (): Int fails SchemaIssue => schemaMake(schemaDefaultKey(integer, (): Int => 4), 4)",
      [
        "type-mismatch/010",
        "`schemaMake` needs a Schema value",
        "schemaDefaultKey(integer, (): Int => 4)",
      ],
    ],
    [
      "const bad = schemaMake",
      [
        "unknown-name/004",
        "can only be called or used as a pipeline stage",
        "schemaMake",
      ],
    ],
    [
      "const bad = (): D fails SchemaIssue => schemaMake(record)",
      [
        "type-mismatch/004",
        "`schemaMake` takes 2 arguments, but 1 is given",
        "schemaMake(record)",
      ],
    ],
  ];
  assertRejected(
    cases,
    (declaration) => prefix + declaration,
    (source) => checked(source).diagnostics,
  );
});

Deno.test("independent validation recomputes constructor input and failure channels", () => {
  const source = prefix +
    "const make = (input: D): D fails SchemaIssue => schemaMake(record, input)";
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const [mutation, path, fragment] of [
      [
        "runner",
        ".body.effects.failures",
        "expected [error:effect/SchemaError]",
      ],
      ["input", ".body.input", "schemaMake input does not fit decoded type"],
      [
        "failure",
        ".body.effects.failures",
        "expected [error:effect/SchemaIssue], recorded []",
      ],
    ] as const
  ) {
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
    assertValidation(
      validateModule(module, new Map([["main.eff", source]])),
      mutation === "input" ? "validation/002" : "validation/003",
      `${declarationPath(module, "make")}${path}`,
      fragment,
      mutation,
    );
  }
});

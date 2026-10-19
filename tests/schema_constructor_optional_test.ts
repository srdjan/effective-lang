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

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-optional.eff", import.meta.url),
);

function checked(source = fixture) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("optional adapters retain target make inputs and invariant field types", () => {
  const project = checked();
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

Deno.test("optional constructor inputs keep required keys, complete Options and decoded defaults", () => {
  const cases: readonly Case[] = [
    [
      "const bad: SchemaEncodedOptional<D, E, Read.parse | Defaults.next, Write.print> = decodedField",
      ["type-mismatch/003", "has type SchemaEncodedOptional<", "decodedField"],
    ],
    [
      "const bad = schemaMake(decoded, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(decoded, {})"],
      ["type-mismatch/005", "the record is missing the field `settings`", "{}"],
    ],
    [
      "const bad = schemaMake(encoded, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(encoded, {})"],
      ["type-mismatch/005", "the record is missing the field `settings`", "{}"],
    ],
    [
      "const bad = schemaMake(nullDefault, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(nullDefault, {})"],
      ["type-mismatch/005", "the record is missing the field `settings`", "{}"],
    ],
    [
      "const bad = schemaMake(nullMissing, { settings: null })",
      [
        "execution-mode/002",
        PURE_CONSTANT,
        "schemaMake(nullMissing, { settings: null })",
      ],
      [
        "type-mismatch/003",
        "the field `settings` has type null, but M is expected",
        "null",
      ],
    ],
    [
      'const bad = schemaMake(transformed, { settings: { label: "source" } })',
      [
        "execution-mode/002",
        PURE_CONSTANT,
        'schemaMake(transformed, { settings: { label: "source" } })',
      ],
      ["type-mismatch/005", "the record type M has no field `label`", "label"],
    ],
    [
      "const bad = schemaMake(optionRecord, { settings: Some({}) })",
      [
        "execution-mode/002",
        PURE_CONSTANT,
        "schemaMake(optionRecord, { settings: Some({}) })",
      ],
      ["type-mismatch/005", "the record is missing the field `score`", "{}"],
    ],
    [
      "const bad = schemaMake(optionRecord, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(optionRecord, {})"],
      ["type-mismatch/005", "the record is missing the field `settings`", "{}"],
    ],
    [
      "const bad = schemaDefaultKey(child, (): M => ({}))",
      [
        "type-mismatch/003",
        "schemaDefaultKey callback must return the decoded field type",
        "(): M => ({})",
      ],
    ],
    [
      "const bad = schemaDefaultNullKey(child, (): M => ({}))",
      [
        "type-mismatch/003",
        "schemaDefaultNullKey callback must return the decoded field type",
        "(): M => ({})",
      ],
    ],
    [
      "const bad = schemaDefaultEncodedKey(child, (): M => ({}))",
      [
        "type-mismatch/003",
        "schemaDefaultEncodedKey callback must return the encoded field type",
        "(): M => ({})",
      ],
    ],
  ];
  assertRejected(
    cases,
    (declaration) => fixture + "\n" + declaration,
    (source) => checked(source).diagnostics,
  );
});

Deno.test("independent validation recomputes optional adapter make inputs", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const name of [
      "nullField",
      "decodedField",
      "encodedField",
      "transformedField",
      "requiredField",
      "optionField",
    ]
  ) {
    const forged = structuredClone(result.value);
    const field = forged.declarations.find((d) =>
      d.kind === "constant" && d.name === name
    );
    assert(
      field?.kind === "constant" && field.value.kind === "schema" &&
        field.value.type.kind === "schema",
    );
    Object.assign(field.value.type, {
      makeInput: name === "optionField"
        ? { kind: "option", element: { kind: "record", fields: [] } }
        : field.value.type.decoded,
    });
    assertValidation(
      validateModule(forged, new Map([["main.eff", fixture]])),
      "validation/002",
      `${declarationPath(forged, name)}.value.type`,
      "expected ",
      name,
    );
  }
});

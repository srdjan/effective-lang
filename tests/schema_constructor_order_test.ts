import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import {
  assertRejected,
  assertValidation,
  type Case,
  declarationPath,
  PURE_CONSTANT,
} from "./schema_diagnostics.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-order.eff", import.meta.url),
);
const base = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-fields.eff", import.meta.url),
);
function checked(source = fixture) {
  const result = checkProject(
    memoryHost({
      "effektive.json": "{}",
      "main.eff": source,
      "schema-constructor-fields.eff": base,
    }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("field adapter order preserves unary defaults, selects target defaults and resets Option defaults", () => {
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

Deno.test("adapter order rejects false flags, duplicate defaults and incompatible input presence", () => {
  const cases: readonly Case[] = [
    [
      "const bad: SchemaOptional<D,E,Read.parse,Write.print,M> = optionalAfter",
      [
        "type-mismatch/003",
        "has type SchemaOptionalConstructorDefault<",
        "optionalAfter",
      ],
    ],
    [
      "const bad: SchemaOptionalConstructorDefault<D,Text,Read.parse,Write.print,M> = sourceBridge",
      ["type-mismatch/003", "has type SchemaOptional<", "sourceBridge"],
    ],
    [
      "const bad: SchemaEncodedOptionalConstructorDefault<Option<D>,E,Read.parse,Write.print> = optionAfter",
      ["type-mismatch/003", "has type SchemaEncodedOptional<", "optionAfter"],
    ],
    [
      "const bad = schemaConstructorDefault(optionalAfter, (): M => ({}))",
      [
        "type-mismatch/010",
        "`schemaConstructorDefault` needs a Schema value",
        "optionalAfter",
      ],
    ],
    [
      "const bad = schemaOptionalKey(decodedAfter)",
      [
        "type-mismatch/010",
        "`schemaOptionalKey` needs a Schema value",
        "decodedAfter",
      ],
    ],
    [
      "const bad = schemaDefaultKey(optionalAfter, (): D => ({ score: 4 }))",
      [
        "type-mismatch/010",
        "`schemaDefaultKey` needs a Schema value",
        "optionalAfter",
      ],
    ],
    [
      "const bad = schemaArray(sourceDefault)",
      [
        "type-mismatch/010",
        "`schemaArray` needs a Schema value",
        "sourceDefault",
      ],
    ],
    [
      "const bad = schemaMake(sourceDefault, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(sourceDefault, {})"],
      [
        "type-mismatch/010",
        "`schemaMake` needs a Schema value",
        "sourceDefault",
      ],
    ],
    [
      "const bad = schemaMake(optionRecord, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(optionRecord, {})"],
      ["type-mismatch/005", "the record is missing the field `settings`", "{}"],
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
  ];
  assertRejected(
    cases,
    (declaration) => fixture + "\n" + declaration,
    (source) => checked(source).diagnostics,
  );
});

Deno.test("independent validation recomputes retained, target and reset constructor flags", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  const result = lowered.get("main");
  assert(result?.ok);
  for (
    const name of [
      "optionalAfter",
      "decodedAfter",
      "nullAfter",
      "nullDefaultAfter",
      "encodedAfter",
      "targetBridge",
      "requiredBridge",
      "sourceBridge",
      "optionAfter",
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
      constructorDefault: field.value.type.constructorDefault === true
        ? undefined
        : true,
    });
    const changed = new Map(lowered);
    changed.set("main", { ok: true, value: forged });
    assertValidation(
      [...validateProject(project.analysis.project, changed).values()].flat(),
      "validation/002",
      `${declarationPath(forged, name)}.value.type`,
      "expected ",
      name,
    );
  }
});

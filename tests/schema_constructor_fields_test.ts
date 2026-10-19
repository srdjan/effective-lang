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
  new URL("../fixtures/emit/schema-constructor-fields.eff", import.meta.url),
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

Deno.test("constructor field descriptors preserve presence, defaults and make input", () => {
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

Deno.test("constructor field defaults reject erased flags, duplicate defaults and further adapters", () => {
  const callback =
    "schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure";
  const cases: readonly Case[] = [
    [
      "const bad: SchemaOptional<D, E, Read.parse, Write.print, M> = optionalField",
      [
        "type-mismatch/003",
        "has type SchemaOptionalConstructorDefault<",
        "optionalField",
      ],
    ],
    [
      "const bad: SchemaConstructorDefault<D, E, Read.parse, Write.print, M> = optionalField",
      [
        "type-mismatch/003",
        "has type SchemaOptionalConstructorDefault<",
        "optionalField",
      ],
    ],
    [
      "const bad: SchemaEncodedOptionalConstructorDefault<D, E, Read.parse, Write.print, M> = optionalField",
      [
        "type-mismatch/003",
        "has type SchemaOptionalConstructorDefault<",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaConstructorDefault(optionalField, (): M => ({}))",
      [
        "type-mismatch/010",
        "`schemaConstructorDefault` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaArray(optionalField)",
      [
        "type-mismatch/010",
        "`schemaArray` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaMake(optionalField, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaMake(optionalField, {})"],
      [
        "type-mismatch/010",
        "`schemaMake` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaDecode(optionalField, {})",
      ["execution-mode/002", PURE_CONSTANT, "schemaDecode(optionalField, {})"],
      [
        "type-mismatch/010",
        "`schemaDecode` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaEncode(optionalField, { score: 4 })",
      [
        "execution-mode/002",
        PURE_CONSTANT,
        "schemaEncode(optionalField, { score: 4 })",
      ],
      [
        "type-mismatch/010",
        "`schemaEncode` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaOptionalKey(decodedField)",
      [
        "type-mismatch/010",
        "`schemaOptionalKey` needs a Schema value",
        "decodedField",
      ],
    ],
    [
      "const bad = schemaDefaultKey(optionalField, (): D => ({ score: 4 }))",
      [
        "type-mismatch/010",
        "`schemaDefaultKey` needs a Schema value",
        "optionalField",
      ],
    ],
    [
      "const bad = schemaConstructorDefault(schemaOptionFromOptionalKey(child), (): Option<M> => Some({}))",
      ["type-mismatch/010", callback, "(): Option<M> => Some({})"],
    ],
    [
      "service Extra { next(): M }\nconst bad = schemaConstructorDefault(schemaOptionalKey(child), (): M uses Extra.next => Extra.next())",
      ["type-mismatch/010", callback, "(): M uses Extra.next => Extra.next()"],
    ],
  ];
  assertRejected(
    cases,
    (declaration) => fixture + "\n" + declaration,
    (source) => checked(source).diagnostics,
  );
});

Deno.test("independent validation accepts one presence flag plus a default and rejects forged combinations", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const [mutation, code, fragment] of [
      [
        "default",
        "validation/002",
        "expected SchemaOptionalConstructorDefault<",
      ],
      [
        "presence",
        "validation/002",
        "expected SchemaOptionalConstructorDefault<",
      ],
      [
        "multiple-presence",
        "validation/001",
        "optionality flags are mutually exclusive",
      ],
      [
        "make-input",
        "validation/002",
        "expected SchemaOptionalConstructorDefault<",
      ],
    ] as const
  ) {
    const forged = structuredClone(result.value);
    const field = forged.declarations.find((d) =>
      d.kind === "constant" && d.name === "optionalField"
    );
    assert(
      field?.kind === "constant" && field.value.kind === "schema" &&
        field.value.type.kind === "schema",
    );
    if (mutation === "default") {
      Object.assign(field.value.type, { constructorDefault: undefined });
    } else if (mutation === "presence") {
      Object.assign(field.value.type, { optionalKey: undefined });
    } else if (mutation === "multiple-presence") {
      Object.assign(field.value.type, { encodedOptionalKey: true });
    } else {Object.assign(field.value.type, {
        makeInput: field.value.type.decoded,
      });}
    assertValidation(
      validateModule(forged, new Map([["main.eff", fixture]])),
      code,
      `${declarationPath(forged, "optionalField")}.value.type`,
      fragment,
      mutation,
    );
  }
});

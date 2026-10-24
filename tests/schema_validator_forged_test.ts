// Independent validator checks for forged Schema IR. Each test lowers a
// compiled fixture, changes one node of the IR, and requires the validator to
// report a specific code at the IR path of that node. These tests ran inside
// the Schema slow test files before, although they start no subprocess.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { ModuleIR } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { assertValidation, declarationPath } from "./schema_diagnostics.ts";

function lowerFixture(name: string) {
  const text = Deno.readTextFileSync(
    new URL(`../fixtures/emit/${name}.eff`, import.meta.url),
  );
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", "main.eff": text }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  const sources = new Map([["main.eff", text]]);
  return {
    sources,
    forge(): ModuleIR {
      return structuredClone(lowered.value);
    },
  };
}

/** The Schema expression that initializes the named constant. */
function schemaConstant(module: ModuleIR, name: string) {
  const declaration = module.declarations.find((d) =>
    d.kind === "constant" && d.name === name
  );
  assert(
    declaration?.kind === "constant" && declaration.value.kind === "schema",
    name,
  );
  return declaration.value;
}

Deno.test("validator rejects malformed default strategies and erased static encoder services", () => {
  const { forge, sources } = lowerFixture("schema-default-encoding");
  const malformed = forge();
  const field = schemaConstant(malformed, "omitField");
  const options = field.arguments[2];
  assert(
    options?.kind === "record" && options.fields[0].value.kind === "literal",
  );
  Object.assign(options.fields[0].value, {
    value: "omit-default",
    type: { kind: "literal", value: "omit-default" },
  });
  Object.assign(options, {
    type: {
      kind: "record",
      fields: [{
        name: "encodingStrategy",
        type: options.fields[0].value.type,
        optional: false,
      }],
    },
  });
  const path = declarationPath(malformed, "omitField");
  assertValidation(
    validateModule(malformed, sources),
    "validation/002",
    `${path}.value`,
    "schemaDefaultKey options need one literal",
    "malformed strategy",
  );

  const erased = forge();
  const descriptor = schemaConstant(erased, "omitField");
  assert(descriptor.type.kind === "schema");
  Object.assign(descriptor.type, { encodeRequirements: [] });
  assertValidation(
    validateModule(erased, sources),
    "validation/002",
    `${path}.value.type`,
    "expected SchemaEncodedOptional",
    "erased encoder services",
  );
});

Deno.test("validator rejects forged optional callback failures and requirements", () => {
  const { forge, sources } = lowerFixture("schema-effectful-optional");

  const forged = forge();
  const field = schemaConstant(forged, "transformedField");
  const callback = field.arguments[2];
  assert(callback?.kind === "closure");
  assert(callback.type.kind === "function");
  Object.assign(callback.type.effects, {
    failures: ["error:effect/SchemaError"],
  });
  const transformed = declarationPath(forged, "transformedField");
  const transformedFound = validateModule(forged, sources);
  assertValidation(
    transformedFound,
    "validation/002",
    `${transformed}.value`,
    "schemaOptionalTransform needs directional Option callbacks",
    "forged optional failure",
  );
  assertValidation(
    transformedFound,
    "validation/003",
    `${transformed}.value.arguments[2].type.effects.failures`,
    "the body can fail with",
    "forged optional failure body",
  );

  const wrongDefault = forge();
  const defaultField = schemaConstant(wrongDefault, "defaultField");
  const fallback = defaultField.arguments[1];
  assert(fallback?.kind === "closure");
  assert(fallback.type.kind === "function");
  Object.assign(fallback.type.effects, { failures: ["error:Other"] });
  const defaulted = declarationPath(wrongDefault, "defaultField");
  const defaultFound = validateModule(wrongDefault, sources);
  assertValidation(
    defaultFound,
    "validation/002",
    `${defaulted}.value`,
    "schemaDefaultKey needs a callback",
    "forged default failure",
  );
  assertValidation(
    defaultFound,
    "validation/001",
    `${defaulted}.value.arguments[1].type.effects.failures[0]`,
    "is not a declared error",
    "forged default failure set",
  );

  const lostRequirements = forge();
  const lost = schemaConstant(lostRequirements, "transformedField");
  assert(lost.type.kind === "schema");
  Object.assign(lost.type, { decodeRequirements: [] });
  assertValidation(
    validateModule(lostRequirements, sources),
    "validation/002",
    `${transformed}.value.type`,
    "expected SchemaOptional",
    "erased decode requirements",
  );
});

Deno.test("validator keeps null data distinct from unit and numeric annotations", () => {
  const { forge, sources } = lowerFixture("schema-nullable-optional");
  for (
    const [change, fragment] of [
      [{ kind: "literal", value: null }, "does not fit the recorded type null"],
      [
        { type: { kind: "primitive", name: "number" } },
        "expected null, recorded number",
      ],
    ] as const
  ) {
    const module = forge();
    Object.assign(nullConstant(module, "inferred"), change);
    assertValidation(
      validateModule(module, sources),
      "validation/002",
      `${declarationPath(module, "inferred")}.value.type`,
      fragment,
      JSON.stringify(change),
    );
  }
  const module = forge();
  const field = schemaConstant(module, "collapsedField");
  const nullable = module.declarations.find((value) =>
    value.kind === "constant" && value.name === "nullable"
  );
  assert(nullable?.kind === "constant");
  Object.assign(field.arguments[0], {
    target: nullable.id,
    type: nullable.type,
  });
  assertValidation(
    validateModule(module, sources),
    "validation/002",
    `${declarationPath(module, "collapsedField")}.value`,
    "schemaNullToMissingKey needs one ordinary Schema",
    "nullable argument",
  );
});

/** The null expression that initializes the named constant. */
function nullConstant(module: ModuleIR, name: string) {
  const declaration = module.declarations.find((value) =>
    value.kind === "constant" && value.name === name
  );
  assert(
    declaration?.kind === "constant" && declaration.value.kind === "null",
    name,
  );
  return declaration.value;
}

Deno.test("independent validator rejects malformed union arity, forged optionality, and unguarded self use", () => {
  const { forge, sources } = lowerFixture("schema-optional-union");

  const oneBranch = forge();
  const choice = schemaConstant(oneBranch, "choice");
  const list = choice.arguments[0];
  assert(list?.kind === "tuple" && list.type.kind === "tuple");
  Object.assign(list, {
    elements: [list.elements[0]],
    type: { kind: "tuple", elements: [list.type.elements[0]] },
  });
  assertValidation(
    validateModule(oneBranch, sources),
    "validation/002",
    `${declarationPath(oneBranch, "choice")}.value`,
    "schemaUnion needs an inline tuple of branches",
    "one branch",
  );

  const optional = forge();
  const descriptor = schemaConstant(optional, "optionalField");
  assert(descriptor.type.kind === "schema");
  Object.assign(descriptor.type, { optionalKey: undefined });
  assertValidation(
    validateModule(optional, sources),
    "validation/002",
    `${declarationPath(optional, "optionalField")}.value.type`,
    "expected SchemaOptional",
    "forged optionality",
  );

  const immediate = forge();
  const node = schemaConstant(immediate, "optionalNode");
  const callback = node.arguments[0];
  assert(callback?.kind === "closure" && callback.body.kind === "schema");
  const record = callback.body.arguments[0];
  assert(record?.kind === "record");
  const next = record.fields.find((field) => field.name === "next");
  assert(next !== undefined);
  Object.assign(next, {
    value: {
      kind: "reference",
      target: callback.parameters[0].id,
      type: callback.parameters[0].type,
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: next.value.span,
    },
  });
  const nodePath = declarationPath(immediate, "optionalNode");
  assertValidation(
    validateModule(immediate, sources),
    "validation/002",
    `${nodePath}.value`,
    "schemaRecursive needs a pure body",
    "self without a guard",
  );
  const terminal = {
    ...callback.body,
    op: "identity",
    arguments: [],
    type: callback.parameters[0].type,
  };
  Object.assign(callback.body, {
    op: "union",
    arguments: [{
      kind: "tuple",
      elements: [next.value, terminal],
      type: {
        kind: "tuple",
        elements: [next.value.type, terminal.type],
      },
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: callback.body.span,
    }],
  });
  assertValidation(
    validateModule(immediate, sources),
    "validation/002",
    `${nodePath}.value`,
    "schemaRecursive needs a pure body",
    "self directly in a union",
  );
});

Deno.test("validator rejects a forged general union branch", () => {
  const { forge, sources } = lowerFixture("schema-general-union");
  const module = forge();
  const choice = schemaConstant(module, "scalar");
  const list = choice.arguments[0];
  assert(list?.kind === "tuple" && list.type.kind === "tuple");
  Object.assign(list, {
    elements: [list.elements[0], list.elements[0]],
    type: {
      kind: "tuple",
      elements: [list.type.elements[0], list.type.elements[0]],
    },
  });
  assertValidation(
    validateModule(module, sources),
    "validation/002",
    `${declarationPath(module, "scalar")}.value.type`,
    "recorded Schema<",
    "duplicated branch",
  );
});

Deno.test("validator rejects forged decoded optionality and callback channels", () => {
  const { forge, sources } = lowerFixture("schema-required-optional");

  const forged = forge();
  const field = schemaConstant(forged, "guardedField");
  assert(field.type.kind === "schema");
  Object.assign(field.type, { decodedOptionalKey: undefined });
  const path = declarationPath(forged, "guardedField");
  assertValidation(
    validateModule(forged, sources),
    "validation/002",
    `${path}.value.type`,
    "expected SchemaDecodedOptional",
    "forged decoded optionality",
  );

  const wrongFailure = forge();
  const wrongField = schemaConstant(wrongFailure, "guardedField");
  const callback = wrongField.arguments[2];
  assert(callback?.kind === "closure");
  assert(callback.type.kind === "function");
  Object.assign(callback.type.effects, {
    failures: ["error:effect/SchemaError"],
  });
  const failureFound = validateModule(wrongFailure, sources);
  assertValidation(
    failureFound,
    "validation/002",
    `${path}.value`,
    "schemaOptionalFromRequired needs required-to-optional callbacks",
    "forged callback failure",
  );
  assertValidation(
    failureFound,
    "validation/003",
    `${path}.value.arguments[2].type.effects.failures`,
    "the body can fail with",
    "forged callback failure body",
  );

  const conflictingFlags = forge();
  const conflicting = schemaConstant(conflictingFlags, "guardedField");
  assert(conflicting.type.kind === "schema");
  Object.assign(conflicting.type, { optionalKey: true });
  assertValidation(
    validateModule(conflictingFlags, sources),
    "validation/001",
    `${path}.value.type`,
    "optionality flags are mutually exclusive",
    "conflicting flags",
  );
});

Deno.test("validator rejects forged encoded optionality and callback failure", () => {
  const { forge, sources } = lowerFixture("schema-optional-transform");

  const forged = forge();
  const field = schemaConstant(forged, "optionField");
  assert(field.type.kind === "schema");
  Object.assign(field.type, { encodedOptionalKey: undefined });
  assertValidation(
    validateModule(forged, sources),
    "validation/002",
    `${declarationPath(forged, "optionField")}.value.type`,
    "expected SchemaEncodedOptional",
    "forged encoded optionality",
  );

  const callbackForged = forge();
  const normalized = schemaConstant(callbackForged, "normalizedField");
  const decode = normalized.arguments[2];
  assert(decode?.kind === "closure");
  assert(decode.type.kind === "function");
  Object.assign(decode.type.effects, {
    failures: ["error:effect/SchemaIssue"],
  });
  const normalizedPath = declarationPath(callbackForged, "normalizedField");
  const found = validateModule(callbackForged, sources);
  assertValidation(
    found,
    "validation/002",
    `${normalizedPath}.value`,
    "schemaOptionalTransform needs directional Option callbacks",
    "forged callback failure",
  );
  assertValidation(
    found,
    "validation/004",
    `${normalizedPath}.value.arguments[2].type.execution`,
    "expected effect, recorded pure",
    "forged callback execution",
  );
});

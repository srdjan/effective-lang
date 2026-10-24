import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  type ModuleIR,
  type TypeDecl,
  validateProject,
} from "../src/core/mod.ts";

const SEALED_LIBRARY = `
export type Int = int
export sealed nominal Positive = Int
export const one: Positive = Positive(1)
export const positiveSchema: Schema<Positive> = schema()
export const positiveOptional: SchemaOptional<Positive> = schemaOptionalKey(positiveSchema)
const ints: Schema<Int> = schema()
export const ownerTransform: Schema<Int, Positive> = schemaTransform(
  positiveSchema,
  ints,
  (value: Positive): Option<Int> => Some(0),
  (value: Int): Option<Positive> => Some(one)
)
`;

function checkConsumer(library: string, body: string) {
  const checked = checkProject(
    memoryHost({
      "effektive.json": "{}",
      "lib.eff": library,
      "main.eff": `
import { Int, Positive, one, positiveSchema, positiveOptional, ownerTransform } from "./lib.eff"
${body}
`,
    }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  return checked.value;
}

Deno.test("consumer schema callbacks cannot receive foreign sealed decoded values", () => {
  const cases = [
    `export const escape = (input: unknown): Positive fails SchemaError => {
  const cell = makeRef(one)
  const ints: Schema<Int> = schema()
  const changed = schemaTransform(
    positiveSchema,
    ints,
    (value: Positive): Option<Int> => { setRef(cell, value)\n Some(0) },
    (value: Int): Option<Positive> => Some(one)
  )
  schemaDecode(changed, input)
  getRef(cell)
}`,
    `export const escape = (input: unknown): Positive fails SchemaError => {
  const cell = makeRef(one)
  const ints: Schema<Int> = schema()
  const optionalInts: SchemaOptional<Int> = schemaOptionalKey(ints)
  const changed: SchemaDecodedOptional<Int, Positive> = schemaOptionalFromRequired(
    positiveSchema,
    optionalInts,
    (value: Positive): Option<Int> => { setRef(cell, value)\n Some(0) },
    (value: Option<Int>): Positive => one
  )
  const record = schemaStruct({ value: changed })
  schemaDecode(record, input)
  getRef(cell)
}`,
    `export const escape = (input: unknown): Positive fails SchemaError => {
  const cell = makeRef(one)
  const ints: Schema<Int> = schema()
  const optionalInts: SchemaOptional<Int> = schemaOptionalKey(ints)
  const changed = schemaOptionalTransform(
    positiveOptional,
    optionalInts,
    (value: Option<Positive>): Option<Int> => match value {
      Some(positive) => { setRef(cell, positive)\n Some(0) },
      None => None
    },
    (value: Option<Int>): Option<Positive> => Some(one)
  )
  const record = schemaStruct({ value: changed })
  schemaDecode(record, input)
  getRef(cell)
}`,
    `export const rejected: Schema<Positive> = schemaTransform(
  positiveSchema,
  positiveSchema,
  (value: Positive): Option<Positive> => Some(value),
  (value: Positive): Option<Positive> => Some(value)
)`,
  ];
  for (const source of cases) {
    const checked = checkConsumer(SEALED_LIBRARY, source);
    assertEquals(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
      ["sealed/004"],
      source,
    );
  }
});

Deno.test("owner callbacks and consumer operations without sealed input stay valid", () => {
  const checked = checkConsumer(
    SEALED_LIBRARY,
    `const ints: Schema<Int> = schema()
const ordinary: Schema<Int> = schemaTransform(
  ints,
  ints,
  (value: Int): Option<Int> => Some(value),
  (value: Int): Option<Int> => Some(value)
)
export const write = (value: Positive): Positive fails SchemaError =>
  schemaEncode(positiveSchema, value)
export const readOwner = (input: unknown): Int fails SchemaError =>
  schemaDecode(ownerTransform, input)
`,
  );
  assertEquals(checked.diagnostics, []);
});

function positiveDefinition(module: ModuleIR) {
  const declarations = [
    ...module.declarations.filter((item): item is TypeDecl =>
      item.kind === "type"
    ),
    ...module.imports.flatMap((item) => item.types),
  ];
  const positive = declarations.find((item) => item.id === "type:lib#Positive");
  assert(positive?.definition.kind === "nominal");
  return positive.definition;
}

Deno.test("validator reads sealed callback authority from the input Schema", () => {
  const openLibrary = SEALED_LIBRARY.replace("sealed nominal", "nominal");
  const checked = checkConsumer(
    openLibrary,
    `const ints: Schema<Int> = schema()
export const changed: Schema<Int, Positive> = schemaTransform(
  positiveSchema,
  ints,
  (value: Positive): Option<Int> => Some(0),
  (value: Int): Option<Positive> => Some(one)
)
`,
  );
  assertEquals(checked.diagnostics, []);
  const lowered = lowerProject(checked);
  const libraryResult = lowered.get("lib");
  const consumerResult = lowered.get("main");
  assert(libraryResult?.ok && consumerResult?.ok);
  const library = structuredClone(libraryResult.value);
  const consumer = structuredClone(consumerResult.value);
  Object.assign(positiveDefinition(library), { sealed: true });
  Object.assign(positiveDefinition(consumer), { sealed: true });

  const changed = consumer.declarations.find((item) =>
    item.kind === "constant" && item.name === "changed"
  );
  assert(changed?.kind === "constant" && changed.value.kind === "schema");
  assert(changed.value.type.kind === "schema");
  assertEquals(changed.value.type.decoded, {
    kind: "named",
    id: "type:lib#Int",
  });

  const forged = new Map(lowered);
  forged.set("lib", { ok: true, value: library });
  forged.set("main", { ok: true, value: consumer });
  const diagnostics = validateProject(
    checked.analysis.project,
    forged,
  ).get("main") ?? [];
  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["validation/002"],
  );
  assert(
    diagnostics[0].message.includes("foreign module") &&
      diagnostics[0].message.includes("callback"),
    JSON.stringify(diagnostics),
  );
});

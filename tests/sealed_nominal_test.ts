import { TypeScriptOutputs } from "../src/core/typescript.ts";
const outputs = new TypeScriptOutputs();
import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  completionsAt,
  emitProject,
  hoverAt,
  lowerProject,
  memoryHost,
  Program,
  revisionDelta,
  semanticClassifications,
} from "../src/core/mod.ts";
import { parse } from "../src/core/parse.ts";

const CONFIG = { "effektive.json": "{}" };

function checked(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
) {
  const result = checkProject(
    memoryHost({ ...CONFIG, ...files }),
    "",
    entries,
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("sealed nominal types lower their authority flag", () => {
  const project = checked({
    "main.eff": `
export sealed nominal Positive = int
export const positive = (): Positive => Positive(1)
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);

  const main = lowerProject(project).get("main");
  assert(main?.ok, JSON.stringify(main));
  const positive = main.value.declarations.find((declaration) =>
    declaration.kind === "type" && declaration.name === "Positive"
  );
  assert(positive?.kind === "type");
  assert(positive.definition.kind === "nominal");
  assertEquals(positive.definition.sealed, true);

  const open = checked({
    "main.eff": `
export nominal Positive = int
export const positive = (): Positive => Positive(1)
`,
  }, ["main.eff"]);
  const sealedOutput = emitProject(lowerProject(project), {
    config: project.analysis.project.config,
  }).get("main");
  const openOutput = emitProject(lowerProject(open), {
    config: open.analysis.project.config,
  }).get("main");
  assert(sealedOutput?.ok, JSON.stringify(sealedOutput));
  assert(openOutput?.ok, JSON.stringify(openOutput));
  assertEquals(sealedOutput.value.text, openOutput.value.text);
});

Deno.test("a foreign module cannot construct a sealed nominal type", () => {
  const project = checked({
    "lib.eff": `
export sealed nominal Positive = int
`,
    "main.eff": `
import { Positive } from "./lib.eff"
export const invalid = (): Positive => Positive(1)
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics.map((diagnostic) => diagnostic.code), [
    "sealed/001",
  ]);
});

const LIBRARY = `
export type Int = int
export type Decimal = number
export type Text = string
export type Flag = boolean
export type Input = unknown
export sealed nominal Positive = Int
export sealed nominal Article = { id: Positive, title: Text }
sealed nominal Secret = Int
export type Hidden = Secret
sealed nominal SecretRecord = { title: Text }
export type HiddenRecord = SecretRecord
export const positive = (value: Int): Positive => Positive(value)
export const article = (id: Positive, title: Text): Article => Article({ id, title })
export const update = (value: Article, title: Text): Article => ({ ...value, title })
export const add = (left: Positive, right: Positive): Positive => left + right
export const multiply = (left: Positive, right: Int): Int => left * right
export const toInt = (value: Positive): Int => value
export const positiveSchema: Schema<Positive> = schema()
export const decodePositive = (input: Input): Positive fails SchemaError => schemaDecode(positiveSchema, input)
export const makePositive = (input: Positive): Positive fails SchemaIssue => schemaMake(positiveSchema, input)
`;

function consumer(body: string) {
  return checked({
    "lib.eff": LIBRARY,
    "main.eff": `
import { Int, Decimal, Text, Flag, Input, Positive, Article, Hidden, HiddenRecord, positive, article, toInt, positiveSchema, decodePositive } from "./lib.eff"
${body}
`,
  }, ["main.eff"]);
}

Deno.test("the owner has authority for every sealed operation", () => {
  const project = checked({ "lib.eff": LIBRARY }, ["lib.eff"]);
  assertEquals(project.diagnostics, []);
});

Deno.test("a consumer can pass, compare, read, encode, and call owner conversions", () => {
  const project = consumer(`
export const pass = (value: Positive): Positive => value
export const equal = (value: Positive): Flag => value === 1
export const ordered = (value: Positive): Flag => value < 2
export const read = (value: Article): Text => value.title
export const convert = (value: Positive): Int => toInt(value)
export const decoded = (input: Input): Positive fails SchemaError => decodePositive(input)
export const written = (value: Positive): Positive fails SchemaError => schemaEncode(positiveSchema, value)
`);
  assertEquals(project.diagnostics, []);
});

Deno.test("foreign sealed operations report their dedicated diagnostics", () => {
  const cases = [
    ["sealed/001", "export const bad = (): Positive => Positive(1)"],
    [
      "sealed/002",
      'export const bad = (value: Article): Article => ({ ...value, title: "changed" })',
    ],
    [
      "sealed/002",
      'export const bad = (value: HiddenRecord): HiddenRecord => ({ ...value, title: "changed" })',
    ],
    [
      "sealed/003",
      "export const bad = (value: Positive): Positive => value + value",
    ],
    [
      "sealed/003",
      "export const bad = (value: Positive): Int => value - 1",
    ],
    [
      "sealed/003",
      "export const bad = (value: Positive): Int => value * 2",
    ],
    [
      "sealed/003",
      "export const bad = (value: Positive): Decimal => value / 2",
    ],
    [
      "sealed/003",
      "nominal Wrapper = Positive\nexport const bad = (value: Positive): Int => { const wrapped = Wrapper(value)\n wrapped + wrapped }",
    ],
    [
      "sealed/004",
      "export const bad: Schema<Positive> = schema()",
    ],
    [
      "sealed/004",
      "export const bad = (input: Input): Positive fails SchemaError => schemaDecode(positiveSchema, input)",
    ],
    [
      "sealed/004",
      "export const bad = (input: Positive): Positive fails SchemaIssue => schemaMake(positiveSchema, input)",
    ],
    [
      "sealed/004",
      "export const bad = (read: pure (value: Positive) => Positive, write: pure (value: Positive) => Positive): Codec<Positive, Positive> => codec(read, write)",
    ],
  ] as const;
  for (const [code, source] of cases) {
    const project = consumer(source);
    assertEquals(
      project.diagnostics.map((diagnostic) => diagnostic.code),
      [code],
      source,
    );
  }
});

Deno.test("foreign sealed widening fails through aliases and nested variance", () => {
  const cases = [
    "export const bad = (value: Positive): Int => value",
    "export const bad = (value: Hidden): Int => value",
    "export const bad = (value: Positive[]): Int[] => value",
    "export const bad = (value: { item: Positive }): { item: Int } => value",
    "export const bad = (value: [Positive]): [Int] => value",
    "type Source = pure (value: Int) => Positive\ntype Target = pure (value: Int) => Int\nexport const bad = (value: Source): Target => value",
  ];
  for (const source of cases) {
    const project = consumer(source);
    assertEquals(
      project.diagnostics.map((diagnostic) => diagnostic.code),
      ["type-mismatch/003"],
      source,
    );
  }
});

Deno.test("generic result joins cannot widen a foreign sealed nominal type", () => {
  const project = consumer(
    "const bad = (value: Positive) => race(defer(() => value), defer(() => 1))",
  );
  assertEquals(project.diagnostics.map((diagnostic) => diagnostic.code), [
    "type-mismatch/010",
  ]);
});

Deno.test("nested foreign Schema derivation is rejected", () => {
  const cases = [
    "export const bad: Schema<Positive[]> = schemaArray(positiveSchema)",
    "export const bad: Schema<{ item: Positive }> = schemaStruct({ item: positiveSchema })",
    "export const bad: Schema<Hidden> = schema()",
  ];
  for (const source of cases) {
    const project = consumer(source);
    assertEquals(
      project.diagnostics.map((diagnostic) => diagnostic.code),
      ["sealed/004"],
      source,
    );
  }
});

Deno.test("open nominal types keep their existing cross-module behavior", () => {
  const project = checked({
    "lib.eff": `
export type Int = int
export nominal Count = Int
export nominal sealed = Int
export nominal Row = { count: Count }
export const countSchema: Schema<Count> = schema()
`,
    "main.eff": `
import { Int, Count, sealed, Row, countSchema } from "./lib.eff"
export const make = (): Count => Count(1)
export const widen = (value: Count): Int => value
export const add = (left: Count, right: Count): Count => left + right
export const contextual = (): Int => sealed(1)
export const update = (row: Row, count: Count): Row => ({ ...row, count })
export const decoded = (input: Int): Count fails SchemaError => schemaDecode(countSchema, input)
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);
});

Deno.test("sealed nominal is rejected in a host interface file", () => {
  const result = parse("host.effi", "sealed nominal Secret = int\n");
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "syntax/008",
  ]);
});

Deno.test("Program resets sealing and changes the interface hash", () => {
  const program = new Program("");
  const open = program.update({
    set: {
      ...CONFIG,
      "lib.eff": "export type Int = int\nexport nominal Count = Int\n",
      "main.eff":
        'import { Int, Count } from "./lib.eff"\nexport const widen = (value: Count): Int => value\n',
    },
  });
  assert(open.ok);
  assertEquals(open.value.diagnostics, []);
  const sealed = program.update({
    set: {
      "lib.eff": "export type Int = int\nexport sealed nominal Count = Int\n",
    },
  });
  assert(sealed.ok);
  assertEquals(sealed.value.diagnostics.map((diagnostic) => diagnostic.code), [
    "type-mismatch/003",
  ]);
  assert(
    sealed.value.types.isSealed("type:lib#Count"),
  );
  assertEquals(revisionDelta(open.value, sealed.value).interfaceChanged, [
    "lib",
    "main",
  ]);
  const reopened = program.update({
    set: {
      "lib.eff": "export type Int = int\nexport nominal Count = Int\n",
    },
  });
  assert(reopened.ok);
  assertEquals(reopened.value.diagnostics, []);
  assertEquals(reopened.value.types.isSealed("type:lib#Count"), false);
  assertEquals(
    reopened.value.interfaceHash("lib"),
    open.value.interfaceHash("lib"),
  );
});

Deno.test("editor tooling classifies, completes, and describes sealed nominal types", () => {
  const text = "export sealed nominal Positive = int\n";
  const loaded = new Program("").update({
    set: { ...CONFIG, "main.eff": text },
  });
  assert(loaded.ok);
  const sealed = text.indexOf("sealed");
  assertEquals(
    semanticClassifications(loaded.value, "main.eff", text).find((item) =>
      item.span.start === sealed
    )?.type,
    "keyword",
  );
  assertEquals(
    hoverAt(loaded.value, "main.eff", text.indexOf("Positive") + 1, outputs)
      ?.contract,
    "sealed nominal Positive",
  );

  for (const prefix of ["sea", "export sea"]) {
    const revision = new Program("").update({
      set: { ...CONFIG, "main.eff": `${prefix}\n` },
    });
    assert(revision.ok);
    const completion = completionsAt(
      revision.value,
      "main.eff",
      prefix.length,
    ).find((item) => item.label === "sealed");
    assertEquals(completion?.kind, "keyword");
  }

  const bindingText = "export const sealed = 1\nexport const value = sea\n";
  const binding = new Program("").update({
    set: { ...CONFIG, "main.eff": bindingText },
  });
  assert(binding.ok);
  assertEquals(
    completionsAt(binding.value, "main.eff", bindingText.lastIndexOf("sea") + 3)
      .find((item) => item.label === "sealed")?.kind,
    "variable",
  );

  const importedText = `
import { Positive } from "./lib.eff"
export const keep = (value: Positive): Positive => value
`;
  const imported = new Program("").update({
    set: {
      ...CONFIG,
      "lib.eff": text,
      "main.eff": importedText,
    },
  });
  assert(imported.ok);
  const use = importedText.lastIndexOf("Positive");
  assertEquals(
    hoverAt(imported.value, "main.eff", use + 1, outputs)?.contract,
    "sealed nominal Positive",
  );
});

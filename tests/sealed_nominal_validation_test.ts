import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import type {
  CheckedProject,
  LowerError,
  ModuleIR,
  Result,
  TypeDecl,
} from "../src/core/mod.ts";

const LIBRARY = `
export type Int = int
export type Text = string
export type Flag = boolean
export type Input = unknown
export nominal Positive = Int
export nominal Article = { title: Text }
nominal PrivateRecord = { title: Text }
export type HiddenRecord = PrivateRecord
export const positiveSchema: Schema<Positive> = schema()
`;

function assertMutable(
  value: unknown,
): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
}

function lowerConsumer(source: string): {
  readonly project: CheckedProject;
  readonly modules: ReadonlyMap<string, Result<ModuleIR, LowerError>>;
} {
  const checked = checkProject(
    memoryHost({
      "effektive.json": "{}",
      "lib.eff": LIBRARY,
      "main.eff": `
import { Int, Text, Flag, Input, Positive, Article, HiddenRecord, positiveSchema } from "./lib.eff"
${source}
`,
    }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const modules = lowerProject(checked.value);
  for (const result of modules.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  return { project: checked.value, modules };
}

function sealImportedTypes(module: ModuleIR): void {
  const imported = module.imports.find((item) => item.module === "lib");
  assert(imported !== undefined);
  for (const declaration of imported.types) {
    if (
      declaration.definition.kind === "nominal" &&
      ["Positive", "Article", "PrivateRecord"].includes(declaration.name)
    ) {
      const definition: unknown = declaration.definition;
      assertMutable(definition);
      definition.sealed = true;
    }
  }
}

function forgedDiagnostics(source: string) {
  const base = lowerConsumer(source);
  const result = base.modules.get("main");
  assert(result?.ok);
  const forged = structuredClone(result.value);
  sealImportedTypes(forged);
  const modules = new Map(base.modules);
  modules.set("main", { ok: true, value: forged });
  return validateProject(base.project.analysis.project, modules).get("main") ??
    [];
}

Deno.test("validator rejects forged sealed authority operations", () => {
  const cases = [
    "export const bad = (): Positive => Positive(1)",
    'export const bad = (value: Article): Article => ({ ...value, title: "changed" })',
    'export const bad = (value: HiddenRecord): HiddenRecord => ({ ...value, title: "changed" })',
    "export const bad = (value: Positive): Positive => value + value",
    "nominal Wrapper = Positive\nexport const bad = (value: Positive): Int => { const wrapped = Wrapper(value)\n wrapped + wrapped }",
    "export const bad = (value: Positive[]): Int[] => value",
    "const bad = (value: Positive) => race(defer(() => value), defer(() => 1))",
    "export const bad: Schema<Positive> = schema()",
    "export const bad: Schema<Positive[]> = schemaArray(positiveSchema)",
    "export const bad = (input: Input): Positive fails SchemaError => schemaDecode(positiveSchema, input)",
    "export const bad = (input: Positive): Positive fails SchemaIssue => schemaMake(positiveSchema, input)",
    "export const bad = (read: pure (value: Positive) => Positive, write: pure (value: Positive) => Positive): Codec<Positive, Positive> => codec(read, write)",
  ];
  for (const source of cases) {
    const diagnostics = forgedDiagnostics(source);
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === "validation/002"),
      `${source}: ${JSON.stringify(diagnostics)}`,
    );
  }
});

Deno.test("validator accepts forged comparisons and schema encoding", () => {
  for (
    const source of [
      "export const same = (value: Positive): Flag => value === 1",
      "export const write = (value: Positive): Positive fails SchemaError => schemaEncode(positiveSchema, value)",
    ]
  ) {
    const diagnostics = forgedDiagnostics(source);
    assertEquals(diagnostics, [], source);
  }
});

Deno.test("validator rejects a sealed flag on an alias", () => {
  const base = lowerConsumer(
    "export const value = (item: Positive): Positive => item",
  );
  const result = base.modules.get("main");
  assert(result?.ok);
  const forged = structuredClone(result.value);
  const imported = forged.imports.find((item) => item.module === "lib");
  const alias = imported?.types.find((item) => item.name === "Int");
  assert(alias?.definition.kind === "alias");
  const definition: unknown = alias.definition;
  assertMutable(definition);
  definition.sealed = true;
  const modules = new Map(base.modules);
  modules.set("main", { ok: true, value: forged });
  const diagnostics = validateProject(base.project.analysis.project, modules)
    .get("main") ?? [];
  assertEquals(diagnostics.map((diagnostic) => diagnostic.code), [
    "validation/002",
  ]);
  assertStringIncludes(diagnostics[0].message, "belongs only to a nominal");
});

Deno.test("validator rejects sealed nominal metadata from an effi source", () => {
  const files = {
    "effektive.json": JSON.stringify({
      host: { x: { interface: "./host.effi", module: "./x.ts" } },
    }),
    "host.effi": "export nominal Token = int\n",
    "main.eff":
      'import { Token } from "host:x"\nexport const keep = (value: Token): Token => value\n',
  };
  const checked = checkProject(memoryHost(files), "", ["main.eff"]);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value);
  const host = [...lowered.entries()].find(([name]) => name !== "main");
  assert(host?.[1].ok, JSON.stringify(host));
  const forged = structuredClone(host[1].value);
  const token = forged.declarations.find((item): item is TypeDecl =>
    item.kind === "type" && item.name === "Token"
  );
  assert(token?.definition.kind === "nominal");
  const definition: unknown = token.definition;
  assertMutable(definition);
  definition.sealed = true;
  const modules = new Map(lowered);
  modules.set(host[0], { ok: true, value: forged });
  const diagnostics = validateProject(checked.value.analysis.project, modules)
    .get(host[0]) ?? [];
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "validation/002" &&
      diagnostic.message.includes("host interface")
    ),
    JSON.stringify(diagnostics),
  );
});

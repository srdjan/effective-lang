import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { Program } from "../src/core/db.ts";
import { completionsAt } from "../src/core/editor_completion.ts";
import { semanticClassifications } from "../src/core/editor_tokens.ts";
import type { FunctionDecl } from "../src/core/ir.ts";

const CONFIG = { "effective.json": "{}" };

function checked(files: Readonly<Record<string, string>>, entries: string[]) {
  const result = checkProject(memoryHost({ ...CONFIG, ...files }), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function functionDeclaration(
  declarations: readonly { readonly kind: string; readonly name: string }[],
  name: string,
): FunctionDecl {
  const declaration = declarations.find((item) => item.name === name);
  assert(declaration?.kind === "function", `no function named ${name}`);
  return declaration as FunctionDecl;
}

Deno.test("pure function types accept inferred imports and inline arrows", () => {
  const project = checked({
    "lib.eff": `
export type Int = int
export const increment = (value: Int): Int => value + 1
`,
    "main.eff": `
import { Int, increment } from "./lib.eff"
export const apply = (value: Int, callback: pure (value: Int) => Int): Int => callback(value)
export const imported = (value: Int): Int => apply(value, increment)
export const inline = (value: Int): Int => apply(value, (item) => item + 2)
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);

  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);

  const main = lowered.get("main");
  assert(main?.ok);
  const apply = functionDeclaration(main.value.declarations, "apply");
  const callback = apply.type.parameters[1];
  assert(callback?.kind === "function");
  assertEquals(callback.execution, "pure");
  assertEquals(callback.effects, { failures: [], requirements: [] });
});

Deno.test("pure functions fit unmarked function types without changing their effect default", () => {
  const project = checked({
    "main.eff": `
type Int = int
const increment = (value: Int): Int => value + 1
export const applyEffect = (value: Int, callback: (value: Int) => Int): Int => callback(value)
export const lifted = (value: Int): Int => applyEffect(value, increment)
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);
  const main = lowerProject(project).get("main");
  assert(main?.ok);
  const apply = functionDeclaration(main.value.declarations, "applyEffect");
  const callback = apply.type.parameters[1];
  assert(callback?.kind === "function");
  assertEquals(callback.execution, "effect");
});

Deno.test("pure function types reject effect functions and declared rows", () => {
  const effect = checked({
    "main.eff": `
type Int = int
service Clock { now(): Int }
const effectful = (): Int uses Clock.now => Clock.now()
const apply = (callback: pure () => Int): Int => callback()
export const bad = (): Int uses Clock.now => apply(effectful)
`,
  }, ["main.eff"]);
  assertEquals(effect.diagnostics.map((diagnostic) => diagnostic.code), [
    "type-mismatch/003",
  ]);

  const provided = checked({
    "main.eff": `
type Int = int
service Clock { now(): Int }
const clock = layer(Clock, () => ({ now: () => 1 }))
const effectful = (): Int => provide(clock, () => Clock.now())
const apply = (callback: pure () => Int): Int => callback()
export const bad = (): Int => apply(effectful)
`,
  }, ["main.eff"]);
  assertEquals(provided.diagnostics.map((diagnostic) => diagnostic.code), [
    "type-mismatch/003",
  ]);

  const binding = checked({
    "main.eff": `
type Int = int
export const bad: pure () => Int = (): Int => run(defer(() => 1))
`,
  }, ["main.eff"]);
  assertEquals(binding.diagnostics.map((diagnostic) => diagnostic.code), [
    "type-mismatch/003",
  ]);

  const rows = checked({
    "main.eff": `
type Int = int
error Stop = {}
service Clock { now(): Int }
export type Failing = pure () => Int fails Stop
export type Requiring = pure () => Int uses Clock.now
`,
  }, ["main.eff"]);
  assertEquals(rows.diagnostics.map((diagnostic) => diagnostic.code), [
    "execution-mode/005",
    "execution-mode/005",
  ]);
});

Deno.test("run and provide stay effectful while constructing defer stays pure", () => {
  const project = checked({
    "main.eff": `
type Int = int
service Clock { now(): Int }
const clock = layer(Clock, () => ({ now: () => 1 }))
export const ran = (): Int => run(defer(() => 1))
export const provided = (): Int => provide(clock, () => Clock.now())
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);
  const main = lowerProject(project).get("main");
  assert(main?.ok);
  for (const name of ["ran", "provided"]) {
    const declaration = functionDeclaration(main.value.declarations, name);
    assertEquals(declaration.type.execution, "effect", name);
    assertEquals(declaration.type.effects, {
      failures: [],
      requirements: [],
    }, name);
  }
  const ran = functionDeclaration(main.value.declarations, "ran");
  assert(ran.body.kind === "run");
  assert(ran.body.value.kind === "defer");
  assertEquals(ran.body.value.execution, "pure");
});

Deno.test("displayed function types include pure", () => {
  const project = checked({
    "main.eff": `
type Int = int
export const apply = (callback: pure (value: Int) => Int): pure (value: Int) => Int => callback
`,
  }, ["main.eff"]);
  assertEquals(project.diagnostics, []);
  const apply = project.modules.get("main")?.functions.get("value:main#apply");
  assert(apply !== undefined);
  const callback = apply.signature.parameters[0].type.ref;
  assertEquals(project.table.show(callback), "pure (Int) => Int");
});

Deno.test("editor tooling completes and highlights pure", () => {
  const text = `
type Int = int
export const apply = (callback: pure (value: Int) => Int): Int => callback(1)
`;
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "main.eff": text },
  });
  assert(loaded.ok, JSON.stringify(loaded));
  const pure = text.indexOf("pure");
  assert(
    completionsAt(loaded.value, "main.eff", pure + 2).some((item) =>
      item.label === "pure"
    ),
  );
  assertEquals(
    semanticClassifications(loaded.value, "main.eff", text).find((item) =>
      item.span.start === pure
    )?.type,
    "keyword",
  );
});

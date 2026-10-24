// Exported signatures must remain usable when another Effektive module infers
// their types, including supporting declarations nested inside built-in types.

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

const signatures = [
  ["Ref element", "type B = { n: Int }", "Ref<B>"],
  ["RetrySchedule error", "error E = {}", "RetrySchedule<E>"],
  ["Codec decoded type", "type B = { n: Int }", "Codec<B, Int>"],
  ["Codec encoded type", "type B = { n: Int }", "Codec<Int, B>"],
  ["Fiber result", "type B = { n: Int }", "Fiber<B, never>"],
  ["Fiber failure", "error E = {}", "Fiber<Int, E>"],
] as const;

async function checkTwoModules(library: string, value: string): Promise<void> {
  const project = checkProject(
    memoryHost({
      "effektive.json": "{}",
      "library.eff": library,
      "consumer.eff": `import { ${value} } from "./library.eff"\n` +
        `const forward = ${value}\n` +
        `export const alive = (): void => { const copy = forward }\n`,
    }),
    "",
    ["consumer.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  assertEquals(
    (await runStrictTarget(
      emitProject(lowered, { config: project.value.analysis.project.config }),
      'import { alive } from "./consumer.ts";\n' +
        "console.log(alive() === undefined);\n",
      "effektive-audit-supporting-exports-",
    )).trim(),
    "true",
  );
}

for (const [name, declaration, type] of signatures) {
  Deno.test(`supporting exports through ${name} pass strict two-module emission`, async () => {
    await checkTwoModules(
      `type Int = int\n${declaration}\n` +
        `export const f = (value: ${type}): Int => 1\n`,
      "f",
    );
  });
}

Deno.test("supporting exports reached only through Schema makeInput pass strict two-module emission", async () => {
  await checkTwoModules(
    [
      "type Int = int",
      "type Text = string",
      "type M = { score?: Int }",
      "type D = { score: Int }",
      "type E = { score: Text }",
      "export service Read { parse(value: Text): Int }",
      "export service Write { print(value: Int): Text }",
      "const integer: Schema<Int> = schema()",
      "const text: Schema<Text> = schema()",
      "const shifted: Schema<Int, Text, Read.parse, Write.print> = schemaTransform(text, integer, (value: Text): Option<Int> uses Read.parse => Some(Read.parse(value)), (value: Int): Option<Text> uses Write.print => Some(Write.print(value)))",
      "export const child: Schema<D, E, Read.parse, Write.print, M> = schemaStruct({ score: schemaConstructorDefault(shifted, (): Int => 4) })",
      "",
    ].join("\n"),
    "child",
  );
});

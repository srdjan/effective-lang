import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

const prefix = `type Text = string
type Required = { name: Text }
type Optional = { name?: Text }
type Strategy = "omit" | "passthrough"
const text: Schema<Text> = schema()
`;

Deno.test("Schema default encoding strategies accept literal options and preserve the two-argument form", () => {
  const project = checked(
    prefix + `
const omitted: Schema<Required, Optional> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { encodingStrategy: "omit" }) })
const passed: Schema<Required, Optional> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { encodingStrategy: "passthrough" }) })
const implicit: Schema<Required, Optional> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada") })`,
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

Deno.test("Schema default encoding options reject dynamic strategies and malformed records", () => {
  const declarations = `const policy = { encodingStrategy: "omit" }
const encodingStrategy: Strategy = "omit"
const choose = (): Strategy => "omit"
`;
  for (
    const options of [
      '"omit"',
      "{}",
      '{ encodingStrategy: "omit-default" }',
      "{ encodingStrategy: true }",
      '{ encoding: "omit" }',
      '{ encodingStrategy: "omit", extra: "x" }',
      '{ encodingStrategy: "omit", encodingStrategy: "omit" }',
      "{ encodingStrategy }",
      "{ ...policy }",
      "{ encodingStrategy: encodingStrategy }",
      "{ encodingStrategy: choose() }",
      "policy",
    ]
  ) {
    const project = checked(
      prefix + declarations +
        `const bad = schemaDefaultKey(text, (): Text => "Ada", ${options})`,
    );
    assert(
      project.diagnostics.some((diagnostic) =>
        diagnostic.code.startsWith("type-mismatch/")
      ),
      options + "\n" + JSON.stringify(project.diagnostics),
    );
  }
  const missingDecoded = checked(
    prefix +
      `const omitted: Schema<Required, Optional> = schemaStruct({ name: schemaDefaultKey(text, (): Text => "Ada", { encodingStrategy: "omit" }) })
const bad = schemaEncode(omitted, {})`,
  );
  assert(
    missingDecoded.diagnostics.some((diagnostic) =>
      diagnostic.code.startsWith("type-mismatch/")
    ),
  );
});

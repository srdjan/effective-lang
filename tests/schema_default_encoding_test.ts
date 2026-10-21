import { assert, assertEquals } from "@std/assert";
import { lowerProject, validateProject } from "../src/core/mod.ts";
import { checkModule } from "./helpers.ts";

const checked = (source: string) => checkModule(source, "main.eff");

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

Deno.test("Schema default callbacks may fail only with SchemaIssue or SchemaError", () => {
  for (
    const failures of ["SchemaIssue", "SchemaError"]
  ) {
    const accepted = checked(
      prefix +
        `const ok = schemaDefaultKey(text, (): Text fails ${failures} => "Ada")`,
    );
    assertEquals(accepted.diagnostics, [], failures);
  }
  for (
    const [failures, body] of [
      ["Other", "fail(Other({}))"],
      ["SchemaIssue | SchemaError", '"Ada"'],
    ]
  ) {
    const callback = `(): Text fails ${failures} => ${body}`;
    const source = prefix + "error Other = {}\n" +
      `const bad = schemaDefaultKey(text, ${callback})`;
    const { diagnostics } = checked(source);
    assertEquals(
      diagnostics.map((d) => d.code),
      ["type-mismatch/010"],
      failures,
    );
    assert(
      diagnostics[0].message.includes(
        "callback may fail only with SchemaIssue or SchemaError",
      ),
      diagnostics[0].message,
    );
    assertEquals(
      source.slice(diagnostics[0].span.start, diagnostics[0].span.end),
      callback,
    );
  }
});

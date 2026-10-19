import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-optional.eff", import.meta.url),
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

Deno.test("optional adapters retain target make inputs and invariant field types", () => {
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

Deno.test("optional constructor inputs keep required keys, complete Options and decoded defaults", () => {
  for (
    const declaration of [
      "const bad: SchemaEncodedOptional<D, E, Read.parse | Defaults.next, Write.print> = decodedField",
      "const bad = schemaMake(decoded, {})",
      "const bad = schemaMake(encoded, {})",
      "const bad = schemaMake(nullDefault, {})",
      "const bad = schemaMake(nullMissing, { settings: null })",
      'const bad = schemaMake(transformed, { settings: { label: "source" } })',
      "const bad = schemaMake(optionRecord, { settings: Some({}) })",
      "const bad = schemaMake(optionRecord, {})",
      "const bad = schemaDefaultKey(child, (): M => ({}))",
      "const bad = schemaDefaultNullKey(child, (): M => ({}))",
      "const bad = schemaDefaultEncodedKey(child, (): M => ({}))",
    ]
  ) {
    assert(
      checked(fixture + "\n" + declaration).diagnostics.length > 0,
      declaration,
    );
  }
});

Deno.test("independent validation recomputes optional adapter make inputs", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const name of [
      "nullField",
      "decodedField",
      "encodedField",
      "transformedField",
      "requiredField",
      "optionField",
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
      makeInput: name === "optionField"
        ? { kind: "option", element: { kind: "record", fields: [] } }
        : field.value.type.decoded,
    });
    assert(
      validateModule(forged, new Map([["main.eff", fixture]])).length > 0,
      name,
    );
  }
});

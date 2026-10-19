import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

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
  for (
    const declaration of [
      "const bad: SchemaOptional<D, E, Read.parse, Write.print, M> = optionalField",
      "const bad: SchemaConstructorDefault<D, E, Read.parse, Write.print, M> = optionalField",
      "const bad: SchemaEncodedOptionalConstructorDefault<D, E, Read.parse, Write.print, M> = optionalField",
      "const bad = schemaConstructorDefault(optionalField, (): M => ({}))",
      "const bad = schemaArray(optionalField)",
      "const bad = schemaMake(optionalField, {})",
      "const bad = schemaDecode(optionalField, {})",
      "const bad = schemaEncode(optionalField, { score: 4 })",
      "const bad = schemaOptionalKey(decodedField)",
      "const bad = schemaDefaultKey(optionalField, (): D => ({ score: 4 }))",
      "const bad = schemaOptionalTransform(optionalField, schemaOptionalKey(child), (value: Option<D>): Option<E> => None, (value: Option<E>): Option<D> => None)",
      "const bad = schemaConstructorDefault(schemaOptionFromOptionalKey(child), (): Option<M> => Some({}))",
      "service Extra { next(): M }\nconst bad = schemaConstructorDefault(schemaOptionalKey(child), (): M uses Extra.next => Extra.next())",
    ]
  ) {
    assert(
      checked(fixture + "\n" + declaration).diagnostics.length > 0,
      declaration,
    );
  }
});

Deno.test("independent validation accepts one presence flag plus a default and rejects forged combinations", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const mutation of ["default", "presence", "multiple-presence", "make-input"]
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
    assert(
      validateModule(forged, new Map([["main.eff", fixture]])).length > 0,
      mutation,
    );
  }
});

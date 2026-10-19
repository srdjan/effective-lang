import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-order.eff", import.meta.url),
);
const base = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-fields.eff", import.meta.url),
);
function checked(source = fixture) {
  const result = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": source,
      "schema-constructor-fields.eff": base,
    }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("field adapter order preserves unary defaults, selects target defaults and resets Option defaults", () => {
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

Deno.test("adapter order rejects false flags, duplicate defaults and incompatible input presence", () => {
  for (
    const declaration of [
      "const bad: SchemaOptional<D,E,Read.parse,Write.print,M> = optionalAfter",
      "const bad: SchemaOptionalConstructorDefault<D,Text,Read.parse,Write.print,M> = sourceBridge",
      "const bad: SchemaEncodedOptionalConstructorDefault<Option<D>,E,Read.parse,Write.print> = optionAfter",
      "const bad = schemaConstructorDefault(optionalAfter, (): M => ({}))",
      "const bad = schemaOptionalKey(decodedAfter)",
      "const bad = schemaDefaultKey(optionalAfter, (): D => ({ score: 4 }))",
      "const bad = schemaArray(sourceDefault)",
      "const bad = schemaMake(sourceDefault, {})",
      "const bad = schemaMake(optionRecord, {})",
      "const bad = schemaMake(optionRecord, { settings: Some({}) })",
    ]
  ) {
    assert(
      checked(fixture + "\n" + declaration).diagnostics.length > 0,
      declaration,
    );
  }
});

Deno.test("independent validation recomputes retained, target and reset constructor flags", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  const result = lowered.get("main");
  assert(result?.ok);
  for (
    const name of [
      "optionalAfter",
      "decodedAfter",
      "nullAfter",
      "nullDefaultAfter",
      "encodedAfter",
      "targetBridge",
      "requiredBridge",
      "sourceBridge",
      "optionAfter",
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
      constructorDefault: field.value.type.constructorDefault === true
        ? undefined
        : true,
    });
    const changed = new Map(lowered);
    changed.set("main", { ok: true, value: forged });
    assert(
      [...validateProject(project.analysis.project, changed).values()].flat()
        .length > 0,
      name,
    );
  }
});

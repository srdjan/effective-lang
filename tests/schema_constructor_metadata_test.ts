import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const prefix = `type Int = int
type D = { score: Int }
type M = { score?: Int }
const integer: Schema<Int> = schema()
const child: Schema<D, D, never, never, M> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })
`;
function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("constructor metadata retains make input independently of D and E", () => {
  const project = checked(
    prefix + `
type SameD = { value: Int }
const identity: Schema<SameD, SameD, never, never, SameM> = schema()
type SameM = { value: Int }
const unchanged = schemaDefaultKey(identity, (): SameD => ({ value: 4 }))
const make = (): D fails SchemaIssue => schemaMake(child, {})
const list: Schema<D[], D[], never, never, M[]> = schemaArray(child)
const shadow = (): Int => { const schemaConstructorDefault = (): Int => 4; schemaConstructorDefault() }
`,
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

Deno.test("constructor metadata rejects erasure, duplicate defaults, services and unsupported adapters", () => {
  for (
    const declaration of [
      "const erased: Schema<D> = child",
      "const forged: Schema<D, D, never, never, M> = schema()",
      "const bad = schemaConstructorDefault(schemaConstructorDefault(integer, (): Int => 4), (): Int => 5)",
      "const bad = schemaMake(schemaConstructorDefault(integer, (): Int => 4), 4)",
      "const bad = schemaConstructorDefault(integer, (): M => ({}))",
      "const make = (): Int => 4\nconst bad = schemaConstructorDefault(integer, make)",
      "service Default { next(): Int }\nconst bad = schemaConstructorDefault(integer, (): Int uses Default.next => Default.next())",
      "const bad = schemaConstructorDefault(integer, (): Int fails SchemaError => schemaDecode(integer, 4))",
      "const bad = schemaEncode(child, {})",
    ]
  ) assert(checked(prefix + declaration).diagnostics.length > 0, declaration);
});

Deno.test("independent validator rejects erased make input and forged constructor flags", () => {
  const source = prefix;
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (const mutation of ["make-input", "flag"]) {
    const module = structuredClone(result.value);
    const child = module.declarations.find((d) =>
      d.kind === "constant" && d.name === "child"
    );
    assert(
      child?.kind === "constant" && child.value.kind === "schema" &&
        child.value.type.kind === "schema",
    );
    if (mutation === "make-input") {
      Object.assign(child.value.type, { makeInput: child.value.type.decoded });
    } else {
      const fields = child.value.arguments[0];
      assert(
        fields.kind === "record" && fields.fields[0].value.kind === "schema",
      );
      Object.assign(fields.fields[0].value.type, { constructorDefault: false });
    }
    assert(
      validateModule(module, new Map([["main.eff", source]])).length > 0,
      mutation,
    );
  }
});

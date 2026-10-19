import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-recursive.eff", import.meta.url),
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

Deno.test("recursive Schema make inputs preserve each guarded self shape", () => {
  const project = checked(
    fixture.replace("(): Int => 4", "(): Int => { const self = 4; self }") + `
type LeafInput = { score: Int, children?: LeafInput[] }
const leafTransform: Schema<Tree, Tree, never, never, LeafInput> = schemaRecursive(
  (self: Schema<Tree, Tree, never, never, LeafInput>): Schema<Tree, Tree, never, never, LeafInput> =>
    schemaStruct({ score: schemaTransform(integer, integer, (value: Int): Option<Int> => Some(value), (value: Int): Option<Int> => Some(value)),
      children: schemaConstructorDefault(schemaArray(self), (): LeafInput[] => []) })
)
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

Deno.test("recursive make input rejects erasure, wrong self types and callback captures", () => {
  for (
    const source of [
      fixture +
      "\nconst erased: Schema<Tree, Tree, Read.next, Write.previous> = tree",
      fixture +
      "\nconst bad: Schema<Tree, Tree, never, never, TreeInput> = schema()",
      fixture.replace(
        "(self: Schema<Tree, Tree, Read.next, Write.previous, TreeInput>)",
        "(self: Schema<Tree, Tree, Read.next, Write.previous>)",
      ),
      fixture.replace("(): TreeInput[] => []", "(): Tree[] => []"),
      fixture.replace(
        "schemaConstructorDefault(schemaArray(self), (): TreeInput[] => [])",
        "schemaConstructorDefault(self, (): TreeInput => ({}))",
      ),
      fixture.replace(
        '(): ChoiceInput => ({ kind: "end" })',
        '(): ChoiceInput => { const captured = self; { kind: "end" } }',
      ),
      fixture + "\ntype LoopInput = { next: LoopInput }",
      fixture +
      '\nconst bad = schemaMake(tree, { children: [{ score: "bad" }] })',
      fixture + "\nconst bad = schemaEncode(tree, { children: [{}] })",
    ]
  ) assert(checked(source).diagnostics.length > 0, source);
});

Deno.test("independent validation rejects erased recursive M and default callback self capture", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  const erased = structuredClone(result.value);
  const tree = erased.declarations.find((d) =>
    d.kind === "constant" && d.name === "tree"
  );
  assert(tree?.kind === "constant" && tree.value.type.kind === "schema");
  Object.assign(tree.value.type, { makeInput: tree.value.type.decoded });
  assert(validateModule(erased, new Map([["main.eff", fixture]])).length > 0);

  const captured = structuredClone(result.value);
  const choice = captured.declarations.find((d) =>
    d.kind === "constant" && d.name === "choice"
  );
  assert(choice?.kind === "constant" && choice.value.kind === "schema");
  const callback = choice.value.arguments[0];
  assert(callback.kind === "closure" && callback.body.kind === "schema");
  const branches = callback.body.arguments[0];
  assert(branches.kind === "tuple" && branches.elements[1].kind === "schema");
  const fields = branches.elements[1].arguments[0];
  assert(fields.kind === "record");
  const next = fields.fields.find((f) => f.name === "next")?.value;
  assert(next?.kind === "schema" && next.arguments[1].kind === "closure");
  const fallback = next.arguments[1];
  // A discarded local capture keeps the callback's recorded result and effects valid.
  Object.assign(fallback, {
    body: {
      kind: "block",
      steps: [{
        kind: "bind",
        binding: {
          id: "local:forged-capture",
          name: "capture",
          type: callback.parameters[0].type,
          span: fallback.span,
        },
        value: {
          kind: "reference",
          target: callback.parameters[0].id,
          type: callback.parameters[0].type,
          execution: "pure",
          effects: { failures: [], requirements: [] },
          span: fallback.span,
        },
      }],
      result: fallback.body,
      type: fallback.body.type,
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: fallback.span,
    },
  });
  assert(
    validateModule(captured, new Map([["main.eff", fixture]])).some((d) =>
      d.message.includes("schemaRecursive needs")
    ),
  );
});

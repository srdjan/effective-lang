import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-recursive-wire.eff", import.meta.url),
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

Deno.test("recursive Schemas preserve independent D, E, M and wire services", () => {
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

Deno.test("recursive wire types reject erased encoded axes and wrong nested data", () => {
  for (
    const source of [
      fixture +
      "\nconst bad: Schema<Tree, Tree, Read.parse, Write.print, TreeInput> = tree",
      fixture.replace(
        "(self: Schema<Tree, WireTree, Read.parse, Write.print, TreeInput>)",
        "(self: Schema<Tree, Tree, Read.parse, Write.print, TreeInput>)",
      ),
      fixture.replace(
        "children: schemaConstructorDefault(schemaArray(self), (): TreeInput[] => [])",
        "children: schemaArray(schemaStruct({ score: text, children: schemaArray(self) }))",
      ),
      fixture +
      '\nconst bad = schemaEncode(tree, { score: "4", children: [] })',
      fixture +
      '\nconst bad = schemaMake(tree, { children: [{ score: "4" }] })',
      fixture +
      '\nconst bad: WireTree = { score: "1", children: [{ score: 2, children: [] }] }',
      fixture + "\nconst bad: Schema<Tree, WireTree> = schema()",
      fixture + "\ntype InvalidWire = { next: InvalidWire }",
    ]
  ) assert(checked(source).diagnostics.length > 0, source);
});

Deno.test("independent validation rejects forged recursive wire signatures and channels", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (const mutation of ["encoded", "self", "services", "identity"]) {
    const forged = structuredClone(result.value);
    const tree = forged.declarations.find((d) =>
      d.kind === "constant" && d.name === "tree"
    );
    assert(
      tree?.kind === "constant" && tree.value.kind === "schema" &&
        tree.value.type.kind === "schema",
    );
    if (mutation === "encoded") {
      Object.assign(tree.value.type, { encoded: tree.value.type.decoded });
    } else if (mutation === "services") {
      Object.assign(tree.value.type, { encodeRequirements: [] });
    } else if (mutation === "identity") {
      // Identity derivation must still require D=E even with otherwise empty channels.
      Object.assign(tree.value, {
        op: "identity",
        arguments: [],
        type: {
          kind: "schema",
          decoded: tree.value.type.decoded,
          encoded: tree.value.type.encoded,
          decodeRequirements: [],
          encodeRequirements: [],
        },
      });
    } else {
      const callback = tree.value.arguments[0];
      assert(
        callback.kind === "closure" &&
          callback.parameters[0].type.kind === "schema",
      );
      Object.assign(callback.parameters[0].type, {
        encoded: callback.parameters[0].type.decoded,
      });
    }
    assert(
      validateModule(forged, new Map([["main.eff", fixture]])).length > 0,
      mutation,
    );
  }
});

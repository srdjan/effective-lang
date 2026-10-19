import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-recursive-adapters.eff", import.meta.url),
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

Deno.test("recursive field adapters retain structural guards and independent D/E/M", () => {
  const project = checked(fixture.replace(
    "(): Input[] => []",
    "(): Input[] => { const self: Input[] = []; self }",
  ));
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

Deno.test("recursive adapters reject callback captures and unsupported self paths", () => {
  for (
    const source of [
      fixture.replace(
        "=> Defaults.children()",
        "=> { const captured = self; Defaults.children() }",
      ),
      fixture.replace(
        "=> run(pending)",
        "=> { const captured = self; run(pending) }",
      ),
      fixture.replace(
        "(): WireTree[] => []",
        "(): WireTree[] => { const captured = self; [] }",
      ),
      fixture.replace(
        "Option<OptionalTree[]> => value",
        "Option<OptionalTree[]> => { const captured = self; value }",
      ),
      fixture.replace(
        "Option<RequiredTree[]> => Some([])",
        "Option<RequiredTree[]> => { const captured = self; Some([]) }",
      ),
      fixture.replace(
        "OptionalTree[] => [])",
        "OptionalTree[] => { const captured = self; [] })",
      ),
      fixture.replace(
        "schemaNullToMissingKey(self)",
        "schemaOptionalKey(schemaTransform(self, self, (value: Node): Option<WireNode> => None, (value: WireNode): Option<Node> => None))",
      ),
      fixture + "\ntype Invalid = { next: Invalid | null }",
      fixture + "\ntype Invalid = { next: Option<Invalid> }",
      fixture +
      '\nconst bad = schemaMake(tree, { children: [{ score: "4" }] })',
      fixture +
      "\nconst bad: Schema<Tree,Tree,Read.parse | Defaults.children,Write.print,Input> = tree",
    ]
  ) assert(checked(source).diagnostics.length > 0, source);
  const shadowed = `type Node = { next?: Node }
const schemaOptionalKey = (value: Schema<Node>): SchemaOptional<Node> => schemaOptionalKey(value)
const bad: Schema<Node> = schemaRecursive((self: Schema<Node>): Schema<Node> =>
  schemaStruct({ next: schemaOptionalKey(self) }))`;
  assert(
    checked(shadowed).diagnostics.some((d) =>
      d.message.includes("recursive schema self")
    ),
  );
});

Deno.test("independent recursive validation forbids self captures in adapter callbacks", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const [name, index] of [
      ["tree", 1],
      ["encoded", 1],
      ["bridge", 2],
      ["bridge", 3],
      ["requiredBridge", 2],
      ["requiredBridge", 3],
    ] as const
  ) {
    const forged = structuredClone(result.value);
    const declaration = forged.declarations.find((d) =>
      d.kind === "constant" && d.name === name
    );
    assert(
      declaration?.kind === "constant" && declaration.value.kind === "schema",
    );
    const recursive = declaration.value.arguments[0];
    assert(recursive.kind === "closure" && recursive.body.kind === "schema");
    const fields = recursive.body.arguments[0];
    assert(fields.kind === "record");
    const adapter = fields.fields.find((f) => f.name === "children")?.value;
    assert(adapter?.kind === "schema");
    const callback = adapter.arguments[index];
    assert(callback.kind === "closure");
    Object.assign(callback, {
      body: {
        kind: "block",
        steps: [{
          kind: "bind",
          binding: {
            id: "local:forged-capture",
            name: "capture",
            type: recursive.parameters[0].type,
            span: callback.span,
          },
          value: {
            kind: "reference",
            target: recursive.parameters[0].id,
            type: recursive.parameters[0].type,
            execution: "pure",
            effects: { failures: [], requirements: [] },
            span: callback.span,
          },
        }],
        result: callback.body,
        type: callback.body.type,
        execution: callback.body.execution,
        effects: callback.body.effects,
        span: callback.span,
      },
    });
    assert(
      validateModule(forged, new Map([["main.eff", fixture]])).some((d) =>
        d.message.includes("schemaRecursive needs")
      ),
      name + index,
    );
  }
});

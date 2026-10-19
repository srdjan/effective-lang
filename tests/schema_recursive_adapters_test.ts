import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import {
  assertDiagnostics,
  type Expected,
  PURE_CONSTANT,
} from "./schema_diagnostics.ts";

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
  const selfGuard =
    "recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch";
  const guard: readonly Expected[] = [["type-mismatch/010", selfGuard]];
  const cases: readonly (readonly [string, readonly Expected[]])[] = [
    [
      fixture.replace(
        "=> Defaults.children()",
        "=> { const captured = self; Defaults.children() }",
      ),
      guard,
    ],
    [
      fixture.replace(
        "=> run(pending)",
        "=> { const captured = self; run(pending) }",
      ),
      guard,
    ],
    [
      fixture.replace(
        "(): WireTree[] => []",
        "(): WireTree[] => { const captured = self; [] }",
      ),
      guard,
    ],
    [
      fixture.replace(
        "Option<OptionalTree[]> => value",
        "Option<OptionalTree[]> => { const captured = self; value }",
      ),
      guard,
    ],
    [
      fixture.replace(
        "Option<RequiredTree[]> => Some([])",
        "Option<RequiredTree[]> => { const captured = self; Some([]) }",
      ),
      guard,
    ],
    [
      fixture.replace(
        "OptionalTree[] => [])",
        "OptionalTree[] => { const captured = self; [] })",
      ),
      guard,
    ],
    [
      fixture.replace(
        "schemaNullToMissingKey(self)",
        "schemaOptionalKey(schemaTransform(self, self, (value: Node): Option<WireNode> => None, (value: WireNode): Option<Node> => None))",
      ),
      [
        ["type-mismatch/010", selfGuard],
        [
          "type-mismatch/003",
          "the function body has type Schema<{ next?: Node, score: Int }",
        ],
      ],
    ],
    [
      fixture + "\ntype Invalid = { next: Invalid | null }",
      [[
        "declaration/007",
        "the type `Invalid` is defined in terms of itself",
        "Invalid",
      ]],
    ],
    [
      fixture + "\ntype Invalid = { next: Option<Invalid> }",
      [[
        "declaration/007",
        "the type `Invalid` is defined in terms of itself",
        "Invalid",
      ]],
    ],
    [
      fixture +
      '\nconst bad = schemaMake(tree, { children: [{ score: "4" }] })',
      [
        [
          "execution-mode/002",
          PURE_CONSTANT,
          'schemaMake(tree, { children: [{ score: "4" }] })',
        ],
        [
          "type-mismatch/003",
          "the field `score` has type string, but Int is expected",
          '"4"',
        ],
      ],
    ],
    [
      fixture +
      "\nconst bad: Schema<Tree,Tree,Read.parse | Defaults.children,Write.print,Input> = tree",
      [[
        "type-mismatch/003",
        "has type Schema<Tree, WireTree, Defaults.children | Read.parse, Write.print, Input>",
        "tree",
      ]],
    ],
  ];
  for (const [source, expected] of cases) {
    assertDiagnostics(
      source,
      checked(source).diagnostics,
      expected,
      source.slice(-80),
    );
  }
  const shadowed = `type Node = { next?: Node }
const schemaOptionalKey = (value: Schema<Node>): SchemaOptional<Node> => schemaOptionalKey(value)
const bad: Schema<Node> = schemaRecursive((self: Schema<Node>): Schema<Node> =>
  schemaStruct({ next: schemaOptionalKey(self) }))`;
  assertDiagnostics(
    shadowed,
    checked(shadowed).diagnostics,
    guard,
    "shadowed schemaOptionalKey",
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

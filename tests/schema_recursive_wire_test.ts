import { assert, assertEquals } from "@std/assert";
import { lowerProject, validateProject } from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import {
  assertDiagnostics,
  assertValidation,
  declarationPath,
  type Expected,
  PURE_CONSTANT,
} from "./schema_diagnostics.ts";
import { checkModule } from "./helpers.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-recursive-wire.eff", import.meta.url),
);
const checked = (source = fixture) => checkModule(source, "main.eff");

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
  const cases: readonly (readonly [string, readonly Expected[]])[] = [
    [
      fixture +
      "\nconst bad: Schema<Tree, Tree, Read.parse, Write.print, TreeInput> = tree",
      [[
        "type-mismatch/003",
        "has type Schema<Tree, WireTree, Read.parse, Write.print, TreeInput>, but Schema<Tree, Tree,",
        "tree",
      ]],
    ],
    [
      fixture.replace(
        "(self: Schema<Tree, WireTree, Read.parse, Write.print, TreeInput>)",
        "(self: Schema<Tree, Tree, Read.parse, Write.print, TreeInput>)",
      ),
      [
        [
          "type-mismatch/003",
          "parameter 1 of the callback has type Schema<Tree, Tree, Read.parse, Write.print, TreeInput>",
        ],
        [
          "type-mismatch/003",
          "the function body has type Schema<{ children: Tree[], score: Int }",
        ],
      ],
    ],
    [
      fixture.replace(
        "children: schemaConstructorDefault(schemaArray(self), (): TreeInput[] => [])",
        "children: schemaArray(schemaStruct({ score: text, children: schemaArray(self) }))",
      ),
      [[
        "type-mismatch/003",
        "the function body has type Schema<{ children: { children: Tree[], score: Text }[], score: Int }",
      ]],
    ],
    [
      fixture +
      '\nconst bad = schemaEncode(tree, { score: "4", children: [] })',
      [
        [
          "execution-mode/002",
          PURE_CONSTANT,
          'schemaEncode(tree, { score: "4", children: [] })',
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
      '\nconst bad: WireTree = { score: "1", children: [{ score: 2, children: [] }] }',
      [[
        "type-mismatch/003",
        "the field `score` has type int, but Text is expected",
        "2",
      ]],
    ],
    [
      fixture + "\nconst bad: Schema<Tree, WireTree> = schema()",
      [[
        "type-mismatch/003",
        "`schema()` needs an identity Schema with no services",
        "schema()",
      ]],
    ],
    [
      fixture + "\ntype InvalidWire = { next: InvalidWire }",
      [[
        "declaration/007",
        "the type `InvalidWire` is defined in terms of itself",
        "InvalidWire",
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
});

Deno.test("independent validation rejects forged recursive wire signatures and channels", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const result = [...lowerProject(project).values()][0];
  assert(result.ok);
  for (
    const [mutation, path, fragment] of [
      ["encoded", ".value", "schemaRecursive needs a pure body"],
      ["self", ".value.arguments[0].type.parameters[0]", "expected Schema<"],
      ["services", ".value", "schemaRecursive needs a pure body"],
      ["identity", ".value", "schema() needs an identity data Schema"],
    ] as const
  ) {
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
    assertValidation(
      validateModule(forged, new Map([["main.eff", fixture]])),
      "validation/002",
      `${declarationPath(forged, "tree")}${path}`,
      fragment,
      mutation,
    );
  }
});

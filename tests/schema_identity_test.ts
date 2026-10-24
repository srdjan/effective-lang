// Emission of identity Schemas (`schema(): Schema<T>`) and of the recursive
// alias constants that they can refer to.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { lowerProject } from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { checkModule, emitFiles } from "./helpers.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-composition.eff", import.meta.url),
);

const checked = (source: string) => checkModule(source, "main.eff");

function emitted(source: string): string {
  const module = emitFiles({ "effektive.json": "{}", "main.eff": source }, [
    "main.eff",
  ]).get("main");
  assert(module !== undefined, "module main was not emitted");
  return module.text;
}

Deno.test("an identity Schema over a brand or an error wraps the derived Schema in toType", () => {
  const output = emitted(`type UserId = string
error Stop = { reason: string }
const userId: Schema<UserId> = schema()
const stop: Schema<Stop> = schema()
`);
  assertStringIncludes(output, "> = Schema.toType(UserId);");
  assertStringIncludes(output, "> = Schema.toType(Stop);");
});

Deno.test("a recursive alias constant keeps its natural Schema and names its encoded mirror type", () => {
  const output = emitted(`type UserId = string
error Stop = { reason: string }
type Node = { id: UserId, error: Stop, kids: Node[] }
const node: Schema<Node> = schema()
`);
  assertStringIncludes(output, "type NodeEncoded = {");
  assertStringIncludes(
    output,
    "readonly id: Schema.Codec.Encoded<typeof UserId>;",
  );
  assertStringIncludes(
    output,
    "readonly error: Schema.Codec.Encoded<typeof Stop>;",
  );
  assertStringIncludes(
    output,
    "readonly kids: ReadonlyArray<NodeEncoded>;",
  );
  assertStringIncludes(output, "const Node: Schema.Codec<Node, NodeEncoded> =");
  assertStringIncludes(
    output,
    "Schema.suspend((): Schema.Codec<Node, NodeEncoded> => Node)",
  );
  // Only the identity Schema refers to the type view of the constant.
  assertStringIncludes(output, "= Schema.toType(Node);");
  assert(
    !/const Node: [^=]+= Schema\.toType/.test(output),
    "the recursive alias constant must keep its natural derivation",
  );
});

Deno.test("the encoded mirror type of a recursive alias avoids names that the source declares", () => {
  const output = emitted(`type NodeEncoded = int
type Node = { score: NodeEncoded, kids: Node[] }
`);
  assertStringIncludes(output, "type NodeEncoded$1 = {");
  assertStringIncludes(
    output,
    "const Node: Schema.Codec<Node, NodeEncoded$1> =",
  );
});

Deno.test("schema callbacks, encode input, and unguarded recursion are rejected", () => {
  const prefix = `type Int = int
type Flag = boolean
type Tree = { value: Int, children: Tree[] }
service Read { next(value: Int): Option<Int> }
service Write { previous(value: Int): Option<Int> }
const integer: Schema<Int> = schema()
`;
  const cases = [
    ["type Loop = Loop", "declaration/007"],
    ["type Loop = { next: Loop }", "declaration/007"],
    ["type A = { children: B[] }\ntype B = A", "declaration/007"],
    ["type Fn = () => Int\ntype Invalid = Schema<Fn>", "type-mismatch/010"],
    [
      "const bad = schemaTransform(integer, integer, (n: Int): Option<Flag> => Some(true), (n: Int): Option<Int> => Some(n))",
      "type-mismatch/003",
    ],
    [
      "const bad: Schema<Tree> = schemaRecursive((self: Schema<Tree>): Schema<Tree> => self)",
      "type-mismatch/010",
    ],
    [
      "const bad: Schema<Tree> = schemaRecursive((self: Schema<Tree>): Schema<Tree> => schemaStruct({ value: integer, children: self }))",
      "type-mismatch/010",
    ],
    [
      'const bad = schemaTransform(integer, integer, (n: Int): Option<Int> fails SchemaError => fail(SchemaError({ message: "x" })), (n: Int): Option<Int> => Some(n))',
      "type-mismatch/010",
    ],
    [
      'const bad: Schema<Int> = schema()\nconst wrong = schemaEncode(bad, "text")',
      "type-mismatch/003",
    ],
  ] as const;
  for (const [source, code] of cases) {
    const diagnostics = checked(`${prefix}\n${source}`).diagnostics;
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === code),
      `${source}: ${JSON.stringify(diagnostics)}`,
    );
  }
  const deferred = checked(
    `type Fn = () => int\ntype Tree = { callback: Fn, children: Tree[] }`,
  );
  assert(
    deferred.diagnostics.some((diagnostic) =>
      diagnostic.code === "declaration/007"
    ),
  );
  assertEquals(
    checked(
      "type Int = int\nconst schema = (value: Int): Int => value\nconst result: Int = schema(1)",
    ).diagnostics,
    [],
  );
});

Deno.test("independent validation rejects forged schema channels and self use", () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  const result = [...lowered.values()][0];
  assert(result.ok, JSON.stringify(result));
  const sources = new Map([["main.eff", fixture]]);
  const channel = structuredClone(result.value);
  const shifted = channel.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "shifted"
  );
  assert(shifted?.kind === "constant");
  assert(shifted.value.type.kind === "schema");
  Object.assign(shifted.value.type, { decodeRequirements: [] });
  assert(
    validateModule(channel, sources).some((diagnostic) =>
      diagnostic.message.includes("type") ||
      diagnostic.message.includes("requirement")
    ),
  );

  const immediate = structuredClone(result.value);
  const tree = immediate.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "tree"
  );
  assert(tree?.kind === "constant" && tree.value.kind === "schema");
  const callback = tree.value.arguments[0];
  assert(callback?.kind === "closure" && callback.body.kind === "schema");
  const record = callback.body.arguments[0];
  assert(record?.kind === "record");
  const children = record.fields.find((field) => field.name === "children");
  assert(children !== undefined);
  Object.assign(children, {
    value: {
      kind: "reference",
      target: callback.parameters[0].id,
      type: callback.parameters[0].type,
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: children.value.span,
    },
  });
  assert(
    validateModule(immediate, sources).some((diagnostic) =>
      diagnostic.message.includes("schemaRecursive needs")
    ),
  );
});

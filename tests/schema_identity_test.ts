// Emission of identity Schemas (`schema(): Schema<T>`) and of the recursive
// alias constants that they can refer to.

import { assert, assertStringIncludes } from "@std/assert";
import { emitFiles } from "./helpers.ts";

function emitted(source: string): string {
  const module = emitFiles({ "effective.json": "{}", "main.eff": source }, [
    "main.eff",
  ]).get("main");
  assert(module !== undefined, "module main was not emitted");
  return module.text;
}

Deno.test("an identity Schema over a brand or an error wraps the derived Schema in toType", () => {
  const output = emitted(`type UserId = Brand<string>
error Stop = { reason: string }
const userId: Schema<UserId> = schema()
const stop: Schema<Stop> = schema()
`);
  assertStringIncludes(output, "> = Schema.toType(UserId);");
  assertStringIncludes(output, "> = Schema.toType(Stop);");
});

Deno.test("a recursive alias constant keeps its natural Schema and names its encoded mirror type", () => {
  const output = emitted(`type UserId = Brand<string>
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

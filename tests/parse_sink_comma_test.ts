// A Sink type needs a comma after its input type. The type word `Sink` is the
// only one whose second type is required, so the parser reports a missing comma
// and goes on. These tests pin the diagnostic, the shape of the tree, and the
// recovery that keeps the later declarations.

import { assertEquals } from "@std/assert";
import { parse } from "../src/core/parse.ts";
import {
  kindName,
  kindOf,
  printTree,
  SyntaxKind,
  walk,
} from "../src/core/syntax.ts";
import { treeProblems } from "./helpers.ts";

function parsed(text: string) {
  const result = parse("t.eff", text, "eff");
  // Every input prints back exactly and gives a well formed tree.
  assertEquals(printTree(result.tree), text);
  assertEquals(treeProblems(result.tree), []);
  const kinds: string[] = [];
  walk(result.tree, result.tree.root, (node) => {
    kinds.push(kindName(kindOf(result.tree, node)));
  });
  return {
    tree: result.tree,
    kinds,
    diagnostics: result.diagnostics.map((d) =>
      `${d.span.start}-${d.span.end} ${d.code} ${d.message}`
    ),
  };
}

Deno.test("a Sink with one type argument reports the missing comma once", () => {
  const { diagnostics, kinds } = parsed("type S = Sink<int>");
  assertEquals(diagnostics, ["17-18 syntax/008 expected `,`, found `>`"]);
  // The comma and the result type are Missing nodes inside the SinkType node.
  assertEquals(kinds.filter((kind) => kind === "SinkType").length, 1);
  assertEquals(kinds.filter((kind) => kind === "Missing").length, 2);
});

Deno.test("a Sink with two types and no comma reports the missing comma and keeps the second type", () => {
  const { diagnostics, kinds } = parsed("type S = Sink<int int>");
  assertEquals(diagnostics, ["18-21 syntax/008 expected `,`, found `int`"]);
  // The second `int` still parses as a NamedType, so only the comma is missing.
  assertEquals(kinds.filter((kind) => kind === "NamedType").length, 2);
  assertEquals(kinds.filter((kind) => kind === "Missing").length, 1);
});

Deno.test("a Sink without a comma does not hide the later declaration", () => {
  const { tree, diagnostics } = parsed(
    "type S = Sink<int>\nconst a = 1\n",
  );
  assertEquals(diagnostics, ["17-18 syntax/008 expected `,`, found `>`"]);
  let constants = 0;
  walk(tree, tree.root, (node) => {
    if (kindOf(tree, node) === SyntaxKind.ConstDecl) constants++;
  });
  assertEquals(constants, 1);
});

Deno.test("a Sink with the comma parses with no diagnostic", () => {
  assertEquals(parsed("type S = Sink<int, int>").diagnostics, []);
});

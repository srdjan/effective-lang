import { assertEquals, assertNotEquals } from "@std/assert";
import { type Diagnostic } from "../src/core/diagnostics.ts";
import { fileModeOf, parse, parseFromHost } from "../src/core/parse.ts";
import { memoryHost } from "../src/core/source.ts";
import {
  childrenOf,
  hasProblem,
  kindName,
  kindOf,
  type NodeId,
  nodeText,
  printTree,
  SyntaxKind,
  type SyntaxTree,
  walk,
} from "../src/core/syntax.ts";
import {
  constInitializer,
  declSummaries,
  findFirst,
  nodeChildren,
  sexp,
  treeProblems,
} from "./helpers.ts";

/** Parses text, checks the invariants that hold for every input, and returns the result. */
function parseChecked(text: string, mode: "eff" | "effi" = "eff") {
  const result = parse(mode === "eff" ? "t.eff" : "t.effi", text, mode);
  assertEquals(
    printTree(result.tree),
    text,
    "the printed tree equals the input",
  );
  assertEquals(treeProblems(result.tree), []);
  return result;
}

function parseClean(text: string, mode: "eff" | "effi" = "eff"): SyntaxTree {
  const result = parseChecked(text, mode);
  assertEquals(result.diagnostics.map(show), []);
  return result.tree;
}

function show(d: Diagnostic): string {
  return `${d.span.start}-${d.span.end} ${d.code} ${d.message}`;
}

function countKind(tree: SyntaxTree, kind: SyntaxKind): number {
  let n = 0;
  walk(tree, tree.root, (node) => {
    if (kindOf(tree, node) === kind) n++;
  });
  return n;
}

function kindsOfChildren(tree: SyntaxTree, node: NodeId): string[] {
  return nodeChildren(tree, node).map((c) => kindName(kindOf(tree, c)));
}

Deno.test("a newline continues an item before fails, uses, =>, |>, else, and catch", () => {
  const cases: [string, string, SyntaxKind][] = [
    ["fails", "const f = (): int\n  fails E\n  => 1", SyntaxKind.FailsClause],
    ["uses", "const f = (): int\n  uses S.m\n  => 1", SyntaxKind.UsesClause],
    ["=>", "const f = (): int\n  => 1", SyntaxKind.ArrowExpr],
    ["|>", "const f = xs\n  |> g", SyntaxKind.PipeExpr],
    ["else", "const f = if (a) { 1 }\n  else { 2 }", SyntaxKind.IfExpr],
    [
      "catch",
      "const f = try { 1 }\n  catch { E(e) => 2 }",
      SyntaxKind.CatchClause,
    ],
  ];
  for (const [name, text, kind] of cases) {
    const tree = parseClean(text);
    assertEquals(countKind(tree, kind), 1, name);
    assertEquals(declSummaries(tree).map((d) => d.kind), ["ConstDecl"], name);
  }
});

Deno.test("a newline ends an item before a binary operator and before a call", () => {
  const plus = parseChecked("const f = a\n+ b");
  assertNotEquals(plus.diagnostics.length, 0);
  assertEquals(declSummaries(plus.tree)[0].kind, "ConstDecl");
  const call = parseClean("const f = (): int => {\n  a\n  (b)\n}");
  const block = findFirst(call, SyntaxKind.Block)!;
  assertEquals(kindsOfChildren(call, block), ["NameExpr", "ParenExpr"]);
});

Deno.test("a newline does not end an item after an operator, a comma, =, =>, :, (, [, or {", () => {
  parseClean("const f = 1 +\n  2");
  parseClean("const f = g(1,\n  2)");
  parseClean("const f =\n  1");
  parseClean("const f: \n  int = 1");
  parseClean("const f = (x:\n  int): int =>\n  x");
  parseClean("const f = g(\n  1\n)");
  parseClean("const f = {\n  a: 1\n}");
  parseClean("type T = [\n  int,\n  string\n]");
  parseClean("const f = a &&\n  b");
  parseClean("const f = a |>\n  g");
});

Deno.test("a semicolon separates declarations and block items", () => {
  const tree = parseClean(
    "const a = 1; const b = 2;\nconst c = (): int => { const x = 1; x }",
  );
  assertEquals(declSummaries(tree).map((d) => d.name), ["a", "b", "c"]);
});

Deno.test("operator precedence and left associativity", () => {
  const table: [string, string][] = [
    ["a + b * c", "(a + (b * c))"],
    ["a * b + c", "((a * b) + c)"],
    ["a - b - c", "((a - b) - c)"],
    ["a / b * c", "((a / b) * c)"],
    ["a < b === c < d", "((a < b) === (c < d))"],
    ["a === b && c !== d || e", "(((a === b) && (c !== d)) || e)"],
    ["a || b && c", "(a || (b && c))"],
    ["a >= b + 1", "(a >= (b + 1))"],
    ["(a + b) * c", "((a + b) * c)"],
    ["a || b |> f", "((a || b) |> f)"],
    ["a + b |> f", "((a + b) |> f)"],
    ["a |> f |> g(1, 2)", "((a |> f) |> g(1, 2))"],
    ["a |> S.m", "(a |> S.m)"],
    ["a.b.c(1).d", "a.b.c(1).d"],
    ["f(a)(b)", "f(a)(b)"],
    ["f(a + 1, b * 2)", "f((a + 1), (b * 2))"],
  ];
  for (const [source, expected] of table) {
    const tree = parseClean(`const x = ${source}`);
    assertEquals(sexp(tree, constInitializer(tree, "x")), expected, source);
  }
});

Deno.test("a pipeline stage is a qualified name with optional arguments", () => {
  const tree = parseClean("const x = a |> f |> S.m(1)");
  assertEquals(countKind(tree, SyntaxKind.PipeStage), 2);
  assertEquals(countKind(tree, SyntaxKind.PipeExpr), 2);
});

Deno.test("at an open parenthesis the parser chooses an arrow or a grouping", () => {
  const table: [string, SyntaxKind][] = [
    ["(a)", SyntaxKind.ParenExpr],
    ["((a))", SyntaxKind.ParenExpr],
    ["(a) => a", SyntaxKind.ArrowExpr],
    ["() => a", SyntaxKind.ArrowExpr],
    ["(a, b) => a", SyntaxKind.ArrowExpr],
    ["(a: int): int => a", SyntaxKind.ArrowExpr],
    ["(a)\n  => a", SyntaxKind.ArrowExpr],
    ["(a): int\n  fails E\n  => a", SyntaxKind.ArrowExpr],
    ["(a) + (b)", SyntaxKind.BinaryExpr],
    ["(a)(b)", SyntaxKind.CallExpr],
  ];
  for (const [source, kind] of table) {
    const tree = parseClean(`const x = ${source}`);
    assertEquals(
      kindName(kindOf(tree, constInitializer(tree, "x"))),
      kindName(kind),
      source,
    );
  }
});

Deno.test("a brace opens a block, a handler list, an arm list, or a record by context", () => {
  const block = parseClean("const f = (): int => { 1 }");
  assertEquals(countKind(block, SyntaxKind.Block), 1);
  assertEquals(countKind(block, SyntaxKind.RecordExpr), 0);

  const paren = parseClean("const f = (): R => ({ a: 1 })");
  assertEquals(countKind(paren, SyntaxKind.Block), 0);
  assertEquals(countKind(paren, SyntaxKind.RecordExpr), 1);

  const record = parseClean("const r = { a: 1 }");
  assertEquals(countKind(record, SyntaxKind.RecordExpr), 1);

  const match = parseClean("const m = match x { _ => 1 }");
  assertEquals(countKind(match, SyntaxKind.MatchExpr), 1);
  assertEquals(countKind(match, SyntaxKind.RecordExpr), 0);
  assertEquals(countKind(match, SyntaxKind.MatchArm), 1);

  const tried = parseClean("const t = try { 1 } catch { E(e) => 1 }");
  assertEquals(countKind(tried, SyntaxKind.Block), 1);
  assertEquals(countKind(tried, SyntaxKind.Handler), 1);

  const branch = parseClean("const i = if (c) { 1 } else { 2 }");
  assertEquals(countKind(branch, SyntaxKind.Block), 2);
  assertEquals(countKind(branch, SyntaxKind.RecordExpr), 0);
});

Deno.test("a record result after => needs parentheses", () => {
  const result = parseChecked("const f = (): R => { a: 1 }");
  assertNotEquals(result.diagnostics.length, 0);
});

Deno.test("record expressions: leading spread, shorthand, trailing comma", () => {
  const tree = parseClean("const r = { ...base, a: 1, b, }");
  const record = findFirst(tree, SyntaxKind.RecordExpr)!;
  assertEquals(kindsOfChildren(tree, record), [
    "SpreadField",
    "RecordField",
    "ShorthandField",
  ]);
  const empty = parseClean("const r = {}");
  assertEquals(
    kindsOfChildren(empty, findFirst(empty, SyntaxKind.RecordExpr)!),
    [],
  );
});

Deno.test("patterns", () => {
  const tree = parseClean(
    'const m = match x { _ => 1, "s" => 2, 3 => 3, true => 4, Some(v) => 5, None => 6, ' +
      'E(e) => 7, { k: "a", ...r } => 8, { k: "b" } => 9 }',
  );
  const arms: string[] = [];
  walk(tree, tree.root, (node) => {
    if (kindOf(tree, node) === SyntaxKind.MatchArm) {
      arms.push(kindName(kindOf(tree, nodeChildren(tree, node)[0])));
    }
  });
  assertEquals(arms, [
    "WildcardPattern",
    "LiteralPattern",
    "LiteralPattern",
    "LiteralPattern",
    "CtorPattern",
    "NamePattern",
    "CtorPattern",
    "RecordPattern",
    "RecordPattern",
  ]);
});

Deno.test("nested patterns are syntax errors", () => {
  const result = parseChecked(
    "const m = match x { Some(Some(v)) => 1, None => 2 }",
  );
  assertEquals(result.diagnostics.map((d) => d.code), ["syntax/011"]);
  // The later arm still parses.
  assertEquals(countKind(result.tree, SyntaxKind.MatchArm), 2);
});

Deno.test("type forms", () => {
  const types = [
    "string",
    "Id",
    "Option<int>",
    "Brand<string>",
    "Option<Option<int>>",
    "int[]",
    "int[][]",
    "[int, string]",
    "{ a: int, b?: string, }",
    "{ a: { b: int } }",
    '"x" | "y"',
    "A | B | C",
    "(A | B)[]",
    "1 | true",
    "(x: int) => string",
    "() => int fails E uses S.m",
    "(f: (x: int) => int, y: int) => int",
    "(x: int) => int[] fails E | F",
  ];
  for (const type of types) parseClean(`type T = ${type}`);
  const union = parseClean('type T = "a" | "b"');
  assertEquals(countKind(union, SyntaxKind.UnionType), 1);
  const optional = parseClean("type T = { a?: int }");
  assertEquals(countKind(optional, SyntaxKind.FieldType), 1);
  assertEquals(
    nodeText(optional, findFirst(optional, SyntaxKind.FieldType)!),
    "a?: int",
  );
});

Deno.test("a service method named fails or uses does not continue the previous method", () => {
  const tree = parseClean(
    "service S {\n  a(): int\n  fails(x: int): int\n  uses(): int\n}",
  );
  assertEquals(countKind(tree, SyntaxKind.ServiceMethod), 3);
  assertEquals(countKind(tree, SyntaxKind.FailsClause), 0);
  assertEquals(countKind(tree, SyntaxKind.UsesClause), 0);
});

Deno.test("a service method clause on the next line continues the method", () => {
  const tree = parseClean(
    "service S {\n  a(): int\n    fails E | F\n  b(): int\n}",
  );
  assertEquals(countKind(tree, SyntaxKind.ServiceMethod), 2);
  assertEquals(countKind(tree, SyntaxKind.FailsClause), 1);
});

Deno.test("host interface files accept provider declarations", () => {
  const tree = parseClean(
    'import { Users } from "../users.eff"\nexport provider UsersLive provides Users\n',
    "effi",
  );
  assertEquals(declSummaries(tree).map((d) => d.kind), [
    "ImportDecl",
    "ProviderDecl",
  ]);
  const full = parseClean(
    "provider P provides A | B fails E uses C.m",
    "effi",
  );
  assertEquals(countKind(full, SyntaxKind.ProvidesClause), 1);
  assertEquals(countKind(full, SyntaxKind.FailsClause), 1);
  assertEquals(countKind(full, SyntaxKind.UsesClause), 1);
});

Deno.test("host interface files reject const, and source files reject provider", () => {
  const constResult = parseChecked("const a = (x: int): int => x", "effi");
  assertEquals(constResult.diagnostics.map((d) => d.code), ["syntax/012"]);
  const providerResult = parseChecked("provider P provides S", "eff");
  assertEquals(providerResult.diagnostics.map((d) => d.code), ["syntax/013"]);
});

Deno.test("fileModeOf follows the extension", () => {
  assertEquals(fileModeOf("host/providers.effi"), "effi");
  assertEquals(fileModeOf("users.eff"), "eff");
  assertEquals(fileModeOf("anything"), "eff");
  assertEquals(parse("a.effi", "provider P provides S").diagnostics, []);
});

Deno.test("void is valid as a type and reserved as a name", () => {
  parseClean("const f = (): void => 1");
  parseClean("service S { f(): void }");
  assertEquals(parseChecked("const void = 1").diagnostics.map((d) => d.code), [
    "syntax/007",
  ]);
  assertEquals(
    parseChecked("const f = (void: int): int => 1").diagnostics.map((d) =>
      d.code
    ),
    ["syntax/007"],
  );
  assertEquals(parseChecked("const f = void").diagnostics.map((d) => d.code), [
    "syntax/007",
  ]);
});

Deno.test("CRLF input gives the same tree as LF input", () => {
  const lf =
    "const a = (x: int): int\n  fails E\n  => {\n  x\n}\nconst b = a\n  |> f\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  const lfResult = parseChecked(lf);
  const crlfResult = parseChecked(crlf);
  assertEquals(crlfResult.diagnostics, []);
  assertEquals(declSummaries(crlfResult.tree), declSummaries(lfResult.tree));
  assertEquals(crlfResult.tree.count, lfResult.tree.count);
});

Deno.test("an error is a Missing node of zero width plus one diagnostic", () => {
  const result = parseChecked("const a = ");
  assertEquals(result.diagnostics.map((d) => d.code), ["syntax/008"]);
  const missing = findFirst(result.tree, SyntaxKind.Missing)!;
  assertEquals(result.tree.starts[missing], result.tree.ends[missing]);
  assertEquals(hasProblem(result.tree, result.tree.root), true);
});

Deno.test("an error span covers a token on the same line and ends a line when the token is on a later line", () => {
  const sameLine = parseChecked("const a = foo(1 2)");
  assertEquals(sameLine.diagnostics.map((d) => [d.span.start, d.span.end]), [[
    16,
    17,
  ]]);
  const laterLine = parseChecked("const a = 1 +\nconst b = 2");
  assertEquals(laterLine.diagnostics.map((d) => [d.span.start, d.span.end]), [[
    13,
    13,
  ]]);
});

Deno.test("diagnostic spans carry the source path", () => {
  const result = parse("dir/a.eff", "const a = )");
  assertEquals(result.diagnostics.length > 0, true);
  for (const d of result.diagnostics) assertEquals(d.span.source, "dir/a.eff");
});

Deno.test("parseFromHost reads through the host", () => {
  const host = memoryHost({ "a.eff": "const a = 1\n" });
  const ok = parseFromHost(host, "a.eff");
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.value.diagnostics, []);
  const missing = parseFromHost(host, "b.eff");
  assertEquals(missing, {
    ok: false,
    error: { tag: "not-found", path: "b.eff" },
  });
});

Deno.test("odd inputs parse without throwing, print back exactly, and give a sound tree", () => {
  const inputs = [
    "",
    "\n",
    "\n\n  \n",
    ";",
    "((((",
    "))))",
    "{{{{",
    "}}}}",
    "[[[[",
    "const",
    "export",
    "export export",
    "import",
    "import {",
    "type",
    "type T",
    "type T =",
    "error E = ",
    "service S {",
    "service S { f(",
    "provider",
    '"',
    '"\\',
    "/*",
    "//",
    "match",
    "match x {",
    "if",
    "if (",
    "if (a) {",
    "try {",
    "try { } catch {",
    "const f = (",
    "const f = (a",
    "const f = (a) =>",
    "const f = a |>",
    "const f = a ||",
    "const f = { ...",
    "const f = { a:",
    "@@@ ### 'x'",
    "\u{1F600}",
    "a b c d",
    "=> => =>",
    "|> |> |>",
    "const a = 1 const b = 2",
    "const a = 1\n\n\n\nconst b",
  ];
  for (const text of inputs) {
    const result = parseChecked(text);
    if (text.trim() !== "" && text !== ";" && text !== "//" && text !== "/*") {
      // Every non-trivial odd input is wrong, so the parser must say so.
      assertEquals(result.diagnostics.length > 0, true, JSON.stringify(text));
    }
  }
});

Deno.test("children of a node are contiguous and in source order", () => {
  const tree = parseClean("const a = f(1, { b: 2 })\ntype T = { x: int }");
  walk(tree, tree.root, (node) => {
    let cursor = tree.starts[node];
    for (const child of childrenOf(tree, node)) {
      assertEquals(
        tree.starts[child] >= cursor ||
          kindOf(tree, child) === SyntaxKind.Missing,
        true,
      );
      cursor = Math.max(cursor, tree.ends[child]);
    }
  });
});

Deno.test("nesting up to 100 levels parses; deeper input is reported and never overflows the stack", () => {
  parseClean("const a = " + "(".repeat(100) + "1" + ")".repeat(100));
  parseClean("type T = " + "Option<".repeat(100) + "int" + ">".repeat(100));
  for (
    const open of ["(", "f(", "() => {", "-", "if (a) { 1 } else ", "Option<"]
  ) {
    const prefix = open === "Option<" ? "type T = " : "const a = ";
    const result = parseChecked(prefix + open.repeat(50000));
    assertEquals(
      result.diagnostics.some((d) => d.message.includes("nesting is too deep")),
      true,
      open,
    );
  }
  // These openers cannot nest, so they only need to survive.
  for (
    const text of ["const a = [", "const a = {", "type T = {", "type T = ["]
  ) {
    parseChecked(text.repeat(50000));
  }
});

Deno.test("too deep a nesting does not hide the later declarations", () => {
  const text = "const x = " + "(".repeat(300) + "1" + ")".repeat(300) + "\n" +
    "const y = )\n" +
    "const z = 1\n";
  const result = parseChecked(text);
  assertEquals(
    result.diagnostics.map((d) => [d.code, d.span.start]),
    [["syntax/009", 266], ["syntax/008", text.indexOf("const y = )") + 10]],
  );
});

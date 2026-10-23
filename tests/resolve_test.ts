// Tests for name resolution.

import { assert, assertEquals } from "@std/assert";
import { type Analysis, analyzeProject } from "../src/core/analyze.ts";
import { memoryHost } from "../src/core/source.ts";
import {
  kindOf,
  type NodeId,
  nodeText,
  SyntaxKind,
  walk,
} from "../src/core/syntax.ts";
import { type Target, targetText } from "../src/core/resolve.ts";
import { diskHost, listEffFiles } from "./helpers.ts";

function analyzeDisk(root: string, entries: readonly string[]): Analysis {
  const result = analyzeProject(diskHost(), root, entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

const examples = analyzeDisk("examples", listEffFiles("examples"));

function analyzeText(
  files: Record<string, string>,
  entry = "m.eff",
): Analysis {
  const result = analyzeProject(
    memoryHost({ "effective.json": "{}", ...files }),
    "",
    [entry],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function single(text: string): Analysis {
  return analyzeText({ "m.eff": text });
}

/** Every node of `kind` whose text equals `text`, in source order. */
function nodesWithText(
  analysis: Analysis,
  module: string,
  kind: SyntaxKind,
  text: string,
): NodeId[] {
  const tree = analysis.project.modules.get(module)!.tree;
  const found: NodeId[] = [];
  walk(tree, tree.root, (n) => {
    if (kindOf(tree, n) === kind && nodeText(tree, n) === text) found.push(n);
  });
  return found;
}

function targetsOf(
  analysis: Analysis,
  module: string,
  kind: SyntaxKind,
  text: string,
): string[] {
  const table = analysis.resolutions.get(module)!.targets;
  return nodesWithText(analysis, module, kind, text).map((n) => {
    const target: Target | undefined = table.get(n);
    return target === undefined ? "none" : targetText(target);
  });
}

function messages(analysis: Analysis): string[] {
  return analysis.diagnostics.map((d) => `${d.code} ${d.message}`);
}

Deno.test("the five examples and the host interface resolve with no diagnostics", () => {
  assertEquals(
    examples.diagnostics.map((d) => `${d.span.source} ${d.code} ${d.message}`),
    [],
  );
  assertEquals(examples.resolutions.size, 6);
  assert(examples.resolutions.has("host/providers"));
});

Deno.test("every name node of the examples has a target and none is unresolved", () => {
  for (const [name, resolution] of examples.resolutions) {
    const tree = examples.project.modules.get(name)!.tree;
    for (const [node, target] of resolution.targets) {
      assert(target.kind !== "unresolved", `${name}: ${nodeText(tree, node)}`);
      const kind = kindOf(tree, node);
      assert(
        kind === SyntaxKind.Name || kind === SyntaxKind.NameExpr ||
          kind === SyntaxKind.QualifiedName || kind === SyntaxKind.FieldExpr,
        `${name}: unexpected node kind ${kind}`,
      );
    }
    // Every NameExpr is in the table.
    walk(tree, tree.root, (n) => {
      if (kindOf(tree, n) === SyntaxKind.NameExpr) {
        assert(resolution.targets.has(n), `${name}: ${nodeText(tree, n)}`);
      }
    });
  }
});

Deno.test("Users.find in users.eff resolves to the capability", () => {
  assertEquals(
    targetsOf(examples, "users", SyntaxKind.FieldExpr, "Users.find"),
    ["cap:users#Users.find"],
  );
  // The three uses clauses of getUser, rename, and displayName.
  assertEquals(
    targetsOf(examples, "users", SyntaxKind.QualifiedName, "Users.find"),
    Array(3).fill("cap:users#Users.find"),
  );
});

Deno.test("uses Orders in pay.eff resolves to the service", () => {
  assertEquals(
    targetsOf(examples, "pay", SyntaxKind.QualifiedName, "Orders"),
    ["service:pay#Orders"],
  );
  assertEquals(
    targetsOf(examples, "pay", SyntaxKind.QualifiedName, "Payments.charge")
      .length,
    2,
  );
});

Deno.test("displayName in main.eff resolves to the imported value", () => {
  assertEquals(
    targetsOf(examples, "main", SyntaxKind.NameExpr, "displayName"),
    ["value:users#displayName"],
  );
  assertEquals(
    targetsOf(examples, "main", SyntaxKind.Name, "displayName"),
    ["value:users#displayName"],
  );
});

Deno.test("UsersLive in main.eff resolves to the provider of the host interface", () => {
  assertEquals(
    targetsOf(examples, "main", SyntaxKind.NameExpr, "UsersLive"),
    ["value:host/providers#UsersLive"],
  );
  const providers = examples.resolutions.get("main")!.namespace.get(
    "UsersLive",
  )!;
  assertEquals(providers.target.kind, "provider");
});

Deno.test("the interface file resolves Users to the service of users.eff", () => {
  assertEquals(
    targetsOf(examples, "host/providers", SyntaxKind.QualifiedName, "Users"),
    ["service:users#Users"],
  );
});

Deno.test("the pipeline stages filter, map, and fold resolve to the prelude", () => {
  assertEquals(
    targetsOf(examples, "collections", SyntaxKind.Name, "filter"),
    ["prelude:filter"],
  );
  assertEquals(
    targetsOf(examples, "collections", SyntaxKind.QualifiedName, "map"),
    ["prelude:map"],
  );
  assertEquals(
    targetsOf(examples, "collections", SyntaxKind.QualifiedName, "fold"),
    ["prelude:fold"],
  );
});

Deno.test("pipeline stages in pay.eff resolve to module functions", () => {
  assertEquals(
    targetsOf(examples, "pay", SyntaxKind.QualifiedName, "findOrder"),
    ["value:pay#findOrder"],
  );
  assertEquals(
    targetsOf(examples, "pay", SyntaxKind.QualifiedName, "saveOrder"),
    ["value:pay#saveOrder"],
  );
});

Deno.test("local identities follow the function namespace of the plan", () => {
  assertEquals(targetsOf(examples, "users", SyntaxKind.NameExpr, "id"), [
    "local:users#getUser/id",
    "local:users#rename/id",
    "local:users#displayName/id",
  ]);
  const users = targetsOf(examples, "users", SyntaxKind.Name, "user");
  assert(users.includes("local:users#getUser/user"));
  assert(users.includes("local:users#rename/user"));
  assertEquals(
    targetsOf(examples, "users", SyntaxKind.Name, "renamed"),
    ["local:users#rename/renamed"],
  );
  assertEquals(
    targetsOf(examples, "users", SyntaxKind.Name, "error"),
    ["local:users#displayName/error"],
  );
});

Deno.test("arrow parameters in pipeline stages are locals of the enclosing function", () => {
  assertEquals(targetsOf(examples, "collections", SyntaxKind.Name, "user"), [
    "local:collections#activeNames/user",
    "local:collections#activeNames/user/2",
  ]);
  assertEquals(
    targetsOf(examples, "collections", SyntaxKind.NameExpr, "user"),
    [
      "local:collections#activeNames/user",
      "local:collections#activeNames/user/2",
    ],
  );
  assertEquals(
    targetsOf(examples, "collections", SyntaxKind.NameExpr, "sum"),
    ["local:collections#total/sum"],
  );
});

Deno.test("log.eff under the root fixtures/ir has the module name example/log", () => {
  const analysis = analyzeDisk("ir", ["example/log.eff"]);
  assertEquals(analysis.diagnostics, []);
  assertEquals(
    targetsOf(analysis, "example/log", SyntaxKind.NameExpr, "message"),
    ["local:example/log#log/message"],
  );
  assertEquals(
    targetsOf(analysis, "example/log", SyntaxKind.FieldExpr, "Console.print"),
    ["cap:example/log#Console.print"],
  );
  assertEquals(
    targetsOf(analysis, "example/log", SyntaxKind.Name, "ConsoleUnavailable"),
    Array(3).fill("error:example/log#ConsoleUnavailable"),
  );
});

Deno.test("the topological order of the examples puts users before main", () => {
  const order = examples.project.order;
  assert(order.indexOf("users") < order.indexOf("main"));
  assertEquals([...examples.resolutions.keys()], [...order]);
});

Deno.test("repeated local names in one function get /2 and /3 in source order", () => {
  const text = [
    "const f = (x: int): int => {",
    "  const g = (x: int): int => {",
    "    const h = (x: int): int => x",
    "    h(x)",
    "  }",
    "  g(x)",
    "}",
    "",
  ].join("\n");
  const analysis = single(text);
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "x"), [
    "local:m#f/x",
    "local:m#f/x/2",
    "local:m#f/x/3",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "x"), [
    "local:m#f/x/3",
    "local:m#f/x/2",
    "local:m#f/x",
  ]);
});

Deno.test("locals in a module-level non-function const use the const name", () => {
  const ok = single(
    "const k: int = ((v: int): int => v)(3)\n",
  );
  assertEquals(messages(ok), []);
  assertEquals(targetsOf(ok, "m", SyntaxKind.Name, "v"), ["local:m#k/v"]);
});

Deno.test("module-level names are visible before their declaration", () => {
  const analysis = single(
    "const a = (): int => b()\nconst b = (): int => c\nconst c: int = 1\n",
  );
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "b"), [
    "value:m#b",
  ]);
});

Deno.test("a block const is visible after its declaration and an arrow const sees itself", () => {
  const analysis = single([
    "const f = (n: int): int => {",
    "  const loop = (k: int): int => loop(k)",
    "  const two = 2",
    "  loop(two)",
    "}",
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "loop"), [
    "local:m#f/loop",
    "local:m#f/loop",
  ]);
});

Deno.test("a block const is not visible in its own non-arrow initializer", () => {
  const analysis = single("const f = (): int => {\n  const x = x\n  x\n}\n");
  assertEquals(analysis.diagnostics.map((d) => d.code), ["unknown-name/001"]);
});

Deno.test("nested shadowing is allowed", () => {
  const analysis = single([
    "const f = (x: int): int => {",
    "  const g = (x: int): int => x",
    "  g(x)",
    "}",
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
});

Deno.test("match arms bind Some, error, and spread names", () => {
  const analysis = single([
    "error E = { id: string }",
    'type Shape = { kind: "c", r: int } | { kind: "s", w: int }',
    "const a = (o: Option<int>): int => match o { Some(v) => v, None => 0 }",
    'const b = (s: Shape): int => match s { { kind: "c", ...c } => c.r, { kind: "s" } => 1 }',
    'const c = (): string => try { "x" } catch { E(e) => e.id }',
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "v"), [
    "local:m#a/v",
  ]);
  assertEquals(
    targetsOf(analysis, "m", SyntaxKind.Name, "c")[0],
    "local:m#b/c",
  );
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "c"), [
    "local:m#b/c",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "e"), [
    "local:m#c/e",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "Some"), [
    "prelude:Some",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "None"), [
    "prelude:None",
  ]);
});

Deno.test("an error name and a brand name resolve as constructors when called", () => {
  const analysis = single([
    "nominal Id = string",
    "error E = { id: Id }",
    "const f = (s: string): E => E({ id: Id(s) })",
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "E"), [
    "error:m#E",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "Id"), [
    "type:m#Id",
  ]);
});

Deno.test("a field access on a local stays a field access", () => {
  const analysis = single(
    "const f = (u: { name: string }): string => u.name\n",
  );
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.FieldExpr, "u.name"), [
    "none",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "name"), [
    "field:name",
    "field:name",
  ]);
});

Deno.test("a local named like a service makes a dotted call a field access", () => {
  const analysis = single([
    "service S { m(): int }",
    "const f = (S: { m: int }): int => S.m",
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.NameExpr, "S"), [
    "local:m#f/S",
  ]);
});

Deno.test("a shorthand field refers to the variable of that name", () => {
  const analysis = single(
    "const f = (id: string): { id: string } => ({ id })\n",
  );
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "id"), [
    "local:m#f/id",
    "field:id",
    "local:m#f/id",
  ]);
});

Deno.test("types resolve to declarations and builtin type names", () => {
  const analysis = single([
    "nominal Id = string",
    "type U = { id: Id, n?: Option<int>, tags: string[], k: void }",
    "",
  ].join("\n"));
  assertEquals(messages(analysis), []);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "Id"), [
    "type:m#Id",
    "type:m#Id",
  ]);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "Option"), [
    "builtin-type:Option",
  ]);
});

Deno.test("Brand is an unknown type name", () => {
  const analysis = single("type Id = Brand<string>\n");
  assertEquals(messages(analysis).length, 1);
  assertEquals(targetsOf(analysis, "m", SyntaxKind.Name, "Brand"), [
    "unresolved:Brand",
  ]);
});

Deno.test("imports bind named exports of the imported module", () => {
  const analysis = analyzeText({
    "m.eff":
      'import { T, E, S, f, k } from "./lib.eff"\nconst g = (x: T): E => f(x)\nconst h = (): int uses S.get => k\n',
    "lib.eff": [
      "export type T = { a: int }",
      "export error E = { b: string }",
      "export service S { get(): int }",
      'export const f = (x: T): E => E({ b: "" })',
      "export const k: int = 1",
      "",
    ].join("\n"),
  });
  assertEquals(messages(analysis), []);
  const namespace = analysis.resolutions.get("m")!.namespace;
  assertEquals(
    ["T", "E", "S", "f", "k"].map((n) => targetText(namespace.get(n)!.target)),
    [
      "type:lib#T",
      "error:lib#E",
      "service:lib#S",
      "value:lib#f",
      "value:lib#k",
    ],
  );
  assertEquals(
    targetsOf(analysis, "m", SyntaxKind.QualifiedName, "S.get"),
    ["cap:lib#S.get"],
  );
});

Deno.test("an import of an unknown or private name is reported once and does not cascade", () => {
  const analysis = analyzeText({
    "m.eff":
      'import { hidden, absent } from "./lib.eff"\nconst g = (): int => hidden() + absent()\n',
    "lib.eff": "const hidden = (): int => 1\n",
  });
  assertEquals(analysis.diagnostics.map((d) => d.code), [
    "unknown-name/002",
    "unknown-name/002",
  ]);
});

Deno.test("a failed import does not cascade into unknown names", () => {
  const analysis = single(
    'import { a } from "./missing.eff"\nconst g = (): int => a()\n',
  );
  assertEquals(analysis.diagnostics.map((d) => d.code), ["module/002"]);
});

Deno.test("an import clashes with a local declaration of the same name", () => {
  const analysis = analyzeText({
    "m.eff": 'import { a } from "./lib.eff"\nconst a = (): int => 1\n',
    "lib.eff": "export const a = (): int => 1\n",
  });
  assertEquals(analysis.diagnostics.map((d) => d.code), ["declaration/001"]);
});

Deno.test("a declaration cannot use a prelude name or a builtin type name", () => {
  const analysis = single(
    "const fail = (): int => 1\ntype Option = { a: int }\nerror None = { a: int }\n",
  );
  assertEquals(analysis.diagnostics.map((d) => d.code), [
    "declaration/002",
    "declaration/002",
    "declaration/002",
  ]);
});

Deno.test("a builtin used outside a call is rejected, but None is a value", () => {
  const bad = single("const f = (): int => fail\n");
  assertEquals(bad.diagnostics.map((d) => d.code), ["unknown-name/004"]);
  const ok = single("const f = (): Option<int> => None\n");
  assertEquals(messages(ok), []);
});

Deno.test("provides names whole services only", () => {
  const analysis = analyzeText({
    "effective.json":
      '{"host": {"h": {"interface": "./h.effi", "module": "./h.ts"}}}',
    "m.eff": 'import { P } from "host:h"\nconst x = (): int => 1\n',
    "h.effi":
      'import { S } from "./s.eff"\nexport provider P provides S | S.get\n',
    "s.eff": "export service S { get(): int }\n",
  });
  assertEquals(analysis.diagnostics.map((d) => d.code), ["declaration/003"]);
});

Deno.test("an unknown name inside a broken declaration still resolves the rest", () => {
  const analysis = single(
    "const a = (): int => nope(\nconst b = (): int => 1\n",
  );
  const codes = analysis.diagnostics.map((d) => d.code);
  assert(codes.includes("syntax/008"));
  assert(codes.includes("unknown-name/001"));
});

Deno.test("resolving never throws on a prefix of every example", () => {
  for (const name of listEffFiles("examples")) {
    const text = Deno.readTextFileSync(
      new URL(`../fixtures/examples/${name}`, import.meta.url),
    );
    for (let n = 0; n <= text.length; n += 17) {
      const analysis = analyzeText({ "m.eff": text.slice(0, n) });
      assert(analysis.project.modules.has("m"));
    }
  }
});

Deno.test("locals holds the span of the name that binds a parameter and a block const", () => {
  const text = "const f = (n: int): int => {\n  const total = n\n  total\n}\n";
  const analysis = single(text);
  const locals = analysis.resolutions.get("m")!.locals;
  const param = locals.get("local:m#f/n");
  const block = locals.get("local:m#f/total");
  assert(param !== undefined && block !== undefined);
  assertEquals(param, {
    source: "m.eff",
    start: text.indexOf("n:"),
    end: text.indexOf("n:") + 1,
  });
  assertEquals(block, {
    source: "m.eff",
    start: text.indexOf("total"),
    end: text.indexOf("total") + 5,
  });
  assertEquals(locals.size, 2);
});

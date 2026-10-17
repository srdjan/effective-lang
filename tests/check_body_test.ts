// Tests for part A3b: expression checking, effects, modes, contracts, patterns,
// the initialization graph, and typeAt. Each test runs through the public entry
// `checkProject`.

import { assert, assertEquals } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
  typeAt,
} from "../src/core/check_project.ts";
import {
  buildInterface,
  buildTypeGraph,
  reachableModules,
} from "../src/core/interface.ts";
import type { TypeGraph } from "../src/core/check.ts";
import { solveModeGroup } from "../src/core/modes.ts";
import type { Execution, ValueId } from "../src/core/ir.ts";
import { memoryHost } from "../src/core/source.ts";
import { kindOf, type NodeId, SyntaxKind } from "../src/core/syntax.ts";
import type { NodeFact } from "../src/core/tables.ts";
import {
  diskHost,
  EXAMPLE_ENTRIES,
  EXAMPLE_MODES,
  exampleFiles,
} from "./helpers.ts";

function checkFiles(
  files: Record<string, string>,
  entries: readonly string[],
): CheckedProject {
  const result = checkProject(memoryHost(files), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** Checks one module `m.eff` with an empty project file. */
function checkText(text: string): CheckedProject {
  return checkFiles({ "effective.json": "{}", "m.eff": text }, ["m.eff"]);
}

function examples(): CheckedProject {
  const result = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function codes(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => d.code);
}

function messages(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => `${d.code} ${d.message}`);
}

function fn(project: CheckedProject, module: string, name: string) {
  const body = project.modules.get(module)?.functions.get(
    `value:${module}#${name}` as ValueId,
  );
  assert(body !== undefined, `${module}#${name}`);
  return body;
}

function shortIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.slice(id.indexOf("#") + 1));
}

/** The facts of a function body in node order. */
function factsOf(
  project: CheckedProject,
  module: string,
  name: string,
): NodeFact[] {
  const table = fn(project, module, name).table;
  return [...table.facts.entries()].sort((a, b) => a[0] - b[0]).map((e) =>
    e[1]
  );
}

function nodesOfKind(
  project: CheckedProject,
  module: string,
  kind: SyntaxKind,
): NodeId[] {
  const tree = project.modules.get(module)!.tree;
  const result: NodeId[] = [];
  for (let n = 0; n < tree.count; n++) {
    if (kindOf(tree, n) === kind) result.push(n);
  }
  return result;
}

// ------------------------------------------------------------------ the examples

Deno.test("the five examples check with no diagnostics", () => {
  const project = examples();
  assertEquals(messages(project), []);
});

Deno.test("the computed modes equal the modes that the plan names", () => {
  const project = examples();
  const computed = new Map<ValueId, Execution>();
  for (const module of project.modules.values()) {
    for (const [id, mode] of module.modes) computed.set(id, mode);
  }
  assertEquals(
    [...computed].sort(),
    [...EXAMPLE_MODES].sort(),
  );
});

Deno.test("every example module has an interface with a hash", () => {
  const project = examples();
  for (const module of project.modules.values()) {
    assert(module.interface.ok, module.module);
    assertEquals(module.hash?.length, 16);
  }
});

Deno.test("the interface built from computed modes equals the interface from the plan's modes", () => {
  const project = examples();
  for (const module of project.modules.values()) {
    const imported = new Map<string, TypeGraph>();
    for (const other of reachableModules(project.analysis, module.module)) {
      const found = project.modules.get(other);
      if (found !== undefined) {
        imported.set(other, buildTypeGraph(found.declarations));
      }
    }
    const rebuilt = buildInterface(
      module.declarations,
      EXAMPLE_MODES,
      imported,
    );
    assert(rebuilt.ok && module.interface.ok);
    assertEquals(rebuilt.value.hash, module.interface.value.hash);
  }
});

Deno.test("rename fails with UserMissing and StoreUnavailable and needs Users.find and Users.save", () => {
  const rename = fn(examples(), "users", "rename");
  assertEquals(shortIds(rename.body!.failures), [
    "StoreUnavailable",
    "UserMissing",
  ]);
  assertEquals(shortIds(rename.body!.requirements), [
    "Users.find",
    "Users.save",
  ]);
  assertEquals(rename.mode, "effect");
});

Deno.test("displayName handles UserMissing and fails only with StoreUnavailable", () => {
  const display = fn(examples(), "users", "displayName");
  assertEquals(shortIds(display.body!.failures), ["StoreUnavailable"]);
  assertEquals(shortIds(display.body!.requirements), ["Users.find"]);
});

Deno.test("main has no requirements left after provide", () => {
  const main = fn(examples(), "main", "main");
  assertEquals(main.body!.requirements, []);
  assertEquals(shortIds(main.body!.failures), ["StoreUnavailable"]);
  assertEquals(main.mode, "effect");
});

Deno.test("markPaid is pure and keeps the Order type", () => {
  const project = examples();
  const markPaid = fn(project, "pay", "markPaid");
  assertEquals(markPaid.mode, "pure");
  assertEquals(markPaid.body!.mode, "pure");
  assertEquals(project.table.show(markPaid.result), "Order");
});

Deno.test("total returns int and is pure", () => {
  const project = examples();
  const total = fn(project, "collections", "total");
  assertEquals(project.table.show(total.result), "int");
  assertEquals(total.mode, "pure");
});

Deno.test("a pipeline stage records the closed builtin specialization", () => {
  const project = examples();
  const activeNames = fn(project, "collections", "activeNames");
  const builtins = factsOf(project, "collections", "activeNames").filter((
    f,
  ) => f.kind === "builtin");
  assertEquals(builtins.map((f) => f.kind === "builtin" ? f.name : ""), [
    "filter",
    "map",
  ]);
  const filter = builtins[0];
  assert(filter.kind === "builtin");
  assertEquals(
    project.table.show(filter.specialized),
    "(User[], (User) => boolean) => User[]",
  );
  assertEquals(filter.ir.execution, "pure");
  assertEquals(filter.ir.parameters.length, 2);
  assertEquals(activeNames.mode, "pure");
  const map = builtins[1];
  assert(map.kind === "builtin");
  assertEquals(
    project.table.show(map.specialized),
    "(User[], (User) => string) => string[]",
  );
  const fold = factsOf(project, "collections", "total").find((f) =>
    f.kind === "builtin"
  );
  assert(fold !== undefined && fold.kind === "builtin");
  assertEquals(
    project.table.show(fold.specialized),
    "(int[], int, (int, int) => int) => int",
  );
});

Deno.test("call facts tell performs, constructions, fail, and retry apart", () => {
  const project = examples();
  const kinds = (module: string, name: string) =>
    factsOf(project, module, name).map((f) => f.kind);
  assertEquals(kinds("log", "log"), ["perform"]);
  assertEquals(kinds("users", "getUser").filter((k) => k !== "pattern"), [
    "perform",
    "error-construction",
    "fail",
  ]);
  assert(kinds("pay", "chargeOrder").includes("retry"));
  const retry = factsOf(project, "pay", "chargeOrder").find((f) =>
    f.kind === "retry"
  );
  assert(retry !== undefined && retry.kind === "retry");
  assertEquals(retry.times, 2);
  const provide = factsOf(project, "main", "main").find((f) =>
    f.kind === "provide"
  );
  assert(provide !== undefined && provide.kind === "provide");
  assertEquals(provide.provider, "value:host/providers#UsersLive");
  const perform = factsOf(project, "log", "log")[0];
  assert(perform.kind === "perform");
  assertEquals(perform.capability, "cap:log#Console.print");
});

Deno.test("pattern facts name the pattern kind and the binding", () => {
  const project = examples();
  const patterns = factsOf(project, "users", "getUser").filter((f) =>
    f.kind === "pattern"
  );
  assertEquals(patterns.length, 2);
  const some = patterns[0];
  assert(some.kind === "pattern" && some.pattern.kind === "some");
  assertEquals(some.pattern.binding, "local:users#getUser/user");
  const none = patterns[1];
  assert(none.kind === "pattern" && none.pattern.kind === "none");
  const handler = factsOf(project, "users", "displayName").find((f) =>
    f.kind === "handler"
  );
  assert(handler !== undefined && handler.kind === "handler");
  assertEquals(handler.error, "error:users#UserMissing");
  assertEquals(handler.binding, "local:users#displayName/error");
});

Deno.test("field reads and block bindings are recorded", () => {
  const project = examples();
  const fields = factsOf(project, "pay", "chargeOrder").filter((f) =>
    f.kind === "field"
  );
  assertEquals(fields.length, 1);
  assert(fields[0].kind === "field");
  assertEquals(fields[0].name, "totalCents");
  assertEquals(fields[0].optional, false);
  const bindings = factsOf(project, "users", "rename").filter((f) =>
    f.kind === "binding"
  );
  assertEquals(bindings.length, 2);
});

// ------------------------------------------------------------------ typeAt

Deno.test("typeAt on a function name prints its signature", () => {
  const project = examples();
  const text = project.modules.get("users")!.tree.text;
  const at = text.indexOf("rename") + 2;
  assertEquals(
    typeAt(project, "users.eff", at),
    "rename(id, name): User fails StoreUnavailable | UserMissing uses Users.find | Users.save",
  );
  const getUser = text.indexOf("getUser") + 1;
  assertEquals(
    typeAt(project, "users.eff", getUser),
    "getUser(id): User fails StoreUnavailable | UserMissing uses Users.find",
  );
});

Deno.test("typeAt on an expression prints the type and the sets of the innermost node", () => {
  const project = examples();
  const text = project.modules.get("users")!.tree.text;
  // The `user` in `const user = getUser(id)` of rename.
  const call = text.indexOf("getUser(id)\n  const renamed");
  assertEquals(
    typeAt(project, "users.eff", call + 9),
    "string",
  );
  assertEquals(
    typeAt(project, "users.eff", call + 2),
    "(string) => User fails StoreUnavailable | UserMissing uses Users.find",
  );
  assertEquals(typeAt(project, "users.eff", 0), undefined);
  assertEquals(typeAt(project, "nowhere.eff", 0), undefined);
});

// ------------------------------------------------------------------ contracts

const USERS_BROKEN = `${exampleFiles()["users.eff"]}
export const broken = (id: string): User
  uses Users.find => getUser(id)
`;

Deno.test("the invalid example of the spec gives exactly one failure-contract diagnostic", () => {
  const files = exampleFiles();
  files["users.eff"] = USERS_BROKEN;
  const project = checkFiles(files, ["users.eff"]);
  assertEquals(codes(project), ["failure-contract/001"]);
  assert(project.diagnostics[0].message.includes("UserMissing"));
  assert(project.diagnostics[0].message.includes("StoreUnavailable"));
});

Deno.test("a body that needs more capabilities than uses lists is a requirement-contract error", () => {
  const project = checkText(`
service S {
  a(): int
  b(): int
}
const f = (): int uses S.a => S.a() + S.b()
`);
  assertEquals(codes(project), ["requirement-contract/001"]);
  assert(project.diagnostics[0].message.includes("S.b"));
});

Deno.test("a declared set may be wider than the body needs", () => {
  const project = checkText(`
error E = { m: string }
service S { a(): int }
const f = (): int fails E uses S.a => 1
const g = (): int fails E uses S.a => f()
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "f").mode, "effect");
  assertEquals(shortIds(fn(project, "m", "g").body!.failures), ["E"]);
});

Deno.test("an inferred arrow takes its sets from the body", () => {
  const project = checkText(`
error E = { m: string }
const f = (n: int): int fails E => fail(E({ m: "x" }))
const g = (n: int): int fails E => {
  const h = (k: int) => f(k)
  h(n)
}
`);
  assertEquals(messages(project), []);
});

Deno.test("an arrow with a result annotation is checked against its closed contract", () => {
  const project = checkText(`
error E = { m: string }
const f = (n: int): int fails E => fail(E({ m: "x" }))
const g = (n: int): int fails E => {
  const h = (k: int): int => f(k)
  h(n)
}
`);
  assertEquals(codes(project), ["failure-contract/001"]);
});

Deno.test("function results with a wider declared type accept narrower bodies", () => {
  const project = checkText(`
const f = (n: int): number => n
const g = (n: int): int | string => n
`);
  assertEquals(messages(project), []);
});

// ------------------------------------------------------------------ callbacks and modes

Deno.test("an effectful callback passed to map is an execution-mode error", () => {
  const project = checkText(`
service S { a(): int }
const f = (xs: int[]): int[] uses S.a => map(xs, (x) => S.a())
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("a parameter of function type is effectful and cannot be a pure callback", () => {
  const project = checkText(`
const f = (xs: int[], g: (x: int) => int): int[] => map(xs, g)
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("a pure module function may be a callback by reference", () => {
  const project = checkText(`
const double = (n: int): int => n * 2
const f = (xs: int[]): int[] => xs |> map(double)
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "double").mode, "pure");
});

Deno.test("an effectful module function cannot be a callback by reference", () => {
  const project = checkText(`
service S { a(): int }
const bump = (n: int): int uses S.a => n + S.a()
const f = (xs: int[]): int[] uses S.a => xs |> map(bump)
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("an effectful module constant initializer is an execution-mode error", () => {
  const project = checkText(`
service S { a(): int }
const x: int = S.a()
`);
  assertEquals(codes(project), ["execution-mode/002"]);
});

Deno.test("a pure function call is allowed in a module constant", () => {
  const project = checkText(`
const double = (n: int): int => n * 2
const x: int = double(21)
`);
  assertEquals(messages(project), []);
});

Deno.test("an imported function keeps the mode from its interface", () => {
  const files = {
    "effective.json": "{}",
    "lib.eff": `
export const double = (n: int): int => n * 2
export const loud = (n: int): int => retry(() => n, { times: 1 })
`,
    "main.eff": `
import { double, loud } from "./lib.eff"
const a = (xs: int[]): int[] => xs |> map(double)
const b = (xs: int[]): int[] => xs |> map(loud)
`,
  };
  const project = checkFiles(files, ["main.eff"]);
  assertEquals(
    project.modules.get("lib")!.modes.get("value:lib#double" as ValueId),
    "pure",
  );
  assertEquals(
    project.modules.get("lib")!.modes.get("value:lib#loud" as ValueId),
    "effect",
  );
  assertEquals(messages(project).length, 1);
  assertEquals(project.diagnostics[0].code, "execution-mode/001");
  assert(project.diagnostics[0].span.source === "main.eff");
});

Deno.test("two mutually recursive functions where one performs an effect both end up effect", () => {
  const project = checkText(`
const ping = (n: int): int => retry(() => pong(n), { times: 1 })
const pong = (n: int): int => if (n === 0) { 0 } else { ping(n - 1) }
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "ping").mode, "effect");
  assertEquals(fn(project, "m", "pong").mode, "effect");
  assertEquals(project.modules.get("m")!.hash?.length, 16);
});

Deno.test("two mutually recursive pure functions stay pure", () => {
  const project = checkText(`
const even = (n: int): boolean => if (n === 0) { true } else { odd(n - 1) }
const odd = (n: int): boolean => if (n === 0) { false } else { even(n - 1) }
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "even").mode, "pure");
  assertEquals(fn(project, "m", "odd").mode, "pure");
});

Deno.test("a self-recursive explicit function is allowed and an unannotated one is not", () => {
  const ok = checkText(`
const sum = (n: int): int => if (n === 0) { 0 } else { n + sum(n - 1) }
`);
  assertEquals(messages(ok), []);
  assertEquals(fn(ok, "m", "sum").mode, "pure");
  const bad = checkText(`
const sum = (n: int) => if (n === 0) { 0 } else { n + sum(n - 1) }
`);
  assertEquals(codes(bad), ["execution-mode/003"]);
});

Deno.test("the mode solver starts pure, converges, and reports a cap hit", () => {
  const a = "value:m#a" as ValueId;
  const b = "value:m#b" as ValueId;
  // b is intrinsically effectful. a is effectful when b is.
  let rounds = 0;
  const solved = solveModeGroup([a, b], (assumed) => {
    rounds++;
    return {
      results: rounds,
      computed: new Map<ValueId, Execution>([
        [a, assumed.get(b) === "effect" ? "effect" : "pure"],
        [b, "effect"],
      ]),
    };
  });
  assertEquals(solved.settled, true);
  assertEquals(solved.modes.get(a), "effect");
  assertEquals(solved.modes.get(b), "effect");
  assertEquals(solved.rounds, 3);
  const capped = solveModeGroup([a, b], (assumed) => ({
    results: 0,
    computed: new Map<ValueId, Execution>([
      [a, assumed.get(b) === "effect" ? "effect" : "pure"],
      [b, "effect"],
    ]),
  }), 2);
  assertEquals(capped.settled, false);
});

Deno.test("held diagnostics of a recursive group appear once", () => {
  const project = checkText(`
const ping = (n: int): int => retry(() => pong(n), { times: 1 })
const pong = (n: int): int => if (n === 0) { "zero" } else { ping(n - 1) }
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

// ------------------------------------------------------------------ initialization

Deno.test("the initialization graph orders constants by their eager dependencies", () => {
  const project = checkText(`
const total: int = double(base)
const double = (n: int): int => n * scale
const scale: int = 2
const base: int = 21
`);
  assertEquals(messages(project), []);
  const graph = project.modules.get("m")!.initialization;
  assertEquals(graph.constants.map((c) => c.slice(8)), [
    "total",
    "scale",
    "base",
  ]);
  assertEquals(
    graph.dependencies.get("value:m#total" as ValueId)?.map((c) => c.slice(8)),
    ["scale", "base"],
  );
  assertEquals(graph.order.map((c) => c.slice(8)), ["scale", "base", "total"]);
  assertEquals(graph.cycles, []);
});

Deno.test("a cycle through a function is a module diagnostic", () => {
  const project = checkText(`
const a: int = f(1)
const f = (n: int): int => n + a
`);
  assertEquals(codes(project), ["module/004"]);
});

Deno.test("a recursive function without a constant in the cycle is no initialization cycle", () => {
  const project = checkText(`
const total: int = down(3)
const down = (n: int): int => if (n === 0) { 0 } else { down(n - 1) }
`);
  assertEquals(messages(project), []);
});

// ------------------------------------------------------------------ types and literals

Deno.test("an integral literal is int and a fraction is number", () => {
  const project = checkText(`
const a = (): int => 3
const b = (): number => 3
const c = (): number => 1.5
const d = (): int => 1.5
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("an expected literal alternative survives in a record update", () => {
  const project = checkText(`
type Order = { id: string, status: "pending" | "paid" }
const paid = (o: Order): Order => ({ ...o, status: "paid" })
const bad = (o: Order): Order => ({ ...o, status: "lost" })
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assert(project.diagnostics[0].message.includes("status"));
});

Deno.test("a literal without an expected type widens to its primitive", () => {
  const project = checkText(`
type Status = "pending" | "paid"
const f = (): Status => {
  const s = "paid"
  s
}
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("branches without an expected type widen and need a common type", () => {
  const project = checkText(`
const f = (flag: boolean) => if (flag) { "a" } else { "b" }
const g = (flag: boolean): string => f(flag)
const h = (flag: boolean) => if (flag) { 1 } else { 2.5 }
const i = (flag: boolean): number => h(flag)
`);
  assertEquals(messages(project), []);
});

Deno.test("never fits every branch", () => {
  const project = checkText(`
error E = { m: string }
const f = (flag: boolean): int fails E =>
  if (flag) { 1 } else { fail(E({ m: "no" })) }
`);
  assertEquals(messages(project), []);
});

Deno.test("arithmetic keeps int, divides to number, and joins strings", () => {
  const project = checkText(`
const a = (x: int, y: int): int => x + y * 2 - 1
const b = (x: int, y: int): number => x / y
const c = (x: int, y: number): number => x + y
const d = (x: string): string => x + "!"
const e = (x: int, y: int): boolean => x < y
const f = (x: int, y: int): int => x / y
const g = (x: int, y: string): int => x + y
`);
  assertEquals(codes(project), ["type-mismatch/003", "type-mismatch/007"]);
});

Deno.test("equality takes compatible primitives, literal unions, and matching brands, and rejects records", () => {
  const project = checkText(`
type Id = Brand<string>
type Other = Brand<string>
type Point = { x: int }
type Status = "a" | "b"
const a = (x: int, y: number): boolean => x === y
const b = (x: Status): boolean => x === "a"
const c = (x: Id, y: Id): boolean => x !== y
const d = (x: Id, y: Other): boolean => x === y
const e = (x: Point, y: Point): boolean => x === y
const f = (x: string, y: int): boolean => x === y
`);
  assertEquals(codes(project), [
    "type-mismatch/007",
    "type-mismatch/007",
    "type-mismatch/007",
  ]);
});

Deno.test("conditions and boolean operators need boolean operands", () => {
  const project = checkText(`
const a = (x: int): int => if (x) { 1 } else { 2 }
const b = (x: boolean, y: boolean): boolean => x && y || x
const c = (x: boolean, y: int): boolean => x && y
`);
  assertEquals(codes(project), ["type-mismatch/007", "type-mismatch/007"]);
});

Deno.test("short-circuit operators union the effects of both operands", () => {
  const project = checkText(`
service S { ok(): boolean }
const f = (x: boolean): boolean uses S.ok => x && S.ok()
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), ["S.ok"]);
});

Deno.test("record construction rejects missing, duplicate, and unknown fields", () => {
  const project = checkText(`
type User = { name: string, nick?: string }
const a = (): User => ({ name: "a" })
const b = (): User => ({ name: "a", nick: "b" })
const c = (): User => ({ nick: "b" })
const d = (): User => ({ name: "a", name: "b" })
const e = (): User => ({ name: "a", age: 3 })
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/005",
    "type-mismatch/005",
  ]);
});

Deno.test("a record without an expected type infers its record type", () => {
  const project = checkText(`
type User = { name: string, age: int }
const a = () => ({ name: "a", age: 3 })
const b = (): User => a()
`);
  assertEquals(messages(project), []);
});

Deno.test("record update checks the base, the field names, and the field types", () => {
  const project = checkText(`
type User = { name: string, age: int }
const a = (u: User): User => ({ ...u, age: 4 })
const b = (u: User): User => ({ ...u, size: 4 })
const c = (u: User): User => ({ ...u, age: "old" })
const d = (n: int): int => ({ ...n, age: 1 })
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/003",
    "type-mismatch/005",
  ]);
});

Deno.test("an optional field reads as Option and a missing field is rejected", () => {
  const project = checkText(`
type Profile = { name: string, nick?: string }
const a = (p: Profile): Option<string> => p.nick
const b = (p: Profile): string => p.nick
const c = (p: Profile): string => p.name
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  const facts = factsOf(project, "m", "a").filter((f) => f.kind === "field");
  assert(facts[0].kind === "field" && facts[0].optional);
});

Deno.test("a field of a named error value reads through the error record", () => {
  const project = checkText(`
error E = { reason: string }
const f = (e: E): string => e.reason
const g = (e: E): string => e.other
`);
  assertEquals(codes(project), ["type-mismatch/006"]);
});

Deno.test("brand construction and unbrand follow the nominal rules", () => {
  const project = checkText(`
type Id = Brand<string>
type Name = string
const a = (s: string): Id => Id(s)
const b = (i: Id): string => unbrand(i)
const c = (n: int): Id => Id(n)
const d = (s: string): string => unbrand(s)
const e = (s: string): Name => Name(s)
const f = (i: Id): string => i
`);
  assertEquals(codes(project), [
    "type-mismatch/003",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/003",
  ]);
  const kinds = factsOf(project, "m", "a").map((f) => f.kind);
  assertEquals(kinds, ["brand-construction"]);
});

Deno.test("Some and None take their type from the expected type", () => {
  const project = checkText(`
type Status = "a" | "b"
const a = (): Option<int> => Some(1)
const b = (): Option<Status> => Some("a")
const c = (): Option<int> => None
const d = (): Option<string> => Some(1)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("fail needs a named error value and has type never", () => {
  const project = checkText(`
error E = { m: string }
const a = (): int fails E => fail(E({ m: "x" }))
const b = (e: E): string fails E => fail(e)
const c = (): int => fail(1)
`);
  assertEquals(codes(project), ["type-mismatch/010"]);
});

Deno.test("error construction needs exactly the error fields", () => {
  const project = checkText(`
error E = { m: string, n: int }
const a = (): E => E({ m: "x", n: 1 })
const b = (): E => E({ m: "x" })
const c = (): E => E(1)
const d = (): E => E({ m: "x", n: 1 }, 2)
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/003",
    "type-mismatch/004",
  ]);
});

Deno.test("calls check the callee once, the argument count, and the argument types", () => {
  const project = checkText(`
const add = (a: int, b: int): int => a + b
const f = (): int => add(1, 2)
const g = (): int => add(1)
const h = (): int => add(1, "2")
const i = (): int => (add)(1, 2)
`);
  assertEquals(codes(project), ["type-mismatch/004", "type-mismatch/003"]);
});

Deno.test("a function-typed parameter can be called and makes the caller effectful", () => {
  const project = checkText(`
const apply = (f: (n: int) => int, x: int): int => f(x)
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "apply").mode, "effect");
});

Deno.test("an inline arrow gets parameter types from the expected function type", () => {
  const project = checkText(`
const apply = (f: (n: int) => int, x: int): int => f(x)
const a = (): int => apply((n) => n + 1, 1)
const b = (): int => apply((n) => "x", 1)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a pipeline evaluates the left value once and passes it first", () => {
  const project = checkText(`
service S { all(): int[] }
const add = (a: int, b: int): int => a + b
const f = (): int => 1 |> add(2)
const g = (): int[] uses S.all => S.all() |> map((n) => n + 1)
const h = (x: int): int => x |> add
`);
  assertEquals(codes(project), ["type-mismatch/004"]);
});

Deno.test("a service stage is a perform with the left value as the first argument", () => {
  const project = checkText(`
service S { put(n: int): void }
const f = (n: int): void uses S.put => n |> S.put
`);
  assertEquals(messages(project), []);
  const kinds = factsOf(project, "m", "f").map((f) => f.kind);
  assertEquals(kinds, ["perform"]);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), ["S.put"]);
});

Deno.test("map, filter, and fold check their arguments", () => {
  const project = checkText(`
const a = (xs: int[]): string[] => xs |> map((n) => "x")
const b = (xs: int[]): int[] => xs |> filter((n) => n)
const c = (xs: int[]): int => xs |> fold(0, (s, n) => s + n)
const d = (xs: int[]): int => xs |> fold(0, (s) => s)
const e = (n: int): int[] => n |> map((x) => x)
const f = (xs: string[]): string => xs |> fold("", (s, x) => s + x)
const g = (xs: int[]): number => xs |> fold(0, (s, n) => s + n)
`);
  assertEquals(codes(project), [
    "type-mismatch/003",
    "type-mismatch/004",
    "type-mismatch/010",
  ]);
});

Deno.test("fold takes the widened type of the initial value when no type is expected", () => {
  const project = checkText(`
const a = (xs: int[]) => xs |> fold(0, (s, n) => s + n)
const b = (xs: int[]): int => a(xs)
`);
  assertEquals(messages(project), []);
});

Deno.test("a builtin used as a plain value is rejected by the resolver, not twice", () => {
  const project = checkText(`
const f = (xs: int[]): int[] => xs |> map
`);
  assertEquals(codes(project), ["type-mismatch/004"]);
});

// ------------------------------------------------------------------ retry and provide

Deno.test("retry needs a zero-argument job and a literal times", () => {
  const project = checkText(`
const job = (): int => 1
const a = (): int => retry(job, { times: 2 })
const b = (): int => retry(job, { times: 1.5 })
const c = (n: int): int => retry(job, { times: n })
const d = (): int => retry(job, { count: 2 })
const e = (): int => retry((n: int) => n, { times: 2 })
const f = (): int => retry(job)
`);
  assertEquals(codes(project), [
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/004",
  ]);
  assertEquals(fn(project, "m", "a").mode, "effect");
});

Deno.test("retry unions the construction sets with the job's invocation sets", () => {
  const project = checkText(`
error E = { m: string }
service S { a(): int fails E }
const f = (): int fails E uses S.a => retry(() => S.a(), { times: 0 })
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.failures), ["E"]);
});

const HOST = {
  "effective.json": JSON.stringify({
    host: {
      providers: { interface: "./host/providers.effi", module: "./live.ts" },
    },
  }),
  "svc.eff": `
export error Down = { m: string }
export service Db {
  read(): int fails Down
  write(n: int): void
}
`,
  "host/providers.effi": `
import { Db, Down } from "../svc.eff"
export provider DbLive provides Db fails Down
`,
};

Deno.test("provide with a host provider has the callback's failures and the acquisition failures", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Db, Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const run = (): int fails Down =>
  provide(DbLive, () => Db.read())
export const bad = (): int fails Down uses Db.read =>
  provide(DbLive, () => Db.read())
`,
  }, ["main.eff"]);
  assertEquals(messages(project), []);
  const run = fn(project, "main", "run");
  assertEquals(run.body!.requirements, []);
  assertEquals(shortIds(run.body!.failures), ["Down"]);
  assertEquals(fn(project, "main", "bad").mode, "effect");
});

Deno.test("provide needs a host provider and a zero-argument job", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Db, Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const a = (n: int): int fails Down => provide(n, () => 1)
export const b = (): int fails Down => provide(DbLive, (n: int) => n)
export const c = (): int fails Down => provide(DbLive)
`,
  }, ["main.eff"]);
  assertEquals(codes(project), [
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/004",
  ]);
});

Deno.test("a provide with empty sets still has effect mode", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const run = (): int fails Down => provide(DbLive, () => 1)
const quiet = (): int => provide(DbLive, () => 1)
`,
  }, ["main.eff"]);
  // quiet fails with Down, which its empty fails clause does not list.
  assertEquals(codes(project), ["failure-contract/001"]);
  assertEquals(fn(project, "main", "quiet").mode, "effect");
});

// ------------------------------------------------------------------ try and catch

Deno.test("catch removes handled tags and unions the handler sets", () => {
  const project = checkText(`
error A = { m: string }
error B = { m: string }
error C = { m: string }
const raise = (): int fails A | B => fail(A({ m: "x" }))
const f = (): int fails C =>
  try { raise() } catch {
    A(a) => 1,
    B(b) => fail(C({ m: b.m }))
  }
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.failures), ["C"]);
});

Deno.test("an unhandled tag continues to the caller", () => {
  const project = checkText(`
error A = { m: string }
error B = { m: string }
const raise = (): int fails A | B => fail(A({ m: "x" }))
const f = (): int fails A =>
  try { raise() } catch {
    A(a) => 1
  }
`);
  assertEquals(codes(project), ["failure-contract/001"]);
  assert(project.diagnostics[0].message.includes("B"));
});

Deno.test("successful and handled paths need a common type", () => {
  const project = checkText(`
error A = { m: string }
const raise = (): int fails A => fail(A({ m: "x" }))
const f = (): int =>
  try { raise() } catch {
    A(a) => "none"
  }
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("handlers evaluate as effect mode even when nothing can fail", () => {
  const project = checkText(`
error A = { m: string }
const f = (): int => try { 1 } catch { A(a) => 2 }
`);
  assertEquals(codes(project), ["failure-contract/002"]);
  assertEquals(fn(project, "m", "f").mode, "effect");
});

// ------------------------------------------------------------------ match

Deno.test("match on an option needs Some and None", () => {
  const project = checkText(`
const a = (o: Option<int>): int => match o { Some(x) => x, None => 0 }
const b = (o: Option<int>): int => match o { Some(x) => x }
const c = (o: Option<int>): int => match o { None => 0, _ => 1 }
const d = (o: Option<int>): int => match o { Some(x) => x, None => 0, _ => 1 }
`);
  assertEquals(codes(project), ["pattern/001", "pattern/002"]);
});

Deno.test("match on literals and booleans needs every value or a wildcard", () => {
  const project = checkText(`
type Color = "red" | "green"
const a = (c: Color): int => match c { "red" => 1, "green" => 2 }
const b = (c: Color): int => match c { "red" => 1 }
const c = (b: boolean): int => match b { true => 1, false => 0 }
const d = (b: boolean): int => match b { true => 1 }
const e = (c: Color): int => match c { "red" => 1, "green" => 2, "blue" => 3 }
const f = (c: Color): int => match c { "red" => 1, "red" => 2, "green" => 3 }
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/001",
    "pattern/003",
    "pattern/002",
  ]);
});

Deno.test("match on a primitive needs a final wildcard", () => {
  const project = checkText(`
const a = (n: int): string => match n { 0 => "zero", _ => "many" }
const b = (n: int): string => match n { 0 => "zero", 1 => "one" }
const c = (s: string): int => match s { "a" => 1, _ => 2 }
const d = (s: string): int => match s { 1 => 1, _ => 2 }
`);
  assertEquals(codes(project), ["pattern/001", "pattern/003"]);
});

Deno.test("match on a tagged record union binds the narrowed record", () => {
  const project = checkText(`
type Shape = { kind: "circle", radius: number } | { kind: "square", side: number }
const extent = (s: Shape): number =>
  match s {
    { kind: "circle", ...c } => c.radius,
    { kind: "square", ...q } => q.side
  }
const missing = (s: Shape): number =>
  match s {
    { kind: "circle", ...c } => c.radius
  }
const wrong = (s: Shape): number =>
  match s {
    { kind: "circle", ...c } => c.side,
    { kind: "square" } => 1
  }
const foreign = (s: Shape): number =>
  match s {
    { kind: "circle" } => 1,
    { kind: "square" } => 2,
    { kind: "hex" } => 3
  }
`);
  assertEquals(codes(project), [
    "pattern/001",
    "type-mismatch/006",
    "pattern/003",
  ]);
  const facts = factsOf(project, "m", "extent").filter((f) =>
    f.kind === "pattern"
  );
  assert(facts[0].kind === "pattern" && facts[0].pattern.kind === "tag");
  assertEquals(facts[0].pattern.field, "kind");
  assertEquals(facts[0].pattern.value, "circle");
  assertEquals(facts[0].pattern.binding, "local:m#extent/c");
});

Deno.test("match on an error union uses error patterns", () => {
  const project = checkText(`
error A = { m: string }
error B = { n: int }
const label = (e: A | B): string =>
  match e {
    A(a) => a.m,
    B(b) => "b"
  }
const partial = (e: A | B): string => match e { A(a) => a.m }
const foreign = (e: A): string => match e { B(b) => "b" }
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/001",
    "pattern/003",
  ]);
});

Deno.test("a match subject evaluates once and its arms union their effects", () => {
  const project = checkText(`
service S {
  find(): Option<int>
  other(): int
}
const f = (): int uses S.find | S.other =>
  match S.find() { Some(x) => x, None => S.other() }
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), [
    "S.find",
    "S.other",
  ]);
});

Deno.test("constructor patterns without a binding are pattern errors", () => {
  const project = checkText(`
error A = { m: string }
const f = (o: Option<int>): int => match o { Some => 1, None => 0 }
const g = (e: A): int => match e { A => 1 }
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/004",
    "pattern/001",
    "pattern/004",
  ]);
});

// ------------------------------------------------------------------ blocks and bindings

Deno.test("a block ending with a binding is void and a block binding checks its annotation", () => {
  const project = checkText(`
const a = (): void => {
  const x = 1
}
const b = (): int => {
  const x: int = "s"
  x
}
const c = (): int => {
  const x = 1
}
const d = (): void => {}
`);
  assertEquals(codes(project), ["type-mismatch/003", "type-mismatch/003"]);
});

Deno.test("a local function can be called and infers its contract", () => {
  const project = checkText(`
const f = (n: int): int => {
  const twice = (k: int) => k * 2
  twice(n)
}
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "f").mode, "pure");
});

Deno.test("a local function cannot call itself", () => {
  const project = checkText(`
const f = (n: int): int => {
  const loop = (k: int): int => loop(k)
  loop(n)
}
`);
  assertEquals(codes(project), ["execution-mode/003"]);
});

Deno.test("creating a closure is pure and invoking it carries the effects", () => {
  const project = checkText(`
service S { a(): int }
const f = (): () => int =>
  () => S.a()
`);
  // The returned function has the default effect execution of an annotation, so
  // the closure with requirements does not fit a type that lists none.
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a closure construction has pure mode and empty sets", () => {
  const project = checkText(`
service S { a(): int }
const f = (): int uses S.a => {
  const g = () => S.a()
  g()
}
`);
  assertEquals(messages(project), []);
  const table = fn(project, "m", "f").table;
  const arrows = nodesOfKind(project, "m", SyntaxKind.ArrowExpr);
  const inner = arrows.map((n) => table.info.get(n)).filter((i) =>
    i !== undefined
  );
  assert(inner.length >= 1);
  assertEquals(inner[0]!.mode, "pure");
  assertEquals(inner[0]!.failures, []);
  assertEquals(inner[0]!.requirements, []);
});

// ------------------------------------------------------------------ recovery

Deno.test("an unknown name gives one unknown-name diagnostic and no cascade", () => {
  const project = checkText(`
const f = (n: int): int => missing(n) + 1
const g = (n: int): string => missing.field
`);
  assertEquals(codes(project), ["unknown-name/001", "unknown-name/001"]);
});

Deno.test("an unknown operand of -, *, or / gives no cascade", () => {
  const project = checkText(`
const a: int = missing - 1
const b: int = missing * 2
const c: int = missing / 2
`);
  assertEquals(codes(project), [
    "unknown-name/001",
    "unknown-name/001",
    "unknown-name/001",
  ]);
});

Deno.test("a declaration with a syntax error does not hide a later declaration", () => {
  const project = checkText(`
const broken = (n: int): int => n +
const fine = (n: int): int => "text"
`);
  assert(codes(project).includes("type-mismatch/003"));
  assert(codes(project).some((c) => c.startsWith("syntax/")));
});

Deno.test("checking never throws on a prefix of every example", () => {
  const files = exampleFiles();
  for (const path of EXAMPLE_ENTRIES) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 60));
    for (let n = 0; n <= text.length; n += step) {
      const edited = { ...files, [path]: text.slice(0, n) };
      const result = checkProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
    }
  }
});

Deno.test("checking never throws when one character of an example is deleted", () => {
  const files = exampleFiles();
  for (const path of EXAMPLE_ENTRIES) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 60));
    for (let i = 0; i < text.length; i += step) {
      const edited = {
        ...files,
        [path]: text.slice(0, i) + text.slice(i + 1),
      };
      const result = checkProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
    }
  }
});

// ------------------------------------------------------------------ interfaces

Deno.test("a body edit that keeps the mode leaves the importing module's interface and the hash unchanged", () => {
  const before = examples().modules.get("users")!.hash;
  const files = exampleFiles();
  files["users.eff"] = files["users.eff"].replace(
    "Some(user) => user,",
    "Some(found) => found,",
  );
  const edited = checkProject(memoryHost(files), "", EXAMPLE_ENTRIES);
  assert(edited.ok);
  assertEquals(codes(edited.value), []);
  assertEquals(edited.value.modules.get("users")!.hash, before);
});

Deno.test("a mode change of an exported function changes the interface hash", () => {
  const base = `
export const f = (n: int): int => n
`;
  const effectful = `
export const f = (n: int): int => retry(() => n, { times: 1 })
`;
  const a = checkFiles({ "effective.json": "{}", "m.eff": base }, ["m.eff"]);
  const b = checkFiles({ "effective.json": "{}", "m.eff": effectful }, [
    "m.eff",
  ]);
  assert(a.modules.get("m")!.hash !== b.modules.get("m")!.hash);
});

Deno.test("a binding annotation with a function type supplies the signature and the mode", () => {
  const project = checkText(`
const inc: (n: int) => int = (n) => n + 1
const bad: (n: int) => int = (n) => "x"
const use = (xs: int[]): int[] => xs |> map(inc)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assertEquals(fn(project, "m", "inc").mode, "pure");
});

Deno.test("a service stage with extra arguments and a brand stage are performs and constructions", () => {
  const project = checkText(`
type Id = Brand<string>
service S { put(a: int, b: int): void }
const f = (n: int): void uses S.put => n |> S.put(2)
const g = (s: string): Id => s |> Id
`);
  assertEquals(messages(project), []);
  assertEquals(factsOf(project, "m", "g").map((x) => x.kind), [
    "brand-construction",
  ]);
});

/** A record type nested `levels` times with the given leaf, as source text. */
function deepRecord(levels: number, leaf: string): string {
  return "{ a: ".repeat(levels) + leaf + " }".repeat(levels);
}

Deno.test("a record type 300 levels deep compares int to number with no diagnostic", () => {
  const project = checkText(`
const f = (x: ${deepRecord(300, "number")}): int => 1
const g = (y: ${deepRecord(300, "int")}): int => f(y)
`);
  assertEquals(messages(project), []);
});

Deno.test("a chain of 5000 aliases gives declaration/012 and no exception", () => {
  const lines = ["const v = (x: A0): int => 1"];
  for (let i = 0; i < 4999; i++) lines.push(`type A${i} = A${i + 1}`);
  lines.push("type A4999 = int");
  const project = checkText(lines.join("\n"));
  assert(codes(project).includes("declaration/012"));
  assert(codes(project).every((code) => code === "declaration/012"));
});

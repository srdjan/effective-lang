// Tests for part A4: lowering checked modules to typed IR and serializing it.
// Each test runs through the public entries `checkProject`, `lowerModule`,
// `lowerProject`, and `serializeModule`.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
} from "../src/core/check_project.ts";
import type { Expr, ModuleIR, Span } from "../src/core/ir.ts";
import { walkExpr } from "../src/core/emit/walk.ts";
import {
  type LowerError,
  lowerModule,
  lowerProject,
} from "../src/core/lower.ts";
import { serializeModule } from "../src/core/serialize.ts";
import { memoryHost } from "../src/core/source.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { diskHost, EXAMPLE_ENTRIES, FIXTURES } from "./helpers.ts";

// ------------------------------------------------------------------ helpers

function examples(): CheckedProject {
  const result = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function exampleText(name: string): string {
  return Deno.readTextFileSync(new URL(`examples/${name}.eff`, FIXTURES));
}

function checkText(text: string): CheckedProject {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function lowered(checked: CheckedProject, module: string): ModuleIR {
  const result = lowerModule(checked, module);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function lowerText(text: string): ModuleIR {
  const checked = checkText(text);
  assertEquals(checked.diagnostics.map((d) => d.code), []);
  return lowered(checked, "m");
}

function failure(checked: CheckedProject, module: string): LowerError {
  const result = lowerModule(checked, module);
  assert(!result.ok, "expected an error value");
  return result.error;
}

function json(ir: ModuleIR): string {
  const text = serializeModule(ir);
  assert(text.ok, JSON.stringify(text));
  return text.value;
}

function textOf(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}

function functionBody(ir: ModuleIR, name: string): Expr {
  for (const declaration of ir.declarations) {
    if (declaration.kind === "function" && declaration.name === name) {
      return declaration.body;
    }
  }
  throw new Error(`no function ${name}`);
}

function bodies(ir: ModuleIR): Expr[] {
  return ir.declarations.flatMap((d) =>
    d.kind === "function" ? [d.body] : d.kind === "constant" ? [d.value] : []
  );
}

/** Every `failures` and `requirements` list in a value is sorted and unique. */
function assertSetsSorted(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSetsSorted(item, `${path}[${i}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "failures" || key === "requirements") && Array.isArray(item)) {
      const expected = [...new Set(item as string[])].sort();
      assertEquals(item, expected, `${path}.${key} is sorted and unique`);
    }
    assertSetsSorted(item, `${path}.${key}`);
  }
}

function preludeExports(ir: ModuleIR): readonly string[] {
  const prelude = ir.imports.find((i) => i.module === "effective:prelude");
  return prelude === undefined ? [] : prelude.exports;
}

// ------------------------------------------------------------------ acceptance check 3

Deno.test("example/log lowers to the IR fixture apart from the source id", () => {
  const checked = checkProject(diskHost(), "ir", ["example/log.eff"]);
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const text = json(lowered(checked.value, "example/log")).replaceAll(
    "example/log.eff",
    "log.lft",
  );
  const fixture = Deno.readTextFileSync(
    new URL("ir/example/log.ir.json", FIXTURES),
  );
  assertEquals(JSON.parse(text), JSON.parse(fixture));
});

// ------------------------------------------------------------------ the examples

Deno.test("the five examples lower, serialize, and keep sorted unique sets", () => {
  const results = lowerProject(examples());
  assertEquals([...results.keys()].sort(), [
    "collections",
    "host/providers",
    "log",
    "main",
    "pay",
    "users",
  ]);
  for (const [name, result] of results) {
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    const text = serializeModule(result.value);
    assert(text.ok, `${name}: ${JSON.stringify(text)}`);
    assertSetsSorted(JSON.parse(text.value));
    assert(text.value.endsWith("}\n"));
    assertEquals(result.value.module, name);
    const extension = name === "host/providers" ? "effi" : "eff";
    assertEquals(result.value.sources, [`${name}.${extension}`]);
  }
});

Deno.test("a module outside the project is not lowered", () => {
  assertEquals(failure(examples(), "nowhere"), {
    tag: "unknown-module",
    module: "nowhere",
  });
});

Deno.test("a host interface lowers its declarations, exports each one, and validates", () => {
  const files = {
    "effective.json":
      '{ "host": { "x": { "interface": "./host.effi", "module": "./adapter.ts" } } }',
    "host.effi": `export opaque type Conn
export type Text = string
error Boom = { message: Text }
export nominal Token = { id: Text }
export service Clock { now(): Text fails Boom }
export provider ClockLive provides Clock fails Boom
`,
    "main.eff": `import { Token, Clock, ClockLive } from "host:x"
export const id = (t: Token): Token => t
`,
  };
  const result = checkProject(memoryHost(files), "", ["main.eff"]);
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics.map((d) => d.code), []);
  const ir = lowered(result.value, "host");
  assertEquals(ir.sources, ["host.effi"]);
  assertEquals(
    ir.declarations.map((d) => `${d.kind} ${d.name}`),
    ["type Conn", "type Text", "error Boom", "type Token", "service Clock"],
  );
  assertEquals(ir.exports, [
    "error:host#Boom",
    "service:host#Clock",
    "type:host#Conn",
    "type:host#Text",
    "type:host#Token",
  ]);
  assertEquals(
    validateModule(ir, new Map([["host.effi", files["host.effi"]]])),
    [],
  );
});

Deno.test("declarations keep source order and exports are sorted ids", () => {
  const ir = lowered(examples(), "users");
  assertEquals(
    ir.declarations.map((d) => `${d.kind} ${d.name}`),
    [
      "type UserId",
      "type Name",
      "type User",
      "error UserMissing",
      "error StoreUnavailable",
      "service Users",
      "function getUser",
      "function rename",
      "function displayName",
      "function activeNames",
    ],
  );
  assertEquals(ir.exports, [...ir.exports].sort());
  assertEquals(ir.exports.length, 10);
});

// ------------------------------------------------------------------ imports

Deno.test("main has one import for users and one for the host module", () => {
  const ir = lowered(examples(), "main");
  assertEquals(ir.imports.map((i) => i.module), ["users", "host:providers"]);
  const [users, host] = ir.imports;
  assertEquals(users.bindings, [
    { name: "displayName", target: "value:users#displayName" },
    { name: "Name", target: "type:users#Name" },
    { name: "StoreUnavailable", target: "error:users#StoreUnavailable" },
  ]);
  assert(users.exports.includes("service:users#Users"));
  assertEquals(users.services.map((s) => s.id), ["service:users#Users"]);
  assertEquals(host.bindings, [
    { name: "UsersLive", target: "value:host/providers#UsersLive" },
  ]);
  assertEquals(host.exports, ["value:host/providers#UsersLive"]);
  assertEquals(host.values.map((v) => v.type.kind), ["provider"]);
});

Deno.test("a module without builtins has no prelude import", () => {
  const ir = lowered(examples(), "pay");
  assertEquals(ir.imports.length, 0);
  assertEquals(lowered(examples(), "log").imports, []);
});

// ------------------------------------------------------------------ pipelines

Deno.test("the activeNames pipeline of users lowers to bindings and calls", () => {
  const source = exampleText("users");
  const ir = lowered(examples(), "users");
  const body = functionBody(ir, "activeNames");
  assertEquals(body.kind, "block");
  if (body.kind !== "block") return;
  assertEquals(body.steps.length, 2);
  const [first, second] = body.steps;
  assert(first.kind === "bind" && second.kind === "bind");
  assertEquals(first.binding.name, "$p1");
  assertEquals(first.binding.id, "local:users#activeNames/$p1");
  assertEquals(second.binding.name, "$p2");
  assertEquals(second.binding.id, "local:users#activeNames/$p2");

  // A generated binding uses the span of the left expression.
  assertEquals(textOf(source, first.binding.span), "Users.all()");
  assertEquals(
    textOf(source, second.binding.span),
    "Users.all()\n    |> filter((user) => user.active)",
  );
  assertEquals(first.value.kind, "perform");
  assertEquals(textOf(source, first.value.span), "Users.all()");

  // Each call keeps the span of its stage.
  assert(second.value.kind === "call");
  assertEquals(
    textOf(source, second.value.span),
    "filter((user) => user.active)",
  );
  assert(body.result.kind === "call");
  assertEquals(textOf(source, body.result.span), "map((user) => user.name)");

  // A reference to a generated binding uses the same span as the binding.
  const [filterInput] = second.value.arguments;
  assert(filterInput.kind === "reference");
  assertEquals(filterInput.target, first.binding.id);
  assertEquals(filterInput.span, first.binding.span);
  const [mapInput] = body.result.arguments;
  assert(mapInput.kind === "reference");
  assertEquals(mapInput.target, second.binding.id);
  assertEquals(mapInput.span, second.binding.span);

  // The callees are builtin ids that the prelude import supplies.
  const exported = preludeExports(ir);
  assertEquals(exported.length, 2);
  for (const call of [second.value, body.result]) {
    assert(call.kind === "call");
    assert(call.callee.kind === "reference");
    assert(call.callee.target.startsWith("value:users#$builtin/"));
    assert(exported.includes(call.callee.target as never));
  }
  const names = [second.value, body.result].map((c) =>
    c.kind === "call" && c.callee.kind === "reference"
      ? c.callee.target.split("/")[1]
      : ""
  );
  assertEquals(names, ["filter", "map"]);

  // Block sets are the union of the steps. The pure builtin calls add none.
  assertEquals(body.execution, "effect");
  assertEquals(body.effects, first.value.effects);
  assertEquals(second.value.execution, "pure");
  assertEquals(second.value.effects, { failures: [], requirements: [] });
  assertEquals(body.result.execution, "pure");
  const prelude = ir.imports.find((i) => i.module === "effective:prelude");
  assertEquals(prelude?.bindings, []);
  assertEquals(
    prelude?.values.map((v) => v.id),
    exported,
  );
  assertEquals(prelude?.types, []);
});

Deno.test("a pure pipeline in collections binds its base value", () => {
  const ir = lowered(examples(), "collections");
  const body = functionBody(ir, "total");
  assert(body.kind === "block");
  assertEquals(body.steps.length, 1);
  const [only] = body.steps;
  assert(only.kind === "bind");
  assertEquals(only.binding.id, "local:collections#total/$p1");
  assertEquals(body.execution, "pure");
});

Deno.test("a pipeline binding skips a $p name that the source uses", () => {
  const ir = lowerText(
    "const add = (a: Int, b: Int): Int => a + b\n" +
      "export const p = (y: Int): Int => {\n" +
      "  const $p1 = 10\n" +
      "  y |> add($p1)\n" +
      "}\n" +
      "type Int = int\n",
  );
  const body = functionBody(ir, "p");
  assert(body.kind === "block");
  const pipeline = body.result;
  assert(pipeline.kind === "block");
  const [first] = pipeline.steps;
  assert(first.kind === "bind");
  assertEquals(first.binding.id, "local:m#p/$p2");
  assertEquals(first.binding.name, "$p2");
});

Deno.test("the pay pipeline numbers its bindings and keeps stage sets", () => {
  const source = exampleText("pay");
  const body = functionBody(lowered(examples(), "pay"), "pay");
  assert(body.kind === "block");
  assertEquals(
    body.steps.map((s) => s.kind === "bind" ? s.binding.name : "?"),
    ["$p1", "$p2", "$p3", "$p4"],
  );
  const calls = [...body.steps.map((s) => s.value), body.result];
  assertEquals(
    calls.map((c) => textOf(source, c.span)),
    [
      "id",
      "findOrder",
      "chargeOrder",
      "markPaid",
      "saveOrder",
    ],
  );
  // `markPaid` is pure although its input came from effectful stages.
  assertEquals(calls[3].execution, "pure");
  assertEquals(calls[1].effects, {
    failures: ["error:pay#OrderNotFound"],
    requirements: ["cap:pay#Orders.find"],
  });
  assertEquals(body.effects.failures, [
    "error:pay#OrderNotFound",
    "error:pay#PaymentDeclined",
  ]);
});

Deno.test("a stage call excludes the effects of its left value", () => {
  const ir = lowerText(`
error Boom = { code: int }
service A {
  num(): Int
  boom(): Boom
}
service B {
  twice(x: Int): Int
}
const id = (x: Int): Int => x
const viaPerform = (): Int uses A.num | B.twice => A.num() |> B.twice
const viaFail = (): Int fails Boom uses A.boom => A.boom() |> fail
const viaCall = (): Int uses A.num => A.num() |> id
type Int = int
`);
  const stage = (name: string) => {
    const body = functionBody(ir, name);
    assert(body.kind === "block");
    return body;
  };
  const perform = stage("viaPerform");
  assertEquals(perform.result.kind, "perform");
  assertEquals(perform.result.effects, {
    failures: [],
    requirements: ["cap:m#B.twice"],
  });
  assertEquals(perform.effects.requirements, ["cap:m#A.num", "cap:m#B.twice"]);
  const fail = stage("viaFail");
  assertEquals(fail.result.kind, "fail");
  assertEquals(fail.result.effects, {
    failures: ["error:m#Boom"],
    requirements: [],
  });
  assertEquals(fail.effects, {
    failures: ["error:m#Boom"],
    requirements: ["cap:m#A.boom"],
  });
  const call = stage("viaCall");
  assertEquals(call.result.kind, "call");
  assertEquals(call.result.execution, "pure");
  assertEquals(call.result.effects, { failures: [], requirements: [] });
  assertEquals(call.execution, "effect");
});

// ------------------------------------------------------------------ builtin identities

const COLLECTIONS = `
type User = { name: string, active: boolean }
const names = (users: User[]): Text[] =>
  users |> map((user) => user.name)
const moreNames = (people: User[]): Text[] =>
  people |> map((p) => p.name)
const flags = (users: User[]): Bool[] =>
  users |> map((user) => user.active)
const total = (xs: Int[]): Int =>
  xs |> fold(0, (sum, x) => sum + x)
type Int = int
type Text = string
type Bool = boolean
`;

Deno.test("equal closed builtin types share one identity", () => {
  const ir = lowerText(COLLECTIONS);
  const exported = preludeExports(ir);
  // Two `map` uses share a type. One more `map` and one `fold` differ.
  assertEquals(exported.length, 3);
  assertEquals(new Set(exported).size, 3);
  const mapIds = exported.filter((id) => id.includes("/map/"));
  assertEquals(mapIds.length, 2);
  for (const id of exported) {
    assert(/^value:m#\$builtin\/(map|fold|filter)\/[0-9a-f]{12}$/.test(id), id);
  }
  const used: string[] = [];
  for (const body of bodies(ir)) {
    walkExpr(body, (e) => {
      if (e.kind === "call" && e.callee.kind === "reference") {
        used.push(e.callee.target);
      }
    });
  }
  assertEquals(used.length, 4);
  assertEquals(new Set(used).size, 3);
});

Deno.test("lowering twice gives identical JSON", () => {
  const first = json(lowerText(COLLECTIONS));
  const second = json(lowerText(COLLECTIONS));
  assertEquals(first, second);
  assertEquals(
    json(lowered(examples(), "users")),
    json(lowered(examples(), "users")),
  );
});

Deno.test("an unrelated edit does not change a builtin identity", () => {
  const edited = `// a comment that moves every offset
const unrelated = (n: Int): Int => n + 1
${COLLECTIONS}
const later = (n: Int): Int => n * 2
`;
  const before = lowerText(COLLECTIONS);
  const after = lowerText(edited);
  assertEquals(preludeExports(after), preludeExports(before));
  assertNotEquals(json(after), json(before));
});

Deno.test("a different element type gives a different identity", () => {
  const ir = lowerText(`
const a = (xs: Int[]): Int[] => xs |> map((x) => x)
const b = (xs: Text[]): Text[] => xs |> map((x) => x)
type Int = int
type Text = string
`);
  assertEquals(preludeExports(ir).length, 2);
});

// ------------------------------------------------------------------ diagnostics

Deno.test("a module with a diagnostic does not lower", () => {
  const checked = checkText(
    `const bad = (x: Int): Text => x\ntype Int = int\ntype Text = string`,
  );
  assert(checked.diagnostics.length > 0);
  assertEquals(failure(checked, "m"), {
    tag: "diagnostics",
    module: "m",
    count: checked.diagnostics.length,
  });
  assertEquals(lowerProject(checked).get("m")?.ok, false);
});

Deno.test("a syntax error blocks lowering", () => {
  const checked = checkText(`type Int = int\nconst bad = (x: Int): Int =>`);
  assert(checked.diagnostics.length > 0);
  assertEquals(failure(checked, "m").tag, "diagnostics");
});

Deno.test("an error built from a non-literal record is a checker error", () => {
  const checked = checkText(`
error Boom = { code: int }
const make = (r: { code: Int }): Boom => Boom(r)
type Int = int
`);
  assertEquals(checked.diagnostics.map((d) => d.code), ["type-mismatch/010"]);
  assertEquals(failure(checked, "m").tag, "diagnostics");
});

// ------------------------------------------------------------------ every node kind

const WIDE = `
nominal Id = string
type Shape = { kind: "circle", r: number } | { kind: "square", side: number }
type Cfg = { name: string, note?: string }
error Boom = { code: int }
error Bust = { reason: string }
const limit = 10
const twice: (x: Int) => Int = (x) => x + x
const area = (s: Shape): Num =>
  match s {
    { kind: "circle", ...c } => c.r * c.r,
    { kind: "square" } => 4
  }
const label = (o: Option<Int>): Text =>
  match o {
    Some(_) => "some",
    None => "none"
  }
const pick = (n: Int): Text =>
  match n { 1 => "one", _ => "many" }
const code = (e: Boom | Bust): Int =>
  match e { Boom(b) => b.code, Bust(x) => 0 }
const wrap = (v: Text): Id => Id(v)
const raw = (i: Id): Text => unbrand(i)
const nothing = (): void => {
  const x = 1
}
const empty = (): void => {}
const note = (c: Cfg): Option<Text> => c.note
const cmp = (a: Int, b: Int): Bool => if (a < b) { true } else { a === b }
const boom = (): Int fails Boom => fail(Boom({ code: 1 }))
const safe = (): Int => try { boom() } catch { Boom(e) => e.code }
const maybe = (): Option<Int> => Some(1)
const none = (): Option<Int> => None
const mk = (): Cfg => ({ name: "a" })
const upd = (c: Cfg): Cfg => ({ ...c, name: "b" })
const local = (n: Int): Int => {
  const add = (m: Int) => n + m
  add(1)
}
type Int = int
type Num = number
type Text = string
type Bool = boolean
`;

Deno.test("every expression kind and pattern kind lowers", () => {
  const wide = lowerText(WIDE);
  const all = [
    wide,
    ...["users", "pay", "main", "log", "collections"].map((m) =>
      lowered(examples(), m)
    ),
  ];
  const kinds = new Set<string>();
  const patterns = new Set<string>();
  for (const ir of all) {
    for (const body of bodies(ir)) {
      walkExpr(body, (e) => {
        kinds.add(e.kind);
        if (e.kind === "match") {
          for (const arm of e.arms) patterns.add(arm.pattern.kind);
        }
      });
    }
  }
  assertEquals(
    [...kinds].sort(),
    [
      "binary",
      "block",
      "call",
      "catch",
      "closure",
      "error",
      "fail",
      "get",
      "if",
      "literal",
      "match",
      "nominal",
      "none",
      "perform",
      "provide",
      "record",
      "reference",
      "retry",
      "some",
      "unbrand",
      "update",
    ],
  );
  assertEquals(
    [...patterns].sort(),
    ["error", "literal", "none", "some", "tag", "wildcard"],
  );
  const text = serializeModule(wide);
  assert(text.ok);
  assertSetsSorted(JSON.parse(text.value));
});

Deno.test("a tag pattern has a binding only when the source names one", () => {
  const wide = lowerText(WIDE);
  const body = functionBody(wide, "area");
  assert(body.kind === "match");
  const [circle, square] = body.arms.map((a) => a.pattern);
  assert(circle.kind === "tag" && square.kind === "tag");
  assertEquals(circle.field, "kind");
  assertEquals(circle.value, "circle");
  assertEquals(circle.binding?.name, "c");
  assertEquals(square.binding, null);
});

Deno.test("a block that ends with a binding or is empty yields unit", () => {
  const wide = lowerText(WIDE);
  for (const name of ["nothing", "empty"]) {
    const body = functionBody(wide, name);
    assert(body.kind === "block");
    assertEquals(body.type, { kind: "primitive", name: "unit" });
    assert(body.result.kind === "literal");
    assertEquals(body.result.value, null);
    assertEquals(body.result.type, { kind: "primitive", name: "unit" });
    assertEquals(body.result.execution, "pure");
  }
  const nothing = functionBody(wide, "nothing");
  assert(nothing.kind === "block");
  assertEquals(nothing.steps.length, 1);
});

Deno.test("a const with an arrow value lowers to a function", () => {
  const wide = lowerText(WIDE);
  const byName = new Map(wide.declarations.map((d) => [d.name, d]));
  const twice = byName.get("twice");
  assert(twice?.kind === "function");
  assertEquals(twice.contract, "explicit");
  assertEquals(twice.parameters.map((p) => p.name), ["x"]);
  assertEquals(twice.type.parameters, [{ kind: "named", id: "type:m#Int" }]);
  assertEquals(byName.get("limit")?.kind, "constant");
  assertEquals(byName.get("local")?.kind, "function");
});

Deno.test("a parenthesized expression lowers to its inner node", () => {
  const source =
    `const mk = (): { name: Text } => ({ name: "a" })\ntype Text = string`;
  const body = functionBody(lowerText(source), "mk");
  assertEquals(body.kind, "record");
  assertEquals(textOf(source, body.span), `{ name: "a" }`);
});

Deno.test("an inferred function uses its inferred type", () => {
  const ir = lowerText(`const inc = (n: Int) => n + 1\ntype Int = int`);
  const inc = ir.declarations[0];
  assert(inc.kind === "function");
  assertEquals(inc.contract, "inferred");
  assertEquals(inc.type.result, { kind: "primitive", name: "int" });
  assertEquals(inc.type.execution, "pure");
});

// ------------------------------------------------------------------ serialization

Deno.test("serialization is canonical JSON with a trailing newline", () => {
  const checked = checkProject(diskHost(), "ir", ["example/log.eff"]);
  assert(checked.ok);
  const text = json(lowered(checked.value, "example/log"));
  assert(
    text.startsWith('{\n  "declarations": [\n    {\n      "definition": {'),
  );
  assert(text.endsWith('  "version": 3\n}\n'));
  assert(text.includes('"imports": []'));
  // Keys are sorted at every level.
  const reparsed = JSON.parse(text);
  assertEquals(Object.keys(reparsed), [
    "declarations",
    "exports",
    "format",
    "imports",
    "module",
    "sources",
    "version",
  ]);
});

Deno.test("serialization rejects an unsorted or repeated effect set", () => {
  const ir = lowered(examples(), "users");
  const getUser = ir.declarations.find((d) => d.name === "getUser");
  assert(getUser?.kind === "function");
  const swapped = {
    ...getUser,
    body: {
      ...getUser.body,
      effects: {
        failures: [...getUser.body.effects.failures].reverse(),
        requirements: getUser.body.effects.requirements,
      },
    },
  };
  const bad: ModuleIR = {
    ...ir,
    declarations: ir.declarations.map((d) => d === getUser ? swapped : d),
  };
  const result = serializeModule(bad);
  assert(!result.ok);
  assertEquals(result.error.tag, "unsorted-set");
  assert(result.error.path.endsWith("body.effects.failures"));

  const repeated: ModuleIR = {
    ...ir,
    declarations: ir.declarations.map((d) =>
      d === getUser
        ? {
          ...getUser,
          type: {
            ...getUser.type,
            effects: {
              failures: getUser.type.effects.failures,
              requirements: ["cap:users#Users.find", "cap:users#Users.find"],
            },
          },
        }
        : d
    ),
  };
  const second = serializeModule(repeated);
  assert(!second.ok);
  assertEquals(second.error.tag, "unsorted-set");
});

Deno.test("serialization rejects a number literal that is not finite", () => {
  const ir = lowerText(`const one = (): Int => 1\ntype Int = int`);
  const one = ir.declarations[0];
  assert(one.kind === "function" && one.body.kind === "literal");
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad: ModuleIR = {
      ...ir,
      declarations: [{ ...one, body: { ...one.body, value } }],
    };
    const result = serializeModule(bad);
    assert(!result.ok);
    assertEquals(result.error.tag, "non-finite-number");
  }
});

Deno.test("stream builtin names retain callback-dependent lowering kinds", () => {
  const cases = [
    ["mapEffect", "(n) => n + 1", "", "map-stream"],
    ["mapEffect", "(n) => Probe.next(n)", "", "map-effect"],
    ["mapEffect", "(n) => n + 1", ", { concurrency: 1 }", "map-effect"],
    ["filterEffectStream", "(n) => n < 3", "", "filter-stream"],
    [
      "filterEffectStream",
      "(n) => Probe.accept(n)",
      "",
      "filter-effect-stream",
    ],
    ["takeWhileEffectStream", "(n) => n < 3", "", "take-while-stream"],
    [
      "takeWhileEffectStream",
      "(n) => Probe.accept(n)",
      "",
      "take-while-effect-stream",
    ],
    ["takeUntilEffectStream", "(n) => n < 3", "", "take-until-stream"],
    [
      "takeUntilEffectStream",
      "(n) => Probe.accept(n)",
      "",
      "take-until-effect-stream",
    ],
    ["dropWhileEffectStream", "(n) => n < 3", "", "drop-while-stream"],
    [
      "dropWhileEffectStream",
      "(n) => Probe.accept(n)",
      "",
      "drop-while-effect-stream",
    ],
  ] as const;
  for (const [name, callback, options, kind] of cases) {
    const text = `type Int = int
type Bool = boolean
service Probe { next(n: Int): Int; accept(n: Int): Bool }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const probe = () => ${name}(source, ${callback}${options})
`;
    const checked = checkText(text);
    assertEquals(checked.diagnostics, [], name);
    const targets = checked.analysis.resolutions.get("m")?.targets;
    assert(targets !== undefined);
    assert(
      [...targets.values()].some((t) =>
        t.kind === "builtin" && t.name === name
      ),
    );
    const ir = lowered(checked, "m");
    assertEquals(
      functionBody(ir, "probe").kind,
      kind,
      `${name}: ${callback}${options}`,
    );
    assertEquals(validateModule(ir, new Map([["m.eff", text]])), []);
  }
});

Deno.test("retry lowers counted and scheduled policies from the same resolved builtin", () => {
  const text = `type Int = int
error Stop = {}
service Jobs { next(): Int fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((e: Stop, attempt: Int): Option<Int> => None)
const counted = () => retry(() => Jobs.next(), { times: 2 })
const scheduled = () => retry(() => Jobs.next(), { schedule: policy })
`;
  const checked = checkText(text);
  assertEquals(checked.diagnostics, []);
  const targets = checked.analysis.resolutions.get("m")?.targets;
  assert(targets !== undefined);
  assertEquals(
    [...targets.values()].filter((t) =>
      t.kind === "builtin" && t.name === "retry"
    ).length,
    2,
  );
  const ir = lowered(checked, "m");
  assertEquals(functionBody(ir, "counted").kind, "retry");
  assertEquals(functionBody(ir, "scheduled").kind, "retry-with-schedule");
  assertEquals(validateModule(ir, new Map([["m.eff", text]])), []);
});

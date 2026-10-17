// Tests for the declaration level of the checker and for module interfaces.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type Analysis, analyzeProject } from "../src/core/analyze.ts";
import {
  checkModuleDeclarations,
  executionOf,
  type FunctionSignature,
  type ModeMap,
  signatureType,
} from "../src/core/check.ts";
import type { Execution, ValueId } from "../src/core/ir.ts";
import {
  buildInterface,
  checkDeclarations,
  type ModuleInterface,
  type ProjectCheck,
} from "../src/core/interface.ts";
import { checkAnalysis } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";
import { stripSpans } from "../src/core/interface.ts";
import { TypeTable } from "../src/core/types.ts";
import {
  diskHost,
  EXAMPLE_ENTRIES,
  EXAMPLE_MODES,
  exampleFiles,
} from "./helpers.ts";

function analyzeFiles(
  files: Record<string, string>,
  entries: readonly string[],
): Analysis {
  const result = analyzeProject(memoryHost(files), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** The modes that the body checker computes for every function of the project. */
function computedModes(analysis: Analysis): ModeMap {
  const modes = new Map<ValueId, Execution>();
  for (const module of checkAnalysis(analysis).modules.values()) {
    for (const [id, mode] of module.modes) modes.set(id, mode);
  }
  return modes;
}

/** Checks the examples with the modes that the body checker computes, unless `modes` is given. */
function checkExamples(
  edit: (files: Record<string, string>) => void = () => {},
  modes?: ModeMap,
): ProjectCheck {
  const files = exampleFiles();
  edit(files);
  const analysis = analyzeFiles(files, EXAMPLE_ENTRIES);
  return checkDeclarations(analysis, modes ?? computedModes(analysis));
}

function checkText(
  text: string,
  modes: ModeMap = new Map(),
): ProjectCheck {
  return checkDeclarations(
    analyzeFiles({ "effective.json": "{}", "m.eff": text }, ["m.eff"]),
    modes,
  );
}

function interfaceOf(project: ProjectCheck, module: string): ModuleInterface {
  const check = project.modules.get(module);
  assert(check !== undefined, `no module ${module}`);
  assert(check.interface.ok, JSON.stringify(check.interface));
  return check.interface.value;
}

function signatureOf(
  project: ProjectCheck,
  module: string,
  id: ValueId,
): FunctionSignature {
  const signature = project.modules.get(module)?.declarations.values.get(id);
  assert(signature !== undefined && signature.kind === "function", id);
  return signature;
}

function names(items: readonly { readonly name: string }[]): string[] {
  return items.map((i) => i.name).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declaration with the given id from the parsed `log.ir.json`. */
function fixtureDeclaration(id: string): Record<string, unknown> {
  const text = Deno.readTextFileSync(
    new URL("../fixtures/ir/example/log.ir.json", import.meta.url),
  );
  const data: unknown = JSON.parse(text);
  assert(isRecord(data) && Array.isArray(data.declarations));
  const found = data.declarations.find((d: unknown) =>
    isRecord(d) && d.id === id
  );
  assert(isRecord(found), id);
  return found;
}

// ------------------------------------------------------------------ the five examples

Deno.test("the five examples have no declaration diagnostics", () => {
  const project = checkExamples();
  assertEquals(project.diagnostics.map((d) => `${d.code} ${d.message}`), []);
  for (const check of project.modules.values()) {
    assert(
      check.interface.ok,
      `${check.module}: ${JSON.stringify(check.interface)}`,
    );
  }
});

Deno.test("the modules are checked in topological order", () => {
  const project = checkExamples();
  const order = [...project.modules.keys()];
  assert(order.indexOf("users") < order.indexOf("host/providers"));
  assert(order.indexOf("host/providers") < order.indexOf("main"));
});

Deno.test("the type of log equals the type in log.ir.json", () => {
  const result = analyzeProject(diskHost(), "ir", ["example/log.eff"]);
  assert(result.ok);
  const modes = new Map<ValueId, Execution>([[
    "value:example/log#log",
    "effect",
  ]]);
  const project = checkDeclarations(result.value, modes);
  assertEquals(project.diagnostics, []);
  const signature = signatureOf(
    project,
    "example/log",
    "value:example/log#log",
  );
  const type = signatureType(
    project.modules.get("example/log")!.declarations.env.table,
    signature,
    modes,
  );
  assert(type.ok);
  const fixture = fixtureDeclaration("value:example/log#log");
  assertEquals(type.value.ir, fixture.type);
  // The same type through the intern table and its conversion back to IR.
  assertEquals(project.table.toIrFunction(type.value.ref), fixture.type);
  assertEquals(signature.contract, "explicit");
  assertEquals(fixture.contract, "explicit");
  const ref =
    (fixture.parameters as readonly { id: string; name: string }[])[0];
  assertEquals(signature.parameters[0].id, ref.id);
  assertEquals(signature.parameters[0].name, ref.name);
});

Deno.test("Console.print has the method type of log.ir.json", () => {
  const result = analyzeProject(diskHost(), "ir", ["example/log.eff"]);
  assert(result.ok);
  const project = checkDeclarations(result.value);
  const declarations = project.modules.get("example/log")!.declarations;
  const service = declarations.services[0];
  const fixture = fixtureDeclaration("service:example/log#Console");
  assertEquals<unknown>(stripSpans(service), stripSpans(fixture));
  assertEquals<unknown>(
    stripSpans(declarations.errors[0]),
    stripSpans(fixtureDeclaration("error:example/log#ConsoleUnavailable")),
  );
});

Deno.test("declaration spans equal the spans in log.ir.json apart from the source id", () => {
  const result = analyzeProject(diskHost(), "ir", ["example/log.eff"]);
  assert(result.ok);
  const declarations = checkDeclarations(result.value).modules.get(
    "example/log",
  )!.declarations;
  const offsets = (span: { start: number; end: number }) => [
    span.start,
    span.end,
  ];
  const fixtureSpan = (id: string) => {
    const span = fixtureDeclaration(id).span;
    assert(isRecord(span));
    return offsets({ start: Number(span.start), end: Number(span.end) });
  };
  assertEquals(
    offsets(declarations.errors[0].span),
    fixtureSpan("error:example/log#ConsoleUnavailable"),
  );
  assertEquals(
    offsets(declarations.services[0].span),
    fixtureSpan("service:example/log#Console"),
  );
  assertEquals(
    offsets(
      declarations.values.get("value:example/log#log")!.span,
    ),
    fixtureSpan("value:example/log#log"),
  );
  const method = (fixtureDeclaration("service:example/log#Console")
    .methods as readonly { span: { start: number; end: number } }[])[0];
  assertEquals(
    offsets(declarations.services[0].methods[0].span),
    offsets(method.span),
  );
});

Deno.test("pay requires the sorted capabilities of Orders and Payments.charge", () => {
  const project = checkExamples();
  const pay = signatureOf(project, "pay", "value:pay#pay");
  assertEquals(pay.requirements, [
    "cap:pay#Orders.find",
    "cap:pay#Orders.save",
    "cap:pay#Payments.charge",
  ]);
  assertEquals(pay.failures, [
    "error:pay#OrderNotFound",
    "error:pay#PaymentDeclined",
  ]);
  const type = interfaceOf(project, "pay").payload.values.find((v) =>
    v.id === "value:pay#pay"
  );
  assert(type !== undefined && type.type.kind === "function");
  assertEquals(type.type.execution, "effect");
});

Deno.test("a pure function with empty sets takes its mode from the map", () => {
  const project = checkExamples();
  const markPaid = interfaceOf(project, "pay").payload.values.find((v) =>
    v.id === "value:pay#markPaid"
  );
  // markPaid is private, so it is not an interface value.
  assertEquals(markPaid, undefined);
  const total = interfaceOf(project, "collections").payload.values.find((v) =>
    v.id === "value:collections#total"
  );
  assert(total !== undefined && total.type.kind === "function");
  assertEquals(total.type.execution, "pure");
});

Deno.test("UsersLive has a provider type that provides every Users method", () => {
  const project = checkExamples();
  const value = interfaceOf(project, "host/providers").payload.values[0];
  assertEquals(value.id, "value:host/providers#UsersLive");
  assertEquals(value.type, {
    kind: "provider",
    provides: [
      "cap:users#Users.all",
      "cap:users#Users.find",
      "cap:users#Users.save",
    ],
    acquisition: {
      execution: "effect",
      effects: { failures: [], requirements: [] },
    },
  });
  // The interface carries the supporting declarations of users that the
  // provider reaches (spec: the complete supporting type graph).
  const payload = interfaceOf(project, "host/providers").payload;
  assertEquals(names(payload.services), ["Users"]);
  assertEquals(names(payload.types), ["User", "UserId"]);
  assertEquals(names(payload.errors), ["StoreUnavailable"]);
});

Deno.test("the users interface lists User, UserMissing, StoreUnavailable, and Users", () => {
  const payload = interfaceOf(checkExamples(), "users").payload;
  assertEquals(names(payload.types), ["Name", "User", "UserId"]);
  assertEquals(names(payload.errors), ["StoreUnavailable", "UserMissing"]);
  assertEquals(names(payload.services), ["Users"]);
  assertEquals(payload.exports, [
    "error:users#StoreUnavailable",
    "error:users#UserMissing",
    "service:users#Users",
    "type:users#Name",
    "type:users#User",
    "type:users#UserId",
    "value:users#activeNames",
    "value:users#displayName",
    "value:users#getUser",
    "value:users#rename",
  ]);
  assertEquals(names(payload.values), [
    "activeNames",
    "displayName",
    "getUser",
    "rename",
  ]);
});

Deno.test("a whole service name in uses expands to all its methods", () => {
  const project = checkText(`
service Store {
  get(id: Text): Text
  put(id: Text, value: Text): void
}
export const run = (id: Text): Text uses Store => Store.get(id)
type Text = string
`);
  const run = signatureOf(project, "m", "value:m#run");
  assertEquals(run.requirements, ["cap:m#Store.get", "cap:m#Store.put"]);
});

Deno.test("methods of a service have effect functions with failures and no requirements", () => {
  const project = checkText(`
error Broken = { code: int }
service Store {
  get(id: Text): Text fails Broken
}
type Text = string
`);
  const service = project.modules.get("m")!.declarations.services[0];
  assertEquals(service.methods[0].type, {
    kind: "function",
    execution: "effect",
    parameters: [{ kind: "named", id: "type:m#Text" }],
    result: { kind: "named", id: "type:m#Text" },
    effects: { failures: ["error:m#Broken"], requirements: [] },
  });
});

Deno.test("a function without a result annotation has an inferred contract", () => {
  const project = checkText(
    "const twice = (x: Int) => x + x\ntype Int = int\n",
  );
  const twice = signatureOf(project, "m", "value:m#twice");
  assertEquals(twice.contract, "inferred");
  assertEquals(twice.result, undefined);
  assertEquals(twice.parameters.length, 1);
  assertEquals(project.diagnostics, []);
  const mode = executionOf(twice, new Map());
  assert(!mode.ok && mode.error.tag === "inferred-contract");
});

Deno.test("a binding annotation that is a function type supplies the signature", () => {
  const project = checkText(
    "export const add: (a: Int, b: Int) => Int = (a, b) => a + b\ntype Int = int\n",
    new Map([["value:m#add", "pure"]]),
  );
  assertEquals(project.diagnostics, []);
  const add = signatureOf(project, "m", "value:m#add");
  assertEquals(add.contract, "explicit");
  assertEquals(add.annotation, "binding");
  assertEquals(add.parameters.map((p) => p.name), ["a", "b"]);
  const value = interfaceOf(project, "m").payload.values[0];
  assertEquals(value.type, {
    kind: "function",
    execution: "pure",
    parameters: [
      { kind: "named", id: "type:m#Int" },
      { kind: "named", id: "type:m#Int" },
    ],
    result: { kind: "named", id: "type:m#Int" },
    effects: { failures: [], requirements: [] },
  });
});

Deno.test("an exported constant takes its interface type from the annotation", () => {
  const project = checkText("export const limit: Int = 10\ntype Int = int\n");
  const value = interfaceOf(project, "m").payload.values[0];
  assertEquals(value.type, { kind: "named", id: "type:m#Int" });
});

Deno.test("alias types keep their names, and compatibility unfolds them", () => {
  const project = checkText(`
type Id = string
type Pair = { left: Id, right: string }
`);
  const table = project.table;
  const id = table.named("type:m#Id");
  assert(table.isAssignable(id, table.string));
  assert(table.isAssignable(table.string, id));
  const pair = project.modules.get("m")!.declarations.types[1];
  assertEquals(pair.definition, {
    kind: "alias",
    type: {
      kind: "record",
      fields: [
        {
          name: "left",
          type: { kind: "named", id: "type:m#Id" },
          optional: false,
        },
        {
          name: "right",
          type: { kind: "primitive", name: "string" },
          optional: false,
        },
      ],
    },
  });
});

Deno.test("brands are nominal in the table", () => {
  const project = checkText(`
type A = Brand<string>
type B = Brand<string>
`);
  const table = project.table;
  const a = table.named("type:m#A");
  const b = table.named("type:m#B");
  assert(!table.isAssignable(a, b));
  assert(!table.isAssignable(a, table.string));
  assert(!table.isAssignable(table.string, a));
  const decl = project.modules.get("m")!.declarations.types[0];
  assertEquals(decl.definition, {
    kind: "brand",
    base: { kind: "primitive", name: "string" },
  });
});

Deno.test("declaration diagnostics do not depend on the mode map", () => {
  const files = exampleFiles();
  const analysis = analyzeFiles(files, EXAMPLE_ENTRIES);
  const withModes = checkDeclarations(analysis, EXAMPLE_MODES);
  const without = checkDeclarations(analysis);
  assertEquals(withModes.diagnostics, without.diagnostics);
});

// ------------------------------------------------------------------ modes

Deno.test("a missing mode entry is a Result error that names every function", () => {
  const project = checkExamples(() => {}, new Map());
  const collections = project.modules.get("collections")!.interface;
  assert(!collections.ok);
  assertEquals(collections.error, {
    tag: "missing-modes",
    ids: ["value:collections#activeNames", "value:collections#total"],
  });
  // Functions with nonempty sets need no entry.
  assert(project.modules.get("users")!.interface.ok);
  assert(project.modules.get("log")!.interface.ok);
  const pay = project.modules.get("pay")!.interface;
  assert(!pay.ok);
  assertEquals(pay.error.ids, ["value:pay#markPaid"]);
});

Deno.test("buildInterface can be called again after the modes arrive", () => {
  const project = checkExamples(() => {}, new Map());
  const declarations = project.modules.get("collections")!.declarations;
  assert(!buildInterface(declarations, new Map()).ok);
  const analysis = analyzeFiles(exampleFiles(), EXAMPLE_ENTRIES);
  const built = buildInterface(declarations, computedModes(analysis));
  assert(built.ok);
});

Deno.test("nonempty sets force effect mode whatever the map says", () => {
  const project = checkExamples();
  const getUser = signatureOf(project, "users", "value:users#getUser");
  const forced = executionOf(
    getUser,
    new Map([["value:users#getUser", "pure"]]),
  );
  assert(forced.ok);
  assertEquals(forced.value, "effect");
  const withoutEntry = executionOf(getUser, new Map());
  assert(withoutEntry.ok);
  assertEquals(withoutEntry.value, "effect");
});

Deno.test("an empty-set function without an entry is a Result error", () => {
  const project = checkExamples();
  const total = signatureOf(project, "collections", "value:collections#total");
  const missing = executionOf(total, new Map());
  assert(!missing.ok);
  assertEquals(missing.error, {
    tag: "missing-mode",
    id: "value:collections#total",
  });
  const type = signatureType(new TypeTable(), total, new Map());
  assert(!type.ok);
});

// ------------------------------------------------------------------ hashes

function hashOf(project: ProjectCheck, module: string): string {
  return interfaceOf(project, module).hash;
}

Deno.test("the interface hash is stable and has 16 hex digits", () => {
  const a = hashOf(checkExamples(), "users");
  const b = hashOf(checkExamples(), "users");
  assertEquals(a, b);
  assert(/^[0-9a-f]{16}$/.test(a));
});

Deno.test("a body edit of getUser leaves the users interface hash unchanged", () => {
  const before = checkExamples();
  const after = checkExamples((files) => {
    const text = files["users.eff"];
    const edited = text.replace(
      "None => fail(UserMissing({ id }))",
      "None => fail(UserMissing({ id: id }))",
    );
    assertNotEquals(edited, text);
    files["users.eff"] = edited;
  });
  assertEquals(hashOf(after, "users"), hashOf(before, "users"));
  assertEquals(after.diagnostics, []);
});

Deno.test("a comment above the types moves the spans and leaves the hash unchanged", () => {
  const before = checkExamples();
  const after = checkExamples((files) => {
    files["users.eff"] = "// A comment that moves every declaration.\n" +
      files["users.eff"];
  });
  assertEquals(hashOf(after, "users"), hashOf(before, "users"));
  // The value keeps its spans, so the payload itself differs.
  assertNotEquals(
    interfaceOf(after, "users").payload.types[0].span,
    interfaceOf(before, "users").payload.types[0].span,
  );
});

Deno.test("a header edit that adds a failure changes the users interface hash", () => {
  const before = checkExamples();
  const after = checkExamples((files) => {
    const text = files["users.eff"];
    const edited = text.replace(
      "export const displayName = (id: UserId): Name\n  fails StoreUnavailable",
      "export const displayName = (id: UserId): Name\n  fails StoreUnavailable | UserMissing",
    );
    assertNotEquals(edited, text);
    files["users.eff"] = edited;
  });
  assertNotEquals(hashOf(after, "users"), hashOf(before, "users"));
});

Deno.test("a mode change in the supplied map changes the interface hash", () => {
  const before = checkExamples();
  const changed = new Map(EXAMPLE_MODES);
  changed.set("value:collections#total", "effect");
  const after = checkExamples(() => {}, changed);
  assertNotEquals(
    hashOf(after, "collections"),
    hashOf(before, "collections"),
  );
  // Other modules do not change.
  assertEquals(hashOf(after, "users"), hashOf(before, "users"));
});

Deno.test("an edit of a private function leaves the interface hash unchanged", () => {
  const before = checkExamples();
  const after = checkExamples((files) => {
    files["pay.eff"] = files["pay.eff"].replace(
      "const markPaid = (order: Order): Order =>",
      "const markPaid = (order: Order): Order =>\n  // changed\n",
    );
  });
  assertEquals(hashOf(after, "pay"), hashOf(before, "pay"));
});

Deno.test("a field edit of an exported type changes the hash of its module", () => {
  const before = checkExamples();
  const after = checkExamples((files) => {
    files["users.eff"] = files["users.eff"].replace(
      "  active: boolean\n}",
      "  active: boolean,\n  admin: boolean\n}",
    );
  });
  assertNotEquals(hashOf(after, "users"), hashOf(before, "users"));
});

// ------------------------------------------------------------------ private declarations

Deno.test("a private type that an exported function reaches is in the interface", () => {
  const project = checkText(`
type Secret = { code: int }
type Wrapper = { inner: Secret }
type Unrelated = { value: string }
error Hidden = { reason: string }
service Vault {
  open(w: Wrapper): Text
}
export const run = (w: Wrapper): Text
  fails Hidden
  uses Vault.open => Vault.open(w)
type Text = string
`);
  assertEquals(project.diagnostics, []);
  const payload = interfaceOf(project, "m").payload;
  // Text is the alias that R1 needs for the result; the exported run reaches it.
  assertEquals(names(payload.types), ["Secret", "Text", "Wrapper"]);
  assertEquals(names(payload.errors), ["Hidden"]);
  assertEquals(names(payload.services), ["Vault"]);
  assertEquals(payload.exports, ["value:m#run"]);
});

Deno.test("a private type reached only through a private function stays out", () => {
  const project = checkText(
    `
type Secret = { code: int }
const helper = (s: Secret): Int => 1
export const run = (): Int => 1
type Int = int
`,
    new Map([["value:m#run", "pure"], ["value:m#helper", "pure"]]),
  );
  // Only Int, the alias that the exported run names, is reached; Secret stays out.
  assertEquals(names(interfaceOf(project, "m").payload.types), ["Int"]);
});

Deno.test("a private type reached through a return type appears", () => {
  const project = checkText(
    `
type Secret = { code: int }
export const make = (): Secret[] => []
`,
    new Map([["value:m#make", "pure"]]),
  );
  assertEquals(names(interfaceOf(project, "m").payload.types), ["Secret"]);
});

// ------------------------------------------------------------------ imports

Deno.test("an edit to a private type of an import changes the interface hash of the dependent", () => {
  const files = (code: string) => ({
    "effective.json": "{}",
    "a.eff": `
type Hidden = { code: ${code} }
export type Wrapper = { inner: Hidden }
`,
    "b.eff": `
import { Wrapper } from "./a.eff"
export const show = (wrapper: Wrapper): Int => 1
type Int = int
`,
  });
  const hashOf = (code: string): string => {
    const project = checkDeclarations(
      analyzeFiles(files(code), ["b.eff"]),
      new Map([["value:b#show", "pure"]]),
    );
    assertEquals(project.diagnostics, []);
    return interfaceOf(project, "b").hash;
  };
  assertNotEquals(hashOf("int"), hashOf("string"));
});

Deno.test("imported types resolve through the interface graph, not through syntax", () => {
  const files = {
    "effective.json": "{}",
    "a.eff": `
type Hidden = { code: int }
export type Wrapper = { inner: Hidden }
export type Name = string
`,
    "b.eff": `
import { Name, Wrapper } from "./a.eff"
export const show = (name: Name, wrapper: Wrapper): Name => name
`,
  };
  const analysis = analyzeFiles(files, ["b.eff"]);
  const project = checkDeclarations(
    analysis,
    new Map([["value:b#show", "pure"]]),
  );
  assertEquals(project.diagnostics, []);
  const aGraph = interfaceOf(project, "a").payload;
  assertEquals(names(aGraph.types), ["Hidden", "Name", "Wrapper"]);
  // The interface of b carries the declarations of a that its exports reach,
  // including the private Hidden.
  const bPayload = interfaceOf(project, "b").payload;
  assertEquals(names(bPayload.types), ["Hidden", "Name", "Wrapper"]);
  assertEquals(bPayload.values[0].type, {
    kind: "function",
    execution: "pure",
    parameters: [
      { kind: "named", id: "type:a#Name" },
      { kind: "named", id: "type:a#Wrapper" },
    ],
    result: { kind: "named", id: "type:a#Name" },
    effects: { failures: [], requirements: [] },
  });

  // A fresh table that has never seen module a learns a's definitions from the graph.
  const fresh = new TypeTable();
  const graph = {
    types: aGraph.types,
    errors: aGraph.errors,
    services: aGraph.services,
  };
  checkModuleDeclarations(analysis, "b", fresh, new Map([["a", graph]]));
  assert(fresh.isAssignable(fresh.named("type:a#Name"), fresh.string));
  assert(fresh.isAssignable(fresh.string, fresh.named("type:a#Name")));
  assert(fresh.aliasOf("type:a#Hidden") !== undefined);
  assert(fresh.aliasOf("type:a#Wrapper") !== undefined);
});

Deno.test("a service from another module expands through its interface", () => {
  const files = {
    "effective.json": "{}",
    "a.eff": `
export service Store {
  get(id: Text): Text
  put(id: Text, value: Text): void
}
type Text = string
`,
    "b.eff": `
import { Store } from "./a.eff"
export const copy = (id: Text): Text uses Store => Store.get(id)
type Text = string
`,
  };
  const project = checkDeclarations(analyzeFiles(files, ["b.eff"]));
  assertEquals(project.diagnostics, []);
  assertEquals(signatureOf(project, "b", "value:b#copy").requirements, [
    "cap:a#Store.get",
    "cap:a#Store.put",
  ]);
});

// ------------------------------------------------------------------ robustness

Deno.test("declaration checking never throws on a prefix of every example", () => {
  const files = exampleFiles();
  for (const path of EXAMPLE_ENTRIES) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 60));
    for (let n = 0; n <= text.length; n += step) {
      const edited = { ...files, [path]: text.slice(0, n) };
      const result = analyzeProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
      const project = checkDeclarations(result.value);
      assert(project.modules.size > 0);
    }
  }
});

Deno.test("declaration checking never throws when one character is deleted", () => {
  const files = exampleFiles();
  for (const path of ["users.eff", "pay.eff", "log.eff"]) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 80));
    for (let i = 0; i < text.length; i += step) {
      const edited = {
        ...files,
        [path]: text.slice(0, i) + text.slice(i + 1),
      };
      const result = analyzeProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
      checkDeclarations(result.value);
    }
  }
});

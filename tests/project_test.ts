// Tests for the project file, module identity, the module graph, and cycles.

import { assert, assertEquals } from "@std/assert";
import { memoryHost } from "../src/core/source.ts";
import {
  describeConfigError,
  joinPath,
  loadProject,
  moduleNameOf,
  normalizeRelative,
  parseConfig,
  type Project,
} from "../src/core/project.ts";
import { diskHost, listEffFiles } from "./helpers.ts";

function load(
  files: Record<string, string>,
  entries: readonly string[],
  root = "",
): Project {
  const result = loadProject(memoryHost(files), root, entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function messages(project: Project): string[] {
  return project.diagnostics.map((d) =>
    `${d.span.source} ${d.code} ${d.message}`
  );
}

Deno.test("module names drop the extension and keep the path", () => {
  assertEquals(moduleNameOf("users.eff"), "users");
  assertEquals(moduleNameOf("example/log.eff"), "example/log");
  assertEquals(moduleNameOf("host/providers.effi"), "host/providers");
});

Deno.test("paths normalize against the root", () => {
  assertEquals(normalizeRelative("./a/../b.eff"), "b.eff");
  assertEquals(normalizeRelative("a//b.eff"), "a/b.eff");
  assertEquals(normalizeRelative("../x.eff"), undefined);
  assertEquals(normalizeRelative("/abs.eff"), undefined);
  assertEquals(normalizeRelative(""), undefined);
  assertEquals(joinPath("", "a.eff"), "a.eff");
  assertEquals(joinPath("p/", "a.eff"), "p/a.eff");
});

Deno.test("a missing effective.json is an error value", () => {
  const result = loadProject(memoryHost({}), "proj", []);
  assert(!result.ok);
  assertEquals(result.error, { tag: "missing", path: "proj/effective.json" });
  assertEquals(
    describeConfigError(result.error),
    "proj/effective.json does not exist",
  );
});

Deno.test("a malformed effective.json is an error value", () => {
  const result = parseConfig("{ not json");
  assert(!result.ok);
  assertEquals(result.error.tag, "malformed-json");
});

Deno.test("an effective.json with the wrong shape is an error value", () => {
  for (
    const text of [
      "[]",
      '{"host": 3}',
      '{"host": {"a": 3}}',
      '{"host": {"a": {"interface": 1, "module": "./x.ts"}}}',
      '{"host": {"a": {"interface": "./a.effi"}}}',
    ]
  ) {
    const result = parseConfig(text);
    assert(!result.ok, text);
    assertEquals(result.error.tag, "invalid-shape", text);
  }
});

Deno.test("unknown keys in effective.json are module diagnostics on the key", () => {
  const text = `{
  "extra": 1,
  "host": {
    "p": { "interface": "./p.effi", "module": "./p.ts", "colour": "red" }
  }
}`;
  const result = parseConfig(text);
  assert(result.ok);
  assertEquals(result.value.config.host.get("p"), {
    interfacePath: "p.effi",
    modulePath: "p.ts",
  });
  const found = result.value.diagnostics.map((d) => ({
    code: d.code,
    key: text.slice(d.span.start, d.span.end),
    source: d.span.source,
  }));
  assertEquals(found, [
    { code: "module/001", key: '"extra"', source: "effective.json" },
    { code: "module/001", key: '"colour"', source: "effective.json" },
  ]);
});

Deno.test("a host interface must be an .effi path inside the root", () => {
  const result = parseConfig(
    '{"host": {"a": {"interface": "../a.effi", "module": "./a.ts"}, "b": {"interface": "./b.eff", "module": "./b.ts"}}}',
  );
  assert(result.ok);
  assertEquals(result.value.config.host.size, 0);
  assertEquals(result.value.diagnostics.length, 2);
});

Deno.test("the examples form a graph with users before main", () => {
  const entries = listEffFiles("examples");
  assertEquals(entries, [
    "collections.eff",
    "log.eff",
    "main.eff",
    "pay.eff",
    "users.eff",
  ]);
  const result = loadProject(diskHost(), "examples", entries);
  assert(result.ok);
  const project = result.value;
  assertEquals(messages(project), []);
  assertEquals([...project.modules.keys()].sort(), [
    "collections",
    "host/providers",
    "log",
    "main",
    "pay",
    "users",
  ]);
  const order = project.order;
  assertEquals(order.length, 6);
  assert(order.indexOf("users") < order.indexOf("main"));
  assert(order.indexOf("host/providers") < order.indexOf("main"));
  assert(order.indexOf("users") < order.indexOf("host/providers"));
  assertEquals(project.graph.get("main"), ["host/providers", "users"]);
  assertEquals(project.graph.get("host/providers"), ["users"]);
  assertEquals(project.graph.get("users"), []);
});

Deno.test("the host import links to the interface file and keeps the import string", () => {
  const result = loadProject(diskHost(), "examples", ["main.eff"]);
  assert(result.ok);
  const main = result.value.modules.get("main")!;
  assertEquals(
    main.links.map((l) => [l.target, l.label, l.isHost]),
    [["users", "users", false], ["host/providers", "host:providers", true]],
  );
  assertEquals(result.value.modules.get("host/providers")!.mode, "effi");
  assertEquals(
    result.value.modules.get("host/providers")!.path,
    "host/providers.effi",
  );
});

Deno.test("discovery follows imports from the entry files", () => {
  const project = load({
    "effective.json": "{}",
    "a.eff": 'import { b } from "./sub/b.eff"\nexport const a = (): int => 1\n',
    "sub/b.eff":
      'import { c } from "../c.eff"\nexport const b = (): int => 1\n',
    "c.eff": "export const c = (): int => 1\n",
    "unused.eff": "export const u = (): int => 1\n",
  }, ["a.eff"]);
  assertEquals(messages(project), []);
  assertEquals(project.order, ["c", "sub/b", "a"]);
  assert(!project.modules.has("unused"));
});

Deno.test("the order does not depend on the entry order", () => {
  const files = {
    "effective.json": "{}",
    "a.eff": 'import { b } from "./b.eff"\nexport const a = (): int => 1\n',
    "b.eff": "export const b = (): int => 1\n",
  };
  assertEquals(load(files, ["a.eff", "b.eff"]).order, ["b", "a"]);
  assertEquals(load(files, ["b.eff", "a.eff"]).order, ["b", "a"]);
});

Deno.test("an import cycle gives one diagnostic on an import in the cycle", () => {
  const project = load({
    "effective.json": "{}",
    "a.eff": 'import { b } from "./b.eff"\nexport const a = (): int => 1\n',
    "b.eff": 'import { c } from "./c.eff"\nexport const b = (): int => 1\n',
    "c.eff": 'import { a } from "./a.eff"\nexport const c = (): int => 1\n',
    "d.eff": 'import { a } from "./a.eff"\nexport const d = (): int => 1\n',
  }, ["d.eff"]);
  assertEquals(messages(project), [
    "a.eff module/003 import cycle: a -> b -> c -> a",
  ]);
  assertEquals(project.diagnostics[0].span.start, 18);
  assertEquals(project.order.length, 4);
  assertEquals(project.order[3], "d");
});

Deno.test("a module that imports itself is a cycle", () => {
  const project = load({
    "effective.json": "{}",
    "a.eff": 'import { a } from "./a.eff"\nexport const a = (): int => 1\n',
  }, ["a.eff"]);
  assertEquals(messages(project), ["a.eff module/003 a imports itself"]);
});

Deno.test("two separate cycles give two diagnostics", () => {
  const project = load({
    "effective.json": "{}",
    "a.eff": 'import { b } from "./b.eff"\nexport const a = (): int => 1\n',
    "b.eff": 'import { a } from "./a.eff"\nexport const b = (): int => 1\n',
    "c.eff": 'import { d } from "./d.eff"\nexport const c = (): int => 1\n',
    "d.eff": 'import { c } from "./c.eff"\nexport const d = (): int => 1\n',
  }, ["a.eff", "c.eff"]);
  assertEquals(project.diagnostics.map((d) => d.code), [
    "module/003",
    "module/003",
  ]);
});

Deno.test("import problems are module diagnostics on the specifier", () => {
  const files = {
    "effective.json":
      '{"host": {"known": {"interface": "./k.effi", "module": "./k.ts"}}}',
    "dir/main.eff": [
      'import { a } from "./lib"',
      'import { b } from "pkg"',
      'import { c } from "../../up.eff"',
      'import { d } from "./gone.eff"',
      'import { e } from "host:nothing"',
      'import { f } from "host:known"',
      "",
    ].join("\n"),
  };
  const project = load(files, ["dir/main.eff"]);
  assertEquals(
    project.diagnostics.map((d) => d.code),
    [
      "module/001",
      "module/001",
      "module/001",
      "module/002",
      "module/002",
      "module/002",
    ],
  );
  const text = files["dir/main.eff"];
  for (const d of project.diagnostics) {
    assert(text.slice(d.span.start, d.span.end).startsWith('"'));
    assertEquals(d.span.source, "dir/main.eff");
  }
});

Deno.test("a relative import resolves against the importing file", () => {
  const project = load({
    "effective.json": "{}",
    "a/b/main.eff":
      'import { x } from "../../top.eff"\nexport const m = (): int => 1\n',
    "top.eff": "export const x = (): int => 1\n",
  }, ["a/b/main.eff"]);
  assertEquals(messages(project), []);
  assertEquals(project.order, ["top", "a/b/main"]);
});

Deno.test("a root path is joined to the paths that the host reads", () => {
  const project = load(
    {
      "proj/effective.json": "{}",
      "proj/a.eff": "export const a = (): int => 1\n",
    },
    ["a.eff"],
    "proj",
  );
  assertEquals(messages(project), []);
  assertEquals([...project.modules.keys()], ["a"]);
});

Deno.test("an entry that cannot be read is a module diagnostic", () => {
  const project = load({ "effective.json": "{}" }, [
    "gone.eff",
    "../x.eff",
    "notes.txt",
  ]);
  assertEquals(project.diagnostics.map((d) => d.code).sort(), [
    "module/001",
    "module/001",
    "module/002",
  ]);
});

Deno.test("two files with one module name conflict", () => {
  const project = load({
    "effective.json":
      '{"host": {"h": {"interface": "./m.effi", "module": "./m.ts"}}}',
    "main.eff":
      'import { x } from "./m.eff"\nimport { y } from "host:h"\nexport const a = (): int => 1\n',
    "m.eff": "export const x = (): int => 1\n",
    "m.effi": "",
  }, ["main.eff"]);
  assertEquals(project.diagnostics.map((d) => d.code), ["module/001"]);
});

Deno.test("a module path with special characters is a module diagnostic", () => {
  const files = {
    "effective.json": "{}",
    "main.eff": 'import { a } from "./a#b.eff"\n',
    "a#b.eff": "export const a: int = 1\n",
  };
  const project = load(files, ["main.eff"]);
  assertEquals(project.diagnostics.map((d) => d.code), ["module/001"]);
  assert(project.diagnostics[0].message.includes("a#b.eff"));
  assertEquals(project.modules.has("a#b"), false);
});

Deno.test("a chain of 10000 modules links without overflowing the stack", () => {
  const count = 10_000;
  const files: Record<string, string> = { "effective.json": "{}" };
  for (let i = 0; i < count; i++) {
    const body = "export const v = (): int => 1\n";
    files[`m${i}.eff`] = i + 1 < count
      ? `import { v } from "./m${i + 1}.eff"\n${body}`
      : body;
  }
  const project = load(files, ["m0.eff"]);
  assertEquals(project.diagnostics.length, 0);
  assertEquals(project.order.length, count);
  assertEquals(project.order[0], `m${count - 1}`);
  assertEquals(project.order[count - 1], "m0");
});

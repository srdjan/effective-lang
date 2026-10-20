// `provides` of a provider type is a sorted, unique set like the other effect
// sets, so serialization rejects an unsorted or repeated list.

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  type ModuleIR,
  serializeModule,
} from "../src/core/mod.ts";
import { EXAMPLE_ENTRIES, exampleFiles } from "./helpers.ts";

const FILES: Record<string, string> = {
  "effective.json": JSON.stringify({
    host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
  }),
  "host/p.effi": 'import { S } from "../s.eff"\nexport provider L provides S\n',
  "s.eff":
    "export service S { a(): Int\n  b(): Int }\nexport error Down = { why: string }\ntype Int = int\n",
  "m.eff":
    'import { L } from "host:p"\nimport { S } from "./s.eff"\nexport const g = (): Int => provide(L, () => S.a())\ntype Int = int\n',
};

function lowerAll(files: Record<string, string>, entries: readonly string[]) {
  const checked = checkProject(memoryHost(files), "", entries);
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const modules: ModuleIR[] = [];
  for (const [name, result] of lowerProject(checked.value)) {
    assert(result.ok, name);
    modules.push(result.value);
  }
  return modules;
}

/** Every path of an array of strings, with the key that holds it. */
function stringLists(
  value: unknown,
  path: string,
  out: { path: string; key: string; list: string[] }[],
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => stringLists(item, `${path}[${i}]`, out));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (Array.isArray(item) && item.length > 0 && item.every(isString)) {
      out.push({ path: at, key, list: item });
    }
    stringLists(item, at, out);
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function setAt(root: unknown, path: string, list: readonly string[]): void {
  const steps = path.slice(2).split(/\.|(?=\[)/);
  let node = root as Record<string, unknown>;
  for (const step of steps.slice(0, -1)) {
    const index = /^\[(\d+)\]$/.exec(step);
    node = (index ? node[Number(index[1])] : node[step]) as Record<
      string,
      unknown
    >;
  }
  node[steps[steps.length - 1]] = list;
}

Deno.test("a provider type must list provides sorted and unique", () => {
  const modules = lowerAll(FILES, ["s.eff", "m.eff"]);
  const found: { path: string; key: string; list: string[] }[] = [];
  const module = modules.find((m) => m.module === "m");
  assert(module !== undefined);
  stringLists(module, "$", found);
  const provides = found.filter((f) => f.key === "provides");
  assert(provides.length > 0);
  for (const { path, list } of provides) {
    assertEquals(list.length, 2);
    for (const bad of [[...list].reverse(), [list[0], ...list]]) {
      const forged = structuredClone(module);
      setAt(forged, path, bad);
      const serialized = serializeModule(forged);
      assert(!serialized.ok, path);
      assertEquals(serialized.error, { tag: "unsorted-set", path });
    }
  }
});

// A new set field in the IR must reach SET_KEYS. This lists the string-array
// keys that lowered modules hold today. A key outside both lists fails here, so
// its author decides whether it is a sorted set.
const SET_FIELDS = new Set([
  "failures",
  "requirements",
  "decodeRequirements",
  "encodeRequirements",
  "provides",
]);
// `exports` follows declaration order, and `sources` follows the module list.
const ORDERED_FIELDS = new Set(["sources", "exports"]);

Deno.test("every string list in the IR is a known set or a known ordered list", () => {
  const modules = [
    ...lowerAll(FILES, ["s.eff", "m.eff"]),
    ...lowerAll(exampleFiles(), EXAMPLE_ENTRIES),
  ];
  const unknown = new Set<string>();
  const seen = new Set<string>();
  for (const module of modules) {
    const found: { path: string; key: string; list: string[] }[] = [];
    stringLists(module, "$", found);
    for (const { path, key } of found) {
      seen.add(key);
      if (!SET_FIELDS.has(key) && !ORDERED_FIELDS.has(key)) unknown.add(key);
      if (SET_FIELDS.has(key)) {
        const forged = structuredClone(module);
        setAt(forged, path, ["z", "a"]);
        const serialized = serializeModule(forged);
        assert(!serialized.ok, path);
        // The clone keeps shared nodes shared, so an earlier copy may report.
        assertEquals(serialized.error.tag, "unsorted-set");
        assert(serialized.error.path.endsWith(`.${key}`), path);
      }
    }
  }
  assertEquals([...unknown], []);
  assert(seen.has("provides") && seen.has("failures"));
});

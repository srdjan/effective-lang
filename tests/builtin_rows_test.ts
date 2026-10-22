// The builtin rows of src/core/check_builtins. A key that two row tables give
// compiles with no error, and a spread keeps the last one. These tests check
// that the family tables and the core names are disjoint and that together
// they cover each prelude call name.

import { assert, assertEquals } from "@std/assert";
import {
  CORE_ROW_NAMES,
  FAMILY_ROW_TABLES,
} from "../src/core/check_builtins/registry.ts";
import { PRELUDE_NAMES } from "../src/core/resolve.ts";

const owners = new Map<string, string[]>();
function own(name: string, owner: string): void {
  owners.set(name, [...(owners.get(name) ?? []), owner]);
}
for (const [family, rows] of Object.entries(FAMILY_ROW_TABLES)) {
  for (const name of Object.keys(rows)) own(name, family);
}
for (const name of CORE_ROW_NAMES) own(name, "core");

Deno.test("each builtin row has exactly one owner", () => {
  const shared = [...owners].filter(([, list]) => list.length > 1);
  assertEquals(shared, []);
});

Deno.test("the rows cover each prelude call name and nothing else", () => {
  const expected = [...PRELUDE_NAMES].filter((name) => name !== "None").sort();
  assertEquals([...owners.keys()].sort(), expected);
});

Deno.test("each family owns at least one row", () => {
  for (const [family, rows] of Object.entries(FAMILY_ROW_TABLES)) {
    assert(Object.keys(rows).length > 0, `${family} has no rows`);
  }
});

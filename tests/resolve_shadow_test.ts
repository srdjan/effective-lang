// Tests for the prelude names that a module constant, a parameter, or a local may shadow.

import { assert, assertEquals } from "@std/assert";
import { analyzeProject } from "../src/core/analyze.ts";
import {
  PRELUDE_NAMES,
  SHADOWABLE_PRELUDE_NAMES,
} from "../src/core/resolve.ts";
import { memoryHost } from "../src/core/source.ts";

function codes(source: string): string[] {
  const result = analyzeProject(
    memoryHost({ "effective.json": "{}", "m.eff": source }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.map((d) => d.code);
}

/** A module constant, a function with a parameter, and a function with a local, all named `name`. */
function bindings(name: string, index: number): string {
  return [
    `const ${name} = 1`,
    `const p${index} = (${name}: int): int => ${name}`,
    `const l${index} = (): int => {`,
    `  const ${name} = 2`,
    `  ${name}`,
    `}`,
    "",
  ].join("\n");
}

Deno.test("stream and Schema prelude names are shadowable in each position", () => {
  const names = [
    "filterEffectStream",
    "takeStream",
    "schemaMake",
    "schemaStruct",
  ];
  assertEquals(codes(names.map(bindings).join("")), []);
});

Deno.test("every shadowable name is a prelude name and can be bound", () => {
  const names = [...SHADOWABLE_PRELUDE_NAMES];
  for (const name of names) assert(PRELUDE_NAMES.has(name), name);
  assertEquals(codes(names.map(bindings).join("")), []);
});

Deno.test("a prelude name outside the shadowable set is reserved in each position", () => {
  assertEquals(codes("const fail = 1\n"), ["declaration/002"]);
  assertEquals(
    codes("const f = (fail: int): int => fail\n"),
    ["declaration/002"],
  );
  assertEquals(
    codes("const f = (): int => {\n  const fail = 2\n  fail\n}\n"),
    ["declaration/002"],
  );
});

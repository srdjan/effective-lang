// Tests for the depth walk of the declaration checker (`heightWithin` in
// src/core/types.ts). The checker reports `declaration/012` for a type
// declaration nested deeper than 128 levels. Each test runs through the public
// entry `checkProject` and pins the limit for one position of one type form: a
// type of exactly 128 levels passes, and a type of 129 levels fails.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";

/** The limit of `declaration/012`, in levels. */
const LIMIT = 128;

/** The codes of the diagnostics for one module. */
function codesOf(text: string): string[] {
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.map((d) => d.code);
}

/** `Option<Option<...int...>>` with `levels` Option levels: `levels + 1` levels deep. */
function options(levels: number): string {
  return "Option<".repeat(levels) + "int" + ">".repeat(levels);
}

/**
 * Each case writes one type form with `deep` in the position under test. The
 * other positions hold shallow types. The form adds one level above `deep`.
 */
const POSITIONS: readonly (readonly [
  name: string,
  form: (deep: string) => string,
])[] = [
  ["Ref element", (d) => `Ref<${d}>`],
  ["Stream element", (d) => `Stream<${d}>`],
  ["Fiber result", (d) => `Fiber<${d}, never>`],
  ["Codec decoded", (d) => `Codec<${d}, int>`],
  ["Codec encoded", (d) => `Codec<int, ${d}>`],
  ["Schedule output", (d) => `Schedule<${d}, int>`],
  ["Schedule input", (d) => `Schedule<int, ${d}>`],
  ["Sink input", (d) => `Sink<${d}, int>`],
  ["Sink result", (d) => `Sink<int, ${d}>`],
  ["Sink leftover", (d) => `Sink<int, int, never, never, ${d}>`],
  ["Schema decoded", (d) => `Schema<${d}>`],
  ["Schema encoded", (d) => `Schema<int, ${d}>`],
  ["Schema make input", (d) => `Schema<int, int, never, never, ${d}>`],
];

for (const [name, form] of POSITIONS) {
  Deno.test(`a ${name} at 128 levels passes and at 129 levels gives declaration/012`, () => {
    // The form adds one level and `options(m)` adds m + 1 levels.
    assertEquals(codesOf(`type T = ${form(options(LIMIT - 2))}`), []);
    assertEquals(
      codesOf(`type T = ${form(options(LIMIT - 1))}`),
      ["declaration/012"],
    );
  });
}

Deno.test("a nested chain of each wrapped form is measured through every level", () => {
  // The same form at every level: 127 levels over int is 128 deep, 128 is 129.
  const chains: readonly (readonly [string, string, string])[] = [
    ["Ref", "Ref<", ">"],
    ["Stream", "Stream<", ">"],
    ["Fiber", "Fiber<", ", never>"],
    ["Codec", "Codec<", ", string>"],
    ["Schedule", "Schedule<", ", int>"],
    ["Sink", "Sink<int, ", ">"],
  ];
  for (const [name, open, close] of chains) {
    const chain = (levels: number) =>
      `type T = ${open.repeat(levels)}int${close.repeat(levels)}`;
    assertEquals(codesOf(chain(LIMIT - 1)), [], name);
    assertEquals(codesOf(chain(LIMIT)), ["declaration/012"], name);
  }
});

Deno.test("a RetrySchedule of an error is measured as two levels", () => {
  assertEquals(codesOf("error E = {}\ntype T = RetrySchedule<E>"), []);
});

Deno.test("an alias that reaches a deep form is measured through the alias", () => {
  // Alias levels count: the deep alias is 127 levels, and each wrapper adds one.
  const deep = options(LIMIT - 2);
  assertEquals(
    codesOf(`type Deep = ${deep}\ntype T = Stream<Deep>`),
    ["declaration/012"],
  );
  assertEquals(
    codesOf(`type Deep = ${options(LIMIT - 3)}\ntype T = Stream<Deep>`),
    [],
  );
});

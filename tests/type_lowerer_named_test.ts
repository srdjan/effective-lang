// Error paths of the built-in type names in the declaration checker
// (`TypeLowerer.named` in src/core/check.ts): a wrong number of type arguments
// for Ref, RetrySchedule, the three Schedule helper types, Codec, and Fiber, a
// RetrySchedule over a type that is not a declared error, and a Fiber failure
// type that is not a declared error or never. Each case pins the code, the text
// of the node that carries the span, and the message.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";

const PRELUDE = "type Int = int\nerror E = {}\nerror F = {}\n";

/** The diagnostics for one type alias `T`, as [code, node text, message]. */
function reportsFor(body: string): string[][] {
  const text = `${PRELUDE}type T = ${body}\n`;
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.map((d) => [
    d.code,
    text.slice(d.span.start, d.span.end),
    d.message,
  ]);
}

const ARITY = "type-mismatch/001";

Deno.test("a wrong number of type arguments names the type and the counts", () => {
  const cases: readonly (readonly [body: string, message: string])[] = [
    ["Ref<>", "`Ref` takes 1 type argument, but 0 are given"],
    ["Ref<Int, Int>", "`Ref` takes 1 type argument, but 2 are given"],
    [
      "RetrySchedule<>",
      "`RetrySchedule` takes 1 type argument, but 0 are given",
    ],
    [
      "RetrySchedule<E, F>",
      "`RetrySchedule` takes 1 type argument, but 2 are given",
    ],
    [
      "ScheduleInput<>",
      "`ScheduleInput` takes 1 type argument, but 0 are given",
    ],
    [
      "ScheduleInput<Int, Int>",
      "`ScheduleInput` takes 1 type argument, but 2 are given",
    ],
    [
      "ScheduleMetadata<Int>",
      "`ScheduleMetadata` takes 2 type arguments, but 1 is given",
    ],
    [
      "ScheduleMetadata<Int, Int, Int>",
      "`ScheduleMetadata` takes 2 type arguments, but 3 are given",
    ],
    [
      "ScheduleDecision<Int>",
      "`ScheduleDecision` takes 2 type arguments, but 1 is given",
    ],
    ["Codec<Int>", "`Codec` takes 2 type arguments, but 1 is given"],
    [
      "Codec<Int, Int, Int>",
      "`Codec` takes 2 type arguments, but 3 are given",
    ],
    ["Fiber<Int>", "`Fiber` takes 2 type arguments, but 1 is given"],
    ["Fiber<Int, E, F>", "`Fiber` takes 2 type arguments, but 3 are given"],
  ];
  for (const [body, message] of cases) {
    assertEquals(reportsFor(body), [[ARITY, body, message]], body);
  }
});

Deno.test("a RetrySchedule needs a declared error type", () => {
  assertEquals(reportsFor("RetrySchedule<E>"), []);
  assertEquals(reportsFor("RetrySchedule<Int>"), [
    [ARITY, "Int", "RetrySchedule needs a declared error type"],
  ]);
  assertEquals(reportsFor("RetrySchedule<Option<E>>"), [
    [ARITY, "Option<E>", "RetrySchedule needs a declared error type"],
  ]);
});

Deno.test("a Fiber failure type is a declared error, a union of them, or never", () => {
  for (const ok of ["E", "E | F", "F | E", "never", "E | never"]) {
    assertEquals(reportsFor(`Fiber<Int, ${ok}>`), [], ok);
  }
  const message = "Fiber failure type needs declared errors or never";
  // The report covers the whole failure type. A union with two bad members still
  // gives one diagnostic: the checker drops a second report with the same code
  // and span.
  const bad: readonly (readonly [type: string, reports: number])[] = [
    ["Int", 1],
    ["string", 1],
    ["Option<E>", 1],
    ["E | Int", 1],
    ["Int | string", 1],
  ];
  for (const [type, reports] of bad) {
    assertEquals(
      reportsFor(`Fiber<Int, ${type}>`),
      Array.from({ length: reports }, () => [ARITY, type, message]),
      type,
    );
  }
});

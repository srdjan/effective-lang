// Wrong-argument-count tests for the prelude builtins of src/core/check_expr.ts.
// Each row calls one builtin with a wrong number of arguments and expects the
// type-mismatch/004 diagnostic with its exact message. `None` is not callable
// and is tested in builtin_report_sites_test.ts. Every test runs through the
// public entry `checkProject`.

import { assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { memoryHost } from "../src/core/source.ts";
import { PRELUDE_NAMES } from "../src/core/resolve.ts";

interface ArityRow {
  readonly builtin: string;
  readonly call: string;
  readonly message: string;
}

function noun(count: number): string {
  return `${count} argument${count === 1 ? "" : "s"}`;
}

function given(count: number): string {
  return `${count} ${count === 1 ? "is" : "are"} given`;
}

function args(count: number): string {
  return Array.from({ length: count }, (_, i) => String(i + 1)).join(", ");
}

/** Rows for a builtin with a fixed count: one call with none and one with one too many. */
function fixed(builtin: string, count: number): ArityRow[] {
  const rows: ArityRow[] = [{
    builtin,
    call: `${builtin}(${args(count + 1)})`,
    message: `\`${builtin}\` takes ${noun(count)}, but ${given(count + 1)}`,
  }];
  if (count > 0) {
    rows.push({
      builtin,
      call: `${builtin}()`,
      message: `\`${builtin}\` takes ${noun(count)}, but ${given(0)}`,
    });
  }
  return rows;
}

/** Rows for a builtin that takes `low` or `low + 1` arguments and one fixed message. */
function bounded(builtin: string, low: number, message: string): ArityRow[] {
  return [
    { builtin, call: `${builtin}(${args(low - 1)})`, message },
    { builtin, call: `${builtin}(${args(low + 2)})`, message },
  ];
}

/** Rows for a schema builtin that also accepts a third options argument. */
function schemaWithOptions(builtin: string): ArityRow[] {
  return [
    {
      builtin,
      call: `${builtin}(1)`,
      message: `\`${builtin}\` takes 2 arguments, but 1 is given`,
    },
    {
      builtin,
      call: `${builtin}(1, 2, 3, 4)`,
      message: `\`${builtin}\` takes 2 arguments, but 4 are given`,
    },
  ];
}

const ARITY_ROWS: readonly ArityRow[] = [
  ...fixed("fail", 1),
  ...fixed("retry", 2),
  ...fixed("provide", 2),
  ...fixed("defer", 1),
  ...fixed("run", 1),
  ...fixed("scoped", 1),
  ...fixed("forkScoped", 1),
  ...fixed("makeScope", 0),
  ...fixed("provideScope", 2),
  ...fixed("addScopeFinalizer", 2),
  ...fixed("closeScope", 1),
  ...fixed("withResource", 3),
  ...fixed("unfold", 2),
  ...bounded(
    "mapEffect",
    2,
    "`mapEffect` takes a Stream, a callback, and an optional concurrency record",
  ),
  ...fixed("mapGroups", 4),
  ...fixed("scanStream", 3),
  ...fixed("mapAccumStream", 3),
  ...fixed("foldStream", 3),
  ...fixed("foldEffectStream", 3),
  ...fixed("collectStream", 1),
  ...fixed("headStream", 1),
  ...fixed("lastStream", 1),
  ...fixed("drainStream", 1),
  ...fixed("sinkForEach", 1),
  ...fixed("takeSink", 1),
  ...fixed("transduceStream", 2),
  ...fixed("aggregateStream", 2),
  ...fixed("aggregateWithinStream", 3),
  ...fixed("scheduleFromStep", 2),
  ...fixed("scheduleRecurs", 1),
  ...fixed("scheduleSpaced", 1),
  ...fixed("scheduleMap", 2),
  ...fixed("scheduleMax", 2),
  ...fixed("scheduleMin", 2),
  ...fixed("scheduleConcat", 2),
  ...fixed("runStream", 2),
  ...fixed("bufferStream", 2),
  ...fixed("mergeStreams", 2),
  ...fixed("zipStreams", 2),
  ...fixed("concatStreams", 2),
  ...bounded(
    "flatMapStreams",
    2,
    "`flatMapStreams` takes a Stream, a callback, and an optional concurrency record",
  ),
  ...fixed("switchMapStreams", 2),
  ...fixed("catchStream", 2),
  ...fixed("retryStream", 2),
  ...fixed("debounceStream", 2),
  ...fixed("throttleStream", 2),
  ...fixed("takeStream", 2),
  ...fixed("dropStream", 2),
  ...fixed("filterEffectStream", 2),
  ...fixed("takeWhileEffectStream", 2),
  ...fixed("takeUntilEffectStream", 2),
  ...fixed("dropWhileEffectStream", 2),
  ...fixed("race", 2),
  ...fixed("makeRef", 1),
  ...fixed("getRef", 1),
  ...fixed("setRef", 2),
  ...fixed("updateRef", 2),
  ...fixed("layer", 2),
  ...fixed("mergeLayers", 2),
  ...fixed("retrySchedule", 1),
  ...fixed("codec", 2),
  ...fixed("schema", 0),
  ...fixed("schemaArray", 1),
  ...fixed("schemaStruct", 1),
  ...fixed("schemaOptionalKey", 1),
  ...fixed("schemaNullToMissingKey", 1),
  ...fixed("schemaOptionFromOptionalKey", 1),
  ...schemaWithOptions("schemaDefaultKey"),
  ...fixed("schemaConstructorDefault", 2),
  ...fixed("schemaOptionalTransform", 4),
  ...fixed("schemaOptionalFromRequired", 4),
  ...fixed("schemaUnion", 1),
  ...fixed("schemaTransform", 4),
  ...fixed("schemaRecursive", 1),
  ...fixed("schemaDecode", 2),
  ...fixed("schemaEncode", 2),
  ...fixed("schemaMake", 2),
  ...fixed("schemaInvalid", 1),
  ...fixed("schemaAt", 2),
  ...fixed("schemaBoth", 3),
  ...fixed("decode", 2),
  ...fixed("encode", 2),
  ...fixed("withFiber", 2),
  ...fixed("joinFiber", 1),
  ...fixed("interruptFiber", 1),
  ...fixed("Some", 1),
  ...fixed("map", 2),
  ...fixed("filter", 2),
  ...fixed("fold", 3),
  ...bounded(
    "all",
    1,
    "`all` takes an Effect collection and an optional concurrency record",
  ),
  ...bounded(
    "partitionAll",
    1,
    "`partitionAll` takes an Effect array and an optional concurrency record",
  ),
  ...bounded(
    "validateAll",
    2,
    "`validateAll` takes an Effect array, an error wrapper, and an optional concurrency record",
  ),
  ...bounded(
    "allResults",
    1,
    "`allResults` takes an Effect collection and an optional concurrency record",
  ),
  ...bounded(
    "traverse",
    2,
    "`traverse` takes two arguments and an optional concurrency record",
  ),
];

function arityMessages(call: string): string[] {
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": `const x = ${call}\n` }),
    "",
    ["m.eff"],
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value.diagnostics
    .filter((d) => d.code === "type-mismatch/004")
    .map((d) => d.message);
}

for (const row of ARITY_ROWS) {
  Deno.test(`wrong argument count: ${row.call}`, () => {
    assertEquals(arityMessages(row.call), [row.message]);
  });
}

Deno.test("the arity table covers every prelude builtin except None", () => {
  const covered = new Set(ARITY_ROWS.map((row) => row.builtin));
  const missing = [...PRELUDE_NAMES].filter((name) =>
    name !== "None" && !covered.has(name)
  );
  assertEquals(missing, []);
  assertEquals(covered.has("None"), false);
});

Deno.test("the wrong-count messages keep their exact wording", () => {
  assertEquals(arityMessages("fail()"), [
    "`fail` takes 1 argument, but 0 are given",
  ]);
  assertEquals(arityMessages("retry(1)"), [
    "`retry` takes 2 arguments, but 1 is given",
  ]);
  assertEquals(arityMessages("makeScope(1)"), [
    "`makeScope` takes 0 arguments, but 1 is given",
  ]);
});

Deno.test("the optional concurrency record accepts both of its counts", () => {
  const counts: Record<string, readonly number[]> = {
    all: [1, 2],
    allResults: [1, 2],
    partitionAll: [1, 2],
    validateAll: [2, 3],
    traverse: [2, 3],
    mapEffect: [2, 3],
    flatMapStreams: [2, 3],
  };
  for (const [name, accepted] of Object.entries(counts)) {
    for (const count of accepted) {
      assertEquals(
        arityMessages(`${name}(${args(count)})`),
        [],
        `${name} with ${count} arguments`,
      );
    }
  }
});

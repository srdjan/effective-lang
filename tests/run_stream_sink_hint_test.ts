// A sink argument of a stream gives `takeSink` the producer element as its
// expected input when a direct `takeSink` call is one of its results, also
// inside an `if` or `match`. Every other sink argument keeps the unhinted check.

import { assert, assertEquals } from "@std/assert";
import {
  type CheckedProject,
  lowerProject,
  validateProject,
} from "../src/core/mod.ts";
import type { ValueId } from "../src/core/ir.ts";
import { assertDiagnostics } from "./schema_diagnostics.ts";
import { checkModule } from "./helpers.ts";

const checked = (source: string): CheckedProject =>
  checkModule(source, "main.eff");

const PRELUDE = `export type Int = int
export type Text = string
export type Flag = boolean
export error Stop = {}
export service Count { tick(value: Int): Int fails Stop }
type Branch = Sink<Int, Text, Stop, Count.tick, Text>
type Chunk = Sink<Int, Text, Stop, Count.tick, Int>
`;

function shortIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.slice(id.indexOf("#") + 1));
}

/** The failures, requirements, and result text of a checked function body. */
function channels(project: CheckedProject, name: string) {
  const body = project.modules.get("main")?.functions.get(
    `value:main#${name}` as ValueId,
  );
  assert(body?.body !== undefined, name);
  return {
    result: project.table.show(body.body.type),
    failures: shortIds(body.body.failures),
    requirements: shortIds(body.body.requirements),
  };
}

Deno.test("runStream infers the input of an inline takeSink from the stream", () => {
  const source =
    `${PRELUDE}export const firstTwo = (s: Stream<Int>): Int[] => runStream(s, takeSink(2))
`;
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  assertEquals(channels(project, "firstTwo"), {
    result: "Int[]",
    failures: [],
    requirements: [],
  });
});

Deno.test("runStream still accepts named sinks with another result type", () => {
  const project = checked(
    `${PRELUDE}export const named = (s: Stream<Int>, sink: Branch): Text fails Stop uses Count.tick =>
  runStream(s, sink)
`,
  );
  assertEquals(
    project.diagnostics.map((d) => [d.code, d.message]),
    [],
  );
  assertEquals(channels(project, "named"), {
    result: "Text",
    failures: ["Stop"],
    requirements: ["Count.tick"],
  });
});

Deno.test("runStream keeps a sink chosen by if or match unhinted", () => {
  const project = checked(
    `${PRELUDE}export const viaIf = (s: Stream<Int>, flag: Flag, a: Branch, b: Branch): Text fails Stop uses Count.tick =>
  runStream(s, if (flag) { a } else { b })
export const viaMatch = (s: Stream<Int>, flag: Flag, a: Branch, b: Branch): Text fails Stop uses Count.tick =>
  runStream(s, match (flag) { true => a, false => b })
`,
  );
  assertEquals(project.diagnostics, []);
  for (const name of ["viaIf", "viaMatch"]) {
    assertEquals(channels(project, name), {
      result: "Text",
      failures: ["Stop"],
      requirements: ["Count.tick"],
    }, name);
  }
});

Deno.test("runStream with a non-Stream first argument reports both missing inputs", () => {
  const source =
    `${PRELUDE}export const notStream = (n: Int): Int[] => runStream(n, takeSink(2))
`;
  assertDiagnostics(
    source,
    checked(source).diagnostics,
    [
      [
        "type-mismatch/010",
        "`runStream` needs a Stream as its first argument",
        "n",
      ],
      [
        "type-mismatch/010",
        "`takeSink` needs an expected Sink type to determine its input",
        "takeSink(2)",
      ],
    ],
    "non-Stream first argument",
  );
});

Deno.test("runStream rejects a sink input that the stream element does not fit", () => {
  const source =
    `${PRELUDE}export const wrong = (s: Stream<Text>, sink: Sink<Int, Int[], never, never, Int>): Int[] => runStream(s, sink)
`;
  assertDiagnostics(
    source,
    checked(source).diagnostics,
    [["type-mismatch/003", "the sink input", "sink"]],
    "incompatible named sink",
  );
});

/** Checks, lowers, and validates a source that must have no diagnostics. */
function clean(source: string): CheckedProject {
  const project = checked(source);
  assertEquals(project.diagnostics.map((d) => [d.code, d.message]), []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  return project;
}

Deno.test("stream transformations keep a sink chosen between named sinks unhinted", () => {
  const project = clean(
    `${PRELUDE}export const transduced = (s: Stream<Int>, flag: Flag, a: Chunk, b: Chunk): Stream<Text, Stop, Count.tick> =>
  transduceStream(s, if (flag) { a } else { b })
export const aggregated = (s: Stream<Int>, flag: Flag, a: Chunk, b: Chunk): Stream<Text, Stop, Count.tick> =>
  aggregateStream(s, match (flag) { true => a, false => b })
export const within = (s: Stream<Int>, flag: Flag, a: Chunk, b: Chunk): Stream<Text, Stop, Count.tick> =>
  aggregateWithinStream(s, if (flag) { a } else { b }, scheduleSpaced(10))
`,
  );
  for (const name of ["transduced", "aggregated", "within"]) {
    assertEquals(
      channels(project, name).result,
      "Stream<Text, Stop, Count.tick>",
      name,
    );
  }
});

Deno.test("a takeSink in an if or match branch gets the stream element", () => {
  const project = clean(
    `${PRELUDE}export const runIf = (s: Stream<Int>, flag: Flag): Int[] =>
  runStream(s, if (flag) { takeSink(2) } else { takeSink(3) })
export const runMatch = (s: Stream<Int>, flag: Flag): Int[] =>
  runStream(s, match (flag) { true => takeSink(2), false => { takeSink(3) } })
export const transduced = (s: Stream<Int>, flag: Flag): Stream<Int[]> =>
  transduceStream(s, (if (flag) { takeSink(2) } else { takeSink(3) }))
`,
  );
  for (const name of ["runIf", "runMatch"]) {
    assertEquals(channels(project, name), {
      result: "Int[]",
      failures: [],
      requirements: [],
    }, name);
  }
});

/** The shown parameter types of every arrow in a checked function body. */
function arrowParameters(project: CheckedProject, name: string): string[][] {
  const body = project.modules.get("main")?.functions.get(
    `value:main#${name}` as ValueId,
  );
  assert(body !== undefined, name);
  return [...body.table.facts.values()].flatMap((fact) =>
    fact.kind === "arrow"
      ? [fact.parameters.map((p) => project.table.show(p.type))]
      : []
  );
}

Deno.test("an inline sinkForEach gets its callback input from the stream element", () => {
  const project = clean(
    `${PRELUDE}export const direct = (s: Stream<Int>): void fails Stop uses Count.tick =>
  runStream(s, sinkForEach((item) => if (Count.tick(item) > 0) {} else {}))
export const wrapped = (s: Stream<Int[]>): void =>
  runStream(s, (sinkForEach((batch) => {})))
export const batches = (s: Stream<Int>): void =>
  runStream(transduceStream(s, takeSink(2)), sinkForEach((batch) => {}))
export const aggregated = (s: Stream<Int>): Stream<void> =>
  aggregateStream(s, sinkForEach((item) => {}))
`,
  );
  assertEquals(arrowParameters(project, "direct"), [["Int"]]);
  assertEquals(arrowParameters(project, "wrapped"), [["Int[]"]]);
  assertEquals(arrowParameters(project, "batches"), [["Int[]"]]);
  assertEquals(arrowParameters(project, "aggregated"), [["Int"]]);
});

Deno.test("an annotated sinkForEach behaves as before, also inline", () => {
  clean(
    `${PRELUDE}export const inline = (s: Stream<Int>): void =>
  runStream(s, sinkForEach((item: Int) => {}))
export const bound = (s: Stream<Int>): void => {
  const sink = sinkForEach((item: Int) => {})
  runStream(s, sink)
}
`,
  );
  const source = `${PRELUDE}export const wrong = (s: Stream<Text>): void =>
  runStream(s, sinkForEach((item: Int) => {}))
`;
  assertDiagnostics(
    source,
    checked(source).diagnostics,
    [["type-mismatch/003", "the sink input", "sinkForEach((item: Int) => {})"]],
    "annotated inline sink with the wrong input",
  );
});

Deno.test("a sinkForEach bound to a name still needs an annotated input", () => {
  const source = `${PRELUDE}export const bound = (s: Stream<Int>): void => {
  const sink = sinkForEach((item) => {})
  runStream(s, sink)
}
`;
  assertDiagnostics(
    source,
    checked(source).diagnostics,
    [[
      "type-mismatch/011",
      "the parameter `item` needs a type annotation, because the context gives no function type",
      "item",
    ]],
    "bound sinkForEach without annotation",
  );
});

Deno.test("a sinkForEach in a branch keeps its callback input annotated", () => {
  const source =
    `${PRELUDE}export const branched = (s: Stream<Int>, flag: Flag): void =>
  runStream(s, if (flag) { sinkForEach((item) => {}) } else { sinkForEach((item) => {}) })
`;
  assertEquals(
    checked(source).diagnostics.map((d) => d.code),
    ["type-mismatch/011", "type-mismatch/011"],
  );
});

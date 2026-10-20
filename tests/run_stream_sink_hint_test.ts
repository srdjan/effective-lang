// A sink argument of a stream gives `takeSink` the producer element as its
// expected input when a direct `takeSink` call is one of its results, also
// inside an `if` or `match`. Every other sink argument keeps the unhinted check.

import { assert, assertEquals } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import type { ValueId } from "../src/core/ir.ts";
import { assertDiagnostics } from "./schema_diagnostics.ts";

function checked(source: string): CheckedProject {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

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

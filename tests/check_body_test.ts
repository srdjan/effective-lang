// Tests for part A3b: expression checking, effects, modes, contracts, patterns,
// the initialization graph, and typeAt. Each test runs through the public entry
// `checkProject`.

import { assert, assertEquals } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
  typeAt,
} from "../src/core/check_project.ts";
import {
  buildInterface,
  buildTypeGraph,
  reachableModules,
} from "../src/core/interface.ts";
import type { TypeGraph } from "../src/core/check.ts";
import { solveModeGroup } from "../src/core/modes.ts";
import type { Execution, ValueId } from "../src/core/ir.ts";
import { memoryHost } from "../src/core/source.ts";
import { kindOf, type NodeId, SyntaxKind } from "../src/core/syntax.ts";
import type { NodeFact } from "../src/core/tables.ts";
import {
  diskHost,
  EXAMPLE_ENTRIES,
  EXAMPLE_MODES,
  exampleFiles,
} from "./helpers.ts";

function checkFiles(
  files: Record<string, string>,
  entries: readonly string[],
): CheckedProject {
  const result = checkProject(memoryHost(files), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** Checks one module `m.eff` with an empty project file. */
function checkText(text: string): CheckedProject {
  return checkFiles({ "effective.json": "{}", "m.eff": text }, ["m.eff"]);
}

function examples(): CheckedProject {
  const result = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function codes(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => d.code);
}

function messages(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => `${d.code} ${d.message}`);
}

function fn(project: CheckedProject, module: string, name: string) {
  const body = project.modules.get(module)?.functions.get(
    `value:${module}#${name}` as ValueId,
  );
  assert(body !== undefined, `${module}#${name}`);
  return body;
}

function shortIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.slice(id.indexOf("#") + 1));
}

Deno.test("withResource combines acquisition, use, and release contracts", () => {
  const project = checkText(`
error OpenError = {}
error ReadError = {}
error CloseError = {}
service Files {
  open(): { read: () => Text fails ReadError, close: () => void fails CloseError } fails OpenError
}
const load = (): Text fails OpenError | ReadError | CloseError uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
type Text = string
`);
  assertEquals(messages(project), []);
  const type = project.table.node(fn(project, "m", "load").type);
  assert(type.kind === "function");
  assertEquals(shortIds(type.failures), [
    "CloseError",
    "OpenError",
    "ReadError",
  ]);
  assertEquals(shortIds(type.requirements), ["Files.open"]);
  assertEquals(type.execution, "effect");
});

Deno.test("bounded traverse keeps callback failure and requirement channels", () => {
  const project = checkText(`
error Stop = {}
service S { step(n: Int): Int fails Stop }
const f = (): Int[] fails Stop uses S.step =>
  traverse([1, 2], (n) => S.step(n), { concurrency: 2 })
type Int = int
`);
  assertEquals(messages(project), []);
  const type = project.table.node(fn(project, "m", "f").type);
  assert(type.kind === "function");
  assertEquals(shortIds(type.failures), ["Stop"]);
  assertEquals(shortIds(type.requirements), ["S.step"]);
});

Deno.test("Stream and Sink defer channels until runStream", () => {
  const project = checkText(`
error Stop = {}
service Source { next(state: Int): Option<[Int, Int]> fails Stop }
service Consumer { accept(value: Int): void fails Stop }
const numbers: Stream<Int, Stop, Source.next> = unfold(0, (state) => Source.next(state))
const sink: Sink<Int, void, Stop, Consumer.accept> = sinkForEach((value: Int) => Consumer.accept(value))
const main = (): void fails Stop uses Source.next | Consumer.accept => runStream(numbers, sink)
type Int = int
`);
  assertEquals(messages(project), []);
  const main = project.table.node(fn(project, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Consumer.accept", "Source.next"]);
  assertEquals(main.execution, "effect");
});

Deno.test("runStream rejects an incompatible sink input", () => {
  const project = checkText(`
const numbers = unfold(0, (n: Int): Option<[Int, Int]> => None)
const sink = sinkForEach((s: Text): void => {})
const main = (): void => runStream(numbers, sink)
type Int = int
type Text = string
`);
  assert(
    codes(project).includes("type-mismatch/003"),
    messages(project).join("\n"),
  );
});

Deno.test("stream constructors require inline callbacks", () => {
  const project = checkText(`
const next = (n: Int): Option<[Int, Int]> => None
const numbers = unfold(0, next)
type Int = int
`);
  assert(
    codes(project).includes("type-mismatch/010"),
    messages(project).join("\n"),
  );
});

Deno.test("traverse requires a positive bound or the unbounded literal", () => {
  for (
    const option of [
      "{ concurrency: 0 }",
      "{ concurrency: -1 }",
      "{ concurrency: 1.5 }",
      "{ concurrency: 9007199254740992 }",
      '{ concurrency: "infinite" }',
      "{ concurrency: true }",
      "{ other: 2 }",
      "{ concurrency: 2, other: 3 }",
    ]
  ) {
    const project = checkText(
      `const f = (): Int[] => traverse([1], (n) => n, ${option})\ntype Int = int`,
    );
    assert(
      codes(project).includes("type-mismatch/010") ||
        (option === "{ concurrency: -1 }" &&
          codes(project).includes("syntax/010")),
      `${option}: ${messages(project)}`,
    );
  }
});

Deno.test("all preserves heterogeneous result and effect channels", () => {
  const project = checkText(`
error Stop = {}
service Probe { number(): Int fails Stop; text(): Text }
type Int = int
type Text = string
type Jobs = [Effect<Int, Stop, Probe.number>, Effect<Text, never, Probe.text>]
const jobs: Jobs = [defer(() => Probe.number()), defer(() => Probe.text())]
const tuple = (): [Int, Text] fails Stop uses Probe.number | Probe.text =>
  all(jobs, { concurrency: "unbounded" })
const record = (): { number: Int, text: Text } fails Stop uses Probe.number | Probe.text =>
  all({ number: defer(() => Probe.number()), text: defer(() => Probe.text()) })
const array = (): Int[] => all([defer(() => 1), defer(() => 2)])
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("partitionAll collects nominal failures as data", () => {
  const project = checkText(`
error Stop = { n: Int }
service Jobs { run(n: Int): Int fails Stop }
type Int = int
const jobs: Effect<Int, Stop, Jobs.run>[] = [defer(() => Jobs.run(0)), defer(() => Jobs.run(1))]
const result = (): [Int[], Stop[]] uses Jobs.run => partitionAll(jobs, { concurrency: 2 })
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  const invalid = checkText(`
type Int = int
const bad = (): [Int[], never[]] => partitionAll([1, 2])
`);
  assert(codes(invalid).includes("type-mismatch/010"));
  const bound = checkText(`
type Int = int
const bad = (): [Int[], never[]] => partitionAll([defer(() => 1)], { concurrency: 0 })
`);
  assert(codes(bound).includes("type-mismatch/010"));
});

Deno.test("a source binding named partitionAll shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const partitionAll = (): Int => 3
const use = (): Int => partitionAll()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("validateAll wraps accumulated failures in a nominal error", () => {
  const project = checkText(`
type Int = int
error Stop = { n: Int }
error Problems = { errors: Stop[] }
service Jobs { run(n: Int): Int fails Stop }
const jobs: Effect<Int, Stop, Jobs.run>[] = [defer(() => Jobs.run(0)), defer(() => Jobs.run(1))]
const result = (): Int[] fails Problems uses Jobs.run =>
  validateAll(jobs, (errors) => Problems({ errors }), { concurrency: 2 })
`);
  assertEquals(codes(project), [], messages(project).join("\n"));

  const wrongResult = checkText(`
type Int = int
error Stop = {}
const result = (): Int[] => validateAll([defer(() => fail(Stop()))], (errors) => 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/010"));

  const invalidBound = checkText(`
type Int = int
error Stop = {}
error Problems = { errors: Stop[] }
const result = (): Int[] fails Problems =>
  validateAll([defer(() => fail(Stop()))], (errors) => Problems({ errors }), { concurrency: 0 })
`);
  assert(codes(invalidBound).includes("type-mismatch/010"));
  const effectfulWrapper = checkText(`
type Int = int
error Stop = {}
error Problems = { errors: Stop[] }
service Wrap { make(errors: Stop[]): Problems }
const result = (): Int[] fails Problems uses Wrap.make =>
  validateAll([defer(() => fail(Stop()))], (errors) => Wrap.make(errors))
`);
  assert(codes(effectfulWrapper).includes("execution-mode/001"));
});

Deno.test("a source binding named validateAll shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const validateAll = (): Int => 3
const use = (): Int => validateAll()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("allResults preserves collection shape and captures each failure", () => {
  const project = checkText(`
type Int = int
type Text = string
error Stop = { n: Int }
service Probe { number(): Int fails Stop; text(): Text }
type NumberResult = { _tag: "Success", success: Int } | { _tag: "Failure", failure: Stop }
type TextResult = { _tag: "Success", success: Text } | { _tag: "Failure", failure: never }
type Jobs = [Effect<Int, Stop, Probe.number>, Effect<Text, never, Probe.text>]
const jobs: Jobs = [defer(() => Probe.number()), defer(() => Probe.text())]
const tuple = (): [NumberResult, TextResult] uses Probe.number | Probe.text =>
  allResults(jobs, { concurrency: 2 })
const record = (): { number: NumberResult, text: TextResult } uses Probe.number | Probe.text =>
  allResults({ number: defer(() => Probe.number()), text: defer(() => Probe.text()) })
const array = (): NumberResult[] uses Probe.number =>
  allResults([defer(() => Probe.number())])
`);
  assertEquals(codes(project), [], messages(project).join("\n"));

  const invalid = checkText(`
type Int = int
const bad = (): Int[] => allResults([1, 2])
`);
  assert(codes(invalid).includes("type-mismatch/010"));
  const bound = checkText(`
type Int = int
const bad = (): Int[] => allResults([defer(() => 1)], { concurrency: 0 })
`);
  assert(codes(bound).includes("type-mismatch/010"));
});

Deno.test("a source binding named allResults shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const allResults = (): Int => 3
const use = (): Int => allResults()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("takeStream keeps deferred channels and accepts a pure Int count", () => {
  const project = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const limited = (count: Int): Stream<Int, Stop, Source.next> => takeStream(source, count)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));

  const wrongCount = checkText(`
type Int = int
type Text = string
const bad = (): Stream<Int> => takeStream(unfold(0, (n): Option<[Int, Int]> => None), "two")
`);
  assert(codes(wrongCount).includes("type-mismatch/003"));

  const effectfulCount = checkText(`
type Int = int
service Count { next(): Int }
const bad = (): Stream<Int> uses Count.next =>
  takeStream(unfold(0, (n): Option<[Int, Int]> => None), Count.next())
`);
  assert(codes(effectfulCount).includes("execution-mode/001"));
});

Deno.test("a source binding named takeStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const takeStream = (): Int => 3
const use = (): Int => takeStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("dropStream keeps deferred channels and accepts a pure Int count", () => {
  const project = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const limited = (count: Int): Stream<Int, Stop, Source.next> => dropStream(source, count)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));

  const wrongCount = checkText(`
type Int = int
type Text = string
const bad = (): Stream<Int> => dropStream(unfold(0, (n): Option<[Int, Int]> => None), "two")
`);
  assert(codes(wrongCount).includes("type-mismatch/003"));

  const effectfulCount = checkText(`
type Int = int
service Count { next(): Int }
const bad = (): Stream<Int> uses Count.next =>
  dropStream(unfold(0, (n): Option<[Int, Int]> => None), Count.next())
`);
  assert(codes(effectfulCount).includes("execution-mode/001"));
});

Deno.test("a source binding named dropStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const dropStream = (): Int => 3
const use = (): Int => dropStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("takeWhileStream preserves deferred channels and requires a pure boolean predicate", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeWhileStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = takeWhileStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
service Probe { accept(n: Int): boolean }
const bad = takeWhileStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assert(codes(effectful).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = takeWhileStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named takeWhileStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const takeWhileStream = (): Int => 3
const use = (): Int => takeWhileStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("dropWhileStream preserves deferred channels and requires a pure boolean predicate", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = dropWhileStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = dropWhileStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
service Probe { accept(n: Int): boolean }
const bad = dropWhileStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assert(codes(effectful).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = dropWhileStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named dropWhileStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const dropWhileStream = (): Int => 3
const use = (): Int => dropWhileStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("takeUntilStream preserves deferred channels and requires a pure boolean predicate", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeUntilStream(source, (n) => n === 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = takeUntilStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
service Probe { accept(n: Int): boolean }
const bad = takeUntilStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assert(codes(effectful).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = takeUntilStream(3, (n) => n === 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named takeUntilStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const takeUntilStream = (): Int => 3
const use = (): Int => takeUntilStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("filterStream preserves deferred channels and requires a pure boolean predicate", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = filterStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = filterStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
service Probe { accept(n: Int): boolean }
const bad = filterStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assert(codes(effectful).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = filterStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named filterStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const filterStream = (): Int => 3
const use = (): Int => filterStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("mapStream changes the element type and preserves deferred channels", () => {
  const valid = checkText(`
type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const mapped: Stream<Bool, Stop, Source.next> = mapStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const effectful = checkText(`
type Int = int
service Probe { next(n: Int): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapStream(source, (n) => Probe.next(n))
`);
  assert(codes(effectful).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = mapStream(3, (n) => n + 1)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));

  const nonInline = checkText(`
type Int = int
const convert = (n: Int): Int => n + 1
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapStream(source, convert)
`);
  assert(codes(nonInline).includes("type-mismatch/010"));
});

Deno.test("a source binding named mapStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const mapStream = (): Int => 3
const use = (): Int => mapStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("scanStream emits seed states and preserves deferred channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const scanned: Stream<Int, Stop, Source.next> =
  scanStream(source, 0, (total, n) => total + n)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = scanStream(source, 0, (total, n) => total < n)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectfulSeed = checkText(`
type Int = int
service Seed { next(): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = scanStream(source, Seed.next(), (total, n) => total + n)
`);
  assert(codes(effectfulSeed).includes("execution-mode/001"));

  const effectfulUpdate = checkText(`
type Int = int
service Probe { next(n: Int): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = scanStream(source, 0, (total, n) => Probe.next(total + n))
`);
  assert(codes(effectfulUpdate).includes("execution-mode/001"));

  const wrongSource = checkText(`
type Int = int
const bad = scanStream(3, 0, (total, n) => total + n)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named scanStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const scanStream = (): Int => 3
const use = (): Int => scanStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("mapAccumStream threads state and infers emitted values", () => {
  const valid = checkText(`
type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const mapped: Stream<Bool, Stop, Source.next> =
  mapAccumStream(source, 0, (total, n): [Int, Bool[]] =>
    [total + n, if (n < 2) { [] } else { [total < n, n < 4] }])
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const noResultType = checkText(`
type Int = int
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapAccumStream(source, 0, (total, n) => [total + n, [n]])
`);
  assert(codes(noResultType).includes("type-mismatch/011"));

  const wrongState = checkText(`
type Int = int
type Bool = boolean
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapAccumStream(source, 0, (total, n): [Bool, Int[]] => [true, [n]])
`);
  assert(codes(wrongState).includes("type-mismatch/003"));

  const effectfulUpdate = checkText(`
type Int = int
service Probe { next(n: Int): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapAccumStream(source, 0, (total, n): [Int, Int[]] => [Probe.next(total), [n]])
`);
  assert(codes(effectfulUpdate).includes("execution-mode/001"));

  const effectfulSeed = checkText(`
type Int = int
service Seed { next(): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapAccumStream(source, Seed.next(), (total, n): [Int, Int[]] => [total + n, [n]])
`);
  assert(codes(effectfulSeed).includes("execution-mode/001"));
});

Deno.test("a source binding named mapAccumStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const mapAccumStream = (): Int => 3
const use = (): Int => mapAccumStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("foldStream returns a final state with active source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (seed: Int): Int fails Stop uses Source.next =>
  foldStream(source, seed, (total, n) => total + n)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Source.next"]);

  const missingChannels = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int => foldStream(source, 0, (total, n) => total + n)
`);
  assert(codes(missingChannels).includes("failure-contract/001"));
  assert(codes(missingChannels).includes("requirement-contract/001"));

  const wrongResult = checkText(`
type Int = int
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int => foldStream(source, 0, (total, n) => total < n)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectfulUpdate = checkText(`
type Int = int
service Probe { next(n: Int): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int uses Probe.next =>
  foldStream(source, 0, (total, n) => Probe.next(total + n))
`);
  assert(codes(effectfulUpdate).includes("execution-mode/001"));

  const effectfulSeed = checkText(`
type Int = int
service Seed { next(): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int uses Seed.next =>
  foldStream(source, Seed.next(), (total, n) => total + n)
`);
  assert(codes(effectfulSeed).includes("execution-mode/001"));
});

Deno.test("a source binding named foldStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const foldStream = (): Int => 3
const use = (): Int => foldStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("foldEffectStream combines source and update channels", () => {
  const valid = checkText(`
type Int = int
error SourceStop = {}
error UpdateStop = {}
service Source { next(n: Int): Option<[Int, Int]> fails SourceStop }
service Accum { add(total: Int, n: Int): Int fails UpdateStop }
const source = unfold(0, (n) => Source.next(n))
const main = (seed: Int): Int fails SourceStop | UpdateStop uses Source.next | Accum.add =>
  foldEffectStream(source, seed, (total, n) => Accum.add(total, n))
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["SourceStop", "UpdateStop"]);
  assertEquals(shortIds(main.requirements), ["Accum.add", "Source.next"]);

  const pureUpdate = checkText(`
type Int = int
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int => foldEffectStream(source, 0, (total, n) => total + n)
`);
  assertEquals(codes(pureUpdate), [], messages(pureUpdate).join("\n"));

  const effectfulSeed = checkText(`
type Int = int
service Seed { next(): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int uses Seed.next =>
  foldEffectStream(source, Seed.next(), (total, n) => total + n)
`);
  assert(codes(effectfulSeed).includes("execution-mode/001"));

  const wrongResult = checkText(`
type Int = int
const source = unfold(0, (n): Option<[Int, Int]> => None)
const main = (): Int => foldEffectStream(source, 0, (total, n) => total < n)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));
});

Deno.test("a source binding named foldEffectStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const foldEffectStream = (): Int => 3
const use = (): Int => foldEffectStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("collectStream returns an array with active source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int[] fails Stop uses Source.next => collectStream(source)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Source.next"]);

  const missingChannels = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int[] => collectStream(source)
`);
  assert(codes(missingChannels).includes("failure-contract/001"));
  assert(codes(missingChannels).includes("requirement-contract/001"));

  const wrongSource = checkText(`
type Int = int
const main = (): Int[] => collectStream(3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named collectStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const collectStream = (): Int => 3
const use = (): Int => collectStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("headStream returns an Option with active source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> fails Stop uses Source.next => headStream(source)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Source.next"]);

  const missingChannels = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> => headStream(source)
`);
  assert(codes(missingChannels).includes("failure-contract/001"));
  assert(codes(missingChannels).includes("requirement-contract/001"));

  const wrongSource = checkText(`
type Int = int
const main = (): Option<Int> => headStream(3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named headStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const headStream = (): Int => 3
const use = (): Int => headStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("lastStream returns an Option with active source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> fails Stop uses Source.next => lastStream(source)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Source.next"]);

  const missingChannels = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> => lastStream(source)
`);
  assert(codes(missingChannels).includes("failure-contract/001"));
  assert(codes(missingChannels).includes("requirement-contract/001"));

  const wrongSource = checkText(`
type Int = int
const main = (): Option<Int> => lastStream(3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named lastStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const lastStream = (): Int => 3
const use = (): Int => lastStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("drainStream returns void with active source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): void fails Stop uses Source.next => drainStream(source)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const main = valid.table.node(fn(valid, "m", "main").type);
  assert(main.kind === "function");
  assertEquals(main.execution, "effect");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Source.next"]);

  const missingChannels = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): void => drainStream(source)
`);
  assert(codes(missingChannels).includes("failure-contract/001"));
  assert(codes(missingChannels).includes("requirement-contract/001"));

  const wrongSource = checkText(`
type Int = int
const main = (): void => drainStream(3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a source binding named drainStream shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const drainStream = (): Int => 3
const use = (): Int => drainStream()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("zipStreams pairs different element types and unions deferred channels", () => {
  const project = checkText(`
error Stop = {}
service Left { next(n: Int): Option<[Int, Int]> fails Stop }
service Right { next(n: Int): Option<[Text, Int]> }
type Int = int
type Text = string
const left = unfold(0, (n) => Left.next(n))
const right = unfold(0, (n) => Right.next(n))
const zipped: Stream<[Int, Text], Stop, Left.next | Right.next> = zipStreams(left, right)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  const invalid = checkText(`
type Int = int
const bad = zipStreams(unfold(0, (n): Option<[Int, Int]> => None), 1)
`);
  assert(codes(invalid).includes("type-mismatch/010"));
});

Deno.test("a source binding named zipStreams shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const zipStreams = (): Int => 3
const use = (): Int => zipStreams()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("concatStreams unions different element and deferred channel types", () => {
  const project = checkText(`
error Stop = {}
service Left { next(n: Int): Option<[Int, Int]> fails Stop }
service Right { next(n: Int): Option<[Text, Int]> }
type Int = int
type Text = string
const left = unfold(0, (n) => Left.next(n))
const right = unfold(0, (n) => Right.next(n))
const combined: Stream<Int | Text, Stop, Left.next | Right.next> = concatStreams(left, right)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  const invalid = checkText(`
type Int = int
const bad = concatStreams(unfold(0, (n): Option<[Int, Int]> => None), 1)
`);
  assert(codes(invalid).includes("type-mismatch/010"));
});

Deno.test("a source binding named concatStreams shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const concatStreams = (): Int => 3
const use = (): Int => concatStreams()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("flatMapStreams combines outer and inner deferred channels", () => {
  const project = checkText(`
error OuterStop = {}
error InnerStop = {}
service Outer { next(n: Int): Option<[Int, Int]> fails OuterStop }
service Inner { next(n: Int): Option<[Text, Int]> fails InnerStop }
type Int = int
type Text = string
const outer = unfold(0, (n) => Outer.next(n))
const nested: Stream<Text, OuterStop | InnerStop, Outer.next | Inner.next> =
  flatMapStreams(outer, (n) => unfold(n, (m) => Inner.next(m)))
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  const invalid = checkText(`
type Int = int
service Outer { next(n: Int): Option<[Int, Int]> }
const outer = unfold(0, (n) => Outer.next(n))
const bad = flatMapStreams(outer, (n) => n + 1)
`);
  assert(codes(invalid).includes("type-mismatch/010"));
  const effectful = checkText(`
type Int = int
service Outer { next(n: Int): Option<[Int, Int]> }
const outer = unfold(0, (n) => Outer.next(n))
const bad = flatMapStreams(outer, (n) => { Outer.next(n); unfold(n, (m) => Outer.next(m)) })
`);
  assert(codes(effectful).includes("execution-mode/001"));
});

Deno.test("a source binding named flatMapStreams shadows the prelude operation", () => {
  const project = checkText(`
type Int = int
const flatMapStreams = (): Int => 3
const use = (): Int => flatMapStreams()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("switchMapStreams combines outer and inner deferred channels", () => {
  const valid = checkText(`
type Int = int
error OuterStop = {}
error InnerStop = {}
service Outer { next(n: Int): Option<[Int, Int]> fails OuterStop }
service Inner { next(n: Int): Option<[Int, Int]> fails InnerStop }
const outer = unfold(0, (n) => Outer.next(n))
const switched = switchMapStreams(outer, (n) => unfold(n, (m) => Inner.next(m)))
const main = (): Int[] fails OuterStop | InnerStop uses Outer.next | Inner.next => collectStream(switched)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const bad = checkText(`
type Int = int
service Outer { next(n: Int): Option<[Int, Int]> }
const outer = unfold(0, (n) => Outer.next(n))
const switched = switchMapStreams(outer, (n) => n)
`);
  assert(codes(bad).includes("type-mismatch/010"));
  const shadow = checkText(`
type Int = int
const switchMapStreams = (): Int => 3
const use = (): Int => switchMapStreams()
`);
  assertEquals(codes(shadow), [], messages(shadow).join("\n"));
});

Deno.test("catchStream replaces typed source failures with recovery channels", () => {
  const valid = checkText(`
type Int = int
error Stop = { code: Int }
error RecoveryStop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
service Recovery { next(n: Int): Option<[Int, Int]> fails RecoveryStop }
const source = unfold(0, (n) => Source.next(n))
const recovered = catchStream(source, (err) => unfold(err.code, (n) => Recovery.next(n)))
const main = (): Int[] fails RecoveryStop uses Source.next | Recovery.next => collectStream(recovered)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const bad = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const recovered = catchStream(source, (err) => err)
`);
  assert(codes(bad).includes("type-mismatch/010"));
  const shadow = checkText(`
type Int = int
const catchStream = (): Int => 3
const use = (): Int => catchStream()
`);
  assertEquals(codes(shadow), [], messages(shadow).join("\n"));
});

Deno.test("retryStream accepts compatible schedules and keeps source channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((_: Stop, attempt: Int): Option<Int> => if (attempt < 2) { Some(0) } else { None })
const source = unfold(0, (n) => Source.next(n))
const retried = retryStream(source, policy)
const main = (): Int[] fails Stop uses Source.next => collectStream(retried)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  const bad = checkText(`
type Int = int
error Stop = {}
error Other = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const policy: RetrySchedule<Other> = retrySchedule((_: Other, attempt: Int): Option<Int> => None)
const retried = retryStream(unfold(0, (n) => Source.next(n)), policy)
`);
  assert(codes(bad).includes("type-mismatch/003"));
  const shadow = checkText(`
type Int = int
const retryStream = (): Int => 3
const use = (): Int => retryStream()
`);
  assertEquals(codes(shadow), [], messages(shadow).join("\n"));
});

Deno.test("stream mapping accepts literal concurrency and rejects invalid bounds", () => {
  const valid = checkText(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
service Worker { work(n: Int): Int }
const source = unfold(0, (n) => Source.next(n))
const mapped = mapEffect(source, (n) => Worker.work(n), { concurrency: 2 })
const nested = flatMapStreams(source, (n) => unfold(n, (m) => Source.next(m)), { concurrency: "unbounded" })
const main = (): Int[] uses Source.next | Worker.work => collectStream(mapped)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  for (
    const expression of [
      "mapEffect(source, (n) => n, { concurrency: 0 })",
      'mapEffect(source, (n) => n, { concurrency: "infinite" })',
      "flatMapStreams(source, (n) => unfold(n, (m) => Source.next(m)), { concurrency: 1.5 })",
      "flatMapStreams(source, (n) => unfold(n, (m) => Source.next(m)), { capacity: 2 })",
    ]
  ) {
    const invalid = checkText(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const source = unfold(0, (n) => Source.next(n))
const bad = ${expression}
`);
    assert(
      codes(invalid).includes("type-mismatch/010"),
      messages(invalid).join("\n"),
    );
  }
});

Deno.test("effectful stream predicates defer source and callback channels", () => {
  for (
    const operation of [
      "filterEffectStream",
      "takeWhileEffectStream",
      "takeUntilEffectStream",
      "dropWhileEffectStream",
    ]
  ) {
    const valid = checkText(`
type Int = int
type Bool = boolean
error SourceStop = {}
error PredicateStop = {}
service Source { next(n: Int): Option<[Int, Int]> fails SourceStop }
service Gate { check(n: Int): Bool fails PredicateStop }
const source = unfold(0, (n) => Source.next(n))
const selected = ${operation}(source, (n) => Gate.check(n))
const main = (): Int[] fails SourceStop | PredicateStop uses Source.next | Gate.check => collectStream(selected)
`);
    assertEquals(codes(valid), [], messages(valid).join("\n"));

    const wrongResult = checkText(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const source = unfold(0, (n) => Source.next(n))
const bad = ${operation}(source, (n) => n + 1)
`);
    assert(
      codes(wrongResult).includes("type-mismatch/003"),
      messages(wrongResult).join("\n"),
    );
    const shadow = checkText(`
type Int = int
const ${operation} = (): Int => 3
const use = (): Int => ${operation}()
`);
    assertEquals(codes(shadow), [], messages(shadow).join("\n"));
  }
});

Deno.test("all rejects non-Effect entries and invalid concurrency", () => {
  for (
    const expression of [
      "all({ count: 1 })",
      'all({ job: defer(() => 1) }, { concurrency: "infinite" })',
      "all({ job: defer(() => 1) }, { concurrency: 0 })",
    ]
  ) {
    const project = checkText(
      `const bad = (): Int => ${expression}\ntype Int = int`,
    );
    assert(
      codes(project).includes("type-mismatch/010"),
      messages(project).join("\n"),
    );
  }
});

Deno.test("an existing value named all shadows the new prelude builtin", () => {
  const project = checkText(`
type Int = int
const all = (): Int => 3
const use = (): Int => all()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("scoped discharges a scope-bound fork after its parent finishes", () => {
  const project = checkText(`
service Child { run(): void; wait(): void; alive(): Bool }
type Int = int
type Bool = boolean
const parent = (): Int uses Child.run | Child.wait | Child.alive =>
  scoped(defer(() => {
    withFiber(defer(() => { forkScoped(defer(() => Child.run())); 1 }), (fiber) => joinFiber(fiber))
    Child.wait()
    if (Child.alive()) { 1 } else { 0 }
  }))
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("forkScoped needs a scope and a job without typed failures", () => {
  const outside = checkText(
    `const outside = (): void => forkScoped(defer(() => 1))`,
  );
  assert(
    codes(outside).includes("requirement-contract/001"),
    messages(outside).join("\n"),
  );
  const failed = checkText(`
error Stop = {}
const bad = (): void fails Stop =>
  scoped(defer(() => forkScoped(defer(() => fail(Stop())))))
`);
  assert(
    codes(failed).includes("type-mismatch/010"),
    messages(failed).join("\n"),
  );
});

Deno.test("withResource rejects escaped operation records and fields", () => {
  const prefix =
    `service Files { open(): { read: () => Text, close: () => void } }\n`;
  for (
    const use of [
      "file",
      "{ const saved = { saved: file }; saved }",
      "file.read",
      "{ const copy = file; copy.read() }",
      "() => file.read()",
    ]
  ) {
    const project = checkText(
      `${prefix}const bad = () => withResource(() => Files.open(), (file) => ${use}, (file) => file.close())\ntype Text = string`,
    );
    assert(
      messages(project).some((m) =>
        m.includes("a scoped operation record may only")
      ),
      `${use}: ${messages(project)}`,
    );
  }
});

Deno.test("withResource rejects operation records and results containing capabilities", () => {
  const programs = [
    `service Files { open(): { bad: () => () => Text } }\nconst bad = () => withResource(() => Files.open(), (file) => file.bad(), (file) => file.bad())\ntype Text = string`,
    `service Files { open(): { read: () => Text, close: () => void } }\nconst bad = () => withResource(() => Files.open(), (file) => () => file.read(), (file) => file.close())\ntype Text = string`,
  ];
  for (const program of programs) {
    const project = checkText(program);
    assert(
      codes(project).includes("type-mismatch/010"),
      messages(project).join("\n"),
    );
  }
});

Deno.test("Effect values defer channels until run and preserve them through bindings", () => {
  const project = checkText(`
error Stop = {}
service Counter { next(): Int fails Stop }
const make = (): Effect<Int, Stop, Counter.next> =>
  defer(() => Counter.next())
const stored: Effect<Int, Stop, Counter.next> = make()
const twice = (): Int fails Stop uses Counter.next => {
  const first = run(stored)
  const second = run(stored)
  first + second
}
type Int = int
`);
  assertEquals(messages(project), []);
  const make = fn(project, "m", "make");
  const twice = fn(project, "m", "twice");
  const makeType = project.table.node(make.type);
  const twiceType = project.table.node(twice.type);
  assert(makeType.kind === "function");
  assert(twiceType.kind === "function");
  assertEquals(makeType.failures, []);
  assertEquals(makeType.requirements, []);
  assertEquals(shortIds(twiceType.failures), ["Stop"]);
  assertEquals(shortIds(twiceType.requirements), ["Counter.next"]);
});

Deno.test("run rejects a non-Effect value", () => {
  const project = checkText("const f = (): Int => run(1)\ntype Int = int");
  assertEquals(codes(project).includes("type-mismatch/010"), true);
});

Deno.test("Effect channels accept explicit never and default to empty", () => {
  const project = checkText(`
const make = (): Effect<Int, never, never> => defer(() => 1)
const use = (value: Effect<Int>): Int => run(value)
type Int = int
`);
  assertEquals(messages(project), []);
});

Deno.test("run requires deferred failures and requirements in the caller contract", () => {
  const project = checkText(`
error Stop = {}
service Counter { next(): Int fails Stop }
const make = (): Effect<Int, Stop, Counter.next> => defer(() => Counter.next())
const missing = (): Int => run(make())
type Int = int
`);
  assertEquals(codes(project), [
    "failure-contract/001",
    "requirement-contract/001",
  ]);
});

/** The facts of a function body in node order. */
function factsOf(
  project: CheckedProject,
  module: string,
  name: string,
): NodeFact[] {
  const table = fn(project, module, name).table;
  return [...table.facts.entries()].sort((a, b) => a[0] - b[0]).map((e) =>
    e[1]
  );
}

function nodesOfKind(
  project: CheckedProject,
  module: string,
  kind: SyntaxKind,
): NodeId[] {
  const tree = project.modules.get(module)!.tree;
  const result: NodeId[] = [];
  for (let n = 0; n < tree.count; n++) {
    if (kindOf(tree, n) === kind) result.push(n);
  }
  return result;
}

// ------------------------------------------------------------------ the examples

Deno.test("the five examples check with no diagnostics", () => {
  const project = examples();
  assertEquals(messages(project), []);
});

Deno.test("the computed modes equal the modes that the plan names", () => {
  const project = examples();
  const computed = new Map<ValueId, Execution>();
  for (const module of project.modules.values()) {
    for (const [id, mode] of module.modes) computed.set(id, mode);
  }
  assertEquals(
    [...computed].sort(),
    [...EXAMPLE_MODES].sort(),
  );
});

Deno.test("every example module has an interface with a hash", () => {
  const project = examples();
  for (const module of project.modules.values()) {
    assert(module.interface.ok, module.module);
    assertEquals(module.hash?.length, 16);
  }
});

Deno.test("the interface built from computed modes equals the interface from the plan's modes", () => {
  const project = examples();
  for (const module of project.modules.values()) {
    const imported = new Map<string, TypeGraph>();
    for (const other of reachableModules(project.analysis, module.module)) {
      const found = project.modules.get(other);
      if (found !== undefined) {
        imported.set(other, buildTypeGraph(found.declarations));
      }
    }
    const rebuilt = buildInterface(
      module.declarations,
      EXAMPLE_MODES,
      imported,
    );
    assert(rebuilt.ok && module.interface.ok);
    assertEquals(rebuilt.value.hash, module.interface.value.hash);
  }
});

Deno.test("rename fails with UserMissing and StoreUnavailable and needs Users.find and Users.save", () => {
  const rename = fn(examples(), "users", "rename");
  assertEquals(shortIds(rename.body!.failures), [
    "StoreUnavailable",
    "UserMissing",
  ]);
  assertEquals(shortIds(rename.body!.requirements), [
    "Users.find",
    "Users.save",
  ]);
  assertEquals(rename.mode, "effect");
});

Deno.test("displayName handles UserMissing and fails only with StoreUnavailable", () => {
  const display = fn(examples(), "users", "displayName");
  assertEquals(shortIds(display.body!.failures), ["StoreUnavailable"]);
  assertEquals(shortIds(display.body!.requirements), ["Users.find"]);
});

Deno.test("main has no requirements left after provide", () => {
  const main = fn(examples(), "main", "main");
  assertEquals(main.body!.requirements, []);
  assertEquals(shortIds(main.body!.failures), ["StoreUnavailable"]);
  assertEquals(main.mode, "effect");
});

Deno.test("markPaid is pure and keeps the Order type", () => {
  const project = examples();
  const markPaid = fn(project, "pay", "markPaid");
  assertEquals(markPaid.mode, "pure");
  assertEquals(markPaid.body!.mode, "pure");
  assertEquals(project.table.show(markPaid.result), "Order");
});

Deno.test("total returns Amount, an alias of int, and is pure", () => {
  const project = examples();
  const total = fn(project, "collections", "total");
  assertEquals(project.table.show(total.result), "Amount");
  assert(project.table.isAssignable(total.result, project.table.int));
  assertEquals(total.mode, "pure");
});

Deno.test("a pipeline stage records the closed builtin specialization", () => {
  const project = examples();
  const activeNames = fn(project, "collections", "activeNames");
  const builtins = factsOf(project, "collections", "activeNames").filter((
    f,
  ) => f.kind === "builtin");
  assertEquals(builtins.map((f) => f.kind === "builtin" ? f.name : ""), [
    "filter",
    "map",
  ]);
  const filter = builtins[0];
  assert(filter.kind === "builtin");
  assertEquals(
    project.table.show(filter.specialized),
    "(User[], (User) => boolean) => User[]",
  );
  assertEquals(filter.ir.execution, "pure");
  assertEquals(filter.ir.parameters.length, 2);
  assertEquals(activeNames.mode, "pure");
  const map = builtins[1];
  assert(map.kind === "builtin");
  assertEquals(
    project.table.show(map.specialized),
    "(User[], (User) => string) => string[]",
  );
  const fold = factsOf(project, "collections", "total").find((f) =>
    f.kind === "builtin"
  );
  assert(fold !== undefined && fold.kind === "builtin");
  assertEquals(
    project.table.show(fold.specialized),
    "(Amount[], Amount, (Amount, Amount) => Amount) => Amount",
  );
});

Deno.test("call facts tell performs, constructions, fail, and retry apart", () => {
  const project = examples();
  const kinds = (module: string, name: string) =>
    factsOf(project, module, name).map((f) => f.kind);
  assertEquals(kinds("log", "log"), ["perform"]);
  assertEquals(kinds("users", "getUser").filter((k) => k !== "pattern"), [
    "perform",
    "error-construction",
    "fail",
  ]);
  assert(kinds("pay", "chargeOrder").includes("retry"));
  const retry = factsOf(project, "pay", "chargeOrder").find((f) =>
    f.kind === "retry"
  );
  assert(retry !== undefined && retry.kind === "retry");
  assertEquals(retry.times, 2);
  const provide = factsOf(project, "main", "main").find((f) =>
    f.kind === "provide"
  );
  assert(provide !== undefined && provide.kind === "provide");
  assertEquals(provide.provider, "value:host/providers#UsersLive");
  const perform = factsOf(project, "log", "log")[0];
  assert(perform.kind === "perform");
  assertEquals(perform.capability, "cap:log#Console.print");
});

Deno.test("pattern facts name the pattern kind and the binding", () => {
  const project = examples();
  const patterns = factsOf(project, "users", "getUser").filter((f) =>
    f.kind === "pattern"
  );
  assertEquals(patterns.length, 2);
  const some = patterns[0];
  assert(some.kind === "pattern" && some.pattern.kind === "some");
  assertEquals(some.pattern.binding, "local:users#getUser/user");
  const none = patterns[1];
  assert(none.kind === "pattern" && none.pattern.kind === "none");
  const handler = factsOf(project, "users", "displayName").find((f) =>
    f.kind === "handler"
  );
  assert(handler !== undefined && handler.kind === "handler");
  assertEquals(handler.error, "error:users#UserMissing");
  assertEquals(handler.binding, "local:users#displayName/error");
});

Deno.test("field reads and block bindings are recorded", () => {
  const project = examples();
  const fields = factsOf(project, "pay", "chargeOrder").filter((f) =>
    f.kind === "field"
  );
  assertEquals(fields.length, 1);
  assert(fields[0].kind === "field");
  assertEquals(fields[0].name, "totalCents");
  assertEquals(fields[0].optional, false);
  const bindings = factsOf(project, "users", "rename").filter((f) =>
    f.kind === "binding"
  );
  assertEquals(bindings.length, 2);
});

// ------------------------------------------------------------------ typeAt

Deno.test("typeAt on a function name prints its signature", () => {
  const project = examples();
  const text = project.modules.get("users")!.tree.text;
  const at = text.indexOf("rename") + 2;
  assertEquals(
    typeAt(project, "users.eff", at),
    "rename(id, name): User fails StoreUnavailable | UserMissing uses Users.find | Users.save",
  );
  const getUser = text.indexOf("getUser") + 1;
  assertEquals(
    typeAt(project, "users.eff", getUser),
    "getUser(id): User fails StoreUnavailable | UserMissing uses Users.find",
  );
});

Deno.test("typeAt on an expression prints the type and the sets of the innermost node", () => {
  const project = examples();
  const text = project.modules.get("users")!.tree.text;
  // The `user` in `const user = getUser(id)` of rename.
  const call = text.indexOf("getUser(id)\n  const renamed");
  assertEquals(
    typeAt(project, "users.eff", call + 9),
    "UserId",
  );
  assertEquals(
    typeAt(project, "users.eff", call + 2),
    "(UserId) => User fails StoreUnavailable | UserMissing uses Users.find",
  );
  assertEquals(typeAt(project, "users.eff", 0), undefined);
  assertEquals(typeAt(project, "nowhere.eff", 0), undefined);
});

// ------------------------------------------------------------------ contracts

const USERS_BROKEN = `${exampleFiles()["users.eff"]}
export const broken = (id: Text): User
  uses Users.find => getUser(id)
type Text = string
`;

Deno.test("the invalid example of the spec gives exactly one failure-contract diagnostic", () => {
  const files = exampleFiles();
  files["users.eff"] = USERS_BROKEN;
  const project = checkFiles(files, ["users.eff"]);
  assertEquals(codes(project), ["failure-contract/001"]);
  assert(project.diagnostics[0].message.includes("UserMissing"));
  assert(project.diagnostics[0].message.includes("StoreUnavailable"));
});

Deno.test("a body that needs more capabilities than uses lists is a requirement-contract error", () => {
  const project = checkText(`
service S {
  a(): Int
  b(): Int
}
const f = (): Int uses S.a => S.a() + S.b()
type Int = int
`);
  assertEquals(codes(project), ["requirement-contract/001"]);
  assert(project.diagnostics[0].message.includes("S.b"));
});

Deno.test("a declared set may be wider than the body needs", () => {
  const project = checkText(`
error E = { m: string }
service S { a(): Int }
const f = (): Int fails E uses S.a => 1
const g = (): Int fails E uses S.a => f()
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "f").mode, "effect");
  assertEquals(shortIds(fn(project, "m", "g").body!.failures), ["E"]);
});

Deno.test("an inferred arrow takes its sets from the body", () => {
  const project = checkText(`
error E = { m: string }
const f = (n: Int): Int fails E => fail(E({ m: "x" }))
const g = (n: Int): Int fails E => {
  const h = (k: Int) => f(k)
  h(n)
}
type Int = int
`);
  assertEquals(messages(project), []);
});

Deno.test("an arrow with a result annotation is checked against its closed contract", () => {
  const project = checkText(`
error E = { m: string }
const f = (n: Int): Int fails E => fail(E({ m: "x" }))
const g = (n: Int): Int fails E => {
  const h = (k: Int): Int => f(k)
  h(n)
}
type Int = int
`);
  assertEquals(codes(project), ["failure-contract/001"]);
});

Deno.test("function results with a wider declared type accept narrower bodies", () => {
  const project = checkText(`
const f = (n: Int): Num => n
const g = (n: Int): Int | Text => n
type Int = int
type Num = number
type Text = string
`);
  assertEquals(messages(project), []);
});

// ------------------------------------------------------------------ callbacks and modes

Deno.test("an effectful callback passed to map is an execution-mode error", () => {
  const project = checkText(`
service S { a(): Int }
const f = (xs: Int[]): Int[] uses S.a => map(xs, (x) => S.a())
type Int = int
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("traverse carries callback failures and requirements", () => {
  const project = checkText(`
error Stop = { at: int }
service S { step(n: Int): Int fails Stop }
const good = (xs: Int[]): Int[] fails Stop uses S.step =>
  traverse(xs, (n) => S.step(n))
const missing = (xs: Int[]): Int[] =>
  xs |> traverse((n) => S.step(n))
type Int = int
`);
  assertEquals(codes(project), [
    "failure-contract/001",
    "requirement-contract/001",
  ]);
  assertEquals(shortIds(fn(project, "m", "good").body!.failures), ["Stop"]);
  assertEquals(shortIds(fn(project, "m", "good").body!.requirements), [
    "S.step",
  ]);
});

Deno.test("a parameter of function type is effectful and cannot be a pure callback", () => {
  const project = checkText(`
const f = (xs: Int[], g: (x: Int) => Int): Int[] => map(xs, g)
type Int = int
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("a pure module function may be a callback by reference", () => {
  const project = checkText(`
const double = (n: Int): Int => n * 2
const f = (xs: Int[]): Int[] => xs |> map(double)
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "double").mode, "pure");
});

Deno.test("an effectful module function cannot be a callback by reference", () => {
  const project = checkText(`
service S { a(): Int }
const bump = (n: Int): Int uses S.a => n + S.a()
const f = (xs: Int[]): Int[] uses S.a => xs |> map(bump)
type Int = int
`);
  assertEquals(codes(project), ["execution-mode/001"]);
});

Deno.test("an effectful module constant initializer is an execution-mode error", () => {
  const project = checkText(`
service S { a(): Int }
const x: Int = S.a()
type Int = int
`);
  assertEquals(codes(project), ["execution-mode/002"]);
});

Deno.test("a pure function call is allowed in a module constant", () => {
  const project = checkText(`
const double = (n: Int): Int => n * 2
const x: Int = double(21)
type Int = int
`);
  assertEquals(messages(project), []);
});

Deno.test("an imported function keeps the mode from its interface", () => {
  const files = {
    "effective.json": "{}",
    "lib.eff": `
export const double = (n: Int): Int => n * 2
export const loud = (n: Int): Int => retry(() => n, { times: 1 })
type Int = int
`,
    "main.eff": `
import { double, loud } from "./lib.eff"
const a = (xs: Int[]): Int[] => xs |> map(double)
const b = (xs: Int[]): Int[] => xs |> map(loud)
type Int = int
`,
  };
  const project = checkFiles(files, ["main.eff"]);
  assertEquals(
    project.modules.get("lib")!.modes.get("value:lib#double" as ValueId),
    "pure",
  );
  assertEquals(
    project.modules.get("lib")!.modes.get("value:lib#loud" as ValueId),
    "effect",
  );
  assertEquals(messages(project).length, 1);
  assertEquals(project.diagnostics[0].code, "execution-mode/001");
  assert(project.diagnostics[0].span.source === "main.eff");
});

Deno.test("two mutually recursive functions where one performs an effect both end up effect", () => {
  const project = checkText(`
const ping = (n: Int): Int => retry(() => pong(n), { times: 1 })
const pong = (n: Int): Int => if (n === 0) { 0 } else { ping(n - 1) }
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "ping").mode, "effect");
  assertEquals(fn(project, "m", "pong").mode, "effect");
  assertEquals(project.modules.get("m")!.hash?.length, 16);
});

Deno.test("two mutually recursive pure functions stay pure", () => {
  const project = checkText(`
const even = (n: Int): Bool => if (n === 0) { true } else { odd(n - 1) }
const odd = (n: Int): Bool => if (n === 0) { false } else { even(n - 1) }
type Int = int
type Bool = boolean
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "even").mode, "pure");
  assertEquals(fn(project, "m", "odd").mode, "pure");
});

Deno.test("a self-recursive explicit function is allowed and an unannotated one is not", () => {
  const ok = checkText(`
const sum = (n: Int): Int => if (n === 0) { 0 } else { n + sum(n - 1) }
type Int = int
`);
  assertEquals(messages(ok), []);
  assertEquals(fn(ok, "m", "sum").mode, "pure");
  const bad = checkText(`
const sum = (n: Int) => if (n === 0) { 0 } else { n + sum(n - 1) }
type Int = int
`);
  assertEquals(codes(bad), ["execution-mode/003"]);
});

Deno.test("the mode solver starts pure, converges, and reports a cap hit", () => {
  const a = "value:m#a" as ValueId;
  const b = "value:m#b" as ValueId;
  // b is intrinsically effectful. a is effectful when b is.
  let rounds = 0;
  const solved = solveModeGroup([a, b], (assumed) => {
    rounds++;
    return {
      results: rounds,
      computed: new Map<ValueId, Execution>([
        [a, assumed.get(b) === "effect" ? "effect" : "pure"],
        [b, "effect"],
      ]),
    };
  });
  assertEquals(solved.settled, true);
  assertEquals(solved.modes.get(a), "effect");
  assertEquals(solved.modes.get(b), "effect");
  assertEquals(solved.rounds, 3);
  const capped = solveModeGroup([a, b], (assumed) => ({
    results: 0,
    computed: new Map<ValueId, Execution>([
      [a, assumed.get(b) === "effect" ? "effect" : "pure"],
      [b, "effect"],
    ]),
  }), 2);
  assertEquals(capped.settled, false);
});

Deno.test("held diagnostics of a recursive group appear once", () => {
  const project = checkText(`
const ping = (n: Int): Int => retry(() => pong(n), { times: 1 })
const pong = (n: Int): Int => if (n === 0) { "zero" } else { ping(n - 1) }
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

// ------------------------------------------------------------------ initialization

Deno.test("the initialization graph orders constants by their eager dependencies", () => {
  const project = checkText(`
const total: Int = double(base)
const double = (n: Int): Int => n * scale
const scale: Int = 2
const base: Int = 21
type Int = int
`);
  assertEquals(messages(project), []);
  const graph = project.modules.get("m")!.initialization;
  assertEquals(graph.constants.map((c) => c.slice(8)), [
    "total",
    "scale",
    "base",
  ]);
  assertEquals(
    graph.dependencies.get("value:m#total" as ValueId)?.map((c) => c.slice(8)),
    ["scale", "base"],
  );
  assertEquals(graph.order.map((c) => c.slice(8)), ["scale", "base", "total"]);
  assertEquals(graph.cycles, []);
});

Deno.test("a cycle through a function is a module diagnostic", () => {
  const project = checkText(`
const a: Int = f(1)
const f = (n: Int): Int => n + a
type Int = int
`);
  assertEquals(codes(project), ["module/004"]);
});

Deno.test("a recursive function without a constant in the cycle is no initialization cycle", () => {
  const project = checkText(`
const total: Int = down(3)
const down = (n: Int): Int => if (n === 0) { 0 } else { down(n - 1) }
type Int = int
`);
  assertEquals(messages(project), []);
});

// ------------------------------------------------------------------ types and literals

Deno.test("an integral literal is int and a fraction is number", () => {
  const project = checkText(`
const a = (): Int => 3
const b = (): Num => 3
const c = (): Num => 1.5
const d = (): Int => 1.5
type Int = int
type Num = number
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("an expected literal alternative survives in a record update", () => {
  const project = checkText(`
type Order = { id: string, status: "pending" | "paid" }
const paid = (o: Order): Order => ({ ...o, status: "paid" })
const bad = (o: Order): Order => ({ ...o, status: "lost" })
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assert(project.diagnostics[0].message.includes("status"));
});

Deno.test("a literal without an expected type widens to its primitive", () => {
  const project = checkText(`
type Status = "pending" | "paid"
const f = (): Status => {
  const s = "paid"
  s
}
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("branches without an expected type widen and need a common type", () => {
  const project = checkText(`
const f = (flag: Bool) => if (flag) { "a" } else { "b" }
const g = (flag: Bool): Text => f(flag)
const h = (flag: Bool) => if (flag) { 1 } else { 2.5 }
const i = (flag: Bool): Num => h(flag)
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(messages(project), []);
});

Deno.test("never fits every branch", () => {
  const project = checkText(`
error E = { m: string }
const f = (flag: Bool): Int fails E =>
  if (flag) { 1 } else { fail(E({ m: "no" })) }
type Int = int
type Bool = boolean
`);
  assertEquals(messages(project), []);
});

Deno.test("arithmetic keeps int, divides to number, and joins strings", () => {
  const project = checkText(`
const a = (x: Int, y: Int): Int => x + y * 2 - 1
const b = (x: Int, y: Int): Num => x / y
const c = (x: Int, y: Num): Num => x + y
const d = (x: Text): Text => x + "!"
const e = (x: Int, y: Int): Bool => x < y
const f = (x: Int, y: Int): Int => x / y
const g = (x: Int, y: Text): Int => x + y
type Int = int
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(codes(project), ["type-mismatch/003", "type-mismatch/007"]);
});

Deno.test("two values of one numeric brand compare, add, and subtract", () => {
  const project = checkText(`
type Count = Brand<int>
type Price = Brand<number>
const sum = (a: Count, b: Count): Count => a + b
const diff = (a: Count, b: Count): Count => a - b
const below = (a: Count, b: Count): Bool => a < b
const atLeast = (a: Count, b: Count): Bool => a >= b
const priceSum = (a: Price, b: Price): Price => a + b
const priceDiff = (a: Price, b: Price): Price => a - b
const priceAbove = (a: Price, b: Price): Bool => a > b
const priceAtMost = (a: Price, b: Price): Bool => a <= b
type Int = int
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(messages(project), []);
  const text = project.modules.get("m")!.tree.text;
  const plus = text.indexOf("a + b") + 2;
  assertEquals(typeAt(project, "m.eff", plus), "Count");
  const minus = text.indexOf("a - b") + 2;
  assertEquals(typeAt(project, "m.eff", minus), "Count");
  const priceMinus = text.indexOf("a - b", minus + 1) + 2;
  assertEquals(typeAt(project, "m.eff", priceMinus), "Price");
});

Deno.test("a brand operator rejects multiplication, division, a plain number, another brand, and a string brand", () => {
  const project = checkText(`
type Count = Brand<int>
type Price = Brand<number>
type Name = Brand<string>
const times = (a: Count, b: Count): Count => a * b
const divide = (a: Count, b: Count): Count => a / b
const plain = (a: Count): Count => a + 1
const mixed = (count: Count, price: Price): Price => count + price
const names = (name: Name): Name => name + name
type Int = int
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(codes(project), [
    "type-mismatch/007",
    "type-mismatch/007",
    "type-mismatch/007",
    "type-mismatch/007",
    "type-mismatch/007",
  ]);
  assertEquals(
    messages(project)[2],
    "type-mismatch/007 the operator `+` does not accept operands of type Count and int",
  );
});

Deno.test("equality takes compatible primitives, literal unions, and matching brands, and rejects records", () => {
  const project = checkText(`
type Id = Brand<string>
type Other = Brand<string>
type Point = { x: int }
type Status = "a" | "b"
const a = (x: Int, y: Num): Bool => x === y
const b = (x: Status): Bool => x === "a"
const c = (x: Id, y: Id): Bool => x !== y
const d = (x: Id, y: Other): Bool => x === y
const e = (x: Point, y: Point): Bool => x === y
const f = (x: Text, y: Int): Bool => x === y
type Int = int
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(codes(project), [
    "type-mismatch/007",
    "type-mismatch/007",
    "type-mismatch/007",
  ]);
});

Deno.test("conditions and boolean operators need boolean operands", () => {
  const project = checkText(`
const a = (x: Int): Int => if (x) { 1 } else { 2 }
const b = (x: Bool, y: Bool): Bool => x && y || x
const c = (x: Bool, y: Int): Bool => x && y
type Int = int
type Bool = boolean
`);
  assertEquals(codes(project), ["type-mismatch/007", "type-mismatch/007"]);
});

Deno.test("short-circuit operators union the effects of both operands", () => {
  const project = checkText(`
service S { ok(): Bool }
const f = (x: Bool): Bool uses S.ok => x && S.ok()
type Bool = boolean
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), ["S.ok"]);
});

Deno.test("record construction rejects missing, duplicate, and unknown fields", () => {
  const project = checkText(`
type User = { name: string, nick?: string }
const a = (): User => ({ name: "a" })
const b = (): User => ({ name: "a", nick: "b" })
const c = (): User => ({ nick: "b" })
const d = (): User => ({ name: "a", name: "b" })
const e = (): User => ({ name: "a", age: 3 })
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/005",
    "type-mismatch/005",
  ]);
});

Deno.test("a record without an expected type infers its record type", () => {
  const project = checkText(`
type User = { name: string, age: int }
const a = () => ({ name: "a", age: 3 })
const b = (): User => a()
`);
  assertEquals(messages(project), []);
});

Deno.test("record update checks the base, the field names, and the field types", () => {
  const project = checkText(`
type User = { name: string, age: int }
const a = (u: User): User => ({ ...u, age: 4 })
const b = (u: User): User => ({ ...u, size: 4 })
const c = (u: User): User => ({ ...u, age: "old" })
const d = (n: Int): Int => ({ ...n, age: 1 })
type Int = int
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/003",
    "type-mismatch/005",
  ]);
});

Deno.test("an optional field reads as Option and a missing field is rejected", () => {
  const project = checkText(`
type Profile = { name: string, nick?: string }
const a = (p: Profile): Option<Text> => p.nick
const b = (p: Profile): Text => p.nick
const c = (p: Profile): Text => p.name
type Text = string
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  const facts = factsOf(project, "m", "a").filter((f) => f.kind === "field");
  assert(facts[0].kind === "field" && facts[0].optional);
});

Deno.test("a field of a named error value reads through the error record", () => {
  const project = checkText(`
error E = { reason: string }
const f = (e: E): Text => e.reason
const g = (e: E): Text => e.other
type Text = string
`);
  assertEquals(codes(project), ["type-mismatch/006"]);
});

Deno.test("brand construction and unbrand follow the nominal rules", () => {
  const project = checkText(`
type Id = Brand<string>
type Name = string
const a = (s: Text): Id => Id(s)
const b = (i: Id): Text => unbrand(i)
const c = (n: Int): Id => Id(n)
const d = (s: Text): Text => unbrand(s)
const e = (s: Text): Name => Name(s)
const f = (i: Id): Text => i
type Int = int
type Text = string
`);
  assertEquals(codes(project), [
    "type-mismatch/003",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/003",
  ]);
  const kinds = factsOf(project, "m", "a").map((f) => f.kind);
  assertEquals(kinds, ["brand-construction"]);
});

Deno.test("Some and None take their type from the expected type", () => {
  const project = checkText(`
type Status = "a" | "b"
const a = (): Option<Int> => Some(1)
const b = (): Option<Status> => Some("a")
const c = (): Option<Int> => None
const d = (): Option<Text> => Some(1)
type Int = int
type Text = string
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("fail needs a named error value and has type never", () => {
  const project = checkText(`
error E = { m: string }
const a = (): Int fails E => fail(E({ m: "x" }))
const b = (e: E): Text fails E => fail(e)
const c = (): Int => fail(1)
type Int = int
type Text = string
`);
  assertEquals(codes(project), ["type-mismatch/010"]);
});

Deno.test("error construction needs exactly the error fields", () => {
  const project = checkText(`
error E = { m: string, n: int }
const a = (): E => E({ m: "x", n: 1 })
const b = (): E => E({ m: "x" })
const c = (): E => E(1)
const d = (): E => E({ m: "x", n: 1 }, 2)
`);
  assertEquals(codes(project), [
    "type-mismatch/005",
    "type-mismatch/003",
    "type-mismatch/004",
  ]);
});

Deno.test("calls check the callee once, the argument count, and the argument types", () => {
  const project = checkText(`
const add = (a: Int, b: Int): Int => a + b
const f = (): Int => add(1, 2)
const g = (): Int => add(1)
const h = (): Int => add(1, "2")
const i = (): Int => (add)(1, 2)
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/004", "type-mismatch/003"]);
});

Deno.test("a function-typed parameter can be called and makes the caller effectful", () => {
  const project = checkText(`
const apply = (f: (n: Int) => Int, x: Int): Int => f(x)
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "apply").mode, "effect");
});

Deno.test("an inline arrow gets parameter types from the expected function type", () => {
  const project = checkText(`
const apply = (f: (n: Int) => Int, x: Int): Int => f(x)
const a = (): Int => apply((n) => n + 1, 1)
const b = (): Int => apply((n) => "x", 1)
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a pipeline evaluates the left value once and passes it first", () => {
  const project = checkText(`
service S { all(): Int[] }
const add = (a: Int, b: Int): Int => a + b
const f = (): Int => 1 |> add(2)
const g = (): Int[] uses S.all => S.all() |> map((n) => n + 1)
const h = (x: Int): Int => x |> add
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/004"]);
});

Deno.test("a service stage is a perform with the left value as the first argument", () => {
  const project = checkText(`
service S { put(n: Int): void }
const f = (n: Int): void uses S.put => n |> S.put
type Int = int
`);
  assertEquals(messages(project), []);
  const kinds = factsOf(project, "m", "f").map((f) => f.kind);
  assertEquals(kinds, ["perform"]);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), ["S.put"]);
});

Deno.test("map, filter, and fold check their arguments", () => {
  const project = checkText(`
const a = (xs: Int[]): Text[] => xs |> map((n) => "x")
const b = (xs: Int[]): Int[] => xs |> filter((n) => n)
const c = (xs: Int[]): Int => xs |> fold(0, (s, n) => s + n)
const d = (xs: Int[]): Int => xs |> fold(0, (s) => s)
const e = (n: Int): Int[] => n |> map((x) => x)
const f = (xs: Text[]): Text => xs |> fold("", (s, x) => s + x)
const g = (xs: Int[]): Num => xs |> fold(0, (s, n) => s + n)
type Int = int
type Num = number
type Text = string
`);
  assertEquals(codes(project), [
    "type-mismatch/003",
    "type-mismatch/004",
    "type-mismatch/010",
  ]);
});

Deno.test("fold takes the widened type of the initial value when no type is expected", () => {
  const project = checkText(`
const a = (xs: Int[]) => xs |> fold(0, (s, n) => s + n)
const b = (xs: Int[]): Int => a(xs)
type Int = int
`);
  assertEquals(messages(project), []);
});

Deno.test("a builtin used as a plain value is rejected by the resolver, not twice", () => {
  const project = checkText(`
const f = (xs: Int[]): Int[] => xs |> map
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/004"]);
});

// ------------------------------------------------------------------ retry and provide

Deno.test("retry needs a zero-argument job and a literal times", () => {
  const project = checkText(`
const job = (): Int => 1
const a = (): Int => retry(job, { times: 2 })
const b = (): Int => retry(job, { times: 1.5 })
const c = (n: Int): Int => retry(job, { times: n })
const d = (): Int => retry(job, { count: 2 })
const e = (): Int => retry((n: Int) => n, { times: 2 })
const f = (): Int => retry(job)
type Int = int
`);
  assertEquals(codes(project), [
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/004",
  ]);
  assertEquals(fn(project, "m", "a").mode, "effect");
});

Deno.test("retry unions the construction sets with the job's invocation sets", () => {
  const project = checkText(`
error E = { m: string }
service S { a(): Int fails E }
const f = (): Int fails E uses S.a => retry(() => S.a(), { times: 0 })
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.failures), ["E"]);
});

Deno.test("custom retry schedules keep nominal failure contracts", () => {
  const project = checkText(`
error Stop = {}
service Jobs { next(): Int fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((error: Stop, attempt: Int): Option<Int> =>
  if (attempt < 2) { Some(0) } else { None })
const run = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "run").body!.failures), ["Stop"]);
});

Deno.test("pure codecs infer both directions and return Options", () => {
  const project = checkText(`
type Int = int
const shift: Codec<Int, Int> = codec((n: Int): Int => n + 1, (n: Int): Int => n - 1)
const a = (input: unknown): Option<Int> => decode(shift, input)
const b = (n: Int): Option<Int> => encode(shift, n)
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "a").mode, "pure");
});

Deno.test("codec rejects effectful transformations", () => {
  const project = checkText(`
service S { read(): Int }
const bad = codec((n: Int): Int uses S.read => n + S.read(), (n: Int): Int => n)
type Int = int
`);
  assert(codes(project).includes("execution-mode/001"));
});

Deno.test("withFiber joins a supervised child and rejects handle escape", () => {
  const good = checkText(`
error Stop = {}
service Jobs { next(): Int fails Stop }
const run = (): Int fails Stop uses Jobs.next =>
  withFiber(defer(() => Jobs.next()), (fiber) => joinFiber(fiber))
type Int = int
`);
  assertEquals(messages(good), []);
  assertEquals(shortIds(fn(good, "m", "run").body!.failures), ["Stop"]);
  const bad = checkText(`
const escape = (): Fiber<Int, never> => withFiber(defer(() => 1), (fiber) => fiber)
type Int = int
`);
  assert(codes(bad).includes("type-mismatch/010"));
});

Deno.test("opaque handles require borrowed host parameters and cannot escape", () => {
  const files = {
    "effective.json": JSON.stringify({
      host: { files: { interface: "./host.effi", module: "./host.ts" } },
    }),
    "host.effi": `
export opaque type Handle
export type Text = string
export service Files {
  open(): Handle
  read(borrow handle: Handle): Text
  plain(handle: Handle): Text
  close(borrow handle: Handle): void
}
`,
    "main.eff": `
import { Handle, Text, Files } from "host:files"
const readBorrowed = (borrow handle: Handle): Text uses Files.read => Files.read(handle)
const good = (): Text uses Files.open | Files.read | Files.close =>
  withResource(() => Files.open(), (handle) => readBorrowed(handle), (handle) => Files.close(handle))
const bad = (): Text uses Files.open | Files.plain | Files.close =>
  withResource(() => Files.open(), (handle) => Files.plain(handle), (handle) => Files.close(handle))
`,
  };
  const project = checkFiles(files, ["main.eff"]);
  assertEquals(codes(project), ["type-mismatch/010"]);
  const escaped = checkFiles({
    ...files,
    "main.eff": `
import { Handle, Text, Files } from "host:files"
const bad = (): Handle uses Files.open | Files.close =>
  withResource(() => Files.open(), (handle) => handle, (handle) => Files.close(handle))
`,
  }, ["main.eff"]);
  assert(codes(escaped).includes("type-mismatch/010"));
  const forged = checkFiles({
    ...files,
    "main.eff": `
import { Handle } from "host:files"
const forged = (): Handle => Handle(1)
`,
  }, ["main.eff"]);
  assert(codes(forged).includes("type-mismatch/010"));
});

const HOST = {
  "effective.json": JSON.stringify({
    host: {
      providers: { interface: "./host/providers.effi", module: "./live.ts" },
    },
  }),
  "svc.eff": `
export error Down = { m: string }
export service Db {
  read(): Int fails Down
  write(n: Int): void
}
type Int = int
`,
  "host/providers.effi": `
import { Db, Down } from "../svc.eff"
export provider DbLive provides Db fails Down
`,
};

Deno.test("provide with a host provider has the callback's failures and the acquisition failures", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Db, Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const run = (): Int fails Down =>
  provide(DbLive, () => Db.read())
export const bad = (): Int fails Down uses Db.read =>
  provide(DbLive, () => Db.read())
type Int = int
`,
  }, ["main.eff"]);
  assertEquals(messages(project), []);
  const run = fn(project, "main", "run");
  assertEquals(run.body!.requirements, []);
  assertEquals(shortIds(run.body!.failures), ["Down"]);
  assertEquals(fn(project, "main", "bad").mode, "effect");
});

Deno.test("provide needs a host provider and a zero-argument job", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Db, Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const a = (n: Int): Int fails Down => provide(n, () => 1)
export const b = (): Int fails Down => provide(DbLive, (n: Int) => n)
export const c = (): Int fails Down => provide(DbLive)
type Int = int
`,
  }, ["main.eff"]);
  assertEquals(codes(project), [
    "type-mismatch/010",
    "type-mismatch/010",
    "type-mismatch/004",
  ]);
});

Deno.test("a provide with empty sets still has effect mode", () => {
  const project = checkFiles({
    ...HOST,
    "main.eff": `
import { Down } from "./svc.eff"
import { DbLive } from "host:providers"
export const run = (): Int fails Down => provide(DbLive, () => 1)
const quiet = (): Int => provide(DbLive, () => 1)
type Int = int
`,
  }, ["main.eff"]);
  // quiet fails with Down, which its empty fails clause does not list.
  assertEquals(codes(project), ["failure-contract/001"]);
  assertEquals(fn(project, "main", "quiet").mode, "effect");
});

// ------------------------------------------------------------------ try and catch

Deno.test("catch removes handled tags and unions the handler sets", () => {
  const project = checkText(`
error A = { m: string }
error B = { m: string }
error C = { m: string }
const raise = (): Int fails A | B => fail(A({ m: "x" }))
const f = (): Int fails C =>
  try { raise() } catch {
    A(a) => 1,
    B(b) => fail(C({ m: b.m }))
  }
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.failures), ["C"]);
});

Deno.test("an unhandled tag continues to the caller", () => {
  const project = checkText(`
error A = { m: string }
error B = { m: string }
const raise = (): Int fails A | B => fail(A({ m: "x" }))
const f = (): Int fails A =>
  try { raise() } catch {
    A(a) => 1
  }
type Int = int
`);
  assertEquals(codes(project), ["failure-contract/001"]);
  assert(project.diagnostics[0].message.includes("B"));
});

Deno.test("successful and handled paths need a common type", () => {
  const project = checkText(`
error A = { m: string }
const raise = (): Int fails A => fail(A({ m: "x" }))
const f = (): Int =>
  try { raise() } catch {
    A(a) => "none"
  }
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("handlers evaluate as effect mode even when nothing can fail", () => {
  const project = checkText(`
error A = { m: string }
const f = (): Int => try { 1 } catch { A(a) => 2 }
type Int = int
`);
  assertEquals(codes(project), ["failure-contract/002"]);
  assertEquals(fn(project, "m", "f").mode, "effect");
});

// ------------------------------------------------------------------ match

Deno.test("match on an option needs Some and None", () => {
  const project = checkText(`
const a = (o: Option<Int>): Int => match o { Some(x) => x, None => 0 }
const b = (o: Option<Int>): Int => match o { Some(x) => x }
const c = (o: Option<Int>): Int => match o { None => 0, _ => 1 }
const d = (o: Option<Int>): Int => match o { Some(x) => x, None => 0, _ => 1 }
type Int = int
`);
  assertEquals(codes(project), ["pattern/001", "pattern/002"]);
});

Deno.test("match on literals and booleans needs every value or a wildcard", () => {
  const project = checkText(`
type Color = "red" | "green"
const a = (c: Color): Int => match c { "red" => 1, "green" => 2 }
const b = (c: Color): Int => match c { "red" => 1 }
const c = (b: Bool): Int => match b { true => 1, false => 0 }
const d = (b: Bool): Int => match b { true => 1 }
const e = (c: Color): Int => match c { "red" => 1, "green" => 2, "blue" => 3 }
const f = (c: Color): Int => match c { "red" => 1, "red" => 2, "green" => 3 }
type Int = int
type Bool = boolean
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/001",
    "pattern/003",
    "pattern/002",
  ]);
});

Deno.test("match on a primitive needs a final wildcard", () => {
  const project = checkText(`
const a = (n: Int): Text => match n { 0 => "zero", _ => "many" }
const b = (n: Int): Text => match n { 0 => "zero", 1 => "one" }
const c = (s: Text): Int => match s { "a" => 1, _ => 2 }
const d = (s: Text): Int => match s { 1 => 1, _ => 2 }
type Int = int
type Text = string
`);
  assertEquals(codes(project), ["pattern/001", "pattern/003"]);
});

Deno.test("match on a tagged record union binds the narrowed record", () => {
  const project = checkText(`
type Shape = { kind: "circle", radius: number } | { kind: "square", side: number }
const extent = (s: Shape): Num =>
  match s {
    { kind: "circle", ...c } => c.radius,
    { kind: "square", ...q } => q.side
  }
const missing = (s: Shape): Num =>
  match s {
    { kind: "circle", ...c } => c.radius
  }
const wrong = (s: Shape): Num =>
  match s {
    { kind: "circle", ...c } => c.side,
    { kind: "square" } => 1
  }
const foreign = (s: Shape): Num =>
  match s {
    { kind: "circle" } => 1,
    { kind: "square" } => 2,
    { kind: "hex" } => 3
  }
type Num = number
`);
  assertEquals(codes(project), [
    "pattern/001",
    "type-mismatch/006",
    "pattern/003",
  ]);
  const facts = factsOf(project, "m", "extent").filter((f) =>
    f.kind === "pattern"
  );
  assert(facts[0].kind === "pattern" && facts[0].pattern.kind === "tag");
  assertEquals(facts[0].pattern.field, "kind");
  assertEquals(facts[0].pattern.value, "circle");
  assertEquals(facts[0].pattern.binding, "local:m#extent/c");
});

Deno.test("match on an error union uses error patterns", () => {
  const project = checkText(`
error A = { m: string }
error B = { n: int }
const label = (e: A | B): Text =>
  match e {
    A(a) => a.m,
    B(b) => "b"
  }
const partial = (e: A | B): Text => match e { A(a) => a.m }
const foreign = (e: A): Text => match e { B(b) => "b" }
type Text = string
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/001",
    "pattern/003",
  ]);
});

Deno.test("a match subject evaluates once and its arms union their effects", () => {
  const project = checkText(`
service S {
  find(): Option<Int>
  other(): Int
}
const f = (): Int uses S.find | S.other =>
  match S.find() { Some(x) => x, None => S.other() }
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "m", "f").body!.requirements), [
    "S.find",
    "S.other",
  ]);
});

Deno.test("constructor patterns without a binding are pattern errors", () => {
  const project = checkText(`
error A = { m: string }
const f = (o: Option<Int>): Int => match o { Some => 1, None => 0 }
const g = (e: A): Int => match e { A => 1 }
type Int = int
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/004",
    "pattern/001",
    "pattern/004",
  ]);
});

// ------------------------------------------------------------------ blocks and bindings

Deno.test("a block ending with a binding is void and a block binding checks its annotation", () => {
  const project = checkText(`
const a = (): void => {
  const x = 1
}
const b = (): Int => {
  const x: Int = "s"
  x
}
const c = (): Int => {
  const x = 1
}
const d = (): void => {}
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/003", "type-mismatch/003"]);
});

Deno.test("a local function can be called and infers its contract", () => {
  const project = checkText(`
const f = (n: Int): Int => {
  const twice = (k: Int) => k * 2
  twice(n)
}
type Int = int
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "m", "f").mode, "pure");
});

Deno.test("a local function cannot call itself", () => {
  const project = checkText(`
const f = (n: Int): Int => {
  const loop = (k: Int): Int => loop(k)
  loop(n)
}
type Int = int
`);
  assertEquals(codes(project), ["execution-mode/003"]);
});

Deno.test("creating a closure is pure and invoking it carries the effects", () => {
  const project = checkText(`
service S { a(): Int }
const f = (): () => Int =>
  () => S.a()
type Int = int
`);
  // The returned function has the default effect execution of an annotation, so
  // the closure with requirements does not fit a type that lists none.
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a closure construction has pure mode and empty sets", () => {
  const project = checkText(`
service S { a(): Int }
const f = (): Int uses S.a => {
  const g = () => S.a()
  g()
}
type Int = int
`);
  assertEquals(messages(project), []);
  const table = fn(project, "m", "f").table;
  const arrows = nodesOfKind(project, "m", SyntaxKind.ArrowExpr);
  const inner = arrows.map((n) => table.info.get(n)).filter((i) =>
    i !== undefined
  );
  assert(inner.length >= 1);
  assertEquals(inner[0]!.mode, "pure");
  assertEquals(inner[0]!.failures, []);
  assertEquals(inner[0]!.requirements, []);
});

// ------------------------------------------------------------------ recovery

Deno.test("an unknown name gives one unknown-name diagnostic and no cascade", () => {
  const project = checkText(`
const f = (n: Int): Int => missing(n) + 1
const g = (n: Int): Text => missing.field
type Int = int
type Text = string
`);
  assertEquals(codes(project), ["unknown-name/001", "unknown-name/001"]);
});

Deno.test("an unknown operand of -, *, or / gives no cascade", () => {
  const project = checkText(`
const a: Int = missing - 1
const b: Int = missing * 2
const c: Int = missing / 2
type Int = int
`);
  assertEquals(codes(project), [
    "unknown-name/001",
    "unknown-name/001",
    "unknown-name/001",
  ]);
});

Deno.test("a declaration with a syntax error does not hide a later declaration", () => {
  const project = checkText(`
const broken = (n: Int): Int => n +
const fine = (n: Int): Int => "text"
type Int = int
`);
  assert(codes(project).includes("type-mismatch/003"));
  assert(codes(project).some((c) => c.startsWith("syntax/")));
});

Deno.test("checking never throws on a prefix of every example", () => {
  const files = exampleFiles();
  for (const path of EXAMPLE_ENTRIES) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 60));
    for (let n = 0; n <= text.length; n += step) {
      const edited = { ...files, [path]: text.slice(0, n) };
      const result = checkProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
    }
  }
});

Deno.test("checking never throws when one character of an example is deleted", () => {
  const files = exampleFiles();
  for (const path of EXAMPLE_ENTRIES) {
    const text = files[path];
    const step = Math.max(1, Math.floor(text.length / 60));
    for (let i = 0; i < text.length; i += step) {
      const edited = {
        ...files,
        [path]: text.slice(0, i) + text.slice(i + 1),
      };
      const result = checkProject(memoryHost(edited), "", EXAMPLE_ENTRIES);
      assert(result.ok);
    }
  }
});

// ------------------------------------------------------------------ interfaces

Deno.test("a body edit that keeps the mode leaves the importing module's interface and the hash unchanged", () => {
  const before = examples().modules.get("users")!.hash;
  const files = exampleFiles();
  files["users.eff"] = files["users.eff"].replace(
    "Some(user) => user,",
    "Some(found) => found,",
  );
  const edited = checkProject(memoryHost(files), "", EXAMPLE_ENTRIES);
  assert(edited.ok);
  assertEquals(codes(edited.value), []);
  assertEquals(edited.value.modules.get("users")!.hash, before);
});

Deno.test("a mode change of an exported function changes the interface hash", () => {
  const base = `
export const f = (n: Int): Int => n
type Int = int
`;
  const effectful = `
export const f = (n: Int): Int => retry(() => n, { times: 1 })
type Int = int
`;
  const a = checkFiles({ "effective.json": "{}", "m.eff": base }, ["m.eff"]);
  const b = checkFiles({ "effective.json": "{}", "m.eff": effectful }, [
    "m.eff",
  ]);
  assert(a.modules.get("m")!.hash !== b.modules.get("m")!.hash);
});

Deno.test("a binding annotation with a function type supplies the signature and the mode", () => {
  const project = checkText(`
const inc: (n: Int) => Int = (n) => n + 1
const bad: (n: Int) => Int = (n) => "x"
const use = (xs: Int[]): Int[] => xs |> map(inc)
type Int = int
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assertEquals(fn(project, "m", "inc").mode, "pure");
});

Deno.test("a service stage with extra arguments and a brand stage are performs and constructions", () => {
  const project = checkText(`
type Id = Brand<string>
service S { put(a: Int, b: Int): void }
const f = (n: Int): void uses S.put => n |> S.put(2)
const g = (s: Text): Id => s |> Id
type Int = int
type Text = string
`);
  assertEquals(messages(project), []);
  assertEquals(factsOf(project, "m", "g").map((x) => x.kind), [
    "brand-construction",
  ]);
});

/** A record type nested `levels` times with the given leaf, as source text. */
function deepRecord(levels: number, leaf: string): string {
  return "{ a: ".repeat(levels) + leaf + " }".repeat(levels);
}

Deno.test("a record type 300 levels deep compares int to number with no diagnostic", () => {
  const project = checkText(`
const f = (x: ${deepRecord(300, "Num")}): Int => 1
const g = (y: ${deepRecord(300, "Int")}): Int => f(y)
type Int = int
type Num = number
`);
  assertEquals(messages(project), []);
});

Deno.test("a chain of 5000 aliases gives declaration/012 and no exception", () => {
  const lines = ["const v = (x: A0): Int => 1"];
  for (let i = 0; i < 4999; i++) lines.push(`type A${i} = A${i + 1}`);
  lines.push("type A4999 = int");
  lines.push("type Int = int");
  const project = checkText(lines.join("\n"));
  assert(codes(project).includes("declaration/012"));
  assert(codes(project).every((code) => code === "declaration/012"));
});

// ------------------------------------------------------------------ record brands

const NOMINAL_RECORDS = `
type UserId = Brand<string>
type User = Brand<{ id: UserId, name: string, active: boolean, nickname?: string }>
type Dog = { id: UserId, name: string, active: boolean, nickname?: string }
const nameOf = (user: User): Text => user.name
const nick = (user: User): Text =>
  match user.nickname {
    Some(n) => n,
    None => "none"
  }
const activate = (user: User): User => ({ ...user, active: true })
type Text = string
`;

Deno.test("a field read and a record update see through a brand of a record", () => {
  const project = checkText(NOMINAL_RECORDS);
  assertEquals(messages(project), []);
  const activate = fn(project, "m", "activate");
  const type = project.table.node(activate.type);
  assert(type.kind === "function");
  const update = nodesOfKind(project, "m", SyntaxKind.RecordExpr)
    .map((n) => activate.table.info.get(n))
    .find((info) => info !== undefined);
  assert(update !== undefined);
  assertEquals(update.type, type.result);
  const result = project.table.node(update.type);
  assert(result.kind === "named");
  assert(result.id.endsWith("#User"), result.id);
});

Deno.test("a record brand stays nominal against a structural record of equal fields", () => {
  const project = checkText(`${NOMINAL_RECORDS}
const dog: Dog = { id: UserId("d1"), name: "barki", active: false }
const wrong = (): User => activate(dog)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a record update through a brand rejects a field that the base lacks", () => {
  const project = checkText(`${NOMINAL_RECORDS}
const owned = (user: User): User => ({ ...user, owner: "x" })
`);
  assertEquals(codes(project), ["type-mismatch/005"]);
});

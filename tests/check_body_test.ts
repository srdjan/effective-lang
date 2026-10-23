// Tests for part A3b: expression checking, effects, modes, contracts, patterns,
// the initialization graph, and the hover text of a checked node. Each test runs through the public entry
// `checkProject`.

import { assert, assertEquals } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
} from "../src/core/check_project.ts";
import { Program } from "../src/core/db.ts";
import { hoverAt } from "../src/core/editor.ts";
import {
  buildInterface,
  buildTypeGraph,
  reachableModules,
} from "../src/core/interface.ts";
import type { TypeGraph } from "../src/core/check.ts";
import { solveModeGroup } from "../src/core/modes.ts";
import type { Execution, ValueId } from "../src/core/ir.ts";
import { memoryHost, spanText } from "../src/core/source.ts";
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

/** The hover contract of `m.eff` at an offset, through the public editor query. */
function hoverContract(text: string, offset: number): string | undefined {
  const result = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(result.ok, JSON.stringify(result));
  return hoverAt(result.value, "m.eff", offset)?.contract;
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

Deno.test("mapGroups checks primitive key classes and direct terminal group uses", () => {
  const project = checkText(`
type Int = int
nominal Key = string
type Alias = Key
type Choice = "a" | "b"
type Bool = boolean
const one: Sink<Int, Int[], never, never, Int> = takeSink(1)
const byBrand = (source: Stream<Alias>): Stream<Alias[]> => mapGroups(source, (n) => n, (key, group) => collectStream(group), { bufferSize: 1 })
const byLiteral = (source: Stream<Choice>): Stream<Choice> => mapGroups(source, (n) => n, (key, group) => { drainStream(group); key }, { bufferSize: 2 })
const byBool = (source: Stream<Bool>): Stream<Bool> => mapGroups(source, (n) => n, (key, group) => key, { bufferSize: 1 })
const first = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => headStream(group), { bufferSize: 1 })
const last = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => lastStream(group), { bufferSize: 1 })
const folded = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => foldStream(group, 0, (sum, n) => sum + n), { bufferSize: 1 })
const effectFold = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => foldEffectStream(group, 0, (sum, n) => sum + n), { bufferSize: 1 })
const sink = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => runStream(group, one), { bufferSize: 1 })
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "first").mode, "pure");
});

Deno.test("mapGroups defers callback channels and discharges only callback Scope", () => {
  const project = checkText(`
type Int = int
error SourceStop = {}
error UseStop = {}
error BuildStop = {}
service Pull { next(): void }
service Use { value(n: Int): Int fails UseStop; worker(): void }
service Factory { source(): Stream<Int, SourceStop, Pull.next> fails BuildStop }
const make = (): Stream<Int, SourceStop | UseStop, Pull.next | Use.value | Use.worker>
 fails BuildStop uses Factory.source =>
 mapGroups(Factory.source(), (n) => n, (key, group) => {
   forkScoped(defer(() => Use.worker()))
   drainStream(group)
   Use.value(key)
 }, { bufferSize: 1 })
const runIt = (): Int[] fails BuildStop | SourceStop | UseStop
 uses Factory.source | Pull.next | Use.value | Use.worker => collectStream(make())
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("mapGroups rejects structural, mixed, general number, and impure keys", () => {
  for (
    const key of [
      "(n) => ({ n })",
      "(n): Num => n",
      "(n) => [n]",
      "(n) => Some(n)",
      '(n) => if (n === 0) { "zero" } else { 1 }',
      '(n) => if (n === 0) { A("a") } else { B("b") }',
      '(n): A | Text => if (n === 0) { A("a") } else { "a" }',
      "(n) => Read.key(n)",
      "(n): never => fail(Stop({}))",
    ]
  ) {
    const project = checkText(`type Int = int
type Num = number
type Text = string
nominal A = string
nominal B = string
error Stop = {}
service Read { key(n: Int): Int }
const bad = (source: Stream<Int>) => mapGroups(source, ${key}, (key, group) => key, { bufferSize: 1 })`);
    assert(project.diagnostics.length > 0, key);
    assert(
      !codes(project).includes("syntax/001"),
      messages(project).join("\n"),
    );
  }
});

Deno.test("mapGroups prevents aliasing, storage, repeated reads, helper calls, and captures", () => {
  for (
    const use of [
      "(key, group) => group",
      "(key, group) => ({ group })",
      "(key, group) => { const alias = group; drainStream(alias); key }",
      "(key, group) => { const saved = makeRef(group); key }",
      "(key, group) => { const record = { group }; key }",
      "(key, group) => { const tuple: [Stream<Int>] = [group]; key }",
      "(key, group) => { setRef(saved, group); key }",
      "(key, group) => { drainStream(group); headStream(group) }",
      "(key, group) => if (key === 0) { headStream(group) } else { lastStream(group) }",
      "(key, group) => helper(group)",
      "(key, group) => { drainStream(takeStream(group, 1)); key }",
      "(key, group) => { run(defer(() => drainStream(group))); key }",
      "(key, group) => { forkScoped(defer(() => drainStream(group))); key }",
      "(key, group) => { foldStream(other, 0, (sum, n) => { drainStream(group); sum }); key }",
      "(key, group: unknown) => key",
    ]
  ) {
    const project = checkText(`type Int = int
const helper = (s: Stream<Int>): Int => { drainStream(s); 1 }
const bad = (source: Stream<Int>, other: Stream<Int>, saved: Ref<Stream<Int>>) =>
 mapGroups(source, (n) => n, ${use}, { bufferSize: 1 })`);
    assert(
      codes(project).includes("type-mismatch/010"),
      `${use}\n${messages(project).join("\n")}`,
    );
  }
  const shadowed = checkText(`type Int = int
const headStream = (source: Stream<Int>): Int => 1
const bad = (source: Stream<Int>) => mapGroups(source, (n) => n, (key, group) => headStream(group), { bufferSize: 1 })`);
  assert(
    codes(shadowed).includes("type-mismatch/010"),
    messages(shadowed).join("\n"),
  );
});

Deno.test("mapGroups requires inline callbacks and a literal positive per-key bound", () => {
  for (
    const options of [
      "{}",
      "{ bufferSize: 0 }",
      "{ bufferSize: 0 - 1 }",
      "{ bufferSize: 1.5 }",
      "{ bufferSize: 9007199254740992 }",
      "{ bufferSize: count }",
      "{ bufferSize: 1, concurrency: 2 }",
      "options",
    ]
  ) {
    const project = checkText(`type Int = int
const bad = (source: Stream<Int>, count: Int, options: { bufferSize: Int }) => mapGroups(source, (n) => n, (key, group) => key, ${options})`);
    assert(
      codes(project).includes("type-mismatch/010"),
      `${options}: ${messages(project)}`,
    );
  }
  for (
    const call of [
      "mapGroups(source, key, (key, group) => key, { bufferSize: 1 })",
      "mapGroups(source, (n) => n, use, { bufferSize: 1 })",
      "source |> mapGroups((n: Int) => n, (key: Int, group: Stream<Int>) => key, { bufferSize: 1 })",
      "mapGroups(source, (n) => n)",
    ]
  ) {
    const project = checkText(`type Int = int
const key = (n: Int): Int => n
const use = (key: Int, group: Stream<Int>): Int => key
const bad = (source: Stream<Int>) => ${call}`);
    assert(project.diagnostics.length > 0, call);
  }
  const shadowed = checkText(
    "type Int = int\nconst mapGroups = (n: Int): Int => n\nconst use = (): Int => mapGroups(1)",
  );
  assertEquals(codes(shadowed), [], messages(shadowed).join("\n"));
});

Deno.test("takeSink infers input from bindings, returns, calls, and transduction", () => {
  const project = checkText(`
type Int = int
type Pairs = Sink<Int, Int[], never, never, Int>
const pairs: Pairs = takeSink(2)
const make = (): Pairs => takeSink(2)
const identity = (sink: Pairs): Pairs => sink
const viaCall = (): Pairs => identity(takeSink(2))
const batch = (source: Stream<Int>): Stream<Int[]> => transduceStream(source, pairs)
const inline = (source: Stream<Int>): Stream<Int[]> => transduceStream(source, takeSink(2))
const terminal = (source: Stream<Int>): Int[] => runStream(source, pairs)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "batch").mode, "pure");
  assertEquals(fn(project, "m", "terminal").mode, "effect");
});

Deno.test("Sink transduction preserves construction and deferred channels", () => {
  const project = checkText(`
type Int = int
error SourceStop = {}
error SinkStop = {}
error BuildStop = {}
service Pull { next(): void }
service Add { add(): void }
service Factory {
  source(): Stream<Int, SourceStop, Pull.next> fails BuildStop
  sink(): Sink<Int, Int, SinkStop, Add.add, Int>
}
const make = (): Stream<Int, SourceStop | SinkStop, Pull.next | Add.add>
  fails BuildStop uses Factory.source | Factory.sink =>
  transduceStream(Factory.source(), Factory.sink())
const runIt = (): Int[] fails BuildStop | SourceStop | SinkStop
  uses Factory.source | Factory.sink | Pull.next | Add.add => collectStream(make())
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
});

Deno.test("Sink replay checks leftovers against sink input rather than original stream input", () => {
  const prefix =
    `type Text = string\ntype Int = int\ntype Item = string | int\n`;
  const good = checkText(
    prefix + `
const broad = (source: Stream<Text>, sink: Sink<Item, Item[], never, never, Item>): Stream<Item[]> => transduceStream(source, sink)
const terminal = (source: Stream<Int>, sink: Sink<Int, Text, never, never, Text>): Text => runStream(source, sink)
`,
  );
  assertEquals(codes(good), [], messages(good).join("\n"));
  const bad = checkText(
    prefix +
      `const bad = (source: Stream<Int>, sink: Sink<Int, Text, never, never, Text>) => transduceStream(source, sink)`,
  );
  assert(codes(bad).includes("type-mismatch/003"), messages(bad).join("\n"));
});

Deno.test("aggregateStream checks replay and defers source and Sink channels", () => {
  const project = checkText(`
type Int = int
type Text = string
type Item = int | string
type Pairs = Sink<Int, Int[], never, never, Int>
error SourceStop = {}
error SinkStop = {}
error BuildStop = {}
service Pull { next(): void }
service Add { add(): void }
service Factory {
  source(): Stream<Int, SourceStop, Pull.next> fails BuildStop
  sink(): Sink<Int, Int, SinkStop, Add.add, Int>
}
const pairs: Pairs = takeSink(2)
const batches = (source: Stream<Int>): Stream<Int[]> => aggregateStream(source, pairs)
const inline = (source: Stream<Int>): Stream<Int[]> => aggregateStream(source, takeSink(2))
const broad = (source: Stream<Text>, sink: Sink<Item, Item[], never, never, Item>): Stream<Item[]> => aggregateStream(source, sink)
const make = (): Stream<Int, SourceStop | SinkStop, Pull.next | Add.add>
  fails BuildStop uses Factory.source | Factory.sink =>
  aggregateStream(Factory.source(), Factory.sink())
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "batches").mode, "pure");
});

Deno.test("aggregateStream rejects incompatible operands and preserves shadowing", () => {
  const prefix = `type Int = int\ntype Text = string\n`;
  for (
    const body of [
      "const bad = aggregateStream(1, takeSink(2))",
      "const bad = aggregateStream()",
      "const bad = (source: Stream<Int>) => source |> aggregateStream(takeSink(2))",
      "const bad = (source: Stream<Int>, sink: Sink<Text, Int>) => aggregateStream(source, sink)",
      "const bad = (source: Stream<Int>, sink: Sink<Int, Text, never, never, Text>) => aggregateStream(source, sink)",
    ]
  ) {
    const checked = checkText(prefix + body);
    assert(checked.diagnostics.length > 0, body);
    assert(
      !codes(checked).includes("unknown-name/001"),
      messages(checked).join("\n"),
    );
  }
  const shadowed = checkText(`type Int = int
const aggregateStream = (a: Int, b: Int): Int => a + b
const use = (): Int => aggregateStream(1, 2)`);
  assertEquals(codes(shadowed), [], messages(shadowed).join("\n"));
});

Deno.test("general Schedule values retain four channels and scheduled aggregation checks input", () => {
  const source = Deno.readTextFileSync(
    new URL("../fixtures/emit/schedules/main.eff", import.meta.url),
  );
  const project = checkText(source);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "timed").mode, "pure");
  for (
    const body of [
      "const bad = (source: Stream<Int>, policy: Schedule<Int, string>) => aggregateWithinStream(source, takeSink(2), policy)",
      "const bad = (source: Stream<Int>, policy: RetrySchedule<Stop>) => aggregateWithinStream(source, takeSink(2), policy)",
      "const bad = scheduleFromStep((): Int => 0, (state: Int, meta: ScheduleInput<Int>): Int => state)",
      "const bad = (source: Stream<Int>) => source |> aggregateWithinStream(takeSink(2), scheduleRecurs(0))",
    ]
  ) {
    const checked = checkText(`type Int = int\nerror Stop = {}\n${body}`);
    assert(checked.diagnostics.length > 0, body);
    assert(
      !codes(checked).includes("unknown-name/001"),
      messages(checked).join("\n"),
    );
  }
  const shadowed = checkText(`type Int = int
const scheduleRecurs = (n: Int): Int => n
const use = (): Int => scheduleRecurs(1)`);
  assertEquals(codes(shadowed), [], messages(shadowed).join("\n"));
});

Deno.test("Schedule composition keeps comparable input, output, and deferred channels", () => {
  const source = Deno.readTextFileSync(
    new URL("../fixtures/emit/schedules/composition.eff", import.meta.url),
  );
  const project = checkText(source);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "assembled").mode, "effect");
  for (
    const body of [
      "const bad = scheduleMax(scheduleRecurs(1), 1)",
      "const bad = scheduleMin()",
      "const bad = (a: Schedule<Int, string>, b: Schedule<Int, Int>) => scheduleConcat(a, b)",
      "const bad = (a: Schedule<Int, string>) => a |> scheduleMax(scheduleRecurs(1))",
    ]
  ) {
    const checked = checkText(`type Int = int\n${body}`);
    assert(checked.diagnostics.length > 0, body);
    assert(
      !codes(checked).includes("unknown-name/001"),
      messages(checked).join("\n"),
    );
  }
  const shadowed = checkText(`type Int = int
const scheduleMax = (a: Int, b: Int): Int => a + b
const use = (): Int => scheduleMax(1, 2)`);
  assertEquals(codes(shadowed), [], messages(shadowed).join("\n"));
});

Deno.test("takeSink rejects invalid counts, erased leftovers, pipelines, and borrowed captures", () => {
  for (
    const body of [
      "const bad = takeSink(2)",
      "const bad: Sink<Int, Int[]> = takeSink(2)",
      "const bad: Pairs = takeSink(0)",
      "const bad: Pairs = takeSink(-1)",
      "const bad: Pairs = takeSink(1.5)",
      "const count = 2; const bad: Pairs = takeSink(count)",
      "const bad: Pairs = takeSink()",
      "const bad: Pairs = 2 |> takeSink",
      "const bad = (s: Stream<Int>) => s |> transduceStream(takeSink(2))",
      "const bad = () => withFiber(defer(() => 1), (fiber) => takeSink(2))",
      "const bad = (s: Stream<Int>) => withFiber(defer(() => 1), (fiber) => { collectStream(transduceStream(s, sinkForEach((n: Int) => interruptFiber(fiber)))) })",
    ]
  ) {
    const project = checkText(
      `type Int = int\ntype Pairs = Sink<Int, Int[], never, never, Int>\n${body}`,
    );
    assert(project.diagnostics.length > 0, body);
    assert(
      !codes(project).includes("unknown-name/001"),
      messages(project).join("\n"),
    );
  }
  const shadowed = checkText(`type Int = int
const takeSink = (n: Int): Int => n
const transduceStream = (a: Int, b: Int): Int => a + b
const use = (): Int => transduceStream(takeSink(2), 3)`);
  assertEquals(codes(shadowed), [], messages(shadowed).join("\n"));
});

Deno.test("Sink leftover graphs reach private aliases, update hashes, and reject recursion", () => {
  const project = (tail: string) =>
    checkFiles({
      "effective.json": "{}",
      "a.eff":
        `type Tail = ${tail}\nexport type S = Sink<int, int, never, never, Tail>`,
      "b.eff":
        `import { S } from "./a.eff"\nexport const identity = (sink: S): S => sink`,
    }, ["b.eff"]);
  const before = project("string");
  const after = project("boolean");
  assertEquals(codes(before), []);
  assertEquals(codes(after), []);
  assert(before.modules.get("b")!.hash !== after.modules.get("b")!.hash);
  const old = checkText("export type S = Sink<int, int>");
  const explicit = checkText(
    "export type S = Sink<int, int, never, never, never>",
  );
  assertEquals(old.modules.get("m")!.hash, explicit.modules.get("m")!.hash);
  const recursive = checkText("type Loop = Sink<int, int, never, never, Loop>");
  assert(
    codes(recursive).includes("declaration/007"),
    messages(recursive).join("\n"),
  );
});

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

Deno.test("takeWhileEffectStream with a pure callback preserves deferred channels and the stream alias", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeWhileEffectStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = takeWhileEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
type Bool = boolean
service Probe { accept(n: Int): Bool }
const bad = takeWhileEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assertEquals(codes(effectful), [], messages(effectful).join("\n"));

  const wrongSource = checkText(`
type Int = int
const bad = takeWhileEffectStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("dropWhileEffectStream with a pure callback preserves deferred channels and the stream alias", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = dropWhileEffectStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = dropWhileEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
type Bool = boolean
service Probe { accept(n: Int): Bool }
const bad = dropWhileEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assertEquals(codes(effectful), [], messages(effectful).join("\n"));

  const wrongSource = checkText(`
type Int = int
const bad = dropWhileEffectStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("takeUntilEffectStream with a pure callback preserves deferred channels and the stream alias", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeUntilEffectStream(source, (n) => n === 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = takeUntilEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
type Bool = boolean
service Probe { accept(n: Int): Bool }
const bad = takeUntilEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assertEquals(codes(effectful), [], messages(effectful).join("\n"));

  const wrongSource = checkText(`
type Int = int
const bad = takeUntilEffectStream(3, (n) => n === 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("filterEffectStream with a pure callback preserves deferred channels and the stream alias", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = filterEffectStream(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const wrongResult = checkText(`
type Int = int
const bad = filterEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => n + 1)
`);
  assert(codes(wrongResult).includes("type-mismatch/003"));

  const effectful = checkText(`
type Int = int
type Bool = boolean
service Probe { accept(n: Int): Bool }
const bad = filterEffectStream(unfold(0, (n): Option<[Int, Int]> => None), (n) => Probe.accept(n))
`);
  assertEquals(codes(effectful), [], messages(effectful).join("\n"));

  const wrongSource = checkText(`
type Int = int
const bad = filterEffectStream(3, (n) => n < 3)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));
});

Deno.test("a pure stream predicate keeps the stream alias and an effectful one widens it", () => {
  const header = `
type Int = int
type Bool = boolean
service Source { next(n: Int): Option<[Int, Int]> }
service Probe { accept(n: Int): Bool }
type Ints = Stream<Int, never, Source.next>
const source: Ints = unfold(0, (n) => Source.next(n))
`;
  for (
    const name of [
      "filterEffectStream",
      "takeWhileEffectStream",
      "takeUntilEffectStream",
      "dropWhileEffectStream",
    ]
  ) {
    const kept = checkText(
      `${header}const c: Ints = ${name}(source, (n) => n < 3)\n`,
    );
    assertEquals(codes(kept), [], messages(kept).join("\n"));
    const widened = checkText(
      `${header}const c: Ints = ${name}(source, (n) => Probe.accept(n))\n`,
    );
    assertEquals(codes(widened), ["type-mismatch/003"], name);
  }
  const mapped = checkText(
    `${header}const c: Stream<Bool, never, Source.next> = mapEffect(source, (n) => n < 3)\n`,
  );
  assertEquals(codes(mapped), [], messages(mapped).join("\n"));
});

Deno.test("mapEffect with a pure callback changes the element type and preserves deferred channels", () => {
  const valid = checkText(`
type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const mapped: Stream<Bool, Stop, Source.next> = mapEffect(source, (n) => n < 3)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));

  const effectful = checkText(`
type Int = int
service Probe { next(n: Int): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapEffect(source, (n) => Probe.next(n))
`);
  assertEquals(codes(effectful), [], messages(effectful).join("\n"));

  const wrongSource = checkText(`
type Int = int
const bad = mapEffect(3, (n) => n + 1)
`);
  assert(codes(wrongSource).includes("type-mismatch/010"));

  const nonInline = checkText(`
type Int = int
const convert = (n: Int): Int => n + 1
const source = unfold(0, (n): Option<[Int, Int]> => None)
const bad = mapEffect(source, convert)
`);
  assert(codes(nonInline).includes("type-mismatch/010"));
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

Deno.test("temporal stream controls validate literal settings and deferred channels", () => {
  const valid = checkText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const debounced = debounceStream(source, 0)
const shaped = throttleStream(debounced, { units: 2, durationMs: 100, strategy: "shape" })
const enforced = throttleStream(source, { strategy: "enforce", durationMs: 100, units: 1 })
const main = (): Int[] fails Stop uses Source.next => collectStream(shaped)
`);
  assertEquals(codes(valid), [], messages(valid).join("\n"));
  for (
    const [expression, expected] of [
      ["debounceStream(source, -1)", "syntax/010"],
      [
        'throttleStream(source, { units: 0, durationMs: 100, strategy: "shape" })',
        "type-mismatch/010",
      ],
      [
        'throttleStream(source, { units: 1, durationMs: 0, strategy: "shape" })',
        "type-mismatch/010",
      ],
      [
        'throttleStream(source, { units: 1, durationMs: 100, strategy: "drop" })',
        "type-mismatch/010",
      ],
    ] as const
  ) {
    const bad = checkText(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const source = unfold(0, (n) => Source.next(n))
const bad = ${expression}
`);
    assert(codes(bad).includes(expected), expression);
  }
  const shadow = checkText(`
type Int = int
const debounceStream = (): Int => 1
const throttleStream = (): Int => 2
const use = (): Int => debounceStream() + throttleStream()
`);
  assertEquals(codes(shadow), [], messages(shadow).join("\n"));
});

Deno.test("common stream terminals and observation compose from core forms", () => {
  const project = checkText(`
type Int = int
type Count = number
type Bool = boolean
service Source { next(n: Int): Option<[Int, Int]> }
service Worker { inspect(n: Int): void; keep(n: Int): Bool }
const source = unfold(0, (n) => Source.next(n))
const tapped = mapEffect(source, (n) => { Worker.inspect(n); n })
const seed: Count = 0
const counted = (): Count uses Source.next => foldStream(source, seed, (count, _) => count + 1)
const each = (): void uses Source.next | Worker.inspect => runStream(source, sinkForEach((n: Int) => Worker.inspect(n)))
const eachWhile = (): void uses Source.next | Worker.keep => drainStream(takeUntilEffectStream(source, (n) => Worker.keep(n) === false))
const observed = (): Int[] uses Source.next | Worker.inspect => collectStream(tapped)
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
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

Deno.test("explicit scopes share authority and retain finalizer service requirements", () => {
  const project = checkText(`
service Jobs { run(): void; release(): void }
type Owner = CloseableScope
const open = (): Owner uses Jobs.run | Jobs.release => {
  const owner = makeScope()
  addScopeFinalizer(owner, defer(() => Jobs.release()))
  provideScope(owner, defer(() => forkScoped(defer(() => Jobs.run()))))
  owner
}
const close = (owner: Owner): void => closeScope(owner)
const share = (owner: Owner) => { const copy = { owner }; () => closeScope(copy.owner) }
const pipeline = (): void => makeScope() |> closeScope
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "open").mode, "effect");
  assertEquals(fn(project, "m", "close").mode, "effect");
});

Deno.test("scope operations check arity, owners, finalizers, and escape boundaries", () => {
  for (
    const expression of [
      "makeScope(1)",
      "closeScope()",
      "closeScope({})",
      "provideScope(makeScope())",
      "provideScope(makeScope(), 1)",
      "addScopeFinalizer(makeScope(), defer(() => 1))",
      "addScopeFinalizer(makeScope(), defer(() => fail(Stop())))",
      "addScopeFinalizer(makeScope(), defer(() => forkScoped(defer(() => 1))))",
      "withFiber(defer(() => 1), (fiber) => makeScope())",
      "withResource(() => ({ close: () => {} }), (file) => ({ owner: makeScope() }), (file) => file.close())",
      "withFiber(defer(() => 1), (fiber) => addScopeFinalizer(makeScope(), defer(() => interruptFiber(fiber))))",
      "withResource(() => ({ close: () => {} }), (file) => addScopeFinalizer(makeScope(), defer(() => file.close())), (file) => file.close())",
      "codec((owner: CloseableScope) => Some(owner), (owner: CloseableScope) => Some(owner))",
      "makeScope() === makeScope()",
    ]
  ) {
    const project = checkText(
      `error Stop = {}\nconst bad = () => ${expression}`,
    );
    assert(project.diagnostics.length > 0, expression);
    assert(
      !codes(project).includes("unknown-name/001"),
      messages(project).join("\n"),
    );
  }
  const generic = checkText("type Bad = CloseableScope<CloseableScope>");
  assert(generic.diagnostics.length > 0);
  const missing = checkText(`service Audit { record(): void }
const bad = (owner: CloseableScope): void => addScopeFinalizer(owner, defer(() => Audit.record()))`);
  assert(
    codes(missing).includes("requirement-contract/001"),
    messages(missing).join("\n"),
  );
});

Deno.test("explicit scope operations obey module and local shadowing", () => {
  const project = checkText(`
type Int = int
const makeScope = (): Int => 1
const provideScope = (a: Int, b: Int): Int => a + b
const addScopeFinalizer = (a: Int, b: Int): Int => a + b
const closeScope = (a: Int): Int => a
const use = (): Int => provideScope(makeScope(), addScopeFinalizer(1, closeScope(2)))
const local = (makeScope: () => Int): Int => makeScope()
`);
  assertEquals(codes(project), [], messages(project).join("\n"));
  assertEquals(fn(project, "m", "use").mode, "pure");
});

Deno.test("provideScope only discharges latent Scope requirements", () => {
  for (
    const expression of [
      "provideScope(owner, makeJob())",
      "provideScope(makeOwner(), defer(() => {}))",
    ]
  ) {
    const project = checkText(`
const makeJob = () => { forkScoped(defer(() => {})); defer(() => {}) }
const makeOwner = () => { forkScoped(defer(() => {})); makeScope() }
const bad = (owner: CloseableScope): void => ${expression}
`);
    assert(
      codes(project).includes("requirement-contract/001"),
      messages(project).join("\n"),
    );
  }
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
  const source = `
nominal Count = int
nominal Price = number
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
`;
  assertEquals(messages(checkText(source)), []);
  const plus = source.indexOf("a + b") + 2;
  assertEquals(hoverContract(source, plus), "Count");
  const minus = source.indexOf("a - b") + 2;
  assertEquals(hoverContract(source, minus), "Count");
  const priceMinus = source.indexOf("a - b", minus + 1) + 2;
  assertEquals(hoverContract(source, priceMinus), "Price");
});

const NOMINAL_OPERANDS = `
nominal Cents = int
nominal Meters = int
nominal Rate = number
nominal UserId = string
nominal Email = string
type Int = int
type Num = number
type Text = string
type Bool = boolean
`;

Deno.test("arithmetic with a numeric brand widens it to its base", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
const times = (a: Cents): Int => a * 2
const plus = (a: Cents): Int => a + 5
const minus = (a: Cents): Int => 5 - a
const divide = (a: Cents): Num => a / 2
const square = (a: Cents): Int => a * a
const scaled = (r: Rate): Num => r * 2
const half = (r: Rate): Num => r / r
const keep = (a: Cents, b: Cents): Cents => a + b
`);
  assertEquals(messages(project), []);
});

Deno.test("arithmetic that widens a brand does not give the brand back", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
const times = (a: Cents, b: Cents): Cents => a * b
const divide = (a: Cents, b: Cents): Cents => a / b
const plain = (a: Cents): Cents => a + 1
`);
  assertEquals(codes(project), Array(3).fill("type-mismatch/003"));
});

Deno.test("arithmetic with two different nominal classes is an error", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
const mixed = (a: Cents, b: Meters): Int => a + b
const product = (a: Cents, b: Meters): Int => a * b
const rate = (a: Cents, r: Rate): Num => a * r
const ids = (id: UserId, email: Email): Text => id + email
`);
  assertEquals(codes(project), Array(4).fill("type-mismatch/007"));
  assertEquals(
    messages(project)[0],
    "type-mismatch/007 the operator `+` does not accept operands of type Cents and Meters",
  );
});

Deno.test("a string brand widens to string for +, and for nothing else", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
const greet = (id: UserId): Text => id + "x"
const lead = (id: UserId): Text => "x" + id
const both = (a: UserId, b: UserId): Text => a + b
const minus = (id: UserId): Text => id - "x"
const times = (id: UserId): Text => id * 2
`);
  assertEquals(codes(project), Array(2).fill("type-mismatch/007"));
});

Deno.test("comparisons need compatible classes, and ordering needs a numeric class", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
const idEq = (id: UserId): Bool => id === "u1"
const idNe = (id: UserId): Bool => "u1" !== id
const sameId = (a: UserId, b: UserId): Bool => a === b
const positive = (a: Cents): Bool => a > 0
const below = (a: Cents, b: Cents): Bool => a < b
const atLeast = (a: Cents, n: Int): Bool => n <= a
const rateAbove = (r: Rate): Bool => r >= 0.5
const otherId = (id: UserId, email: Email): Bool => id === email
const otherCents = (a: Cents, b: Meters): Bool => a < b
const otherEq = (a: Cents, b: Meters): Bool => a !== b
const idText = (id: UserId): Bool => id < "u"
const idNumber = (id: UserId): Bool => id === 1
`);
  assertEquals(codes(project), Array(5).fill("type-mismatch/007"));
  assertEquals(
    project.diagnostics.map((d) => d.message.includes("Cents and Meters")),
    [false, true, true, false, false],
  );
});

Deno.test("operator classes follow widening through a nominal type over a nominal type", () => {
  const project = checkText(`${NOMINAL_OPERANDS}
nominal Tip = Cents
const same = (a: Tip, b: Tip): Bool => a < b
const literal = (a: Tip): Bool => a > 0
const base = (a: Tip, b: Cents): Bool => a <= b
const sum = (a: Tip, b: Int): Int => a + b
const other = (a: Tip, b: Meters): Bool => a < b
`);
  assertEquals(codes(project), ["type-mismatch/007"]);
});

Deno.test("equality takes compatible primitives, literal unions, and matching brands, and rejects records", () => {
  const project = checkText(`
nominal Id = string
nominal Other = string
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

Deno.test("brand construction follows the nominal rules, and unbrand is an unknown name", () => {
  const project = checkText(`
nominal Id = string
type Name = string
const a = (s: Text): Id => Id(s)
const b = (i: Id): Text => i
const c = (n: Int): Id => Id(n)
const d = (s: Text): Id => s
const e = (s: Text): Name => Name(s)
const f = (i: Id): Text => unbrand(i)
type Int = int
type Text = string
`);
  assertEquals(codes(project), [
    "type-mismatch/003",
    "type-mismatch/003",
    "type-mismatch/010",
    "unknown-name/001",
  ]);
  const kinds = factsOf(project, "m", "a").map((f) => f.kind);
  assertEquals(kinds, ["brand-construction"]);
});

const WIDENING = `
type Text = string
type Int = int
nominal UserId = string
nominal Account = { id: UserId, name: Text }
type Fields = { id: UserId, name: Text }
const take = (s: Text): Text => s
const takeFields = (f: Fields): Text => f.name
const make = (): Account => Account({ id: UserId("u1"), name: "Ann" })
`;

Deno.test("a nominal value fits its base in an argument, a return, a field, an array, and an option", () => {
  const project = checkText(`${WIDENING}
type Holder = { text: Text, list: Text[], maybe: Option<Text>, pair: [Text, Int] }
const arg = (id: UserId): Text => take(id)
const ret = (id: UserId): Text => id
const field = (id: UserId): Holder => ({ text: id, list: [id], maybe: Some(id), pair: [id, 1] })
const list = (ids: UserId[]): Text[] => ids
const option = (id: Option<UserId>): Option<Text> => id
const either = (id: UserId): Text | Int => id
const record = (a: Account): Fields => a
const records = (accounts: Account[]): Fields[] => accounts
const call = (a: Account): Text => takeFields(a)
const kept = (id: UserId): UserId | Int => id
const keptText = (id: UserId): UserId | Text => id
`);
  assertEquals(messages(project), []);
});

Deno.test("a base value does not fit a nominal type, and one nominal type does not fit another", () => {
  const project = checkText(`${WIDENING}
nominal Email = string
nominal Twin = { id: UserId, name: Text }
const down = (s: Text): UserId => s
const list = (ss: Text[]): UserId[] => ss
const option = (s: Option<Text>): Option<UserId> => s
const record = (f: Fields): Account => f
const sideways = (id: UserId): Email => id
const twin = (a: Account): Twin => a
const union = (s: Text): UserId | Int => s
`);
  assertEquals(codes(project), Array(7).fill("type-mismatch/003"));
});

Deno.test("an invariant position and a function parameter keep their variance", () => {
  const project = checkText(`${WIDENING}
const ref = (r: Ref<UserId>): Ref<Text> => r
const refBack = (r: Ref<Text>): Ref<UserId> => r
const accepts = (f: (id: Text) => Text): (id: UserId) => Text => f
const rejects = (f: (id: UserId) => Text): (id: Text) => Text => f
const returns = (f: (id: Text) => UserId): (id: Text) => Text => f
`);
  assertEquals(codes(project), Array(3).fill("type-mismatch/003"));
});

Deno.test("an error value does not widen to its record", () => {
  const project = checkText(`
type Text = string
error Failed = { reason: Text }
const wrong = (e: Failed): { reason: Text } => e
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
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
nominal Id = string
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

// ------------------------------------------------------------------ nominal records

const NOMINAL_RECORDS = `
nominal UserId = string
nominal User = { id: UserId, name: string, active: boolean, nickname?: string }
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

Deno.test("a field read and a record update see through a data type", () => {
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

Deno.test("a data type stays nominal against a structural record of equal fields", () => {
  const project = checkText(`${NOMINAL_RECORDS}
const dog: Dog = { id: UserId("d1"), name: "barki", active: false }
const wrong = (): User => activate(dog)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a record update through a data type rejects a field that the base lacks", () => {
  const project = checkText(`${NOMINAL_RECORDS}
const owned = (user: User): User => ({ ...user, owner: "x" })
`);
  assertEquals(codes(project), ["type-mismatch/005"]);
});

// ------------------------------------------------------------------ data types

const DATA_TYPES = `
nominal UserId = string
type Text = string
nominal User = { id: UserId, name: Text, nick?: Text }
nominal Twin = { id: UserId, name: Text, nick?: Text }
nominal Marker = {}
type Dog = { id: UserId, name: Text, nick?: Text }
const user = (): User => User({ id: UserId("u"), name: "Ann" })
`;

Deno.test("a data type is constructed, read, updated, and widened", () => {
  const project = checkText(`${DATA_TYPES}
const nameOf = (u: User): Text => u.name
const nick = (u: User): Option<Text> => u.nick
const rename = (u: User): User => ({ ...u, name: "Bo" })
const base = (u: User): Dog => u
const twin = (u: User): Twin => Twin(u)
const piped = (u: User): Twin => u |> Twin
const marker = (): Marker => Marker({})
`);
  assertEquals(messages(project), []);
  const facts = [...fn(project, "m", "twin").table.facts.values()];
  assert(facts.some((f) => f.kind === "data-construction"));
  const result = fn(project, "m", "rename").type;
  const type = project.table.node(result);
  assert(type.kind === "function");
  const user = project.table.node(type.result);
  assert(user.kind === "named" && user.id === "type:m#User", String(user.kind));
});

Deno.test("a structural record does not fit a data type", () => {
  const project = checkText(`${DATA_TYPES}
const wrong: User = { id: UserId("u"), name: "Ann" }
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a data type fits a structural record of equal fields, and the record does not fit back", () => {
  const project = checkText(`${DATA_TYPES}
const widened = (u: User): Dog => u
const wrong = (d: Dog): User => d
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assertEquals(project.diagnostics[0].message.includes("User"), true);
});

Deno.test("two data types with equal fields are distinct", () => {
  const project = checkText(`${DATA_TYPES}
const wrong = (u: User): Twin => u
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
});

Deno.test("a data constructor takes a data argument of equal fields, and rejects one with other fields", () => {
  const project = checkText(`${DATA_TYPES}
nominal Other = { id: UserId }
const right = (u: User): Twin => Twin(u)
const wrong = (o: Other): Twin => Twin(o)
`);
  assertEquals(codes(project), ["type-mismatch/003"]);
  assertEquals(project.diagnostics[0].message.includes("Twin"), true);
});

Deno.test("a nominal body cannot hold a nominal record or a union with a record", () => {
  const project = checkText(`
type Text = string
type Plain = { id: Text }
nominal Row = { id: Text }
nominal FromRecord = { id: Text }
nominal FromAlias = Plain
nominal FromData = Row
nominal FromUnion = Row | Text
nominal FromAliasLater = Later
type Later = Plain | Text
nominal FromString = Text
nominal FromArray = Plain[]
nominal FromLiterals = "a" | "b"
nominal FromOption = Option<Plain>
nominal FromBrand = FromString
`);
  assertEquals(codes(project), Array(3).fill("declaration/014"));
  assert(project.diagnostics[0].message.includes("declare each record alone"));
});

Deno.test("a data constructor takes one argument", () => {
  const project = checkText(`${DATA_TYPES}
const wrong = (): Marker => Marker()
`);
  assertEquals(codes(project), ["type-mismatch/004"]);
});

Deno.test("a data field named _tag is rejected, as it is in an error", () => {
  const project = checkText(`
nominal Tagged = { _tag: string }
error Failed = { _tag: string }
`);
  assertEquals(codes(project), ["declaration/009", "declaration/009"]);
});

Deno.test("equality rejects data values", () => {
  const project = checkText(`${DATA_TYPES}
type Flag = boolean
const same = (a: User, b: User): Flag => a === b
`);
  assertEquals(codes(project), ["type-mismatch/007"]);
});

Deno.test("a data type has no field that its record lacks", () => {
  const project = checkText(`${DATA_TYPES}
const wrong = (u: User): Text => u.owner
`);
  assertEquals(codes(project), ["type-mismatch/006"]);
});

const RECURSIVE_DATA = `
type Text = string
type Count = int
nominal Tree = { label: Text, children: Tree[] }
nominal Forest = { first: Option<Node> }
nominal Node = { rest: Forest }
nominal Cons = { head: Count, tail: List }
nominal Nil = {}
type List = Cons | Nil
`;

Deno.test("recursive data types are legal when every cycle has a base case", () => {
  const project = checkText(`${RECURSIVE_DATA}
const length = (list: List): Count =>
  match list {
    Cons(c) => 1 + length(c.tail),
    Nil(n) => 0
  }
const first = (tree: Tree): Tree[] => tree.children
const renamed = (tree: Tree): Tree => ({ ...tree, label: "x" })
const plain = (tree: Tree): { label: Text, children: Tree[] } => tree
const treeSchema: Schema<Tree> = schema()
const listSchema: Schema<List> = schema()
const forestSchema: Schema<Forest> = schema()
`);
  assertEquals(messages(project), []);
});

Deno.test("a cycle with no base case keeps the recursion rejection", () => {
  for (
    const text of [
      "nominal Loop = { next: Loop }",
      "nominal A = { b: B }\nnominal B = { a: A }",
      "nominal Left = { next: Left | Right }\nnominal Right = { next: Left }",
      "type First = Second\ntype Second = First | Anchor\nnominal Anchor = { next: Option<Second> }",
      "nominal Wraps = { cause: Option<Failure> }\nerror Failure = { inner: Option<Wraps> }",
    ]
  ) {
    assertEquals(codes(checkText(text)), ["declaration/007"], text);
  }
});

Deno.test("a cycle of aliases alone stays rejected beside legal data cycles", () => {
  const project = checkText(`${RECURSIVE_DATA}
type Ping = Option<Pong>
type Pong = Ping
`);
  assertEquals(codes(project), ["declaration/007"]);
});

const NAME_MATCH = `
type Text = string
nominal Circle = { radius: Text }
nominal Square = { side: Text }
nominal Dot = {}
error Broken = { reason: Text }
type Shape = Circle | Square
type Record = { kind: "c", radius: Text }
nominal Id = Text
`;

Deno.test("a match over data and error types binds each member type and covers by name", () => {
  const project = checkText(`${NAME_MATCH}
const area = (shape: Shape): Text =>
  match shape {
    Circle(c) => c.radius,
    Square(q) => q.side
  }
const lax = (shape: Shape): Text =>
  match shape {
    Circle(c) => c.radius,
    _ => "other"
  }
const either = (value: Circle | Broken | Dot): Text =>
  match value {
    Circle(c) => c.radius,
    Broken(b) => b.reason,
    Dot(d) => "dot"
  }
`);
  assertEquals(messages(project), []);
  const facts = [...fn(project, "m", "area").table.facts.values()].filter((
    f,
  ) => f.kind === "pattern");
  assertEquals(
    facts.map((f) => f.kind === "pattern" ? f.pattern.kind : ""),
    ["data", "data"],
  );
});

Deno.test("a match over names reports a missing arm and an unreachable arm", () => {
  const project = checkText(`${NAME_MATCH}
const missing = (shape: Shape): Text =>
  match shape {
    Circle(c) => c.radius
  }
const twice = (shape: Shape): Text =>
  match shape {
    Circle(c) => c.radius,
    Circle(d) => d.radius,
    Square(q) => q.side
  }
const afterWildcard = (shape: Shape): Text =>
  match shape {
    _ => "any",
    Square(q) => q.side
  }
`);
  assertEquals(codes(project), [
    "pattern/001",
    "pattern/002",
    "pattern/002",
  ]);
  assert(project.diagnostics[0].message.includes("Square(_)"));
});

Deno.test("a match over names rejects a record pattern, a mixed subject, an alias, and a nominal type over a primitive", () => {
  const project = checkText(`${NAME_MATCH}
const byRecord = (shape: Shape): Text =>
  match shape {
    { kind: "c", ...rest } => "r",
    _ => "other"
  }
const mixed = (value: Circle | Record): Text =>
  match value {
    Circle(c) => c.radius,
    _ => "other"
  }
const byAlias = (shape: Shape): Text =>
  match shape {
    Record(r) => "a",
    _ => "other"
  }
const byBrand = (shape: Shape): Text =>
  match shape {
    Id(i) => "b",
    _ => "other"
  }
`);
  assertEquals(codes(project), [
    "pattern/004",
    "pattern/004",
    "pattern/004",
    "pattern/004",
  ]);
  assertEquals(
    project.diagnostics.map((d) => d.message.replace(/`/g, "")).slice(2),
    [
      "Record is a type alias, not a nominal type; a constructor pattern names a nominal type or an error",
      "Id is a nominal type with a non-record body; a constructor pattern names a nominal record or an error",
    ],
  );
});

Deno.test("a name that is not a member of the subject does not belong to it", () => {
  const project = checkText(`${NAME_MATCH}
const foreign = (shape: Shape): Text =>
  match shape {
    Broken(b) => b.reason,
    _ => "other"
  }
`);
  assertEquals(codes(project), ["pattern/003"]);
});

Deno.test("a catch handler still names an error, not a data type", () => {
  const project = checkText(`${NAME_MATCH}
const guarded = (): Text fails Broken =>
  try { fail(Broken({ reason: "no" })) } catch { Circle(c) => c.radius }
`);
  assertEquals(codes(project), ["unknown-name/004"]);
});

Deno.test("a nominal or error body that did not parse causes no cascade", () => {
  const project = checkText(`
type Name = string
type Fields = { name: Name }
nominal Account = ,
error Boom = Fields
export const a = (account: Account): Fields => account
export const b = (account: Account): Name => account.name
export const c = (name: Name): Account => Account({ name })
export const d = (name: Name): Name fails Boom => fail(Boom({ name }))
export const e = (): Name fails Boom => try { d("x") } catch { Boom(x) => x.name }
`);
  assertEquals(codes(project), ["syntax/008", "syntax/008"]);
});

Deno.test("a data or error field cannot hold a function type at any depth", () => {
  const project = checkText(`
type Count = int
type Step = (n: Count) => Count
nominal Direct = { run: Step }
error Failed = { run: Step }
nominal Nested = { a: Option<Step>, b: Step[], c: [Count, Step], d: { e: Step } }
nominal Aliased = { steps: Later }
type Later = Step[]
`);
  assertEquals(codes(project), Array(7).fill("declaration/015"));
});

Deno.test("a data or error field that names another data type with a function field is not reported twice", () => {
  const project = checkText(`
type Count = int
nominal Inner = { run: (n: Count) => Count }
nominal Outer = { inner: Inner }
error Wrap = { inner: Inner }
`);
  assertEquals(codes(project), ["declaration/015"]);
  assertEquals(project.diagnostics[0].message.includes("`run`"), true);
});

Deno.test("a function type stays legal in a record and in a brand-free alias", () => {
  const project = checkText(`
type Count = int
type Step = (n: Count) => Count
type Plain = { run: Step }
nominal Fine = { count: Count }
`);
  assertEquals(messages(project), []);
});

Deno.test("data stays legal as a variable and a function name", () => {
  const project = checkText(`
type Int = int
const data = (x: Int): Int => x
const use = (data: Int): Int => data
const call = (): Int => data(1)
`);
  assertEquals(messages(project), []);
});

Deno.test("a data type is legal in a host interface file", () => {
  const project = checkFiles({
    "effective.json": JSON.stringify({
      host: { rows: { interface: "./rows.effi", module: "./rows.ts" } },
    }),
    "rows.effi": `
export nominal Row = { id: string, total: int }
export service Rows { next(): Row }
`,
    "main.eff": `
import { Row, Rows } from "host:rows"
export const first = (): Row uses Rows.next => Rows.next()
`,
  }, ["main.eff"]);
  assertEquals(messages(project), []);
});

// Characterization tests for the Schema builtins. Each case lists the complete
// diagnostic list of a module: code, message, source text of the span, and the
// order that the checker reports. They pin the behavior of `schemaCall` before
// and after its refactor.
const SCHEMA_PREFIX = `type Int = int
type Text = string
type Nil = null
error Other = {}
service Need { next(value: Int): Int }
const text: Schema<Text> = schema()
const integer: Schema<Int> = schema()
const optional: SchemaOptional<Int> = schemaOptionalKey(integer)
const optionalText: SchemaOptional<Text> = schemaOptionalKey(text)
const nullable: Schema<Text | Nil> = schema()
const failOther = (): Text fails Other => fail(Other({}))
const sample = (): Text => "x"
`;

interface SchemaCase {
  readonly name: string;
  /** Source text that follows SCHEMA_PREFIX. */
  readonly tail: string;
  /** Each entry is `code | message | span text`. */
  readonly expected: readonly string[];
}

function schemaDiagnostics(tail: string): string[] {
  const text = SCHEMA_PREFIX + tail;
  return checkText(text).diagnostics.map((d) =>
    `${d.code} | ${d.message} | ${spanText(text, d.span)}`
  );
}

function assertSchemaCases(cases: readonly SchemaCase[]): void {
  for (const c of cases) {
    assertEquals(schemaDiagnostics(c.tail), c.expected, c.name);
  }
}

const OPTIONAL_TRANSFORM_CASES: readonly SchemaCase[] = [
  {
    name: "accepts optional descriptors",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    expected: [],
  },
  {
    name: "source is not optional",
    tail:
      "const bad = schemaOptionalTransform(integer, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | `schemaOptionalTransform` needs a SchemaOptional field | integer",
    ],
  },
  {
    name: "target is not optional",
    tail:
      "const bad = schemaOptionalTransform(optional, integer, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | `schemaOptionalTransform` needs a SchemaOptional field | integer",
    ],
  },
  {
    name: "neither is optional",
    tail:
      "const bad = schemaOptionalTransform(integer, integer, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | `schemaOptionalTransform` needs a SchemaOptional field | integer",
      "type-mismatch/010 | `schemaOptionalTransform` needs a SchemaOptional field | integer",
    ],
  },
  {
    name: "bad source still checks the callbacks",
    tail:
      'const bad = schemaOptionalTransform(integer, optional, (value: Option<Int>): Option<Int> => "x", (value: Option<Int>): Option<Int> => value)',
    expected: [
      "type-mismatch/010 | `schemaOptionalTransform` needs a SchemaOptional field | integer",
      'type-mismatch/003 | the function body has type string, but Option<Int> is expected | "x"',
    ],
  },
  {
    name: "decode fails with another error",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other({})), (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other({})), (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "encode fails with another error",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> fails Other => fail(Other({})))",
    ],
  },
  {
    name: "both fail with another error",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other({})), (value: Option<Int>): Option<Int> fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails Other => fail(Other({})), (value: Option<Int>): Option<Int> fails Other => fail(Other({})))",
    ],
  },
  {
    name: "decode fails with SchemaError",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaError => { const n = schemaDecode(integer, 1)\n Some(n) }, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaError => { const n = schemaDecode(integer, 1)\n Some(n) }, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "decode fails with SchemaIssue",
    tail:
      'const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")), (value: Option<Int>): Option<Int> => value)',
    expected: [],
  },
  {
    name: "encode fails with SchemaIssue",
    tail:
      'const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")))',
    expected: [],
  },
  {
    name: "decode fails with SchemaIssue and SchemaError",
    tail:
      'const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) }, (value: Option<Int>): Option<Int> => value)',
    expected: [
      'type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) }, (value: Option<Int>): Option<Int> => value)',
    ],
  },
  {
    name: "decode is not inline",
    tail:
      "const keep = (value: Option<Int>): Option<Int> => value\nconst bad = schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "encode is not inline",
    tail:
      "const keep = (value: Option<Int>): Option<Int> => value\nconst bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, keep)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, keep)",
    ],
  },
  {
    name: "neither callback is inline",
    tail:
      "const keep = (value: Option<Int>): Option<Int> => value\nconst bad = schemaOptionalTransform(optional, optional, keep, keep)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, keep, keep)",
    ],
  },
  {
    name: "decode is not a function",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, 1, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, 1, (value: Option<Int>): Option<Int> => value)",
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, 1, (value: Option<Int>): Option<Int> => value)",
      "type-mismatch/010 | the callback of `schemaOptionalTransform` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "encode is not a function",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, 1)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, 1)",
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, 1)",
      "type-mismatch/010 | the callback of `schemaOptionalTransform` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "decode returns the wrong Option",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Text> => None, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | schemaOptionalTransform callbacks must return directional Option values | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Text> => None, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "encode returns the wrong Option",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | schemaOptionalTransform callbacks must return directional Option values | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Text> => None)",
    ],
  },
  {
    name: "decode returns a bare value",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Int => 1, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | schemaOptionalTransform callbacks must return directional Option values | schemaOptionalTransform(optional, optional, (value: Option<Int>): Int => 1, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "decode takes the wrong parameter",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Text>): Option<Int> => None, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | parameter 1 of the callback has type Option<Text>, but the collection supplies Option<Int> | (value: Option<Text>): Option<Int> => None",
    ],
  },
  {
    name: "encode takes no parameter",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (): Option<Int> => None)",
    expected: [
      "type-mismatch/004 | the callback of `schemaOptionalTransform` takes 1 parameter, but the function takes 0 | (): Option<Int> => None",
    ],
  },
  {
    name: "failure, inline, and result errors together",
    tail:
      "const keep = (value: Option<Int>): Option<Text> fails Other => fail(Other({}))\nconst bad = schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | schemaOptionalTransform callbacks must return directional Option values | schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, keep, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "both callbacks fail with another error and are not inline",
    tail:
      "const keep = (value: Option<Int>): Option<Int> fails Other => fail(Other({}))\nconst bad = schemaOptionalTransform(optional, optional, keep, keep)",
    expected: [
      "type-mismatch/010 | schemaOptionalTransform callbacks may fail only with SchemaIssue | schemaOptionalTransform(optional, optional, keep, keep)",
      "type-mismatch/010 | schemaOptionalTransform needs inline callbacks | schemaOptionalTransform(optional, optional, keep, keep)",
    ],
  },
  {
    name: "service requirement is accepted",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> uses Need.next => { const tick = Need.next(1)\n value }, (value: Option<Int>): Option<Int> => value)",
    expected: [],
  },
  {
    name: "too few arguments",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/004 | `schemaOptionalTransform` takes 4 arguments, but 3 are given | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "too many arguments",
    tail:
      "const bad = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value, 1)",
    expected: [
      "type-mismatch/004 | `schemaOptionalTransform` takes 4 arguments, but 5 are given | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value, 1)",
    ],
  },
  {
    name: "inferred type",
    tail:
      "const shown: Int = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaOptional<Int, Int, never, never>, but Int is expected | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> => value, (value: Option<Int>): Option<Int> => value)",
    ],
  },
  {
    name: "inferred type with services",
    tail:
      "const shown: Int = schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> uses Need.next => { const tick = Need.next(1)\n value }, (value: Option<Int>): Option<Int> => value)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaOptional<Int, Int, Need.next, never>, but Int is expected | schemaOptionalTransform(optional, optional, (value: Option<Int>): Option<Int> uses Need.next => { const tick = Need.next(1)\n value }, (value: Option<Int>): Option<Int> => value)",
    ],
  },
];

Deno.test("schemaOptionalTransform diagnostics keep their lists and order", () => {
  assertSchemaCases(OPTIONAL_TRANSFORM_CASES);
});

const OPTIONAL_FROM_REQUIRED_CASES: readonly SchemaCase[] = [
  {
    name: "accepts a required source",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [],
  },
  {
    name: "source is optional",
    tail:
      'const bad = schemaOptionalFromRequired(optionalText, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a Schema value | optionalText",
    ],
  },
  {
    name: "target is required",
    tail:
      'const bad = schemaOptionalFromRequired(text, text, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a SchemaOptional field | text",
    ],
  },
  {
    name: "both are wrong",
    tail:
      'const bad = schemaOptionalFromRequired(optionalText, text, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a Schema value | optionalText",
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a SchemaOptional field | text",
    ],
  },
  {
    name: "source is not a Schema",
    tail:
      'const bad = schemaOptionalFromRequired(1, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a Schema value | 1",
    ],
  },
  {
    name: "bad source still checks the callbacks",
    tail:
      'const bad = schemaOptionalFromRequired(optionalText, optionalText, (value: Text): Option<Text> => "x", (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/010 | `schemaOptionalFromRequired` needs a Schema value | optionalText",
      'type-mismatch/003 | the function body has type string, but Option<Text> is expected | "x"',
    ],
  },
  {
    name: "decode fails with another error",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails Other => fail(Other({})), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails Other => fail(Other({})), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "encode fails with another error",
    tail:
      "const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text fails Other => fail(Other({})))",
    ],
  },
  {
    name: "decode fails with SchemaError",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails SchemaError => { const n = schemaDecode(text, value)\n Some(n) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails SchemaError => { const n = schemaDecode(text, value)\n Some(n) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "decode fails with SchemaIssue",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails SchemaIssue => fail(schemaInvalid("x")), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [],
  },
  {
    name: "encode fails with SchemaIssue",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text fails SchemaIssue => fail(schemaInvalid("x")))',
    expected: [],
  },
  {
    name: "decode fails with SchemaIssue and SchemaError",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails SchemaIssue | SchemaError => { const n = schemaDecode(text, value)\n fail(schemaInvalid("x")) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> fails SchemaIssue | SchemaError => { const n = schemaDecode(text, value)\n fail(schemaInvalid("x")) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "decode is not inline",
    tail:
      'const keep = (value: Text): Option<Text> => Some(value)\nconst bad = schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "encode is not inline",
    tail:
      'const keep = (value: Option<Text>): Text => match value { Some(name) => name, None => "" }\nconst bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), keep)',
    expected: [
      "type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), keep)",
    ],
  },
  {
    name: "decode is not a function",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, 1, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, 1, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
      'type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, 1, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
      "type-mismatch/010 | the callback of `schemaOptionalFromRequired` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "encode is not a function",
    tail:
      "const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), 1)",
    expected: [
      "type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), 1)",
      "type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), 1)",
      "type-mismatch/010 | the callback of `schemaOptionalFromRequired` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "decode returns a bare value",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Text => value, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/003 | schemaOptionalFromRequired decode must return optional target-encoded values and encode must return a required source-decoded value | schemaOptionalFromRequired(text, optionalText, (value: Text): Text => value, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "encode returns an Option",
    tail:
      "const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Option<Text> => value)",
    expected: [
      "type-mismatch/003 | schemaOptionalFromRequired decode must return optional target-encoded values and encode must return a required source-decoded value | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Option<Text> => value)",
    ],
  },
  {
    name: "decode takes the wrong parameter",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Int): Option<Text> => None, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/003 | parameter 1 of the callback has type Int, but the collection supplies Text | (value: Int): Option<Text> => None",
    ],
  },
  {
    name: "encode takes the wrong parameter",
    tail:
      "const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Text): Text => value)",
    expected: [
      "type-mismatch/003 | parameter 1 of the callback has type Text, but the collection supplies Option<Text> | (value: Text): Text => value",
    ],
  },
  {
    name: "decode takes no parameter",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (): Option<Text> => None, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      "type-mismatch/004 | the callback of `schemaOptionalFromRequired` takes 1 parameter, but the function takes 0 | (): Option<Text> => None",
    ],
  },
  {
    name: "failure, inline, and result errors together",
    tail:
      'const keep = (value: Text): Text fails Other => fail(Other({}))\nconst bad = schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/003 | schemaOptionalFromRequired decode must return optional target-encoded values and encode must return a required source-decoded value | schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
      'type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
      'type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, keep, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "both callbacks fail with another error and are not inline",
    tail:
      "const keep = (value: Text): Option<Text> fails Other => fail(Other({}))\nconst bad = schemaOptionalFromRequired(text, optionalText, keep, keep)",
    expected: [
      "type-mismatch/003 | schemaOptionalFromRequired decode must return optional target-encoded values and encode must return a required source-decoded value | schemaOptionalFromRequired(text, optionalText, keep, keep)",
      "type-mismatch/010 | schemaOptionalFromRequired callbacks may fail only with SchemaIssue | schemaOptionalFromRequired(text, optionalText, keep, keep)",
      "type-mismatch/010 | schemaOptionalFromRequired needs inline callbacks | schemaOptionalFromRequired(text, optionalText, keep, keep)",
      "type-mismatch/003 | parameter 1 of the callback has type Text, but the collection supplies Option<Text> | keep",
    ],
  },
  {
    name: "service requirement is accepted",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> uses Need.next => { const tick = Need.next(1)\n Some(value) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [],
  },
  {
    name: "too few arguments",
    tail:
      "const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value))",
    expected: [
      "type-mismatch/004 | `schemaOptionalFromRequired` takes 4 arguments, but 3 are given | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value))",
    ],
  },
  {
    name: "too many arguments",
    tail:
      'const bad = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" }, 1)',
    expected: [
      'type-mismatch/004 | `schemaOptionalFromRequired` takes 4 arguments, but 5 are given | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" }, 1)',
    ],
  },
  {
    name: "inferred type",
    tail:
      'const shown: Int = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaDecodedOptional<Text, Text, never, never>, but Int is expected | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> => Some(value), (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
  {
    name: "inferred type with services",
    tail:
      'const shown: Int = schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> uses Need.next => { const tick = Need.next(1)\n Some(value) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaDecodedOptional<Text, Text, Need.next, never>, but Int is expected | schemaOptionalFromRequired(text, optionalText, (value: Text): Option<Text> uses Need.next => { const tick = Need.next(1)\n Some(value) }, (value: Option<Text>): Text => match value { Some(name) => name, None => "" })',
    ],
  },
];

Deno.test("schemaOptionalFromRequired diagnostics keep their lists and order", () => {
  assertSchemaCases(OPTIONAL_FROM_REQUIRED_CASES);
});

const SCHEMA_DEFAULT_KEY_CASES: readonly SchemaCase[] = [
  {
    name: "accepts a plain callback",
    tail: 'const bad = schemaDefaultKey(text, (): Text => "a")',
    expected: [],
  },
  {
    name: "accepts SchemaIssue failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue => fail(schemaInvalid("x")))',
    expected: [],
  },
  {
    name: "accepts SchemaError failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaError => schemaDecode(text, "x"))',
    expected: [],
  },
  {
    name: "rejects SchemaIssue with SchemaError",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "rejects another failure",
    tail:
      "const bad = schemaDefaultKey(text, (): Text fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "rejects another failure with SchemaIssue",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "callback is not inline",
    tail: "const bad = schemaDefaultKey(text, sample)",
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
    ],
  },
  {
    name: "callback is not inline and fails",
    tail: "const bad = schemaDefaultKey(text, failOther)",
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | failOther",
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | failOther",
    ],
  },
  {
    name: "callback is not a function",
    tail: "const bad = schemaDefaultKey(text, 1)",
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | 1",
      "type-mismatch/010 | the callback of `schemaDefaultKey` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "callback returns the wrong type",
    tail: "const bad = schemaDefaultKey(text, (): Int => 1)",
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the decoded field type | (): Int => 1",
    ],
  },
  {
    name: "callback returns the wrong type and fails",
    tail:
      "const bad = schemaDefaultKey(text, (): Int fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the decoded field type | (): Int fails Other => fail(Other({}))",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Int fails Other => fail(Other({}))",
    ],
  },
  {
    name: "callback takes a parameter",
    tail: "const bad = schemaDefaultKey(text, (value: Text): Text => value)",
    expected: [
      "type-mismatch/004 | the callback of `schemaDefaultKey` takes 0 parameters, but the function takes 1 | (value: Text): Text => value",
    ],
  },
  {
    name: "schema is optional",
    tail: 'const bad = schemaDefaultKey(optionalText, (): Text => "a")',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
    ],
  },
  {
    name: "schema is optional and callback fails",
    tail:
      "const bad = schemaDefaultKey(optionalText, (): Text fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "schema is not a Schema",
    tail: 'const bad = schemaDefaultKey(1, (): Text => "a")',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | 1",
    ],
  },
  {
    name: "options are accepted",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" })',
    expected: [],
  },
  {
    name: "options are not a record",
    tail: 'const bad = schemaDefaultKey(text, (): Text => "a", 1)',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | 1',
    ],
  },
  {
    name: "options use another strategy",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "other" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { encodingStrategy: "other" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "other"',
    ],
  },
  {
    name: "options have an extra field",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit", extra: true })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { encodingStrategy: "omit", extra: true }',
      'type-mismatch/005 | the record type { encodingStrategy?: "omit" | "passthrough", on?: "encoded" | "missing" | "null" } has no field `extra` | extra',
    ],
  },
  {
    name: "options and callback both wrong",
    tail:
      'const bad = schemaDefaultKey(text, sample, { encodingStrategy: "x" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { encodingStrategy: "x" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "x"',
    ],
  },
  {
    name: "no arguments",
    tail: "const bad = schemaDefaultKey()",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 0 are given | schemaDefaultKey()",
    ],
  },
  {
    name: "one argument",
    tail: "const bad = schemaDefaultKey(text)",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 1 is given | schemaDefaultKey(text)",
    ],
  },
  {
    name: "four arguments",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    expected: [
      'type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 4 are given | schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    ],
  },
  {
    name: "inferred type",
    tail: 'const shown: Int = schemaDefaultKey(text, (): Text => "a")',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a")',
    ],
  },
  {
    name: "inferred type with options",
    tail:
      'const shown: Int = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "passthrough" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "passthrough" })',
    ],
  },
];

Deno.test("schemaDefaultKey diagnostics keep their lists and order", () => {
  assertSchemaCases(SCHEMA_DEFAULT_KEY_CASES);
});

const SCHEMA_DEFAULT_NULL_KEY_CASES: readonly SchemaCase[] = [
  {
    name: "accepts a plain callback",
    tail: 'const bad = schemaDefaultKey(text, (): Text => "a", { on: "null" })',
    expected: [],
  },
  {
    name: "accepts SchemaIssue failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue => fail(schemaInvalid("x")), { on: "null" })',
    expected: [],
  },
  {
    name: "accepts SchemaError failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaError => schemaDecode(text, "x"), { on: "null" })',
    expected: [],
  },
  {
    name: "rejects SchemaIssue with SchemaError",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) }, { on: "null" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "rejects another failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails Other => fail(Other({})), { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "rejects another failure with SchemaIssue",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) }, { on: "null" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "callback is not inline",
    tail: 'const bad = schemaDefaultKey(text, sample, { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
    ],
  },
  {
    name: "callback is not inline and fails",
    tail: 'const bad = schemaDefaultKey(text, failOther, { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | failOther",
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | failOther",
    ],
  },
  {
    name: "callback is not a function",
    tail: 'const bad = schemaDefaultKey(text, 1, { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | 1",
      "type-mismatch/010 | the callback of `schemaDefaultKey` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "callback returns the wrong type",
    tail: 'const bad = schemaDefaultKey(text, (): Int => 1, { on: "null" })',
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the decoded field type | (): Int => 1",
    ],
  },
  {
    name: "callback returns the wrong type and fails",
    tail:
      'const bad = schemaDefaultKey(text, (): Int fails Other => fail(Other({})), { on: "null" })',
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the decoded field type | (): Int fails Other => fail(Other({}))",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Int fails Other => fail(Other({}))",
    ],
  },
  {
    name: "callback takes a parameter",
    tail:
      'const bad = schemaDefaultKey(text, (value: Text): Text => value, { on: "null" })',
    expected: [
      "type-mismatch/004 | the callback of `schemaDefaultKey` takes 0 parameters, but the function takes 1 | (value: Text): Text => value",
    ],
  },
  {
    name: "schema is optional",
    tail:
      'const bad = schemaDefaultKey(optionalText, (): Text => "a", { on: "null" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
    ],
  },
  {
    name: "schema is optional and callback fails",
    tail:
      'const bad = schemaDefaultKey(optionalText, (): Text fails Other => fail(Other({})), { on: "null" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "schema is not a Schema",
    tail: 'const bad = schemaDefaultKey(1, (): Text => "a", { on: "null" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | 1",
    ],
  },
  {
    name: "options are accepted",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "null", encodingStrategy: "omit" })',
    expected: [],
  },
  {
    name: "options are not a record",
    tail: 'const bad = schemaDefaultKey(text, (): Text => "a", 1)',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | 1',
    ],
  },
  {
    name: "options use another strategy",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "null", encodingStrategy: "other" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "null", encodingStrategy: "other" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "other"',
    ],
  },
  {
    name: "options have an extra field",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "null", encodingStrategy: "omit", extra: true })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "null", encodingStrategy: "omit", extra: true }',
      'type-mismatch/005 | the record type { encodingStrategy?: "omit" | "passthrough", on?: "encoded" | "missing" | "null" } has no field `extra` | extra',
    ],
  },
  {
    name: "options and callback both wrong",
    tail:
      'const bad = schemaDefaultKey(text, sample, { on: "null", encodingStrategy: "x" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "null", encodingStrategy: "x" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "x"',
    ],
  },
  {
    name: "no arguments",
    tail: "const bad = schemaDefaultKey()",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 0 are given | schemaDefaultKey()",
    ],
  },
  {
    name: "one argument",
    tail: "const bad = schemaDefaultKey(text)",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 1 is given | schemaDefaultKey(text)",
    ],
  },
  {
    name: "four arguments",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    expected: [
      'type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 4 are given | schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    ],
  },
  {
    name: "inferred type",
    tail:
      'const shown: Int = schemaDefaultKey(text, (): Text => "a", { on: "null" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text | null, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a", { on: "null" })',
    ],
  },
  {
    name: "inferred type with options",
    tail:
      'const shown: Int = schemaDefaultKey(text, (): Text => "a", { on: "null", encodingStrategy: "passthrough" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text | null, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a", { on: "null", encodingStrategy: "passthrough" })',
    ],
  },
  {
    name: "nullable schema is rejected",
    tail:
      'const bad = schemaDefaultKey(nullable, (): Text => "a", { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs nonnullable decoded and encoded field types | nullable",
    ],
  },
  {
    name: "nullable schema with a wrong callback",
    tail:
      'const bad = schemaDefaultKey(nullable, (): Int fails Other => fail(Other({})), { on: "null" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs nonnullable decoded and encoded field types | nullable",
      "type-mismatch/003 | schemaDefaultKey callback must return the decoded field type | (): Int fails Other => fail(Other({}))",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Int fails Other => fail(Other({}))",
    ],
  },
];

Deno.test("schemaDefaultKey diagnostics keep their lists and order", () => {
  assertSchemaCases(SCHEMA_DEFAULT_NULL_KEY_CASES);
});

const SCHEMA_DEFAULT_ENCODED_KEY_CASES: readonly SchemaCase[] = [
  {
    name: "accepts a plain callback",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "encoded" })',
    expected: [],
  },
  {
    name: "accepts SchemaIssue failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue => fail(schemaInvalid("x")), { on: "encoded" })',
    expected: [],
  },
  {
    name: "accepts SchemaError failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaError => schemaDecode(text, "x"), { on: "encoded" })',
    expected: [],
  },
  {
    name: "rejects SchemaIssue with SchemaError",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) }, { on: "encoded" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | SchemaError => { const n = schemaDecode(text, "x")\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "rejects another failure",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails Other => fail(Other({})), { on: "encoded" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "rejects another failure with SchemaIssue",
    tail:
      'const bad = schemaDefaultKey(text, (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) }, { on: "encoded" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails SchemaIssue | Other => { fail(Other({}))\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "callback is not inline",
    tail: 'const bad = schemaDefaultKey(text, sample, { on: "encoded" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
    ],
  },
  {
    name: "callback is not inline and fails",
    tail: 'const bad = schemaDefaultKey(text, failOther, { on: "encoded" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | failOther",
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | failOther",
    ],
  },
  {
    name: "callback is not a function",
    tail: 'const bad = schemaDefaultKey(text, 1, { on: "encoded" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | 1",
      "type-mismatch/010 | the callback of `schemaDefaultKey` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "callback returns the wrong type",
    tail: 'const bad = schemaDefaultKey(text, (): Int => 1, { on: "encoded" })',
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the encoded field type | (): Int => 1",
    ],
  },
  {
    name: "callback returns the wrong type and fails",
    tail:
      'const bad = schemaDefaultKey(text, (): Int fails Other => fail(Other({})), { on: "encoded" })',
    expected: [
      "type-mismatch/003 | schemaDefaultKey callback must return the encoded field type | (): Int fails Other => fail(Other({}))",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Int fails Other => fail(Other({}))",
    ],
  },
  {
    name: "callback takes a parameter",
    tail:
      'const bad = schemaDefaultKey(text, (value: Text): Text => value, { on: "encoded" })',
    expected: [
      "type-mismatch/004 | the callback of `schemaDefaultKey` takes 0 parameters, but the function takes 1 | (value: Text): Text => value",
    ],
  },
  {
    name: "schema is optional",
    tail:
      'const bad = schemaDefaultKey(optionalText, (): Text => "a", { on: "encoded" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
    ],
  },
  {
    name: "schema is optional and callback fails",
    tail:
      'const bad = schemaDefaultKey(optionalText, (): Text fails Other => fail(Other({})), { on: "encoded" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | optionalText",
      "type-mismatch/010 | schemaDefaultKey callback may fail only with SchemaIssue or SchemaError | (): Text fails Other => fail(Other({}))",
    ],
  },
  {
    name: "schema is not a Schema",
    tail: 'const bad = schemaDefaultKey(1, (): Text => "a", { on: "encoded" })',
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` needs a Schema value | 1",
    ],
  },
  {
    name: "options are accepted",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "encoded", encodingStrategy: "omit" })',
    expected: [],
  },
  {
    name: "options are not a record",
    tail: 'const bad = schemaDefaultKey(text, (): Text => "a", 1)',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | 1',
    ],
  },
  {
    name: "options use another strategy",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "encoded", encodingStrategy: "other" })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "encoded", encodingStrategy: "other" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "other"',
    ],
  },
  {
    name: "options have an extra field",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { on: "encoded", encodingStrategy: "omit", extra: true })',
    expected: [
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "encoded", encodingStrategy: "omit", extra: true }',
      'type-mismatch/005 | the record type { encodingStrategy?: "omit" | "passthrough", on?: "encoded" | "missing" | "null" } has no field `extra` | extra',
    ],
  },
  {
    name: "options and callback both wrong",
    tail:
      'const bad = schemaDefaultKey(text, sample, { on: "encoded", encodingStrategy: "x" })',
    expected: [
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
      'type-mismatch/010 | schemaDefaultKey options must be an inline { on?: "missing" | "null" | "encoded", encodingStrategy?: "omit" | "passthrough" } record with literal values | { on: "encoded", encodingStrategy: "x" }',
      'type-mismatch/003 | the field `encodingStrategy` has type string, but "omit" | "passthrough" is expected | "x"',
    ],
  },
  {
    name: "no arguments",
    tail: "const bad = schemaDefaultKey()",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 0 are given | schemaDefaultKey()",
    ],
  },
  {
    name: "one argument",
    tail: "const bad = schemaDefaultKey(text)",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 1 is given | schemaDefaultKey(text)",
    ],
  },
  {
    name: "four arguments",
    tail:
      'const bad = schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    expected: [
      'type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 4 are given | schemaDefaultKey(text, (): Text => "a", { encodingStrategy: "omit" }, 1)',
    ],
  },
  {
    name: "inferred type",
    tail:
      'const shown: Int = schemaDefaultKey(text, (): Text => "a", { on: "encoded" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a", { on: "encoded" })',
    ],
  },
  {
    name: "inferred type with options",
    tail:
      'const shown: Int = schemaDefaultKey(text, (): Text => "a", { on: "encoded", encodingStrategy: "passthrough" })',
    expected: [
      'type-mismatch/003 | the constant has type SchemaEncodedOptional<Text, Text, never, never>, but Int is expected | schemaDefaultKey(text, (): Text => "a", { on: "encoded", encodingStrategy: "passthrough" })',
    ],
  },
];

Deno.test("schemaDefaultKey diagnostics keep their lists and order", () => {
  assertSchemaCases(SCHEMA_DEFAULT_ENCODED_KEY_CASES);
});

const CONSTRUCTOR_DEFAULT_CASES: readonly SchemaCase[] = [
  {
    name: "accepts a plain callback",
    tail: "const bad = schemaConstructorDefault(integer, (): Int => 1)",
    expected: [],
  },
  {
    name: "accepts SchemaIssue failure",
    tail:
      'const bad = schemaConstructorDefault(integer, (): Int fails SchemaIssue => fail(schemaInvalid("x")))',
    expected: [],
  },
  {
    name: "rejects SchemaError failure",
    tail:
      "const bad = schemaConstructorDefault(integer, (): Int fails SchemaError => schemaDecode(integer, 1))",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Int fails SchemaError => schemaDecode(integer, 1)",
    ],
  },
  {
    name: "rejects SchemaIssue with SchemaError",
    tail:
      'const bad = schemaConstructorDefault(integer, (): Int fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) })',
    expected: [
      'type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Int fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) }',
    ],
  },
  {
    name: "rejects another failure",
    tail:
      "const bad = schemaConstructorDefault(integer, (): Int fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Int fails Other => fail(Other({}))",
    ],
  },
  {
    name: "rejects services",
    tail:
      "const bad = schemaConstructorDefault(integer, (): Int uses Need.next => Need.next(1))",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Int uses Need.next => Need.next(1)",
    ],
  },
  {
    name: "rejects the wrong return type",
    tail: 'const bad = schemaConstructorDefault(integer, (): Text => "x")',
    expected: [
      'type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Text => "x"',
    ],
  },
  {
    name: "rejects a callback that is not inline",
    tail:
      "const keep = (): Int => 1\nconst bad = schemaConstructorDefault(integer, keep)",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | keep",
    ],
  },
  {
    name: "callback is not a function",
    tail: "const bad = schemaConstructorDefault(integer, 1)",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | 1",
      "type-mismatch/010 | the callback of `schemaConstructorDefault` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "callback takes a parameter",
    tail:
      "const bad = schemaConstructorDefault(integer, (value: Int): Int => value)",
    expected: [
      "type-mismatch/004 | the callback of `schemaConstructorDefault` takes 0 parameters, but the function takes 1 | (value: Int): Int => value",
    ],
  },
  {
    name: "every rule fails at once",
    tail:
      "const keep = (): Text fails Other => fail(Other({}))\nconst bad = schemaConstructorDefault(integer, keep)",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | keep",
    ],
  },
  {
    name: "schema is optional",
    tail: "const bad = schemaConstructorDefault(optional, (): Int => 1)",
    expected: [],
  },
  {
    name: "schema is optional and callback fails",
    tail:
      "const bad = schemaConstructorDefault(optional, (): Int fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | (): Int fails Other => fail(Other({}))",
    ],
  },
  {
    name: "schema already has a default",
    tail:
      "const bad = schemaConstructorDefault(schemaConstructorDefault(integer, (): Int => 1), (): Int => 2)",
    expected: [
      "type-mismatch/010 | `schemaConstructorDefault` needs a Schema value | schemaConstructorDefault(integer, (): Int => 1)",
    ],
  },
  {
    name: "no arguments",
    tail: "const bad = schemaConstructorDefault()",
    expected: [
      "type-mismatch/004 | `schemaConstructorDefault` takes 2 arguments, but 0 are given | schemaConstructorDefault()",
    ],
  },
  {
    name: "one argument",
    tail: "const bad = schemaConstructorDefault(integer)",
    expected: [
      "type-mismatch/004 | `schemaConstructorDefault` takes 2 arguments, but 1 is given | schemaConstructorDefault(integer)",
    ],
  },
  {
    name: "three arguments",
    tail: "const bad = schemaConstructorDefault(integer, (): Int => 1, 1)",
    expected: [
      "type-mismatch/004 | `schemaConstructorDefault` takes 2 arguments, but 3 are given | schemaConstructorDefault(integer, (): Int => 1, 1)",
    ],
  },
  {
    name: "inferred type",
    tail: "const shown: Text = schemaConstructorDefault(integer, (): Int => 1)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaConstructorDefault<Int, Int, never, never>, but Text is expected | schemaConstructorDefault(integer, (): Int => 1)",
    ],
  },
];

Deno.test("schemaConstructorDefault keeps its combined diagnostic", () => {
  assertSchemaCases(CONSTRUCTOR_DEFAULT_CASES);
});

const TRANSFORM_CASES: readonly SchemaCase[] = [
  {
    name: "accepts Option callbacks",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [],
  },
  {
    name: "accepts SchemaIssue callbacks",
    tail:
      'const bad = schemaTransform(text, integer, (value: Text): Int fails SchemaIssue => fail(schemaInvalid("x")), (value: Int): Text fails SchemaIssue => fail(schemaInvalid("x")))',
    expected: [],
  },
  {
    name: "source is optional",
    tail:
      "const bad = schemaTransform(optional, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | `schemaTransform` needs a Schema value | optional",
    ],
  },
  {
    name: "target is optional",
    tail:
      "const bad = schemaTransform(text, optional, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | `schemaTransform` needs a Schema value | optional",
    ],
  },
  {
    name: "neither is a Schema",
    tail:
      "const bad = schemaTransform(1, 2, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | `schemaTransform` needs a Schema value | 1",
      "type-mismatch/010 | `schemaTransform` needs a Schema value | 2",
    ],
  },
  {
    name: "bad source still checks the callbacks",
    tail:
      'const bad = schemaTransform(optional, integer, (value: Text): Option<Int> => "x", (value: Int): Option<Text> => None)',
    expected: [
      "type-mismatch/010 | `schemaTransform` needs a Schema value | optional",
      'type-mismatch/003 | the function body has type string, but Option<Int> is expected | "x"',
    ],
  },
  {
    name: "decode fails with another error",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> fails Other => fail(Other({})), (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, (value: Text): Option<Int> fails Other => fail(Other({})), (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "encode fails with another error",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> fails Other => fail(Other({})))",
    expected: [
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> fails Other => fail(Other({})))",
    ],
  },
  {
    name: "decode fails with SchemaError",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> fails SchemaError => { const n = schemaDecode(integer, 1)\n Some(n) }, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, (value: Text): Option<Int> fails SchemaError => { const n = schemaDecode(integer, 1)\n Some(n) }, (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "decode fails with SchemaIssue and SchemaError",
    tail:
      'const bad = schemaTransform(text, integer, (value: Text): Int fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) }, (value: Int): Option<Text> => None)',
    expected: [
      'type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, (value: Text): Int fails SchemaIssue | SchemaError => { const n = schemaDecode(integer, 1)\n fail(schemaInvalid("x")) }, (value: Int): Option<Text> => None)',
    ],
  },
  {
    name: "decode is not inline",
    tail:
      "const keep = (value: Text): Option<Int> => None\nconst bad = schemaTransform(text, integer, keep, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(text, integer, keep, (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "encode is not inline",
    tail:
      "const keep = (value: Int): Option<Text> => None\nconst bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, keep)",
    expected: [
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(text, integer, (value: Text): Option<Int> => None, keep)",
    ],
  },
  {
    name: "decode is not a function",
    tail:
      "const bad = schemaTransform(text, integer, 1, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, 1, (value: Int): Option<Text> => None)",
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(text, integer, 1, (value: Int): Option<Text> => None)",
      "type-mismatch/010 | the callback of `schemaTransform` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "encode is not a function",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, 1)",
    expected: [
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, (value: Text): Option<Int> => None, 1)",
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(text, integer, (value: Text): Option<Int> => None, 1)",
      "type-mismatch/010 | the callback of `schemaTransform` must be a function, but the value has type int | 1",
    ],
  },
  {
    name: "decode returns the wrong Option",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Text> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | schema transformation callbacks must return Option or issue-failing values in their direction | schemaTransform(text, integer, (value: Text): Option<Text> => None, (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "decode returns a bare value",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Int => 1, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | schema transformation callbacks must return Option or issue-failing values in their direction | schemaTransform(text, integer, (value: Text): Int => 1, (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "issue-failing decode returns an Option",
    tail:
      'const bad = schemaTransform(text, integer, (value: Text): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")), (value: Int): Option<Text> => None)',
    expected: [
      'type-mismatch/003 | schema transformation callbacks must return Option or issue-failing values in their direction | schemaTransform(text, integer, (value: Text): Option<Int> fails SchemaIssue => fail(schemaInvalid("x")), (value: Int): Option<Text> => None)',
    ],
  },
  {
    name: "encode returns the wrong type",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Int => value)",
    expected: [
      "type-mismatch/003 | schema transformation callbacks must return Option or issue-failing values in their direction | schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Int => value)",
    ],
  },
  {
    name: "decode takes the wrong parameter",
    tail:
      "const bad = schemaTransform(text, integer, (value: Int): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | parameter 1 of the callback has type Int, but the collection supplies Text | (value: Int): Option<Int> => None",
    ],
  },
  {
    name: "encode takes no parameter",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, (): Option<Text> => None)",
    expected: [
      "type-mismatch/004 | the callback of `schemaTransform` takes 1 parameter, but the function takes 0 | (): Option<Text> => None",
    ],
  },
  {
    name: "every rule fails at once",
    tail:
      "const keep = (value: Text): Text fails Other => fail(Other({}))\nconst bad = schemaTransform(text, integer, keep, keep)",
    expected: [
      "type-mismatch/003 | schema transformation callbacks must return Option or issue-failing values in their direction | schemaTransform(text, integer, keep, keep)",
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(text, integer, keep, keep)",
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(text, integer, keep, keep)",
      "type-mismatch/003 | parameter 1 of the callback has type Text, but the collection supplies Int | keep",
    ],
  },
  {
    name: "service requirement is accepted",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> uses Need.next => Some(Need.next(1)), (value: Int): Option<Text> => None)",
    expected: [],
  },
  {
    name: "too few arguments",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None)",
    expected: [
      "type-mismatch/004 | `schemaTransform` takes 4 arguments, but 3 are given | schemaTransform(text, integer, (value: Text): Option<Int> => None)",
    ],
  },
  {
    name: "too many arguments",
    tail:
      "const bad = schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None, 1)",
    expected: [
      "type-mismatch/004 | `schemaTransform` takes 4 arguments, but 5 are given | schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None, 1)",
    ],
  },
  {
    name: "inferred type",
    tail:
      "const shown: Text = schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | the constant has type Schema<Int, Text, never, never>, but Text is expected | schemaTransform(text, integer, (value: Text): Option<Int> => None, (value: Int): Option<Text> => None)",
    ],
  },
  {
    name: "inferred type with services",
    tail:
      "const shown: Text = schemaTransform(text, integer, (value: Text): Option<Int> uses Need.next => Some(Need.next(1)), (value: Int): Option<Text> => None)",
    expected: [
      "type-mismatch/003 | the constant has type Schema<Int, Text, Need.next, never>, but Text is expected | schemaTransform(text, integer, (value: Text): Option<Int> uses Need.next => Some(Need.next(1)), (value: Int): Option<Text> => None)",
    ],
  },
];

Deno.test("schemaTransform diagnostics keep their lists and order", () => {
  assertSchemaCases(TRANSFORM_CASES);
});

const ARITY_CASES: readonly SchemaCase[] = [
  {
    name: "schema: schema(1)",
    tail: "const bad = schema(1)",
    expected: [
      "type-mismatch/004 | `schema` takes 0 arguments, but 1 is given | schema(1)",
    ],
  },
  {
    name: "schemaArray: schemaArray()",
    tail: "const bad = schemaArray()",
    expected: [
      "type-mismatch/004 | `schemaArray` takes 1 argument, but 0 are given | schemaArray()",
    ],
  },
  {
    name: "schemaArray: schemaArray(text, text)",
    tail: "const bad = schemaArray(text, text)",
    expected: [
      "type-mismatch/004 | `schemaArray` takes 1 argument, but 2 are given | schemaArray(text, text)",
    ],
  },
  {
    name: "schemaStruct: schemaStruct()",
    tail: "const bad = schemaStruct()",
    expected: [
      "type-mismatch/004 | `schemaStruct` takes 1 argument, but 0 are given | schemaStruct()",
    ],
  },
  {
    name: "schemaStruct: schemaStruct({}, {})",
    tail: "const bad = schemaStruct({}, {})",
    expected: [
      "type-mismatch/004 | `schemaStruct` takes 1 argument, but 2 are given | schemaStruct({}, {})",
    ],
  },
  {
    name: "schemaOptionalKey: schemaOptionalKey()",
    tail: "const bad = schemaOptionalKey()",
    expected: [
      "type-mismatch/004 | `schemaOptionalKey` takes 1 argument, but 0 are given | schemaOptionalKey()",
    ],
  },
  {
    name: "schemaOptionalKey: schemaOptionalKey(text, text)",
    tail: "const bad = schemaOptionalKey(text, text)",
    expected: [
      "type-mismatch/004 | `schemaOptionalKey` takes 1 argument, but 2 are given | schemaOptionalKey(text, text)",
    ],
  },
  {
    name: "schemaNullToMissingKey: schemaNullToMissingKey()",
    tail: "const bad = schemaNullToMissingKey()",
    expected: [
      "type-mismatch/004 | `schemaNullToMissingKey` takes 1 argument, but 0 are given | schemaNullToMissingKey()",
    ],
  },
  {
    name: "schemaNullToMissingKey: schemaNullToMissingKey(text, text)",
    tail: "const bad = schemaNullToMissingKey(text, text)",
    expected: [
      "type-mismatch/004 | `schemaNullToMissingKey` takes 1 argument, but 2 are given | schemaNullToMissingKey(text, text)",
    ],
  },
  {
    name: "schemaOptionFromOptionalKey: schemaOptionFromOptionalKey()",
    tail: "const bad = schemaOptionFromOptionalKey()",
    expected: [
      "type-mismatch/004 | `schemaOptionFromOptionalKey` takes 1 argument, but 0 are given | schemaOptionFromOptionalKey()",
    ],
  },
  {
    name:
      "schemaOptionFromOptionalKey: schemaOptionFromOptionalKey(text, text)",
    tail: "const bad = schemaOptionFromOptionalKey(text, text)",
    expected: [
      "type-mismatch/004 | `schemaOptionFromOptionalKey` takes 1 argument, but 2 are given | schemaOptionFromOptionalKey(text, text)",
    ],
  },
  {
    name: "schemaUnion: schemaUnion()",
    tail: "const bad = schemaUnion()",
    expected: [
      "type-mismatch/004 | `schemaUnion` takes 1 argument, but 0 are given | schemaUnion()",
    ],
  },
  {
    name: "schemaUnion: schemaUnion([text, text], 1)",
    tail: "const bad = schemaUnion([text, text], 1)",
    expected: [
      "type-mismatch/004 | `schemaUnion` takes 1 argument, but 2 are given | schemaUnion([text, text], 1)",
    ],
  },
  {
    name: "schemaRecursive: schemaRecursive()",
    tail: "const bad = schemaRecursive()",
    expected: [
      "type-mismatch/004 | `schemaRecursive` takes 1 argument, but 0 are given | schemaRecursive()",
    ],
  },
  {
    name: "schemaRecursive: schemaRecursive((self: Schema<Text>) => text, 1)",
    tail: "const bad = schemaRecursive((self: Schema<Text>) => text, 1)",
    expected: [
      "type-mismatch/004 | `schemaRecursive` takes 1 argument, but 2 are given | schemaRecursive((self: Schema<Text>) => text, 1)",
    ],
  },
  {
    name: "schemaDecode: schemaDecode(text)",
    tail: "const bad = schemaDecode(text)",
    expected: [
      "type-mismatch/004 | `schemaDecode` takes 2 arguments, but 1 is given | schemaDecode(text)",
    ],
  },
  {
    name: "schemaDecode: schemaDecode(text, 1, 2)",
    tail: "const bad = schemaDecode(text, 1, 2)",
    expected: [
      "type-mismatch/004 | `schemaDecode` takes 2 arguments, but 3 are given | schemaDecode(text, 1, 2)",
    ],
  },
  {
    name: "schemaEncode: schemaEncode(text)",
    tail: "const bad = schemaEncode(text)",
    expected: [
      "type-mismatch/004 | `schemaEncode` takes 2 arguments, but 1 is given | schemaEncode(text)",
    ],
  },
  {
    name: "schemaEncode: schemaEncode(text, 1, 2)",
    tail: "const bad = schemaEncode(text, 1, 2)",
    expected: [
      "type-mismatch/004 | `schemaEncode` takes 2 arguments, but 3 are given | schemaEncode(text, 1, 2)",
    ],
  },
  {
    name: "schemaMake: schemaMake(text)",
    tail: "const bad = schemaMake(text)",
    expected: [
      "type-mismatch/004 | `schemaMake` takes 2 arguments, but 1 is given | schemaMake(text)",
    ],
  },
  {
    name: "schemaMake: schemaMake(text, 1, 2)",
    tail: "const bad = schemaMake(text, 1, 2)",
    expected: [
      "type-mismatch/004 | `schemaMake` takes 2 arguments, but 3 are given | schemaMake(text, 1, 2)",
    ],
  },
  {
    name: "schemaInvalid: schemaInvalid()",
    tail: "const bad = schemaInvalid()",
    expected: [
      "type-mismatch/004 | `schemaInvalid` takes 1 argument, but 0 are given | schemaInvalid()",
    ],
  },
  {
    name: 'schemaInvalid: schemaInvalid("a", "b")',
    tail: 'const bad = schemaInvalid("a", "b")',
    expected: [
      'type-mismatch/004 | `schemaInvalid` takes 1 argument, but 2 are given | schemaInvalid("a", "b")',
    ],
  },
  {
    name: 'schemaAt: schemaAt("a")',
    tail: 'const bad = schemaAt("a")',
    expected: [
      'type-mismatch/004 | `schemaAt` takes 2 arguments, but 1 is given | schemaAt("a")',
    ],
  },
  {
    name: 'schemaAt: schemaAt("a", schemaInvalid("b"), 1)',
    tail: 'const bad = schemaAt("a", schemaInvalid("b"), 1)',
    expected: [
      'type-mismatch/004 | `schemaAt` takes 2 arguments, but 3 are given | schemaAt("a", schemaInvalid("b"), 1)',
    ],
  },
  {
    name: 'schemaBoth: schemaBoth(text, schemaInvalid("a"))',
    tail: 'const bad = schemaBoth(text, schemaInvalid("a"))',
    expected: [
      'type-mismatch/004 | `schemaBoth` takes 3 arguments, but 2 are given | schemaBoth(text, schemaInvalid("a"))',
    ],
  },
  {
    name:
      'schemaBoth: schemaBoth(text, schemaInvalid("a"), schemaInvalid("b"), 1)',
    tail:
      'const bad = schemaBoth(text, schemaInvalid("a"), schemaInvalid("b"), 1)',
    expected: [
      'type-mismatch/004 | `schemaBoth` takes 3 arguments, but 4 are given | schemaBoth(text, schemaInvalid("a"), schemaInvalid("b"), 1)',
    ],
  },
  {
    name: "schemaDefaultKey: schemaDefaultKey(text)",
    tail: "const bad = schemaDefaultKey(text)",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 1 is given | schemaDefaultKey(text)",
    ],
  },
  {
    name: "schemaDefaultKey: schemaDefaultKey(text, sample, {}, 1)",
    tail: "const bad = schemaDefaultKey(text, sample, {}, 1)",
    expected: [
      "type-mismatch/004 | `schemaDefaultKey` takes 2 arguments, but 4 are given | schemaDefaultKey(text, sample, {}, 1)",
    ],
  },
  {
    name: "schemaConstructorDefault: schemaConstructorDefault(text)",
    tail: "const bad = schemaConstructorDefault(text)",
    expected: [
      "type-mismatch/004 | `schemaConstructorDefault` takes 2 arguments, but 1 is given | schemaConstructorDefault(text)",
    ],
  },
  {
    name:
      "schemaConstructorDefault: schemaConstructorDefault(text, sample, {})",
    tail: "const bad = schemaConstructorDefault(text, sample, {})",
    expected: [
      "type-mismatch/004 | `schemaConstructorDefault` takes 2 arguments, but 3 are given | schemaConstructorDefault(text, sample, {})",
    ],
  },
  {
    name: "schemaOptionalTransform: schemaOptionalTransform(optional)",
    tail: "const bad = schemaOptionalTransform(optional)",
    expected: [
      "type-mismatch/004 | `schemaOptionalTransform` takes 4 arguments, but 1 is given | schemaOptionalTransform(optional)",
    ],
  },
  {
    name:
      "schemaOptionalTransform: schemaOptionalTransform(optional, optional, 1, 2, 3)",
    tail: "const bad = schemaOptionalTransform(optional, optional, 1, 2, 3)",
    expected: [
      "type-mismatch/004 | `schemaOptionalTransform` takes 4 arguments, but 5 are given | schemaOptionalTransform(optional, optional, 1, 2, 3)",
    ],
  },
  {
    name: "schemaOptionalFromRequired: schemaOptionalFromRequired(text)",
    tail: "const bad = schemaOptionalFromRequired(text)",
    expected: [
      "type-mismatch/004 | `schemaOptionalFromRequired` takes 4 arguments, but 1 is given | schemaOptionalFromRequired(text)",
    ],
  },
  {
    name:
      "schemaOptionalFromRequired: schemaOptionalFromRequired(text, optionalText, 1, 2, 3)",
    tail: "const bad = schemaOptionalFromRequired(text, optionalText, 1, 2, 3)",
    expected: [
      "type-mismatch/004 | `schemaOptionalFromRequired` takes 4 arguments, but 5 are given | schemaOptionalFromRequired(text, optionalText, 1, 2, 3)",
    ],
  },
  {
    name: "schemaTransform: schemaTransform(text)",
    tail: "const bad = schemaTransform(text)",
    expected: [
      "type-mismatch/004 | `schemaTransform` takes 4 arguments, but 1 is given | schemaTransform(text)",
    ],
  },
  {
    name: "schemaTransform: schemaTransform(text, text, 1, 2, 3)",
    tail: "const bad = schemaTransform(text, text, 1, 2, 3)",
    expected: [
      "type-mismatch/004 | `schemaTransform` takes 4 arguments, but 5 are given | schemaTransform(text, text, 1, 2, 3)",
    ],
  },
];

Deno.test("every Schema builtin reports its expected argument count", () => {
  assertSchemaCases(ARITY_CASES);
});

const PIPELINE_CASES: readonly SchemaCase[] = [
  {
    name: "array",
    tail: "const bad = text |> schemaArray()",
    expected: [
      "type-mismatch/010 | `schemaArray` requires direct call syntax | text",
    ],
  },
  {
    name: "optional key",
    tail: "const bad = text |> schemaOptionalKey()",
    expected: [
      "type-mismatch/010 | `schemaOptionalKey` requires direct call syntax | text",
    ],
  },
  {
    name: "transform",
    tail: "const bad = text |> schemaTransform(integer, 1, 2)",
    expected: [
      "type-mismatch/010 | `schemaTransform` requires direct call syntax | text",
      "type-mismatch/010 | schema transformations may fail only with SchemaIssue | schemaTransform(integer, 1, 2)",
      "type-mismatch/010 | schemaTransform needs inline callbacks | schemaTransform(integer, 1, 2)",
      "type-mismatch/010 | the callback of `schemaTransform` must be a function, but the value has type int | 1",
      "type-mismatch/010 | the callback of `schemaTransform` must be a function, but the value has type int | 2",
    ],
  },
  {
    name: "default key",
    tail: "const bad = text |> schemaDefaultKey(sample)",
    expected: [
      "type-mismatch/010 | `schemaDefaultKey` requires direct call syntax | text",
      "type-mismatch/010 | schemaDefaultKey needs an inline default callback | sample",
    ],
  },
  {
    name: "constructor default",
    tail: "const bad = integer |> schemaConstructorDefault(sample)",
    expected: [
      "type-mismatch/010 | `schemaConstructorDefault` requires direct call syntax | integer",
      "type-mismatch/010 | schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure | sample",
    ],
  },
  {
    name: "decode",
    tail: 'const bad = text |> schemaDecode("x")',
    expected: [
      "type-mismatch/010 | `schemaDecode` requires direct call syntax | text",
      'execution-mode/002 | a module constant must have a pure initializer with empty failure and requirement sets | text |> schemaDecode("x")',
    ],
  },
  {
    name: "union",
    tail: "const bad = [text, text] |> schemaUnion()",
    expected: [
      "type-mismatch/010 | `schemaUnion` requires direct call syntax | [text, text]",
    ],
  },
  {
    name: "both",
    tail:
      'const bad = text |> schemaBoth(schemaInvalid("a"), schemaInvalid("b"))',
    expected: [
      "type-mismatch/010 | `schemaBoth` requires direct call syntax | text",
    ],
  },
];

Deno.test("Schema builtins reject a piped first argument after the arity check", () => {
  assertSchemaCases(PIPELINE_CASES);
});

const MAKE_INPUT_CASES: readonly SchemaCase[] = [
  {
    name: "identity",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst forged: Schema<Pair, Pair, never, never, PairMake> = schema()",
    expected: [
      "type-mismatch/010 | schema does not yet preserve constructor make-input metadata | schema()",
    ],
  },
  {
    name: "array",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaArray(pair)",
    expected: [],
  },
  {
    name: "union",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaUnion([pair, pair])",
    expected: [],
  },
  {
    name: "struct",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaStruct({ pair })",
    expected: [],
  },
  {
    name: "optional key",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaOptionalKey(pair)",
    expected: [],
  },
  {
    name: "null to missing key",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaNullToMissingKey(pair)",
    expected: [],
  },
  {
    name: "option from optional key",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaOptionFromOptionalKey(pair)",
    expected: [],
  },
  {
    name: "default key",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaDefaultKey(pair, (): Pair => ({ score: 1 }))",
    expected: [],
  },
  {
    name: "default null key",
    tail:
      'type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaDefaultKey(pair, (): Pair => ({ score: 1 }), { on: "null" })',
    expected: [],
  },
  {
    name: "default encoded key",
    tail:
      'type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaDefaultKey(pair, (): Pair => ({ score: 1 }), { on: "encoded" })',
    expected: [],
  },
  {
    name: "constructor default",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaConstructorDefault(pair, (): PairMake => ({}))",
    expected: [],
  },
  {
    name: "optional from required",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaOptionalFromRequired(pair, schemaOptionalKey(pair), (value: Pair): Option<Pair> => Some(value), (value: Option<Pair>): Pair => match value { Some(inner) => inner, None => ({ score: 1 }) })",
    expected: [],
  },
  {
    name: "transform source",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaTransform(pair, text, (value: Pair): Option<Text> => None, (value: Text): Option<Pair> => None)",
    expected: [],
  },
  {
    name: "transform target",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaTransform(text, pair, (value: Text): Option<Pair> => None, (value: Pair): Option<Text> => None)",
    expected: [],
  },
  {
    name: "make",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = (): Pair fails SchemaIssue => schemaMake(pair, {})",
    expected: [],
  },
  {
    name: "decode",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = (): Pair fails SchemaError => schemaDecode(pair, {})",
    expected: [],
  },
  {
    name: "encode",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = (): Pair fails SchemaError => schemaEncode(pair, { score: 1 })",
    expected: [],
  },
  {
    name: "recursive",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\ntype Tree = { score: Int, children: Tree[] }\ntype TreeInput = { score: Int, children?: TreeInput[] }\nconst bad: Schema<Tree, Tree, never, never, TreeInput> = schemaRecursive((self: Schema<Tree, Tree, never, never, TreeInput>): Schema<Tree, Tree, never, never, TreeInput> => schemaStruct({ score: integer, children: schemaConstructorDefault(schemaArray(self), (): TreeInput[] => []) }))",
    expected: [],
  },
  {
    name: "both",
    tail:
      'type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst bad = schemaBoth(pair, schemaInvalid("a"), schemaInvalid("b"))',
    expected: [],
  },
  {
    name: "inferred struct type",
    tail:
      "type Pair = { score: Int }\ntype PairMake = { score?: Int }\nconst pair: Schema<Pair, Pair, never, never, PairMake> = schemaStruct({ score: schemaConstructorDefault(integer, (): Int => 4) })\nconst shown: Int = schemaStruct({ plain: integer, opt: optional, kept: pair, dflt: schemaConstructorDefault(integer, (): Int => 1) })",
    expected: [
      "type-mismatch/003 | the constant has type Schema<{ dflt: Int, kept: Pair, opt?: Int, plain: Int }, { dflt: Int, kept: Pair, opt?: Int, plain: Int }, never, never, { dflt?: Int, kept: PairMake, opt?: Int, plain: Int }>, but Int is expected | schemaStruct({ plain: integer, opt: optional, kept: pair, dflt: schemaConstructorDefault(integer, (): Int => 1) })",
    ],
  },
];

Deno.test("constructor make-input metadata passes only through the supported builtins", () => {
  assertSchemaCases(MAKE_INPUT_CASES);
});

const STRUCT_CASES: readonly SchemaCase[] = [
  {
    name: "accepts required Schema fields",
    tail: "const ok = schemaStruct({ a: integer, b: text })",
    expected: [],
  },
  {
    name: "input is not a record",
    tail: "const bad = schemaStruct(1)",
    expected: [
      "type-mismatch/010 | `schemaStruct` needs a record of required Schema fields | 1",
    ],
  },
  {
    name: "a field is not a Schema",
    tail: "const bad = schemaStruct({ a: integer, b: 1 })",
    expected: [
      "type-mismatch/010 | `schemaStruct` fields must be Schema values or schemaOptionalKey descriptors | { a: integer, b: 1 }",
    ],
  },
  {
    name: "every field is not a Schema",
    tail: 'const bad = schemaStruct({ a: 1, b: "x" })',
    expected: [
      'type-mismatch/010 | `schemaStruct` fields must be Schema values or schemaOptionalKey descriptors | { a: 1, b: "x" }',
    ],
  },
  {
    name: "inferred plain type",
    tail: "const shown: Text = schemaStruct({ a: integer, b: text })",
    expected: [
      "type-mismatch/003 | the constant has type Schema<{ a: Int, b: Text }, { a: Int, b: Text }, never, never>, but Text is expected | schemaStruct({ a: integer, b: text })",
    ],
  },
  {
    name: "inferred descriptor type",
    tail:
      "const shown: Text = schemaStruct({ a: integer, b: optional, c: schemaOptionFromOptionalKey(integer), d: schemaDefaultKey(integer, (): Int => 1), e: schemaConstructorDefault(integer, (): Int => 1), f: schemaNullToMissingKey(integer) })",
    expected: [
      "type-mismatch/003 | the constant has type Schema<{ a: Int, b?: Int, c: Option<Int>, d: Int, e: Int, f?: Int }, { a: Int, b?: Int, c?: Int, d?: Int, e: Int, f?: Int | null }, never, never, { a: Int, b?: Int, c: Option<Int>, d: Int, e?: Int, f?: Int }>, but Text is expected | schemaStruct({ a: integer, b: optional, c: schemaOptionFromOptionalKey(integer), d: schemaDefaultKey(integer, (): Int => 1), e: schemaConstructorDefault(integer, (): Int => 1), f: schemaNullToMissingKey(integer) })",
    ],
  },
  {
    name: "inferred requirement type",
    tail:
      "const shown: Text = schemaStruct({ a: schemaTransform(text, integer, (value: Text): Option<Int> uses Need.next => Some(Need.next(1)), (value: Int): Option<Text> => None) })",
    expected: [
      "type-mismatch/003 | the constant has type Schema<{ a: Int }, { a: Text }, Need.next, never>, but Text is expected | schemaStruct({ a: schemaTransform(text, integer, (value: Text): Option<Int> uses Need.next => Some(Need.next(1)), (value: Int): Option<Text> => None) })",
    ],
  },
];

Deno.test("schemaStruct keeps its field rules and result type", () => {
  assertSchemaCases(STRUCT_CASES);
});

const ISSUE_AND_HINT_CASES: readonly SchemaCase[] = [
  {
    name: "invalid accepts a message",
    tail: 'const ok = schemaInvalid("x")',
    expected: [],
  },
  {
    name: "invalid needs a string",
    tail: "const bad = schemaInvalid(1)",
    expected: [
      "type-mismatch/003 | schema issue message has type int, but string is expected | 1",
    ],
  },
  {
    name: "at accepts a string key",
    tail: 'const ok = schemaAt("a", schemaInvalid("b"))',
    expected: [],
  },
  {
    name: "at accepts an int key",
    tail: 'const ok = schemaAt(1, schemaInvalid("b"))',
    expected: [],
  },
  {
    name: "at rejects the key type",
    tail: 'const bad = schemaAt(true, schemaInvalid("b"))',
    expected: [
      "type-mismatch/003 | schema issue key has type boolean, but int | string is expected | true",
    ],
  },
  {
    name: "at rejects the nested issue",
    tail: 'const bad = schemaAt("a", 1)',
    expected: [
      "type-mismatch/003 | nested schema issue has type int, but error:effect/SchemaIssue is expected | 1",
    ],
  },
  {
    name: "both accepts a Schema and two issues",
    tail: 'const ok = schemaBoth(text, schemaInvalid("a"), schemaInvalid("b"))',
    expected: [],
  },
  {
    name: "both rejects an optional descriptor",
    tail:
      'const bad = schemaBoth(optionalText, schemaInvalid("a"), schemaInvalid("b"))',
    expected: [
      "type-mismatch/010 | `schemaBoth` needs a Schema value | optionalText",
    ],
  },
  {
    name: "both rejects both issues",
    tail: "const bad = schemaBoth(text, 1, 2)",
    expected: [
      "type-mismatch/003 | left schema issue has type int, but error:effect/SchemaIssue is expected | 1",
      "type-mismatch/003 | right schema issue has type int, but error:effect/SchemaIssue is expected | 2",
    ],
  },
  {
    name: "schema without an expected type",
    tail: "const bad = schema()",
    expected: [
      "type-mismatch/010 | `schema` needs an expected Schema type | schema()",
    ],
  },
  {
    name: "schema with a non-Schema expected type",
    tail: "const bad: Int = schema()",
    expected: [
      "type-mismatch/010 | `schema` needs an expected Schema type | schema()",
    ],
  },
  {
    name: "schema with an unknown expected type",
    tail: "const bad: Missing = schema()",
    expected: ["unknown-name/001 | unknown type `Missing` | Missing"],
  },
  {
    name: "schema with a Schema of an unknown type",
    tail: "const bad: Schema<Missing> = schema()",
    expected: ["unknown-name/001 | unknown type `Missing` | Missing"],
  },
  {
    name: "schema with a service identity",
    tail: "const bad: Schema<Text, Text, Need.next> = schema()",
    expected: [
      "type-mismatch/003 | `schema()` needs an identity Schema with no services | schema()",
    ],
  },
  {
    name: "schema with a different encoded type",
    tail: "const bad: Schema<Text, Int> = schema()",
    expected: [
      "type-mismatch/003 | `schema()` needs an identity Schema with no services | schema()",
    ],
  },
  {
    name: "schema with an optional descriptor type",
    tail: "const bad: SchemaOptional<Text> = schema()",
    expected: [
      "type-mismatch/010 | `schema` needs a Schema value | schema()",
    ],
  },
  {
    name: "recursive without an expected type",
    tail: "const bad = schemaRecursive((self: Schema<Text>) => text)",
    expected: [
      "type-mismatch/010 | `schemaRecursive` needs an expected Schema type | schemaRecursive((self: Schema<Text>) => text)",
    ],
  },
  {
    name: "recursive with a non-Schema expected type",
    tail: "const bad: Int = schemaRecursive((self: Schema<Text>) => text)",
    expected: [
      "type-mismatch/010 | `schemaRecursive` needs an expected Schema type | schemaRecursive((self: Schema<Text>) => text)",
    ],
  },
  {
    name: "recursive with an unknown expected type",
    tail: "const bad: Missing = schemaRecursive((self: Schema<Text>) => text)",
    expected: ["unknown-name/001 | unknown type `Missing` | Missing"],
  },
  {
    name: "recursive callback is not guarded",
    tail:
      "const bad: Schema<Text> = schemaRecursive((self: Schema<Text>) => self)",
    expected: [
      "type-mismatch/010 | recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch | (self: Schema<Text>) => self",
    ],
  },
  {
    name: "recursive body has the wrong type",
    tail:
      "const bad: Schema<Text> = schemaRecursive((self: Schema<Text>) => integer)",
    expected: [
      "type-mismatch/003 | recursive schema body does not fit its expected Schema | (self: Schema<Text>) => integer",
      "type-mismatch/010 | recursive schema self must occur beneath an array, optional key, or tagged union with a terminal branch | (self: Schema<Text>) => integer",
    ],
  },
  {
    name: "union rejects a non-list",
    tail: "const bad = schemaUnion(text)",
    expected: [
      "type-mismatch/010 | `schemaUnion` needs an inline list of Schema branches | text",
    ],
  },
  {
    name: "union needs two branches",
    tail: "const bad = schemaUnion([text])",
    expected: [
      "type-mismatch/010 | `schemaUnion` needs at least two ordinary Schema branches | [text]",
    ],
  },
  {
    name: "union rejects an optional branch",
    tail: "const bad = schemaUnion([text, optionalText])",
    expected: [
      "type-mismatch/010 | `schemaUnion` needs at least two ordinary Schema branches | [text, optionalText]",
      "type-mismatch/010 | `schemaUnion` needs a Schema value | optionalText",
    ],
  },
  {
    name: "union accepts two branches",
    tail: "const shown: Int = schemaUnion([text, integer])",
    expected: [
      "type-mismatch/003 | the constant has type Schema<Int | Text, Int | Text, never, never>, but Int is expected | schemaUnion([text, integer])",
    ],
  },
  {
    name: "null to missing key rejects a nullable schema",
    tail: "const bad = schemaNullToMissingKey(nullable)",
    expected: [
      "type-mismatch/010 | schemaNullToMissingKey needs nonnullable decoded and encoded field types | nullable",
    ],
  },
  {
    name: "null to missing key accepts a plain schema",
    tail: "const shown: Int = schemaNullToMissingKey(text)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaOptional<Text, Text | null, never, never>, but Int is expected | schemaNullToMissingKey(text)",
    ],
  },
  {
    name: "optional key inferred type",
    tail: "const shown: Int = schemaOptionalKey(text)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaOptional<Text, Text, never, never>, but Int is expected | schemaOptionalKey(text)",
    ],
  },
  {
    name: "option from optional key rejects an optional descriptor",
    tail: "const bad = schemaOptionFromOptionalKey(optionalText)",
    expected: [
      "type-mismatch/010 | `schemaOptionFromOptionalKey` needs a Schema value | optionalText",
    ],
  },
  {
    name: "option from optional key inferred type",
    tail: "const shown: Int = schemaOptionFromOptionalKey(text)",
    expected: [
      "type-mismatch/003 | the constant has type SchemaEncodedOptional<Option<Text>, Text, never, never>, but Int is expected | schemaOptionFromOptionalKey(text)",
    ],
  },
  {
    name: "array inferred type",
    tail: "const shown: Int = schemaArray(text)",
    expected: [
      "type-mismatch/003 | the constant has type Schema<Text[], Text[], never, never>, but Int is expected | schemaArray(text)",
    ],
  },
  {
    name: "array rejects an optional descriptor",
    tail: "const bad = schemaArray(optionalText)",
    expected: [
      "type-mismatch/010 | `schemaArray` needs a Schema value | optionalText",
    ],
  },
  {
    name: "decode result type mismatch",
    tail: "const shown = (): Int => schemaDecode(text, 1)",
    expected: [
      "failure-contract/001 | the body can fail with error:effect/SchemaError, which the `fails` clause does not list | schemaDecode(text, 1)",
      "type-mismatch/003 | the function body has type Text, but Int is expected | schemaDecode(text, 1)",
    ],
  },
  {
    name: "decode rejects an optional descriptor",
    tail: "const bad = (): Text => schemaDecode(optionalText, 1)",
    expected: [
      "failure-contract/001 | the body can fail with error:effect/SchemaError, which the `fails` clause does not list | schemaDecode(optionalText, 1)",
      "type-mismatch/010 | `schemaDecode` needs a Schema value | optionalText",
    ],
  },
  {
    name: "encode input mismatch",
    tail: "const bad = (): Text => schemaEncode(text, 1)",
    expected: [
      "failure-contract/001 | the body can fail with error:effect/SchemaError, which the `fails` clause does not list | schemaEncode(text, 1)",
      "type-mismatch/003 | the schema encode input has type int, but Text is expected | 1",
    ],
  },
  {
    name: "make input mismatch",
    tail: "const bad = (): Text => schemaMake(text, 1)",
    expected: [
      "failure-contract/001 | the body can fail with error:effect/SchemaIssue, which the `fails` clause does not list | schemaMake(text, 1)",
      "type-mismatch/003 | the schema make input has type int, but Text is expected | 1",
    ],
  },
];

Deno.test("issue builders and expected-type Schema forms keep their diagnostics", () => {
  assertSchemaCases(ISSUE_AND_HINT_CASES);
});

Deno.test("the seeded stream operations report an effectful seed with their own name", () => {
  const cases = [
    {
      name: "scanStream",
      use:
        "const bad = scanStream(source, Seed.next(), (total, n) => total + n)",
    },
    {
      name: "mapAccumStream",
      use:
        "const bad = mapAccumStream(source, Seed.next(), (total, n): [Int, Int[]] => [total + n, [n]])",
    },
    {
      name: "foldStream",
      use:
        "const bad = (): Int uses Seed.next => foldStream(source, Seed.next(), (total, n) => total + n)",
    },
    {
      name: "foldEffectStream",
      use:
        "const bad = (): Int uses Seed.next => foldEffectStream(source, Seed.next(), (total, n) => total + n)",
    },
  ];
  for (const { name, use } of cases) {
    const project = checkText(`
type Int = int
service Seed { next(): Int }
const source = unfold(0, (n): Option<[Int, Int]> => None)
${use}
`);
    assertEquals(
      messages(project).filter((m) => m.startsWith("execution-mode/001")),
      [`execution-mode/001 \`${name}\` seed must be pure`],
      messages(project).join("\n"),
    );
  }
});

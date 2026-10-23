// Tests for part A6a: the Effect-TS emitter. The tests run through the public
// entries `emitModule` and `emitProject` and compare the emitted text.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { emitModule, emitProject } from "../src/core/emit/emit.ts";
import { relativeSpecifier } from "../src/core/emit/scope.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import {
  emitExamples,
  emitFiles,
  EXAMPLE_ENTRIES,
  FIXTURES,
  projectFiles,
} from "./helpers.ts";

function oneModule(text: string): string {
  const files = { "effective.json": "{}", "m.eff": text };
  const emitted = emitFiles(files, ["m.eff"]).get("m");
  assert(emitted !== undefined, "module m was not emitted");
  return emitted.text;
}

function indexOfOrFail(text: string, needle: string): number {
  const at = text.indexOf(needle);
  assert(at >= 0, `the text does not contain ${needle}`);
  return at;
}

Deno.test("withResource emits acquireUseRelease with suspended callbacks", () => {
  const output = oneModule(`
service Files { open(): { read: () => Text, close: () => void } }
export const load = (): Text uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
type Text = string
`);
  assertStringIncludes(output, "Effect.acquireUseRelease(");
  assertStringIncludes(output, "Effect.suspend(() =>");
  assertStringIncludes(output, "file.read()");
  assertStringIncludes(output, "file.close()");
});

Deno.test("bounded traverse passes the concurrency literal to Effect.forEach", () => {
  const output = oneModule(
    `const f = (): Int[] => traverse([1, 2], (n) => n + 1, { concurrency: 2 })\ntype Int = int`,
  );
  assertStringIncludes(output, "Effect.forEach([1, 2]");
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("unbounded traverse passes its literal to Effect.forEach", () => {
  const output = oneModule(
    'const f = (): Int[] => traverse([1, 2], (n) => n + 1, { concurrency: "unbounded" })\ntype Int = int',
  );
  assertStringIncludes(output, "Effect.forEach([1, 2]");
  assertStringIncludes(output, 'concurrency: "unbounded"');
});

Deno.test("all emits heterogeneous Effect collections", () => {
  const output = oneModule(`
type Int = int
type Text = string
type Jobs = [Effect<Int>, Effect<Text>]
const jobs: Jobs = [defer(() => 1), defer(() => "ok")]
export const tuple = (): [Int, Text] => all(jobs, { concurrency: "unbounded" })
export const record = (): { number: Int, text: Text } =>
  all({ number: defer(() => 1), text: defer(() => "ok") }, { concurrency: 2 })
`);
  assertStringIncludes(
    output,
    'Effect.all(jobs, { concurrency: "unbounded" })',
  );
  assertStringIncludes(output, "Effect.all({");
  assertStringIncludes(output, "number: Effect.suspend(");
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("partitionAll emits Effect.partition with a concurrency bound", () => {
  const output = oneModule(`
error Stop = { n: Int }
service Jobs { run(n: Int): Int fails Stop }
type Int = int
export const main = (): [Int[], Stop[]] uses Jobs.run =>
  partitionAll([defer(() => Jobs.run(0)), defer(() => Jobs.run(1))], { concurrency: 2 })
`);
  assertStringIncludes(output, "Effect.partition(");
  assertStringIncludes(output, "(job) => job");
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("validateAll emits Effect.validate and maps errors", () => {
  const output = oneModule(`
error Stop = { n: Int }
error Problems = { errors: Stop[] }
service Jobs { run(n: Int): Int fails Stop }
type Int = int
export const main = (): Int[] fails Problems uses Jobs.run =>
  validateAll([defer(() => Jobs.run(0)), defer(() => Jobs.run(1))], (errors) => Problems({ errors }), { concurrency: 2 })
`);
  assertStringIncludes(output, "Effect.validate(");
  assertStringIncludes(output, "Effect.mapError(");
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("allResults emits Effect.all in result mode", () => {
  const output = oneModule(`
type Int = int
error Stop = { n: Int }
service Jobs { run(n: Int): Int fails Stop }
type Outcome = { _tag: "Success", success: Int } | { _tag: "Failure", failure: Stop }
export const main = (): Outcome[] uses Jobs.run =>
  allResults([defer(() => Jobs.run(0)), defer(() => Jobs.run(1))], { concurrency: 2 })
`);
  assertStringIncludes(output, "Effect.all(");
  assertStringIncludes(output, 'mode: "result"');
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("scoped fiber emission provides a local scope", () => {
  const output = oneModule(`
type Int = int
export const main = (): Int => scoped(defer(() => {
  forkScoped(defer(() => 1))
  2
}))
`);
  assertStringIncludes(output, "Effect.scoped(");
  assertStringIncludes(output, "Effect.forkScoped(");
});

Deno.test("stream operations emit the Effect 4 Stream and Sink APIs", () => {
  const output = oneModule(`
service Source { next(state: Int): Option<[Int, Int]> }
service Consumer { accept(value: Int): void }
const source = unfold(0, (state) => Source.next(state))
const mapped = mapEffect(source, (value) => value + 1, { concurrency: 2 })
const sink = sinkForEach((value: Int) => Consumer.accept(value))
export const main = (): void uses Source.next | Consumer.accept => runStream(mapped, sink)
type Int = int
`);
  assertStringIncludes(output, "Stream.unfold(");
  assertStringIncludes(output, "Option.getOrUndefined");
  assertStringIncludes(output, "Stream.mapEffect(");
  assertStringIncludes(output, "Sink.forEach(");
  assertStringIncludes(output, "Stream.run(mapped, sink)");
});

Deno.test("takeStream emits Stream.take with a dynamic count", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const limit = (count: Int): Stream<Int, never, Source.next> =>
  takeStream(source, count)
`);
  assertStringIncludes(output, "Stream.take(source, count)");
});

Deno.test("dropStream emits Stream.drop with a dynamic count", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const limit = (count: Int): Stream<Int, never, Source.next> =>
  dropStream(source, count)
`);
  assertStringIncludes(output, "Stream.drop(source, count)");
});

Deno.test("takeWhileEffectStream with a pure callback emits Stream.takeWhile", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const prefix: Stream<Int, never, Source.next> =
  takeWhileEffectStream(source, (n) => n < 3)
`);
  assertStringIncludes(output, "Stream.takeWhile(");
  assertStringIncludes(output, "(n) => n < 3");
});

Deno.test("dropWhileEffectStream with a pure callback emits Stream.dropWhile", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const prefix: Stream<Int, never, Source.next> =
  dropWhileEffectStream(source, (n) => n < 3)
`);
  assertStringIncludes(output, "Stream.dropWhile(");
  assertStringIncludes(output, "(n) => n < 3");
});

Deno.test("takeUntilEffectStream with a pure callback emits Stream.takeUntil", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const prefix: Stream<Int, never, Source.next> =
  takeUntilEffectStream(source, (n) => n === 3)
`);
  assertStringIncludes(output, "Stream.takeUntil(");
  assertStringIncludes(output, "(n) => n === 3");
});

Deno.test("filterEffectStream with a pure callback emits Stream.filter", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const prefix: Stream<Int, never, Source.next> =
  filterEffectStream(source, (n) => n < 3)
`);
  assertStringIncludes(output, "Stream.filter(");
  assertStringIncludes(output, ") => n < 3");
});

Deno.test("mapEffect with a pure callback emits pure Stream.map with a changed element type", () => {
  const output = oneModule(`
type Int = int
type Bool = boolean
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const mapped: Stream<Bool, never, Source.next> =
  mapEffect(source, (n) => n < 3)
`);
  assertStringIncludes(output, "Stream.map(");
  assertStringIncludes(output, ") => n < 3");
  assertStringIncludes(output, "Stream.Stream<Bool, never, Source>");
});

Deno.test("mapEffect with a pure callback and a concurrency option stays Stream.mapEffect", () => {
  const output = oneModule(`
type Int = int
type Bool = boolean
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const mapped: Stream<Bool, never, Source.next> =
  mapEffect(source, (n) => n < 3, { concurrency: 2 })
`);
  assertStringIncludes(output, "Stream.mapEffect(");
});

Deno.test("a stream predicate with an effectful callback emits the effect operation", () => {
  const output = oneModule(`
type Int = int
type Bool = boolean
service Source { next(state: Int): Option<[Int, Int]> }
service Probe { accept(n: Int): Bool }
const source = unfold(0, (state) => Source.next(state))
export const prefix: Stream<Int, never, Source.next | Probe.accept> =
  filterEffectStream(source, (n) => Probe.accept(n))
`);
  assertStringIncludes(output, "Stream.filterEffect(");
});

Deno.test("scanStream emits Stream.scan with a lazy seed", () => {
  const scanned = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const result: Stream<Int, never, Source.next> =
  scanStream(source, 0, (total, n) => total + n)
`);
  assertStringIncludes(scanned, "Stream.scan(");
  assertStringIncludes(scanned, "() => 0");
  assertStringIncludes(scanned, "total + n");
});

Deno.test("mapAccumStream emits Stream.mapAccum with a lazy seed", () => {
  const output = oneModule(`
type Int = int
type Bool = boolean
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const result: Stream<Bool, never, Source.next> =
  mapAccumStream(source, 0, (total, n): [Int, Bool[]] => [total + n, [n < 3]])
`);
  assertStringIncludes(output, "Stream.mapAccum(");
  assertStringIncludes(output, "() => 0");
  assertStringIncludes(output, "total + n");
});

Deno.test("foldStream emits Stream.runFold with a lazy seed", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const main = (seed: Int): Int uses Source.next =>
  foldStream(source, seed, (total, n) => total + n)
`);
  assertStringIncludes(output, "Stream.runFold(");
  assertStringIncludes(output, "() => seed");
  assertStringIncludes(output, "total + n");
});

Deno.test("foldEffectStream emits an Effect-valued Stream.runFoldEffect callback", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
service Accum { add(total: Int, n: Int): Int }
const source = unfold(0, (state) => Source.next(state))
export const main = (seed: Int): Int uses Source.next | Accum.add =>
  foldEffectStream(source, seed, (total, n) => Accum.add(total, n))
`);
  assertStringIncludes(output, "Stream.runFoldEffect(");
  assertStringIncludes(output, "() => seed");
  assertStringIncludes(output, "Accum.use(");
});

Deno.test("collectStream emits Stream.runCollect", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const main = (): Int[] uses Source.next => collectStream(source)
`);
  assertStringIncludes(output, "Stream.runCollect(source)");
});

Deno.test("headStream emits Stream.runHead", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const main = (): Option<Int> uses Source.next => headStream(source)
`);
  assertStringIncludes(output, "Stream.runHead(source)");
});

Deno.test("lastStream emits Stream.runLast", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const main = (): Option<Int> uses Source.next => lastStream(source)
`);
  assertStringIncludes(output, "Stream.runLast(source)");
});

Deno.test("drainStream emits Stream.runDrain", () => {
  const output = oneModule(`
type Int = int
service Source { next(state: Int): Option<[Int, Int]> }
const source = unfold(0, (state) => Source.next(state))
export const main = (): void uses Source.next => drainStream(source)
`);
  assertStringIncludes(output, "Stream.runDrain(source)");
});

Deno.test("buffered merged streams emit bounded suspending buffers", () => {
  const output = oneModule(`
service Source { next(state: Int): Option<[Int, Int]> }
service Consumer { accept(value: Int): void }
const first = unfold(0, (state) => Source.next(state))
const second = unfold(10, (state) => Source.next(state))
const combined = mergeStreams(bufferStream(first, { capacity: 2 }), second)
const sink = sinkForEach((value: Int) => Consumer.accept(value))
export const main = (): void uses Source.next | Consumer.accept => runStream(combined, sink)
type Int = int
`);
  assertStringIncludes(
    output,
    'Stream.buffer(first, { capacity: 2, strategy: "suspend" })',
  );
  assertStringIncludes(output, "Stream.merge(");
});

Deno.test("zipped streams emit Stream.zip", () => {
  const output = oneModule(`
service Source { next(state: Int): Option<[Int, Int]> }
const first = unfold(0, (state) => Source.next(state))
const second = unfold(10, (state) => Source.next(state))
const pairs = zipStreams(first, second)
type Int = int
`);
  assertStringIncludes(output, "Stream.zip(");
});

Deno.test("concatenated streams emit Stream.concat", () => {
  const output = oneModule(`
service Source { next(state: Int): Option<[Int, Int]> }
const first = unfold(0, (state) => Source.next(state))
const second = unfold(10, (state) => Source.next(state))
const values = concatStreams(first, second)
type Int = int
`);
  assertStringIncludes(output, "Stream.concat(");
});

Deno.test("flat mapped streams emit a pure Stream.flatMap callback", () => {
  const output = oneModule(`
service Source { next(state: Int): Option<[Int, Int]> }
const outer = unfold(0, (state) => Source.next(state))
const nested = flatMapStreams(outer, (value) => unfold(value, (state) => Source.next(state)))
type Int = int
`);
  assertStringIncludes(output, "Stream.flatMap(");
  assertStringIncludes(output, "Stream.unfold(");
});

Deno.test("switchMapStreams emits Stream.switchMap", () => {
  const output = oneModule(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const outer = unfold(0, (n) => Source.next(n))
const switched = switchMapStreams(outer, (n) => unfold(n, (m) => Source.next(m)))
`);
  assertStringIncludes(output, "Stream.switchMap(");
});

Deno.test("catchStream emits Stream.catch", () => {
  const output = oneModule(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const recovered = catchStream(source, (_) => unfold(1, (n) => Source.next(n)))
`);
  assertStringIncludes(output, "Stream.catch(");
});

Deno.test("retryStream emits Stream.retry with a source policy", () => {
  const output = oneModule(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((_: Stop, attempt: Int): Option<Int> => None)
const source = unfold(0, (n) => Source.next(n))
const retried = retryStream(source, policy)
`);
  assertStringIncludes(output, "Stream.retry(");
});

Deno.test("temporal stream controls emit duration and per-element throttle", () => {
  const output = oneModule(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const source = unfold(0, (n) => Source.next(n))
const debounced = debounceStream(source, 0)
const throttled = throttleStream(source, { units: 2, durationMs: 100, strategy: "enforce" })
`);
  assertStringIncludes(output, "Stream.debounce(");
  assertStringIncludes(output, "Duration.millis(0)");
  assertStringIncludes(output, "Stream.throttle(");
  assertStringIncludes(output, "Stream.rechunk(");
  assertStringIncludes(output, 'strategy: "enforce"');
});

Deno.test("concurrent stream mapping emits pinned concurrency options", () => {
  const output = oneModule(`
type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
service Worker { work(n: Int): Int }
const source = unfold(0, (n) => Source.next(n))
const mapped = mapEffect(source, (n) => Worker.work(n), { concurrency: 2 })
const nested = flatMapStreams(source, (n) => unfold(n, (m) => Source.next(m)), { concurrency: "unbounded" })
`);
  assertStringIncludes(output, "Stream.mapEffect(");
  assertStringIncludes(output, "{ concurrency: 2 }");
  assertStringIncludes(output, "Stream.flatMap(");
  assertStringIncludes(output, '{ concurrency: "unbounded" }');
});

Deno.test("effectful stream predicates emit the corresponding Effect operators", () => {
  const output = oneModule(`
type Int = int
type Bool = boolean
service Source { next(n: Int): Option<[Int, Int]> }
service Gate { check(n: Int): Bool }
const source = unfold(0, (n) => Source.next(n))
const filtered = filterEffectStream(source, (n) => Gate.check(n))
const taken = takeWhileEffectStream(source, (n) => Gate.check(n))
const until = takeUntilEffectStream(source, (n) => Gate.check(n))
const dropped = dropWhileEffectStream(source, (n) => Gate.check(n))
`);
  for (
    const method of [
      "filterEffect",
      "takeWhileEffect",
      "takeUntilEffect",
      "dropWhileEffect",
    ]
  ) {
    assertStringIncludes(output, `Stream.${method}(`);
  }
});

Deno.test("a source race emits Effect.race and executes only when run", () => {
  const output = oneModule(`
type Int = int
export const choose = (): Int =>
  run(race(defer(() => 1), defer(() => 2)))
`);
  assertStringIncludes(output, "Effect.race(");
  assertStringIncludes(output, "Effect.suspend(");
});

Deno.test("reference operations emit Effect 4 Ref methods", () => {
  const output = oneModule(`
type Int = int
export const count = (): Int => {
  const ref = makeRef(0)
  updateRef(ref, (n) => n + 1)
  setRef(ref, 3)
  getRef(ref)
}
`);
  assertStringIncludes(output, "Ref.make(0)");
  assertStringIncludes(output, "Ref.update(ref, (n: number) => $int(n + 1))");
  assertStringIncludes(output, "Ref.set(ref, 3)");
  assertStringIncludes(output, "Ref.get(ref)");
});

Deno.test("source Layers emit service acquisition and merge", () => {
  const output = oneModule(`
service First { one(): Int }
service Second { two(): Int }
const first = layer(First, () => ({ one: () => 1 }))
const second = layer(Second, () => ({ two: () => 2 }))
const both: Layer<First | Second> = mergeLayers(first, second)
export const main = (): Int => provide(both, () => First.one() + Second.two())
type Int = int
`);
  assertStringIncludes(output, "Layer.effect(");
  assertStringIncludes(output, "Layer.merge(first, second)");
  assertStringIncludes(output, "Effect.provide(");
});

Deno.test("defer stores an Effect and run executes it in an effect function", () => {
  const output = oneModule(`
error Stop = {}
service Counter { next(): Int fails Stop }
export const make = (): Effect<Int, Stop, Counter.next> =>
  defer(() => Counter.next())
export const twice = (stored: Effect<Int, Stop, Counter.next>): Int fails Stop uses Counter.next => {
  const first = run(stored)
  const second = run(stored)
  first + second
}
type Int = int
`);
  assertStringIncludes(output, "Effect.suspend(");
  assertStringIncludes(output, "yield* stored");
  assertStringIncludes(output, "Effect.Effect<Int, Stop, Counter>");
});

Deno.test("retry schedules emit the Effect 4 schedule step", () => {
  const output = oneModule(`
export error Stop = {}
export service Jobs { next(): Int fails Stop }
export const policy: RetrySchedule<Stop> = retrySchedule((error: Stop, attempt: Int): Option<Int> =>
  if (attempt < 2) { Some(0) } else { None })
export const run = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })
type Int = int
`);
  assertStringIncludes(output, "Schedule.fromStepWithMetadata<");
  assertStringIncludes(output, "Cause.done(");
  assertStringIncludes(output, "Duration.millis(");
  assertStringIncludes(output, "Effect.retry(");
});

Deno.test("source codecs emit schema-guarded pure transformations", () => {
  const output = oneModule(`
type Int = int
export const shift: Codec<Int, Int> = codec((n: Int): Int => n + 1, (n: Int): Int => n - 1)
export const parse = (input: unknown): Option<Int> => decode(shift, input)
export const print = (n: Int): Option<Int> => encode(shift, n)
`);
  assertStringIncludes(output, "Schema.decodeUnknownOption(");
  assertStringIncludes(output, ".decode(");
  assertStringIncludes(output, ".encode(");
});

Deno.test("withFiber emits a supervised child and join", () => {
  const output = oneModule(`
error Stop = {}
service Jobs { next(): Int fails Stop }
export const run = (): Int fails Stop uses Jobs.next =>
  withFiber(defer(() => Jobs.next()), (fiber) => joinFiber(fiber))
type Int = int
`);
  assertStringIncludes(output, "Effect.acquireUseRelease(");
  assertStringIncludes(output, "Effect.forkChild(");
  assertStringIncludes(output, "Fiber.join(");
  assertStringIncludes(output, "Fiber.interrupt");
});

// ------------------------------------------------------------------ golden

Deno.test("each example emits exactly its golden file", () => {
  const emitted = emitExamples();
  assertEquals([...emitted.keys()].sort(), [
    "collections",
    "log",
    "main",
    "pay",
    "users",
  ]);
  for (const [name, module] of emitted) {
    const golden = Deno.readTextFileSync(
      new URL(`golden/${name}.ts`, FIXTURES),
    );
    assertEquals(module.text, golden, `golden file ${name}.ts differs`);
    assertEquals(module.path, `${name}.ts`);
  }
});

Deno.test("traverse emits exactly its golden file", () => {
  const emitted = emitFiles(
    projectFiles("emit/traverse"),
    ["traverse.eff"],
  ).get("traverse");
  assert(emitted !== undefined);
  assertEquals(
    emitted.text,
    Deno.readTextFileSync(new URL("golden/traverse.ts", FIXTURES)),
  );
});

Deno.test("emitting twice gives identical text", () => {
  const first = emitExamples();
  const second = emitExamples();
  for (const [name, module] of first) {
    assertEquals(second.get(name)?.text, module.text);
  }
  const forms = projectFiles("emit/forms");
  assertEquals(
    emitFiles(forms, ["forms.eff"]).get("forms")?.text,
    emitFiles(forms, ["forms.eff"]).get("forms")?.text,
  );
});

Deno.test("a nominal record emits field reads and updates that keep the data type", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), [
    "nominal-records.eff",
  ]).get("nominal-records");
  assert(emitted !== undefined, "module nominal-records was not emitted");
  const text = emitted.text;
  assertStringIncludes(text, '"nominal-records#User"');
  assertStringIncludes(text, "Schema.TaggedStruct(");
  assertStringIncludes(text, "export type User = typeof User.Type;");
  assertStringIncludes(text, "(user: User): Text => user.name;");
  // An optional field read through the data type becomes an Option.
  assertStringIncludes(text, "Option.fromUndefinedOr(user.nickname)");
  // The update is a plain spread; it keeps the data type in the TypeScript type.
  assertStringIncludes(text, "({ ...user, active: true })");
  assertStringIncludes(text, "User.make({ id: UserId.make(");
});

Deno.test("a data type emits a TaggedStruct, a make call, and an unbrand copy without the tag", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), ["data-types.eff"]).get(
    "data-types",
  );
  assert(emitted !== undefined, "module data-types was not emitted");
  const text = emitted.text;
  assertStringIncludes(
    text,
    'export const User = Schema.TaggedStruct(\n  "data-types#User"',
  );
  assertStringIncludes(text, "nick: Schema.optionalKey(Text)");
  assertStringIncludes(text, "export type User = typeof User.Type;");
  // An empty body gives a variant with no fields.
  assertStringIncludes(text, 'Schema.TaggedStruct("data-types#Marker", {})');
  assertStringIncludes(text, "User.make({ id: UserId.make(");
  assertStringIncludes(text, "Marker.make({})");
  assertStringIncludes(text, "(user: User): Text => user.name;");
  assertStringIncludes(text, "Option.fromUndefinedOr(user.nick)");
  assertStringIncludes(text, "({ ...user, name })");
  // A data value in an error needs no adapter.
  assertStringIncludes(text, "{ user: User, reason: Text }");
  // A piped record literal reaches the constructor.
  assertStringIncludes(text, "return Pin.make($p1);");
  // The copy that unbrand makes leaves the tag out.
  assertEquals(text.split("$untagged<").length - 1, 2);
  assertStringIncludes(text, 'key !== "_tag"');
});

Deno.test("a match over data and error types tests the tag of each arm but the last", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), ["data-types.eff"]).get(
    "data-types",
  );
  assert(emitted !== undefined, "module data-types was not emitted");
  const text = emitted.text;
  // The arms of `describe` over `Circle | Square`: a test for the first, none for the last.
  assertStringIncludes(text, '$t0._tag === "data-types#Circle"');
  assertEquals(text.split('$t0._tag === "data-types#Square"').length - 1, 0);
  // A `_` arm is the else branch.
  assertStringIncludes(text, ': "other")(shape)');
  // An error and a data type share one chain, and an empty variant has a tag test.
  assertStringIncludes(text, "((r) => r.reason)($t0)");
  assertStringIncludes(text, '$t0._tag === "data-types#Marker"');
});

Deno.test("a literal result in a generated function is as const", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), ["literal-results.eff"])
    .get("literal-results");
  assert(emitted !== undefined, "module literal-results was not emitted");
  const text = emitted.text;
  assertStringIncludes(text, '((x) => "a" as const)($t0)');
  assertStringIncludes(text, "((x) => 1 as const)($t0)");
  assertStringIncludes(text, "((x) => true as const)($t0)");
  assertStringIncludes(text, 'Effect.succeed("a" as const)');
  assertStringIncludes(text, 'return "a" as const;');
  // A literal compared with a value has no literal slot.
  assertStringIncludes(text, 'k === "a"');
});

Deno.test("a data type with field names from Object.prototype keeps them valid", () => {
  const output = oneModule(`
type Text = string
export data Odd = { constructor: Text, __proto__: Text, toString?: Text }
export const make = (): Odd => Odd({ constructor: "c", __proto__: "p" })
export const ts = (o: Odd): Option<Text> => o.toString
`);
  assertStringIncludes(output, '["__proto__"]: Text');
  assertStringIncludes(output, "Odd.make(");
  assertStringIncludes(output, '$optionalField<Text>(o, "toString")');
});

Deno.test("an optional field read through a union, a data type, or an error becomes an Option", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), [
    "optional-fields.eff",
  ]).get("optional-fields");
  assert(emitted !== undefined, "module optional-fields was not emitted");
  const text = emitted.text;
  // nickOfUnion, nickOfNested, and nickOfBrand (a data type) each read x.nickname once.
  assertEquals(
    text.split("Option.fromUndefinedOr(x.nickname)").length - 1,
    3,
  );
  assertStringIncludes(text, "Option.fromUndefinedOr(e.detail)");
  // A field that is required in every member stays a plain read.
  assertStringIncludes(text, "(x: A | B): Text => x.kind;");
});

// ------------------------------------------------------------------ names

Deno.test("a module that declares generated names still emits valid names", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), ["names.eff"]).get(
    "names",
  );
  assert(emitted !== undefined, "module names was not emitted");
  const text = emitted.text;
  // The helper takes the next free name and leaves the source names alone.
  assertStringIncludes(
    text,
    "const f = ($t0: Int, $int: Int): Int =>",
  );
  assertStringIncludes(text, "$int$1($t0 + $int)");
  assertStringIncludes(text, "const $int$1 = (value: number): number =>");
  // The `Option` import gets an alias, and the parameter keeps its name.
  assertStringIncludes(text, "Option as Option$1");
  assertStringIncludes(text, "(Option: Option$1.Option<Int>)");
  assertStringIncludes(text, "Option$1.match(Option, {");
  // The selector temporary skips the taken name.
  assertStringIncludes(text, '(($t1) => $t1 === "a" ? 1 : 2)($t0)');
  // A declaration named `Schema` or `Effect` moves the matching import.
  assertStringIncludes(text, "Schema as Schema$1");
  assertStringIncludes(text, "const Schema = Schema$1.Struct(");
  assertStringIncludes(text, "Effect as Effect$1");
  assertStringIncludes(text, "Effect$1.Effect<Int, never, Env>");
  // The service parameter skips the taken name `$s`.
  assertStringIncludes(text, "Env.use(($s$1) => $s$1.get($s))");
});

// ------------------------------------------------------------------ order

Deno.test("a type used before its definition is emitted after it", () => {
  const text = oneModule(`
export type Outer = { inner: Inner }
error Boom = { reason: Reason }
type Reason = "a" | "b"
type Inner = { n: int }
export const make = (n: Int): Outer => ({ inner: { n } })
type Int = int
`);
  assert(
    indexOfOrFail(text, "const Inner =") < indexOfOrFail(text, "const Outer ="),
  );
  assert(
    indexOfOrFail(text, "const Reason =") < indexOfOrFail(text, "class Boom"),
  );
});

Deno.test("a constant that calls a later function is emitted after the function and its inputs", () => {
  const text = oneModule(`
export const answer: Int = twice(base)
const twice = (x: Int): Int => x * 2
const base: Int = 21
type Int = int
`);
  const twice = indexOfOrFail(text, "const twice =");
  const base = indexOfOrFail(text, "const base:");
  const answer = indexOfOrFail(text, "const answer:");
  assert(twice < base, "functions come before constants");
  assert(base < answer, "a constant comes after its eager dependency");
});

Deno.test("a module with an initialization cycle has no IR to emit", () => {
  const checked = checkProject(
    memoryHost({
      "effective.json": "{}",
      "m.eff": "const a: Int = b\nconst b: Int = a\ntype Int = int\n",
    }),
    "",
    ["m.eff"],
  );
  assert(checked.ok);
  // The checker reports the cycle, so the module has no IR.
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered !== undefined && !lowered.ok);
});

// ------------------------------------------------------------------ annotations

Deno.test("every const in a body carries a type annotation", () => {
  const sources = [
    ...[...emitExamples().values()].map((m) => m.text),
    emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get("forms")?.text ??
      "",
  ];
  let seen = 0;
  for (const text of sources) {
    for (const line of text.split("\n")) {
      if (!/^\s+const /.test(line)) continue;
      seen += 1;
      assert(/^\s+const [^\s:=]+: \S/.test(line), `no annotation: ${line}`);
    }
  }
  assert(seen >= 10, `only ${seen} body consts were checked`);
});

Deno.test("a module constant and a host assertion carry a type annotation", () => {
  const text = oneModule(
    "export const answer: Int = 21\ntype Int = int\n",
  );
  assertStringIncludes(text, "export const answer: Int = 21;");
  const main = emitExamples().get("main")?.text ?? "";
  assertStringIncludes(
    main,
    "const UsersLive$host: Layer.Layer<Users> = UsersLive;",
  );
});

// ------------------------------------------------------------------ imports

Deno.test("specifiers are relative to the generated file", () => {
  assertEquals(relativeSpecifier("main.ts", "users.ts"), "./users.ts");
  assertEquals(relativeSpecifier("a/b.ts", "c.ts"), "../c.ts");
  assertEquals(relativeSpecifier("a/b.ts", "a/c.ts"), "./c.ts");
  assertEquals(relativeSpecifier("a/b/c.ts", "x/y.ts"), "../../x/y.ts");
  assertEquals(relativeSpecifier("a.ts", "impl/live.ts"), "./impl/live.ts");
});

Deno.test("imports and host modules are rewritten relative to a nested module", () => {
  const emitted = emitFiles({
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./impl/live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): Int }\ntype Int = int\n",
    "sub/m.eff": [
      'import { S } from "../s.eff"',
      'import { L } from "host:p"',
      "export const g = (): Int => provide(L, () => S.f())",
      "type Int = int",
      "",
    ].join("\n"),
  }, ["s.eff", "sub/m.eff"]);
  const text = emitted.get("sub/m")?.text ?? "";
  assertEquals(emitted.get("sub/m")?.path, "sub/m.ts");
  assertStringIncludes(text, 'from "../s.ts";');
  assertStringIncludes(text, 'import { L } from "../impl/live.ts";');
  assertStringIncludes(text, "const L$host: Layer.Layer<S> = L;");
  assertStringIncludes(
    text,
    "Effect.provide(Effect.suspend(() => S.use(($s) => $s.f())), L$host)",
  );
});

// ------------------------------------------------------------------ forms

Deno.test("the forms fixture emits the plan's control forms", () => {
  const text = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get("forms")
    ?.text ?? "";
  // One Effect.catchTags call with all handlers, never a chain of catchTag.
  assertStringIncludes(text, "Effect.catchTags({");
  assert(!text.includes("catchTag("));
  // Parentheses by parent position.
  assertStringIncludes(
    text,
    "return $int((yield* Store.use(($s) => $s.count())) + n);",
  );
  assertStringIncludes(
    text,
    "const n: IntVal = yield* Store.use(($s) => $s.count());",
  );
  assertStringIncludes(text, "(yield* lookup(id)).name");
  // A leaf with an effectful child hoists it inside a nested Effect.gen.
  assertStringIncludes(text, "const $t0: number = yield* f(x);");
  assertStringIncludes(text, "return yield* f($t0);");
  // A pure child that comes before an effectful child keeps its place.
  assertStringIncludes(text, "const $t0: IntVal = add(x, 1);");
  assertStringIncludes(
    text,
    "const $t1: IntVal = yield* Store.use(($s) => $s.count());",
  );
  assertStringIncludes(text, "return yield* pair($t0, $t1);");
  // A pure function fits an effect function slot through a wrapper.
  assertStringIncludes(text, "Effect.succeed(addOne($t0))");
  // The optional field read.
  assertStringIncludes(text, "Option.fromUndefinedOr(p.nickname)");
  // Brand construction.
  assertStringIncludes(text, "Id.make(s)");
});

Deno.test("the brand operators fixture wraps a sum or a difference in the brand", () => {
  const text =
    emitFiles(projectFiles("emit/forms"), ["brand-operators.eff"]).get(
      "brand-operators",
    )?.text ?? "";
  // A brand of int keeps the $int check inside the brand constructor.
  assertStringIncludes(text, "Count.make($int(a + b))");
  assertStringIncludes(text, "Count.make($int(a - b))");
  assertStringIncludes(text, "Count.make($int(Count.make($int(a + b)) - c))");
  assertStringIncludes(
    text,
    "Count.make($int((yield* Counter.use(($s) => $s.read())) + a))",
  );
  // A brand of number has no $int.
  assertStringIncludes(text, "Price.make(a + b)");
  assertStringIncludes(text, "Price.make(a - b)");
  // A comparison needs no brand wrapper.
  assertStringIncludes(text, "a < b;");
  assertStringIncludes(text, "a >= b;");
});

// ------------------------------------------------------------------ formatting

Deno.test("an arrow chain that is too long moves below the equals sign", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "export const adder =\n  (n: IntVal): (a: IntVal) => Effect.Effect<IntVal> => (x: IntVal) =>\n    Effect.succeed($int(x + n));",
  );
  // A short chain stays on one line.
  const short = oneModule(
    "type F = (x: int) => int\nexport const f = (n: Int): F => (x) => x\ntype Int = int\n",
  );
  assertStringIncludes(
    short,
    "export const f = (n: Int): F => (x: number) => Effect.succeed(x);",
  );
});

Deno.test("a match with three arms prints one flat chain of conditionals", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "        : $t0 === 2\n        ? Effect.succeed(2000000000)\n        : $t0 === 3\n        ? Effect.succeed(3000000000)\n        : Effect.succeed(4000000000))(",
  );
});

Deno.test("a long binary expression breaks after an operator, and a short one stays on one line", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  // An arrow body: the lines after the first keep the indentation of the first.
  assertStringIncludes(
    forms.text,
    "): BoolVal =>\n  alphaValueNumberOne > betaValueNumberTwo &&\n  betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n  alphaValueNumberOne < 1000;",
  );
  // A conditional test: the lines after the first sit one level deeper than `?`.
  assertStringIncludes(
    forms.text,
    '): StrVal =>\n  alphaValueNumberOne > betaValueNumberTwo &&\n    betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n    alphaValueNumberOne < 1000\n    ? "a"\n    : "b";',
  );
  // After `return`, the lines after the first sit one level deeper.
  assertStringIncludes(
    forms.text,
    "  return first && alphaValueNumberOne > betaValueNumberTwo &&\n    betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n    alphaValueNumberOne < 1000;",
  );
  // A sum of int values: each `$int` call breaks its argument list.
  assertStringIncludes(
    forms.text,
    "          $int(alphaValueNumberOne + betaValueNumberTwo) +\n            gammaValueNumberThree,\n        ) + alphaValueNumberOne,",
  );
  // A short expression is unchanged.
  assertStringIncludes(forms.text, "export const arith = ");
  assertStringIncludes(
    forms.text,
    "$int($int($int(a * b) + a) - b)",
  );
});

Deno.test("an arrow chain whose first parameter list breaks puts each next head on a line of its own", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "  gammaValueNumberThree: IntVal,\n): WideG =>\n(gammaValueNumberThree: number, delta: number) =>\n  Effect.succeed(alphaValueNumberOne);",
  );
  // A later head that breaks does the same, and the body stays on its line.
  assertStringIncludes(
    forms.text,
    "export const wideChainLate = (z: IntVal): WideH =>\n(\n  alphaValueNumberOne: number,",
  );
  // In a call argument the arguments break, and the heads align with the first.
  assertStringIncludes(
    forms.text,
    "    ) =>\n    (q: IntVal) =>\n      $int(",
  );
  // A chain that fits below the equals sign keeps its heads on one line.
  assertStringIncludes(
    forms.text,
    "export const adder =\n  (n: IntVal): (a: IntVal) => Effect.Effect<IntVal> => (x: IntVal) =>\n    Effect.succeed($int(x + n));",
  );
});

Deno.test("an else-if chain prints every ? and : at one indentation level", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    '    : betaValueNumberTwo > gammaValueNumberThree\n    ? "bbbbbbbbbbbbbbbbbbbbbbb"\n    : gammaValueNumberThree > 100000 && alphaValueNumberOne < 10000000 &&\n        betaValueNumberTwo > 100\n    ? "c"\n    : "d";',
  );
});

// ------------------------------------------------------------------ spans and results

Deno.test("span records lie inside the text and cover each declaration", () => {
  const module = emitExamples().get("pay");
  assert(module !== undefined);
  assert(module.spans.length > 20);
  for (const record of module.spans) {
    assert(record.start >= 0 && record.start <= record.end);
    assert(record.end <= module.text.length);
  }
  const functionSpans = module.spans.filter((r) =>
    module.text.slice(r.start, r.end).startsWith("export const pay =")
  );
  assertEquals(functionSpans.length, 1);
});

Deno.test("a flattened run of binary operations keeps one span record for each operation", () => {
  const declaration =
    'export const f = (a: StrVal, b: StrVal, c: StrVal): StrVal => a + "-" + b + "-" + c\n';
  const source = declaration + "type StrVal = string\n";
  const files = { "effective.json": "{}", "m.eff": source };
  const module = emitFiles(files, ["m.eff"]).get("m");
  assert(module !== undefined);
  const pairs = module.spans
    .filter((r) => module.text.slice(r.start, r.end).includes(" + "))
    .map((r) => [
      module.text.slice(r.start, r.end),
      source.slice(r.span.start, r.span.end),
    ]);
  assertEquals(pairs, [
    ['a + "-"', 'a + "-"'],
    ['a + "-" + b', 'a + "-" + b'],
    ['a + "-" + b + "-"', 'a + "-" + b + "-"'],
    ['a + "-" + b + "-" + c', 'a + "-" + b + "-" + c'],
    [
      'export const f = (a: StrVal, b: StrVal, c: StrVal): StrVal =>\n  a + "-" + b + "-" + c;',
      declaration.trimEnd(),
    ],
  ]);
});

Deno.test("emitProject reports a module that did not lower", () => {
  const checked = checkProject(
    memoryHost({
      "effective.json": "{}",
      "m.eff": 'export const x: Int = "no"\ntype Int = int\n',
    }),
    "",
    ["m.eff"],
  );
  assert(checked.ok);
  const emitted = emitProject(lowerProject(checked.value), {
    config: checked.value.analysis.project.config,
  });
  const result = emitted.get("m");
  assert(result !== undefined && !result.ok);
  assertEquals(result.error.tag, "lowering");
});

Deno.test("emitModule returns an error value for a host module that the project file lacks", () => {
  const files = {
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): Int }\ntype Int = int\n",
    "m.eff":
      'import { L } from "host:p"\nexport const g = (): Int => provide(L, () => 1)\ntype Int = int\n',
  };
  const checked = checkProject(memoryHost(files), "", ["s.eff", "m.eff"]);
  assert(checked.ok);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered !== undefined && lowered.ok);
  const result = emitModule(lowered.value, {
    config: { host: new Map() },
  });
  assert(!result.ok);
  assertEquals(result.error.tag, "unsupported");
});

Deno.test("the example list stays in step with the helper", () => {
  assertEquals(EXAMPLE_ENTRIES.length, 5);
});

Deno.test("the emitted module lists the range of each host assertion", () => {
  const main = emitExamples().get("main");
  assert(main !== undefined);
  assertEquals(main.hostAssertions.length, 1);
  const found = main.hostAssertions[0];
  assertEquals(
    main.text.slice(found.start, found.end),
    "const UsersLive$host: Layer.Layer<Users> = UsersLive;",
  );
  assertEquals(
    [found.name, found.local, found.exported, found.key],
    ["UsersLive$host", "UsersLive", "UsersLive", "providers"],
  );
  assertEquals(emitExamples().get("users")?.hostAssertions, []);
});

Deno.test("a record type that breaks over lines ends its last field with a semicolon", () => {
  const output = oneModule(`
type Text = string
export const make = (a: Text): { firstVeryLongFieldName: Text, secondVeryLongFieldName: Text, thirdVeryLongFieldName: Text } => ({ firstVeryLongFieldName: a, secondVeryLongFieldName: a, thirdVeryLongFieldName: a })
`);
  assertStringIncludes(
    output,
    "  readonly secondVeryLongFieldName: Text;\n  readonly thirdVeryLongFieldName: Text;\n}",
  );
});

Deno.test("an array literal body that breaks over lines stays on the line of the arrow", () => {
  const output = oneModule(`
type Text = string
export const pair = (a: Text): [Text, Text] => ["aVeryLongStringLiteralNumberOneForTheTest", "aVeryLongStringLiteralNumberTwoForTheTest"]
`);
  assertStringIncludes(
    output,
    'export const pair = (a: Text): readonly [Text, Text] => [\n  "aVeryLongStringLiteralNumberOneForTheTest",\n  "aVeryLongStringLiteralNumberTwoForTheTest",\n];',
  );
});

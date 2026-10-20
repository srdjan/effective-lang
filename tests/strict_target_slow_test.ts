// Strict-target cases for compiled Effective sources. Each case checks, lowers,
// and validates its project, writes the emitted modules into its own temporary
// directory, and runs `deno check` and `deno run` on its script there. The
// project must have no diagnostics, and both commands must exit with code 0.

import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

function emitFixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`../fixtures/emit/${name}.eff`, import.meta.url),
  );
}

interface Case {
  readonly name: string;
  /** The source files of the project by root-relative path. */
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly string[];
  /** The text of `run.ts`. */
  readonly run: string;
  /** The prefix of the temporary directory. */
  readonly prefix: string;
  /** Checks the standard output of the run. */
  readonly verify?: (output: string) => void;
}

const CASES: readonly Case[] = [
  {
    name:
      "a recursive alias with literal alias tags validates, passes strict tsc, and round-trips",
    files: {
      "main.eff": `export type A = "a"
export type T = { tag: A, next: T } | { tag: B }
export type B = "b"
const lit_a: Schema<A> = schema()
const lit_b: Schema<B> = schema()
export const t: Schema<T> = schemaRecursive((self: Schema<T>): Schema<T> =>
  schemaUnion([schemaStruct({ tag: lit_a, next: self }), schemaStruct({ tag: lit_b })]))
export const parse = (x: T): T fails SchemaError => schemaDecode(t, x)
export const make = (x: T): T fails SchemaIssue => schemaMake(t, x)
`,
    },
    entries: ["main.eff"],
    run: `import { Effect, Exit } from "effect";
import { make, parse, type T } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const value: T = { tag: "a", next: { tag: "a", next: { tag: "b" } } };
expect(await Effect.runPromise(parse(value)), value);
expect(await Effect.runPromise(make(value)), value);
expect(await Effect.runPromise(parse({ tag: "b" } as T)), { tag: "b" });
const bad: unknown = { tag: "a", next: { tag: "c" } };
if (!Exit.isFailure(await Effect.runPromiseExit(parse(bad as T)))) throw new Error("a wrong nested tag decoded");
const missing: unknown = { tag: "a" };
if (!Exit.isFailure(await Effect.runPromiseExit(parse(missing as T)))) throw new Error("a missing next field decoded");
`,
    prefix: "effective-tag-alias-",
  },
  {
    name:
      "runStream with an inline takeSink compiles and takes the first two elements",
    files: {
      "main.eff": `type Int = int
export const firstTwo = (s: Stream<Int>): Int[] => runStream(s, takeSink(2))
`,
    },
    entries: ["main.eff"],
    run: `import { Effect, Stream } from "effect";
import { firstTwo } from "./main.ts";
const taken = await Effect.runPromise(firstTwo(Stream.fromIterable([1, 2, 3, 4, 5])));
console.log(JSON.stringify(taken));
`,
    prefix: "effective-run-stream-sink-",
    verify: (output) =>
      assertEquals(JSON.parse(output.trim().split("\n").pop() ?? ""), [1, 2]),
  },
  {
    name:
      "a Schedule annotated wider than its decision output validates and passes strict tsc",
    files: {
      "main.eff": `type Int = int
type Millis = number
export const wide: Schedule<Millis> = scheduleFromStep(
  (): Int => 0,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Int> => ({ kind: "Done", output: state })
)
`,
    },
    entries: ["main.eff"],
    run: `import { Schedule } from "effect";
import { wide } from "./main.ts";
const widest: Schedule.Schedule<number, unknown> = wide;
void widest;
`,
    prefix: "effective-schedule-output-",
  },
  {
    name:
      "type-side constructors validate without wire services and compose explicit defaults",
    files: { "main.eff": emitFixture("schema-constructor") },
    entries: ["main.eff"],
    run:
      `import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import { Other, Read, Write, Values, record, nested, makeRecord, makeNested, makeDirect, makeObserved, readWire, writeWire, classify, catchMixed } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const operation: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue> = makeRecord({});
expect(classify(new SchemaIssue.InvalidValue({ message: "x" })), 1);
expect(classify(new Other({})), 2);
expect(await Effect.runPromise(catchMixed(false)), 2);
const rethrown = await Effect.runPromiseExit(catchMixed(true));
if (!Exit.isFailure(rethrown) || !(Option.getOrUndefined(Cause.findErrorOption(rethrown.cause)) instanceof Other)) throw new Error("another handler recaught a handler's failure");
expect(await Effect.runPromise(operation), { score: 4 });
expect(await Effect.runPromise(operation), { score: 4 });
expect(await Effect.runPromise(makeRecord({ score: 8 })), { score: 8 });
expect(await Effect.runPromise(makeDirect({ score: 8 })), { score: 8 });
expect(await Effect.runPromise(makeNested({})), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: { score: 8 } })), { settings: { score: 8 } });
// @ts-expect-error Exact factory input rejects explicit undefined statically.
const explicitUndefined = makeRecord({ score: undefined });
expect(await Effect.runPromise(explicitUndefined), { score: 4 });
const NativeInt = Schema.Finite.check(Schema.makeFilter((value) => Number.isSafeInteger(value) || "expected a safe integer"));
const native = Schema.Struct({ score: NativeInt.pipe(Schema.withConstructorDefault(Effect.succeed(4))) });
const nativeNested = Schema.Struct({ settings: native.pipe(Schema.withConstructorDefault(native.makeEffect({}))) });
for (const input of [{ score: 0.5 }, { score: null }]) {
  // Run the unknown host boundary without weakening the published input type.
  const makeUnknown = makeRecord as (input: unknown) => Effect.Effect<unknown, SchemaIssue.Issue>;
  const nativeUnknown = native.makeEffect as (input: unknown) => Effect.Effect<unknown, SchemaIssue.Issue>;
  const failures = [];
  for (const effect of [makeUnknown(input), nativeUnknown(input)]) {
    const exit = await Effect.runPromiseExit(effect);
    if (!Exit.isFailure(exit)) throw new Error("invalid constructor input accepted");
    const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (!SchemaIssue.isIssue(issue) || issue instanceof Schema.SchemaError) throw new Error("construction did not preserve SchemaIssue");
    failures.push(SchemaIssue.makeFormatterDefault()(issue));
  }
  expect(failures[0], failures[1]);
}
const nestedFailures = [];
for (const effect of [makeNested({ settings: { score: 0.5 } }), nativeNested.makeEffect({ settings: { score: 0.5 } })]) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("invalid nested constructor input accepted");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("nested issue lost");
  nestedFailures.push(SchemaIssue.makeFormatterDefault()(issue));
}
expect(nestedFailures[0], nestedFailures[1]);
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const missingWire = await Effect.runPromiseExit(readWire({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missingWire)) throw new Error("constructor factory changed wire requirements");
expect(await Effect.runPromise(readWire({ score: "8" }).pipe(Effect.provide(read))), { score: 8 });
expect(await Effect.runPromise(writeWire({ score: 8 }).pipe(Effect.provide(write))), { score: "8" });
expect(calls, ["read:8", "write:8"]);
let count = 0;
const observed = Layer.succeed(Values)({ next: () => Effect.sync(() => ++count) });
const active: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue, Values> = makeObserved();
// @ts-expect-error Active argument services stay required even though RD and RE are unused.
const missingValues: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue> = active;
void missingValues;
expect(count, 0);
expect(await Effect.runPromise(active.pipe(Effect.provide(observed))), { score: 2 });
expect(count, 2);
const defective = Layer.succeed(Values)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(makeObserved().pipe(Effect.provide(defective)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("argument defect converted to a constructor issue");
const decoded: typeof record.Type = { score: 8 };
const wire: typeof record.Encoded = { score: "8" };
void decoded; void wire; void nested;
// @ts-expect-error The wire field remains required and encoded as text.
const invalidWire: typeof record.Encoded = {};
void invalidWire;

`,
    prefix: "effective-schema-constructor-",
  },
  {
    name:
      "constructor defaults on field descriptors compile across imports with independent wire behavior",
    files: {
      "main.eff": emitFixture("schema-constructor-fields"),
      "imported.eff":
        `import { optionalField, decodedField, D, E, M, Read, Write, Defaults } from "./main.eff"
const field: SchemaOptionalConstructorDefault<D,E,Read.parse,Write.print,M> = optionalField
export const optional: Schema<{ settings?: D },{ settings?: E },Read.parse,Write.print,{ settings?: M }> = schemaStruct({ settings: field })
export const decoded: Schema<{ settings: D },{ settings?: E },Read.parse | Defaults.next,Write.print,{ settings?: M }> = schemaStruct({ settings: decodedField })
`,
    },
    entries: ["main.eff", "imported.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, Defaults, optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, optionRecord, transformedRecord, requiredRecord, waiting, makeDecoded, readDecoded, writeEncoded } from "./main.ts";
import { optional, decoded } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const defaults = Layer.succeed(Defaults)({
  next: () => Effect.sync(() => { calls.push("wire-default"); return { score: 8 }; }),
  encoded: () => Effect.sync(() => { calls.push("encoded-default"); return { score: "9" }; }),
});
for (const schema of [optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, transformedRecord, requiredRecord, optional, decoded]) {
  const input: typeof schema["~type.make.in"] = {};
  const operation: Effect.Effect<unknown, SchemaIssue.Issue> = schema.makeEffect(input);
  expect(await Effect.runPromise(operation), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: {} })), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: { score: 7 } })), { settings: { score: 7 } });
  const invalid = await Effect.runPromiseExit(schema.makeEffect({ settings: { score: 0.5 } }));
  if (!Exit.isFailure(invalid)) throw new Error("invalid nested input accepted");
  const issue = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor issue channel lost");
  const message = SchemaIssue.makeFormatterDefault()(issue);
  if (!message.includes("settings") || !message.includes("score")) throw new Error("nested path lost");
}
expect(await Effect.runPromise(makeDecoded({})), { settings: { score: 4 } });
expect(calls, []);
expect(await Effect.runPromise(optionRecord.makeEffect({})), { settings: Option.some({ score: 6 }) });
expect(await Effect.runPromise(optionRecord.makeEffect({ settings: Option.none() })), { settings: Option.none() });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionRecord)({}).pipe(Effect.provide(read))), { settings: Option.none() });
expect(await Effect.runPromise(Schema.encodeEffect(optionRecord)({ settings: Option.none() }).pipe(Effect.provide(write))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionalRecord)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullRecord)({ settings: null }).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(transformedRecord)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(readDecoded({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullDefaultRecord)({ settings: null }).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(encodedRecord)({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 9 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(requiredRecord)({ settings: "10" }).pipe(Effect.provide(read))), { settings: { score: 10 } });
expect(await Effect.runPromise(writeEncoded({ settings: { score: 7 } }).pipe(Effect.provide(write))), {});
expect(calls, ["wire-default", "wire-default", "encoded-default", "read:9", "read:10", "write:7"]);
const optionalD: typeof optionalRecord.Type = {};
const optionalE: typeof optionalRecord.Encoded = {};
const optionalM: typeof decodedRecord["~type.make.in"] = {};
// @ts-expect-error The decoding-default descriptor keeps D required.
const incompleteD: typeof decodedRecord.Type = {};
// @ts-expect-error The required-encoded descriptor keeps its wire key required.
const incompleteE: typeof requiredRecord.Encoded = {};
// @ts-expect-error Option contents stay complete after adding a constructor default.
const incompleteOption: typeof optionRecord["~type.make.in"] = { settings: Option.some({}) };
void optionalD; void optionalE; void optionalM; void incompleteD; void incompleteE; void incompleteOption;
let count = 0;
const fresh = waiting(Effect.sync(() => { count++; return {}; }));
expect(count, 0);
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(count, 2);
const failed = await Effect.runPromiseExit(waiting(Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" }))).makeEffect({}));
if (!Exit.isFailure(failed)) throw new Error("default failure lost");
const issue = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
if (!SchemaIssue.isIssue(issue) || !SchemaIssue.makeFormatterDefault()(issue).includes("settings")) throw new Error("default path lost");
const died = await Effect.runPromiseExit(waiting(Effect.die("defect")).makeEffect({}));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause) || Option.isSome(Cause.findErrorOption(died.cause))) throw new Error("default defect translated");
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const fiber = yield* Effect.forkChild(waiting(pending).makeEffect({}));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("field default cleanup outlived interruption");
}));
`,
    prefix: "effective-constructor-fields-",
  },
  {
    name:
      "constructor metadata composes make inputs without changing wire contracts",
    files: {
      "main.eff": emitFixture("schema-constructor-metadata"),
      "imported.eff": `import { child, D, E, M, Read, Write } from "./main.eff"
type OuterD = { settings: D }
type OuterE = { settings: E }
type OuterM = { settings?: M }
export const outer: Schema<OuterD, OuterE, Read.parse, Write.print, OuterM> =
  schemaStruct({ settings: schemaConstructorDefault(child, (): M => ({})) })
`,
    },
    entries: ["main.eff", "imported.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, child, nested, array, optional, union, transformed, failingNested, makeChild, makeNested, makeArray, makeOptional, makeUnion, readWire, writeWire, freshSchema, waiting } from "./main.ts";
import { outer } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const make: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue> = makeChild({});
expect(await Effect.runPromise(make), { score: 4 });
expect(await Effect.runPromise(outer.makeEffect({})), { settings: { score: 4 } });
expect(await Effect.runPromise(makeChild({ score: 8 })), { score: 8 });
expect(await Effect.runPromise(makeNested({})), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: { score: 8 } })), { settings: { score: 8 } });
expect(await Effect.runPromise(makeArray([{}, { score: 8 }])), [{ score: 4 }, { score: 8 }]);
expect(await Effect.runPromise(makeOptional({})), {});
expect(await Effect.runPromise(makeOptional({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeUnion({})), { score: 4 });
expect(await Effect.runPromise(makeUnion("keep")), "keep");
expect(await Effect.runPromise(transformed.makeEffect({})), { score: 4 });
const callbacks = await Effect.runPromise(freshSchema());
const repeated = callbacks.makeEffect({});
const first = await Effect.runPromise(repeated);
expect(first, { score: 1 });
const second = await Effect.runPromise(repeated);
expect(second, { score: 2 });
if (first !== second) throw new Error("native replay identity changed");
expect(first, { score: 2 });
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
expect(await Effect.runPromise(readWire({ score: "8" }).pipe(Effect.provide(read))), { score: 8 });
expect(await Effect.runPromise(writeWire({ score: 8 }).pipe(Effect.provide(write))), { score: "8" });
const missing = await Effect.runPromiseExit(readWire({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing)) throw new Error("constructor default ran during wire decoding");
expect(calls, ["read:8", "write:8"]);
for (const effect of [failingNested.makeEffect({}), nested.makeEffect({ settings: { score: 0.5 } })]) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("constructor validation/failure lost");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor failure changed channel");
  const text = SchemaIssue.makeFormatterDefault()(issue);
  if (!text.includes("settings") || !text.includes("score")) throw new Error("nested path lost: " + text);
}
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Effect.gen(function*() {
    yield* Deferred.succeed(entered, undefined);
    return yield* Effect.never;
  }).pipe(Effect.ensuring(Effect.sync(() => { released = true; })));
  const schema = waiting(pending);
  const fiber = yield* Effect.forkChild(schema.makeEffect({}));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("constructor default cleanup outlived interruption");
}));
const input: typeof child["~type.make.in"] = {};
void input;
// @ts-expect-error M optionality does not relax decoded data.
const invalidD: typeof child.Type = {};
// @ts-expect-error M optionality does not relax wire data.
const invalidE: typeof child.Encoded = {};
// @ts-expect-error Make input remains decoded numeric data.
const wrongM: typeof child["~type.make.in"] = { score: "8" };
void invalidD; void invalidE; void wrongM; void array; void optional; void union;

`,
    prefix: "effective-schema-constructor-metadata-",
  },
  {
    name:
      "optional adapters construct nested defaults without running wire effects",
    files: {
      "main.eff": emitFixture("schema-constructor-optional"),
      "imported.eff":
        `import { nullField, decodedField, D, E, M, Read, Write, Defaults } from "./main.eff"
type NullableWire = { settings?: E | null }
export const optional: Schema<{ settings?: D }, NullableWire, Read.parse, Write.print, { settings?: M }> = schemaStruct({ settings: nullField })
export const defaulted: Schema<{ settings: D }, { settings?: E }, Read.parse | Defaults.next, Write.print, { settings: M }> = schemaStruct({ settings: decodedField })
`,
    },
    entries: ["main.eff", "imported.eff"],
    run:
      `import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, Defaults, Convert, decoded, encoded, nullDefault, nullMissing, transformed, required, optionRecord, makeDecoded, makeOptional, makeOption, readDefault, readNull, readEncoded, readMissing, readTransformed, writeEncoded } from "./main.ts";
import { optional, defaulted } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const defaults = Layer.succeed(Defaults)({
  next: () => Effect.sync(() => { calls.push("default"); return { score: 8 }; }),
  encoded: () => Effect.sync(() => { calls.push("encoded-default"); return { score: "9" }; }),
});
const convert = Layer.succeed(Convert)({
  decode: (value) => Effect.sync(() => { calls.push("convert"); return Option.map(value, () => ({ score: "10" })); }),
  encode: (value) => Effect.succeed(Option.map(value, () => ({ label: "10" }))),
  required: () => Effect.succeed({ label: "10" }),
});
for (const schema of [decoded, encoded, nullDefault, nullMissing, transformed, required, optional, defaulted]) {
  const input = { settings: {} };
  const effect: Effect.Effect<unknown, SchemaIssue.Issue> = schema.makeEffect(input);
  expect(await Effect.runPromise(effect), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: { score: 7 } })), { settings: { score: 7 } });
  expect(calls, []);
  const exit = await Effect.runPromiseExit(schema.makeEffect({ settings: { score: 0.5 } }));
  if (!Exit.isFailure(exit)) throw new Error("invalid nested integer accepted");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor lost issue channel");
  const message = SchemaIssue.makeFormatterDefault()(issue);
  if (!message.includes("settings") || !message.includes("score")) throw new Error("nested path lost: " + message);
}
for (const schema of [nullMissing, transformed, required, optional]) expect(await Effect.runPromise(schema.makeEffect({})), {});
for (const schema of [decoded, encoded, nullDefault, defaulted]) {
  // @ts-expect-error Decoding defaults leave the constructor field required.
  const missing: typeof schema["~type.make.in"] = {};
  if (!Exit.isFailure(await Effect.runPromiseExit(schema.makeEffect(missing)))) throw new Error("wire default supplied a constructor key");
}
expect(await Effect.runPromise(makeDecoded({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeOptional({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeOption({ settings: Option.none() })), { settings: Option.none() });
expect(await Effect.runPromise(optionRecord.makeEffect({ settings: Option.some({ score: 7 }) })), { settings: Option.some({ score: 7 }) });
// @ts-expect-error Option declaration validates D and does not construct nested M.
const partial: Parameters<typeof makeOption>[0] = { settings: Option.some({}) };
if (!Exit.isFailure(await Effect.runPromiseExit(optionRecord.makeEffect(partial)))) throw new Error("partial Option accepted");
// @ts-expect-error Null belongs to the wire input only.
const nullInput: typeof nullMissing["~type.make.in"] = { settings: null };
if (!Exit.isFailure(await Effect.runPromiseExit(nullMissing.makeEffect(nullInput)))) throw new Error("constructor treated null as missing");
expect(calls, []);
expect(await Effect.runPromise(readDefault({}).pipe(Effect.provide(defaults), Effect.provide(read))), { settings: { score: 8 } });
expect(await Effect.runPromise(readNull({ settings: null }).pipe(Effect.provide(defaults), Effect.provide(read))), { settings: { score: 8 } });
expect(await Effect.runPromise(readEncoded({}).pipe(Effect.provide(defaults), Effect.provide(read))), { settings: { score: 9 } });
expect(await Effect.runPromise(readMissing({ settings: null }).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(readTransformed({ settings: { label: "wire" } }).pipe(Effect.provide(convert), Effect.provide(read))), { settings: { score: 10 } });
expect(await Effect.runPromise(writeEncoded({ settings: { score: 7 } }).pipe(Effect.provide(write))), {});
expect(calls, ["default", "default", "encoded-default", "read:9", "convert", "read:10", "write:7"]);
// @ts-expect-error Decoded fields stay complete.
const invalidD: typeof decoded.Type = { settings: {} };
// @ts-expect-error Encoded child fields stay complete.
const invalidE: typeof decoded.Encoded = { settings: {} };
void invalidD; void invalidE;
`,
    prefix: "effective-constructor-optional-",
  },
  {
    name:
      "field adapters retain or reset constructor defaults across imports with native lifetimes",
    files: {
      "main.eff": emitFixture("schema-constructor-order"),
      "schema-constructor-fields.eff": emitFixture("schema-constructor-fields"),
    },
    entries: ["main.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, Defaults } from "./schema-constructor-fields.ts";
import { optionalAfter, optionAfter, sourceBridge, optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, targetRecord, sourceRecord, requiredRecord, optionRecord, optionRestoredRecord, waiting, makeDecoded, makeOption, readDecoded } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const defaults = Layer.succeed(Defaults)({
  next: () => Effect.sync(() => { calls.push("wire-default"); return { score: 8 }; }),
  encoded: () => Effect.sync(() => { calls.push("encoded-default"); return { score: "9" }; }),
});
for (const schema of [optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, targetRecord, requiredRecord]) {
  const operation: Effect.Effect<unknown, SchemaIssue.Issue> = schema.makeEffect({});
  expect(await Effect.runPromise(operation), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: {} })), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: { score: 7 } })), { settings: { score: 7 } });
}
expect(await Effect.runPromise(makeDecoded({})), { settings: { score: 4 } });
expect(await Effect.runPromise(sourceRecord.makeEffect({})), {});
expect(await Effect.runPromise(sourceRecord.makeEffect({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(optionRestoredRecord.makeEffect({})), { settings: Option.some({ score: 6 }) });
expect(calls, []);
const retained: typeof optionalAfter["~type.constructor.default"] = "with-default";
const targetReset: typeof sourceBridge["~type.constructor.default"] = "no-default";
const optionReset: typeof optionAfter["~type.constructor.default"] = "no-default";
// @ts-expect-error Option adaptation resets the root default and requires its key.
const absent: Parameters<typeof makeOption>[0] = {};
if (!Exit.isFailure(await Effect.runPromiseExit(optionRecord.makeEffect(absent)))) throw new Error("Option retained root default");
// @ts-expect-error Option requires complete D, not partial M.
const partial: Parameters<typeof makeOption>[0] = { settings: Option.some({}) };
if (!Exit.isFailure(await Effect.runPromiseExit(optionRecord.makeEffect(partial)))) throw new Error("Option accepted partial contents");
expect(await Effect.runPromise(makeOption({ settings: Option.none() })), { settings: Option.none() });
// @ts-expect-error Decoding defaults leave decoded fields required.
const incompleteD: typeof decodedRecord.Type = {};
// @ts-expect-error Required-to-optional bridging still requires an encoded key.
const incompleteE: typeof requiredRecord.Encoded = {};
void retained; void targetReset; void optionReset; void incompleteD; void incompleteE;
expect(await Effect.runPromise(readDecoded({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullDefaultRecord)({ settings: null }).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(encodedRecord)({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 9 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionalRecord)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullRecord)({ settings: null }).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionRecord)({}).pipe(Effect.provide(read))), { settings: Option.none() });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(targetRecord)({ settings: "10" }).pipe(Effect.provide(read))), { settings: { score: 10 } });
expect(await Effect.runPromise(Schema.encodeEffect(encodedRecord)({ settings: { score: 7 } }).pipe(Effect.provide(write))), {});
expect(await Effect.runPromise(Schema.encodeEffect(requiredRecord)({}).pipe(Effect.provide(write))), { settings: "" });
if (!Exit.isFailure(await Effect.runPromiseExit(Schema.decodeUnknownEffect(requiredRecord)({}).pipe(Effect.provide(read))))) throw new Error("source constructor default supplied wire key");
expect(calls, ["wire-default", "wire-default", "encoded-default", "read:9", "read:10", "write:7"]);
let count = 0;
const fresh = waiting(Effect.sync(() => { count++; return {}; }));
expect(count, 0);
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(count, 2);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(waiting(Effect.die("constructor must not run")))({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
const failed = await Effect.runPromiseExit(waiting(Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" }))).makeEffect({}));
if (!Exit.isFailure(failed)) throw new Error("default failure lost");
const issue = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
if (!SchemaIssue.isIssue(issue) || !SchemaIssue.makeFormatterDefault()(issue).includes("settings")) throw new Error("default failure path lost");
const died = await Effect.runPromiseExit(waiting(Effect.die("defect")).makeEffect({}));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause) || Option.isSome(Cause.findErrorOption(died.cause))) throw new Error("default defect translated");
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const fiber = yield* Effect.forkChild(waiting(pending).makeEffect({}));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("retained default cleanup outlived interruption");
}));
`,
    prefix: "effective-constructor-order-",
  },
  {
    name:
      "recursive constructors retain partial input, paths and cancellation across imports",
    files: {
      "main.eff": emitFixture("schema-constructor-recursive"),
      "imported.eff":
        `import { tree, Tree, TreeInput, Read, Write } from "./main.eff"
export const forest: Schema<Tree[], Tree[], Read.next, Write.previous, TreeInput[]> = schemaArray(tree)
export const root: Schema<{ root: Tree }, { root: Tree }, Read.next, Write.previous, { root?: TreeInput }> =
  schemaStruct({ root: schemaConstructorDefault(tree, (): TreeInput => ({})) })
`,
    },
    entries: ["main.eff", "imported.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, tree, node, choice, waiting, makeTree, makeNode, makeChoice, readTree, writeTree } from "./main.ts";
import { forest, root } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const input: typeof tree["~type.make.in"] = { children: [{}, { score: 8, children: [{}] }] };
const expected = { score: 4, children: [{ score: 4, children: [] }, { score: 8, children: [{ score: 4, children: [] }] }] };
const make: Effect.Effect<typeof tree.Type, SchemaIssue.Issue> = makeTree(input);
expect(await Effect.runPromise(make), expected);
expect(await Effect.runPromise(makeTree({})), { score: 4, children: [] });
expect(await Effect.runPromise(makeTree(input)), expected);
expect(await Effect.runPromise(forest.makeEffect([{}, { children: [{}] }])), [{ score: 4, children: [] }, { score: 4, children: [{ score: 4, children: [] }] }]);
expect(await Effect.runPromise(root.makeEffect({})), { root: { score: 4, children: [] } });
expect(await Effect.runPromise(makeNode({ next: { next: {} } })), { score: 4, next: { score: 4, next: { score: 4 } } });
expect(await Effect.runPromise(makeChoice({ kind: "more", next: { kind: "more" } })), { kind: "more", next: { kind: "more", next: { kind: "end" } } });
// @ts-expect-error Nested decoded records still require complete fields.
const invalidD: typeof tree.Type = { score: 4, children: [{}] };
// @ts-expect-error Wire data has the same complete shape as D.
const invalidE: typeof tree.Encoded = { score: 4, children: [{}] };
// @ts-expect-error Recursive M retains the integer field type.
const invalidM: typeof tree["~type.make.in"] = { children: [{ score: "4" }] };
// @ts-expect-error Tagged make input still requires a terminal discriminator.
const invalidTag: Parameters<typeof makeChoice>[0] = { kind: "more", next: {} };
void invalidD; void invalidE; void invalidM; void invalidTag; void node; void choice;
let defaults = 0;
const fresh = waiting(Effect.sync(() => ++defaults));
expect(defaults, 0);
expect(await Effect.runPromise(fresh.makeEffect({ children: [{}, { children: [{}] }] })), { score: 1, children: [{ score: 2, children: [] }, { score: 3, children: [{ score: 4, children: [] }] }] });
expect(await Effect.runPromise(fresh.makeEffect({})), { score: 5, children: [] });
const calls: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => { calls.push("read:" + value); return value + 1; }) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => { calls.push("write:" + value); return value - 1; }) });
const wire = { score: 1, children: [{ score: 2, children: [] }] };
const decoded = await Effect.runPromise(readTree(wire).pipe(Effect.provide(read)));
expect(decoded, { score: 2, children: [{ score: 3, children: [] }] });
expect(await Effect.runPromise(writeTree(decoded).pipe(Effect.provide(write))), wire);
expect(calls, ["read:1", "read:2", "write:2", "write:3"]);
const missing = await Effect.runPromiseExit(readTree({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing) || !(Option.getOrUndefined(Cause.findErrorOption(missing.cause)) instanceof Schema.SchemaError)) throw new Error("wire decoding applied constructor defaults");
for (const schema of [tree, waiting(Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" })))]) {
  const effect = schema === tree ? schema.makeEffect({ score: 1, children: [{ score: 0.5 }] }) : schema.makeEffect({ score: 1, children: [{}] });
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("nested constructor failure lost");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor changed failure channel");
  const message = SchemaIssue.makeFormatterDefault()(issue);
  if (!message.includes("children") || !message.includes("score") || !message.includes("0")) throw new Error("recursive path lost: " + message);
}
const defect = await Effect.runPromiseExit(waiting(Effect.die("blocked")).makeEffect({ children: [{}], score: 1 }));
if (!Exit.isFailure(defect) || !Cause.hasDies(defect.cause) || Option.isSome(Cause.findErrorOption(defect.cause))) throw new Error("constructor translated defect");
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const schema = waiting(pending);
  const fiber = yield* Effect.forkChild(schema.makeEffect({ score: 1, children: [{}] }));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("recursive default cleanup outlived interruption");
}));
`,
    prefix: "effective-constructor-recursive-",
  },
  {
    name:
      "Schema default encoding strategies compile and retain directional behavior",
    files: { "main.eff": emitFixture("schema-default-encoding") },
    entries: ["main.eff"],
    run:
      `import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import { Defaults, Read, Write, implicit, nullableOmitted, omitted, passed, pureOmitted, readOmitted, writeOmitted } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const events: string[] = [];
let defaults = 0;
const read = Layer.succeed(Read)({ normalize: (value) => Effect.sync(() => { events.push("read:" + value); return value.toUpperCase(); }) });
const write = Layer.succeed(Write)({ restore: (value) => Effect.sync(() => { events.push("write:" + value); return value.toLowerCase(); }) });
const fallback = Layer.succeed(Defaults)({ make: () => Effect.sync(() => { defaults++; return "DEFAULT" + defaults; }) });
const services = Layer.merge(read, fallback);
expect(events, []);
expect(defaults, 0);
for (const schema of [omitted, passed, implicit]) {
  const decode: Effect.Effect<{ readonly name: string }, Schema.SchemaError, Read | Defaults> = Schema.decodeUnknownEffect(schema)({});
  const first = await Effect.runPromise(decode.pipe(Effect.provide(services)));
  expect(first, { name: "DEFAULT" + defaults });
  expect(await Effect.runPromise(decode.pipe(Effect.provide(services))), { name: "DEFAULT" + defaults });
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(schema)({ name: "Ada" }).pipe(Effect.provide(services))), { name: "ADA" });
}
if (defaults !== 6) throw new Error("default did not run per decode");
expect(events, ["read:Ada", "read:Ada", "read:Ada"]);
for (const name of ["DEFAULT", "OTHER"]) {
  const encode: Effect.Effect<{ readonly name?: string }, Schema.SchemaError, Write> = writeOmitted({ name });
  // @ts-expect-error The encoder requirement remains static even with omit.
  const missingService: Effect.Effect<{ readonly name?: string }, Schema.SchemaError> = encode;
  void missingService;
  expect(await Effect.runPromise(encode.pipe(Effect.provide(write))), {});
  expect(await Effect.runPromise(Schema.encodeEffect(passed)({ name }).pipe(Effect.provide(write))), { name: name.toLowerCase() });
  expect(await Effect.runPromise(Schema.encodeEffect(implicit)({ name }).pipe(Effect.provide(write))), { name: name.toLowerCase() });
}
expect(events, ["read:Ada", "read:Ada", "read:Ada", "write:DEFAULT", "write:DEFAULT", "write:OTHER", "write:OTHER"]);
if (defaults !== 6) throw new Error("default ran during encoding");
const invalid = await Effect.runPromiseExit(readOmitted({ name: undefined }).pipe(Effect.provide(services)));
if (!Exit.isFailure(invalid) || defaults !== 6) throw new Error("undefined ran default");
for (const input of [{ name: 3 }, { name: undefined }]) {
  const exit = await Effect.runPromiseExit(Schema.encodeUnknownEffect(omitted)(input).pipe(Effect.provide(write)));
  if (!Exit.isFailure(exit)) throw new Error("omit skipped present decoded validation");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("name")) throw new Error("validation path lost");
}
const blockedWrite = Layer.succeed(Write)({ restore: () => Effect.fail(new SchemaIssue.InvalidValue({ message: "encoder blocked" })) });
expect(await Effect.runPromise(writeOmitted({ name: "Ada" }).pipe(Effect.provide(blockedWrite))), {});
const blocked = await Effect.runPromiseExit(Schema.encodeEffect(passed)({ name: "Ada" }).pipe(Effect.provide(blockedWrite)));
if (!Exit.isFailure(blocked)) throw new Error("passthrough encoder failure lost");
const blockedError = Option.getOrUndefined(Cause.findErrorOption(blocked.cause));
if (!(blockedError instanceof Schema.SchemaError) || !blockedError.message.includes("encoder blocked") || !blockedError.message.includes("name")) throw new Error("encoder issue path lost");
const defective = Layer.succeed(Write)({ restore: () => Effect.die("boom") });
expect(await Effect.runPromise(writeOmitted({ name: "Ada" }).pipe(Effect.provide(defective))), {});
const died = await Effect.runPromiseExit(Schema.encodeEffect(passed)({ name: "Ada" }).pipe(Effect.provide(defective)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("passthrough defect changed channel");
const blockedDefault = Layer.succeed(Defaults)({ make: () => Effect.succeed("blocked") });
const decodeFailure = await Effect.runPromiseExit(readOmitted({}).pipe(Effect.provide(Layer.merge(read, blockedDefault))));
if (!Exit.isFailure(decodeFailure)) throw new Error("authored default issue lost");
const defaultError = Option.getOrUndefined(Cause.findErrorOption(decodeFailure.cause));
if (!(defaultError instanceof Schema.SchemaError) || !defaultError.message.includes("default blocked")) throw new Error("default issue changed channel");
expect(await Effect.runPromise(Schema.decodeUnknownEffect(pureOmitted)({})), { name: "DEFAULT" });
expect(await Effect.runPromise(Schema.encodeEffect(pureOmitted)({ name: "OTHER" })), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullableOmitted)({})), { name: null });
expect(await Effect.runPromise(Schema.encodeEffect(nullableOmitted)({ name: null })), {});
expect(await Effect.runPromise(Schema.encodeEffect(nullableOmitted)({ name: "Ada" })), {});
const wire: typeof omitted.Encoded = {};
void wire;
// @ts-expect-error Defaulted decoded fields remain required.
const missingDecoded: typeof omitted.Type = {};
void missingDecoded;
`,
    prefix: "effective-schema-default-encoding-",
  },
  {
    name: "effectful optional Schema getters and defaults compile and run",
    files: { "main.eff": emitFixture("schema-effectful-optional") },
    entries: ["main.eff"],
    run: `import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Read, Write, Default, readOptional, writeOptional, readDefault, writeDefault, readExistingError } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => { events.push("read:" + value); return value + 1; }) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => { events.push("write:" + value); return value - 1; }) });
const count = { value: 0 };
const defaults = Layer.succeed(Default)({ make: () => Effect.sync(() => ++count.value) });
if (JSON.stringify(await Effect.runPromise(readOptional({}).pipe(Effect.provide(read)))) !== '{"score":1}') throw new Error("missing decode getter");
if (JSON.stringify(await Effect.runPromise(readOptional({ score: 2 }).pipe(Effect.provide(read)))) !== '{"score":3}') throw new Error("present decode getter");
if (JSON.stringify(await Effect.runPromise(writeOptional({}).pipe(Effect.provide(write)))) !== '{"score":0}') throw new Error("missing encode getter");
if (JSON.stringify(await Effect.runPromise(writeOptional({ score: 3 }).pipe(Effect.provide(write)))) !== '{"score":2}') throw new Error("present encode getter");
if (events.join(",") !== "read:0,read:2,write:1,write:3") throw new Error("directional getter calls: " + events);
if (JSON.stringify(await Effect.runPromise(readDefault({ score: 9 }).pipe(Effect.provide(defaults)))) !== '{"score":9}' || count.value !== 0) throw new Error("present default");
const absent = readDefault({}).pipe(Effect.provide(defaults));
if (JSON.stringify(await Effect.runPromise(absent)) !== '{"score":1}') throw new Error("first default");
if (JSON.stringify(await Effect.runPromise(absent)) !== '{"score":2}') throw new Error("second default");
if (JSON.stringify(await Effect.runPromise(writeDefault({ score: 9 }))) !== '{"score":9}' || Number(count.value) !== 2) throw new Error("encode default service");
if (JSON.stringify(await Effect.runPromise(readExistingError({}))) !== '{"score":4}') throw new Error("existing SchemaError callback");

const blockedRead = Layer.succeed(Read)({ next: () => Effect.succeed(-1) });
const blockedWrite = Layer.succeed(Write)({ previous: () => Effect.succeed(-1) });
const blockedDefault = Layer.succeed(Default)({ make: () => Effect.succeed(0) });
for (const [operation, text] of [
  [readOptional({ score: 1 }).pipe(Effect.provide(blockedRead)), "read blocked"],
  [writeOptional({ score: 1 }).pipe(Effect.provide(blockedWrite)), "write blocked"],
  [readDefault({}).pipe(Effect.provide(blockedDefault)), "no default"],
] as const) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit)) throw new Error("expected schema failure");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes(text) || !error.message.includes("score")) throw new Error("authored issue/path lost: " + String(error));
}
const defectiveRead = Layer.succeed(Read)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readOptional({}).pipe(Effect.provide(defectiveRead)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect became a typed failure");
`,
    prefix: "effective-schema-effectful-",
  },
  {
    name:
      "encoded defaults run decoding and retain encoder work before omission",
    files: { "main.eff": emitFixture("schema-encoded-default") },
    entries: ["main.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Defaults, Errors, Read, Write, defaulted, omitted, passed, errorDefault, decodedOmitted, pureDefault, nullableDefault, readDefault, writeOmitted } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const calls: string[] = [];
let count = 0;
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value) + 1; }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value - 1); }) });
const fallback = Layer.succeed(Defaults)({ make: () => Effect.sync(() => { calls.push("default"); return String(++count); }) });
const services = Layer.merge(read, fallback);
expect(calls, []);
for (const schema of [defaulted, omitted, passed]) {
  const operation: Effect.Effect<{ readonly score: number }, Schema.SchemaError, Read | Defaults> = Schema.decodeUnknownEffect(schema)({});
  // @ts-expect-error Both decoder and default requirements remain static.
  const noDefault: Effect.Effect<{ readonly score: number }, Schema.SchemaError, Read> = operation;
  void noDefault;
  expect(await Effect.runPromise(operation.pipe(Effect.provide(services))), { score: count + 1 });
  expect(await Effect.runPromise(operation.pipe(Effect.provide(services))), { score: count + 1 });
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(schema)({ score: "40" }).pipe(Effect.provide(services))), { score: 41 });
  const before = [...calls];
  for (const input of [{ score: undefined }, { score: null }, { score: false }]) {
    const exit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(schema)(input).pipe(Effect.provide(services)));
    if (!Exit.isFailure(exit)) throw new Error("invalid present key accepted");
  }
  expect(calls, before);
}
expect(count, 6);
expect(calls, ["default", "read:1", "default", "read:2", "read:40", "default", "read:3", "default", "read:4", "read:40", "default", "read:5", "default", "read:6", "read:40"]);
const encode: Effect.Effect<{ readonly score?: string }, Schema.SchemaError, Write> = writeOmitted({ score: 41 });
// @ts-expect-error Omit retains the encoder service because it actually runs.
const noWrite: Effect.Effect<{ readonly score?: string }, Schema.SchemaError> = encode;
void noWrite;
expect(await Effect.runPromise(encode.pipe(Effect.provide(write))), {});
expect(calls.at(-1), "write:41");
expect(await Effect.runPromise(Schema.encodeEffect(defaulted)({ score: 41 }).pipe(Effect.provide(write))), { score: "40" });
expect(count, 6);
const issue = new SchemaIssue.InvalidValue({ message: "blocked" });
const blockedRead = Layer.succeed(Read)({ parse: () => Effect.fail(issue) });
const blockedWrite = Layer.succeed(Write)({ print: () => Effect.fail(issue) });
const blockedDefault = Layer.succeed(Defaults)({ make: () => Effect.fail(issue) });
const blockedError = Layer.succeed(Errors)({ make: () => Effect.fail(new Schema.SchemaError(issue)) });
const failures: readonly Effect.Effect<unknown, Schema.SchemaError>[] = [
  readDefault({}).pipe(Effect.provide(Layer.merge(blockedRead, fallback))),
  readDefault({}).pipe(Effect.provide(Layer.merge(read, blockedDefault))),
  readDefault({ score: "1" }).pipe(Effect.provide(Layer.merge(blockedRead, fallback))),
  Schema.decodeUnknownEffect(errorDefault)({}).pipe(Effect.provide(Layer.merge(read, blockedError))),
  writeOmitted({ score: 41 }).pipe(Effect.provide(blockedWrite)),
];
for (const operation of failures) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit)) throw new Error("failure was swallowed");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("score") || !error.message.includes("blocked")) throw new Error("authored path lost");
}
expect(await Effect.runPromise(Schema.encodeEffect(decodedOmitted)({ score: 41 }).pipe(Effect.provide(blockedWrite))), {});
const defectiveWrite = Layer.succeed(Write)({ print: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(writeOmitted({ score: 41 }).pipe(Effect.provide(defectiveWrite)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("encoder defect lost under omit");
expect(await Effect.runPromise(Schema.encodeEffect(decodedOmitted)({ score: 41 }).pipe(Effect.provide(defectiveWrite))), {});
const badDefault = Layer.succeed(Defaults)({ make: () => Effect.succeed("bad") });
const invalid = await Effect.runPromiseExit(readDefault({}).pipe(Effect.provide(Layer.merge(read, badDefault))));
if (!Exit.isFailure(invalid)) throw new Error("encoded default bypassed wrapped validation");
const errorFallback = Layer.succeed(Errors)({ make: () => Effect.succeed("8") });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(errorDefault)({}).pipe(Effect.provide(Layer.merge(read, errorFallback)))), { score: 9 });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(pureDefault)({})), { name: "Ada" });
expect(await Effect.runPromise(Schema.encodeEffect(pureDefault)({ name: "Ada" })), { name: "Ada" });
const beforeNull = count;
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullableDefault)({ name: null }).pipe(Effect.provide(fallback))), { name: null });
expect(count, beforeNull);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullableDefault)({}).pipe(Effect.provide(fallback))), { name: String(count) });
expect(await Effect.runPromise(Schema.encodeEffect(nullableDefault)({ name: null })), { name: null });
// @ts-expect-error The intermediate unknown does not widen the public wire field.
const invalidWire: typeof defaulted.Encoded = { score: 1 };
void invalidWire;
const wire: typeof defaulted.Encoded = {};
void wire;
// @ts-expect-error Decoded fields remain required.
const absent: typeof defaulted.Type = {};
void absent;
for (const point of ["read", "default", "write"] as const) {
  await Effect.runPromise(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined);
      return yield* Effect.never;
    }).pipe(Effect.ensuring(Effect.sync(() => { released = true; })));
    const pendingRead = Layer.succeed(Read)({ parse: () => point === "read" ? pending : Effect.succeed(1) });
    const pendingDefault = Layer.succeed(Defaults)({ make: () => point === "default" ? pending : Effect.succeed("1") });
    const pendingWrite = Layer.succeed(Write)({ print: () => pending });
    const operation: Effect.Effect<unknown, Schema.SchemaError> = point === "write"
      ? writeOmitted({ score: 41 }).pipe(Effect.provide(pendingWrite))
      : readDefault({}).pipe(Effect.provide(Layer.merge(pendingRead, pendingDefault)));
    const fiber = yield* Effect.forkChild(operation);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    if (!released) throw new Error("finalizer outlived cancellation at " + point);
  }));
}

`,
    prefix: "effective-schema-encoded-default-",
  },
  {
    name:
      "general Schema unions compile and preserve branch order and fallback",
    files: { "main.eff": emitFixture("schema-general-union") },
    entries: ["main.eff"],
    run:
      `import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Check, Write, converted, fallback, longFirst, readFallback, readScalar, scalar, shortFirst } from "./main.ts";

if (await Effect.runPromise(readScalar("Ada")) !== "Ada") throw new Error("string branch");
if (await Effect.runPromise(readScalar(3)) !== 3) throw new Error("integer branch");
if (await Effect.runPromise(Schema.encodeEffect(scalar)("Ada")) !== "Ada") throw new Error("string encode");
if (await Effect.runPromise(Schema.encodeEffect(scalar)(3)) !== 3) throw new Error("integer encode");
if (await Effect.runPromise(Schema.decodeUnknownEffect(converted)("one")) !== 1) throw new Error("transformed decode");
if (await Effect.runPromise(Schema.decodeUnknownEffect(converted)("Ada")) !== "Ada") throw new Error("transformed decode fallback");
const transformedEncode: Effect.Effect<string, Schema.SchemaError> = Schema.encodeEffect(converted)(1);
if (await Effect.runPromise(transformedEncode) !== "one") throw new Error("transformed encode");
if (await Effect.runPromise(Schema.encodeEffect(converted)("Ada")) !== "Ada") throw new Error("encoded branch selection");
const invalid = await Effect.runPromiseExit(readScalar(true));
if (!Exit.isFailure(invalid) || !(Option.getOrUndefined(Cause.findErrorOption(invalid.cause)) instanceof Schema.SchemaError)) throw new Error("invalid scalar");

const record = { name: "Ada", score: 3 };
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(shortFirst)(record))) !== '{"name":"Ada"}') throw new Error("short first decode");
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(longFirst)(record))) !== JSON.stringify(record)) throw new Error("long first decode");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(shortFirst)(record))) !== '{"name":"Ada"}') throw new Error("short first encode");

const calls: string[] = [];
const check = Layer.succeed(Check)({ accept: (value) => Effect.sync(() => { calls.push(value); return value; }).pipe(
  Effect.flatMap((name) => name === "Ada"
    ? Effect.fail(new SchemaIssue.InvalidValue({ message: "first refused" }))
    : Effect.succeed(name.toUpperCase()))
) });
const decode: Effect.Effect<string, Schema.SchemaError, Check> = readFallback("Ada");
if (await Effect.runPromise(decode.pipe(Effect.provide(check))) !== "Ada") throw new Error("typed issue did not backtrack");
if (await Effect.runPromise(readFallback("Bee").pipe(Effect.provide(check))) !== "BEE") throw new Error("first branch success");
if (calls.join(",") !== "Ada,Bee") throw new Error("branch evaluation order: " + calls);
const encodeCalls: string[] = [];
const write = Layer.succeed(Write)({ accept: (value) => Effect.sync(() => { encodeCalls.push(value); return value; }).pipe(
  Effect.flatMap((name) => name === "Ada"
    ? Effect.fail(new SchemaIssue.InvalidValue({ message: "first encode refused" }))
    : Effect.succeed(name.toUpperCase()))
) });
const encode: Effect.Effect<string, Schema.SchemaError, Write> = Schema.encodeEffect(fallback)("Ada");
if (await Effect.runPromise(encode.pipe(Effect.provide(write))) !== "Ada") throw new Error("typed encode issue did not backtrack");
if (await Effect.runPromise(Schema.encodeEffect(fallback)("Bee").pipe(Effect.provide(write))) !== "BEE") throw new Error("first encode branch success");
if (encodeCalls.join(",") !== "Ada,Bee") throw new Error("encode branch order: " + encodeCalls);

const defective = Layer.succeed(Check)({ accept: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readFallback("Ada").pipe(Effect.provide(defective)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect backtracked or changed channel");
const waiting = Layer.succeed(Check)({ accept: () => Effect.never });
const fiber = Effect.runFork(readFallback("Ada").pipe(Effect.provide(waiting)));
await Effect.runPromise(Fiber.interrupt(fiber));
const interrupted = await Effect.runPromise(Fiber.await(fiber));
if (!Exit.isFailure(interrupted) || !Cause.hasInterrupts(interrupted.cause)) throw new Error("interruption backtracked or changed channel");
`,
    prefix: "effective-schema-union-",
  },
  {
    name:
      "missing-or-null defaults compile with directional services, failures and cancellation",
    files: { "main.eff": emitFixture("schema-null-default") },
    entries: ["main.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Defaults, Errors, Read, Write, defaulted, omitted, passed, errorDefault, pureDefault, readDefault, writeDefault } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const calls: string[] = [];
let count = 0;
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const fallback = Layer.succeed(Defaults)({ make: () => Effect.sync(() => ++count) });
const services = Layer.merge(read, fallback);
expect(count, 0);
for (const schema of [defaulted, omitted, passed]) {
  for (const input of [{}, { score: null }]) {
    const operation: Effect.Effect<{ readonly score: number }, Schema.SchemaError, Read | Defaults> = Schema.decodeUnknownEffect(schema)(input);
    // @ts-expect-error Both decoder and default requirements remain static.
    const missingDefault: Effect.Effect<{ readonly score: number }, Schema.SchemaError, Read> = operation;
    void missingDefault;
    expect(await Effect.runPromise(operation.pipe(Effect.provide(services))), { score: count });
    expect(await Effect.runPromise(operation.pipe(Effect.provide(services))), { score: count });
  }
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(schema)({ score: "42" }).pipe(Effect.provide(services))), { score: 42 });
  for (const input of [{ score: undefined }, { score: false }]) {
    const exit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(schema)(input).pipe(Effect.provide(services)));
    if (!Exit.isFailure(exit)) throw new Error("invalid input accepted");
  }
}
expect(count, 12);
expect(calls, ["read:42", "read:42", "read:42"]);
for (const score of [0, 42]) {
  const encoded: Effect.Effect<{ readonly score?: string | null }, Schema.SchemaError, Write> = writeDefault({ score });
  expect(await Effect.runPromise(encoded.pipe(Effect.provide(write))), { score: String(score) });
  const omit: Effect.Effect<{ readonly score?: string | null }, Schema.SchemaError, Write> = Schema.encodeEffect(omitted)({ score });
  // @ts-expect-error Omission retains the static encoder requirement.
  const missingWrite: Effect.Effect<{ readonly score?: string | null }, Schema.SchemaError> = omit;
  void missingWrite;
  expect(await Effect.runPromise(omit.pipe(Effect.provide(write))), {});
  expect(await Effect.runPromise(Schema.encodeEffect(passed)({ score }).pipe(Effect.provide(write))), { score: String(score) });
}
expect(count, 12);
expect(calls, ["read:42", "read:42", "read:42", "write:0", "write:0", "write:42", "write:42"]);
for (const score of [null, undefined, "42"]) {
  const exit = await Effect.runPromiseExit(Schema.encodeUnknownEffect(omitted)({ score }).pipe(Effect.provide(write)));
  if (!Exit.isFailure(exit)) throw new Error("omission skipped decoded validation");
}
const blocked = new SchemaIssue.InvalidValue({ message: "default blocked" });
const issueDefault = Layer.succeed(Defaults)({ make: () => Effect.fail(blocked) });
const schemaErrorDefault = Layer.succeed(Errors)({ make: () => Effect.fail(new Schema.SchemaError(blocked)) });
for (const input of [{}, { score: null }]) {
  for (const effect of [
    readDefault(input).pipe(Effect.provide(Layer.merge(read, issueDefault))),
    Schema.decodeUnknownEffect(errorDefault)(input).pipe(Effect.provide(Layer.merge(read, schemaErrorDefault))),
  ]) {
    const exit = await Effect.runPromiseExit(effect);
    if (!Exit.isFailure(exit)) throw new Error("default failure lost");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (!(error instanceof Schema.SchemaError) || !error.message.includes("default blocked") || !error.message.includes("score")) throw new Error("default issue path lost");
  }
}
expect(await Effect.runPromise(Schema.decodeUnknownEffect(errorDefault)({ score: null }).pipe(Effect.provide(Layer.merge(read, Layer.succeed(Errors)({ make: () => Effect.succeed(8) }))))), { score: 8 });
for (const input of [{}, { score: null }]) {
  const defective = Layer.succeed(Defaults)({ make: () => Effect.die("boom") });
  const exit = await Effect.runPromiseExit(readDefault(input).pipe(Effect.provide(Layer.merge(read, defective))));
  if (!Exit.isFailure(exit) || !Cause.hasDies(exit.cause)) throw new Error("defect changed channel");
}
for (const input of [{}, { score: null }]) {
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(pureDefault)(input)), { score: 7 });
}
expect(await Effect.runPromise(Schema.encodeEffect(pureDefault)({ score: 7 })), { score: 7 });
const wire: typeof defaulted.Encoded = { score: null };
void wire;
// @ts-expect-error Decoded fields remain required.
const absent: typeof defaulted.Type = {};
void absent;
// @ts-expect-error Decoded fields exclude null.
const nil: typeof defaulted.Type = { score: null };
void nil;
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Layer.succeed(Defaults)({ make: () => Effect.gen(function*() {
    yield* Deferred.succeed(entered, undefined);
    return yield* Effect.never;
  }).pipe(Effect.ensuring(Effect.sync(() => { released = true; }))) });
  const fiber = yield* Effect.forkChild(readDefault({ score: null }).pipe(Effect.provide(Layer.merge(read, pending))));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("default finalizer outlived interruption");
}));
`,
    prefix: "effective-schema-null-default-",
  },
  {
    name:
      "nullable optional Schema fields compile and preserve missing versus null",
    files: { "main.eff": emitFixture("schema-nullable-optional") },
    entries: ["main.eff"],
    run: `import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Defaults, Read, Write, absent, collapsed, defaulted, exact, finite, identity, isNull, isPresent, nullRef, nullValue, option, presentNull, unit } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({actual, expected}));
};
if (nullValue !== null || unit() !== undefined) throw new Error("null and unit confused");
expect(await Effect.runPromise(nullRef()), null);
expect(presentNull(), { name: null });
expect(absent(), {});
if (!Object.hasOwn(presentNull(), "name") || Object.hasOwn(absent(), "name")) throw new Error("presence lost");
if (!isNull(null) || isNull("Ada") || isPresent(null) || !isPresent("Ada") || !finite(null) || finite("present")) throw new Error("null equality or match");
expect(await Effect.runPromise(Schema.decodeUnknownEffect(identity)(null)), null);
expect(await Effect.runPromise(Schema.encodeEffect(identity)(null)), null);

const events: string[] = [];
const read = Layer.succeed(Read)({ normalize: (value) => Effect.sync(() => { events.push("read:" + value); return value.toUpperCase(); }) });
const write = Layer.succeed(Write)({ restore: (value) => Effect.sync(() => { events.push("write:" + value); return value.toLowerCase(); }) });
for (const input of [{}, { name: null }, { name: "Ada" }]) {
  const effect: Effect.Effect<{ readonly name?: string | null }, Schema.SchemaError, Read> = Schema.decodeUnknownEffect(exact)(input);
  expect(await Effect.runPromise(effect.pipe(Effect.provide(read))), "name" in input && input.name !== null ? { name: "ADA" } : input);
}
for (const input of [{}, { name: null }, { name: "ADA" }]) {
  const effect: Effect.Effect<{ readonly name?: string | null }, Schema.SchemaError, Write> = Schema.encodeEffect(exact)(input);
  expect(await Effect.runPromise(effect.pipe(Effect.provide(write))), "name" in input && input.name !== null ? { name: "ada" } : input);
}
expect(events, ["read:Ada", "write:ADA"]);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(collapsed)({ name: null }).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(collapsed)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.encodeEffect(collapsed)({}).pipe(Effect.provide(write))), {});
expect(events, ["read:Ada", "write:ADA"]);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(collapsed)({ name: "Bee" }).pipe(Effect.provide(read))), { name: "BEE" });
expect(await Effect.runPromise(Schema.encodeEffect(collapsed)({ name: "BEE" }).pipe(Effect.provide(write))), { name: "bee" });
expect(events.splice(2), ["read:Bee", "write:BEE"]);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(option)({}).pipe(Effect.provide(read))), { name: Option.none() });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(option)({ name: null }).pipe(Effect.provide(read))), { name: Option.some(null) });
expect(await Effect.runPromise(Schema.encodeEffect(option)({ name: Option.none() }).pipe(Effect.provide(write))), {});
expect(await Effect.runPromise(Schema.encodeEffect(option)({ name: Option.some(null) }).pipe(Effect.provide(write))), { name: null });

let defaults = 0;
const defaultsLayer = Layer.succeed(Defaults)({ make: () => Effect.sync(() => { defaults++; return null; }) });
const decodeDefault = (input: unknown) => Schema.decodeUnknownEffect(defaulted)(input).pipe(Effect.provide(Layer.merge(read, defaultsLayer)));
expect(await Effect.runPromise(decodeDefault({})), { name: null });
expect(await Effect.runPromise(decodeDefault({ name: null })), { name: null });
if (defaults !== 1) throw new Error("null ran missing-key default");
expect(await Effect.runPromise(Schema.encodeEffect(defaulted)({ name: null }).pipe(Effect.provide(write))), { name: null });
expect(events, ["read:Ada", "write:ADA"]);

for (const effect of [
  Schema.decodeUnknownEffect(exact)({ name: undefined }).pipe(Effect.provide(read)),
  Schema.encodeUnknownEffect(exact)({ name: undefined }).pipe(Effect.provide(write)),
  Schema.decodeUnknownEffect(collapsed)({ name: undefined }).pipe(Effect.provide(read)),
]) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("undefined accepted");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("name")) throw new Error("field path lost");
}
const wire: typeof exact.Encoded = { name: null };
void wire;
// @ts-expect-error A nullable exact optional field still excludes explicit undefined.
const undefinedWire: typeof exact.Encoded = { name: undefined };
void undefinedWire;
const nullableWire: typeof collapsed.Encoded = { name: null };
void nullableWire;
// @ts-expect-error Collapsing null excludes it from the decoded field type.
const invalidDecoded: typeof collapsed.Type = { name: null };
void invalidDecoded;
const defective = Layer.succeed(Read)({ normalize: () => Effect.die("boom") });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(exact)({ name: null }).pipe(Effect.provide(defective))), { name: null });
const exit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(exact)({ name: "Ada" }).pipe(Effect.provide(defective)));
if (!Exit.isFailure(exit) || !Cause.hasDies(exit.cause)) throw new Error("defect changed channel");
`,
    prefix: "effective-schema-nullable-",
  },
  {
    name:
      "optional fields, tagged union, authored issues, and finite recursion compile and run",
    files: { "main.eff": emitFixture("schema-optional-union") },
    entries: ["main.eff"],
    run:
      `import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { Read, Write, choice, optional, optionalNode, taggedNode, readChoice, readOptional, readPositive, writeChoice, writeOptional, writePositive } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => {
  events.push("read:" + value);
  return Option.some(value + 1);
}) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => {
  events.push("write:" + value);
  return Option.some(value - 1);
}) });
if (events.length !== 0 || !choice || !optional) throw new Error("eager schema");
const absent = await Effect.runPromise(readOptional({}).pipe(Effect.provide(read)));
const absentEncoded = await Effect.runPromise(writeOptional({}).pipe(Effect.provide(write)));
if (JSON.stringify(absent) !== "{}" || JSON.stringify(absentEncoded) !== "{}" || events.length !== 0) throw new Error("missing optional field ran");
const present = await Effect.runPromise(readOptional({ value: 1 }).pipe(Effect.provide(read)));
const encoded = await Effect.runPromise(writeOptional({ value: 2 }).pipe(Effect.provide(write)));
if (JSON.stringify(present) !== '{"value":2}' || JSON.stringify(encoded) !== '{"value":1}') throw new Error("present optional field");
const right = await Effect.runPromise(readChoice({ kind: "right", value: 7 }).pipe(Effect.provide(read)));
const left = await Effect.runPromise(readChoice({ kind: "left", value: 1 }).pipe(Effect.provide(read)));
const leftEncoded = await Effect.runPromise(writeChoice({ kind: "left", value: 2 }).pipe(Effect.provide(write)));
const again = await Effect.runPromise(readOptional({ value: 1 }).pipe(Effect.provide(read)));
if (JSON.stringify(right) !== '{"kind":"right","value":7}' || JSON.stringify(left) !== '{"kind":"left","value":2}' || JSON.stringify(leftEncoded) !== '{"kind":"left","value":1}') throw new Error("tag dispatch");
if (JSON.stringify(again) !== '{"value":2}' || events.join(",") !== "read:1,write:2,read:1,write:2,read:1") throw new Error("wrong field effects or replay: " + events.join(","));
const invalid = await Effect.runPromiseExit(readOptional({ value: undefined }).pipe(Effect.provide(read)));
if (!Exit.isFailure(invalid) || !(Option.getOrUndefined(Cause.findErrorOption(invalid.cause)) instanceof Schema.SchemaError)) throw new Error("present undefined accepted");
const issueExit = await Effect.runPromiseExit(readPositive(0));
if (!Exit.isFailure(issueExit)) throw new Error("positive schema accepted zero");
const issue = Option.getOrUndefined(Cause.findErrorOption(issueExit.cause));
if (!(issue instanceof Schema.SchemaError) || !issue.message.includes("not positive") || !issue.message.includes("try another value") || !JSON.stringify(issue.issue).includes('"path":["value"]')) throw new Error("lost authored issue tree");
const encodeIssueExit = await Effect.runPromiseExit(writePositive(0));
if (!Exit.isFailure(encodeIssueExit)) throw new Error("encode issue accepted zero");
const encodeIssue = Option.getOrUndefined(Cause.findErrorOption(encodeIssueExit.cause));
if (!(encodeIssue instanceof Schema.SchemaError) || !encodeIssue.message.includes("cannot encode zero") || !JSON.stringify(encodeIssue.issue).includes('"path":["encode"]')) throw new Error("lost encode issue");
const optionalValue = { next: { next: {} } };
const taggedValue = { kind: "more", next: { kind: "end" } } as const;
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(optionalNode)(optionalValue))) !== JSON.stringify(optionalValue)) throw new Error("optional recursion decode");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(optionalNode)(optionalValue))) !== JSON.stringify(optionalValue)) throw new Error("optional recursion encode");
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(taggedNode)(taggedValue))) !== JSON.stringify(taggedValue)) throw new Error("tagged recursion decode");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(taggedNode)(taggedValue))) !== JSON.stringify(taggedValue)) throw new Error("tagged recursion encode");
const defect = Layer.succeed(Read)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readOptional({ value: 1 }).pipe(Effect.provide(defect)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect translated");
const blocked = Layer.succeed(Read)({ next: () => Effect.never });
const fiber = Effect.runFork(readOptional({ value: 1 }).pipe(Effect.provide(blocked)));
await Effect.runPromise(Fiber.interrupt(fiber));
const interrupted = await Effect.runPromise(Fiber.await(fiber));
if (!Exit.isFailure(interrupted) || !Cause.hasInterrupts(interrupted.cause)) throw new Error("interruption translated");
`,
    prefix: "effective-schema-optional-",
  },
  {
    name:
      "optional Schema conversion, defaults, and normalization compile and run",
    files: { "main.eff": emitFixture("schema-optional-transform") },
    entries: ["main.eff"],
    run: `import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Read, Write, readOption, writeOption, readDefault, writeDefault, readNormalized, writeNormalized } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => {
  events.push("read:" + value);
  return Option.some(value + 1);
}) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => {
  events.push("write:" + value);
  return Option.some(value - 1);
}) });
const none = await Effect.runPromise(readOption({}).pipe(Effect.provide(read)));
if (!Option.isNone(none.score) || events.length !== 0) throw new Error("missing Option field");
const empty = await Effect.runPromise(writeOption({ score: Option.none() }).pipe(Effect.provide(write)));
if (JSON.stringify(empty) !== "{}" || events.length !== 0) throw new Error("None encode");
const some = await Effect.runPromise(readOption({ score: 1 }).pipe(Effect.provide(read)));
const encoded = await Effect.runPromise(writeOption({ score: Option.some(2) }).pipe(Effect.provide(write)));
if (!Option.isSome(some.score) || some.score.value !== 2 || JSON.stringify(encoded) !== '{"score":1}') throw new Error("Some conversion");
if (events.join(",") !== "read:1,write:2") throw new Error("directional services");
const again = await Effect.runPromise(readOption({ score: 1 }).pipe(Effect.provide(read)));
if (!Option.isSome(again.score) || again.score.value !== 2 || events.join(",") !== "read:1,write:2,read:1") throw new Error("repeated execution");
if (JSON.stringify(await Effect.runPromise(readDefault({}))) !== '{"score":3}') throw new Error("missing default");
if (JSON.stringify(await Effect.runPromise(readDefault({ score: 5 }))) !== '{"score":5}') throw new Error("present default");
if (JSON.stringify(await Effect.runPromise(writeDefault({ score: 3 }))) !== '{"score":3}') throw new Error("default passthrough");
if (JSON.stringify(await Effect.runPromise(readNormalized({ score: -1 }))) !== "{}") throw new Error("normalization omission");
if (JSON.stringify(await Effect.runPromise(readNormalized({ score: 2 }))) !== '{"score":2}') throw new Error("normalization present");
if (JSON.stringify(await Effect.runPromise(writeNormalized({ score: 0 }))) !== '{"score":0}') throw new Error("encode normalization direction");
const invalidInputs: Array<Effect.Effect<unknown, Schema.SchemaError>> = [
  readOption({ score: undefined }).pipe(Effect.provide(read)),
  readDefault({ score: undefined }),
  readNormalized({ score: undefined }),
];
for (const operation of invalidInputs) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit) || !(Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof Schema.SchemaError)) throw new Error("present undefined accepted");
}
`,
    prefix: "effective-schema-field-",
  },
  {
    name:
      "recursive wire shapes compile across imports with directional services and cleanup",
    files: {
      "main.eff": emitFixture("schema-recursive-wire"),
      "imported.eff":
        `import { tree, Tree, WireTree, TreeInput, Read, Write } from "./main.eff"
export const forest: Schema<Tree[], WireTree[], Read.parse, Write.print, TreeInput[]> = schemaArray(tree)
`,
    },
    entries: ["main.eff", "imported.eff"],
    run:
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, tree, node, choice, makeTree, makeNode, makeChoice, readTree, writeTree, readNode, writeNode, readChoice, writeChoice } from "./main.ts";
import { forest } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.suspend(() => {
  calls.push("read:" + value);
  return value === "bad" ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked decode" })) : Effect.succeed(Number(value));
}) });
const write = Layer.succeed(Write)({ print: (value) => Effect.suspend(() => {
  calls.push("write:" + value);
  return value === 9 ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked encode" })) : Effect.succeed(String(value));
}) });
const wire: typeof tree.Encoded = { score: "1", children: [{ score: "2", children: [] }] };
const decoded: typeof tree.Type = { score: 1, children: [{ score: 2, children: [] }] };
const decode: Effect.Effect<typeof tree.Type, Schema.SchemaError> = readTree(wire).pipe(Effect.provide(read));
const encode: Effect.Effect<typeof tree.Encoded, Schema.SchemaError> = writeTree(decoded).pipe(Effect.provide(write));
expect(calls, []);
expect(await Effect.runPromise(decode), decoded);
expect(await Effect.runPromise(encode), wire);
expect(await Effect.runPromise(decode), decoded);
expect(calls, ["read:1", "read:2", "write:1", "write:2", "read:1", "read:2"]);
const input: typeof tree["~type.make.in"] = { children: [{}] };
const make: Effect.Effect<typeof tree.Type, SchemaIssue.Issue> = makeTree(input);
expect(await Effect.runPromise(make), { score: 4, children: [{ score: 4, children: [] }] });
expect(await Effect.runPromise(forest.makeEffect([{}, { children: [{}] }])), [{ score: 4, children: [] }, { score: 4, children: [{ score: 4, children: [] }] }]);
expect(calls.length, 6);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(forest)([wire]).pipe(Effect.provide(read))), [decoded]);
expect(await Effect.runPromise(Schema.encodeEffect(forest)([decoded]).pipe(Effect.provide(write))), [wire]);
expect(await Effect.runPromise(readNode({ next: {} }).pipe(Effect.provide(read))), { score: 8, next: { score: 8 } });
expect(await Effect.runPromise(writeNode({ score: 8, next: { score: 8 } }).pipe(Effect.provide(write))), { score: "8", next: { score: "8" } });
expect(await Effect.runPromise(makeNode({ score: 2, next: { score: 3 } })), { score: 2, next: { score: 3 } });
const wireChoice: typeof choice.Encoded = { kind: "more", score: "2", next: { kind: "more", score: "3", next: { kind: "end" } } };
const decodedChoice = await Effect.runPromise(readChoice(wireChoice).pipe(Effect.provide(read)));
expect(decodedChoice, { kind: "more", score: 2, next: { kind: "more", score: 3, next: { kind: "end" } } });
expect(await Effect.runPromise(writeChoice(decodedChoice).pipe(Effect.provide(write))), wireChoice);
expect(await Effect.runPromise(makeChoice({ kind: "more", next: { kind: "more" } })), { kind: "more", score: 4, next: { kind: "more", score: 4, next: { kind: "end" } } });
const missing = await Effect.runPromiseExit(readTree({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing)) throw new Error("wire decode used constructor defaults");
const operations: ReadonlyArray<Effect.Effect<unknown, Schema.SchemaError>> = [
  readTree({ score: "1", children: [{ score: "bad", children: [] }] }).pipe(Effect.provide(read)),
  writeTree({ score: 1, children: [{ score: 9, children: [] }] }).pipe(Effect.provide(write)),
];
for (const operation of operations) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit)) throw new Error("recursive wire failure lost");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("children") || !error.message.includes("score") || !error.message.includes("0")) throw new Error("wire issue path lost");
}
// @ts-expect-error Encoded self references keep string fields.
const wrongWire: typeof tree.Encoded = { score: "1", children: [{ score: 2, children: [] }] };
// @ts-expect-error Decoded self references keep numeric fields.
const wrongDecoded: Parameters<typeof writeTree>[0] = { score: 1, children: [{ score: "2", children: [] }] };
// @ts-expect-error Make input uses decoded types at every self reference.
const wrongMake: typeof tree["~type.make.in"] = { children: [{ score: "2" }] };
// @ts-expect-error Decoding defaults do not make constructor fields optional.
const wrongNode: Parameters<typeof makeNode>[0] = { next: {} };
void wrongWire; void wrongDecoded; void wrongMake; void wrongNode; void node;
for (const direction of ["read", "write"] as const) {
  const defect: Effect.Effect<unknown, Schema.SchemaError> = direction === "read" ? readTree(wire).pipe(Effect.provide(Layer.succeed(Read)({ parse: () => Effect.die("defect") }))) : writeTree(decoded).pipe(Effect.provide(Layer.succeed(Write)({ print: () => Effect.die("defect") })));
  const exit = await Effect.runPromiseExit(Effect.asVoid(defect));
  if (!Exit.isFailure(exit) || !Cause.hasDies(exit.cause) || Option.isSome(Cause.findErrorOption(exit.cause))) throw new Error("wire defect translated");
  await Effect.runPromise(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
    const operation: Effect.Effect<unknown, Schema.SchemaError> = direction === "read" ? readTree(wire).pipe(Effect.provide(Layer.succeed(Read)({ parse: (value) => value === "2" ? pending : Effect.succeed(Number(value)) }))) : writeTree(decoded).pipe(Effect.provide(Layer.succeed(Write)({ print: (value) => value === 2 ? pending : Effect.succeed(String(value)) })));
    const fiber = yield* Effect.forkChild(Effect.asVoid(operation));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    if (!released) throw new Error("nested wire cleanup outlived interruption");
  }));
}
`,
    prefix: "effective-recursive-wire-",
  },
  {
    name: "required-encoded optional Schema fields compile and run",
    files: { "main.eff": emitFixture("schema-required-optional") },
    entries: ["main.eff"],
    run:
      `import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { Read, Write, guarded, pure, readRequired, writeRequired } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ normalize: (value) => Effect.sync(() => {
  events.push("read:" + value);
  return value === "" ? Option.none() : Option.some(value.toUpperCase());
}) });
const write = Layer.succeed(Write)({ restore: (value) => Effect.sync(() => {
  events.push(Option.isSome(value) ? "write:" + value.value : "write:none");
  return Option.getOrElse(value, () => "");
}) });
const missing = await Effect.runPromiseExit(readRequired({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing)) throw new Error("missing encoded key accepted");
const missingError = Option.getOrUndefined(Cause.findErrorOption(missing.cause));
if (!(missingError instanceof Schema.SchemaError) || !missingError.message.includes("name")) throw new Error("missing field path lost");
if (events.length !== 0) throw new Error("decode callback ran on missing key");
if (JSON.stringify(await Effect.runPromise(readRequired({ name: "" }).pipe(Effect.provide(read)))) !== "{}") throw new Error("present empty value not omitted");
if (JSON.stringify(await Effect.runPromise(readRequired({ name: "Ada" }).pipe(Effect.provide(read)))) !== '{"name":"ADA"}') throw new Error("present value not normalized");
if (JSON.stringify(await Effect.runPromise(writeRequired({}).pipe(Effect.provide(write)))) !== '{"name":""}') throw new Error("missing decoded key not restored");
if (JSON.stringify(await Effect.runPromise(writeRequired({ name: "Ada" }).pipe(Effect.provide(write)))) !== '{"name":"Ada"}') throw new Error("present encode value");
if (events.join(",") !== "read:,read:Ada,write:none,write:Ada") throw new Error("directional callback calls: " + events);
const blocked = await Effect.runPromiseExit(readRequired({ name: "blocked" }).pipe(Effect.provide(read)));
if (!Exit.isFailure(blocked)) throw new Error("authored issue accepted");
const issue = Option.getOrUndefined(Cause.findErrorOption(blocked.cause));
if (!(issue instanceof Schema.SchemaError) || !issue.message.includes("blocked name") || !issue.message.includes("name")) throw new Error("authored issue lost");
const undefinedValue = await Effect.runPromiseExit(readRequired({ name: undefined }).pipe(Effect.provide(read)));
if (!Exit.isFailure(undefinedValue)) throw new Error("undefined accepted");
if (JSON.stringify(await Effect.runPromise(Schema.decodeUnknownEffect(pure)({ name: "" }))) !== "{}") throw new Error("pure omission");
if (JSON.stringify(await Effect.runPromise(Schema.encodeEffect(pure)({}))) !== '{"name":""}') throw new Error("pure restoration");
const defective = Layer.succeed(Read)({ normalize: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readRequired({ name: "Ada" }).pipe(Effect.provide(defective)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect became typed failure");
const waiting = Layer.succeed(Read)({ normalize: () => Effect.never });
const fiber = Effect.runFork(readRequired({ name: "Ada" }).pipe(Effect.provide(waiting)));
await Effect.runPromise(Fiber.interrupt(fiber));
const interrupted = await Effect.runPromise(Fiber.await(fiber));
if (!Exit.isFailure(interrupted) || !Cause.hasInterrupts(interrupted.cause)) throw new Error("interruption lost");
const encoded: typeof guarded.Encoded = { name: "Ada" };
void encoded;
// @ts-expect-error The emitted encoded field is required.
const absentEncoded: typeof guarded.Encoded = {};
void absentEncoded;
`,
    prefix: "effective-schema-required-",
  },
];

for (const c of CASES) {
  Deno.test(c.name, async () => {
    const output = await compileStrictTarget(
      c.files,
      c.entries,
      c.run,
      c.prefix,
    );
    c.verify?.(output);
  });
}

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-encoded-default.eff", import.meta.url),
);

function checked() {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": fixture }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
  return result.value;
}

Deno.test("encoded defaults run decoding and retain encoder work before omission", async () => {
  const project = checked();
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  await runStrictTarget(
    emitProject(lowered, { config: project.analysis.project.config }),
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
    "effective-schema-encoded-default-",
  );
});

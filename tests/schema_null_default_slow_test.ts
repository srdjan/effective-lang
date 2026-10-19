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
  new URL("../fixtures/emit/schema-null-default.eff", import.meta.url),
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

Deno.test("missing-or-null defaults compile with directional services, failures and cancellation", async () => {
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
    "effective-schema-null-default-",
  );
});

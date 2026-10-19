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
  new URL("../fixtures/emit/schema-constructor-order.eff", import.meta.url),
);
const base = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-fields.eff", import.meta.url),
);

Deno.test("field adapters retain or reset constructor defaults across imports with native lifetimes", async () => {
  const project = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": fixture,
      "schema-constructor-fields.eff": base,
    }),
    "",
    ["main.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  await runStrictTarget(
    emitProject(lowered, { config: project.value.analysis.project.config }),
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
    "effective-constructor-order-",
  );
});

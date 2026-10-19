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
  new URL("../fixtures/emit/schema-constructor-metadata.eff", import.meta.url),
);

const imported = `import { child, D, E, M, Read, Write } from "./main.eff"
type OuterD = { settings: D }
type OuterE = { settings: E }
type OuterM = { settings?: M }
export const outer: Schema<OuterD, OuterE, Read.parse, Write.print, OuterM> =
  schemaStruct({ settings: schemaConstructorDefault(child, (): M => ({})) })
`;

function checked() {
  const result = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": fixture,
      "imported.eff": imported,
    }),
    "",
    ["main.eff", "imported.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
  return result.value;
}

Deno.test("constructor metadata composes make inputs without changing wire contracts", async () => {
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
    "effective-schema-constructor-metadata-",
  );
});

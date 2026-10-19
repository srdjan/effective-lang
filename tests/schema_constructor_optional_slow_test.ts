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
  new URL("../fixtures/emit/schema-constructor-optional.eff", import.meta.url),
);

Deno.test("optional adapters construct nested defaults without running wire effects", async () => {
  const imported =
    `import { nullField, decodedField, D, E, M, Read, Write, Defaults } from "./main.eff"
type NullableWire = { settings?: E | null }
export const optional: Schema<{ settings?: D }, NullableWire, Read.parse, Write.print, { settings?: M }> = schemaStruct({ settings: nullField })
export const defaulted: Schema<{ settings: D }, { settings?: E }, Read.parse | Defaults.next, Write.print, { settings: M }> = schemaStruct({ settings: decodedField })
`;
  const project = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": fixture,
      "imported.eff": imported,
    }),
    "",
    ["main.eff", "imported.eff"],
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
    "effective-constructor-optional-",
  );
});

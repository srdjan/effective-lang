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
  new URL("../fixtures/emit/schema-nullable-optional.eff", import.meta.url),
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

Deno.test("nullable optional Schema fields compile and preserve missing versus null", async () => {
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
    `import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
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
    "effective-schema-nullable-",
  );
});

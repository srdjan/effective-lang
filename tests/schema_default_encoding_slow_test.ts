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
  new URL("../fixtures/emit/schema-default-encoding.eff", import.meta.url),
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

Deno.test("Schema default encoding strategies compile and retain directional behavior", async () => {
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
    "effective-schema-default-encoding-",
  );
});

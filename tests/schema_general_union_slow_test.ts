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
  new URL("../fixtures/emit/schema-general-union.eff", import.meta.url),
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

Deno.test("general Schema unions compile and preserve branch order and fallback", async () => {
  const project = checked();
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) {
    assertEquals(diagnostics, []);
  }

  await runStrictTarget(
    emitProject(lowered, { config: project.analysis.project.config }),
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
    "effective-schema-union-",
  );
});

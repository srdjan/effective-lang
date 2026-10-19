import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-required-optional.eff", import.meta.url),
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

Deno.test("required-encoded optional Schema fields compile and run", async () => {
  const project = checked();
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);

  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-required-" });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      }),
    );
    for (
      const result of emitProject(lowered, {
        config: project.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
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
    );
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

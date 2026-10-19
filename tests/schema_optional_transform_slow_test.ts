import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-optional-transform.eff", import.meta.url),
);

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("optional Schema conversion, defaults, and normalization compile and run", async () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);

  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-field-" });
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
      `import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
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

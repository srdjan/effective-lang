import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-effectful-optional.eff", import.meta.url),
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

Deno.test("effectful optional Schema getters and defaults compile and run", async () => {
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

  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-effectful-" });
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
import { Read, Write, Default, readOptional, writeOptional, readDefault, writeDefault, readExistingError } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => { events.push("read:" + value); return value + 1; }) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => { events.push("write:" + value); return value - 1; }) });
const count = { value: 0 };
const defaults = Layer.succeed(Default)({ make: () => Effect.sync(() => ++count.value) });
if (JSON.stringify(await Effect.runPromise(readOptional({}).pipe(Effect.provide(read)))) !== '{"score":1}') throw new Error("missing decode getter");
if (JSON.stringify(await Effect.runPromise(readOptional({ score: 2 }).pipe(Effect.provide(read)))) !== '{"score":3}') throw new Error("present decode getter");
if (JSON.stringify(await Effect.runPromise(writeOptional({}).pipe(Effect.provide(write)))) !== '{"score":0}') throw new Error("missing encode getter");
if (JSON.stringify(await Effect.runPromise(writeOptional({ score: 3 }).pipe(Effect.provide(write)))) !== '{"score":2}') throw new Error("present encode getter");
if (events.join(",") !== "read:0,read:2,write:1,write:3") throw new Error("directional getter calls: " + events);
if (JSON.stringify(await Effect.runPromise(readDefault({ score: 9 }).pipe(Effect.provide(defaults)))) !== '{"score":9}' || count.value !== 0) throw new Error("present default");
const absent = readDefault({}).pipe(Effect.provide(defaults));
if (JSON.stringify(await Effect.runPromise(absent)) !== '{"score":1}') throw new Error("first default");
if (JSON.stringify(await Effect.runPromise(absent)) !== '{"score":2}') throw new Error("second default");
if (JSON.stringify(await Effect.runPromise(writeDefault({ score: 9 }))) !== '{"score":9}' || Number(count.value) !== 2) throw new Error("encode default service");
if (JSON.stringify(await Effect.runPromise(readExistingError({}))) !== '{"score":4}') throw new Error("existing SchemaError callback");

const blockedRead = Layer.succeed(Read)({ next: () => Effect.succeed(-1) });
const blockedWrite = Layer.succeed(Write)({ previous: () => Effect.succeed(-1) });
const blockedDefault = Layer.succeed(Default)({ make: () => Effect.succeed(0) });
for (const [operation, text] of [
  [readOptional({ score: 1 }).pipe(Effect.provide(blockedRead)), "read blocked"],
  [writeOptional({ score: 1 }).pipe(Effect.provide(blockedWrite)), "write blocked"],
  [readDefault({}).pipe(Effect.provide(blockedDefault)), "no default"],
] as const) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit)) throw new Error("expected schema failure");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes(text) || !error.message.includes("score")) throw new Error("authored issue/path lost: " + String(error));
}
const defectiveRead = Layer.succeed(Read)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(readOptional({}).pipe(Effect.provide(defectiveRead)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("defect became a typed failure");
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

Deno.test("validator rejects forged optional callback failures and requirements", () => {
  const project = checked();
  const result = [...lowerProject(project).values()][0];
  assert(result?.ok, JSON.stringify(result));
  const forged = structuredClone(result.value);
  const field = forged.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "transformedField"
  );
  assert(field?.kind === "constant" && field.value.kind === "schema");
  const callback = field.value.arguments[2];
  assert(callback?.kind === "closure" && callback.type.kind === "function");
  Object.assign(callback.type.effects, {
    failures: ["error:effect/SchemaError"],
  });
  assert(
    validateModule(forged, new Map([["main.eff", fixture]])).some(
      (diagnostic) => diagnostic.message.includes("schemaOptionalTransform"),
    ),
  );

  const wrongDefault = structuredClone(result.value);
  const defaultField = wrongDefault.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "defaultField"
  );
  assert(
    defaultField?.kind === "constant" &&
      defaultField.value.kind === "schema",
  );
  const fallback = defaultField.value.arguments[1];
  assert(fallback?.kind === "closure" && fallback.type.kind === "function");
  Object.assign(fallback.type.effects, { failures: ["error:Other"] });
  assert(
    validateModule(wrongDefault, new Map([["main.eff", fixture]])).some(
      (diagnostic) => diagnostic.message.includes("schemaDefaultKey"),
    ),
  );

  const lostRequirements = structuredClone(result.value);
  const lostField = lostRequirements.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "transformedField"
  );
  assert(
    lostField?.kind === "constant" && lostField.value.type.kind === "schema",
  );
  Object.assign(lostField.value.type, { decodeRequirements: [] });
  assert(
    validateModule(lostRequirements, new Map([["main.eff", fixture]])).some(
      (diagnostic) => diagnostic.message.includes("type"),
    ),
  );
});

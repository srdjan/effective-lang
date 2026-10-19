import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor.eff", import.meta.url),
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

Deno.test("type-side constructors validate without wire services and compose explicit defaults", async () => {
  const project = checked();
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({
    prefix: "effective-schema-constructor-",
  });
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
      `import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import { Other, Read, Write, Values, record, nested, makeRecord, makeNested, makeDirect, makeObserved, readWire, writeWire, classify, catchMixed } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
};
const operation: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue> = makeRecord({});
expect(classify(new SchemaIssue.InvalidValue({ message: "x" })), 1);
expect(classify(new Other({})), 2);
expect(await Effect.runPromise(catchMixed(false)), 2);
const rethrown = await Effect.runPromiseExit(catchMixed(true));
if (!Exit.isFailure(rethrown) || !(Option.getOrUndefined(Cause.findErrorOption(rethrown.cause)) instanceof Other)) throw new Error("another handler recaught a handler's failure");
expect(await Effect.runPromise(operation), { score: 4 });
expect(await Effect.runPromise(operation), { score: 4 });
expect(await Effect.runPromise(makeRecord({ score: 8 })), { score: 8 });
expect(await Effect.runPromise(makeDirect({ score: 8 })), { score: 8 });
expect(await Effect.runPromise(makeNested({})), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: {} })), { settings: { score: 4 } });
expect(await Effect.runPromise(makeNested({ settings: { score: 8 } })), { settings: { score: 8 } });
// @ts-expect-error Exact factory input rejects explicit undefined statically.
const explicitUndefined = makeRecord({ score: undefined });
expect(await Effect.runPromise(explicitUndefined), { score: 4 });
const NativeInt = Schema.Finite.check(Schema.makeFilter((value) => Number.isSafeInteger(value) || "expected a safe integer"));
const native = Schema.Struct({ score: NativeInt.pipe(Schema.withConstructorDefault(Effect.succeed(4))) });
const nativeNested = Schema.Struct({ settings: native.pipe(Schema.withConstructorDefault(native.makeEffect({}))) });
for (const input of [{ score: 0.5 }, { score: null }]) {
  // Run the unknown host boundary without weakening the published input type.
  const makeUnknown = makeRecord as (input: unknown) => Effect.Effect<unknown, SchemaIssue.Issue>;
  const nativeUnknown = native.makeEffect as (input: unknown) => Effect.Effect<unknown, SchemaIssue.Issue>;
  const failures = [];
  for (const effect of [makeUnknown(input), nativeUnknown(input)]) {
    const exit = await Effect.runPromiseExit(effect);
    if (!Exit.isFailure(exit)) throw new Error("invalid constructor input accepted");
    const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (!SchemaIssue.isIssue(issue) || issue instanceof Schema.SchemaError) throw new Error("construction did not preserve SchemaIssue");
    failures.push(SchemaIssue.makeFormatterDefault()(issue));
  }
  expect(failures[0], failures[1]);
}
const nestedFailures = [];
for (const effect of [makeNested({ settings: { score: 0.5 } }), nativeNested.makeEffect({ settings: { score: 0.5 } })]) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("invalid nested constructor input accepted");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("nested issue lost");
  nestedFailures.push(SchemaIssue.makeFormatterDefault()(issue));
}
expect(nestedFailures[0], nestedFailures[1]);
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const missingWire = await Effect.runPromiseExit(readWire({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missingWire)) throw new Error("constructor factory changed wire requirements");
expect(await Effect.runPromise(readWire({ score: "8" }).pipe(Effect.provide(read))), { score: 8 });
expect(await Effect.runPromise(writeWire({ score: 8 }).pipe(Effect.provide(write))), { score: "8" });
expect(calls, ["read:8", "write:8"]);
let count = 0;
const observed = Layer.succeed(Values)({ next: () => Effect.sync(() => ++count) });
const active: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue, Values> = makeObserved();
// @ts-expect-error Active argument services stay required even though RD and RE are unused.
const missingValues: Effect.Effect<{ readonly score: number }, SchemaIssue.Issue> = active;
void missingValues;
expect(count, 0);
expect(await Effect.runPromise(active.pipe(Effect.provide(observed))), { score: 2 });
expect(count, 2);
const defective = Layer.succeed(Values)({ next: () => Effect.die("boom") });
const died = await Effect.runPromiseExit(makeObserved().pipe(Effect.provide(defective)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause)) throw new Error("argument defect converted to a constructor issue");
const decoded: typeof record.Type = { score: 8 };
const wire: typeof record.Encoded = { score: "8" };
void decoded; void wire; void nested;
// @ts-expect-error The wire field remains required and encoded as text.
const invalidWire: typeof record.Encoded = {};
void invalidWire;

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

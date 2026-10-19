import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-fields.eff", import.meta.url),
);

Deno.test("constructor defaults on field descriptors compile across imports with independent wire behavior", async () => {
  const imported =
    `import { optionalField, decodedField, D, E, M, Read, Write, Defaults } from "./main.eff"
const field: SchemaOptionalConstructorDefault<D,E,Read.parse,Write.print,M> = optionalField
export const optional: Schema<{ settings?: D },{ settings?: E },Read.parse,Write.print,{ settings?: M }> = schemaStruct({ settings: field })
export const decoded: Schema<{ settings: D },{ settings?: E },Read.parse | Defaults.next,Write.print,{ settings?: M }> = schemaStruct({ settings: decodedField })
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
  const dir = Deno.makeTempDirSync({ prefix: "effective-constructor-fields-" });
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
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, Defaults, optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, optionRecord, transformedRecord, requiredRecord, waiting, makeDecoded, readDecoded, writeEncoded } from "./main.ts";
import { optional, decoded } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const defaults = Layer.succeed(Defaults)({
  next: () => Effect.sync(() => { calls.push("wire-default"); return { score: 8 }; }),
  encoded: () => Effect.sync(() => { calls.push("encoded-default"); return { score: "9" }; }),
});
for (const schema of [optionalRecord, nullRecord, decodedRecord, nullDefaultRecord, encodedRecord, transformedRecord, requiredRecord, optional, decoded]) {
  const input: typeof schema["~type.make.in"] = {};
  const operation: Effect.Effect<unknown, SchemaIssue.Issue> = schema.makeEffect(input);
  expect(await Effect.runPromise(operation), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: {} })), { settings: { score: 4 } });
  expect(await Effect.runPromise(schema.makeEffect({ settings: { score: 7 } })), { settings: { score: 7 } });
  const invalid = await Effect.runPromiseExit(schema.makeEffect({ settings: { score: 0.5 } }));
  if (!Exit.isFailure(invalid)) throw new Error("invalid nested input accepted");
  const issue = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor issue channel lost");
  const message = SchemaIssue.makeFormatterDefault()(issue);
  if (!message.includes("settings") || !message.includes("score")) throw new Error("nested path lost");
}
expect(await Effect.runPromise(makeDecoded({})), { settings: { score: 4 } });
expect(calls, []);
expect(await Effect.runPromise(optionRecord.makeEffect({})), { settings: Option.some({ score: 6 }) });
expect(await Effect.runPromise(optionRecord.makeEffect({ settings: Option.none() })), { settings: Option.none() });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionRecord)({}).pipe(Effect.provide(read))), { settings: Option.none() });
expect(await Effect.runPromise(Schema.encodeEffect(optionRecord)({ settings: Option.none() }).pipe(Effect.provide(write))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(optionalRecord)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullRecord)({ settings: null }).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(Schema.decodeUnknownEffect(transformedRecord)({}).pipe(Effect.provide(read))), {});
expect(await Effect.runPromise(readDecoded({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullDefaultRecord)({ settings: null }).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 8 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(encodedRecord)({}).pipe(Effect.provide(read), Effect.provide(defaults))), { settings: { score: 9 } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(requiredRecord)({ settings: "10" }).pipe(Effect.provide(read))), { settings: { score: 10 } });
expect(await Effect.runPromise(writeEncoded({ settings: { score: 7 } }).pipe(Effect.provide(write))), {});
expect(calls, ["wire-default", "wire-default", "encoded-default", "read:9", "read:10", "write:7"]);
const optionalD: typeof optionalRecord.Type = {};
const optionalE: typeof optionalRecord.Encoded = {};
const optionalM: typeof decodedRecord["~type.make.in"] = {};
// @ts-expect-error The decoding-default descriptor keeps D required.
const incompleteD: typeof decodedRecord.Type = {};
// @ts-expect-error The required-encoded descriptor keeps its wire key required.
const incompleteE: typeof requiredRecord.Encoded = {};
// @ts-expect-error Option contents stay complete after adding a constructor default.
const incompleteOption: typeof optionRecord["~type.make.in"] = { settings: Option.some({}) };
void optionalD; void optionalE; void optionalM; void incompleteD; void incompleteE; void incompleteOption;
let count = 0;
const fresh = waiting(Effect.sync(() => { count++; return {}; }));
expect(count, 0);
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(await Effect.runPromise(fresh.makeEffect({})), { settings: { score: 4 } });
expect(count, 2);
const failed = await Effect.runPromiseExit(waiting(Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" }))).makeEffect({}));
if (!Exit.isFailure(failed)) throw new Error("default failure lost");
const issue = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
if (!SchemaIssue.isIssue(issue) || !SchemaIssue.makeFormatterDefault()(issue).includes("settings")) throw new Error("default path lost");
const died = await Effect.runPromiseExit(waiting(Effect.die("defect")).makeEffect({}));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause) || Option.isSome(Cause.findErrorOption(died.cause))) throw new Error("default defect translated");
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const fiber = yield* Effect.forkChild(waiting(pending).makeEffect({}));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("field default cleanup outlived interruption");
}));
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

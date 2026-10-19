// deno test --no-lock docs/plans/schema-adapter-probes/constructor-default.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

class Read extends Context.Service<Read, {
  readonly parse: (value: string) => Effect.Effect<number>;
}>()("constructor-default#Read") {}
class Write extends Context.Service<Write, {
  readonly print: (value: number) => Effect.Effect<string>;
}>()("constructor-default#Write") {}

const field = Schema.String.pipe(Schema.decodeTo(
  Schema.Int,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.parse(value)),
    encode: (value) => Write.use((service) => service.print(value)),
  }),
));
const base = Schema.Struct({ score: field });

Deno.test("constructor defaults validate D without either wire service", async () => {
  let defaults = 0;
  const native = Schema.Struct({
    score: field.pipe(
      Schema.withConstructorDefault(Effect.sync(() => ++defaults)),
    ),
  });
  const input: typeof native["~type.make.in"] = {};
  // @ts-expect-error Constructor input does not relax decoded field presence.
  const missing: typeof native.Type = {};
  void missing;
  // @ts-expect-error Constructor defaults do not make the wire field optional.
  const wireMissing: typeof native.Encoded = {};
  void wireMissing;
  const operation: Effect.Effect<
    { readonly score: number },
    SchemaIssue.Issue
  > = native.makeEffect(input);
  assertEquals(defaults, 0);
  assertEquals(await Effect.runPromise(operation), { score: 1 });
  assertEquals(await Effect.runPromise(operation), { score: 2 });
  assertEquals(await Effect.runPromise(native.makeEffect({ score: 8 })), {
    score: 8,
  });
  // @ts-expect-error Exact make input rejects undefined, though the raw runtime defaults it.
  const explicitOperation = native.makeEffect({ score: undefined });
  const explicit = await Effect.runPromise(explicitOperation);
  assertEquals(explicit, { score: 3 });
  const invalid = await Effect.runPromiseExit(
    native.makeEffect({ score: 0.5 }),
  );
  assert(Exit.isFailure(invalid));
  const issue = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  assert(SchemaIssue.isIssue(issue));
  assert(SchemaIssue.makeFormatterDefault()(issue).includes("score"));
  assertEquals(defaults, 3);
});

Deno.test("explicit default factories plus type-side construction match the native selected behavior", async () => {
  const results: unknown[][] = [];
  for (const implementation of ["native", "factory"] as const) {
    let defaults = 0;
    const next = () => ++defaults;
    const native = Schema.Struct({
      score: field.pipe(Schema.withConstructorDefault(Effect.sync(next))),
    });
    const make = implementation === "native"
      ? (input: { readonly score?: number }) => native.makeEffect(input)
      : (input: { readonly score?: number }) =>
        Effect.suspend(() =>
          base.makeEffect({
            score: input.score === undefined ? next() : input.score,
          })
        );
    const values: unknown[] = [];
    const repeated = make({});
    assertEquals(defaults, 0);
    values.push(
      structuredClone(await Effect.runPromise(repeated)),
      structuredClone(await Effect.runPromise(repeated)),
    );
    values.push(await Effect.runPromise(make({ score: 8 })));
    // @ts-expect-error Exercise the raw host boundary as well as the exact static input.
    const explicit = make({ score: undefined });
    values.push(await Effect.runPromise(explicit));
    const failed = await Effect.runPromiseExit(make({ score: 0.5 }));
    assert(Exit.isFailure(failed));
    const issue = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
    assert(SchemaIssue.isIssue(issue));
    values.push(SchemaIssue.makeFormatterDefault()(issue));
    assertEquals(defaults, 3);
    results.push(values);
  }
  assertEquals(results[0], results[1]);
});

Deno.test("constructor defaults do not run on wire decode or encode", async () => {
  let defaults = 0;
  const calls: string[] = [];
  const native = Schema.Struct({
    score: field.pipe(
      Schema.withConstructorDefault(Effect.sync(() => ++defaults)),
    ),
  });
  const read = Layer.succeed(Read)({
    parse: (value) =>
      Effect.sync(() => {
        calls.push("read:" + value);
        return Number(value);
      }),
  });
  const write = Layer.succeed(Write)({
    print: (value) =>
      Effect.sync(() => {
        calls.push("write:" + value);
        return String(value);
      }),
  });
  assert(
    Exit.isFailure(
      await Effect.runPromiseExit(
        Schema.decodeUnknownEffect(native)({}).pipe(Effect.provide(read)),
      ),
    ),
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(native)({ score: "8" }).pipe(
        Effect.provide(read),
      ),
    ),
    { score: 8 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(native)({ score: 8 }).pipe(Effect.provide(write)),
    ),
    { score: "8" },
  );
  assertEquals(calls, ["read:8", "write:8"]);
  assertEquals(defaults, 0);
});

Deno.test("constructor default failures retain issues and defects", async () => {
  const blocked = new SchemaIssue.InvalidValue({ message: "default blocked" });
  const failing = Schema.Struct({
    score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.fail(blocked))),
  });
  const failed = await Effect.runPromiseExit(failing.makeEffect({}));
  assert(Exit.isFailure(failed));
  const issue = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
  assert(SchemaIssue.isIssue(issue));
  const text = SchemaIssue.makeFormatterDefault()(issue);
  assert(text.includes("score") && text.includes("default blocked"));
  const invalid = Schema.Struct({
    score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0.5))),
  });
  const invalidExit = await Effect.runPromiseExit(invalid.makeEffect({}));
  assert(Exit.isFailure(invalidExit));
  const defective = Schema.Struct({
    score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.die("boom"))),
  });
  const died = await Effect.runPromiseExit(defective.makeEffect({}));
  assert(Exit.isFailure(died) && Cause.hasDies(died.cause));
});

Deno.test("native nested default inputs are separate from D and E", async () => {
  const nested = Schema.Struct({
    score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
  });
  const native = Schema.Struct({
    settings: nested.pipe(Schema.withConstructorDefault(Effect.succeed({}))),
  });
  const input: typeof native["~type.make.in"] = {};
  assertEquals(await Effect.runPromise(native.makeEffect(input)), {
    settings: { score: 4 },
  });
  // @ts-expect-error Nested defaults have not been applied to the decoded input.
  const decoded: typeof native.Type = { settings: {} };
  void decoded;
  const materialized = makeSettings();
  assertEquals(
    await Effect.runPromise(
      Schema.Struct({ settings: nested }).makeEffect(materialized),
    ),
    { settings: { score: 4 } },
  );
  function makeSettings() {
    return { settings: { score: 4 } };
  }
});

Deno.test("raw constructor effect replay can reuse its result object", async () => {
  let count = 0;
  const native = Schema.Struct({
    score: Schema.Int.pipe(
      Schema.withConstructorDefault(Effect.sync(() => ++count)),
    ),
  });
  const operation = native.makeEffect({});
  const first = await Effect.runPromise(operation);
  assertEquals(first.score, 1);
  const second = await Effect.runPromise(operation);
  assert(first === second);
  assertEquals(first.score, 2);
});

// deno test --no-lock docs/plans/schema-adapter-probes/constructor-fields.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "npm:effect@4.0.5";

const child = Schema.Struct({
  score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
});

Deno.test("constructor defaults coexist with every selected field adapter", async () => {
  let defaults = 0;
  const optional = Schema.optionalKey(child);
  const nullMissing = Schema.optionalKey(Schema.NullOr(child)).pipe(
    Schema.decodeTo(optional, {
      decode: SchemaGetter.transformOptional(
        Option.filter((value) => value !== null),
      ),
      encode: SchemaGetter.transformOptional((value) => value),
    }),
  );
  const nullDefault = Schema.optionalKey(Schema.NullOr(child)).pipe(
    Schema.decodeTo(Schema.toType(child), {
      decode: SchemaGetter.transformOptional((value) =>
        Option.orElseSome(
          Option.filter(value, (value) => value !== null),
          () => ({ score: 8 }),
        )
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );
  const adapted = Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(optional, {
      decode: SchemaGetter.transformOptional(Option.map(() => ({ score: 8 }))),
      encode: SchemaGetter.transformOptional(Option.map(() => "8")),
    }),
  );
  const required = Schema.String.pipe(Schema.decodeTo(optional, {
    decode: SchemaGetter.transformOptional(Option.map(() => ({ score: 8 }))),
    encode: SchemaGetter.transformOptional((value) =>
      Option.some(Option.isSome(value) ? "8" : "empty")
    ),
  }));
  for (
    const field of [
      optional,
      nullMissing,
      nullDefault,
      adapted,
      required,
      child.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed({ score: 8 })),
      ),
      child.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ score: 8 }))),
    ]
  ) {
    const decorated = field.pipe(
      Schema.withConstructorDefault(Effect.sync(() => {
        defaults++;
        return {};
      })),
    );
    const record = Schema.Struct({ settings: decorated });
    const input: typeof record["~type.make.in"] = {};
    const before = defaults;
    assertEquals(await Effect.runPromise(record.makeEffect(input)), {
      settings: { score: 4 },
    });
    assertEquals(defaults, before + 1);
    assertEquals(
      await Effect.runPromise(record.makeEffect({ settings: { score: 7 } })),
      { settings: { score: 7 } },
    );
    assertEquals(defaults, before + 1);
  }
});

Deno.test("constructor and decoding defaults stay independent with unchanged field presence", async () => {
  let constructors = 0;
  let wire = 0;
  const field = child.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => {
      wire++;
      return { score: 8 };
    })),
    Schema.withConstructorDefault(Effect.sync(() => {
      constructors++;
      return {};
    })),
  );
  const record = Schema.Struct({ settings: field });
  assertEquals(await Effect.runPromise(record.makeEffect({})), {
    settings: { score: 4 },
  });
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(record)({})),
    { settings: { score: 8 } },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({ settings: { score: 7 } }),
    ),
    { settings: { score: 7 } },
  );
  assertEquals([constructors, wire], [1, 1]);
  // @ts-expect-error A constructor default does not make the decoded field optional.
  const decoded: typeof record.Type = {};
  const encoded: typeof record.Encoded = {};
  const exact = Schema.Struct({
    settings: Schema.optionalKey(child).pipe(
      Schema.withConstructorDefault(Effect.succeed({})),
    ),
  });
  const optionalD: typeof exact.Type = {};
  const optionalE: typeof exact.Encoded = {};
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(exact)({})),
    {},
  );
  void decoded;
  void encoded;
  void optionalD;
  void optionalE;
});

Deno.test("Option constructor defaults require complete contents and None omits the wire field", async () => {
  const field = Schema.OptionFromOptionalKey(child).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.some({ score: 6 }))),
  );
  const record = Schema.Struct({ settings: field });
  assertEquals(await Effect.runPromise(record.makeEffect({})), {
    settings: Option.some({ score: 6 }),
  });
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(record)({})),
    { settings: Option.none() },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({ settings: Option.none() }),
    ),
    {},
  );
  // @ts-expect-error The Option adapter's make input is Option<D>, not Option<M>.
  Schema.OptionFromOptionalKey(child).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.some({}))),
  );
});

Deno.test("optional field default failures retain paths and interruption awaits cleanup", async () => {
  const schema = Schema.Struct({
    settings: Schema.optionalKey(child).pipe(
      Schema.withConstructorDefault(
        Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" })),
      ),
    ),
  });
  const exit = await Effect.runPromiseExit(schema.makeEffect({}));
  assert(Exit.isFailure(exit));
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(SchemaIssue.isIssue(issue));
  assert(SchemaIssue.makeFormatterDefault()(issue).includes("settings"));
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => {
        released = true;
      })),
    );
    const waiting = Schema.Struct({
      settings: Schema.optionalKey(child).pipe(
        Schema.withConstructorDefault(pending),
      ),
    });
    const fiber = yield* Effect.forkChild(waiting.makeEffect({}));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert(released);
  }));
});

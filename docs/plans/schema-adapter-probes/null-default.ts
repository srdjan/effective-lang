// deno test --no-lock docs/plans/schema-adapter-probes/null-default.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

function defaultNullKey<D, E, RD, RE, R>(
  source: Schema.Codec<D, E, RD, RE>,
  fallback: Effect.Effect<D, Schema.SchemaError, R>,
  options?: { encodingStrategy: "omit" | "passthrough" },
) {
  return Schema.optionalKey(Schema.NullOr(source)).pipe(
    Schema.decodeTo(Schema.toType(source), {
      decode: SchemaGetter.transformOptionalEffect((input) => {
        const present = Option.filter(input, (value) => value !== null);
        return Option.isSome(present) ? Effect.succeed(present) : Effect.map(
          Effect.mapError(fallback, (error) => error.issue),
          Option.some,
        );
      }),
      encode: options?.encodingStrategy === "omit"
        ? SchemaGetter.omit()
        : SchemaGetter.passthrough(),
    }),
  );
}

class Read extends Context.Service<Read, {
  readonly parse: (value: string) => Effect.Effect<number>;
}>()("null-default#Read") {}
class Write extends Context.Service<Write, {
  readonly print: (value: number) => Effect.Effect<string>;
}>()("null-default#Write") {}
class Defaults extends Context.Service<Defaults, {
  readonly make: () => Effect.Effect<number, Schema.SchemaError>;
}>()("null-default#Defaults") {}

const source = Schema.String.pipe(Schema.decodeTo(
  Schema.Number,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.parse(value)),
    encode: (value) => Write.use((service) => service.print(value)),
  }),
));
const record = Schema.Struct({
  score: defaultNullKey(
    source,
    Effect.suspend(() => Defaults.use((service) => service.make())),
  ),
});

Deno.test("missing and null use fresh decoded defaults; present and undefined skip them", async () => {
  const events: string[] = [];
  let defaults = 0;
  const services = Layer.merge(
    Layer.succeed(Read)({
      parse: (value) =>
        Effect.sync(() => {
          events.push(value);
          return Number(value);
        }),
    }),
    Layer.succeed(Defaults)({ make: () => Effect.sync(() => ++defaults) }),
  );
  const wire: typeof record.Encoded = { score: null };
  const missing: typeof record.Encoded = {};
  // @ts-expect-error The decoded field is required.
  const invalid: typeof record.Type = {};
  void invalid;
  for (const input of [missing, wire, missing, wire]) {
    const effect: Effect.Effect<
      { readonly score: number },
      Schema.SchemaError,
      Read | Defaults
    > = Schema.decodeUnknownEffect(record)(input);
    assertEquals(
      await Effect.runPromise(effect.pipe(Effect.provide(services))),
      { score: defaults },
    );
  }
  assertEquals(defaults, 4);
  assertEquals(events, []);
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)({ score: "42" }).pipe(
        Effect.provide(services),
      ),
    ),
    { score: 42 },
  );
  for (const input of [{ score: undefined }, { score: false }]) {
    assert(
      Exit.isFailure(
        await Effect.runPromiseExit(
          Schema.decodeUnknownEffect(record)(input).pipe(
            Effect.provide(services),
          ),
        ),
      ),
    );
  }
  assertEquals(defaults, 4);
  assertEquals(events, ["42"]);
});

Deno.test("encoding restores E or omits every value and retains only encoder services", async () => {
  const calls: number[] = [];
  const write = Layer.succeed(Write)({
    print: (value) =>
      Effect.sync(() => {
        calls.push(value);
        return String(value);
      }),
  });
  const omitted = Schema.Struct({
    score: defaultNullKey(source, Effect.succeed(0), {
      encodingStrategy: "omit",
    }),
  });
  for (const score of [0, 42]) {
    const encoded: Effect.Effect<
      { readonly score?: string | null },
      Schema.SchemaError,
      Write
    > = Schema.encodeEffect(record)({ score });
    assertEquals(await Effect.runPromise(encoded.pipe(Effect.provide(write))), {
      score: String(score),
    });
    const omit: Effect.Effect<
      { readonly score?: string | null },
      Schema.SchemaError,
      Write
    > = Schema.encodeEffect(omitted)({ score });
    // @ts-expect-error Omit conservatively retains the encoder requirement.
    const noWrite: Effect.Effect<
      { readonly score?: string | null },
      Schema.SchemaError
    > = omit;
    void noWrite;
    assertEquals(await Effect.runPromise(omit.pipe(Effect.provide(write))), {});
  }
  assertEquals(calls, [0, 42]);
  for (const score of [null, undefined, "42"]) {
    assert(
      Exit.isFailure(
        await Effect.runPromiseExit(
          Schema.encodeUnknownEffect(omitted)({ score }).pipe(
            Effect.provide(write),
          ),
        ),
      ),
    );
  }
});

Deno.test("default SchemaErrors retain the field path and defects keep their channel", async () => {
  const issue = new SchemaIssue.InvalidValue({ message: "default blocked" });
  for (const input of [{}, { score: null }]) {
    const failed = Layer.succeed(Defaults)({
      make: () => Effect.fail(new Schema.SchemaError(issue)),
    });
    const exit = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(record)(input).pipe(
        Effect.provide(failed),
        Effect.provide(Layer.succeed(Read)({ parse: () => Effect.succeed(0) })),
      ),
    );
    assert(Exit.isFailure(exit));
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(
      error instanceof Schema.SchemaError && error.message.includes("score") &&
        error.message.includes("default blocked"),
    );
    const defective = Layer.succeed(Defaults)({
      make: () => Effect.die("boom"),
    });
    const died = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(record)(input).pipe(
        Effect.provide(defective),
        Effect.provide(Layer.succeed(Read)({ parse: () => Effect.succeed(0) })),
      ),
    );
    assert(Exit.isFailure(died) && Cause.hasDies(died.cause));
  }
});

Deno.test("interrupting a null default awaits its finalizer", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Schema.Struct({
      score: defaultNullKey(
        Schema.Number,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Effect.sync(() => {
          released = true;
        }))),
      ),
    });
    const fiber = yield* Effect.forkChild(
      Schema.decodeUnknownEffect(pending)({ score: null }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert(released);
  }));
});

Deno.test("present unit results preserve presence and skip the default", async () => {
  let defaults = 0;
  const erased = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Void,
      SchemaTransformation.transform({
        decode: (): void => undefined,
        encode: (_value: void) => "present",
      }),
    ),
  );
  const decoded = Schema.Struct({
    value: defaultNullKey(
      erased,
      Effect.sync(() => {
        defaults++;
      }),
    ),
  });
  const present = await Effect.runPromise(
    Schema.decodeUnknownEffect(decoded)({ value: "present" }),
  );
  assert(Object.hasOwn(present, "value") && present.value === undefined);
  assertEquals(defaults, 0);
  const wireUnit = Schema.Struct({
    value: defaultNullKey(
      Schema.Void,
      Effect.sync(() => {
        defaults++;
      }),
    ),
  });
  const explicitUnit = await Effect.runPromise(
    Schema.decodeUnknownEffect(wireUnit)({ value: undefined }),
  );
  assert(Object.hasOwn(explicitUnit, "value"));
  assertEquals(defaults, 0);
  for (const input of [{}, { value: null }]) {
    await Effect.runPromise(Schema.decodeUnknownEffect(decoded)(input));
  }
  assertEquals(defaults, 2);
});

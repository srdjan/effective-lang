// deno test --no-lock docs/plans/schema-adapter-probes/nullable-optional.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "npm:effect@4.0.5";

class Read extends Context.Service<Read, {
  readonly normalize: (value: string) => Effect.Effect<string>;
}>()("nullable-optional#Read") {}
class Write extends Context.Service<Write, {
  readonly restore: (value: string) => Effect.Effect<string>;
}>()("nullable-optional#Write") {}

const text = Schema.String.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.normalize(value)),
    encode: (value) => Write.use((service) => service.restore(value)),
  }),
));
const nullable = Schema.Union([text, Schema.Null]);
const exact = Schema.Struct({ name: Schema.optionalKey(nullable) });

Deno.test("an explicit null-to-missing field collapses null and preserves directional services", async () => {
  const record = Schema.Struct({
    name: Schema.optionalKey(Schema.NullOr(text)).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.toType(text)), {
        decode: SchemaGetter.transformOptional(
          Option.filter((value) => value !== null),
        ),
        encode: SchemaGetter.transformOptional((value) => value),
      }),
    ),
  });
  const events: string[] = [];
  const read = Layer.succeed(Read)({
    normalize: (value) =>
      Effect.sync(() => {
        events.push("read");
        return value;
      }),
  });
  const write = Layer.succeed(Write)({
    restore: (value) =>
      Effect.sync(() => {
        events.push("write");
        return value;
      }),
  });
  const wire: typeof record.Encoded = { name: null };
  // @ts-expect-error The decoded optional field excludes null.
  const decoded: typeof record.Type = { name: null };
  void decoded;
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)(wire).pipe(Effect.provide(read)),
    ),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)({}).pipe(Effect.provide(read)),
    ),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)({ name: "Ada" }).pipe(
        Effect.provide(read),
      ),
    ),
    { name: "Ada" },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({}).pipe(Effect.provide(write)),
    ),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({ name: "Ada" }).pipe(Effect.provide(write)),
    ),
    { name: "Ada" },
  );
  assertEquals(events, ["read", "write"]);
  const invalid = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(record)({ name: undefined }).pipe(
      Effect.provide(read),
    ),
  );
  assert(Exit.isFailure(invalid));
});

Deno.test("nullable exact optional keys distinguish missing, null, and text", async () => {
  const events: string[] = [];
  const read = Layer.succeed(Read)({
    normalize: (value) =>
      Effect.sync(() => {
        events.push("read:" + value);
        return value.toUpperCase();
      }),
  });
  const write = Layer.succeed(Write)({
    restore: (value) =>
      Effect.sync(() => {
        events.push("write:" + value);
        return value.toLowerCase();
      }),
  });
  const wire: typeof exact.Encoded = { name: null };
  assertEquals(wire, { name: null });
  // @ts-expect-error Exact optional keys exclude explicit undefined.
  const invalid: typeof exact.Encoded = { name: undefined };
  void invalid;
  for (const input of [{}, { name: null }, { name: "Ada" }]) {
    const decoded: Effect.Effect<
      { readonly name?: string | null },
      Schema.SchemaError,
      Read
    > = Schema.decodeUnknownEffect(exact)(input);
    const expected = "name" in input && input.name !== null
      ? { name: "ADA" }
      : input;
    assertEquals(
      await Effect.runPromise(decoded.pipe(Effect.provide(read))),
      expected,
    );
  }
  for (const input of [{}, { name: null }, { name: "ADA" }]) {
    assertEquals(
      await Effect.runPromise(
        Schema.encodeEffect(exact)(input).pipe(Effect.provide(write)),
      ),
      "name" in input && input.name !== null ? { name: "ada" } : input,
    );
  }
  assertEquals(events, ["read:Ada", "write:ADA"]);
  const exit = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(exact)({ name: undefined }).pipe(
      Effect.provide(read),
    ),
  );
  assert(Exit.isFailure(exit));
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("name"));
  assertEquals(events, ["read:Ada", "write:ADA"]);
});

Deno.test("Option-from-optional-key retains Some(null) separately from None", async () => {
  const option = Schema.Struct({
    name: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.String)),
  });
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(option)({})),
    { name: Option.none() },
  );
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(option)({ name: null })),
    { name: Option.some(null) },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(option)({ name: Option.none() }),
    ),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(option)({ name: Option.some(null) }),
    ),
    { name: null },
  );
});

Deno.test("a nullable missing-key default runs only for an absent key", async () => {
  let calls = 0;
  const defaulted = Schema.Struct({
    name: Schema.NullOr(Schema.String).pipe(
      Schema.withDecodingDefaultTypeKey(Effect.sync(() => {
        calls++;
        return null;
      })),
    ),
  });
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(defaulted)({})),
    { name: null },
  );
  assertEquals(calls, 1);
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(defaulted)({ name: null }),
    ),
    { name: null },
  );
  assertEquals(calls, 1);
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(defaulted)({ name: null })),
    { name: null },
  );
});

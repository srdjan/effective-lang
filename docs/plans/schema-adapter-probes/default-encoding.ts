// deno test --no-lock docs/plans/schema-adapter-probes/default-encoding.ts
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
  readonly normalize: (value: string) => Effect.Effect<string>;
}>()("default-encoding#Read") {}
class Write extends Context.Service<Write, {
  readonly restore: (value: string) => Effect.Effect<string, SchemaIssue.Issue>;
}>()("default-encoding#Write") {}
class Defaults extends Context.Service<Defaults, {
  readonly make: () => Effect.Effect<string>;
}>()("default-encoding#Defaults") {}

const text = Schema.String.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.normalize(value)),
    encode: (value) => Write.use((service) => service.restore(value)),
  }),
));
const defaultValue = Effect.suspend(() =>
  Defaults.use((service) => service.make())
);
const omit = Schema.Struct({
  name: text.pipe(
    Schema.withDecodingDefaultTypeKey(defaultValue, {
      encodingStrategy: "omit",
    }),
  ),
});
const passthrough = Schema.Struct({
  name: text.pipe(
    Schema.withDecodingDefaultTypeKey(defaultValue, {
      encodingStrategy: "passthrough",
    }),
  ),
});

Deno.test("omit drops every encoded field value and skips its encoder while retaining static services", async () => {
  const calls: string[] = [];
  const write = Layer.succeed(Write)({
    restore: (value) =>
      Effect.sync(() => {
        calls.push(value);
        return value.toLowerCase();
      }),
  });
  for (const name of ["DEFAULT", "OTHER"]) {
    const effect: Effect.Effect<
      { readonly name?: string },
      Schema.SchemaError,
      Write
    > = Schema.encodeEffect(omit)({ name });
    // @ts-expect-error Omission retains the wrapped encoder requirement.
    const missingService: Effect.Effect<
      { readonly name?: string },
      Schema.SchemaError
    > = effect;
    void missingService;
    assertEquals(
      await Effect.runPromise(effect.pipe(Effect.provide(write))),
      {},
    );
    assertEquals(
      await Effect.runPromise(
        Schema.encodeEffect(passthrough)({ name }).pipe(Effect.provide(write)),
      ),
      { name: name.toLowerCase() },
    );
  }
  assertEquals(calls, ["DEFAULT", "OTHER"]);
});

Deno.test("both encoding strategies retain the same missing-key decoding rule", async () => {
  let defaults = 0;
  const calls: string[] = [];
  const read = Layer.succeed(Read)({
    normalize: (value) =>
      Effect.sync(() => {
        calls.push(value);
        return value.toUpperCase();
      }),
  });
  const fallback = Layer.succeed(Defaults)({
    make: () => Effect.sync(() => "DEFAULT" + (++defaults)),
  });
  const services = Layer.merge(read, fallback);
  for (const schema of [omit, passthrough]) {
    const effect: Effect.Effect<
      { readonly name: string },
      Schema.SchemaError,
      Read | Defaults
    > = Schema.decodeUnknownEffect(schema)({});
    assertEquals(
      await Effect.runPromise(effect.pipe(Effect.provide(services))),
      { name: "DEFAULT" + defaults },
    );
    assertEquals(
      await Effect.runPromise(
        Schema.decodeUnknownEffect(schema)({ name: "Ada" }).pipe(
          Effect.provide(services),
        ),
      ),
      { name: "ADA" },
    );
    const invalid = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(schema)({ name: undefined }).pipe(
        Effect.provide(services),
      ),
    );
    assert(Exit.isFailure(invalid));
  }
  assertEquals(defaults, 2);
  assertEquals(calls, ["Ada", "Ada"]);
});

Deno.test("omission validates present decoded values and skips encoder failures and defects", async () => {
  const write = Layer.succeed(Write)({
    restore: () =>
      Effect.fail(new SchemaIssue.InvalidValue({ message: "encoder blocked" })),
  });
  for (const input of [{ name: 3 }, { name: undefined }]) {
    const exit = await Effect.runPromiseExit(
      Schema.encodeUnknownEffect(omit)(input).pipe(Effect.provide(write)),
    );
    assert(
      Exit.isFailure(exit),
      JSON.stringify({ input, keys: Object.keys(input) }),
    );
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(error instanceof Schema.SchemaError);
    assert(error.message.includes("name"));
  }
  assertEquals(
    await Effect.runPromise(
      Schema.encodeUnknownEffect(omit)({}).pipe(Effect.provide(write)),
    ),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(omit)({ name: "Ada" }).pipe(Effect.provide(write)),
    ),
    {},
  );
  const blocked = await Effect.runPromiseExit(
    Schema.encodeEffect(passthrough)({ name: "Ada" }).pipe(
      Effect.provide(write),
    ),
  );
  assert(Exit.isFailure(blocked));
  const error = Option.getOrUndefined(Cause.findErrorOption(blocked.cause));
  assert(
    error instanceof Schema.SchemaError &&
      error.message.includes("encoder blocked"),
  );
  const defective = Layer.succeed(Write)({ restore: () => Effect.die("boom") });
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(omit)({ name: "Ada" }).pipe(
        Effect.provide(defective),
      ),
    ),
    {},
  );
  const exit = await Effect.runPromiseExit(
    Schema.encodeEffect(passthrough)({ name: "Ada" }).pipe(
      Effect.provide(defective),
    ),
  );
  assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
});

Deno.test("omission also removes nullable values while the decoded default stays required", async () => {
  const record = Schema.Struct({
    name: Schema.NullOr(Schema.String).pipe(
      Schema.withDecodingDefaultTypeKey(Effect.succeed(null), {
        encodingStrategy: "omit",
      }),
    ),
  });
  const missing: typeof record.Encoded = {};
  // @ts-expect-error A defaulted decoded field remains required.
  const invalid: typeof record.Type = {};
  void invalid;
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(record)(missing)),
    { name: null },
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(record)({ name: null })),
    {},
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(record)({ name: "Ada" })),
    {},
  );
});

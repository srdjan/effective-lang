// deno test --no-lock docs/plans/schema-adapter-probes/optional-transform-defaults.ts
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
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(input));
const encode = <A, I>(schema: Schema.Codec<A, I>, input: A) =>
  Effect.runPromise(Schema.encodeEffect(schema)(input));

Deno.test("OptionFromOptionalKey maps only absence to None and omits None on encode", async () => {
  const profile = Schema.Struct({
    score: Schema.OptionFromOptionalKey(Schema.FiniteFromString),
  });
  const missing: typeof profile.Encoded = {};
  const required: typeof profile.Type = { score: Option.none() };
  // @ts-expect-error The decoded Option field is required.
  const missingDecoded: typeof profile.Type = {};
  // @ts-expect-error The exact optional encoded key excludes undefined.
  const undefinedEncoded: typeof profile.Encoded = { score: undefined };
  void [missing, required, missingDecoded, undefinedEncoded];
  assertEquals(await decode(profile, {}), { score: Option.none() });
  assertEquals(await decode(profile, { score: "2" }), {
    score: Option.some(2),
  });
  assertEquals(await encode(profile, { score: Option.none() }), {});
  assertEquals(await encode(profile, { score: Option.some(2) }), {
    score: "2",
  });
  const exit = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(profile)({ score: undefined }),
  );
  assert(Exit.isFailure(exit));
  assert(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof
      Schema.SchemaError,
  );
});

Deno.test("OptionFromOptionalKey preserves directional field services and skips them for None", async () => {
  class Read extends Context.Service<Read, {
    readonly next: (value: number) => Effect.Effect<number, SchemaIssue.Issue>;
  }>()("optional-transform-defaults#Read") {}
  class Write extends Context.Service<Write, {
    readonly previous: (
      value: number,
    ) => Effect.Effect<number, SchemaIssue.Issue>;
  }>()("optional-transform-defaults#Write") {}
  const calls: string[] = [];
  const shifted: Schema.Codec<number, number, Read, Write> = Schema.Finite.pipe(
    Schema.decodeTo(
      Schema.Finite,
      SchemaTransformation.transformEffect({
        decode: (value) => Read.use((service) => service.next(value)),
        encode: (value) => Write.use((service) => service.previous(value)),
      }),
    ),
  );
  const record = Schema.Struct({
    score: Schema.OptionFromOptionalKey(shifted),
  });
  const read = Layer.succeed(Read)({
    next: (value) =>
      Effect.sync(() => (calls.push(`read:${value}`), value + 1)),
  });
  const write = Layer.succeed(Write)({
    previous: (value) =>
      Effect.sync(() => (calls.push(`write:${value}`), value - 1)),
  });
  const decoded: Effect.Effect<
    { readonly score: Option.Option<number> },
    Schema.SchemaError,
    Read
  > = Schema.decodeUnknownEffect(record)({ score: 1 });
  const encoded: Effect.Effect<
    { readonly score?: number },
    Schema.SchemaError,
    Write
  > = Schema.encodeEffect(record)({ score: Option.some(2) });
  assertEquals(calls, []);
  assertEquals(
    await Effect.runPromise(decoded.pipe(Effect.provide(read))),
    { score: Option.some(2) },
  );
  assertEquals(
    await Effect.runPromise(encoded.pipe(Effect.provide(write))),
    { score: 1 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)({}).pipe(Effect.provide(read)),
    ),
    { score: Option.none() },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({ score: Option.none() }).pipe(
        Effect.provide(write),
      ),
    ),
    {},
  );
  assertEquals(calls, ["read:1", "write:2"]);
});

Deno.test("exact missing-key default runs per decode, skips present values, and encodes both policies", async () => {
  let defaults = 0;
  const field = Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultTypeKey(
      Effect.sync(() => ++defaults),
    ),
  );
  const passthrough = Schema.Struct({ score: field });
  const missing: typeof passthrough.Encoded = {};
  const required: typeof passthrough.Type = { score: 1 };
  // @ts-expect-error A decoded defaulted field is required.
  const missingDecoded: typeof passthrough.Type = {};
  void [missing, required, missingDecoded];
  assertEquals(defaults, 0);
  assertEquals(await decode(passthrough, { score: "7" }), { score: 7 });
  assertEquals(defaults, 0);
  assertEquals(await decode(passthrough, {}), { score: 1 });
  assertEquals(await decode(passthrough, {}), { score: 2 });
  assertEquals(await encode(passthrough, { score: 7 }), { score: "7" });
  assertEquals(defaults, 2);

  const omit = Schema.Struct({
    score: Schema.FiniteFromString.pipe(
      Schema.withDecodingDefaultTypeKey(Effect.succeed(1), {
        encodingStrategy: "omit",
      }),
    ),
  });
  assertEquals(await encode(omit, { score: 7 }), {});
  const invalid = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(passthrough)({ score: undefined }),
  );
  assert(Exit.isFailure(invalid));
  assert(
    Option.getOrUndefined(Cause.findErrorOption(invalid.cause)) instanceof
      Schema.SchemaError,
  );
  assertEquals(defaults, 2);
});

Deno.test("optional-to-optional getter can omit a present value in one direction", async () => {
  const record = Schema.Struct({
    name: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: SchemaGetter.transformOptional(
          Option.filter((name) => name !== ""),
        ),
        encode: SchemaGetter.transformOptional((name) => name),
      }),
    ),
  });
  assertEquals(await decode(record, {}), {});
  assertEquals(await decode(record, { name: "" }), {});
  assertEquals(await decode(record, { name: "Ada" }), { name: "Ada" });
  assertEquals(await encode(record, {}), {});
  assertEquals(await encode(record, { name: "" }), { name: "" });
  const invalid = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(record)({ name: undefined }),
  );
  assert(Exit.isFailure(invalid));
});

Deno.test("optional-to-required getter chooses whether its default is omitted on encode", async () => {
  const record = Schema.Struct({
    name: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.NullOr(Schema.String), {
        decode: SchemaGetter.transformOptional(
          Option.orElseSome(() => null),
        ),
        encode: SchemaGetter.transformOptional(
          Option.filter((name) => name !== null),
        ),
      }),
    ),
  });
  assertEquals(await decode(record, {}), { name: null });
  assertEquals(await decode(record, { name: "Ada" }), { name: "Ada" });
  assertEquals(await encode(record, { name: null }), {});
  assertEquals(await encode(record, { name: "Ada" }), { name: "Ada" });
});

Deno.test("optional-to-required getter fails if its callback still omits the required key", async () => {
  const record = Schema.Struct({
    name: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformOptional(() => Option.none()),
        encode: SchemaGetter.transformOptional((name) => name),
      }),
    ),
  });
  const exit = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(record)({}),
  );
  assert(Exit.isFailure(exit));
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("name"));
});

Deno.test("required-to-optional getter accepts missing input despite its required encoded type", async () => {
  const record = Schema.Struct({
    name: Schema.String.pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: SchemaGetter.transformOptional(
          Option.filter((name) => name !== ""),
        ),
        encode: SchemaGetter.transformOptional(
          Option.orElseSome(() => ""),
        ),
      }),
    ),
  });
  // @ts-expect-error The inferred Encoded type requires name.
  const absent: typeof record.Encoded = {};
  void absent;
  assertEquals(await decode(record, { name: "" }), {});
  assertEquals(await decode(record, { name: "Ada" }), { name: "Ada" });
  assertEquals(await encode(record, {}), { name: "" });
  assertEquals(await encode(record, { name: "Ada" }), { name: "Ada" });
  assertEquals(await decode(record, {}), {});
});

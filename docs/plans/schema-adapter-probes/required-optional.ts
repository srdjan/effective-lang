// deno test --no-lock docs/plans/schema-adapter-probes/required-optional.ts
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
} from "npm:effect@4.0.5";

const rawField = Schema.String.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.transformOptional(
      Option.filter((name) => name !== ""),
    ),
    encode: SchemaGetter.transformOptional(
      Option.orElseSome(() => ""),
    ),
  }),
);
const raw = Schema.Struct({ name: rawField });

Deno.test("the target's required-to-optional getter accepts an absent encoded key", async () => {
  const encoded: typeof raw.Encoded = { name: "Ada" };
  assertEquals(encoded, { name: "Ada" });
  // @ts-expect-error The inferred encoded type requires name.
  const absent: typeof raw.Encoded = {};
  void absent;
  assertEquals(await Effect.runPromise(Schema.decodeUnknownEffect(raw)({})), {});
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(raw)({})),
    { name: "" },
  );
});

const requiredField = Schema.String.pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.transformOptionalEffect((value) =>
      Option.isNone(value)
        ? Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "required encoded name is missing",
          }),
        )
        : Effect.succeed(value.value === "" ? Option.none() : value)
    ),
    encode: SchemaGetter.transformOptional((value) =>
      Option.some(Option.getOrElse(value, () => ""))
    ),
  }),
);
const required = Schema.Struct({ name: requiredField });

Deno.test("a guarded getter restores the required encoded contract", async () => {
  const encoded: typeof required.Encoded = { name: "Ada" };
  assertEquals(encoded, { name: "Ada" });
  // @ts-expect-error The encoded field is required.
  const absent: typeof required.Encoded = {};
  void absent;
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(required)({ name: "" })),
    {},
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(required)({ name: "Ada" }),
    ),
    { name: "Ada" },
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(required)({})),
    { name: "" },
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(required)({ name: "Ada" })),
    { name: "Ada" },
  );
  for (const input of [{}, { name: undefined }]) {
    const exit = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(required)(input),
    );
    assert(Exit.isFailure(exit));
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(error instanceof Schema.SchemaError);
    assert(error.message.includes("name"));
  }
});

class Read extends Context.Service<Read, {
  readonly normalize: (value: string) => Effect.Effect<Option.Option<string>>;
}>()("required-optional#Read") {}
class Write extends Context.Service<Write, {
  readonly restore: (value: Option.Option<string>) => Effect.Effect<string>;
}>()("required-optional#Write") {}

const effectful = Schema.Struct({
  name: Schema.String.pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.String), {
      decode: SchemaGetter.transformOptionalEffect((value) =>
        Option.isNone(value)
          ? Effect.fail(
            new SchemaIssue.InvalidValue({ message: "name is required" }),
          )
          : Read.use((service) => service.normalize(value.value))
      ),
      encode: SchemaGetter.transformOptionalEffect((value) =>
        Write.use((service) =>
          Effect.map(service.restore(value), Option.some)
        )
      ),
    }),
  ),
});

Deno.test("guarded callbacks keep decode and encode services separate", async () => {
  const read = Layer.succeed(Read)({
    normalize: (value) =>
      Effect.succeed(value === "" ? Option.none() : Option.some(value)),
  });
  const write = Layer.succeed(Write)({
    restore: (value) =>
      Effect.succeed(Option.getOrElse(value, () => "")),
  });
  const decoded: Effect.Effect<
    { readonly name?: string },
    Schema.SchemaError,
    Read
  > = Schema.decodeUnknownEffect(effectful)({ name: "" });
  const encoded: Effect.Effect<
    { readonly name: string },
    Schema.SchemaError,
    Write
  > = Schema.encodeEffect(effectful)({});
  assertEquals(await Effect.runPromise(decoded.pipe(Effect.provide(read))), {});
  assertEquals(
    await Effect.runPromise(encoded.pipe(Effect.provide(write))),
    { name: "" },
  );
});

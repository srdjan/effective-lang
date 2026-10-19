// deno test --no-lock docs/plans/schema-adapter-probes/general-union.ts
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

const primitives = Schema.Union([Schema.String, Schema.Finite]);

Deno.test("general union decodes and encodes unlike primitive branches", async () => {
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(primitives)("Ada")),
    "Ada",
  );
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(primitives)(3)),
    3,
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(primitives)("Ada")),
    "Ada",
  );
  assertEquals(await Effect.runPromise(Schema.encodeEffect(primitives)(3)), 3);
  const exit = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(primitives)(true),
  );
  assert(Exit.isFailure(exit));
  assert(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof
      Schema.SchemaError,
  );
});

Deno.test("overlapping record branches use the first successful member", async () => {
  const short = Schema.Struct({ name: Schema.String });
  const long = Schema.Struct({ name: Schema.String, score: Schema.Finite });
  const input = { name: "Ada", score: 3 };
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Union([short, long]))(input),
    ),
    { name: "Ada" },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Union([long, short]))(input),
    ),
    input,
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(Schema.Union([short, long]))(input),
    ),
    { name: "Ada" },
  );
});

class Read extends Context.Service<Read, {
  readonly tryFirst: (
    value: string,
  ) => Effect.Effect<string, SchemaIssue.Issue>;
}>()("general-union#Read") {}
class Write extends Context.Service<Write, {
  readonly tryFirst: (
    value: string,
  ) => Effect.Effect<string, SchemaIssue.Issue>;
}>()("general-union#Write") {}

const first = Schema.String.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transformEffect({
    decode: (value) => Read.use((service) => service.tryFirst(value)),
    encode: (value) => Write.use((service) => service.tryFirst(value)),
  }),
));
const second = Schema.String;
const fallback = Schema.Union([first, second]);

Deno.test("a typed issue in an untagged first member can try a later member", async () => {
  const calls: string[] = [];
  const read = Layer.succeed(Read)({
    tryFirst: (value) =>
      Effect.sync(() => calls.push(value)).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new SchemaIssue.InvalidValue({ message: "first rejected" }),
          )
        ),
      ),
  });
  const effect: Effect.Effect<string, Schema.SchemaError, Read> = Schema
    .decodeUnknownEffect(fallback)("Ada");
  assertEquals(
    await Effect.runPromise(effect.pipe(Effect.provide(read))),
    "Ada",
  );
  assertEquals(calls, ["Ada"]);
});

Deno.test("encoding also retries a later member after a typed issue", async () => {
  const calls: string[] = [];
  const write = Layer.succeed(Write)({
    tryFirst: (value) =>
      Effect.sync(() => calls.push(value)).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new SchemaIssue.InvalidValue({ message: "first encode rejected" }),
          )
        ),
      ),
  });
  const effect: Effect.Effect<string, Schema.SchemaError, Write> = Schema
    .encodeEffect(fallback)("Ada");
  assertEquals(
    await Effect.runPromise(effect.pipe(Effect.provide(write))),
    "Ada",
  );
  assertEquals(calls, ["Ada"]);
});

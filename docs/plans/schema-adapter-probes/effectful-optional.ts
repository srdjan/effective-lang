// deno test --no-lock docs/plans/schema-adapter-probes/effectful-optional.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "npm:effect@4.0.5";

class Read extends Context.Service<Read, {
  readonly transform: (
    value: Option.Option<number>,
  ) => Effect.Effect<Option.Option<number>, SchemaIssue.Issue>;
}>()("effectful-optional#Read") {}
class Write extends Context.Service<Write, {
  readonly transform: (
    value: Option.Option<number>,
  ) => Effect.Effect<Option.Option<number>, SchemaIssue.Issue>;
}>()("effectful-optional#Write") {}
class Missing extends Context.Service<Missing, {
  readonly value: () => Effect.Effect<number, Schema.SchemaError>;
}>()("effectful-optional#Missing") {}

const field = Schema.optionalKey(Schema.Finite).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Finite), {
    decode: SchemaGetter.transformOptionalEffect((value) =>
      Read.use((service) => service.transform(value))
    ),
    encode: SchemaGetter.transformOptionalEffect((value) =>
      Write.use((service) => service.transform(value))
    ),
  }),
);
const record = Schema.Struct({ score: field });
const calls: string[] = [];
const read = Layer.succeed(Read)({
  transform: (value) =>
    Effect.sync(() => {
      calls.push(Option.isSome(value) ? `read:${value.value}` : "read:none");
      return Option.isSome(value)
        ? Option.some(value.value + 1)
        : Option.some(7);
    }),
});
const write = Layer.succeed(Write)({
  transform: (value) =>
    Effect.sync(() => {
      calls.push(Option.isSome(value) ? `write:${value.value}` : "write:none");
      return Option.isSome(value)
        ? Option.some(value.value - 1)
        : Option.some(0);
    }),
});

Deno.test("effectful optional getters run on absent and present keys with separate services", async () => {
  const decoded: Effect.Effect<
    { readonly score?: number },
    Schema.SchemaError,
    Read
  > = Schema.decodeUnknownEffect(record)({});
  const encoded: Effect.Effect<
    { readonly score?: number },
    Schema.SchemaError,
    Write
  > = Schema.encodeEffect(record)({});
  calls.length = 0;
  assertEquals(calls, []);
  assertEquals(
    await Effect.runPromise(decoded.pipe(Effect.provide(read))),
    { score: 7 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(record)({ score: 2 }).pipe(
        Effect.provide(read),
      ),
    ),
    { score: 3 },
  );
  assertEquals(
    await Effect.runPromise(encoded.pipe(Effect.provide(write))),
    { score: 0 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(record)({ score: 3 }).pipe(Effect.provide(write)),
    ),
    { score: 2 },
  );
  assertEquals(calls, ["read:none", "read:2", "write:none", "write:3"]);
});

Deno.test("optional getter issues become SchemaError and retain their field path", async () => {
  const blockedRead = Layer.succeed(Read)({
    transform: () =>
      Effect.fail(new SchemaIssue.InvalidValue({ message: "decode blocked" })),
  });
  const blockedWrite = Layer.succeed(Write)({
    transform: () =>
      Effect.fail(new SchemaIssue.InvalidValue({ message: "encode blocked" })),
  });
  for (
    const [effect, message] of [
      [
        Schema.decodeUnknownEffect(record)({}).pipe(
          Effect.provide(blockedRead),
        ),
        "decode blocked",
      ],
      [
        Schema.encodeEffect(record)({}).pipe(Effect.provide(blockedWrite)),
        "encode blocked",
      ],
    ] as const
  ) {
    const exit = await Effect.runPromiseExit(effect);
    assert(Exit.isFailure(exit));
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(error instanceof Schema.SchemaError);
    assert(error.message.includes(message));
    assert(error.message.includes("score"));
  }
});

Deno.test("optional getter defects and interruption retain their cause", async () => {
  const defective = Layer.succeed(Read)({
    transform: () => Effect.die("boom"),
  });
  const died = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(record)({}).pipe(Effect.provide(defective)),
  );
  assert(Exit.isFailure(died));
  assert(Cause.hasDies(died.cause));

  const blocked = Layer.succeed(Read)({ transform: () => Effect.never });
  const fiber = Effect.runFork(
    Schema.decodeUnknownEffect(record)({}).pipe(Effect.provide(blocked)),
  );
  await Effect.runPromise(Fiber.interrupt(fiber));
  const interrupted = await Effect.runPromise(Fiber.await(fiber));
  assert(Exit.isFailure(interrupted));
  assert(Cause.hasInterrupts(interrupted.cause));
});

Deno.test("effectful default runs only on missing keys and adds only decode service", async () => {
  let count = 0;
  const defaulted = Schema.Struct({
    score: Schema.Finite.pipe(
      Schema.withDecodingDefaultTypeKey(
        Missing.use((service) => service.value()),
      ),
    ),
  });
  const layer = Layer.succeed(Missing)({
    value: () => Effect.sync(() => ++count),
  });
  const decoded: Effect.Effect<
    { readonly score: number },
    Schema.SchemaError,
    Missing
  > = Schema.decodeUnknownEffect(defaulted)({});
  const encoded: Effect.Effect<
    { readonly score?: number },
    Schema.SchemaError
  > = Schema.encodeEffect(defaulted)({ score: 9 });
  assertEquals(count, 0);
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(defaulted)({ score: 9 }).pipe(
        Effect.provide(layer),
      ),
    ),
    { score: 9 },
  );
  assertEquals(count, 0);
  assertEquals(
    await Effect.runPromise(decoded.pipe(Effect.provide(layer))),
    { score: 1 },
  );
  assertEquals(
    await Effect.runPromise(decoded.pipe(Effect.provide(layer))),
    { score: 2 },
  );
  assertEquals(await Effect.runPromise(encoded), { score: 9 });
  assertEquals(count, 2);
});

Deno.test("an authored default SchemaError keeps its issue; a defect remains a defect", async () => {
  const defaulted = Schema.Struct({
    score: Schema.Finite.pipe(
      Schema.withDecodingDefaultTypeKey(
        Missing.use((service) => service.value()),
      ),
    ),
  });
  const failed = Layer.succeed(Missing)({
    value: () =>
      Effect.fail(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: "no default" }),
        ),
      ),
  });
  const exit = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(defaulted)({}).pipe(Effect.provide(failed)),
  );
  assert(Exit.isFailure(exit));
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("no default"));
  const defect = Layer.succeed(Missing)({ value: () => Effect.die("boom") });
  const died = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(defaulted)({}).pipe(Effect.provide(defect)),
  );
  assert(Exit.isFailure(died));
  assert(Cause.hasDies(died.cause));
});

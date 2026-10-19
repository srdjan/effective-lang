// deno test --no-lock docs/plans/schema-adapter-probes/optional-union-issues.ts
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
  readonly next: (value: number) => Effect.Effect<number, SchemaIssue.Issue>;
}>()("schema-optional-union#Read") {}
class Write extends Context.Service<Write, {
  readonly previous: (
    value: number,
  ) => Effect.Effect<number, SchemaIssue.Issue>;
}>()("schema-optional-union#Write") {}

const shifted: Schema.Codec<number, number, Read, Write> = Schema.Finite.pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transformEffect({
      decode: (value) => Read.use((service) => service.next(value)),
      encode: (value) => Write.use((service) => service.previous(value)),
    }),
  ),
);

const optional = Schema.Struct({ value: Schema.optionalKey(shifted) });
const events: string[] = [];
const read = Layer.succeed(Read)({
  next: (value) => Effect.sync(() => (events.push(`read:${value}`), value + 1)),
});
const write = Layer.succeed(Write)({
  previous: (value) =>
    Effect.sync(() => (events.push(`write:${value}`), value - 1)),
});

function schemaError<A>(effect: Effect.Effect<A, Schema.SchemaError>) {
  return Effect.runPromiseExit(effect);
}

Deno.test("exact optional key omits missing values, rejects present undefined, and skips field effects", async () => {
  const decode: Effect.Effect<
    { readonly value?: number },
    Schema.SchemaError,
    Read
  > = Schema.decodeUnknownEffect(optional)({});
  const encode: Effect.Effect<
    { readonly value?: number },
    Schema.SchemaError,
    Write
  > = Schema.encodeEffect(optional)({});
  events.length = 0;
  assertEquals(await Effect.runPromise(decode.pipe(Effect.provide(read))), {});
  assertEquals(await Effect.runPromise(encode.pipe(Effect.provide(write))), {});
  assertEquals(events, []);
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(optional)({ value: 1 }).pipe(
        Effect.provide(read),
      ),
    ),
    { value: 2 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.encodeEffect(optional)({ value: 2 }).pipe(
        Effect.provide(write),
      ),
    ),
    { value: 1 },
  );
  assertEquals(events, ["read:1", "write:2"]);
  const invalid = await schemaError(
    Schema.decodeUnknownEffect(optional)({ value: undefined }).pipe(
      Effect.provide(read),
    ),
  );
  assert(Exit.isFailure(invalid));
  const error = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("value"));
  assertEquals(events, ["read:1", "write:2"]);
});

const tagged = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("left"), value: shifted }),
  Schema.Struct({ kind: Schema.Literal("right"), value: Schema.Finite }),
]);

Deno.test("tagged union selects one branch and preserves direction-specific services", async () => {
  events.length = 0;
  const decoded: Effect.Effect<
    { readonly kind: "left"; readonly value: number } | {
      readonly kind: "right";
      readonly value: number;
    },
    Schema.SchemaError,
    Read
  > = Schema.decodeUnknownEffect(tagged)({ kind: "left", value: 1 });
  const encoded: Effect.Effect<
    { readonly kind: "left"; readonly value: number } | {
      readonly kind: "right";
      readonly value: number;
    },
    Schema.SchemaError,
    Write
  > = Schema.encodeEffect(tagged)({ kind: "left", value: 2 });
  assertEquals(events, []);
  assertEquals(
    await Effect.runPromise(decoded.pipe(Effect.provide(read))),
    { kind: "left", value: 2 },
  );
  assertEquals(
    await Effect.runPromise(encoded.pipe(Effect.provide(write))),
    { kind: "left", value: 1 },
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(tagged)({ kind: "right", value: 7 }).pipe(
        Effect.provide(read),
      ),
    ),
    { kind: "right", value: 7 },
  );
  assertEquals(events, ["read:1", "write:2"]);
  const invalid = await schemaError(
    Schema.decodeUnknownEffect(tagged)({ kind: "other", value: 1 }).pipe(
      Effect.provide(read),
    ),
  );
  assert(Exit.isFailure(invalid));
  const error = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("kind"));
});

Deno.test("a selected tagged branch keeps its transformation issue", async () => {
  const calls: string[] = [];
  const blocked = Layer.succeed(Read)({
    next: (value) =>
      Effect.sync(() => calls.push(`read:${value}`)).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new SchemaIssue.InvalidValue({ message: "branch blocked" }),
          )
        ),
      ),
  });
  const exit = await schemaError(
    Schema.decodeUnknownEffect(tagged)({ kind: "left", value: 1 }).pipe(
      Effect.provide(blocked),
    ),
  );
  assert(Exit.isFailure(exit));
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("branch blocked"));
  assertEquals(calls, ["read:1"]);
});

Deno.test("tag dispatch skips an unselected branch even when its effectful field comes first", async () => {
  const reversed = Schema.Union([
    Schema.Struct({ value: shifted, kind: Schema.Literal("left") }),
    Schema.Struct({ kind: Schema.Literal("right"), value: Schema.Finite }),
  ]);
  events.length = 0;
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(reversed)({ kind: "right", value: 7 }).pipe(
        Effect.provide(read),
      ),
    ),
    { kind: "right", value: 7 },
  );
  assertEquals(events, []);
});

Deno.test("union member order is observable when branches overlap", async () => {
  const first = Schema.Struct({ value: Schema.Finite });
  const second = Schema.Struct({ value: Schema.Finite, extra: Schema.String });
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Union([first, second]))({
        value: 1,
        extra: "kept?",
      }),
    ),
    { value: 1 },
  );
});

interface OptionalNode {
  readonly next?: OptionalNode;
}
const optionalNode: Schema.Codec<OptionalNode> = Schema.Struct({
  next: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<OptionalNode> => optionalNode),
  ),
});

type TaggedList = { readonly kind: "end" } | {
  readonly kind: "more";
  readonly next: TaggedList;
};
const taggedList: Schema.Codec<TaggedList> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("end") }),
  Schema.Struct({
    kind: Schema.Literal("more"),
    next: Schema.suspend((): Schema.Codec<TaggedList> => taggedList),
  }),
]);

Deno.test("omission and tagged terminal branches guard finite self recursion", async () => {
  const optionalValue: OptionalNode = { next: { next: {} } };
  const unionValue: TaggedList = {
    kind: "more",
    next: { kind: "end" },
  };
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(optionalNode)(optionalValue),
    ),
    optionalValue,
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(optionalNode)(optionalValue)),
    optionalValue,
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(taggedList)(unionValue),
    ),
    unionValue,
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(taggedList)(unionValue)),
    unionValue,
  );
});

const custom = Schema.Struct({
  payload: Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (): Effect.Effect<string, SchemaIssue.Issue> =>
          Effect.fail(
            new SchemaIssue.Pointer(
              ["detail", 0],
              new SchemaIssue.Composite(Schema.String.ast, [
                new SchemaIssue.InvalidValue({ message: "custom failure" }),
                new SchemaIssue.InvalidValue({ message: "second failure" }),
              ]),
            ),
          ),
        encode: (value) => Effect.succeed(value),
      }),
    ),
  ),
});

Deno.test("source-shaped pointer and composite issues survive SchemaError wrapping", async () => {
  const invalid = await schemaError(
    Schema.decodeUnknownEffect(custom)({ payload: "bad" }),
  );
  assert(Exit.isFailure(invalid));
  const error = Option.getOrUndefined(Cause.findErrorOption(invalid.cause));
  assert(error instanceof Schema.SchemaError);
  assert(error.message.includes("payload"));
  assert(error.message.includes("detail"));
  assert(error.message.includes("custom failure"));
  assert(error.message.includes("second failure"));
  assertEquals(error.issue._tag, "Composite");
  assert(JSON.stringify(error.issue).includes('"path":["detail",0]'));
  const defect = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (): Effect.Effect<string, SchemaIssue.Issue> =>
            Effect.die("boom"),
          encode: (value) => Effect.succeed(value),
        }),
      ),
    ))("bad"),
  );
  assert(Exit.isFailure(defect));
  assert(Cause.hasDies(defect.cause));
});

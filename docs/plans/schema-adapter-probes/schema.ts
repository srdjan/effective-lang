// deno test --no-lock docs/plans/schema-adapter-probes/schema.ts
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

class DecodeIndex extends Context.Service<DecodeIndex, {
  readonly read: (key: string) => Effect.Effect<number, SchemaIssue.Issue>;
}>()("schema-audit#DecodeIndex") {}
class EncodeIndex extends Context.Service<EncodeIndex, {
  readonly write: (value: number) => Effect.Effect<string, SchemaIssue.Issue>;
}>()("schema-audit#EncodeIndex") {}

const indexed: Schema.Codec<number, string, DecodeIndex, EncodeIndex> = Schema
  .String.pipe(
    Schema.decodeTo(
      Schema.Int,
      SchemaTransformation.transformEffect({
        decode: (key: string) => DecodeIndex.use((index) => index.read(key)),
        encode: (value: number) =>
          EncodeIndex.use((index) => index.write(value)),
      }),
    ),
  );

Deno.test("effectful schema keeps decoding and encoding requirements separate", async () => {
  const calls: string[] = [];
  const decode: Effect.Effect<number, Schema.SchemaError, DecodeIndex> = Schema
    .decodeUnknownEffect(indexed)("seven");
  const encode: Effect.Effect<string, Schema.SchemaError, EncodeIndex> = Schema
    .encodeEffect(indexed)(7);
  assertEquals(calls, []);
  assertEquals(
    await Effect.runPromise(
      decode.pipe(Effect.provide(
        Layer.succeed(DecodeIndex)({
          read: (key) =>
            Effect.sync(() => {
              calls.push(`read:${key}`);
              return 7;
            }),
        }),
      )),
    ),
    7,
  );
  assertEquals(
    await Effect.runPromise(
      encode.pipe(Effect.provide(
        Layer.succeed(EncodeIndex)({
          write: (value) =>
            Effect.sync(() => {
              calls.push(`write:${value}`);
              return "seven";
            }),
        }),
      )),
    ),
    "seven",
  );
  assertEquals(calls, ["read:seven", "write:7"]);
});

Deno.test("schema validation and transformation issues fail as SchemaError without catching defects", async () => {
  let calls = 0;
  const live = Layer.succeed(DecodeIndex)({
    read: (key) =>
      Effect.suspend(() => {
        calls++;
        return key === "defect" ? Effect.die("lookup-defect") : Effect.fail(
          new SchemaIssue.InvalidValue({ message: "missing key" }, key),
        );
      }),
  });
  for (const input of [false, "missing"]) {
    const exit = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(indexed)(input).pipe(Effect.provide(live)),
    );
    assert(Exit.isFailure(exit));
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(error instanceof Schema.SchemaError);
  }
  assertEquals(calls, 1);
  const defect = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(indexed)("defect").pipe(Effect.provide(live)),
  );
  assert(Exit.isFailure(defect));
  assert(Cause.hasDies(defect.cause));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(defect.cause)),
    undefined,
  );
});

interface Tree {
  readonly value: number;
  readonly children: ReadonlyArray<Tree>;
}
const tree: Schema.Codec<Tree> = Schema.Struct({
  value: Schema.Int,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => tree)),
});

Deno.test("recursive schema decodes and encodes nested trees and rejects a bad descendant", async () => {
  const value = {
    value: 1,
    children: [{ value: 2, children: [{ value: 3, children: [] }] }],
  };
  assertEquals(
    await Effect.runPromise(Schema.decodeUnknownEffect(tree)(value)),
    value,
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(tree)(value)),
    value,
  );
  const bad = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(tree)({
      value: 1,
      children: [{ value: "wrong", children: [] }],
    }),
  );
  assert(Exit.isFailure(bad));
  assert(
    Option.getOrUndefined(Cause.findErrorOption(bad.cause)) instanceof
      Schema.SchemaError,
  );
});

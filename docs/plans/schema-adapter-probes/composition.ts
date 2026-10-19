// deno test --no-lock docs/plans/schema-adapter-probes/composition.ts
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
}>()("schema-composition#Read") {}

class Write extends Context.Service<Write, {
  readonly previous: (
    value: number,
  ) => Effect.Effect<number, SchemaIssue.Issue>;
}>()("schema-composition#Write") {}

interface Node {
  readonly value: number;
  readonly children: ReadonlyArray<Node>;
}

const shifted: Schema.Codec<number, number, Read, Write> = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: (value) => Read.use((service) => service.next(value)),
      encode: (value) => Write.use((service) => service.previous(value)),
    }),
  ),
);

const tree: Schema.Codec<Node, Node, Read, Write> = Schema.Struct({
  value: shifted,
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<Node, Node, Read, Write> => tree),
  ),
});

Deno.test("recursive composition keeps decode and encode services independent", async () => {
  const events: string[] = [];
  const read = Layer.succeed(Read)({
    next: (value) =>
      Effect.sync(() => {
        events.push(`read:${value}`);
        return value + 1;
      }),
  });
  const write = Layer.succeed(Write)({
    previous: (value) =>
      Effect.sync(() => {
        events.push(`write:${value}`);
        return value - 1;
      }),
  });
  const encoded: Node = {
    value: 1,
    children: [{ value: 2, children: [{ value: 3, children: [] }] }],
  };
  const decoded: Node = {
    value: 2,
    children: [{ value: 3, children: [{ value: 4, children: [] }] }],
  };
  const decode: Effect.Effect<Node, Schema.SchemaError, Read> = Schema
    .decodeUnknownEffect(tree)(encoded);
  const encode: Effect.Effect<Node, Schema.SchemaError, Write> = Schema
    .encodeEffect(tree)(decoded);
  assertEquals(events, []);
  assertEquals(
    await Effect.runPromise(decode.pipe(Effect.provide(read))),
    decoded,
  );
  assertEquals(
    await Effect.runPromise(encode.pipe(Effect.provide(write))),
    encoded,
  );
  assertEquals(events, [
    "read:1",
    "read:2",
    "read:3",
    "write:2",
    "write:3",
    "write:4",
  ]);
});

Deno.test("nested validation and transformation issues are SchemaError; defects remain defects", async () => {
  const read = Layer.succeed(Read)({
    next: (value) =>
      value === 2
        ? Effect.fail(
          new SchemaIssue.InvalidValue({ message: "blocked" }, value),
        )
        : value === 3
        ? Effect.die("defect")
        : Effect.succeed(value + 1),
  });
  for (
    const [index, input] of [
      { value: 1, children: [{ value: "wrong", children: [] }] },
      { value: 1, children: [{ value: 2, children: [] }] },
    ].entries()
  ) {
    const exit = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(tree)(input).pipe(Effect.provide(read)),
    );
    assert(Exit.isFailure(exit));
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert(error instanceof Schema.SchemaError);
    assert(error.message.includes("children"));
    if (index === 1) assert(error.message.includes("blocked"));
  }
  const defect = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(tree)({ value: 3, children: [] }).pipe(
      Effect.provide(read),
    ),
  );
  assert(Exit.isFailure(defect));
  assert(Cause.hasDies(defect.cause));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(defect.cause)),
    undefined,
  );
});

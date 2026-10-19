// deno test --no-lock docs/plans/schema-adapter-probes/recursive-wire.ts
import { assert, assertEquals } from "@std/assert";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

type Tree = { readonly score: number; readonly children: ReadonlyArray<Tree> };
type Wire = { readonly score: string; readonly children: ReadonlyArray<Wire> };
type Input = {
  readonly score?: number;
  readonly children?: ReadonlyArray<Input>;
};
type View = Schema.Codec<Tree, Wire> & { readonly "~type.make.in": Input };

function tree(
  decode: (value: string) => Effect.Effect<number, SchemaIssue.Issue>,
  encode: (value: number) => Effect.Effect<string, SchemaIssue.Issue>,
) {
  const number = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Int,
      SchemaTransformation.transformEffect({ decode, encode }),
    ),
  );
  let body: View;
  const self: View = Schema.suspend(() => body);
  body = Schema.make<View>(
    Schema.Struct({
      score: number.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
      children: Schema.Array(self).pipe(
        Schema.withConstructorDefault(Effect.succeed([])),
      ),
    }).ast,
  );
  return self;
}

Deno.test("recursive decoded, encoded and make shapes stay independent", async () => {
  const calls: string[] = [];
  const schema = tree((value) =>
    Effect.sync(() => {
      calls.push("read:" + value);
      return Number(value);
    }), (value) =>
    Effect.sync(() => {
      calls.push("write:" + value);
      return String(value);
    }));
  const wire: typeof schema.Encoded = {
    score: "1",
    children: [{ score: "2", children: [] }],
  };
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(wire),
  );
  assertEquals(decoded, { score: 1, children: [{ score: 2, children: [] }] });
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(schema)(decoded)),
    wire,
  );
  assertEquals(calls, ["read:1", "read:2", "write:1", "write:2"]);
  const input: typeof schema["~type.make.in"] = { children: [{}] };
  assertEquals(await Effect.runPromise(schema.makeEffect(input)), {
    score: 4,
    children: [{ score: 4, children: [] }],
  });
  assertEquals(calls.length, 4);
  assert(
    Exit.isFailure(
      await Effect.runPromiseExit(Schema.decodeUnknownEffect(schema)({})),
    ),
  );
  // @ts-expect-error Wire representation is required at nested nodes too.
  const wrongWire: typeof schema.Encoded = {
    score: "1",
    children: [{ score: 2, children: [] }],
  };
  // @ts-expect-error Make takes decoded numeric input, not wire strings.
  const wrongMake: typeof schema["~type.make.in"] = {
    children: [{ score: "2" }],
  };
  void wrongWire;
  void wrongMake;
});

Deno.test("optional and tagged recursion retain distinct wire fields", async () => {
  const number = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Int,
      SchemaTransformation.transform({ decode: Number, encode: String }),
    ),
  );
  type Node = { readonly score: number; readonly next?: Node };
  type WireNode = { readonly score?: string; readonly next?: WireNode };
  let node: Schema.Codec<Node, WireNode>;
  const self = Schema.suspend(() => node);
  node = Schema.Struct({
    score: number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(8))),
    next: Schema.optionalKey(self),
  });
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(node)({ next: {} }),
  );
  assertEquals(decoded, { score: 8, next: { score: 8 } });
  assertEquals(await Effect.runPromise(Schema.encodeEffect(node)(decoded)), {
    score: "8",
    next: { score: "8" },
  });
  type Choice = { readonly kind: "end" } | {
    readonly kind: "more";
    readonly score: number;
    readonly next: Choice;
  };
  type WireChoice = { readonly kind: "end" } | {
    readonly kind: "more";
    readonly score: string;
    readonly next: WireChoice;
  };
  let choice: Schema.Codec<Choice, WireChoice>;
  choice = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("end") }),
    Schema.Struct({
      kind: Schema.Literal("more"),
      score: number,
      next: Schema.suspend(() => choice),
    }),
  ]);
  const wire = { kind: "more", score: "2", next: { kind: "end" } } as const;
  const made = await Effect.runPromise(
    Schema.decodeUnknownEffect(choice)(wire),
  );
  assertEquals(made, { kind: "more", score: 2, next: { kind: "end" } });
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(choice)(made)),
    wire,
  );
});

Deno.test("recursive wire failures keep paths and encoding interruption awaits cleanup", async () => {
  const schema = tree(
    (value) =>
      value === "bad"
        ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" }))
        : Effect.succeed(Number(value)),
    (value) =>
      value === 9
        ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" }))
        : Effect.succeed(String(value)),
  );
  const operations: ReadonlyArray<Effect.Effect<unknown, Schema.SchemaError>> =
    [
      Schema.decodeUnknownEffect(schema)({
        score: "1",
        children: [{ score: "bad", children: [] }],
      }),
      Schema.encodeEffect(schema)({
        score: 1,
        children: [{ score: 9, children: [] }],
      }),
    ];
  for (const operation of operations) {
    const exit = await Effect.runPromiseExit(Effect.flip(operation));
    assert(Exit.isSuccess(exit));
    assert(
      exit.value.message.includes("children") &&
        exit.value.message.includes("score"),
    );
  }
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const waiting = tree(
      (value) => Effect.succeed(Number(value)),
      (value) =>
        value === 2
          ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => {
              released = true;
            })),
          )
          : Effect.succeed(String(value)),
    );
    const fiber = yield* Effect.forkChild(
      Schema.encodeEffect(waiting)({
        score: 1,
        children: [{ score: 2, children: [] }],
      }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert(released);
  }));
});

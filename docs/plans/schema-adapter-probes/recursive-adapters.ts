// deno test --no-lock docs/plans/schema-adapter-probes/recursive-adapters.ts
import { assertEquals } from "@std/assert";
import { Effect, Option, Schema, SchemaGetter } from "npm:effect@4.0.5";

type View<D, E, M> = Schema.Codec<D, E> & { readonly "~type.make.in": M };
type Tree = { readonly score: number; readonly children: ReadonlyArray<Tree> };
type Wire = { readonly score: string; readonly children?: ReadonlyArray<Wire> };
type Input = {
  readonly score?: number;
  readonly children?: ReadonlyArray<Input>;
};

Deno.test("recursive arrays retain constructor input through wire default adapters", async () => {
  for (const encoded of [false, true]) {
    let body: View<Tree, Wire, Input>;
    const self: View<Tree, Wire, Input> = Schema.suspend(() => body);
    const children = Schema.Array(self).pipe(
      Schema.withConstructorDefault(Effect.succeed([])),
    );
    body = Schema.make<View<Tree, Wire, Input>>(
      Schema.Struct({
        score: Schema.NumberFromString.pipe(
          Schema.withConstructorDefault(Effect.succeed(4)),
        ),
        children: encoded
          ? children.pipe(
            Schema.withDecodingDefaultKey(Effect.succeed([]), {
              encodingStrategy: "omit",
            }),
          )
          : children.pipe(
            Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
          ),
      }).ast,
    );
    assertEquals(await Effect.runPromise(self.makeEffect({ children: [{}] })), {
      score: 4,
      children: [{ score: 4, children: [] }],
    });
    assertEquals(
      await Effect.runPromise(
        Schema.decodeUnknownEffect(self)({
          score: "1",
          children: [{ score: "2" }],
        }),
      ),
      {
        score: 1,
        children: [{ score: 2, children: [] }],
      },
    );
    assertEquals(
      await Effect.runPromise(
        Schema.encodeEffect(self)({
          score: 1,
          children: [{ score: 2, children: [] }],
        }),
      ),
      encoded
        ? { score: "1" }
        : { score: "1", children: [{ score: "2", children: [] }] },
    );
  }
});

Deno.test("null-as-missing is an optional recursive guard in both wire directions", async () => {
  type Node = { readonly next?: Node };
  type WireNode = { readonly next?: WireNode | null };
  let body: View<Node, WireNode, Node>;
  const self: View<Node, WireNode, Node> = Schema.suspend(() => body);
  body = Schema.make<View<Node, WireNode, Node>>(
    Schema.Struct({
      next: Schema.optionalKey(Schema.NullOr(self)).pipe(
        Schema.decodeTo(Schema.optionalKey(Schema.toType(self)), {
          decode: SchemaGetter.transformOptional(
            Option.filter((value) => value !== null),
          ),
          encode: SchemaGetter.transformOptional((value) => value),
        }),
      ),
    }).ast,
  );
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(self)({ next: { next: null } }),
    ),
    { next: {} },
  );
  assertEquals(
    await Effect.runPromise(self.makeEffect({ next: { next: {} } })),
    { next: { next: {} } },
  );
  assertEquals(
    await Effect.runPromise(Schema.encodeEffect(self)({ next: {} })),
    { next: {} },
  );
});

Deno.test("optional getters around suspended arrays retain target construction only", async () => {
  type Node = { readonly children?: ReadonlyArray<Node> };
  let body: View<Node, Node, Node>;
  const self: View<Node, Node, Node> = Schema.suspend(() => body);
  body = Schema.make<View<Node, Node, Node>>(
    Schema.Struct({
      children: Schema.optionalKey(Schema.Array(self)).pipe(
        Schema.decodeTo(
          Schema.optionalKey(
            Schema.Array(self).pipe(
              Schema.withConstructorDefault(Effect.succeed([])),
            ),
          ),
          {
            decode: SchemaGetter.transformOptional((value) => value),
            encode: SchemaGetter.transformOptional((value) => value),
          },
        ),
      ),
    }).ast,
  );
  assertEquals(await Effect.runPromise(self.makeEffect({ children: [{}] })), {
    children: [{ children: [] }],
  });
  assertEquals(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(self)({ children: [{}] }),
    ),
    { children: [{}] },
  );
});

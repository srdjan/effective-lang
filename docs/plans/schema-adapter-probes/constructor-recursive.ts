// deno test --no-lock docs/plans/schema-adapter-probes/constructor-recursive.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  SchemaIssue,
} from "npm:effect@4.0.5";

type View<D, M> = Schema.Codec<D> & { readonly "~type.make.in": M };
type Tree = { readonly score: number; readonly children: ReadonlyArray<Tree> };
type TreeInput = {
  readonly score?: number;
  readonly children?: ReadonlyArray<TreeInput>;
};

function tree(defaultScore: Effect.Effect<number, SchemaIssue.Issue>) {
  let body: View<Tree, TreeInput>;
  const self: View<Tree, TreeInput> = Schema.suspend(() => body);
  body = Schema.make<View<Tree, TreeInput>>(
    Schema.Struct({
      score: Schema.Int.pipe(Schema.withConstructorDefault(defaultScore)),
      children: Schema.Array(self).pipe(
        Schema.withConstructorDefault(Effect.succeed([])),
      ),
    }).ast,
  );
  return self;
}

Deno.test("suspended schemas retain recursive make inputs and fresh nested defaults", async () => {
  let calls = 0;
  const schema = tree(Effect.sync(() => ++calls));
  const input: typeof schema["~type.make.in"] = {
    children: [{}, { children: [{}] }],
  };
  assertEquals(calls, 0);
  assertEquals(await Effect.runPromise(schema.makeEffect(input)), {
    score: 1,
    children: [{ score: 2, children: [] }, {
      score: 3,
      children: [{ score: 4, children: [] }],
    }],
  });
  assertEquals(await Effect.runPromise(schema.makeEffect({})), {
    score: 5,
    children: [],
  });
  // @ts-expect-error Decoded recursive data stays complete at every level.
  const decoded: typeof schema.Type = { score: 1, children: [{}] };
  void decoded;
  const wire = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(schema)({}),
  );
  assert(Exit.isFailure(wire));
  assertEquals(calls, 5);
});

Deno.test("optional and tagged recursion use the same make input at each self reference", async () => {
  type Node = { readonly score: number; readonly next?: Node };
  type Input = { readonly score?: number; readonly next?: Input };
  let nodeBody: View<Node, Input>;
  const node: View<Node, Input> = Schema.suspend(() => nodeBody);
  nodeBody = Schema.make<View<Node, Input>>(
    Schema.Struct({
      score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
      next: Schema.optionalKey(node),
    }).ast,
  );
  assertEquals(
    await Effect.runPromise(node.makeEffect({ next: { next: {} } })),
    { score: 4, next: { score: 4, next: { score: 4 } } },
  );
  type Choice = { readonly kind: "end" } | {
    readonly kind: "more";
    readonly next: Choice;
  };
  type ChoiceInput = { readonly kind: "end" } | {
    readonly kind: "more";
    readonly next?: ChoiceInput;
  };
  let choiceBody: View<Choice, ChoiceInput>;
  const choice: View<Choice, ChoiceInput> = Schema.suspend(() => choiceBody);
  choiceBody = Schema.make<View<Choice, ChoiceInput>>(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("end") }),
      Schema.Struct({
        kind: Schema.Literal("more"),
        next: Schema.make<
          View<Choice, ChoiceInput> & Schema.WithoutConstructorDefault
        >(choice.ast).pipe(
          Schema.withConstructorDefault(Effect.succeed({ kind: "end" })),
        ),
      }),
    ]).ast,
  );
  assertEquals(
    await Effect.runPromise(
      choice.makeEffect({ kind: "more", next: { kind: "more" } }),
    ),
    { kind: "more", next: { kind: "more", next: { kind: "end" } } },
  );
});

Deno.test("recursive constructor failures retain paths and interruption awaits nested cleanup", async () => {
  const schema = tree(Effect.succeed(4));
  const exit = await Effect.runPromiseExit(
    schema.makeEffect({ children: [{ children: [{ score: 0.5 }] }] }),
  );
  assert(Exit.isFailure(exit));
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(SchemaIssue.isIssue(issue));
  const message = SchemaIssue.makeFormatterDefault()(issue);
  assert(message.includes("children") && message.includes("score"));
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const waiting = tree(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => {
          released = true;
        })),
      ),
    );
    const fiber = yield* Effect.forkChild(
      waiting.makeEffect({ score: 1, children: [{}] }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert(released);
  }));
});

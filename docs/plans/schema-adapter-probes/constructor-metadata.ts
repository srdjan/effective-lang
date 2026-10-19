// deno test --no-lock docs/plans/schema-adapter-probes/constructor-metadata.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "npm:effect@4.0.5";

const child = Schema.Struct({
  score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
});
type View<D, E, M> = Schema.Codec<D, E> & { readonly "~type.make.in": M };

Deno.test("make input survives structs, arrays, unions and optional fields", async () => {
  const nested = Schema.Struct({
    settings: child.pipe(Schema.withConstructorDefault(Effect.succeed({}))),
  });
  const array = Schema.Array(child);
  const optional = Schema.Struct({ settings: Schema.optionalKey(child) });
  const union = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("score"), settings: child }),
    Schema.Struct({ kind: Schema.Literal("end") }),
  ]);
  const input: typeof nested["~type.make.in"] = {};
  const arrayInput: typeof array["~type.make.in"] = [{}, { score: 8 }];
  const optionalInput: typeof optional["~type.make.in"] = { settings: {} };
  const unionInput: typeof union["~type.make.in"] = {
    kind: "score",
    settings: {},
  };
  assertEquals(await Effect.runPromise(nested.makeEffect(input)), {
    settings: { score: 4 },
  });
  assertEquals(await Effect.runPromise(array.makeEffect(arrayInput)), [{
    score: 4,
  }, { score: 8 }]);
  assertEquals(await Effect.runPromise(optional.makeEffect(optionalInput)), {
    settings: { score: 4 },
  });
  assertEquals(await Effect.runPromise(optional.makeEffect({})), {});
  assertEquals(await Effect.runPromise(union.makeEffect(unionInput)), {
    kind: "score",
    settings: { score: 4 },
  });
  // @ts-expect-error Neither decoded nor encoded data gains the make-input omissions.
  const decoded: typeof nested.Type = {};
  // @ts-expect-error Array members are fully constructed on the decoded side.
  const decodedArray: typeof array.Type = [{}];
  void decoded;
  void decodedArray;
});

Deno.test("the decoded target controls a transformation's make input", async () => {
  let decodes = 0;
  const transformed = Schema.String.pipe(
    Schema.decodeTo(
      child,
      SchemaTransformation.transform({
        decode: (_value: string) => {
          decodes++;
          return { score: 8 };
        },
        encode: (_value: { readonly score: number }) => "8",
      }),
    ),
  );
  const input: typeof transformed["~type.make.in"] = {};
  assertEquals(await Effect.runPromise(transformed.makeEffect(input)), {
    score: 4,
  });
  assertEquals(decodes, 0);
});

Deno.test("erased codec views can restore checked make metadata without casts", async () => {
  const erased: Schema.Codec<{ readonly score: number }> = child;
  const restored = Schema.make<
    View<
      { readonly score: number },
      { readonly score: number },
      { readonly score?: number }
    > & Schema.WithoutConstructorDefault
  >(erased.ast);
  assertEquals(await Effect.runPromise(restored.makeEffect({})), { score: 4 });
  const field = restored.pipe(
    Schema.withConstructorDefault(Effect.succeed({})),
  );
  const outer = Schema.Struct({ settings: field });
  const input: typeof outer["~type.make.in"] = {};
  assertEquals(await Effect.runPromise(outer.makeEffect(input)), {
    settings: { score: 4 },
  });
});

Deno.test("native nested constructor failures attach complete paths", async () => {
  const failed = Schema.Struct({
    settings: Schema.Struct({
      score: Schema.Int.pipe(
        Schema.withConstructorDefault(
          Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" })),
        ),
      ),
    }).pipe(Schema.withConstructorDefault(Effect.succeed({}))),
  });
  const exit = await Effect.runPromiseExit(failed.makeEffect({}));
  assert(Exit.isFailure(exit));
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  assert(SchemaIssue.isIssue(issue));
  const text = SchemaIssue.makeFormatterDefault()(issue);
  assert(
    text.includes("settings") && text.includes("score") &&
      text.includes("blocked"),
  );
});

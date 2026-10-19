// deno test --no-lock docs/plans/schema-adapter-probes/constructor-order.ts
import { assert, assertEquals } from "@std/assert";
import {
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "npm:effect@4.0.5";

const child = Schema.Struct({
  score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(4))),
});

Deno.test("unary presence and wire-default adapters retain an existing constructor default", async () => {
  let calls = 0;
  const source = child.pipe(Schema.withConstructorDefault(Effect.sync(() => {
    calls++;
    return {};
  })));
  const nullMissing = Schema.optionalKey(Schema.NullOr(source)).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(source)), {
      decode: SchemaGetter.transformOptional(
        Option.filter((value) => value !== null),
      ),
      encode: SchemaGetter.transformOptional((value) => value),
    }),
  );
  const nullDefault = Schema.optionalKey(Schema.NullOr(source)).pipe(
    Schema.decodeTo(Schema.toType(source), {
      decode: SchemaGetter.transformOptional((value) =>
        Option.orElseSome(
          Option.filter(value, (value) => value !== null),
          () => ({ score: 8 }),
        )
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );
  for (
    const field of [
      Schema.optionalKey(source),
      nullMissing,
      nullDefault,
      source.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed({ score: 8 })),
      ),
      source.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ score: 8 }))),
    ]
  ) {
    const retained: typeof field["~type.constructor.default"] = "with-default";
    const record = Schema.Struct({ settings: field });
    const before = calls;
    const input: typeof record["~type.make.in"] = {};
    assertEquals(await Effect.runPromise(record.makeEffect(input)), {
      settings: { score: 4 },
    });
    assertEquals(
      await Effect.runPromise(record.makeEffect({ settings: { score: 7 } })),
      { settings: { score: 7 } },
    );
    assertEquals(calls, before + 1);
    void retained;
  }
  for (const encodingStrategy of ["omit", "passthrough"] as const) {
    const record = Schema.Struct({
      settings: source.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed({ score: 8 }), {
          encodingStrategy,
        }),
      ),
    });
    const before = calls;
    assertEquals(
      await Effect.runPromise(Schema.decodeUnknownEffect(record)({})),
      { settings: { score: 8 } },
    );
    assertEquals(
      await Effect.runPromise(
        Schema.encodeEffect(record)({ settings: { score: 7 } }),
      ),
      encodingStrategy === "omit" ? {} : { settings: { score: 7 } },
    );
    assertEquals(calls, before);
  }
});

Deno.test("optional bridges inherit constructor defaults from the target only", async () => {
  const source = Schema.optionalKey(
    Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.fail(
          new SchemaIssue.InvalidValue({ message: "source must not run" }),
        ),
      ),
    ),
  );
  for (
    const [target, expected] of [
      [Schema.optionalKey(child), {}],
      [
        Schema.optionalKey(
          child.pipe(Schema.withConstructorDefault(Effect.succeed({}))),
        ),
        { settings: { score: 4 } },
      ],
    ] as const
  ) {
    const field = source.pipe(Schema.decodeTo(target, {
      decode: SchemaGetter.transformOptional(Option.map(() => ({ score: 8 }))),
      encode: SchemaGetter.transformOptional(Option.map(() => "8")),
    }));
    const record = Schema.Struct({ settings: field });
    assertEquals(await Effect.runPromise(record.makeEffect({})), expected);
  }
  const target = Schema.optionalKey(
    child.pipe(Schema.withConstructorDefault(Effect.succeed({}))),
  );
  const required = Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.fail(
        new SchemaIssue.InvalidValue({ message: "source must not run" }),
      ),
    ),
    Schema.decodeTo(target, {
      decode: SchemaGetter.transformOptional(Option.map(() => ({ score: 8 }))),
      encode: SchemaGetter.transformOptional(() => Option.some("8")),
    }),
  );
  assertEquals(
    await Effect.runPromise(
      Schema.Struct({ settings: required }).makeEffect({}),
    ),
    { settings: { score: 4 } },
  );
});

Deno.test("Option adaptation resets the root default and requires complete Option contents", async () => {
  let calls = 0;
  const source = child.pipe(Schema.withConstructorDefault(Effect.sync(() => {
    calls++;
    return {};
  })));
  const option = Schema.OptionFromOptionalKey(source);
  const reset: typeof option["~type.constructor.default"] = "no-default";
  const record = Schema.Struct({ settings: option });
  // @ts-expect-error The adapted Option field has no root constructor default.
  const absent: typeof record["~type.make.in"] = {};
  assert(
    Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(absent))),
  );
  assertEquals(
    await Effect.runPromise(
      record.makeEffect({ settings: Option.some({ score: 7 }) }),
    ),
    { settings: Option.some({ score: 7 }) },
  );
  // @ts-expect-error Option requires complete D, even when the source has partial M.
  const partial: typeof record["~type.make.in"] = { settings: Option.some({}) };
  assert(
    Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(partial))),
  );
  const decorated = Schema.Struct({
    settings: option.pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.some({ score: 6 }))),
    ),
  });
  assertEquals(await Effect.runPromise(decorated.makeEffect({})), {
    settings: Option.some({ score: 6 }),
  });
  assertEquals(calls, 0);
  void reset;
});

// deno test --no-lock docs/plans/schema-adapter-probes/constructor-optional.ts
import { assert, assertEquals } from "@std/assert";
import { Effect, Exit, Option, Schema, SchemaGetter } from "npm:effect@4.0.5";

let constructors = 0;
const child = Schema.Struct({
  score: Schema.Int.pipe(Schema.withConstructorDefault(Effect.sync(() => {
    constructors++;
    return 4;
  }))),
});

Deno.test("wire defaults keep nested make inputs without supplying constructor fields", async () => {
  let defaults = 0;
  const fallback = Effect.sync(() => {
    defaults++;
    return { score: 8 };
  });
  for (const encodingStrategy of ["omit", "passthrough"] as const) {
    for (
      const field of [
        child.pipe(
          Schema.withDecodingDefaultTypeKey(fallback, { encodingStrategy }),
        ),
        child.pipe(
          Schema.withDecodingDefaultKey(fallback, { encodingStrategy }),
        ),
        Schema.optionalKey(Schema.NullOr(child)).pipe(
          Schema.decodeTo(Schema.toType(child), {
            decode: SchemaGetter.transformOptionalEffect((value) => {
              const present = Option.filter(value, (value) => value !== null);
              return Option.isSome(present)
                ? Effect.succeed(present)
                : Effect.map(fallback, Option.some);
            }),
            encode: encodingStrategy === "omit"
              ? SchemaGetter.omit()
              : SchemaGetter.passthrough(),
          }),
        ),
      ]
    ) {
      const record = Schema.Struct({ settings: field });
      const input: typeof record["~type.make.in"] = { settings: {} };
      const before = defaults;
      assertEquals(await Effect.runPromise(record.makeEffect(input)), {
        settings: { score: 4 },
      });
      assertEquals(defaults, before);
      // @ts-expect-error A decoding default does not make the constructor key optional.
      const missing: typeof record["~type.make.in"] = {};
      assert(
        Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(missing))),
      );
      assertEquals(defaults, before);
      assertEquals(
        await Effect.runPromise(Schema.decodeUnknownEffect(record)({})),
        { settings: { score: 8 } },
      );
      assertEquals(defaults, before + 1);
    }
  }
});

Deno.test("optional targets retain their make inputs and skip wire getters", async () => {
  let getters = 0;
  const target = Schema.optionalKey(child);
  const nullMissing = Schema.optionalKey(Schema.NullOr(child)).pipe(
    Schema.decodeTo(target, {
      decode: SchemaGetter.transformOptional(
        Option.filter((value) => value !== null),
      ),
      encode: SchemaGetter.transformOptional((value) => value),
    }),
  );
  for (const source of [Schema.optionalKey(Schema.String), Schema.String]) {
    const field = source.pipe(Schema.decodeTo(target, {
      decode: SchemaGetter.transformOptional((value) => {
        getters++;
        return Option.map(value, () => ({ score: 8 }));
      }),
      encode: SchemaGetter.transformOptional((value) => {
        getters++;
        return Option.map(value, () => "8");
      }),
    }));
    const record = Schema.Struct({ settings: field });
    const input: typeof record["~type.make.in"] = { settings: {} };
    assertEquals(await Effect.runPromise(record.makeEffect(input)), {
      settings: { score: 4 },
    });
    assertEquals(await Effect.runPromise(record.makeEffect({})), {});
    assertEquals(getters, 0);
  }
  const record = Schema.Struct({ settings: nullMissing });
  const input: typeof record["~type.make.in"] = { settings: {} };
  assertEquals(await Effect.runPromise(record.makeEffect(input)), {
    settings: { score: 4 },
  });
  assertEquals(await Effect.runPromise(record.makeEffect({})), {});
  // @ts-expect-error Null is an encoded policy, not a constructor input.
  const invalid: typeof record["~type.make.in"] = { settings: null };
  assert(
    Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(invalid))),
  );
});

Deno.test("Option fields require complete decoded contents and do not run nested defaults", async () => {
  const record = Schema.Struct({
    settings: Schema.OptionFromOptionalKey(child),
  });
  const before = constructors;
  assertEquals(
    await Effect.runPromise(record.makeEffect({ settings: Option.none() })),
    { settings: Option.none() },
  );
  assertEquals(
    await Effect.runPromise(
      record.makeEffect({ settings: Option.some({ score: 8 }) }),
    ),
    { settings: Option.some({ score: 8 }) },
  );
  // @ts-expect-error The declared Option schema's input is Option<D>, not Option<M>.
  const partial: typeof record["~type.make.in"] = { settings: Option.some({}) };
  assert(
    Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(partial))),
  );
  // @ts-expect-error Encoded optionality does not make Option-valued constructor input optional.
  const missing: typeof record["~type.make.in"] = {};
  assert(
    Exit.isFailure(await Effect.runPromiseExit(record.makeEffect(missing))),
  );
  assertEquals(constructors, before);
});

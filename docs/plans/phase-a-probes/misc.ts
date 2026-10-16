import { Effect, Option, Schema } from "effect";
declare const x: Effect.Effect<number>;
export const unitBody = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* x;
    return undefined;
  });
export const noYield = (): Effect.Effect<number> =>
  Effect.gen(function* () {
    return 1;
  });
export const P = Schema.Struct({ maybe: Schema.Option(Schema.String), pair: Schema.Tuple([Schema.String, Schema.Number]), tags: Schema.Array(Schema.String) });
export type P = typeof P.Type;
export const m = (p: P): Option.Option<string> => p.maybe;
export const t = (p: P): readonly [string, number] => p.pair;
export const g = (p: P): ReadonlyArray<string> => p.tags;
export const OrderId = Schema.String.pipe(Schema.brand("pay#OrderId"));
export type OrderId = typeof OrderId.Type;
export const made = OrderId.make("o1");
export const un: string = made;

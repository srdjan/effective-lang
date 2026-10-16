import { Effect } from "effect";

declare const a: Effect.Effect<number>;
declare const b: Effect.Effect<boolean>;

export const g = (): Effect.Effect<number> =>
  Effect.gen(function* () {
    const arr = [(yield* a), (yield* a)];
    const rec = { k: (yield* a) };
    const neg = !(yield* b);
    if (neg) {
      return (yield* a);
    }
    return arr.length + rec.k;
  });

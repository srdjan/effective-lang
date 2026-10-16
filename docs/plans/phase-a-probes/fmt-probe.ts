import { Effect } from "effect";

declare const a: Effect.Effect<number>;

export const f = (): Effect.Effect<number> =>
  Effect.gen(function* () {
    const x = (yield* a);
    (yield* a);
    return (yield* a) + x;
  });

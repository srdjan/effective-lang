import { Effect } from "effect";

declare const a: Effect.Effect<{ readonly name: string }>;
declare const n: Effect.Effect<number>;
declare const f: (x: number, y: number) => number;

export const g = (): Effect.Effect<number> =>
  Effect.gen(function* () {
    const s = (yield* a).name;
    const t = (yield* n) + 1;
    const u = f((yield* n), (yield* n));
    const v = true ? (yield* n) : (yield* n);
    return yield* Effect.succeed(s.length + t + u + v);
  });

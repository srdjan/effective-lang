// Generated from traverse.eff by the Effective compiler. Do not edit.

import { Context, Effect } from "effect";

const $int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");
  return value;
};

export class Counter extends Context.Service<Counter, {
  readonly next: (a: number) => Effect.Effect<number>;
}>()("traverse#Counter") {}

export const sequence = (xs: ReadonlyArray<number>): Effect.Effect<
  ReadonlyArray<number>,
  never,
  Counter
> =>
  Effect.gen(function* () {
    const $p1: ReadonlyArray<number> = xs;
    return yield* Effect.forEach($p1, (n: number) =>
      Counter.use(($s) => $s.next(n)));
  });

export const raised = (xs: ReadonlyArray<number>): Effect.Effect<
  ReadonlyArray<number>
> => Effect.forEach(xs, (n: number) => Effect.succeed($int(n + 1)));
//# sourceMappingURL=traverse.ts.map

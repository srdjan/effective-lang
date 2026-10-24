// Generated from traverse.eff by the Effektive compiler. Do not edit.

import { Context, Effect, Schema } from "effect";

const $Int = Schema.Finite.check(
  Schema.makeFilter(
    (value) => Number.isSafeInteger(value) || "expected a safe integer",
  ),
);

const $int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");
  return value;
};

export const Count = $Int;
export type Count = typeof Count.Type;

export class Counter extends Context.Service<Counter, {
  readonly next: (a: Count) => Effect.Effect<Count>;
}>()("traverse#Counter") {}

export const sequence = (xs: ReadonlyArray<Count>): Effect.Effect<
  ReadonlyArray<Count>,
  never,
  Counter
> =>
  Effect.gen(function* () {
    const $p1: ReadonlyArray<Count> = xs;
    return yield* Effect.forEach($p1, (n: Count) =>
      Counter.use(($s) => $s.next(n)));
  });

export const raised = (xs: ReadonlyArray<Count>): Effect.Effect<
  ReadonlyArray<Count>
> => Effect.forEach(xs, (n: Count) => Effect.succeed($int(n + 1)));
//# sourceMappingURL=traverse.ts.map

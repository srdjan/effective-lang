// Target probe for the proposed first-class Effect value slice.
// Check with: deno test --no-lock docs/plans/phase4-probes/effect-values.ts
import { Context, Effect, Layer } from "npm:effect@4.0.5";

type Stop = { readonly _tag: "Stop" };

class Counter extends Context.Service<Counter, {
  readonly next: () => Effect.Effect<number, Stop>;
}>()("phase4#Counter") {}

type Job = Effect.Effect<number, Stop, Counter>;

export const make = (): Job =>
  Effect.suspend(() => Counter.use((counter) => counter.next()));

export const stored: Job = make();

export const runTwice: Effect.Effect<number, Stop, Counter> = Effect.gen(
  function* () {
    const first = yield* stored;
    const second = yield* stored;
    return first + second;
  },
);

class Factory extends Context.Service<Factory, {
  readonly make: () => Effect.Effect<Job>;
}>()("phase4#Factory") {}

export const fromHost: Effect.Effect<number, Stop, Counter | Factory> = Effect
  .gen(function* () {
    const nested = yield* Factory.use((factory) => factory.make());
    return yield* nested;
  });

Deno.test("a stored Effect value defers and repeats service work", () => {
  let calls = 0;
  const count = () => calls;
  const Live = Layer.succeed(Counter)({
    next: () =>
      Effect.sync(() => {
        calls++;
        return calls;
      }),
  });
  const value = make();
  if (count() !== 0) throw new Error("construction ran the job");
  const twice = Effect.gen(function* () {
    const first = yield* value;
    const second = yield* value;
    return first + second;
  });
  const result = Effect.runSync(twice.pipe(Effect.provide(Live)));
  if (result !== 3 || count() !== 2) {
    throw new Error(`expected two runs summing to 3; got ${calls} runs`);
  }
});

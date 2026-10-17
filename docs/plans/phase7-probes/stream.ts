// Target probe for Phase 7 incremental streams. Run with:
// deno test --no-lock docs/plans/phase7-probes/stream.ts
import { Context, Effect, Layer, Sink, Stream } from "npm:effect@4.0.5";

type Stop = { readonly _tag: "Stop" };

class Source extends Context.Service<Source, {
  readonly next: (
    state: number,
  ) => Effect.Effect<readonly [number, number] | undefined, Stop>;
}>()("phase7#Source") {}

class Transform extends Context.Service<Transform, {
  readonly double: (value: number) => Effect.Effect<number, Stop>;
}>()("phase7#Transform") {}

class Consumer extends Context.Service<Consumer, {
  readonly accept: (value: number) => Effect.Effect<void, Stop>;
}>()("phase7#Consumer") {}

const values: Stream.Stream<number, Stop, Source | Transform> = Stream.unfold(
  0,
  (state) => Source.use((source) => source.next(state)),
).pipe(
  Stream.mapEffect((value) =>
    Transform.use((transform) => transform.double(value))
  ),
);

const drain: Effect.Effect<void, Stop, Source | Transform | Consumer> = Stream
  .run(
    values,
    Sink.forEach((value: number) =>
      Consumer.use((consumer) => consumer.accept(value))
    ),
  );

Deno.test("the producer runs incrementally under consumer demand", async () => {
  let produced = 0;
  let consumed = 0;
  let maximumAhead = 0;
  const counts = () => ({ produced, consumed, maximumAhead });
  const output: number[] = [];
  const SourceLive = Layer.succeed(Source)({
    next: (state) =>
      Effect.sync(() => {
        if (state === 4) return undefined;
        produced++;
        maximumAhead = Math.max(maximumAhead, produced - consumed);
        return [state, state + 1] as const;
      }),
  });
  const TransformLive = Layer.succeed(Transform)({
    double: (value) => Effect.succeed(value * 2),
  });
  const ConsumerLive = Layer.succeed(Consumer)({
    accept: (value) =>
      Effect.sync(() => {
        output.push(value);
        consumed++;
      }),
  });
  if (counts().produced !== 0) {
    throw new Error("stream produced before consumption");
  }
  await Effect.runPromise(
    drain.pipe(Effect.provide(Layer.mergeAll(
      SourceLive,
      TransformLive,
      ConsumerLive,
    ))),
  );
  const final = counts();
  if (
    final.produced !== 4 || final.consumed !== 4 || final.maximumAhead > 1 ||
    output.join(",") !== "0,2,4,6"
  ) {
    throw new Error(
      `unexpected stream trace: produced=${final.produced}, consumed=${final.consumed}, ahead=${final.maximumAhead}, output=${output}`,
    );
  }
});

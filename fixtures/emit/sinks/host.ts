import { Effect, Layer, Sink, Stream } from "effect";
import { Factory } from "./contracts.ts";

export const FactoryLive = Layer.succeed(Factory)({
  source: () => Effect.succeed(Stream.make(1, 2, 3)),
  sink: () =>
    Effect.succeed(Sink.foldUntil(
      () => 0,
      2,
      (sum: number, value: number) => Effect.succeed(sum + value),
    )),
});

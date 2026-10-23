import { Effect, Layer } from "effect";
import { Clock } from "./h.effi.ts";

export const ClockLive = Layer.succeed(Clock)({
  now: () => Effect.succeed(7),
});

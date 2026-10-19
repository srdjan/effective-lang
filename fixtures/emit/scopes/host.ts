import { Effect, Layer } from "effect";
import { Boundary } from "./boundary.ts";
import type { Owner } from "./owner.ts";

export const BoundaryLive = Layer.succeed(Boundary)({
  accept: (owner: Owner) => Effect.succeed(owner),
});

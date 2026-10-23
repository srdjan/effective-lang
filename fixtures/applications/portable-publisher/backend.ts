import { Effect, Layer, type Scope } from "effect";
import {
  type KeyValue,
  Platform,
  type PlatformUnavailable,
} from "./platform.ts";

export interface PlatformBackend {
  readonly acquire: Effect.Effect<
    KeyValue,
    PlatformUnavailable,
    Scope.Scope
  >;
}

export const platformLayer = (
  backend: PlatformBackend,
): Layer.Layer<Platform, PlatformUnavailable> =>
  Layer.effect(
    Platform,
    backend.acquire.pipe(
      Effect.map((operations) => ({
        acquire: () => Effect.succeed(operations),
      })),
    ),
  );

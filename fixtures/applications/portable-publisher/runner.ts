import { Effect, Layer } from "effect";
import { ArticleJsonLive } from "./codecs.ts";
import { makeMemoryPlatform, type MemoryPlatform } from "./memory.ts";
import {
  type Int,
  type LexicalOps,
  type PlatformUnavailable,
  TextRules,
  Time,
} from "./platform.ts";
import type { ArticleJson } from "./storage.ts";
import type { Platform } from "./platform.ts";

export type PublisherRequirements = Platform | TextRules | Time | ArticleJson;

export interface RunnerOptions {
  readonly memory?: MemoryPlatform;
  readonly nowMillis?: () => number;
  readonly platformLayer?: Layer.Layer<Platform, PlatformUnavailable>;
}

export function makeRunner(options: RunnerOptions = {}) {
  const memory = options.memory ?? makeMemoryPlatform();
  const lexical: LexicalOps = {
    isBlank: (value) => Effect.succeed(value.trim() === ""),
    isWellFormed: (value) => Effect.succeed(value.isWellFormed()),
  };
  const dependencies = Layer.mergeAll(
    options.platformLayer ?? memory.layer,
    ArticleJsonLive,
    Layer.succeed(TextRules)({
      acquire: () => Effect.succeed(lexical),
    }),
    Layer.succeed(Time)({
      acquire: () =>
        Effect.succeed({
          nowMillis: (): Effect.Effect<Int> =>
            Effect.sync(() => {
              const value = options.nowMillis?.() ?? 1700000000000;
              if (!Number.isSafeInteger(value) || value < 0) {
                throw new RangeError(
                  "time must be nonnegative epoch milliseconds",
                );
              }
              return value;
            }),
        }),
    }),
  );
  return {
    memory,
    layer: dependencies,
    run: <A, E>(program: Effect.Effect<A, E, PublisherRequirements>) =>
      Effect.runPromise(program.pipe(Effect.provide(dependencies))),
    runExit: <A, E>(program: Effect.Effect<A, E, PublisherRequirements>) =>
      Effect.runPromiseExit(program.pipe(Effect.provide(dependencies))),
  };
}

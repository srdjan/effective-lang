import { Effect, type Layer, Option } from "effect";
import { type PlatformBackend, platformLayer } from "./backend.ts";
import {
  CompareConflict,
  type Entry,
  InvalidKey,
  InvalidPayload,
  type KeyValue,
  type Platform,
  PlatformUnavailable,
  Version,
} from "./platform.ts";

export interface MemoryPlatform {
  readonly backend: PlatformBackend;
  readonly layer: Layer.Layer<Platform, PlatformUnavailable>;
  readonly control: KeyValue;
  readonly active: () => number;
}

const validKey = (key: string): boolean => {
  return key.length > 0 && key.isWellFormed();
};

export function makeMemoryPlatform(): MemoryPlatform {
  const entries = new Map<string, Entry>();
  let nextVersion = 0n;
  let active = 0;

  const operations = (available: () => boolean): KeyValue => ({
    get: (key) =>
      Effect.gen(function* () {
        if (!validKey(key)) return yield* Effect.fail(new InvalidKey({ key }));
        if (!available()) {
          return yield* Effect.fail(
            new PlatformUnavailable({ cause: "memory lease is closed" }),
          );
        }
        const entry = entries.get(key);
        return entry === undefined
          ? Option.none()
          : Option.some({ payload: entry.payload, version: entry.version });
      }),
    set: (key, payload, expected) =>
      Effect.gen(function* () {
        if (!validKey(key)) return yield* Effect.fail(new InvalidKey({ key }));
        if (!payload.isWellFormed()) {
          return yield* Effect.fail(new InvalidPayload({}));
        }
        if (!available()) {
          return yield* Effect.fail(
            new PlatformUnavailable({ cause: "memory lease is closed" }),
          );
        }
        const current = entries.get(key);
        const matches = Option.match(expected, {
          onNone: () => current === undefined,
          onSome: (version) => current?.version === version,
        });
        if (!matches) return yield* Effect.fail(new CompareConflict({}));
        const version = Version.make(String(++nextVersion));
        entries.set(key, { payload, version });
        return version;
      }),
  });

  const control = operations(() => true);
  const backend: PlatformBackend = {
    acquire: Effect.acquireRelease(
      Effect.sync(() => {
        const lease = { open: true };
        active++;
        return { lease, operations: operations(() => lease.open) };
      }),
      ({ lease }) =>
        Effect.sync(() => {
          lease.open = false;
          active--;
        }),
    ).pipe(Effect.map(({ operations }) => operations)),
  };

  return {
    backend,
    layer: platformLayer(backend),
    control,
    active: () => active,
  };
}

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Cause, Effect, Exit, Option } from "effect";
import type { PlatformBackend } from "./backend.ts";
import {
  CompareConflict,
  InvalidKey,
  InvalidPayload,
  Key,
  type KeyValue,
  Payload,
  PlatformUnavailable,
  Version,
} from "./platform.ts";

export interface KeyValueContractPlatform {
  readonly backend: PlatformBackend;
  readonly active: () => number;
}

export interface KeyValueContractFixture {
  readonly platform: KeyValueContractPlatform;
  readonly cleanup?: () => void | Promise<void>;
}

export type KeyValueContractFactory = () =>
  | KeyValueContractFixture
  | Promise<KeyValueContractFixture>;

const some = <A>(value: Option.Option<A>): A => {
  assert(Option.isSome(value));
  return value.value;
};

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};

const runWithStore = <A, E>(
  platform: KeyValueContractPlatform,
  use: (store: KeyValue) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* platform.backend.acquire;
        return yield* use(store);
      }),
    ),
  );

export function registerKeyValueContract(
  name: string,
  make: KeyValueContractFactory,
): void {
  const test = (
    label: string,
    body: (platform: KeyValueContractPlatform) => Promise<void>,
  ): void => {
    Deno.test({
      name: `${name}: ${label}`,
      sanitizeOps: true,
      sanitizeResources: true,
      fn: async () => {
        const fixture = await make();
        try {
          await body(fixture.platform);
        } finally {
          await fixture.cleanup?.();
        }
      },
    });
  };

  test("an absent key returns None", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        assert(Option.isNone(yield* store.get(Key.make("absent"))));
      }));
    assertEquals(platform.active(), 0);
  });

  test("create-if-absent conflicts without replacing the value", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("create");
        const original = Payload.make("original");
        yield* store.set(key, original, Option.none());
        const exit = yield* Effect.exit(
          store.set(key, Payload.make("replacement"), Option.none()),
        );
        assert(errorOf(exit) instanceof CompareConflict);
        assertEquals(some(yield* store.get(key)).payload, original);
      }));
  });

  test("each successful write changes the version", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("versions");
        const first = yield* store.set(key, Payload.make("one"), Option.none());
        const second = yield* store.set(
          key,
          Payload.make("two"),
          Option.some(first),
        );
        assertNotEquals(second, first);
        assertEquals(some(yield* store.get(key)).version, second);
      }));
  });

  test("a stale version conflicts without replacing the value", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("stale");
        const first = yield* store.set(key, Payload.make("one"), Option.none());
        const second = yield* store.set(
          key,
          Payload.make("two"),
          Option.some(first),
        );
        const exit = yield* Effect.exit(
          store.set(key, Payload.make("stale"), Option.some(first)),
        );
        assert(errorOf(exit) instanceof CompareConflict);
        assertEquals(some(yield* store.get(key)), {
          payload: Payload.make("two"),
          version: second,
        });
      }));
  });

  test("two writers using one version produce one success", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("writers");
        const observed = yield* store.set(
          key,
          Payload.make("initial"),
          Option.none(),
        );
        const exits = yield* Effect.all([
          Effect.exit(
            store.set(key, Payload.make("left"), Option.some(observed)),
          ),
          Effect.exit(
            store.set(key, Payload.make("right"), Option.some(observed)),
          ),
        ], { concurrency: "unbounded" });
        assertEquals(exits.filter(Exit.isSuccess).length, 1);
        const failed = exits.find(Exit.isFailure);
        assert(failed !== undefined);
        assert(errorOf(failed) instanceof CompareConflict);
        const payload = some(yield* store.get(key)).payload;
        assert(payload === "left" || payload === "right");
      }));
  });

  test("mutating a returned entry does not mutate storage", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("detached");
        const payload = Payload.make("stored");
        const version = yield* store.set(key, payload, Option.none());
        const returned = some(yield* store.get(key));
        Object.assign(returned, {
          payload: Payload.make("mutated"),
          version: Version.make("mutated"),
        });
        assertEquals(some(yield* store.get(key)), { payload, version });
      }));
  });

  test("invalid keys fail before a write", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        for (const raw of ["", "\ud800", "\udc00"]) {
          const exit = yield* Effect.exit(
            store.set(Key.make(raw), Payload.make("value"), Option.none()),
          );
          assert(errorOf(exit) instanceof InvalidKey);
        }
      }));
  });

  test("an invalid payload fails without changing value or version", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const key = Key.make("payload");
        const payload = Payload.make("stored");
        const version = yield* store.set(key, payload, Option.none());
        const exit = yield* Effect.exit(
          store.set(key, Payload.make("\ud800"), Option.some(version)),
        );
        assert(errorOf(exit) instanceof InvalidPayload);
        assertEquals(some(yield* store.get(key)), { payload, version });
      }));
  });

  test("Unicode keys remain exact and distinct", async (platform) => {
    await runWithStore(platform, (store) =>
      Effect.gen(function* () {
        const composed = Key.make("caf\u00e9");
        const decomposed = Key.make("cafe\u0301");
        yield* store.set(composed, Payload.make("composed"), Option.none());
        yield* store.set(decomposed, Payload.make("decomposed"), Option.none());
        assertEquals(
          some(yield* store.get(composed)).payload,
          Payload.make("composed"),
        );
        assertEquals(
          some(yield* store.get(decomposed)).payload,
          Payload.make("decomposed"),
        );
      }));
  });

  test("a closed handle rejects later operations", async (platform) => {
    const store = await Effect.runPromise(
      Effect.scoped(platform.backend.acquire),
    );
    assertEquals(platform.active(), 0);
    const exit = await Effect.runPromise(
      Effect.exit(store.get(Key.make("closed"))),
    );
    assert(errorOf(exit) instanceof PlatformUnavailable);
    const write = await Effect.runPromise(Effect.exit(
      store.set(Key.make("closed"), Payload.make("refused"), Option.none()),
    ));
    assert(errorOf(write) instanceof PlatformUnavailable);
    await runWithStore(platform, (fresh) =>
      Effect.gen(function* () {
        assert(Option.isNone(yield* fresh.get(Key.make("closed"))));
      }));
    assertEquals(platform.active(), 0);
  });
}

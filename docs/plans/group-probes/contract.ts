// Runtime prototype for a proposed source builtin; source borrow checks are future work.
// deno test --no-lock docs/plans/group-probes/contract.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  Stream,
} from "npm:effect@4.0.5";

function mapGroups<A, K, B, E, R, EU, RU>(
  source: Stream.Stream<A, E, R>,
  key: (value: A) => K,
  use: (key: K, values: Stream.Stream<A>) => Effect.Effect<B, EU, RU>,
  options: { readonly bufferSize: number },
): Stream.Stream<B, E | EU, R | Exclude<RU, Scope.Scope>> {
  return Stream.flatMap(
    Stream.groupByKey(source, key, options),
    ([key, values]) =>
      Stream.fromEffect(Effect.scoped(Effect.gen(function* () {
        // Acquiring this pull installs the queue shutdown even when use never reads it.
        const pull = yield* Stream.toPull(values);
        return yield* use(key, Stream.fromPull(Effect.succeed(pull)));
      }))),
    { concurrency: "unbounded", bufferSize: 1 },
  );
}

Deno.test("group mapping routes one producer with fresh state and ordered values per key", async () => {
  let pulls = 0;
  const classified: number[] = [];
  const used: number[] = [];
  const result = mapGroups(
    Stream.unfold(0, (n) =>
      Effect.sync(() => {
        pulls++;
        return n < 6 ? [n, n + 1] as const : undefined;
      })),
    (n) => {
      classified.push(n);
      return n % 3;
    },
    (key, values) => {
      used.push(key);
      return Stream.runCollect(values).pipe(
        Effect.map((items) => ({ key, items })),
      );
    },
    { bufferSize: 1 },
  );
  assertEquals(pulls, 0);
  assertEquals(classified, []);
  assertEquals(used, []);
  for (let run = 0; run < 2; run++) {
    const groups = await Effect.runPromise(
      Stream.runCollect(result).pipe(Effect.timeout("5 seconds")),
    );
    assertEquals(groups.sort((a, b) => a.key - b.key), [
      { key: 0, items: [0, 3] },
      { key: 1, items: [1, 4] },
      { key: 2, items: [2, 5] },
    ]);
    assertEquals(pulls, (run + 1) * 7);
  }
  assertEquals(classified, [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
  assertEquals(used.sort(), [0, 0, 1, 1, 2, 2]);
});

Deno.test("primitive keys keep value equality across chunks and a key is announced once", async () => {
  const result = await Effect.runPromise(Stream.runCollect(mapGroups(
    Stream.fromArray(["A", "a", "A", "b", "a"]).pipe(Stream.rechunk(1)),
    (key) => key,
    (key, values) =>
      Stream.runCollect(values).pipe(Effect.map((items) => ({ key, items }))),
    { bufferSize: 1 },
  )));
  assertEquals(
    result.sort((a, b) =>
      a.key.localeCompare(b.key, "en", { sensitivity: "variant" })
    ),
    [{ key: "a", items: ["a", "a"] }, { key: "A", items: ["A", "A"] }, {
      key: "b",
      items: ["b"],
    }],
  );
  const integers = await Effect.runPromise(Stream.runCollect(mapGroups(
    Stream.make(0, -0, 1, 0),
    (n) => n,
    (key, values) =>
      Stream.runCount(values).pipe(
        Effect.map((count) => [key, count] as const),
      ),
    { bufferSize: 1 },
  )));
  assertEquals(integers.sort((a, b) => a[0] - b[0]), [[0, 3], [1, 1]]);
});

Deno.test("unused and partially consumed groups close without blocking later keys or reopening", async () => {
  for (const consume of [false, true]) {
    const used: number[] = [];
    const result = mapGroups(
      Stream.concat(Stream.make(0, 0, 0, 1, 1), Stream.make(0, 2, 2, 0)),
      (n) => n,
      (key, values) =>
        Effect.sync(() => {
          used.push(key);
        }).pipe(Effect.andThen(
          consume
            ? Stream.runHead(values).pipe(Effect.as(key))
            : Effect.succeed(key),
        )),
      { bufferSize: 1 },
    );
    assertEquals(
      (await Effect.runPromise(
        Stream.runCollect(result).pipe(Effect.timeout("5 seconds")),
      )).sort(),
      [0, 1, 2],
    );
    assertEquals(used.sort(), [0, 1, 2]);
  }
});

Deno.test("a later completed group emits while an earlier group remains live", async () => {
  const events: string[] = [];
  const pending = Deferred.makeUnsafe<void>();
  const source = Stream.unfold(
    0,
    (n): Effect.Effect<readonly [number, number]> =>
      n < 2 ? Effect.succeed([n, n + 1] as const) : Effect.acquireUseRelease(
        Deferred.succeed(pending, undefined),
        () => Effect.never,
        () =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            events.push("source-release");
          }))),
      ),
  );
  const mapped = mapGroups(
    source,
    (n) => n,
    (key, values) =>
      Effect.acquireUseRelease(
        Effect.void,
        () =>
          key === 0
            ? Stream.runDrain(values).pipe(Effect.as(key))
            : Stream.runHead(values).pipe(
              Effect.andThen(Deferred.await(pending)),
              Effect.as(key),
            ),
        () =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            events.push(`group-release:${key}`);
          }))),
      ),
    { bufferSize: 1 },
  );
  const first = await Effect.runPromise(
    Stream.runHead(mapped).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(Option.getOrUndefined(first), 1);
  assertEquals(events.sort(), [
    "group-release:0",
    "group-release:1",
    "source-release",
  ]);
});

Deno.test("a paused full group prevents later keys from passing its upstream queue", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const later = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      events.push(`pull:${n}`);
      return n < 3 ? [n < 2 ? 0 : 1, n + 1] as const : undefined;
    }));
  const mapped = mapGroups(
    source,
    (n) => n,
    (key, values) =>
      key === 0
        ? Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Stream.runCount(values)),
        )
        : Deferred.succeed(later, undefined).pipe(
          Effect.andThen(Stream.runCount(values)),
        ),
    { bufferSize: 1 },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const child = yield* Effect.forkChild(Stream.runCollect(mapped));
      yield* Deferred.await(entered);
      yield* Effect.yieldNow;
      assertEquals(events, ["pull:0", "pull:1"]);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(later);
      assertEquals((yield* Fiber.join(child)).sort(), [1, 2]);
    }).pipe(Effect.timeout("5 seconds")),
  );
});

Deno.test("callback requirements remain deferred and its Scope requirement is locally discharged", async () => {
  class Audit extends Context.Service<
    Audit,
    { readonly record: (key: string) => Effect.Effect<string> }
  >()("group-contract#Audit") {}
  const events: string[] = [];
  const result: Stream.Stream<string, never, Audit> = mapGroups(
    Stream.make("a", "b"),
    (n) => n,
    (key, values) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            events.push(`release:${key}`);
          })))
        );
        yield* Stream.runDrain(values);
        return yield* Audit.use((audit) => audit.record(key));
      }),
    { bufferSize: 1 },
  );
  assertEquals(events, []);
  for (const prefix of ["first", "second"]) {
    const values = await Effect.runPromise(
      Stream.runCollect(result).pipe(Effect.provideService(Audit, {
        record: (key) => Effect.succeed(`${prefix}:${key}`),
      })),
    );
    assertEquals(values.sort(), [`${prefix}:a`, `${prefix}:b`]);
  }
  assertEquals(events.sort(), [
    "release:a",
    "release:a",
    "release:b",
    "release:b",
  ]);
});

Deno.test("callback failure closes the pending producer and peer consumers before returning", async () => {
  const ready = Deferred.makeUnsafe<void>();
  const peer = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const source = Stream.unfold(
    0,
    (n): Effect.Effect<readonly [number, number]> =>
      n < 2 ? Effect.succeed([n, n + 1] as const) : Effect.acquireUseRelease(
        Deferred.succeed(ready, undefined),
        () => Effect.never,
        () =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            events.push("source-release");
          }))),
      ),
  );
  const result = mapGroups(source, (n) => n, (key) =>
    Effect.acquireUseRelease(
      Effect.void,
      () =>
        key === 0
          ? Deferred.await(peer).pipe(
            Effect.andThen(Deferred.await(ready)),
            Effect.andThen(Effect.fail("use-stop" as const)),
          )
          : Deferred.succeed(peer, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
      () =>
        Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
          events.push(`group-release:${key}`);
        }))),
    ), { bufferSize: 1 });
  const exit = await Effect.runPromiseExit(
    Stream.runDrain(result).pipe(Effect.timeout("5 seconds")),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "use-stop",
  );
  assertEquals(events.sort(), [
    "group-release:0",
    "group-release:1",
    "source-release",
  ]);
});

Deno.test("upstream failure cancels group consumers without inventing completed results", async () => {
  const started = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const source = Stream.concat(
    Stream.make(0),
    Stream.fromEffect(
      Deferred.await(started).pipe(
        Effect.andThen(Effect.fail("source-stop" as const)),
      ),
    ),
  );
  const result = mapGroups(source, (n) => n, () =>
    Effect.acquireUseRelease(
      Deferred.succeed(started, undefined),
      () => Effect.never,
      () =>
        Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
          events.push("use-release");
        }))),
    ), { bufferSize: 1 });
  const exit = await Effect.runPromiseExit(
    Stream.runForEach(result, () =>
      Effect.sync(() => {
        events.push("result");
      })).pipe(Effect.timeout("5 seconds")),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "source-stop",
  );
  assertEquals(events, ["use-release"]);
});

Deno.test("external interruption completes group cleanup and empty input invokes no callbacks", async () => {
  const entered = Deferred.makeUnsafe<void>();
  let released = 0;
  let uses = 0;
  const grouped = mapGroups(
    Stream.make(1),
    (n) => n,
    () =>
      Effect.acquireUseRelease(
        Deferred.succeed(entered, undefined),
        () => Effect.never,
        () =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            released++;
          }))),
      ),
    { bufferSize: 1 },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const child = yield* Effect.forkChild(Stream.runDrain(grouped));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(child);
      assertEquals(released, 1);
    }).pipe(Effect.timeout("5 seconds")),
  );
  const empty = mapGroups(
    Stream.empty,
    (_: never) => 0,
    () =>
      Effect.sync(() => {
        uses++;
      }),
    { bufferSize: 1 },
  );
  assertEquals(await Effect.runPromise(Stream.runCollect(empty)), []);
  assertEquals(uses, 0);
});

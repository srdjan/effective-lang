// deno test --no-lock docs/plans/aggregate-probes/contract.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Sink,
  Stream,
} from "npm:effect@4.0.5";
import { TestClock } from "npm:effect@4.0.5/testing";

Deno.test("aggregate replays leftovers and retains target completion results", async () => {
  const pairs = Sink.take<number>(2);
  const cases = [
    { input: [1, 2, 3, 4, 5], expected: [[1, 2], [3, 4], [5]] },
    { input: [1, 2, 3, 4], expected: [[1, 2], [3, 4]] },
    { input: [], expected: [] },
  ];
  for (const { input, expected } of cases) {
    const aggregated = Stream.aggregate(Stream.fromArray(input), pairs);
    for (let run = 0; run < 2; run++) {
      assertEquals(
        await Effect.runPromise(Stream.runCollect(aggregated)),
        expected,
      );
    }
  }
});

Deno.test("aggregate pulls upstream only through the sink handoff", async () => {
  let pulls = 0;
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      pulls++;
      return n < 3 ? [n + 1, n + 1] as const : undefined;
    }));
  const program = Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* Stream.aggregate(source, Sink.take<number>(1)).pipe(
      Stream.runForEach((batch) =>
        batch[0] === 1
          ? Deferred.succeed(first, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          : Effect.void
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* Effect.yieldNow;
    const whileBlocked = pulls;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    return { whileBlocked, total: pulls };
  });
  assertEquals(
    await Effect.runPromise(program.pipe(Effect.timeout("5 seconds"))),
    { whileBlocked: 1, total: 4 },
  );
});

Deno.test("buffered transduction has a different read-ahead trace", async () => {
  const observed = async (aggregate: boolean) => {
    let pulls = 0;
    const program = Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ahead = yield* Deferred.make<void>();
      const source = Stream.unfold(0, (n) =>
        Effect.sync(() => {
          pulls++;
          return n < 3 ? [n + 1, n + 1] as const : undefined;
        }).pipe(Effect.tap(() =>
          n === 1 ? Deferred.succeed(ahead, undefined) : Effect.void
        )));
      const batches = aggregate
        ? Stream.aggregate(source, Sink.take<number>(1))
        : Stream.transduce(
          Stream.buffer(source, { capacity: 1, strategy: "suspend" }),
          Sink.take<number>(1),
        );
      const fiber = yield* batches.pipe(
        Stream.runForEach((batch) =>
          batch[0] === 1
            ? Deferred.succeed(first, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            )
            : Effect.void
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(first);
      if (aggregate) yield* Effect.yieldNow;
      else yield* Deferred.await(ahead);
      const whileBlocked = pulls;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      return whileBlocked;
    });
    return await Effect.runPromise(program.pipe(Effect.timeout("5 seconds")));
  };
  assertEquals(await observed(true), 1);
  assert((await observed(false)) > 1);
});

Deno.test("aggregate keeps typed sink failure and provider binding deferred", async () => {
  class Add extends Context.Service<Add, {
    readonly add: (sum: number, value: number) => Effect.Effect<number, "stop">;
  }>()("aggregate-probe#Add") {}
  let calls = 0;
  const source = Stream.fromArray([1, 2, 3, 4, 5]);
  const batches: Stream.Stream<number, "stop", Add> = Stream.aggregate(
    source,
    Sink.foldUntil(
      () => 0,
      2,
      (sum: number, value: number) => Add.use((add) => add.add(sum, value)),
    ),
  );
  assertEquals(calls, 0);
  const bad = Effect.provideService(Stream.runCollect(batches), Add, {
    add: (sum, value) =>
      Effect.sync(() => {
        calls++;
        return sum + value;
      }).pipe(Effect.flatMap((sum) =>
        value === 3 ? Effect.fail("stop" as const) : Effect.succeed(sum)
      )),
  });
  const exit = await Effect.runPromiseExit(bad);
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "stop",
  );
  assertEquals(calls, 3);
  const good = Effect.provideService(Stream.runCollect(batches), Add, {
    add: (sum, value) => Effect.succeed(sum + value),
  });
  assertEquals(await Effect.runPromise(good), [3, 7, 5]);
});

Deno.test("aggregate forwards a source failure after completed batches", async () => {
  const seen: number[][] = [];
  const source = Stream.fromArray([1, 2, 3]).pipe(
    Stream.concat(Stream.fail("source-stop" as const)),
  );
  const exit = await Effect.runPromiseExit(
    Stream.aggregate(source, Sink.take<number>(2)).pipe(
      Stream.runForEach((batch) => Effect.sync(() => seen.push(batch))),
    ),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "source-stop",
  );
  assertEquals(seen, [[1, 2], [3]]);
});

Deno.test("aggregate waits for source cleanup after sink failure", async () => {
  const events: string[] = [];
  const source = Stream.scoped(Stream.fromEffect(Effect.acquireRelease(
    Effect.sync(() => {
      events.push("source-acquire");
      return 1;
    }),
    () =>
      Effect.yieldNow.pipe(Effect.andThen(
        Effect.sync(() => events.push("source-release")),
      )),
  )));
  const sink = Sink.foldUntil(
    () => 0,
    2,
    (_sum: number, _value: number) => Effect.fail("sink-stop" as const),
  );
  const exit = await Effect.runPromiseExit(
    Stream.runCollect(Stream.aggregate(source, sink)).pipe(
      Effect.timeout("5 seconds"),
    ),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "sink-stop",
  );
  assertEquals(events, ["source-acquire", "source-release"]);
});

Deno.test("aggregate interruption closes a pending source pull", async () => {
  const events: string[] = [];
  const program = Effect.gen(function* () {
    const pending = yield* Deferred.make<void>();
    const source = Stream.unfold(
      0,
      (n): Effect.Effect<readonly [number, number] | undefined> =>
        n === 0 ? Effect.succeed([1, 1] as const) : Effect.acquireUseRelease(
          Deferred.succeed(pending, undefined),
          () => Effect.never,
          () =>
            Effect.yieldNow.pipe(Effect.andThen(
              Effect.sync(() => events.push("source-release")),
            )),
        ),
    );
    const fiber = yield* Stream.aggregate(source, Sink.take<number>(2)).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(pending);
    yield* Fiber.interrupt(fiber);
    return yield* Effect.exit(Fiber.join(fiber));
  });
  const exit = await Effect.runPromise(
    program.pipe(Effect.timeout("5 seconds")),
  );
  assert(Exit.isFailure(exit));
  assert(Cause.hasInterrupts(exit.cause));
  assertEquals(events, ["source-release"]);
});

Deno.test("early downstream stop does not demand another source pull", async () => {
  let pulls = 0;
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      pulls++;
      return n < 3 ? [n + 1, n + 1] as const : undefined;
    }));
  const first = await Effect.runPromise(
    Stream.aggregate(source, Sink.take<number>(1)).pipe(
      Stream.take(1),
      Stream.runCollect,
    ),
  );
  assertEquals(first, [[1]]);
  assertEquals(pulls, 1);
});

Deno.test("aggregateWithin spaced flushes a pending partial sink on test time", async () => {
  const program = Effect.gen(function* () {
    const firstPull = yield* Deferred.make<void>();
    const source = Stream.unfold(
      0,
      (n): Effect.Effect<readonly [number, number] | undefined> =>
        n === 0
          ? Deferred.succeed(firstPull, undefined).pipe(
            Effect.as([1, 1] as const),
          )
          : Effect.never,
    );
    const fiber = yield* Stream.aggregateWithin(
      source,
      Sink.take<number>(2),
      Schedule.spaced("1 hour"),
    ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
    yield* Deferred.await(firstPull);
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  });
  assertEquals(
    await Effect.runPromise(program.pipe(
      Effect.provide(TestClock.layer()),
      Effect.timeout("5 seconds"),
    )),
    [[1]],
  );
});

Deno.test("aggregateWithin stops upstream when its schedule ends", async () => {
  let pulls = 0;
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      pulls++;
      return n < 3 ? [n + 1, n + 1] as const : undefined;
    }));
  const values = await Effect.runPromise(
    Stream.runCollect(
      Stream.aggregateWithin(source, Sink.take<number>(2), Schedule.recurs(0)),
    ).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(values, [[1]]);
  assertEquals(pulls, 1);
});

Deno.test("an immediate host sink can emit without input progress", async () => {
  const values = await Effect.runPromise(
    Stream.aggregate(Stream.never, Sink.succeed(7)).pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  );
  assertEquals(values, [7, 7, 7]);
});

// Target oracle and proposed type mapping; no new source API is implemented.
// deno test --no-lock docs/plans/sink-leftover-probes/contract.ts
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
  Sink,
  Stream,
} from "npm:effect@4.0.5";

type SourceSink<I, O, E = never, R = never, L = never> = Sink.Sink<
  O,
  I,
  L,
  E,
  R
>;

function transduce<I, O, L extends I, E, R, ES, RS>(
  source: Stream.Stream<I, E, R>,
  sink: SourceSink<I, O, ES, RS, L>,
): Stream.Stream<O, E | ES, R | RS> {
  return Stream.transduce<I, E, R, O, ES, RS>(source, sink);
}

Deno.test("an appended leftover parameter preserves old Sink types and checks replay compatibility", async () => {
  const legacy: SourceSink<number, number[]> = Sink.collect<number>();
  const pairs: SourceSink<number, number[], never, never, number> = Sink.take(
    2,
  );
  // @ts-expect-error A legacy four-argument Sink still has no leftover output.
  const wrongLegacy: SourceSink<number, number[]> = pairs;
  void wrongLegacy;
  const broad: SourceSink<
    string | number,
    (string | number)[],
    never,
    never,
    string | number
  > = Sink.take(2);
  const widened: Stream.Stream<(string | number)[]> = transduce(
    Stream.make("a", "b"),
    broad,
  );
  assertEquals(await Effect.runPromise(Stream.runCollect(widened)), [
    ["a", "b"],
    [],
  ]);
  assertEquals(
    await Effect.runPromise(Stream.run(Stream.make(1, 2, 3), legacy)),
    [1, 2, 3],
  );
  const foreign: SourceSink<number, string, never, never, string> = Sink
    .succeed("result", ["not-input"]);
  // @ts-expect-error String leftovers cannot be replayed into a numeric sink.
  const rejected = transduce(Stream.make(1, 2), foreign);
  void rejected;
  // Terminal execution discards leftovers and imposes no replay compatibility.
  assertEquals(
    await Effect.runPromise(Stream.run(Stream.make(1, 2), foreign)),
    "result",
  );
});

Deno.test("transduction preserves order across chunk boundaries and repeats with fresh state", async () => {
  for (const size of [1, 2, 3, 10]) {
    const batches = transduce(
      Stream.fromArray([1, 2, 3, 4, 5]).pipe(Stream.rechunk(size)),
      Sink.take<number>(2),
    );
    for (let run = 0; run < 2; run++) {
      assertEquals(await Effect.runPromise(Stream.runCollect(batches)), [
        [1, 2],
        [3, 4],
        [5],
      ]);
    }
    assertEquals(
      await Effect.runPromise(Stream.runCollect(transduce(
        Stream.fromArray([1, 2, 3, 4]).pipe(Stream.rechunk(size)),
        Sink.take<number>(2),
      ))),
      [[1, 2], [3, 4], []],
    );
  }
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(transduce(Stream.empty, Sink.take<number>(2))),
    ),
    [[]],
  );
});

Deno.test("leftover batches are emitted before another upstream pull", async () => {
  const events: string[] = [];
  const source = Stream.fromPull(Effect.sync(() => {
    let index = 0;
    return Effect.suspend(() => {
      events.push(`pull:${index}`);
      return index++ === 0
        ? Effect.succeed([1, 2, 3, 4, 5] as const)
        : Cause.done();
    });
  }));
  await Effect.runPromise(
    Stream.runForEach(
      transduce(source, Sink.take<number>(2)),
      (batch) =>
        Effect.sync(() => {
          events.push(`batch:${batch.join(",")}`);
        }),
    ),
  );
  assertEquals(events, [
    "pull:0",
    "batch:1,2",
    "batch:3,4",
    "pull:1",
    "batch:5",
  ]);
});

Deno.test("upstream failure can follow an emitted partial batch", async () => {
  const seen: number[][] = [];
  const source = Stream.concat(
    Stream.make(1, 2, 3),
    Stream.fail("source-stop" as const),
  );
  const exit = await Effect.runPromiseExit(
    Stream.runForEach(
      transduce(source, Sink.take<number>(2)),
      (batch) =>
        Effect.sync(() => {
          seen.push(batch);
        }),
    ),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "source-stop",
  );
  assertEquals(seen, [[1, 2], [3]]);
  const beforeDefect: number[][] = [];
  const defective = Stream.concat(
    Stream.make(1, 2, 3),
    Stream.fromEffect(Effect.die("source-defect")),
  );
  const defect = await Effect.runPromiseExit(
    Stream.runForEach(
      transduce(defective, Sink.take<number>(2)),
      (batch) =>
        Effect.sync(() => {
          beforeDefect.push(batch);
        }),
    ),
  );
  assert(Exit.isFailure(defect) && Cause.hasDies(defect.cause));
  assertEquals(beforeDefect, [[1, 2]]);
});

Deno.test("sink failures and requirements stay deferred and use each consumption's services", async () => {
  class Add extends Context.Service<Add, {
    readonly add: (
      sum: number,
      item: number,
    ) => Effect.Effect<number, "sink-stop">;
  }>()("sink-contract#Add") {}
  let calls = 0;
  const sink: SourceSink<number, number, "sink-stop", Add, number> = Sink
    .foldUntil(
      () => 0,
      2,
      (sum: number, item: number) => Add.use((add) => add.add(sum, item)),
    );
  const batches: Stream.Stream<number, "sink-stop", Add> = transduce(
    Stream.make(1, 2, 3, 4),
    sink,
  );
  assertEquals(calls, 0);
  const seen: number[] = [];
  const exit = await Effect.runPromiseExit(
    Stream.runForEach(batches, (value) =>
      Effect.sync(() => {
        seen.push(value);
      })).pipe(
        Effect.provideService(Add, {
          add: (sum, item) =>
            Effect.suspend(() => {
              calls++;
              return item === 3
                ? Effect.fail("sink-stop" as const)
                : Effect.succeed(sum + item);
            }),
        }),
      ),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "sink-stop",
  );
  assertEquals(seen, [3]);
  assertEquals(calls, 3);
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(batches).pipe(Effect.provideService(Add, {
        add: (sum, item) => Effect.succeed(sum + item * 10),
      })),
    ),
    [30, 70, 0],
  );
});

Deno.test("sink scope finalizers belong to the whole transduction consumption", async () => {
  const events: string[] = [];
  let run = 0;
  const pairs = Sink.take<number>(2);
  const tracked = Sink.fromTransform<number, number[], never, never, number>((
    upstream,
    scope,
  ) =>
    Effect.gen(function* () {
      const current = ++run;
      events.push(`start:${current}`);
      yield* Scope.addFinalizer(
        scope,
        Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
          events.push(`release:${current}`);
        }))),
      );
      return yield* pairs.transform(upstream, scope);
    })
  );
  await Effect.runPromise(
    Stream.runForEach(
      transduce(Stream.make(1, 2, 3), tracked),
      (batch) =>
        Effect.sync(() => {
          events.push(`batch:${batch.join(",")}`);
        }),
    ),
  );
  assertEquals(events, [
    "start:1",
    "batch:1,2",
    "start:2",
    "batch:3",
    "release:2",
    "release:1",
  ]);
});

Deno.test("downstream failure and interruption finish yielding sink finalizers", async () => {
  for (const mode of ["failure", "interruption"] as const) {
    const events: string[] = [];
    const entered = Deferred.makeUnsafe<void>();
    const sink = Sink.fromTransform<number, number[], never, never, number>((
      upstream,
      scope,
    ) =>
      Effect.gen(function* () {
        yield* Scope.addFinalizer(
          scope,
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
            events.push("released");
          }))),
        );
        return yield* Sink.take<number>(2).transform(upstream, scope);
      })
    );
    if (mode === "failure") {
      const exit = await Effect.runPromiseExit(Stream.runForEach(
        transduce(Stream.make(1, 2, 3), sink),
        () => Effect.fail("consumer-stop" as const),
      ));
      assert(Exit.isFailure(exit));
    } else {
      const source = Stream.unfold(
        0,
        (n): Effect.Effect<readonly [number, number]> =>
          n === 0 ? Effect.succeed([1, 1] as const) : Effect.acquireUseRelease(
            Deferred.succeed(entered, undefined),
            () => Effect.never,
            () =>
              Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
                events.push("source-released");
              }))),
          ),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const child = yield* Effect.forkChild(
            Stream.runDrain(
              transduce(source, sink),
            ),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(child);
        }).pipe(Effect.timeout("5 seconds")),
      );
    }
    assertEquals(
      events.sort(),
      mode === "failure" ? ["released"] : ["released", "source-released"],
    );
  }
});

Deno.test("zero-progress host sinks may emit indefinitely without reading the source", async () => {
  let pulls = 0;
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      pulls++;
      return [n, n + 1] as const;
    }));
  const immediate: SourceSink<number, string> = Sink.succeed("tick");
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(transduce(source, immediate).pipe(Stream.take(3))),
    ),
    ["tick", "tick", "tick"],
  );
  assertEquals(pulls, 0);
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(
        Stream.transduce(source, Sink.take<number>(0)).pipe(Stream.take(2)),
      ),
    ),
    [[], []],
  );
  assertEquals(pulls, 0);
});

Deno.test("terminal run discards leftovers and does not run the rest of the producer", async () => {
  let continued = false;
  const source = Stream.concat(
    Stream.make(1, 2, 3, 4, 5),
    Stream.fromEffect(Effect.sync(() => {
      continued = true;
      return 6;
    })),
  );
  assertEquals(
    await Effect.runPromise(Stream.run(source, Sink.take<number>(2))),
    [1, 2],
  );
  assertEquals(continued, false);
});

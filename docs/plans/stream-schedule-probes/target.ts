// deno test --no-lock docs/plans/stream-schedule-probes/target.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Pull,
  Schedule,
  Sink,
  Stream,
} from "npm:effect@4.0.5";

Deno.test("keyed groups consume one source and preserve each key's order", async () => {
  let pulls = 0;
  const source = Stream.unfold(0, (n) =>
    Effect.sync(() => {
      pulls++;
      return n < 6 ? [n, n + 1] as const : undefined;
    }));
  const grouped = source.pipe(
    Stream.groupByKey((n) => n % 3, { bufferSize: 1 }),
    Stream.mapEffect(([key, values]) =>
      Stream.runCollect(values).pipe(
        Effect.map((items) => [key, items] as const),
      ), { concurrency: "unbounded" }),
  );
  assertEquals(pulls, 0);
  for (let run = 0; run < 2; run++) {
    const result = await Effect.runPromise(
      Stream.runCollect(grouped).pipe(Effect.timeout("5 seconds")),
    );
    assertEquals(result.sort((a, b) => a[0] - b[0]), [
      [0, [0, 3]],
      [1, [1, 4]],
      [2, [2, 5]],
    ]);
    assertEquals(pulls, (run + 1) * 7);
  }
});

Deno.test("group consumer failure closes a pending source and peer consumer", async () => {
  const events: string[] = [];
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const a = yield* Deferred.make<void>();
      const b = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<void>();
      const source = Stream.unfold(
        0,
        (n): Effect.Effect<readonly [number, number] | undefined> =>
          n < 2
            ? Effect.succeed([n, n + 1] as const)
            : Effect.acquireUseRelease(
              Deferred.succeed(pending, undefined),
              () => Effect.never,
              () =>
                Effect.yieldNow.pipe(
                  Effect.andThen(
                    Effect.sync(() => events.push("source-release")),
                  ),
                ),
            ),
      );
      return yield* Effect.exit(source.pipe(
        Stream.groupByKey((n) => n),
        Stream.mapEffect(([key]) =>
          Effect.acquireUseRelease(
            Deferred.succeed(key === 0 ? a : b, undefined),
            () =>
              key === 0
                ? Deferred.await(b).pipe(
                  Effect.andThen(Deferred.await(pending)),
                  Effect.andThen(Effect.fail("group-stop")),
                )
                : Deferred.await(a).pipe(Effect.andThen(Effect.never)),
            () =>
              Effect.yieldNow.pipe(
                Effect.andThen(
                  Effect.sync(() => events.push(`group-release:${key}`)),
                ),
              ),
          ), { concurrency: "unbounded" }),
        Stream.runCollect,
      ));
    }).pipe(Effect.timeout("5 seconds")),
  );
  assert(Exit.isFailure(exit));
  assert(Cause.hasFails(exit.cause));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "group-stop",
  );
  assertEquals(events.sort(), [
    "group-release:0",
    "group-release:1",
    "source-release",
  ]);
});

Deno.test("transduction preserves leftovers and emits the final partial sink result", async () => {
  const pairs = Sink.take<number>(2);
  const transduced = Stream.transduce(Stream.fromArray([1, 2, 3, 4, 5]), pairs);
  assertEquals(await Effect.runPromise(Stream.runCollect(transduced)), [
    [1, 2],
    [3, 4],
    [5],
  ]);
  assertEquals(await Effect.runPromise(Stream.runCollect(transduced)), [
    [1, 2],
    [3, 4],
    [5],
  ]);
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(Stream.transduce(Stream.make(1, 2, 3, 4), pairs)),
    ),
    [[1, 2], [3, 4], []],
  );
  assertEquals(
    await Effect.runPromise(
      Stream.runCollect(Stream.transduce(Stream.empty, pairs)),
    ),
    [[]],
  );
});

Deno.test("effectful aggregation retains sink failures and requirements", async () => {
  class Add extends Context.Service<Add, {
    readonly add: (
      sum: number,
      value: number,
    ) => Effect.Effect<number, "sink-stop">;
  }>()("stream-audit#Add") {}
  let calls = 0;
  const batches: Stream.Stream<number, "sink-stop", Add> = Stream.aggregate(
    Stream.fromArray([1, 2, 3, 4, 5]),
    Sink.foldUntil(
      () => 0,
      2,
      (sum: number, value: number) =>
        Add.use((service) => service.add(sum, value)),
    ),
  );
  const live = Layer.succeed(Add)({
    add: (sum, value) =>
      Effect.suspend(() => {
        calls++;
        return value === 3
          ? Effect.fail("sink-stop" as const)
          : Effect.succeed(sum + value);
      }),
  });
  assertEquals(calls, 0);
  const exit = await Effect.runPromiseExit(
    Stream.runCollect(batches).pipe(Effect.provide(live)),
  );
  assert(Exit.isFailure(exit));
  assert(Cause.hasFails(exit.cause));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "sink-stop",
  );
  assertEquals(calls, 3);
});

const limited = (times: number, delay: number) =>
  Schedule.recurs(times).pipe(Schedule.addDelay(() => Effect.succeed(delay)));

Deno.test("schedule max, min and concat have distinct delay and termination rules", async () => {
  const probe = (schedule: Schedule.Schedule<unknown>) =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(schedule);
      const delays: number[] = [];
      for (let index = 0; index < 6; index++) {
        const result = yield* Pull.matchEffect(step(index * 100, undefined), {
          onSuccess: ([, delay]) => Effect.succeed(Duration.toMillis(delay)),
          onDone: () => Effect.succeed(undefined),
          onFailure: Effect.failCause,
        });
        if (result === undefined) return delays;
        delays.push(result);
      }
      throw new Error("schedule did not finish");
    });
  const a = limited(1, 10);
  const b = limited(3, 20);
  assertEquals(await Effect.runPromise(probe(Schedule.max([a, b]))), [20]);
  assertEquals(await Effect.runPromise(probe(Schedule.min([a, b]))), [
    10,
    20,
    20,
  ]);
  assertEquals(await Effect.runPromise(probe(Schedule.concat(a, b))), [
    10,
    20,
    20,
    20,
  ]);
});

Deno.test("a reusable general schedule carries outputs, inputs, failure and service channels", async () => {
  class Policy extends Context.Service<Policy, {
    readonly label: (
      input: string,
      phase: number,
    ) => Effect.Effect<string, "policy-stop">;
  }>()("stream-audit#Policy") {}
  const calls: string[] = [];
  const schedule: Schedule.Schedule<string, string, "policy-stop", Policy> =
    Schedule.concat(
      Schedule.recurs(1),
      Schedule.recurs(1),
    ).pipe(
      Schedule.map((metadata) =>
        Policy.use((policy) => policy.label(metadata.input, metadata.output))
      ),
    );
  const live = Layer.succeed(Policy)({
    label: (input, phase) =>
      Effect.sync(() => {
        calls.push(input);
        return `${input}:${phase}`;
      }).pipe(Effect.flatMap((label) =>
        input === "stop"
          ? Effect.fail("policy-stop" as const)
          : Effect.succeed(label)
      )),
  });
  const run = Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule);
    const [first] = yield* step(0, "a");
    const [second] = yield* step(1, "b");
    const exit = yield* Effect.exit(step(2, "stop"));
    return { first, second, exit };
  }).pipe(Effect.provide(live));
  assertEquals(calls, []);
  const result = await Effect.runPromise(run);
  assertEquals([result.first, result.second], ["a:0", "b:0"]);
  assert(Exit.isFailure(result.exit));
  assert(Cause.hasFails(result.exit.cause));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(result.exit.cause)),
    "policy-stop",
  );
  assertEquals(calls, ["a", "b", "stop"]);
  const repeated = await Effect.runPromise(run);
  assertEquals([repeated.first, repeated.second], ["a:0", "b:0"]);
});

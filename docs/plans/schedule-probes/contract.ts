// deno test --no-lock docs/plans/schedule-probes/contract.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
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

Deno.test("schedule state is fresh and completion is separate from failure", async () => {
  const schedule: Schedule.Schedule<string, string, "schedule-stop"> = Schedule
    .fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<string>) =>
        meta.input === "stop"
          ? Effect.fail("schedule-stop" as const)
          : meta.attempt === 3
          ? Cause.done("complete")
          : Effect.succeed([
            `${meta.input}:${meta.attempt}`,
            Duration.millis(10),
          ] as [string, Duration.Duration])
      ),
    );
  const run = Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule);
    const first = yield* step(100, "a");
    const second = yield* step(110, "b");
    const done = yield* Pull.matchEffect(step(120, "c"), {
      onSuccess: () => Effect.succeed("continued"),
      onDone: (output) => Effect.succeed(output),
      onFailure: Effect.failCause,
    });
    return { first, second, done };
  });
  const expected = {
    first: ["a:1", Duration.millis(10)],
    second: ["b:2", Duration.millis(10)],
    done: "complete",
  };
  assertEquals(await Effect.runPromise(run), expected);
  assertEquals(await Effect.runPromise(run), expected);
  const failure = await Effect.runPromiseExit(Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule);
    return yield* step(100, "stop");
  }));
  assert(Exit.isFailure(failure));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(failure.cause)),
    "schedule-stop",
  );
});

Deno.test("aggregateWithin retains deferred schedule service and completion failure", async () => {
  class Policy extends Context.Service<Policy, {
    readonly check: () => Effect.Effect<string, "schedule-stop">;
  }>()("schedule-contract#Policy") {}
  let calls = 0;
  let pulls = 0;
  const source = Stream.unfold(
    0,
    (n): Effect.Effect<readonly [number, number]> =>
      n === 0
        ? Effect.sync(() => {
          pulls++;
          return [1, 1] as const;
        })
        : Effect.never,
  );
  const schedule: Schedule.Schedule<
    string,
    Option.Option<number[]>,
    "schedule-stop",
    Policy
  > = Schedule.recurs(0).pipe(
    Schedule.map(() => Policy.use((service) => service.check())),
  );
  const batches: Stream.Stream<number[], "schedule-stop", Policy> = Stream
    .aggregateWithin(source, Sink.take<number>(2), schedule);
  const live = Layer.succeed(Policy)({
    check: () =>
      Effect.sync(() => {
        calls++;
        return "done";
      }).pipe(Effect.andThen(Effect.fail("schedule-stop" as const))),
  });
  assertEquals([calls, pulls], [0, 0]);
  for (let run = 1; run <= 2; run++) {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(batches).pipe(
        Effect.provide(live),
        Effect.timeout("5 seconds"),
      ),
    );
    assert(Exit.isFailure(exit));
    assertEquals(
      Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
      "schedule-stop",
    );
    assertEquals([calls, pulls], [run, run]);
  }
});

Deno.test("schedule failure awaits upstream release", async () => {
  const events: string[] = [];
  const source = Stream.scoped(Stream.fromEffect(Effect.acquireRelease(
    Effect.sync(() => {
      events.push("acquire");
      return 1;
    }),
    () =>
      Effect.yieldNow.pipe(Effect.andThen(
        Effect.sync(() => events.push("release")),
      )),
  ))).pipe(Stream.concat(Stream.never));
  const schedule = Schedule.recurs(0).pipe(
    Schedule.map(() => Effect.fail("schedule-stop" as const)),
  );
  const exit = await Effect.runPromiseExit(
    Stream.aggregateWithin(source, Sink.take<number>(2), schedule).pipe(
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  );
  assert(Exit.isFailure(exit));
  assertEquals(
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
    "schedule-stop",
  );
  assertEquals(events, ["acquire", "release"]);
});

Deno.test("aggregateWithin requires a schedule accepting optional sink output", () => {
  const compatible: Schedule.Schedule<
    number,
    Option.Option<number[]>
  > = Schedule.fromStepWithMetadata(
    Effect.succeed(
      (meta: Schedule.InputMetadata<Option.Option<number[]>>) =>
        Effect.succeed([
          Option.isSome(meta.input) ? meta.input.value.length : 0,
          Duration.zero,
        ] as [number, Duration.Duration]),
    ),
  );
  const accepted: Stream.Stream<number[]> = Stream.aggregateWithin(
    Stream.make(1),
    Sink.take<number>(2),
    compatible,
  );
  assert(accepted);
  const incompatible: Schedule.Schedule<number, string> = Schedule
    .fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<string>) =>
        Effect.succeed([meta.input.length, Duration.zero] as [
          number,
          Duration.Duration,
        ])
      ),
    );
  const reject = () => {
    // @ts-expect-error a string-input schedule cannot consume Option<number[]>
    Stream.aggregateWithin(Stream.make(1), Sink.take<number>(2), incompatible);
  };
  assert(reject);
});

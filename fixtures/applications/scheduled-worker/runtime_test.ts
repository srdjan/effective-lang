import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Clock as EffectClock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { InvalidPolicy, JobFailure, type Policy } from "./contracts.ts";
import { makeDriver } from "./driver.ts";
import { nativeWorker } from "./reference.ts";
import { runWorker } from "./worker.ts";

const policy: Policy = { runs: 2, delayMillis: 20, retries: 1, retryMillis: 5 };
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("5 seconds")));

Deno.test("source worker matches native repetition and retry under virtual time, including Effect replay", async () => {
  for (const worker of [runWorker, nativeWorker]) {
    await run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const times: number[] = [];
        const driver = makeDriver({
          execute: (id) =>
            Effect.gen(function* () {
              times.push(yield* EffectClock.currentTimeMillis);
              yield* Deferred.succeed(first, undefined);
              return yield* id % 2 === 1
                ? Effect.fail(new JobFailure({ kind: "Transient", id }))
                : Effect.succeed(id * 10);
            }),
        });
        const program = worker(policy).pipe(Effect.provide(driver.layer));
        assertEquals(driver.events, []);
        for (let replay = 0; replay < 2; replay++) {
          const fiber = yield* Effect.forkChild(program);
          yield* Deferred.await(first);
          yield* TestClock.adjust(100);
          assertEquals(yield* Fiber.join(fiber), {
            completed: 2,
            last: Option.some((replay + 1) * 40),
          });
          assertEquals(driver.active.size, 0);
        }
        assertEquals(times, [0, 5, 25, 30, 100, 105, 125, 130]);
        assertEquals(driver.attempts, 8);
        const jobs = driver.events.filter((event) => !event.startsWith("wait"));
        assertEquals(
          jobs,
          Array.from({ length: 8 }, (_, n) => [
            `open:${n + 1}`,
            `acquired:${n + 1}`,
            `execute:${n + 1}`,
            `close:${n + 1}`,
            `released:${n + 1}`,
          ]).flat(),
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );
  }
});

Deno.test("zero jobs are inert and policy validation precedes the zero-job branch", async () => {
  const driver = makeDriver();
  assertEquals(
    await run(
      runWorker({ ...policy, runs: 0 }).pipe(Effect.provide(driver.layer)),
    ),
    { completed: 0, last: Option.none() },
  );
  for (
    const input of [{ ...policy, runs: 0, delayMillis: -1 }, {
      ...policy,
      retries: -1,
    }]
  ) {
    const error = failure(
      await Effect.runPromiseExit(
        runWorker(input).pipe(Effect.provide(driver.layer)),
      ),
    );
    assert(error instanceof InvalidPolicy);
  }
  for (
    const input of [{ ...policy, runs: "2" }, { ...policy, retries: 0.5 }, {}]
  ) {
    const error = failure(
      await Effect.runPromiseExit(
        runWorker(input).pipe(Effect.provide(driver.layer)),
      ),
    );
    assert(error instanceof Schema.SchemaError);
  }
  assertEquals(driver.events, []);
});

Deno.test("zero retries, exhaustion and permanent failures retain the typed failure and close each attempt", async () => {
  for (
    const [kind, retries, expected] of [["Transient", 0, 1], [
      "Transient",
      2,
      3,
    ], ["Fatal", 2, 1]] as const
  ) {
    const driver = makeDriver({
      execute: (id) => Effect.fail(new JobFailure({ kind, id })),
    });
    const exit = await run(
      Effect.exit(
        runWorker({ ...policy, retries, retryMillis: 0 }).pipe(
          Effect.provide(driver.layer),
        ),
      ),
    );
    const error = failure(exit);
    assert(error instanceof JobFailure);
    assertEquals(error.kind, kind);
    assertEquals(driver.attempts, expected);
    assertEquals(driver.active.size, 0);
    assertEquals(
      driver.events.filter((event) => event.startsWith("released:")).length,
      expected,
    );
    assert(!driver.events.some((event) => event.startsWith("wait:")));
  }
});

Deno.test("acquisition failure never releases an absent resource", async () => {
  const driver = makeDriver({
    open: (id) => Effect.fail(new JobFailure({ kind: "Fatal", id })),
  });
  const error = failure(
    await run(
      Effect.exit(runWorker(policy).pipe(Effect.provide(driver.layer))),
    ),
  );
  assert(error instanceof JobFailure);
  assertEquals(driver.events, ["open:1"]);
  assertEquals(driver.active.size, 0);
});

Deno.test("execution and release defects retain their channel and bypass typed retries", async () => {
  for (
    const options of [{ execute: () => Effect.die("execution") }, {
      close: () => Effect.die("release"),
    }]
  ) {
    const driver = makeDriver(options);
    const exit = await run(
      Effect.exit(runWorker(policy).pipe(Effect.provide(driver.layer))),
    );
    assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    assert(Option.isNone(Cause.findErrorOption(exit.cause)));
    assertEquals(driver.opened, 1);
    assertEquals(driver.active.size, 0);
    assertEquals(driver.events.at(-1), "released:1");
  }
});

Deno.test("shutdown during work waits behind a blocked source-owned release", async () => {
  await run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const releasing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let workClosed = false;
    let interrupted = false;
    const driver = makeDriver({
      execute: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            workClosed = true;
          })),
        ),
      close: () =>
        Deferred.succeed(releasing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
    });
    const fiber = yield* Effect.forkChild(
      runWorker(policy).pipe(Effect.provide(driver.layer)),
    );
    yield* Deferred.await(entered);
    const closing = yield* Effect.forkChild(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Effect.sync(() => {
        interrupted = true;
      }))),
    );
    yield* Deferred.await(releasing);
    yield* Effect.yieldNow;
    yield* Effect.sync(() => {
      assertEquals(
        [workClosed, interrupted, driver.active.size, driver.attempts],
        [true, false, 1, 1],
      );
      assertEquals(driver.events.at(-1), "close:1");
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(closing);
    const exit = yield* Fiber.await(fiber);
    assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assertEquals([interrupted, driver.active.size, driver.attempts], [
      true,
      0,
      1,
    ]);
    assert(!driver.events.some((event) => event.startsWith("wait:")));
  }));
});

Deno.test("shutdown during a repetition delay closes the wait and starts no later job", async () => {
  await run(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let waitClosed = false;
    const driver = makeDriver({
      wait: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            waitClosed = true;
          })),
        ),
    });
    const fiber = yield* Effect.forkChild(
      runWorker(policy).pipe(Effect.provide(driver.layer)),
    );
    yield* Deferred.await(entered);
    assertEquals(driver.active.size, 0);
    yield* Fiber.interrupt(fiber);
    assertEquals([waitClosed, driver.attempts, driver.events.at(-1)], [
      true,
      1,
      "wait-closed:20",
    ]);
  }));
});

Deno.test("shutdown during a native retry delay closes its clock operation without another attempt", async () => {
  await run(Effect.gen(function* () {
    const entered = yield* Deferred.make<number>();
    const clock = yield* EffectClock.Clock;
    let waitClosed = false;
    const observed: EffectClock.Clock = {
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) =>
        Deferred.succeed(entered, Duration.toMillis(duration)).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            waitClosed = true;
          })),
        ),
    };
    const driver = makeDriver({
      execute: (id) => Effect.fail(new JobFailure({ kind: "Transient", id })),
    });
    const fiber = yield* Effect.forkChild(
      runWorker({ ...policy, retryMillis: 1000 }).pipe(
        Effect.provide(driver.layer),
        Effect.provideService(EffectClock.Clock, observed),
      ),
    );
    assertEquals(yield* Deferred.await(entered), 1000);
    assertEquals(driver.active.size, 0);
    yield* Fiber.interrupt(fiber);
    assertEquals([waitClosed, driver.attempts], [true, 1]);
    assert(!driver.events.some((event) => event.startsWith("wait:")));
  }));
});

Deno.test("a failed attempt finishes release before retrying", async () => {
  await run(Effect.gen(function* () {
    const releasing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const driver = makeDriver({
      execute: (id) =>
        id === 1
          ? Effect.fail(new JobFailure({ kind: "Transient", id }))
          : Effect.succeed(id * 10),
      close: (id) =>
        id === 1
          ? Deferred.succeed(releasing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )
          : Effect.void,
    });
    const fiber = yield* Effect.forkChild(
      runWorker({ ...policy, runs: 1, retryMillis: 0 }).pipe(
        Effect.provide(driver.layer),
      ),
    );
    yield* Deferred.await(releasing);
    yield* Effect.yieldNow;
    assertEquals([driver.opened, driver.attempts, driver.active.size], [
      1,
      1,
      1,
    ]);
    yield* Deferred.succeed(release, undefined);
    assertEquals(yield* Fiber.join(fiber), {
      completed: 1,
      last: Option.some(20),
    });
    assertEquals(driver.active.size, 0);
    assertEquals(
      driver.events.indexOf("released:1") < driver.events.indexOf("open:2"),
      true,
    );
  }));
});

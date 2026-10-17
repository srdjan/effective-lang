// Target probe for Phase 6 bounded traversal. Run with:
// deno test --no-lock docs/plans/phase6-probes/bounded.ts
import { Deferred, Effect, Exit, Fiber } from "npm:effect@4.0.5";

Deno.test("bounded traversal has at most two active jobs and keeps input order", async () => {
  let active = 0;
  let maximum = 0;
  const values = await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Effect.forEach(
      [0, 1, 2, 3],
      () => Deferred.make<void>(),
    );
    const gates = yield* Effect.forEach(
      [0, 1, 2, 3],
      () => Deferred.make<void>(),
    );
    const jobs = Effect.forEach(
      [1, 2, 3, 4],
      (n) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            active++;
            maximum = Math.max(maximum, active);
            return n;
          }),
          () =>
            Deferred.succeed(started[n - 1], undefined).pipe(
              Effect.andThen(Deferred.await(gates[n - 1])),
              Effect.as(n * 2),
            ),
          () => Effect.sync(() => active--).pipe(Effect.asVoid),
        ),
      { concurrency: 2 },
    );
    const fiber = yield* Effect.forkChild(jobs);
    yield* Deferred.await(started[0]);
    yield* Deferred.await(started[1]);
    if (active !== 2) {
      throw new Error(`expected two active jobs, got ${active}`);
    }
    yield* Deferred.succeed(gates[1], undefined);
    yield* Deferred.await(started[2]);
    yield* Deferred.succeed(gates[0], undefined);
    yield* Deferred.await(started[3]);
    yield* Deferred.succeed(gates[3], undefined);
    yield* Deferred.succeed(gates[2], undefined);
    return yield* Fiber.join(fiber);
  }));
  if (maximum !== 2 || active !== 0 || values.join(",") !== "2,4,6,8") {
    throw new Error(
      `unexpected bounded result: max=${maximum}, active=${active}, values=${values}`,
    );
  }
});

Deno.test("failure interrupts a running sibling and does not start a queued job", async () => {
  const started: number[] = [];
  const released: number[] = [];
  const failure = { _tag: "Stop" } as const;
  const exit = await Effect.runPromise(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fail = yield* Deferred.make<void>();
    const jobs = Effect.forEach(
      [1, 2, 3],
      (n) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            started.push(n);
            return n;
          }),
          () =>
            n === 2
              ? Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Deferred.await(fail)),
                Effect.andThen(Effect.fail(failure)),
              )
              : Effect.never,
          () =>
            Effect.sync(() => {
              released.push(n);
            }),
        ),
      { concurrency: 2 },
    );
    const fiber = yield* Effect.forkChild(jobs);
    yield* Deferred.await(ready);
    yield* Deferred.succeed(fail, undefined);
    return yield* Fiber.await(fiber);
  }));
  if (
    !Exit.isFailure(exit) || started.join(",") !== "1,2" ||
    released.length !== 2 || !released.includes(1) || !released.includes(2)
  ) {
    throw new Error(
      `unexpected failure trace: started=${started}, released=${released}`,
    );
  }
});

Deno.test("interrupting the traversal waits for both active finalizers", async () => {
  const started: number[] = [];
  const released: number[] = [];
  await Effect.runPromise(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const jobs = Effect.forEach(
      [1, 2, 3],
      (n) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            started.push(n);
            return n;
          }),
          () =>
            n === 2
              ? Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Effect.never),
              )
              : Effect.never,
          () =>
            Effect.sync(() => {
              released.push(n);
            }),
        ),
      { concurrency: 2 },
    );
    const fiber = yield* Effect.forkChild(jobs);
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
  }));
  if (
    started.join(",") !== "1,2" || released.length !== 2 ||
    !released.includes(1) || !released.includes(2)
  ) {
    throw new Error(
      `unexpected interruption trace: started=${started}, released=${released}`,
    );
  }
});

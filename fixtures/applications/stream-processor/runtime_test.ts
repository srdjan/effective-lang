import { assert, assertEquals } from "@std/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { InputFailure, OutputFailure, TransformFailure } from "./contracts.ts";
import { makeDriver, sampleItems, type Session } from "./driver.ts";
import { runProcessor } from "./processor.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("5 seconds")));
const program = (driver: ReturnType<typeof makeDriver>) =>
  runProcessor().pipe(Effect.provide(driver.layer));
const clean = (driver: ReturnType<typeof makeDriver>) => {
  assertEquals(driver.activeSessions.size, 0);
  assertEquals(driver.activeOperations.size, 0);
  assertEquals(driver.activeTransforms.size, 0);
  assertEquals(driver.events.slice(-4), [
    "close:output",
    "closed:output",
    "close:input",
    "closed:input",
  ]);
};
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};
const ids = (driver: ReturnType<typeof makeDriver>) =>
  driver.batches.map((batch) => batch.map((item) => item.id));

Deno.test("processor defers operations and writes ordered full and partial batches", async () => {
  const driver = makeDriver();
  const effect = program(driver);
  assertEquals(driver.events, []);
  await run(effect);
  assertEquals(ids(driver), [[1, 2], [3, 4], [5]]);
  assertEquals(driver.batches.flat().map((item) => item.value), [
    10,
    20,
    30,
    40,
    50,
  ]);
  assert(driver.batches.flat().every((item) => !item.recovered));
  assertEquals(driver.pulls, [0, 1, 2, 3, 4, 5]);
  clean(driver);
});

Deno.test("empty and exact inputs suppress native transduction's empty terminal batch", async () => {
  for (const count of [0, 1, 4]) {
    const driver = makeDriver({ items: sampleItems(count) });
    await run(program(driver));
    assertEquals(
      ids(driver),
      count === 0 ? [] : count === 1 ? [[1]] : [[1, 2], [3, 4]],
    );
    clean(driver);
  }
});

Deno.test("replaying one processor Effect opens fresh sessions and resets pull progress", async () => {
  const driver = makeDriver({ items: sampleItems(3) });
  const effect = program(driver);
  await run(effect);
  await run(effect);
  assertEquals(ids(driver), [[1, 2], [3], [1, 2], [3]]);
  assertEquals(driver.pulls, [0, 1, 2, 3, 0, 1, 2, 3]);
  assertEquals(driver.opened, 4);
  clean(driver);
});

Deno.test("live input can wait for later arrivals without ending or writing a partial batch", async () => {
  await run(
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const arrived = yield* Deferred.make<void>();
      const driver = makeDriver({
        items: sampleItems(3),
        next: (index) =>
          index === 1
            ? Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Deferred.await(arrived)),
            )
            : Effect.void,
      });
      const fiber = yield* Effect.forkChild(program(driver));
      yield* Deferred.await(waiting);
      yield* TestClock.adjust(0);
      yield* Effect.sync(() => {
        assertEquals(driver.batches, []);
        assertEquals(driver.activeSessions.size, 2);
      }).pipe(Effect.ensuring(Deferred.succeed(arrived, undefined)));
      yield* Fiber.join(fiber);
      assertEquals(ids(driver), [[1, 2], [3]]);
      clean(driver);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

Deno.test("two transformations finish out of order while output retains input order", async () => {
  await run(
    Effect.gen(function* () {
      const second = yield* Deferred.make<void>();
      const first = yield* Deferred.make<void>();
      const driver = makeDriver({
        transform: (item) =>
          item.id === 1
            ? Deferred.await(first).pipe(Effect.as(item.value * 10))
            : item.id === 2
            ? Deferred.succeed(second, undefined).pipe(
              Effect.as(item.value * 10),
            )
            : Effect.succeed(item.value * 10),
      });
      const fiber = yield* Effect.forkChild(program(driver));
      yield* Deferred.await(second);
      yield* TestClock.adjust(0);
      yield* Effect.sync(() => {
        assertEquals(driver.completed, [2]);
        assertEquals(driver.batches, []);
        assertEquals(driver.maximumTransforms, 2);
      }).pipe(Effect.ensuring(Deferred.succeed(first, undefined)));
      yield* Fiber.join(fiber);
      assertEquals(driver.completed.slice(0, 2), [2, 1]);
      assertEquals(ids(driver), [[1, 2], [3, 4], [5]]);
      assertEquals(driver.maximumTransforms, 2);
      clean(driver);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

Deno.test("blocked output stops upstream progress and resumed demand drains the remaining input", async () => {
  await run(
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const driver = makeDriver({
        items: sampleItems(100),
        write: (batch) =>
          batch[0]?.id === 1
            ? Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
            )
            : Effect.void,
      });
      const fiber = yield* Effect.forkChild(program(driver));
      yield* Deferred.await(writing);
      yield* TestClock.adjust(0);
      const paused = [...driver.pulls];
      yield* TestClock.adjust(0);
      yield* Effect.sync(() => {
        console.log("paused pulls", paused);
        assert(paused.length >= 2 && paused.length < 100);
        assertEquals(driver.pulls, paused);
        assertEquals(driver.batches, []);
      }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      yield* Fiber.join(fiber);
      assertEquals(driver.pulls.length, 101);
      assertEquals(
        driver.batches.flat().map((item) => item.id),
        sampleItems(100).map((item) => item.id),
      );
      assertEquals(driver.maximumTransforms <= 2, true);
      clean(driver);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

Deno.test("recoverable transformation errors produce marked fallbacks without retry or input restart", async () => {
  const driver = makeDriver({
    transform: (item) =>
      item.id === 2
        ? Effect.fail(
          new TransformFailure({ kind: "Recoverable", id: item.id }),
        )
        : Effect.succeed(item.value * 10),
  });
  await run(program(driver));
  assertEquals(ids(driver), [[1, 2], [3, 4], [5]]);
  assertEquals(driver.batches[0]?.[1], { id: 2, value: 2, recovered: true });
  assertEquals(
    driver.events.filter((event) => event === "transform:2").length,
    1,
  );
  assertEquals(driver.pulls, [0, 1, 2, 3, 4, 5]);
  clean(driver);
});

Deno.test("later input failure propagates after previously emitted full and partial batches", async () => {
  const written = Deferred.makeUnsafe<void>();
  const driver = makeDriver({
    next: (index) =>
      index === 3
        ? Deferred.await(written).pipe(
          Effect.andThen(Effect.fail(new InputFailure({ stage: "read" }))),
        )
        : Effect.void,
    write: () => Deferred.succeed(written, undefined).pipe(Effect.asVoid),
  });
  const error = failure(await run(Effect.exit(program(driver))));
  assert(error instanceof InputFailure);
  assertEquals(ids(driver), [[1, 2], [3]]);
  clean(driver);
});

Deno.test("fatal transformations and output failures cancel pending peers before session closure", async () => {
  for (const broken of ["transform", "output"]) {
    const peer = Deferred.makeUnsafe<void>();
    const driver = makeDriver({
      items: sampleItems(100),
      next: (index) =>
        broken === "output" && index === 5
          ? Deferred.succeed(peer, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      transform: (item) =>
        broken === "transform"
          ? item.id === 1
            ? Deferred.await(peer).pipe(
              Effect.andThen(
                Effect.fail(new TransformFailure({ kind: "Fatal", id: 1 })),
              ),
            )
            : Deferred.succeed(peer, undefined).pipe(
              Effect.andThen(Effect.never),
            )
          : Effect.succeed(item.value * 10),
      write: () =>
        broken === "output"
          ? Deferred.await(peer).pipe(
            Effect.andThen(Effect.fail(new OutputFailure({ stage: "write" }))),
          )
          : Effect.void,
    });
    const error = failure(await run(Effect.exit(program(driver))));
    assert(
      broken === "transform"
        ? error instanceof TransformFailure
        : error instanceof OutputFailure,
    );
    assertEquals(driver.batches, []);
    const close = driver.events.indexOf("close:output");
    for (
      const event of driver.events.filter((event) =>
        event.startsWith("transformed:") || event.startsWith("done:pull:")
      )
    ) {
      assert(driver.events.indexOf(event) < close, event);
    }
    clean(driver);
  }
});

Deno.test("failed acquisition closes only sessions that were acquired", async () => {
  const input = makeDriver({
    openInput: () => Effect.fail(new InputFailure({ stage: "open" })),
  });
  assert(
    failure(await run(Effect.exit(program(input)))) instanceof InputFailure,
  );
  assertEquals(input.events, ["open:input"]);
  const output = makeDriver({
    openOutput: () => Effect.fail(new OutputFailure({ stage: "open" })),
  });
  assert(
    failure(await run(Effect.exit(program(output)))) instanceof OutputFailure,
  );
  assertEquals(output.events, [
    "open:input",
    "opened:input:1",
    "open:output",
    "close:input",
    "closed:input",
  ]);
  assertEquals(output.activeSessions.size, 0);
});

Deno.test("cancellation of pending input or output awaits each blocked session finalizer", async () => {
  for (const pending of ["input", "output"]) {
    for (const blocked of ["input", "output"] as const) {
      const finish = Deferred.makeUnsafe<void>();
      await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const closing = yield* Deferred.make<void>();
          let interrupted = false;
          const wait = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
          );
          const driver = makeDriver({
            next: () => pending === "input" ? wait : Effect.void,
            write: () => pending === "output" ? wait : Effect.void,
            close: (session) =>
              session === blocked
                ? Deferred.succeed(closing, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                )
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(program(driver));
          yield* Deferred.await(entered);
          const shutdown = yield* Effect.forkChild(
            Fiber.interrupt(fiber).pipe(Effect.andThen(Effect.sync(() => {
              interrupted = true;
            }))),
          );
          yield* Deferred.await(closing);
          yield* Effect.yieldNow;
          yield* Effect.sync(() => {
            assertEquals(interrupted, false);
            assertEquals(
              driver.activeSessions.size,
              blocked === "output" ? 2 : 1,
            );
            assertEquals(driver.activeTransforms.size, 0);
            assertEquals(driver.activeOperations.size, 0);
            assertEquals(driver.batches, []);
          }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)));
          yield* Fiber.join(shutdown);
          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
          clean(driver);
        }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined))),
      );
    }
  }
});

Deno.test("execution and session cleanup defects remain defects and remaining finalizers run", async () => {
  for (const broken of ["transform", "output", "input"]) {
    const driver = makeDriver({
      transform: (item) =>
        broken === "transform"
          ? Effect.die("transform defect")
          : Effect.succeed(item.value * 10),
      close: (session: Session) =>
        session === broken ? Effect.die("close defect") : Effect.void,
    });
    const exit = await run(Effect.exit(program(driver)));
    assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    assert(Option.isNone(Cause.findErrorOption(exit.cause)));
    clean(driver);
  }
});

Deno.test("item recovery follows native catchTags and does not preserve arbitrary mixed transform causes", async () => {
  const broken = () =>
    Effect.fail(new TransformFailure({ kind: "Recoverable", id: 1 })).pipe(
      Effect.ensuring(Effect.die("accompanying defect")),
    );
  const expected = await run(
    broken().pipe(Effect.catchTags({
      "contracts#TransformFailure": () =>
        Effect.succeed({ id: 1, value: 1, recovered: true }),
    })),
  );
  const driver = makeDriver({ items: sampleItems(1), transform: broken });
  await run(program(driver));
  assertEquals(driver.batches, [[expected]]);
  clean(driver);
});

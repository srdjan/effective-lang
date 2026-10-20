import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Clock as EffectClock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { CatalogFailure, InvalidOrder, StoreFailure } from "./contracts.ts";
import { makeDriver, sqlFailure } from "./driver.ts";
import { submit } from "./workflow.ts";

const request = { sku: "book", quantity: 2 };
const receipt = { sku: "book", quantity: 2, total: 24 };
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("5 seconds")));
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert(Option.isSome(error));
  return error.value;
};

Deno.test("service workflow returns a validated receipt and commits a parameterized statement", async () => {
  const driver = makeDriver();
  const operation = submit(request).pipe(Effect.provide(driver.layer));
  assertEquals(driver.events, []);
  assertEquals(await run(operation), receipt);
  assertEquals(driver.committed, [receipt]);
  assertEquals(driver.events, [
    "quote:book",
    "connect",
    "lease:1",
    "leased:1",
    "begin:1",
    "write:1",
    "commit:1",
    "release:1",
    "released:1",
  ]);
  assertEquals(driver.statements[0]?.params, ["book", 2, 24]);
  assertEquals(driver.statements[0]?.sql.includes("'book'"), false);
  assertEquals([driver.active.size, driver.staged.size], [0, 0]);
});

Deno.test("invalid requests fail before any service or provider is invoked", async () => {
  const driver = makeDriver();
  for (
    const input of [{}, { sku: "book", quantity: "2" }, {
      sku: "book",
      quantity: 1.5,
    }]
  ) {
    const error = failure(
      await run(Effect.exit(submit(input).pipe(Effect.provide(driver.layer)))),
    );
    assert(error instanceof Schema.SchemaError);
  }
  for (
    const input of [{ sku: "", quantity: 2 }, { sku: "book", quantity: 0 }, {
      sku: "book",
      quantity: 101,
    }]
  ) {
    const error = failure(
      await run(Effect.exit(submit(input).pipe(Effect.provide(driver.layer)))),
    );
    assert(error instanceof InvalidOrder && error.reason === "request");
  }
  assertEquals(driver.events, []);
});

Deno.test("catalog rejection and invalid prices start no transaction", async () => {
  for (const value of [-1, 100001, 1.5, undefined]) {
    const driver = makeDriver({
      price: (sku) =>
        value === undefined
          ? Effect.fail(new CatalogFailure({ sku }))
          : Effect.succeed(value),
    });
    const error = failure(
      await run(
        Effect.exit(submit(request).pipe(Effect.provide(driver.layer))),
      ),
    );
    assert(
      value === -1 || value === 100001
        ? error instanceof InvalidOrder
        : error instanceof CatalogFailure,
    );
    assertEquals(driver.events, ["quote:book"]);
  }
});

Deno.test("transient writes retry at five and ten milliseconds and replay gets a fresh budget", async () => {
  await run(
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const times: number[] = [];
      const driver = makeDriver({
        execute: (phase, id) =>
          Effect.gen(function* () {
            if (phase === "write") {
              times.push(yield* EffectClock.currentTimeMillis);
              yield* Deferred.succeed(first, undefined);
              if (id % 3 !== 0) {
                return yield* Effect.fail(sqlFailure(true, "write"));
              }
            }
          }),
      });
      const program = submit(request).pipe(Effect.provide(driver.layer));
      for (let replay = 0; replay < 2; replay++) {
        const fiber = yield* Effect.forkChild(program);
        yield* Deferred.await(first);
        yield* TestClock.adjust(100);
        assertEquals(yield* Fiber.join(fiber), receipt);
      }
      assertEquals(times, [0, 5, 15, 100, 105, 115]);
      assertEquals(driver.committed, [receipt, receipt]);
      assertEquals(
        driver.events.filter((event) => event === "quote:book").length,
        2,
      );
      assertEquals(
        driver.events.filter((event) => event === "connect").length,
        2,
      );
      assertEquals(
        driver.events.filter((event) => event.startsWith("rollback:")).length,
        4,
      );
      for (let id = 1; id < 6; id++) {
        assert(
          driver.events.indexOf(`released:${id}`) <
            driver.events.indexOf(`lease:${id + 1}`),
        );
      }
      assertEquals([driver.leases, driver.active.size, driver.staged.size], [
        6,
        0,
        0,
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

Deno.test("retry exhaustion and permanent write errors roll back and release without another catalog call", async () => {
  for (const retryable of [true, false]) {
    const driver = makeDriver({
      execute: (phase) =>
        phase === "write"
          ? Effect.fail(sqlFailure(retryable, "write"))
          : Effect.void,
    });
    const error = failure(
      await run(
        Effect.exit(submit(request).pipe(Effect.provide(driver.layer))),
      ),
    );
    assert(error instanceof StoreFailure);
    assertEquals(error.kind, retryable ? "Transient" : "Permanent");
    assertEquals(driver.leases, retryable ? 3 : 1);
    assertEquals(driver.committed, []);
    assertEquals(
      driver.events.filter((event) => event === "quote:book").length,
      1,
    );
    assertEquals(
      driver.events.filter((event) => event.startsWith("released:")).length,
      driver.leases,
    );
    assertEquals([driver.active.size, driver.staged.size], [0, 0]);
  }
});

Deno.test("provider and lease failures remain permanent and release no absent connection", async () => {
  const provider = makeDriver({
    connect: () =>
      Effect.fail(new StoreFailure({ kind: "Transient", stage: "driver" })),
  });
  const providerError = failure(
    await run(
      Effect.exit(submit(request).pipe(Effect.provide(provider.layer))),
    ),
  );
  assert(
    providerError instanceof StoreFailure &&
      providerError.kind === "Permanent" && providerError.stage === "provider",
  );
  assertEquals(provider.events, ["quote:book", "connect"]);
  const lease = makeDriver({
    lease: () => Effect.fail(sqlFailure(true, "lease")),
  });
  const leaseError = failure(
    await run(Effect.exit(submit(request).pipe(Effect.provide(lease.layer)))),
  );
  assert(leaseError instanceof StoreFailure && leaseError.kind === "Permanent");
  assertEquals(lease.events, ["quote:book", "connect", "lease:1"]);
  assertEquals(lease.active.size, 0);
});

Deno.test("BEGIN failures release their connection without running the write", async () => {
  const driver = makeDriver({
    execute: (phase) =>
      phase === "begin" ? Effect.fail(sqlFailure(true, "begin")) : Effect.void,
  });
  const error = failure(
    await run(Effect.exit(submit(request).pipe(Effect.provide(driver.layer)))),
  );
  assert(error instanceof StoreFailure && error.kind === "Permanent");
  assertEquals(driver.statements, []);
  assertEquals(driver.events.slice(2), [
    "lease:1",
    "leased:1",
    "begin:1",
    "release:1",
    "released:1",
  ]);
  assertEquals(driver.active.size, 0);
});

Deno.test("malformed receipt rows roll back staged writes", async () => {
  for (const rows of [[], [{ ...receipt, total: "24" }]]) {
    const driver = makeDriver({ rows: () => rows });
    const error = failure(
      await run(
        Effect.exit(submit(request).pipe(Effect.provide(driver.layer))),
      ),
    );
    assert(
      error instanceof StoreFailure && error.kind === "Permanent" &&
        error.stage === "row",
    );
    assertEquals(driver.events.slice(-3), [
      "rollback:1",
      "release:1",
      "released:1",
    ]);
    assertEquals(driver.committed, []);
    assertEquals([driver.active.size, driver.staged.size], [0, 0]);
  }
});

Deno.test("commit errors cannot become transient write retries even with misleading metadata", async () => {
  const driver = makeDriver({
    execute: (phase) =>
      phase === "commit" ? Effect.fail(sqlFailure(true, "write")) : Effect.void,
  });
  const error = failure(
    await run(Effect.exit(submit(request).pipe(Effect.provide(driver.layer)))),
  );
  assert(error instanceof StoreFailure && error.kind === "Permanent");
  assertEquals(driver.leases, 1);
  assertEquals(driver.events.slice(-3), [
    "commit:1",
    "release:1",
    "released:1",
  ]);
  assertEquals(driver.committed, []);
  assertEquals([driver.active.size, driver.staged.size], [0, 0]);
});

Deno.test("execution defects roll back and bypass typed retries", async () => {
  const driver = makeDriver({
    execute: (phase) =>
      phase === "write" ? Effect.die("write defect") : Effect.void,
  });
  const exit = await run(
    Effect.exit(submit(request).pipe(Effect.provide(driver.layer))),
  );
  assert(
    Exit.isFailure(exit) && Cause.hasDies(exit.cause) &&
      Option.isNone(Cause.findErrorOption(exit.cause)),
  );
  assertEquals(driver.leases, 1);
  assertEquals(driver.events.slice(-3), [
    "rollback:1",
    "release:1",
    "released:1",
  ]);
  assertEquals(driver.committed, []);
});

Deno.test("cleanup defects preserve a simultaneous transient body failure and prevent retry", async () => {
  for (const broken of ["rollback", "release"]) {
    const driver = makeDriver({
      execute: (phase) =>
        phase === "write"
          ? Effect.fail(sqlFailure(true, "write"))
          : phase === broken
          ? Effect.fail(sqlFailure(false, "rollback"))
          : Effect.void,
      release: () =>
        broken === "release" ? Effect.die("release defect") : Effect.void,
    });
    const exit = await run(
      Effect.exit(submit(request).pipe(Effect.provide(driver.layer))),
    );
    assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    const error = failure(exit);
    assert(error instanceof StoreFailure && error.kind === "Transient");
    assertEquals(driver.leases, 1);
    assertEquals(driver.committed, []);
    assertEquals([driver.active.size, driver.staged.size], [0, 0]);
  }
});

Deno.test("body cancellation waits for blocked rollback or release and commits no staged rows", async () => {
  for (const blocked of ["rollback", "release"]) {
    const finish = Deferred.makeUnsafe<void>();
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        let interrupted = false;
        const cleanup = Deferred.succeed(cleaning, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
        );
        const driver = makeDriver({
          execute: (phase) =>
            phase === "write"
              ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
              )
              : phase === blocked
              ? cleanup
              : Effect.void,
          release: () => blocked === "release" ? cleanup : Effect.void,
        });
        const fiber = yield* Effect.forkChild(
          submit(request).pipe(Effect.provide(driver.layer)),
        );
        yield* Deferred.await(entered);
        const stagedBeforeShutdown = driver.staged.size;
        const closing = yield* Effect.forkChild(
          Fiber.interrupt(fiber).pipe(Effect.andThen(Effect.sync(() => {
            interrupted = true;
          }))),
        );
        yield* Deferred.await(cleaning);
        yield* Effect.yieldNow;
        yield* Effect.sync(() => {
          assertEquals(stagedBeforeShutdown, 1);
          assertEquals([interrupted, driver.active.size, driver.staged.size], [
            false,
            1,
            blocked === "rollback" ? 1 : 0,
          ]);
          assertEquals(driver.committed, []);
        }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)));
        yield* Fiber.join(closing);
        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        assertEquals([driver.active.size, driver.staged.size, driver.leases], [
          0,
          0,
          1,
        ]);
        assertEquals(driver.events.slice(-3), [
          "rollback:1",
          "release:1",
          "released:1",
        ]);
        assertEquals(driver.committed, []);
      }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined))),
    );
  }
});

Deno.test("cancellation during either retry delay prevents a later transaction", async () => {
  for (const afterAttempt of [1, 2]) {
    await run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const driver = makeDriver({
          execute: (phase) =>
            phase === "write"
              ? Effect.fail(sqlFailure(true, "write"))
              : Effect.void,
          release: (id) =>
            id === 1
              ? Deferred.succeed(first, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const fiber = yield* Effect.forkChild(
          submit(request).pipe(Effect.provide(driver.layer)),
        );
        yield* Deferred.await(first);
        yield* TestClock.adjust(afterAttempt === 1 ? 0 : 5);
        assertEquals([driver.leases, driver.active.size, driver.staged.size], [
          afterAttempt,
          0,
          0,
        ]);
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(1000);
        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        assertEquals(driver.leases, afterAttempt);
        assertEquals(driver.committed, []);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  }
});

Deno.test("interruption after commit begins waits for commit and release without promising rollback", async () => {
  const finish = Deferred.makeUnsafe<void>();
  await run(
    Effect.gen(function* () {
      const committing = yield* Deferred.make<void>();
      let interrupted = false;
      const driver = makeDriver({
        execute: (phase) =>
          phase === "commit"
            ? Deferred.succeed(committing, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
            )
            : Effect.void,
      });
      const fiber = yield* Effect.forkChild(
        submit(request).pipe(Effect.provide(driver.layer)),
      );
      yield* Deferred.await(committing);
      const closing = yield* Effect.forkChild(
        Fiber.interrupt(fiber).pipe(Effect.andThen(Effect.sync(() => {
          interrupted = true;
        }))),
      );
      yield* Effect.yieldNow;
      yield* Effect.sync(() => {
        assertEquals([interrupted, driver.active.size], [false, 1]);
        assertEquals(driver.committed, []);
      }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)));
      yield* Fiber.join(closing);
      const exit = yield* Fiber.await(fiber);
      assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assertEquals(driver.committed, [receipt]);
      assertEquals(driver.active.size, 0);
      assert(!driver.events.some((event) => event.startsWith("rollback:")));
    }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined))),
  );
});

Deno.test("workflow test assertion failures unblock cleanup before joining children", async () => {
  for (const blocked of ["rollback", "release", "commit"]) {
    for (const stage of ["started", "cleaning"]) {
      const finish = Deferred.makeUnsafe<void>();
      const entered = Deferred.makeUnsafe<void>();
      const cleaning = Deferred.makeUnsafe<void>();
      const cleanup = Deferred.succeed(cleaning, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
      );
      const driver = makeDriver({
        execute: (phase) =>
          phase === "write" && blocked !== "commit"
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
            )
            : phase === "commit" && blocked === "commit"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(cleanup))
            : phase === blocked
            ? cleanup
            : Effect.void,
        release: () => blocked === "release" ? cleanup : Effect.void,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          Effect.runPromiseExit(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                submit(request).pipe(Effect.provide(driver.layer)),
              );
              yield* Deferred.await(entered);
              if (stage === "started") assert(false, "injected assertion");
              yield* Effect.forkChild(Fiber.interrupt(fiber));
              yield* Deferred.await(cleaning);
              assert(false, "injected assertion");
            }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined))),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("cleanup hung")), 1000);
          }),
        ]);
        assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
        assert(Cause.pretty(exit.cause).includes("injected assertion"));
        assertEquals([driver.active.size, driver.staged.size], [0, 0]);
        assertEquals(driver.events.at(-1), "released:1");
        assertEquals(driver.committed, blocked === "commit" ? [receipt] : []);
      } finally {
        clearTimeout(timer);
        await Effect.runPromise(Deferred.succeed(finish, undefined));
      }
    }
  }
});

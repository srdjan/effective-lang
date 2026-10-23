import { assert, assertEquals } from "@std/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { platformLayer } from "./backend.ts";
import { GrantDenied, grantPublishOne, Revoked } from "./grants.ts";
import { makeMemoryPlatform } from "./memory.ts";
import { Key, Payload, PlatformUnavailable } from "./platform.ts";
import { publishAll, publishArticle } from "./publisher.ts";
import { makeRunner } from "./runner.ts";

const seed = (memory: ReturnType<typeof makeMemoryPlatform>, id: string) =>
  memory.control.set(
    Key.make(`articles/${id}`),
    Payload.make(JSON.stringify({
      kind: "draft",
      id,
      revision: 0,
      title: "Title",
      body: "Body",
    })),
    Option.none(),
  );

Deno.test("the batch finishes its accepted operations before releasing the platform", async () => {
  const memory = makeMemoryPlatform();
  await Effect.runPromise(Effect.all([seed(memory, "a"), seed(memory, "b")]));
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let completed = false;
      const runner = makeRunner({
        memory,
        platformLayer: platformLayer({
          acquire: memory.backend.acquire.pipe(Effect.map((kv) => ({
            get: kv.get,
            set: (key, payload, expected) =>
              Effect.gen(function* () {
                if (key === "articles/b") {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(finish);
                }
                return yield* kv.set(key, payload, expected);
              }),
          }))),
        }),
      });
      const fiber = yield* Effect.forkChild(
        publishAll(["a", "b"]).pipe(
          Effect.provide(runner.layer),
          Effect.tap(() => Effect.sync(() => completed = true)),
        ),
      );
      yield* Deferred.await(entered);
      const observed = { completed, active: memory.active() };
      yield* Deferred.succeed(finish, undefined);
      const receipts = yield* Fiber.join(fiber);
      assertEquals(observed, { completed: false, active: 1 });
      assertEquals(receipts.map((receipt) => receipt.id), ["a", "b"]);
      assertEquals(memory.active(), 0);
    }).pipe(Effect.timeout("5 seconds")),
  );
});

Deno.test("interruption waits for cleanup and starts no later batch command", async () => {
  const memory = makeMemoryPlatform();
  await Effect.runPromise(Effect.all([seed(memory, "a"), seed(memory, "b")]));
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const writes: string[] = [];
      const runner = makeRunner({
        memory,
        platformLayer: platformLayer({
          acquire: Effect.gen(function* () {
            const kv = yield* memory.backend.acquire;
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleaning, undefined);
                yield* Deferred.await(finish);
              })
            );
            return {
              get: kv.get,
              set: (key, payload, expected) =>
                Effect.gen(function* () {
                  writes.push(key);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Effect.never;
                  return yield* kv.set(key, payload, expected);
                }),
            };
          }),
        }),
      });
      const fiber = yield* Effect.forkChild(
        publishAll(["a", "b"]).pipe(Effect.provide(runner.layer)),
      );
      yield* Deferred.await(entered);
      const stopping = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Deferred.await(cleaning);
      const activeDuringCleanup = memory.active();
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(stopping);
      const exit = yield* Fiber.await(fiber);
      assert(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assertEquals(activeDuringCleanup, 1);
      assertEquals(writes, ["articles/a"]);
      assertEquals(memory.active(), 0);
    }).pipe(Effect.timeout("5 seconds")),
  );
});

Deno.test("partial acquisition and startup failures release acquired resources", async () => {
  for (const stage of ["acquire", "start", "drive"] as const) {
    const memory = makeMemoryPlatform();
    const marker = new Error(`${stage} failure`);
    const runner = makeRunner({
      memory,
      platformLayer: platformLayer({
        acquire: memory.backend.acquire.pipe(
          Effect.flatMap((kv) =>
            stage === "acquire"
              ? Effect.fail(new PlatformUnavailable({ cause: marker }))
              : Effect.succeed(kv)
          ),
        ),
      }),
    });
    const exit = await runner.runExit(Effect.suspend(() => {
      if (stage === "start") throw marker;
      return Effect.fail(marker);
    }));
    assert(Exit.isFailure(exit));
    if (stage === "start") assert(Cause.hasDies(exit.cause));
    else {
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      assertEquals(
        failure.value instanceof PlatformUnavailable
          ? failure.value.cause
          : failure.value,
        marker,
      );
    }
    assertEquals(memory.active(), 0);
  }
});

Deno.test("release failure preserves an accompanying execution failure", async () => {
  for (const failWork of [false, true]) {
    const memory = makeMemoryPlatform();
    const release = new Error("release failure");
    const work = new Error("execution failure");
    const runner = makeRunner({
      memory,
      platformLayer: platformLayer({
        acquire: memory.backend.acquire.pipe(
          Effect.tap(() => Effect.addFinalizer(() => Effect.die(release))),
        ),
      }),
    });
    const exit = await runner.runExit(
      failWork ? Effect.fail(work) : Effect.void,
    );
    assert(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    assert(Cause.pretty(exit.cause).includes("release failure"));
    const failure = Cause.findErrorOption(exit.cause);
    if (failWork) {
      assert(Option.isSome(failure));
      assertEquals(failure.value, work);
    } else assert(Option.isNone(failure));
    assertEquals(memory.active(), 0);
  }
});

Deno.test("source grants bind one identifier and revoke future invocations", async () => {
  const memory = makeMemoryPlatform();
  await Effect.runPromise(Effect.all([seed(memory, "a"), seed(memory, "b")]));
  const runner = makeRunner({ memory });
  const calls: string[] = [];
  const publish = (id: string) => {
    calls.push(id);
    return publishArticle(id).pipe(Effect.provide(runner.layer));
  };
  const denied = await Effect.runPromiseExit(
    grantPublishOne(publish, "b", ["a"]),
  );
  assert(Exit.isFailure(denied));
  const denial = Cause.findErrorOption(denied.cause);
  assert(Option.isSome(denial) && denial.value instanceof GrantDenied);
  const grant = await Effect.runPromise(grantPublishOne(publish, "a", ["a"]));
  assertEquals((await Effect.runPromise(grant.use())).id, "a");
  await Effect.runPromise(grant.revoke());
  const revoked = await Effect.runPromiseExit(grant.use());
  assert(Exit.isFailure(revoked));
  const error = Cause.findErrorOption(revoked.cause);
  assert(Option.isSome(error) && error.value instanceof Revoked);
  assertEquals(calls, ["a"]);
  assertEquals(memory.active(), 0);
});

Deno.test("revocation refuses deferred work while an active publication can finish", async () => {
  const memory = makeMemoryPlatform();
  await Effect.runPromise(seed(memory, "a"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const runner = makeRunner({
        memory,
        platformLayer: platformLayer({
          acquire: memory.backend.acquire.pipe(Effect.map((kv) => ({
            get: kv.get,
            set: (key, payload, expected) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(finish);
                return yield* kv.set(key, payload, expected);
              }),
          }))),
        }),
      });
      const grant = yield* grantPublishOne(
        (id) => publishArticle(id).pipe(Effect.provide(runner.layer)),
        "a",
        ["a"],
      );
      const deferred = grant.use();
      const active = yield* Effect.forkChild(grant.use());
      yield* Deferred.await(entered);
      yield* grant.revoke();
      const refused = yield* Effect.exit(deferred);
      yield* Deferred.succeed(finish, undefined);
      const receipt = yield* Fiber.join(active);
      assert(Exit.isFailure(refused));
      const error = Cause.findErrorOption(refused.cause);
      assert(Option.isSome(error) && error.value instanceof Revoked);
      assertEquals(receipt.id, "a");
      assertEquals(memory.active(), 0);
    }).pipe(Effect.timeout("5 seconds")),
  );
});

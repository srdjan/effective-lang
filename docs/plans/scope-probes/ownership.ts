// Executable proposal, not a compiler/runtime API.
// deno test --no-lock docs/plans/scope-probes/ownership.ts
import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
} from "npm:effect@4.0.5";

class CloseableScope {
  private started = false;
  private constructor(
    private readonly scope: Scope.Closeable,
    private readonly done: Deferred.Deferred<void>,
  ) {}

  static make: Effect.Effect<CloseableScope> = Effect.gen(function* () {
    return new CloseableScope(
      yield* Scope.make(),
      yield* Deferred.make<void>(),
    );
  });

  provide<A, E, R>(
    job: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, Scope.Scope>> {
    return Scope.provide(job, this.scope);
  }

  // Capture services at registration. Closing never needs their requirements.
  register<R>(
    job: Effect.Effect<void, never, R>,
  ): Effect.Effect<void, never, R> {
    const scope = this.scope;
    return Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      yield* Scope.addFinalizer(scope, Effect.provideContext(job, context));
    });
  }

  close(): Effect.Effect<void> {
    return Effect.uninterruptible(Effect.suspend(() => {
      if (this.started) return Deferred.await(this.done);
      this.started = true;
      return Effect.exit(Scope.close(this.scope, Exit.void)).pipe(
        Effect.flatMap((exit) => Deferred.done(this.done, exit)),
        Effect.andThen(Deferred.await(this.done)),
      );
    }));
  }
}

Deno.test("raw concurrent close can return before the original cleanup completes", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(
        scope,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => events.push("released"))),
        ),
      );
      const first = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      events.push("second-close-returned");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(events, ["second-close-returned", "released"]);
});

Deno.test("proposal shares close authority across roots and waits for every close caller", async () => {
  const events: string[] = [];
  const scope = await Effect.runPromise(CloseableScope.make);
  const alias = { owner: scope };
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      yield* scope.register(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => events.push("released"))),
        ),
      );
      const first = yield* Effect.forkChild(
        scope.close().pipe(
          Effect.andThen(Effect.sync(() => events.push("first-closed"))),
        ),
      );
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(
        Deferred.succeed(secondEntered, undefined).pipe(
          Effect.andThen(alias.owner.close()),
          Effect.andThen(Effect.sync(() => events.push("second-closed"))),
        ),
      );
      yield* Deferred.await(secondEntered);
      yield* Effect.yieldNow;
      assertEquals(events, []);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.timeout("5 seconds")),
  );
  await Effect.runPromise(scope.close());
  assertEquals(events[0], "released");
  assertEquals(events.slice(1).sort(), ["first-closed", "second-closed"]);
});

Deno.test("registered finalizers use registration services rather than closing services", async () => {
  class Audit
    extends Context.Service<Audit, { readonly record: Effect.Effect<void> }>()(
      "ownership#Audit",
    ) {}
  const events: string[] = [];
  const owner = await Effect.runPromise(CloseableScope.make);
  const job = Audit.use((audit) => audit.record);
  const registration: Effect.Effect<void, never, Audit> = owner.register(job);
  await Effect.runPromise(registration.pipe(Effect.provideService(Audit, {
    record: Effect.sync(() => {
      events.push("registration-context");
    }),
  })));
  assertEquals(events, []);
  const closing: Effect.Effect<void> = owner.close();
  await Effect.runPromise(closing.pipe(Effect.provideService(Audit, {
    record: Effect.sync(() => {
      events.push("closing-context");
    }),
  })));
  assertEquals(events, ["registration-context"]);
});

Deno.test("late registration runs immediately and earlier close does not repeat it", async () => {
  const owner = await Effect.runPromise(CloseableScope.make);
  const events: string[] = [];
  await Effect.runPromise(owner.close());
  await Effect.runPromise(owner.register(Effect.sync(() => {
    events.push("late-release");
  })));
  await Effect.runPromise(owner.close());
  assertEquals(events, ["late-release"]);
});

Deno.test("closing aliases finish cleanup even if the first caller is interrupted", async () => {
  const owner = await Effect.runPromise(CloseableScope.make);
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* owner.register(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => {
            events.push("released");
          })),
        ),
      );
      const first = yield* Effect.forkChild(owner.close());
      yield* Deferred.await(entered);
      const cancel = yield* Effect.forkChild(Fiber.interrupt(first));
      const alias = yield* Effect.forkChild(
        owner.close().pipe(Effect.andThen(Effect.sync(() => {
          events.push("alias-closed");
        }))),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancel);
      yield* Fiber.join(alias);
    }).pipe(Effect.timeout("5 seconds")),
  );
  await Effect.runPromise(owner.close());
  assertEquals(events, ["released", "alias-closed"]);
});

Deno.test("closed-scope provision can run ordinary work but cannot keep a newly scoped child alive", async () => {
  const owner = await Effect.runPromise(CloseableScope.make);
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* owner.close();
      yield* owner.provide(Effect.sync(() => {
        events.push("ordinary");
      }));
      const fiber = yield* owner.provide(Effect.forkScoped(Effect.sync(() => {
        events.push("child");
      })));
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(events, ["ordinary"]);
});

Deno.test("close completes remaining finalizers and replays a defect to later aliases", async () => {
  const owner = await Effect.runPromise(CloseableScope.make);
  const events: string[] = [];
  await Effect.runPromise(owner.register(Effect.sync(() => {
    events.push("first");
  })));
  await Effect.runPromise(owner.register(
    Effect.sync(() => {
      events.push("failing");
    }).pipe(Effect.andThen(Effect.die("cleanup-defect"))),
  ));
  await Effect.runPromise(owner.register(Effect.sync(() => {
    events.push("last");
  })));
  const first = await Effect.runPromiseExit(owner.close());
  const alias = owner;
  const second = await Effect.runPromiseExit(alias.close());
  assert(Exit.isFailure(first));
  assert(Exit.isFailure(second));
  assert(Cause.hasDies(first.cause));
  assertEquals(second.cause, first.cause);
  assertEquals(events, ["last", "failing", "first"]);
});

Deno.test("a child-owned provider lives across root return and releases on explicit close", async () => {
  class Worker
    extends Context.Service<Worker, { readonly run: Effect.Effect<void> }>()(
      "ownership#Worker",
    ) {}
  const ready = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const live = Layer.effect(Worker)(Effect.acquireRelease(
    Effect.sync(() => {
      events.push("acquire-provider");
      return {
        run: Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      };
    }),
    () =>
      Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
        events.push("release-provider");
      }))),
  ));
  const owner = await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* CloseableScope.make;
      yield* owner.provide(Effect.forkScoped(
        Worker.use((worker) => worker.run).pipe(Effect.provide(live)),
      ));
      yield* Deferred.await(ready);
      return owner;
    }).pipe(Effect.timeout("5 seconds")),
  );
  events.push("root-returned");
  assertEquals(events, ["acquire-provider", "root-returned"]);
  await Effect.runPromise(owner.close());
  events.push("closed");
  assertEquals(events, [
    "acquire-provider",
    "root-returned",
    "release-provider",
    "closed",
  ]);
});

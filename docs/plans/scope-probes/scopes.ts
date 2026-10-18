// Effect 4 scope audit. Run from the repository root:
// deno test --no-lock docs/plans/scope-probes/scopes.ts
import { assert, assertEquals } from "@std/assert";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "npm:effect@4.0.5";

Deno.test("raw scope closes finalizers in reverse order exactly once", async () => {
  const events: string[] = [];
  await Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(scope, Effect.sync(() => events.push("first")));
    yield* Scope.addFinalizer(
      scope,
      Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => events.push("second"))),
      ),
    );
    events.push("body");
    yield* Scope.close(scope, Exit.void);
    events.push("closed");
    yield* Scope.close(scope, Exit.void);
  }));
  assertEquals(events, ["body", "second", "first", "closed"]);
});

Deno.test("close supplies its own exit and late registration sees that exit", async () => {
  const exits: string[] = [];
  await Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.make();
    const record = (exit: Exit.Exit<unknown, unknown>) =>
      Effect.sync(() => exits.push(exit._tag));
    yield* Scope.addFinalizerExit(scope, record);
    yield* Scope.close(scope, Exit.fail("scope stopped"));
    yield* Scope.close(scope, Exit.void);
    yield* Scope.addFinalizerExit(scope, record);
  }));
  assertEquals(exits, ["Failure", "Failure"]);
});

// The returned value owns the lifetime. The fiber that calls this helper need
// not stay alive. Scope.provide alone does not close this scope on return.
const open = (name: string, events: string[]): Effect.Effect<Scope.Closeable> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const ready = yield* Deferred.make<void>();
    const worker = Effect.acquireUseRelease(
      Effect.sync(() => events.push(`start:${name}`)),
      () =>
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      () =>
        Effect.yieldNow.pipe(
          Effect.andThen(Effect.sync(() => events.push(`release:${name}`))),
        ),
    );
    yield* Scope.provide(Effect.forkScoped(worker), scope);
    yield* Deferred.await(ready);
    return scope;
  });

Deno.test("a caller can close the scope after the creating root run returns", async () => {
  const events: string[] = [];
  const scope = await Effect.runPromise(
    open("root", events).pipe(Effect.timeout("5 seconds")),
  );
  try {
    events.push("root-returned");
    assertEquals(events, ["start:root", "root-returned"]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  assertEquals(events, ["start:root", "root-returned", "release:root"]);
});

Deno.test("returned scopes allow crossing lifetimes and wait for child cleanup", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const creator = yield* Effect.forkChild(open("a", events));
      const a = yield* Fiber.join(creator);
      events.push("creator-returned");
      const b = yield* open("b", events);
      yield* Scope.close(a, Exit.void);
      events.push("a-closed-b-live");
      yield* Scope.close(b, Exit.void);
      events.push("b-closed");
    }).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(events, [
    "start:a",
    "creator-returned",
    "start:b",
    "release:a",
    "a-closed-b-live",
    "release:b",
    "b-closed",
  ]);
});

Deno.test("providing a scope does not interrupt an ordinary running job", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const ready = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const job = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => events.push("finalizer"))
        );
        yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(proceed);
        events.push("continued");
      });
      const fiber = yield* Effect.forkChild(Scope.provide(job, scope));
      yield* Deferred.await(ready);
      yield* Scope.close(scope, Exit.void);
      events.push("closed");
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(fiber);
    }).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(events, ["finalizer", "closed", "continued"]);
});

Deno.test("a raw scope needs explicit cleanup when its creator is interrupted", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* Deferred.make<Scope.Closeable>();
      const creator = yield* Effect.forkChild(Effect.gen(function* () {
        const scope = yield* open("raw", events);
        yield* Deferred.succeed(created, scope);
        yield* Effect.never;
      }));
      const scope = yield* Deferred.await(created);
      yield* Fiber.interrupt(creator);
      events.push("creator-interrupted");
      assertEquals(events, ["start:raw", "creator-interrupted"]);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.timeout("5 seconds")),
  );
  assertEquals(events, ["start:raw", "creator-interrupted", "release:raw"]);
});

Deno.test("bracketing a raw scope closes it with the owner's interrupted exit", async () => {
  const events: string[] = [];
  let interruptedExit = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const owner = Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            yield* Scope.addFinalizerExit(scope, (exit) =>
              Effect.sync(() => {
                interruptedExit = Exit.isFailure(exit) &&
                  Cause.hasInterrupts(exit.cause);
                events.push("release");
              }));
            yield* Deferred.succeed(ready, undefined);
            yield* Effect.never;
          }),
        (scope, exit) => Scope.close(scope, exit),
      );
      const fiber = yield* Effect.forkChild(owner);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      events.push("owner-interrupted");
    }).pipe(Effect.timeout("5 seconds")),
  );
  assert(interruptedExit);
  assertEquals(events, ["release", "owner-interrupted"]);
});

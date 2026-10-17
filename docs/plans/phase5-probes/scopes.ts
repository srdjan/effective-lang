// Target probe for Phase 5 resource lifetime. Run with:
// deno test --no-lock docs/plans/phase5-probes/scopes.ts
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
} from "npm:effect@4.0.5";

type Handle = { readonly id: number };
type Stop = { readonly _tag: "Stop" };
type CloseStop = { readonly _tag: "CloseStop" };

class Audit extends Context.Service<Audit, {
  readonly record: () => Effect.Effect<void, CloseStop>;
}>()("phase5#Audit") {}

const releaseWithAudit: Effect.Effect<number, CloseStop, Audit> = Effect
  .acquireUseRelease(
    Effect.succeed({ id: 7 }),
    (handle) => Effect.succeed(handle.id),
    () => Audit.use((audit) => audit.record()),
  );

const resource = <A, E, R>(
  events: string[],
  use: (handle: Handle) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      events.push("acquire");
      return { id: 7 };
    }),
    use,
    (handle) =>
      Effect.sync(() => {
        events.push(`release:${handle.id}`);
      }),
  );

Deno.test("release follows successful use", () => {
  const events: string[] = [];
  const value = Effect.runSync(resource(events, (handle) =>
    Effect.sync(() => {
      events.push("use");
      return handle.id;
    })));
  if (value !== 7 || events.join(",") !== "acquire,use,release:7") {
    throw new Error(`unexpected success trace: ${events.join(",")}`);
  }
});

Deno.test("release follows typed failure", () => {
  const events: string[] = [];
  const failure: Stop = { _tag: "Stop" };
  const exit = Effect.runSyncExit(
    resource(events, () =>
      Effect.sync(() => events.push("use")).pipe(
        Effect.andThen(Effect.fail(failure)),
      )),
  );
  if (!Exit.isFailure(exit) || events.join(",") !== "acquire,use,release:7") {
    throw new Error(`unexpected failure trace: ${events.join(",")}`);
  }
});

Deno.test("release failure and requirement remain in the result channels", () => {
  let releases = 0;
  const Live = Layer.succeed(Audit)({
    record: () =>
      Effect.sync(() => {
        releases++;
      }).pipe(Effect.andThen(Effect.fail({ _tag: "CloseStop" } as const))),
  });
  const exit = Effect.runSyncExit(releaseWithAudit.pipe(Effect.provide(Live)));
  if (!Exit.isFailure(exit) || releases !== 1) {
    throw new Error(`expected one failing release; got ${releases}`);
  }
});

Deno.test("release completes before an interrupted fiber is joined", async () => {
  const events: string[] = [];
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const job = resource(
      events,
      () =>
        Effect.sync(() => events.push("use")).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        ),
    );
    const fiber = yield* Effect.forkChild(job);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    events.push("interrupted");
  }));
  if (events.join(",") !== "acquire,use,release:7,interrupted") {
    throw new Error(`unexpected interruption trace: ${events.join(",")}`);
  }
});

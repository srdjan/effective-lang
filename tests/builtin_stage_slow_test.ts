import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

// Each program uses one builtin as a pipeline stage. `compileStrictTarget`
// checks the project, lowers it, validates the IR, emits the module, runs
// `deno check` under the strict target configuration, and runs `run.ts`.
//
// `joinFiber` and `interruptFiber` have no program here. A Fiber exists only as
// the borrowed handle of a `withFiber` callback, and the checker accepts that
// handle only as the argument of a direct `joinFiber(fiber)` or
// `interruptFiber(fiber)` call. The stage forms `fiber |> joinFiber` and
// `fiber |> interruptFiber` give `type-mismatch/010`.

async function stage(
  source: string,
  run: string,
  name: string,
): Promise<unknown> {
  return JSON.parse(
    await compileStrictTarget(
      { "main.eff": source },
      ["main.eff"],
      run,
      `effektive-stage-${name}-`,
    ),
  );
}

Deno.test("all runs as a pipeline stage over an array and a record", async () => {
  const result = await stage(
    `type Int = int
type Pair = { left: Int, right: Int }
export const array = (): Int[] => [defer(() => 1), defer(() => 2)] |> all
export const bounded = (): Int[] =>
  [defer(() => 3), defer(() => 4)] |> all({ concurrency: "unbounded" })
export const record = (): Pair =>
  ({ left: defer(() => 5), right: defer(() => 6) }) |> all
`,
    `import { Effect } from "effect";
import { array, bounded, record } from "./main.ts";
console.log(JSON.stringify({
  array: await Effect.runPromise(array()),
  bounded: await Effect.runPromise(bounded()),
  record: await Effect.runPromise(record()),
}));
`,
    "all",
  );
  assertEquals(result, {
    array: [1, 2],
    bounded: [3, 4],
    record: { left: 5, right: 6 },
  });
});

Deno.test("retrySchedule runs as a pipeline stage and stops on None", async () => {
  const result = await stage(
    `type Int = int
export error Stop = {}
export service Jobs { next(): Int fails Stop }
const step = (error: Stop, attempt: Int): Option<Int> => if (attempt < 3) { Some(0) } else { None }
const policy: RetrySchedule<Stop> = step |> retrySchedule
export const main = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })
`,
    `import { Effect, Layer } from "effect";
import { Jobs, Stop, main } from "./main.ts";
let attempts = 0;
const Live = Layer.succeed(Jobs)({ next: () => Effect.sync(() => { attempts++; }).pipe(Effect.andThen(Effect.fail(new Stop({})))) });
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Live))));
console.log(JSON.stringify({ attempts, tag: error._tag }));
`,
    "retry",
  );
  assertEquals(result, { attempts: 3, tag: "main#Stop" });
});

/** The source of the scope tests: a child that runs until its scope closes. */
const CHILD_SERVICE =
  `export service Child { run(): void; wait(): void; alive(): Bool }
type Bool = boolean
`;

/** The host layer of `Child`: `alive` is true while the child runs. */
const CHILD_RUN = `import { Deferred, Effect, Layer } from "effect";
import { Child, main } from "./main.ts";
const ready = Deferred.makeUnsafe<void>();
let active = false;
let released = 0;
const Live = Layer.succeed(Child)({
  run: () => Effect.sync(() => { active = true; }).pipe(
    Effect.andThen(Deferred.succeed(ready, undefined)),
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Effect.sync(() => { active = false; released++; })),
  ),
  wait: () => Deferred.await(ready),
  alive: () => Effect.sync(() => active),
});
const observed = await Effect.runPromise(main().pipe(Effect.provide(Live)));
console.log(JSON.stringify({ observed, active, released }));
`;

Deno.test("scoped runs as a pipeline stage and closes the child with its scope", async () => {
  const result = await stage(
    `${CHILD_SERVICE}const job = defer(() => {
  withFiber(defer(() => { forkScoped(defer(() => Child.run())); 1 }), (fiber) => joinFiber(fiber))
  Child.wait()
  Child.alive()
})
export const main = (): Bool uses Child.run | Child.wait | Child.alive => job |> scoped
`,
    CHILD_RUN,
    "scoped",
  );
  assertEquals(result, { observed: true, active: false, released: 1 });
});

Deno.test("forkScoped runs as a pipeline stage and the child closes with its scope", async () => {
  const result = await stage(
    `${CHILD_SERVICE}const job = defer(() => {
  withFiber(defer(() => { defer(() => Child.run()) |> forkScoped; 1 }), (fiber) => joinFiber(fiber))
  Child.wait()
  Child.alive()
})
export const main = (): Bool uses Child.run | Child.wait | Child.alive => scoped(job)
`,
    CHILD_RUN,
    "fork",
  );
  assertEquals(result, { observed: true, active: false, released: 1 });
});

Deno.test("provideScope runs as a pipeline stage and the owner closes the child", async () => {
  const result = await stage(
    `${CHILD_SERVICE}export const main = (): Bool uses Child.run | Child.wait | Child.alive => {
  const owner = makeScope()
  owner |> provideScope(defer(() => forkScoped(defer(() => Child.run()))))
  Child.wait()
  const alive = Child.alive()
  closeScope(owner)
  alive
}
`,
    CHILD_RUN,
    "provide-scope",
  );
  assertEquals(result, { observed: true, active: false, released: 1 });
});

const FINALIZER_SERVICE = `export service Jobs { release(): void }
`;

const FINALIZER_RUN = `import { Effect, Layer } from "effect";
import { Jobs, main } from "./main.ts";
let released = 0;
const Live = Layer.succeed(Jobs)({ release: () => Effect.sync(() => { released++; }) });
await Effect.runPromise(main().pipe(Effect.provide(Live)));
console.log(JSON.stringify({ released }));
`;

Deno.test("addScopeFinalizer runs as a pipeline stage and the finalizer runs once on close", async () => {
  const result = await stage(
    `${FINALIZER_SERVICE}export const main = (): void uses Jobs.release => {
  const owner = makeScope()
  owner |> addScopeFinalizer(defer(() => Jobs.release()))
  closeScope(owner)
}
`,
    FINALIZER_RUN,
    "finalizer",
  );
  assertEquals(result, { released: 1 });
});

Deno.test("closeScope runs as a pipeline stage and runs the finalizers", async () => {
  const result = await stage(
    `${FINALIZER_SERVICE}export const main = (): void uses Jobs.release => {
  const owner = makeScope()
  addScopeFinalizer(owner, defer(() => Jobs.release()))
  owner |> closeScope
}
`,
    FINALIZER_RUN,
    "close",
  );
  assertEquals(result, { released: 1 });
});

// Slow tests for parts A6a and A6b. Each test copies a fixture project to a
// temporary directory, builds there, and runs `deno check`, `deno fmt`, or
// `deno run` on the result. Nothing is written under fixtures/.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { emitProject, type EmittedModule } from "../src/core/typescript.ts";
import { buildSpanTable, hostImportSpans } from "../src/core/emit/spans.ts";
import {
  hostModulePaths,
  mapTscDiagnostic,
  parseDenoCheck,
} from "../src/core/emit/tsc.ts";
import { lowerProject } from "../src/core/lower.ts";
import { validateProject } from "../src/core/validate_project.ts";
import type { Project } from "../src/core/project.ts";
import {
  lineStarts,
  positionOf,
  type SourceHost,
  spanText,
} from "../src/core/source.ts";
import {
  copyDirectory,
  EXAMPLE_ENTRIES,
  FIXTURES,
  hostBoundaryManifest,
  listFixtures,
} from "./helpers.ts";
import { deno, runScript, withTemporaryDirectory } from "./process_helpers.ts";

const DENO_CONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
    imports: { effect: "npm:effect@4.0.5" },
  },
  null,
  2,
);

/** A host that reads from the file system. Paths are absolute. */
const fileHost: SourceHost = {
  readText(path: string) {
    try {
      return { ok: true, value: Deno.readTextFileSync(path) };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return { ok: false, error: { tag: "not-found", path } };
      }
      return {
        ok: false,
        error: {
          tag: "unreadable",
          path,
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  },
};

interface Built {
  /** The root-relative generated paths. */
  readonly paths: string[];
  readonly project: Project;
  readonly emitted: ReadonlyMap<string, EmittedModule>;
}

/**
 * Builds the project in `root`: checks it, lowers it, emits it, and writes each
 * generated file next to its source. Returns the root-relative generated paths.
 */
function build(root: string, entries: readonly string[]): string[] {
  return buildProject(root, entries).paths;
}

/** Like `build`, and also returns the project and the emitted modules. */
function buildProject(root: string, entries: readonly string[]): Built {
  const checked = checkProject(fileHost, root, entries);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const emitted = emitProject(lowerProject(checked.value), {
    config: checked.value.analysis.project.config,
  });
  const paths: string[] = [];
  const modules = new Map<string, EmittedModule>();
  for (const [name, module] of emitted) {
    assert(module.ok, `${name}: ${JSON.stringify(module)}`);
    const target = `${root}/${module.value.path}`;
    Deno.mkdirSync(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    Deno.writeTextFileSync(target, module.value.text);
    paths.push(module.value.path);
    modules.set(name, module.value);
  }
  Deno.writeTextFileSync(`${root}/deno.json`, DENO_CONFIG);
  return {
    paths,
    project: checked.value.analysis.project,
    emitted: modules,
  };
}

function withTemporary<T>(body: (dir: string) => Promise<T>): Promise<T> {
  return withTemporaryDirectory("effektive-emit-", body);
}

async function check(dir: string, files: readonly string[]): Promise<void> {
  const run = await deno(dir, ["check", "--config", "deno.json", ...files]);
  assertEquals(run.code, 0, `deno check failed:\n${run.stderr}`);
}

function buildExamples(dir: string): string[] {
  copyDirectory(new URL("examples/", FIXTURES), dir);
  return build(dir, EXAMPLE_ENTRIES);
}

/** The forms module in a deep directory, with long names and long strings. */
const LONG_NAMES =
  "a-very-long-directory-name-for-the-module-path/and-another-nested-part/long-names";

function buildForms(dir: string): string[] {
  copyDirectory(new URL("emit/forms/", FIXTURES), dir);
  return build(dir, [
    "forms.eff",
    "names.eff",
    "conditional-chains.eff",
    "nominal-records.eff",
    "data-types.eff",
    "recursive-data.eff",
    "optional-fields.eff",
    "brand-operators.eff",
    "inline-records.eff",
    "array-bodies.eff",
    "literal-results.eff",
    LONG_NAMES + ".eff",
  ]);
}

Deno.test("host providers preserve shared scope handles and reject raw target scopes", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/scopes/", FIXTURES), dir);
    Deno.writeTextFileSync(
      `${dir}/effektive.json`,
      JSON.stringify({
        host: {
          boundary: { interface: "./host.effi", module: "./host.ts" },
        },
      }),
    );
    build(dir, ["host-main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { create, close } from "./owner.ts";
import { pass } from "./host-main.ts";
const owner = await Effect.runPromise(create());
const received = await Effect.runPromise(pass(owner));
await Effect.runPromise(close(received));
console.log(JSON.stringify({ same: received === owner }));
`,
    );
    assertEquals(result, { same: true });
    Deno.writeTextFileSync(
      `${dir}/host.ts`,
      `
import { Layer, Scope } from "effect";
import { Boundary } from "./boundary.ts";
import type { Owner } from "./owner.ts";
export const BoundaryLive = Layer.succeed(Boundary)({ accept: (_owner: Owner) => Scope.make() });
`,
    );
    const wrong = await deno(dir, ["check", "host-main.ts"]);
    assert(wrong.code !== 0, wrong.stdout + wrong.stderr);
    assert(
      wrong.stderr.includes("Closeable") && wrong.stderr.includes("done"),
      wrong.stderr,
    );
  });
});

// ------------------------------------------------------------------ type check

Deno.test("the emitted examples and users-live.ts pass deno check under strict settings", async () => {
  await withTemporary(async (dir) => {
    const generated = buildExamples(dir);
    assertEquals(
      [...generated].sort(),
      [
        "collections.ts",
        "host/providers.effi.ts",
        "log.ts",
        "main.ts",
        "pay.ts",
        "users.ts",
      ],
    );
    await check(dir, [...generated, "users-live.ts"]);
  });
});

Deno.test("the emitted forms and name-collision modules pass deno check", async () => {
  await withTemporary(async (dir) => {
    await check(dir, buildForms(dir));
  });
});

Deno.test("contextual Some payloads retain tuple shape and literals through Effect callbacks", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.copyFileSync(
      new URL("emit/contextual-options.eff", FIXTURES),
      `${dir}/main.eff`,
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { source, nested, record, array, tupleArray, emptyTuple, selected, effectful, Probe, Stop } from "./main.ts";
const unwrap = <A>(value: Option.Option<A>): A => {
  if (Option.isNone(value)) throw new Error("expected Some");
  return value.value;
};
let calls = 0;
const live = Layer.succeed(Probe)({ next: () => Effect.sync(() => { calls++; return 7; }) });
const first = await Effect.runPromise(Stream.runCollect(source));
const second = await Effect.runPromise(Stream.runCollect(source));
const nestedValue = unwrap(await Effect.runPromise(nested));
const present = unwrap(await Effect.runPromise(effectful(false).pipe(Effect.provide(live))));
const absent = await Effect.runPromise(effectful(true).pipe(Effect.provide(live)));
const failed = await Effect.runPromiseExit(effectful(false).pipe(Effect.provide(
  Layer.succeed(Probe)({ next: () => Effect.fail(new Stop({})) }),
)));
const error = Exit.isFailure(failed) ? Option.getOrUndefined(Cause.findErrorOption(failed.cause)) : undefined;
console.log(JSON.stringify({ first, second, nested: [unwrap(nestedValue[0]), nestedValue[1]],
  record: unwrap(await Effect.runPromise(record)), array: unwrap(await Effect.runPromise(array)),
  tupleArray: unwrap(await Effect.runPromise(tupleArray)), emptyTuple: unwrap(await Effect.runPromise(emptyTuple)),
  selectedSome: unwrap(selected(Option.some(9))), selectedNone: unwrap(selected(Option.none())),
  present, absent: Option.isNone(absent), calls, failed: error instanceof Stop,
}));
`,
    );
    assertEquals(result, {
      first: [{ kind: "End", value: 0 }],
      second: [{ kind: "End", value: 0 }],
      nested: [{ kind: "Value", value: 1 }, [2, "ok"]],
      record: { kind: "End", value: 3 },
      array: [1, 2, 3],
      tupleArray: [[{ kind: "Value", value: 4 }, false]],
      emptyTuple: [],
      selectedSome: [{ kind: "Value", value: 9 }, false],
      selectedNone: [{ kind: "End", value: 0 }, true],
      present: [{ kind: "Value", value: 7 }, true],
      absent: true,
      calls: 1,
      failed: true,
    });
  });
});

// ------------------------------------------------------------------ runtime

Deno.test("withResource releases after success, typed failure, and interruption", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Files {",
        "  open(): { read: () => Text fails Stop, wait: () => void, close: () => void }",
        "}",
        "export const load = (): Text fails Stop uses Files.open =>",
        "  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())",
        "export const block = (): void uses Files.open =>",
        "  withResource(() => Files.open(), (file) => file.wait(), (file) => file.close())",
        "type Text = string",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Files, Stop, block, load } from "./main.ts";

const events: string[] = [];
let fail = false;
let started: Deferred.Deferred<void> | undefined;
const Live = Layer.succeed(Files)({
  open: () => Effect.sync(() => {
    events.push("acquire");
    return {
      read: () => fail
        ? Effect.sync(() => { events.push("read"); }).pipe(Effect.andThen(Effect.fail(new Stop({}))))
        : Effect.sync(() => { events.push("read"); return "ok"; }),
      wait: () => Effect.sync(() => { events.push("wait"); }).pipe(
        Effect.andThen(Deferred.succeed(started!, undefined)),
        Effect.andThen(Effect.never),
      ),
      close: () => Effect.sync(() => { events.push("release"); }),
    };
  }),
});

const success = Effect.runSync(load().pipe(Effect.provide(Live)));
fail = true;
const failed = Effect.runSyncExit(load().pipe(Effect.provide(Live)));
const typedFailure = Exit.isFailure(failed);
await Effect.runPromise(Effect.gen(function* () {
  started = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(block().pipe(Effect.provide(Live)));
  yield* Deferred.await(started);
  yield* Fiber.interrupt(fiber);
  events.push("interrupted");
}));
console.log(JSON.stringify({ success, typedFailure, events }));
`,
    );
    assertEquals(result, {
      success: "ok",
      typedFailure: true,
      events: [
        "acquire",
        "read",
        "release",
        "acquire",
        "read",
        "release",
        "acquire",
        "wait",
        "release",
        "interrupted",
      ],
    });
  });
});

Deno.test("bounded traverse limits jobs and waits for scoped finalizers", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Jobs {",
        "  open(n: Int): { work: () => Int fails Stop, close: () => void }",
        "}",
        "export const bounded = (xs: Int[]): Int[] fails Stop uses Jobs.open =>",
        "  traverse(xs, (n) => withResource(() => Jobs.open(n), (job) => job.work(), (job) => job.close()), { concurrency: 2 })",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Jobs, Stop, bounded } from "./main.ts";

type Gate = Deferred.Deferred<void>;
let gates: Gate[] = [];
let ready: Gate[] = [];
let policy: "success" | "failure" | "interrupt" = "success";
let active = 0;
let maximum = 0;
const started: number[] = [];
const released: number[] = [];
const Live = Layer.succeed(Jobs)({
  open: (n) => Effect.sync(() => {
    started.push(n);
    active++;
    maximum = Math.max(maximum, active);
    return {
      work: () => policy === "success"
        ? Deferred.succeed(ready[n - 1]!, undefined).pipe(
          Effect.andThen(Deferred.await(gates[n - 1]!)), Effect.as(n * 2),
        )
        : n === 2 && policy === "failure"
        ? Deferred.succeed(ready[1]!, undefined).pipe(
          Effect.andThen(Deferred.await(gates[1]!)),
          Effect.andThen(Effect.fail(new Stop({}))),
        )
        : n === 2
        ? Deferred.succeed(ready[1]!, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.never,
      close: () => Effect.sync(() => { released.push(n); active--; }),
    };
  }),
});

const makeGates = () => Effect.forEach([1, 2, 3, 4], () => Deferred.make<void>());
const ordered = await Effect.runPromise(Effect.gen(function* () {
  gates = yield* makeGates();
  ready = yield* makeGates();
  const fiber = yield* Effect.forkChild(bounded([1, 2, 3, 4]).pipe(Effect.provide(Live)));
  yield* Deferred.await(ready[0]!);
  yield* Deferred.await(ready[1]!);
  yield* Deferred.succeed(gates[1]!, undefined);
  yield* Deferred.await(ready[2]!);
  yield* Deferred.succeed(gates[0]!, undefined);
  yield* Deferred.await(ready[3]!);
  yield* Deferred.succeed(gates[3]!, undefined);
  yield* Deferred.succeed(gates[2]!, undefined);
  return yield* Fiber.join(fiber);
}));
const success = { ordered, maximum, active };
started.length = 0; released.length = 0; maximum = 0; policy = "failure";
const failed = await Effect.runPromise(Effect.gen(function* () {
  gates = yield* makeGates();
  ready = yield* makeGates();
  const fiber = yield* Effect.forkChild(bounded([1, 2, 3]).pipe(Effect.provide(Live)));
  yield* Deferred.await(ready[1]!);
  yield* Deferred.succeed(gates[1]!, undefined);
  return yield* Fiber.await(fiber);
}));
const failure = { failed: Exit.isFailure(failed), started: [...started], released: [...released].sort(), active };
started.length = 0; released.length = 0; policy = "interrupt";
await Effect.runPromise(Effect.gen(function* () {
  gates = yield* makeGates();
  ready = yield* makeGates();
  const fiber = yield* Effect.forkChild(bounded([1, 2, 3]).pipe(Effect.provide(Live)));
  yield* Deferred.await(ready[1]!);
  yield* Fiber.interrupt(fiber);
}));
const interruption = { started: [...started], released: [...released].sort(), active };
console.log(JSON.stringify({ success, failure, interruption }));
`,
    );
    assertEquals(result, {
      success: { ordered: [2, 4, 6, 8], maximum: 2, active: 0 },
      failure: { failed: true, started: [1, 2], released: [1, 2], active: 0 },
      interruption: { started: [1, 2], released: [1, 2], active: 0 },
    });
  });
});

Deno.test("unbounded traverse starts every job and waits for scoped finalizers", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Jobs {",
        "  open(n: Int): { work: () => Int fails Stop, close: () => void }",
        "}",
        "export const unbounded = (xs: Int[]): Int[] fails Stop uses Jobs.open =>",
        '  traverse(xs, (n) => withResource(() => Jobs.open(n), (job) => job.work(), (job) => job.close()), { concurrency: "unbounded" })',
        "export const all = (): Int[] =>",
        '  traverse([defer(() => 1), defer(() => 2)], (job) => run(job), { concurrency: "unbounded" })',
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Jobs, Stop, all, unbounded } from "./main.ts";

type Gate = Deferred.Deferred<void>;
let gates: Gate[] = [];
let ready: Gate[] = [];
let policy: "success" | "failure" | "interrupt" = "success";
let active = 0;
let maximum = 0;
const started: number[] = [];
const released: number[] = [];
const Live = Layer.succeed(Jobs)({
  open: (n) => Effect.sync(() => {
    started.push(n);
    active++;
    maximum = Math.max(maximum, active);
    return {
      work: () => Deferred.succeed(ready[n - 1]!, undefined).pipe(
        Effect.andThen(Deferred.await(gates[n - 1]!)),
        Effect.andThen(policy === "failure" && n === 2
          ? Effect.fail(new Stop({}))
          : Effect.succeed(n * 2)),
      ),
      close: () => Effect.sync(() => { released.push(n); active--; }),
    };
  }),
});

const makeGates = () => Effect.forEach([1, 2, 3], () => Deferred.make<void>());
const reset = async (next: typeof policy) => {
  policy = next;
  started.length = 0;
  released.length = 0;
  maximum = 0;
  gates = await Effect.runPromise(makeGates());
  ready = await Effect.runPromise(makeGates());
};
const start = () => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(unbounded([1, 2, 3]).pipe(Effect.provide(Live)));
  for (const gate of ready) yield* Deferred.await(gate);
  return fiber;
});

await reset("success");
const ordered = await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* start();
  yield* Deferred.succeed(gates[2]!, undefined);
  yield* Deferred.succeed(gates[0]!, undefined);
  yield* Deferred.succeed(gates[1]!, undefined);
  return yield* Fiber.join(fiber);
}));
const success = { ordered, maximum, active, started: [...started] };

await reset("failure");
const failed = await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* start();
  yield* Deferred.succeed(gates[1]!, undefined);
  return yield* Fiber.await(fiber);
}));
const failure = { failed: Exit.isFailure(failed), started: [...started], released: [...released].sort(), active };

await reset("interrupt");
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* start();
  yield* Fiber.interrupt(fiber);
}));
const interruption = { started: [...started], released: [...released].sort(), active };
const empty = await Effect.runPromise(unbounded([]).pipe(Effect.provide(Live)));
const allResults = await Effect.runPromise(all());
console.log(JSON.stringify({ success, failure, interruption, empty, allResults }));
`,
    );
    assertEquals(result, {
      success: {
        ordered: [2, 4, 6],
        maximum: 3,
        active: 0,
        started: [1, 2, 3],
      },
      failure: {
        failed: true,
        started: [1, 2, 3],
        released: [1, 2, 3],
        active: 0,
      },
      interruption: {
        started: [1, 2, 3],
        released: [1, 2, 3],
        active: 0,
      },
      empty: [],
      allResults: [1, 2],
    });
  });
});

Deno.test("all preserves tuple and record results and cleans up siblings", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Jobs { number(): Int fails Stop; text(): Text }",
        "type Int = int",
        "type Text = string",
        "type Pair = [Effect<Int, Stop, Jobs.number>, Effect<Text, never, Jobs.text>]",
        "const pair: Pair = [defer(() => Jobs.number()), defer(() => Jobs.text())]",
        "export const tuple = (): [Int, Text] fails Stop uses Jobs.number | Jobs.text =>",
        '  all(pair, { concurrency: "unbounded" })',
        "export const record = (): { number: Int, text: Text } fails Stop uses Jobs.number | Jobs.text =>",
        '  all({ number: defer(() => Jobs.number()), text: defer(() => Jobs.text()) }, { concurrency: "unbounded" })',
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Jobs, Stop, tuple, record } from "./main.ts";

const Stable = Layer.succeed(Jobs)({
  number: () => Effect.succeed(7),
  text: () => Effect.succeed("seven"),
});
const tupleResult = await Effect.runPromise(tuple().pipe(Effect.provide(Stable)));
const recordResult = await Effect.runPromise(record().pipe(Effect.provide(Stable)));

let numberReady = Effect.runSync(Deferred.make<void>());
let textReady = Effect.runSync(Deferred.make<void>());
let releaseNumber = Effect.runSync(Deferred.make<void>());
let mode: "failure" | "interrupt" = "failure";
const started: string[] = [];
const released: string[] = [];
const Live = Layer.succeed(Jobs)({
  number: () => Effect.acquireUseRelease(
    Effect.sync(() => { started.push("number"); }),
    () => Deferred.succeed(numberReady, undefined).pipe(
      Effect.andThen(Deferred.await(releaseNumber)),
      Effect.andThen(mode === "failure" ? Effect.fail(new Stop({})) : Effect.never),
    ),
    () => Effect.sync(() => { released.push("number"); }),
  ),
  text: () => Effect.acquireUseRelease(
    Effect.sync(() => { started.push("text"); }),
    () => Deferred.succeed(textReady, undefined).pipe(Effect.andThen(Effect.never)),
    () => Effect.sync(() => { released.push("text"); }),
  ),
});
const start = () => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(record().pipe(Effect.provide(Live)));
  yield* Deferred.await(numberReady);
  yield* Deferred.await(textReady);
  return fiber;
});
const failed = await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* start();
  yield* Deferred.succeed(releaseNumber, undefined);
  return yield* Fiber.await(fiber);
}));
const failure = { failed: Exit.isFailure(failed), started: [...started], released: [...released].sort() };

mode = "interrupt";
started.length = 0;
released.length = 0;
numberReady = Effect.runSync(Deferred.make<void>());
textReady = Effect.runSync(Deferred.make<void>());
releaseNumber = Effect.runSync(Deferred.make<void>());
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* start();
  yield* Fiber.interrupt(fiber);
}));
const interruption = { started: [...started], released: [...released].sort() };
console.log(JSON.stringify({ tupleResult, recordResult, failure, interruption }));
`,
    );
    assertEquals(result, {
      tupleResult: [7, "seven"],
      recordResult: { number: 7, text: "seven" },
      failure: {
        failed: true,
        started: ["number", "text"],
        released: ["number", "text"],
      },
      interruption: {
        started: ["number", "text"],
        released: ["number", "text"],
      },
    });
  });
});

Deno.test("partitionAll collects successes and failures within a concurrency bound", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = { n: Int }",
        "export service Jobs { run(n: Int): Int fails Stop }",
        "export const main = (): [Int[], Stop[]] uses Jobs.run =>",
        "  partitionAll([defer(() => Jobs.run(0)), defer(() => Jobs.run(1)), defer(() => Jobs.run(2)), defer(() => Jobs.run(3))], { concurrency: 2 })",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Jobs, Stop, main } from "./main.ts";

let active = 0;
let maximum = 0;
const started: number[] = [];
const Live = Layer.succeed(Jobs)({
  run: (n) => Effect.sync(() => {
    started.push(n);
    active++;
    maximum = Math.max(maximum, active);
  }).pipe(
    Effect.andThen(Effect.sleep("20 millis")),
    Effect.andThen(n % 2 === 0 ? Effect.succeed(n * 10) : Effect.fail(new Stop({ n }))),
    Effect.ensuring(Effect.sync(() => { active--; })),
  ),
});
const [successes, failures] = await Effect.runPromise(main().pipe(Effect.provide(Live)));
console.log(JSON.stringify({ successes, failures: failures.map((error) => error.n), started, maximum, active }));
`,
    );
    assertEquals(result, {
      successes: [0, 20],
      failures: [1, 3],
      started: [0, 1, 2, 3],
      maximum: 2,
      active: 0,
    });
  });
});

Deno.test("validateAll accumulates nominal failures and keeps successful results", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = { n: Int }",
        "export error Problems = { errors: Stop[] }",
        "export service Jobs { run(n: Int): Int fails Stop }",
        "export const main = (): Int[] fails Problems uses Jobs.run =>",
        "  validateAll([defer(() => Jobs.run(0)), defer(() => Jobs.run(1)), defer(() => Jobs.run(2)), defer(() => Jobs.run(3))], (errors) => Problems({ errors }), { concurrency: 2 })",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Jobs, Stop, main } from "./main.ts";

let mode: "success" | "failure" = "success";
let active = 0;
let maximum = 0;
const started: number[] = [];
const Live = Layer.succeed(Jobs)({
  run: (n) => Effect.sync(() => {
    started.push(n);
    active++;
    maximum = Math.max(maximum, active);
  }).pipe(
    Effect.andThen(Effect.sleep(n === 1 ? "40 millis" : "2 millis")),
    Effect.andThen(mode === "failure" && n % 2 === 1
      ? Effect.fail(new Stop({ n }))
      : Effect.succeed(n * 10)),
    Effect.ensuring(Effect.sync(() => { active--; })),
  ),
});
const successes = await Effect.runPromise(main().pipe(Effect.provide(Live)));
const success = { successes, started: [...started], maximum, active };
mode = "failure";
started.length = 0;
maximum = 0;
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Live))));
const failure = { errors: error.errors.map((item) => item.n), started, maximum, active };
console.log(JSON.stringify({ success, failure }));
`,
    );
    assertEquals(result, {
      success: {
        successes: [0, 10, 20, 30],
        started: [0, 1, 2, 3],
        maximum: 2,
        active: 0,
      },
      failure: {
        errors: [1, 3],
        started: [0, 1, 2, 3],
        maximum: 2,
        active: 0,
      },
    });
  });
});

Deno.test("allResults keeps successes and failures in array, tuple, and record positions", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Text = string",
        "export error Stop = { n: Int }",
        "export service Jobs { number(n: Int): Int fails Stop; text(): Text }",
        'type NumberResult = { _tag: "Success", success: Int } | { _tag: "Failure", failure: Stop }',
        'type TextResult = { _tag: "Success", success: Text } | { _tag: "Failure", failure: never }',
        "type Pair = [Effect<Int, Stop, Jobs.number>, Effect<Text, never, Jobs.text>]",
        "const pair: Pair = [defer(() => Jobs.number(0)), defer(() => Jobs.text())]",
        "export const tuple = (): [NumberResult, TextResult] uses Jobs.number | Jobs.text =>",
        "  allResults(pair, { concurrency: 2 })",
        "export const record = (): { number: NumberResult, text: TextResult } uses Jobs.number | Jobs.text =>",
        "  allResults({ number: defer(() => Jobs.number(1)), text: defer(() => Jobs.text()) }, { concurrency: 2 })",
        "export const array = (): NumberResult[] uses Jobs.number =>",
        "  allResults([defer(() => Jobs.number(0)), defer(() => Jobs.number(1)), defer(() => Jobs.number(2))], { concurrency: 2 })",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Jobs, Stop, tuple, record, array } from "./main.ts";

const started: string[] = [];
const Live = Layer.succeed(Jobs)({
  number: (n) => Effect.sync(() => { started.push(String(n)); }).pipe(
    Effect.andThen(n === 1 ? Effect.fail(new Stop({ n })) : Effect.succeed(n * 10)),
  ),
  text: () => Effect.sync(() => { started.push("text"); return "ok"; }),
});
const inspect = (result: { _tag: "Success"; success: unknown } | { _tag: "Failure"; failure: Stop }) =>
  result._tag === "Success" ? { tag: "success", value: result.success } : { tag: "failure", n: result.failure.n };
const pair = (await Effect.runPromise(tuple().pipe(Effect.provide(Live)))).map(inspect);
const values = await Effect.runPromise(record().pipe(Effect.provide(Live)));
const named = { number: inspect(values.number), text: inspect(values.text) };
const items = (await Effect.runPromise(array().pipe(Effect.provide(Live)))).map(inspect);
console.log(JSON.stringify({ pair, named, items, started }));
`,
    );
    assertEquals(result, {
      pair: [
        { tag: "success", value: 0 },
        { tag: "success", value: "ok" },
      ],
      named: {
        number: { tag: "failure", n: 1 },
        text: { tag: "success", value: "ok" },
      },
      items: [
        { tag: "success", value: 0 },
        { tag: "failure", n: 1 },
        { tag: "success", value: 20 },
      ],
      started: ["0", "text", "1", "text", "0", "1", "2"],
    });
  });
});

Deno.test("switchMapStreams interrupts superseded inners and waits for cleanup", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Outer { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Inner { next(n: Int): Option<[Int, Int]> }",
        "const outer = unfold(0, (n) => Outer.next(n))",
        "const switched = switchMapStreams(outer, (n) => unfold(n, (m) => Inner.next(m)))",
        "export const main = (): Int[] fails Stop uses Outer.next | Inner.next => collectStream(switched)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Layer, Option } from "effect";
import { Outer, Inner, Stop, main } from "./main.ts";

let ready = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
let failOuter = false;
const outerCalls: number[] = [];
const started: number[] = [];
const released: number[] = [];
const OuterLive = Layer.succeed(Outer)({
  next: (n) => Effect.sync(() => { outerCalls.push(n); }).pipe(
    Effect.flatMap(() => n === 0
      ? Effect.succeed(Option.some([1, 1] as const))
      : n === 1
      ? Deferred.await(ready[0]!).pipe(Effect.as(Option.some([2, 2] as const)))
      : n === 2
      ? Deferred.await(ready[1]!).pipe(Effect.flatMap(() => failOuter
        ? Effect.fail(new Stop({}))
        : Effect.succeed(Option.some([3, 3] as const))))
      : Effect.succeed(Option.none())),
  ),
});
const InnerLive = Layer.succeed(Inner)({
  next: (n) => n > 3 ? Effect.succeed(Option.none()) :
    n === 3 ? Effect.sync(() => { started.push(n); return Option.some([n, n + 100] as const); }) :
    Effect.sync(() => { started.push(n); }).pipe(
      Effect.andThen(Deferred.succeed(ready[n - 1]!, undefined)),
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { released.push(n); })),
    ),
});
const Live = Layer.merge(OuterLive, InnerLive);
const pending = main().pipe(Effect.provide(Live));
const before = { outerCalls: [...outerCalls], started: [...started] };
const values = await Effect.runPromise(pending);
const success = { values, outerCalls: [...outerCalls], started: [...started], released: [...released] };
ready = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
outerCalls.length = 0;
started.length = 0;
released.length = 0;
failOuter = true;
const error = await Effect.runPromise(Effect.flip(pending));
const failure = { tag: error._tag, outerCalls: [...outerCalls], started: [...started], released: [...released] };
console.log(JSON.stringify({ before, success, failure }));
`,
    );
    assertEquals(result, {
      before: { outerCalls: [], started: [] },
      success: {
        values: [3],
        outerCalls: [0, 1, 2, 3],
        started: [1, 2, 3],
        released: [1, 2],
      },
      failure: {
        tag: "main#Stop",
        outerCalls: [0, 1, 2],
        started: [1, 2],
        released: [1, 2],
      },
    });
  });
});

Deno.test("catchStream retains earlier values and switches on typed failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = { code: Int }",
        "export error RecoveryStop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Recovery { next(n: Int): Option<[Int, Int]> fails RecoveryStop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const recovered = catchStream(source, (err) => unfold(err.code, (n) => Recovery.next(n)))",
        "export const main = (): Int[] fails RecoveryStop uses Source.next | Recovery.next => collectStream(recovered)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Recovery, Stop, RecoveryStop, main } from "./main.ts";

let failRecovery = false;
const sourceCalls: number[] = [];
const recoveryCalls: number[] = [];
const finalized: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.sync(() => { sourceCalls.push(n); }).pipe(
    Effect.flatMap(() => n < 2
      ? Effect.succeed(Option.some([n + 1, n + 1] as const))
      : Effect.fail(new Stop({ code: 9 }))),
    Effect.ensuring(Effect.sync(() => { finalized.push(n); })),
  ),
});
const RecoveryLive = Layer.succeed(Recovery)({
  next: (n) => Effect.sync(() => { recoveryCalls.push(n); }).pipe(
    Effect.flatMap(() => failRecovery
      ? Effect.fail(new RecoveryStop({}))
      : n === 9
      ? Effect.succeed(Option.some([90, 10] as const))
      : Effect.succeed(Option.none())),
  ),
});
const pending = main().pipe(Effect.provide(Layer.merge(SourceLive, RecoveryLive)));
const before = { sourceCalls: [...sourceCalls], recoveryCalls: [...recoveryCalls] };
const first = await Effect.runPromise(pending);
const second = await Effect.runPromise(pending);
failRecovery = true;
const error = await Effect.runPromise(Effect.flip(pending));
console.log(JSON.stringify({ before, first, second, tag: error._tag, sourceCalls, recoveryCalls, finalized }));
`,
    );
    assertEquals(result, {
      before: { sourceCalls: [], recoveryCalls: [] },
      first: [1, 2, 90],
      second: [1, 2, 90],
      tag: "main#RecoveryStop",
      sourceCalls: [0, 1, 2, 0, 1, 2, 0, 1, 2],
      recoveryCalls: [9, 10, 9, 10, 9],
      finalized: [0, 1, 2, 0, 1, 2, 0, 1, 2],
    });
  });
});

Deno.test("retryStream replays values and resets its schedule after output", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const policy: RetrySchedule<Stop> = retrySchedule((_: Stop, attempt: Int): Option<Int> => if (attempt < 2) { Some(0) } else { None })",
        "const source = unfold(0, (n) => Source.next(n))",
        "const retried = retryStream(source, policy)",
        "export const main = (): Int[] fails Stop uses Source.next => collectStream(retried)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

let attempt = 0;
const calls: number[] = [];
const finalized: number[] = [];
const Live = Layer.succeed(Source)({
  next: (n) => Effect.sync(() => {
    calls.push(n);
    if (n === 0) attempt++;
  }).pipe(
    Effect.flatMap(() => n === 0
      ? Effect.succeed(Option.some([1, 1] as readonly [number, number]))
      : n === 1 && attempt < 3
      ? Effect.fail(new Stop({}))
      : n === 1
      ? Effect.succeed(Option.some([2, 2] as readonly [number, number]))
      : Effect.succeed(Option.none())),
    Effect.ensuring(Effect.sync(() => { finalized.push(n); })),
  ),
});
const pending = main().pipe(Effect.provide(Live));
const before = { calls: [...calls], attempt };
const first = await Effect.runPromise(pending);
const firstRun = { attempt, calls: [...calls], finalized: [...finalized] };
attempt = 0;
calls.length = 0;
finalized.length = 0;
const second = await Effect.runPromise(pending);
console.log(JSON.stringify({ before, first, firstRun, second, attempt, calls, finalized }));
`,
    );
    assertEquals(result, {
      before: { calls: [], attempt: 0 },
      first: [1, 1, 1, 2],
      firstRun: {
        attempt: 3,
        calls: [0, 1, 0, 1, 0, 1, 2],
        finalized: [0, 1, 0, 1, 0, 1, 2],
      },
      second: [1, 1, 1, 2],
      attempt: 3,
      calls: [0, 1, 0, 1, 0, 1, 2],
      finalized: [0, 1, 0, 1, 0, 1, 2],
    });
  });
});

Deno.test("temporal stream controls coalesce and shape or drop elements", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const debounced = debounceStream(source, 0)",
        'const enforced = throttleStream(source, { units: 1, durationMs: 1000, strategy: "enforce" })',
        'const shaped = throttleStream(source, { units: 1, durationMs: 1, strategy: "shape" })',
        "export const debounceRun = (): Int[] fails Stop uses Source.next => collectStream(debounced)",
        "export const enforceRun = (): Int[] fails Stop uses Source.next => collectStream(enforced)",
        "export const shapeRun = (): Int[] fails Stop uses Source.next => collectStream(shaped)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, debounceRun, enforceRun, shapeRun } from "./main.ts";

let calls = 0;
let failSource = false;
const finalized: number[] = [];
const Live = Layer.succeed(Source)({
  next: (n) => Effect.sync(() => { calls++; }).pipe(
    Effect.flatMap(() => failSource && n === 2
      ? Effect.fail(new Stop({}))
      : Effect.succeed(n < 3
        ? Option.some([n + 1, n + 1] as readonly [number, number])
        : Option.none())),
    Effect.ensuring(Effect.sync(() => { finalized.push(n); })),
  ),
});
const before = calls;
const debounced = await Effect.runPromise(debounceRun().pipe(Effect.provide(Live)));
const enforced = await Effect.runPromise(enforceRun().pipe(Effect.provide(Live)));
const shaped = await Effect.runPromise(shapeRun().pipe(Effect.provide(Live)));
failSource = true;
const failure = await Effect.runPromise(Effect.flip(shapeRun().pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, debounced, enforced, shaped, calls, tag: failure._tag, finalized }));
`,
    );
    assertEquals(result, {
      before: 0,
      debounced: [3],
      enforced: [1],
      shaped: [1, 2, 3],
      calls: 15,
      tag: "main#Stop",
      finalized: [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2],
    });
  });
});

Deno.test("concurrent stream mapping bounds work and closes failed siblings", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> }",
        "export service Worker { work(n: Int): Int fails Stop }",
        "export service Inner { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const mapped = mapEffect(source, (n) => Worker.work(n), { concurrency: 2 })",
        "const nested = flatMapStreams(source, (n) => unfold(n, (m) => Inner.next(m)), { concurrency: 2 })",
        "export const mapMain = (): Int[] fails Stop uses Source.next | Worker.work => collectStream(mapped)",
        "export const flatMain = (): Int[] fails Stop uses Source.next | Inner.next => collectStream(nested)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Worker, Inner, Stop, mapMain, flatMain } from "./main.ts";

const calls: number[] = [];
let active = 0;
let maximum = 0;
let fail = false;
const started: number[] = [];
const released: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.sync(() => {
    calls.push(n);
    return n >= 3 ? Option.none() : Option.some([n + 1, n + 1] as const);
  }),
});
const perform = (n: number) => Effect.acquireUseRelease(
  Effect.sync(() => {
    active++;
    maximum = Math.max(maximum, active);
    started.push(n);
  }),
  () => Effect.sleep(n === 1 ? "40 millis" : "10 millis").pipe(
    Effect.flatMap(() => fail && n === 2 ? Effect.fail(new Stop({})) : Effect.succeed(n)),
  ),
  () => Effect.sync(() => { active--; released.push(n); }),
);
const WorkerLive = Layer.succeed(Worker)({
  work: (n) => perform(n).pipe(Effect.map((value) => value * 10)),
});
const InnerLive = Layer.succeed(Inner)({
  next: (n) => n > 3 ? Effect.succeed(Option.none()) :
    perform(n).pipe(Effect.map((value) => Option.some([value, value + 10] as const))),
});
const Live = Layer.mergeAll(SourceLive, WorkerLive, InnerLive);
const reset = () => {
  calls.length = 0;
  started.length = 0;
  released.length = 0;
  active = 0;
  maximum = 0;
};
const pendingMap = mapMain().pipe(Effect.provide(Live));
const before = { calls: [...calls], started: [...started] };
const mapped = await Effect.runPromise(pendingMap);
const mapSuccess = { mapped, maximum, active, started: [...started], released: [...released].sort() };
reset();
fail = true;
const mapFailure = await Effect.runPromise(Effect.flip(pendingMap));
const mapFailed = { tag: mapFailure._tag, active, started: [...started], released: [...released].sort() };
reset();
fail = false;
const flat = await Effect.runPromise(flatMain().pipe(Effect.provide(Live)));
const flatSuccess = { values: [...flat].sort(), maximum, active, started: [...started], released: [...released].sort() };
reset();
fail = true;
const flatFailure = await Effect.runPromise(Effect.flip(flatMain().pipe(Effect.provide(Live))));
const flatFailed = { tag: flatFailure._tag, active, started: [...started], released: [...released].sort() };
console.log(JSON.stringify({ before, mapSuccess, mapFailed, flatSuccess, flatFailed }));
`,
    );
    assertEquals(result, {
      before: { calls: [], started: [] },
      mapSuccess: {
        mapped: [10, 20, 30],
        maximum: 2,
        active: 0,
        started: [1, 2, 3],
        released: [1, 2, 3],
      },
      mapFailed: {
        tag: "main#Stop",
        active: 0,
        started: [1, 2],
        released: [1, 2],
      },
      flatSuccess: {
        values: [1, 2, 3],
        maximum: 2,
        active: 0,
        started: [1, 2, 3],
        released: [1, 2, 3],
      },
      flatFailed: {
        tag: "main#Stop",
        active: 0,
        started: [1, 2],
        released: [1, 2],
      },
    });
  });
});

Deno.test("source-authored streams pull incrementally through an effectful sink", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Source { next(state: Int): Option<[Int, Int]> fails Stop }",
        "export service Transform { double(value: Int): Int fails Stop }",
        "export service Consumer { accept(value: Int): void fails Stop }",
        "const numbers: Stream<Int, Stop, Source.next> = unfold(0, (state) => Source.next(state))",
        "const doubled: Stream<Int, Stop, Source.next | Transform.double> = mapEffect(numbers, (value) => Transform.double(value))",
        "const consume: Sink<Int, void, Stop, Consumer.accept> = sinkForEach((value: Int) => Consumer.accept(value))",
        "export const main = (): void fails Stop uses Source.next | Transform.double | Consumer.accept => runStream(doubled, consume)",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Consumer, Source, Transform, main } from "./main.ts";

let produced = 0;
let consumed = 0;
let maximumAhead = 0;
const output: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (state) => Effect.sync(() => {
    if (state === 4) return Option.none();
    produced++;
    maximumAhead = Math.max(maximumAhead, produced - consumed);
    return Option.some([state, state + 1] as const);
  }),
});
const TransformLive = Layer.succeed(Transform)({
  double: (value) => Effect.succeed(value * 2),
});
const ConsumerLive = Layer.succeed(Consumer)({
  accept: (value) => Effect.sync(() => { output.push(value); consumed++; }),
});
const before = produced;
await Effect.runPromise(main().pipe(Effect.provide(Layer.mergeAll(
  SourceLive, TransformLive, ConsumerLive,
))));
console.log(JSON.stringify({ before, produced, consumed, maximumAhead, output }));
`,
    );
    assertEquals(result, {
      before: 0,
      produced: 4,
      consumed: 4,
      maximumAhead: 1,
      output: [0, 2, 4, 6],
    });
  });
});
Deno.test("buffered merged streams defer production and preserve each source order", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export service Source { next(state: Int): Option<[Int, Int]> }",
        "export service Consumer { accept(value: Int): void }",
        "const first = unfold(0, (state) => Source.next(state))",
        "const second = unfold(10, (state) => Source.next(state))",
        "const combined = mergeStreams(bufferStream(first, { capacity: 2 }), second)",
        "const sink = sinkForEach((value: Int) => Consumer.accept(value))",
        "export const main = (): void uses Source.next | Consumer.accept => runStream(combined, sink)",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Consumer, Source, main } from "./main.ts";
let produced = 0;
const output: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (state) => Effect.sync(() => {
    if (state === 3 || state === 13) return Option.none();
    produced++;
    return Option.some([state, state + 1] as const);
  }),
});
const ConsumerLive = Layer.succeed(Consumer)({
  accept: (value) => Effect.sync(() => { output.push(value); }),
});
const before = produced;
await Effect.runPromise(main().pipe(Effect.provide(Layer.merge(SourceLive, ConsumerLive))));
console.log(JSON.stringify({ before, produced, first: output.filter((n) => n < 10), second: output.filter((n) => n >= 10) }));
`,
    );
    assertEquals(result, {
      before: 0,
      produced: 6,
      first: [0, 1, 2],
      second: [10, 11, 12],
    });
  });
});
Deno.test("zipped streams defer production and stop at the shorter input", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Text = string",
        "export service Left { next(n: Int): Option<[Int, Int]> }",
        "export service Right { next(n: Int): Option<[Text, Int]> }",
        "export service Output { accept(pair: [Int, Text]): void }",
        "const left = unfold(0, (n) => Left.next(n))",
        "const right = unfold(0, (n) => Right.next(n))",
        "const pairs = zipStreams(left, right)",
        "const sink = sinkForEach((pair: [Int, Text]) => Output.accept(pair))",
        "export const main = (): void uses Left.next | Right.next | Output.accept => runStream(pairs, sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Left, Right, Output, main } from "./main.ts";
let produced = 0;
const output: Array<readonly [number, string]> = [];
const LeftLive = Layer.succeed(Left)({
  next: (n) => Effect.sync(() => {
    if (n === 2) return Option.none();
    produced++;
    return Option.some([n, n + 1] as const);
  }),
});
const RightLive = Layer.succeed(Right)({
  next: (n) => Effect.sync(() => {
    if (n === 4) return Option.none();
    produced++;
    return Option.some([String(n), n + 1] as const);
  }),
});
const OutputLive = Layer.succeed(Output)({
  accept: (pair) => Effect.sync(() => { output.push(pair); }),
});
const before = produced;
await Effect.runPromise(main().pipe(Effect.provide(Layer.mergeAll(LeftLive, RightLive, OutputLive))));
console.log(JSON.stringify({ before, output }));
`,
    );
    assertEquals(result, { before: 0, output: [[0, "0"], [1, "1"]] });
  });
});
Deno.test("zipped stream failure interrupts its waiting peer", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Left { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Right { next(n: Int): Option<[Int, Int]> }",
        "export service Output { accept(pair: [Int, Int]): void }",
        "const pairs = zipStreams(unfold(0, (n) => Left.next(n)), unfold(0, (n) => Right.next(n)))",
        "const sink = sinkForEach((pair: [Int, Int]) => Output.accept(pair))",
        "export const main = (): void fails Stop uses Left.next | Right.next | Output.accept => runStream(pairs, sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Layer, Option } from "effect";
import { Left, Right, Output, Stop, main } from "./main.ts";
const ready = Deferred.makeUnsafe<void>();
let started = 0;
let released = 0;
const LeftLive = Layer.succeed(Left)({
  next: (n) => n === 0
    ? Effect.succeed(Option.some([0, 1] as const))
    : Deferred.await(ready).pipe(Effect.andThen(Effect.fail(new Stop({})))),
});
const RightLive = Layer.succeed(Right)({
  next: (n) => n === 0
    ? Effect.succeed(Option.some([0, 1] as const))
    : Effect.sync(() => { started++; }).pipe(
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { released++; })),
    ),
});
const OutputLive = Layer.succeed(Output)({ accept: () => Effect.void });
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Layer.mergeAll(LeftLive, RightLive, OutputLive)))));
console.log(JSON.stringify({ tag: error._tag, started, released }));
`,
    );
    assertEquals(result, { tag: "main#Stop", started: 1, released: 1 });
  });
});
Deno.test("concatenated streams run in sequence and skip the right side after failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Text = string",
        "export error Stop = {}",
        "export service Left { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Right { next(n: Int): Option<[Text, Int]> }",
        "export service Output { accept(value: Int | Text): void }",
        "const left = unfold(0, (n) => Left.next(n))",
        "const right = unfold(0, (n) => Right.next(n))",
        "const values = concatStreams(left, right)",
        "const sink = sinkForEach((value: Int | Text) => Output.accept(value))",
        "export const main = (): void fails Stop uses Left.next | Right.next | Output.accept => runStream(values, sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Left, Right, Output, Stop, main } from "./main.ts";
const emitted: Array<number | string> = [];
let leftDone = false;
let leftStarted = 0;
let rightStarted = 0;
const LeftSuccess = Layer.succeed(Left)({
  next: (n) => Effect.sync(() => {
    leftStarted++;
    if (n === 2) { leftDone = true; return Option.none(); }
    return Option.some([n, n + 1] as const);
  }),
});
const RightLive = Layer.succeed(Right)({
  next: (n) => Effect.sync(() => {
    if (!leftDone) throw new Error("right started before left completed");
    rightStarted++;
    return n === 2 ? Option.none() : Option.some([String(n), n + 1] as const);
  }),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { emitted.push(value); }),
});
const before = { leftStarted, rightStarted };
await Effect.runPromise(main().pipe(Effect.provide(Layer.mergeAll(LeftSuccess, RightLive, OutputLive))));
const success = { emitted: [...emitted], leftDone, leftStarted, rightStarted };
emitted.length = 0;
rightStarted = 0;
leftDone = false;
const LeftFailure = Layer.succeed(Left)({
  next: (n) => n === 0
    ? Effect.succeed(Option.some([0, 1] as const))
    : Effect.fail(new Stop({})),
});
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Layer.mergeAll(LeftFailure, RightLive, OutputLive)))));
console.log(JSON.stringify({ before, success, failure: { tag: error._tag, emitted, rightStarted } }));
`,
    );
    assertEquals(result, {
      before: { leftStarted: 0, rightStarted: 0 },
      success: {
        emitted: [0, 1, "0", "1"],
        leftDone: true,
        leftStarted: 3,
        rightStarted: 3,
      },
      failure: { tag: "main#Stop", emitted: [0], rightStarted: 0 },
    });
  });
});
Deno.test("flat mapped streams exhaust each inner stream and stop after inner failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Text = string",
        "type State = { outer: Int, offset: Int }",
        "export error Stop = {}",
        "export service Outer { next(n: Int): Option<[Int, Int]> }",
        "export service Inner { next(state: State): Option<[Text, State]> fails Stop }",
        "export service Output { accept(value: Text): void }",
        "const outer = unfold(0, (n) => Outer.next(n))",
        "const nested = flatMapStreams(outer, (value) => unfold({ outer: value, offset: 0 }, (state) => Inner.next(state)))",
        "const sink = sinkForEach((value: Text) => Output.accept(value))",
        "export const main = (): void fails Stop uses Outer.next | Inner.next | Output.accept => runStream(nested, sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { Inner, Outer, Output, Stop, main } from "./main.ts";
const output: string[] = [];
let outerCalls = 0;
let firstFinished = false;
const OuterLive = Layer.succeed(Outer)({
  next: (n) => Effect.sync(() => {
    if (n === 1 && !firstFinished) throw new Error("outer advanced before first inner ended");
    outerCalls++;
    return n === 2 ? Option.none() : Option.some([n + 1, n + 1] as const);
  }),
});
const InnerSuccess = Layer.succeed(Inner)({
  next: (state) => Effect.sync(() => {
    if (state.offset === 2) {
      if (state.outer === 1) firstFinished = true;
      return Option.none();
    }
    return Option.some([state.outer + "." + state.offset, { ...state, offset: state.offset + 1 }] as const);
  }),
});
const OutputLive = Layer.succeed(Output)({ accept: (value) => Effect.sync(() => { output.push(value); }) });
const before = { output: [...output], outerCalls };
await Effect.runPromise(main().pipe(Effect.provide(Layer.mergeAll(OuterLive, InnerSuccess, OutputLive))));
const success = { output: [...output], outerCalls };
output.length = 0;
outerCalls = 0;
firstFinished = false;
const InnerFailure = Layer.succeed(Inner)({
  next: (state) => state.outer === 1 && state.offset === 1
    ? Effect.fail(new Stop({}))
    : Effect.succeed(Option.some([state.outer + "." + state.offset, { ...state, offset: state.offset + 1 }] as const)),
});
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Layer.mergeAll(OuterLive, InnerFailure, OutputLive)))));
const failure = { tag: error._tag, output: [...output], outerCalls };
output.length = 0;
outerCalls = 0;
const ready = Deferred.makeUnsafe<void>();
let released = 0;
const InnerBlocked = Layer.succeed(Inner)({
  next: (state) => state.offset === 0
    ? Effect.succeed(Option.some([state.outer + ".0", { ...state, offset: 1 }] as const))
    : Deferred.succeed(ready, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { released++; })),
    ),
});
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(main().pipe(Effect.provide(Layer.mergeAll(OuterLive, InnerBlocked, OutputLive))));
  yield* Deferred.await(ready);
  yield* Fiber.interrupt(fiber);
}));
console.log(JSON.stringify({ before, success, failure, interrupted: { output, outerCalls, released } }));
`,
    );
    assertEquals(result, {
      before: { output: [], outerCalls: 0 },
      success: { output: ["1.0", "1.1", "2.0", "2.1"], outerCalls: 3 },
      failure: { tag: "main#Stop", output: ["1.0"], outerCalls: 1 },
      interrupted: { output: ["1.0"], outerCalls: 1, released: 1 },
    });
  });
});
Deno.test("takeStream stops upstream pulls at a dynamic count", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (count: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(takeStream(source, count), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 3 ? Effect.fail(new Stop({})) : Effect.succeed(Option.some([n, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (count: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(count).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const zero = await run(0);
const negative = await run(-1);
const two = await run(2);
const failure = await Effect.runPromise(Effect.flip(main(4).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, zero, negative, two, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      zero: { calls: [], released: [], values: [] },
      negative: { calls: [], released: [], values: [] },
      two: { calls: [0, 1], released: [0, 1], values: [0, 1] },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 0, 1, 2, 3],
        released: [0, 1, 0, 1, 2, 3],
        values: [0, 1, 0, 1, 2],
      },
    });
  });
});

Deno.test("dropStream consumes a dynamic prefix and propagates skipped failures", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (count: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(dropStream(source, count), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
let failAtThree = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 3 && failAtThree ? Effect.fail(new Stop({})) :
      n === 4 ? Effect.succeed(Option.none()) : Effect.succeed(Option.some([n, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (count: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(count).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const zero = await run(0);
const negative = await run(-1);
const two = await run(2);
const beyond = await run(6);
calls.length = 0;
released.length = 0;
values.length = 0;
failAtThree = true;
const failure = await Effect.runPromise(Effect.flip(main(4).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, zero, negative, two, beyond, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      zero: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [0, 1, 2, 3],
      },
      negative: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [0, 1, 2, 3],
      },
      two: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [2, 3],
      },
      beyond: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        values: [],
      },
    });
  });
});

Deno.test("takeWhileEffectStream with a pure callback omits the false element and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (limit: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(takeWhileEffectStream(source, (n) => n < limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 4 ? Effect.fail(new Stop({})) : Effect.succeed(Option.some([n, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (limit: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(limit).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const empty = await run(0);
const prefix = await run(3);
calls.length = 0;
released.length = 0;
values.length = 0;
const failure = await Effect.runPromise(Effect.flip(main(5).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, empty, prefix, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      empty: { calls: [0], released: [0], values: [] },
      prefix: {
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        values: [0, 1, 2],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [0, 1, 2, 3],
      },
    });
  });
});

Deno.test("takeUntilEffectStream with a pure callback includes the matching element and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (limit: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(takeUntilEffectStream(source, (n) => n === limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
let failAtFour = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 4 && failAtFour ? Effect.fail(new Stop({})) :
      n === 5 ? Effect.succeed(Option.none()) : Effect.succeed(Option.some([n, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (limit: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(limit).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const first = await run(0);
const prefix = await run(3);
const noMatch = await run(-1);
calls.length = 0;
released.length = 0;
values.length = 0;
failAtFour = true;
const failure = await Effect.runPromise(Effect.flip(main(5).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, first, prefix, noMatch, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      first: { calls: [0], released: [0], values: [0] },
      prefix: {
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        values: [0, 1, 2, 3],
      },
      noMatch: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [0, 1, 2, 3, 4],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [0, 1, 2, 3],
      },
    });
  });
});

Deno.test("dropWhileEffectStream with a pure callback emits the first false element and all later elements", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (limit: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(dropWhileEffectStream(source, (n) => n < limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
const sourceValues = [0, 1, 3, 0, 4];
let failAtOne = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 1 && failAtOne ? Effect.fail(new Stop({})) :
      n === 5 ? Effect.succeed(Option.none()) : Effect.succeed(Option.some([sourceValues[n]!, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (limit: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(limit).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const immediate = await run(0);
const suffix = await run(3);
const allDropped = await run(6);
calls.length = 0;
released.length = 0;
values.length = 0;
failAtOne = true;
const failure = await Effect.runPromise(Effect.flip(main(3).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, immediate, suffix, allDropped, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      immediate: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [0, 1, 3, 0, 4],
      },
      suffix: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [3, 0, 4],
      },
      allDropped: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1],
        released: [0, 1],
        values: [],
      },
    });
  });
});

Deno.test("effectful stream predicates stop, fail, and close pulls", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Bool = boolean",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> }",
        "export service Gate { check(n: Int): Bool fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const filtered = (): Int[] fails Stop uses Source.next | Gate.check => collectStream(filterEffectStream(source, (n) => Gate.check(n)))",
        "export const taken = (): Int[] fails Stop uses Source.next | Gate.check => collectStream(takeWhileEffectStream(source, (n) => Gate.check(n)))",
        "export const until = (): Int[] fails Stop uses Source.next | Gate.check => collectStream(takeUntilEffectStream(source, (n) => Gate.check(n)))",
        "export const dropped = (): Int[] fails Stop uses Source.next | Gate.check => collectStream(dropWhileEffectStream(source, (n) => Gate.check(n)))",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Gate, Stop, filtered, taken, until, dropped } from "./main.ts";

const pulled: number[] = [];
const released: number[] = [];
const tested: number[] = [];
let mode = "filter";
let fail = false;
let empty = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { pulled.push(n); }),
    () => Effect.succeed(empty || n === 4
      ? Option.none()
      : Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const GateLive = Layer.succeed(Gate)({
  check: (n) => Effect.sync(() => { tested.push(n); }).pipe(
    Effect.flatMap(() => fail && n === 2
      ? Effect.fail(new Stop({}))
      : Effect.succeed(mode === "filter" ? n % 2 === 0
        : mode === "until" ? n === 3 : n < 3)),
  ),
});
const Live = Layer.merge(SourceLive, GateLive);
const reset = (nextMode: string) => {
  mode = nextMode;
  pulled.length = 0;
  released.length = 0;
  tested.length = 0;
  fail = false;
  empty = false;
};
const snapshot = (values: readonly number[]) => ({
  values, pulled: [...pulled], released: [...released], tested: [...tested],
});
const pending = filtered().pipe(Effect.provide(Live));
const before = snapshot([]);
const filterResult = snapshot(await Effect.runPromise(pending));
reset("while");
const whileResult = snapshot(await Effect.runPromise(taken().pipe(Effect.provide(Live))));
reset("until");
const untilResult = snapshot(await Effect.runPromise(until().pipe(Effect.provide(Live))));
reset("drop");
const dropResult = snapshot(await Effect.runPromise(dropped().pipe(Effect.provide(Live))));
reset("filter");
empty = true;
const emptyResult = snapshot(await Effect.runPromise(pending));
reset("filter");
const repeated = snapshot(await Effect.runPromise(pending));
const failures = [];
for (const [nextMode, program] of [
  ["filter", filtered], ["while", taken], ["until", until], ["drop", dropped],
] as const) {
  reset(nextMode);
  fail = true;
  const error = await Effect.runPromise(Effect.flip(program().pipe(Effect.provide(Live))));
  failures.push({ mode: nextMode, tag: error._tag, pulled: [...pulled], released: [...released], tested: [...tested] });
}
console.log(JSON.stringify({ before, filterResult, whileResult, untilResult, dropResult, emptyResult, repeated, failures }));
`,
    );
    assertEquals(result, {
      before: { values: [], pulled: [], released: [], tested: [] },
      filterResult: {
        values: [2, 4],
        pulled: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        tested: [1, 2, 3, 4],
      },
      whileResult: {
        values: [1, 2],
        pulled: [0, 1, 2],
        released: [0, 1, 2],
        tested: [1, 2, 3],
      },
      untilResult: {
        values: [1, 2, 3],
        pulled: [0, 1, 2],
        released: [0, 1, 2],
        tested: [1, 2, 3],
      },
      dropResult: {
        values: [3, 4],
        pulled: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        tested: [1, 2, 3],
      },
      emptyResult: {
        values: [],
        pulled: [0],
        released: [0],
        tested: [],
      },
      repeated: {
        values: [2, 4],
        pulled: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        tested: [1, 2, 3, 4],
      },
      failures: ["filter", "while", "until", "drop"].map((mode) => ({
        mode,
        tag: "main#Stop",
        pulled: [0, 1],
        released: [0, 1],
        tested: [1, 2],
      })),
    });
  });
});

Deno.test("filterEffectStream with a pure callback evaluates every element and propagates source failures", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (limit: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(filterEffectStream(source, (n) => n >= limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
const sourceValues = [0, 1, 3, 0, 4];
let failAtOne = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 1 && failAtOne ? Effect.fail(new Stop({})) :
      n === 5 ? Effect.succeed(Option.none()) : Effect.succeed(Option.some([sourceValues[n]!, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (limit: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(limit).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const all = await run(0);
const selected = await run(3);
const none = await run(6);
calls.length = 0;
released.length = 0;
values.length = 0;
failAtOne = true;
const failure = await Effect.runPromise(Effect.flip(main(3).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, all, selected, none, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      all: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [0, 1, 3, 0, 4],
      },
      selected: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [3, 4],
      },
      none: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1],
        released: [0, 1],
        values: [],
      },
    });
  });
});

Deno.test("mapEffect with a pure callback changes element type and propagates source failures", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Bool = boolean",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Bool): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Bool) => Output.accept(value))",
        "export const main = (limit: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(mapEffect(source, (n) => n >= limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: boolean[] = [];
const sourceValues = [0, 1, 3, 0, 4];
let failAtOne = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 1 && failAtOne ? Effect.fail(new Stop({})) :
      n === 5 ? Effect.succeed(Option.none()) : Effect.succeed(Option.some([sourceValues[n]!, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const run = async (limit: number) => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  await Effect.runPromise(main(limit).pipe(Effect.provide(Live)));
  return { calls: [...calls], released: [...released], values: [...values] };
};
const before = { calls: [...calls], released: [...released], values: [...values] };
const all = await run(0);
const selected = await run(3);
const none = await run(6);
calls.length = 0;
released.length = 0;
values.length = 0;
failAtOne = true;
const failure = await Effect.runPromise(Effect.flip(main(3).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, all, selected, none, failure: { tag: failure._tag, calls, released, values } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      all: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [true, true, true, true, true],
      },
      selected: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [false, false, true, false, true],
      },
      none: {
        calls: [0, 1, 2, 3, 4, 5],
        released: [0, 1, 2, 3, 4, 5],
        values: [false, false, false, false, false],
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1],
        released: [0, 1],
        values: [false],
      },
    });
  });
});

Deno.test("scanStream emits fresh seed and state before source failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (seed: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(scanStream(source, seed, (sum, n) => sum + n), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
const events: string[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); events.push("pull:" + n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => {
    values.push(value);
    events.push("emit:" + value);
  }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const reset = () => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
  events.length = 0;
};
const snapshot = () => ({
  calls: [...calls], released: [...released], values: [...values],
  firstEvent: events[0],
});
const run = async (seed: number) => {
  reset();
  await Effect.runPromise(main(seed).pipe(Effect.provide(Live)));
  return snapshot();
};
const before = snapshot();
const first = await run(10);
const second = await run(10);
empty = true;
const emptyResult = await run(7);
empty = false;
failAtTwo = true;
reset();
const failure = await Effect.runPromise(Effect.flip(main(0).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      first: {
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        values: [10, 11, 13, 16],
        firstEvent: "emit:10",
      },
      second: {
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        values: [10, 11, 13, 16],
        firstEvent: "emit:10",
      },
      emptyResult: {
        calls: [0],
        released: [0],
        values: [7],
        firstEvent: "emit:7",
      },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2],
        released: [0, 1, 2],
        values: [0, 1, 3],
        firstEvent: "emit:0",
      },
    });
  });
});

Deno.test("mapAccumStream threads state and emits zero or more values", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "export service Output { accept(value: Int): void }",
        "const source = unfold(0, (n) => Source.next(n))",
        "const sink = sinkForEach((value: Int) => Output.accept(value))",
        "export const main = (seed: Int): void fails Stop uses Source.next | Output.accept =>",
        "  runStream(mapAccumStream(source, seed, (total, n): [Int, Int[]] =>",
        "    [total + n, if (n < 2) { [] } else { if (n < 3) { [total + n] } else { [total + n, total + n + 10] } }]), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Output, Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const values: number[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 4 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const OutputLive = Layer.succeed(Output)({
  accept: (value) => Effect.sync(() => { values.push(value); }),
});
const Live = Layer.mergeAll(SourceLive, OutputLive);
const reset = () => {
  calls.length = 0;
  released.length = 0;
  values.length = 0;
};
const snapshot = () => ({
  calls: [...calls], released: [...released], values: [...values],
});
const run = async (seed: number) => {
  reset();
  await Effect.runPromise(main(seed).pipe(Effect.provide(Live)));
  return snapshot();
};
const before = snapshot();
const first = await run(0);
const second = await run(0);
const shifted = await run(10);
empty = true;
const emptyResult = await run(7);
empty = false;
failAtTwo = true;
reset();
const failure = await Effect.runPromise(Effect.flip(main(0).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, first, second, shifted, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], values: [] },
      first: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [3, 6, 16, 10, 20],
      },
      second: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [3, 6, 16, 10, 20],
      },
      shifted: {
        calls: [0, 1, 2, 3, 4],
        released: [0, 1, 2, 3, 4],
        values: [13, 16, 26, 20, 30],
      },
      emptyResult: { calls: [0], released: [0], values: [] },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2],
        released: [0, 1, 2],
        values: [3],
      },
    });
  });
});

Deno.test("foldStream returns fresh final state and propagates source failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (seed: Int): Int fails Stop uses Source.next =>",
        "  foldStream(source, seed, (total, n) => total + n)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const snapshot = () => ({ calls: [...calls], released: [...released] });
const reset = () => { calls.length = 0; released.length = 0; };
const pending = main(10).pipe(Effect.provide(SourceLive));
const before = snapshot();
const firstValue = await Effect.runPromise(pending);
const first = { value: firstValue, ...snapshot() };
reset();
const secondValue = await Effect.runPromise(pending);
const second = { value: secondValue, ...snapshot() };
reset();
empty = true;
const emptyValue = await Effect.runPromise(main(7).pipe(Effect.provide(SourceLive)));
const emptyResult = { value: emptyValue, ...snapshot() };
reset();
empty = false;
failAtTwo = true;
const failure = await Effect.runPromise(Effect.flip(main(0).pipe(Effect.provide(SourceLive))));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [] },
      first: { value: 16, calls: [0, 1, 2, 3], released: [0, 1, 2, 3] },
      second: { value: 16, calls: [0, 1, 2, 3], released: [0, 1, 2, 3] },
      emptyResult: { value: 7, calls: [0], released: [0] },
      failure: {
        tag: "main#Stop",
        calls: [0, 1, 2],
        released: [0, 1, 2],
      },
    });
  });
});

Deno.test("foldEffectStream runs updates sequentially and stops on failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error SourceStop = {}",
        "export error UpdateStop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails SourceStop }",
        "export service Accum { add(total: Int, n: Int): Int fails UpdateStop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (seed: Int): Int fails SourceStop | UpdateStop uses Source.next | Accum.add =>",
        "  foldEffectStream(source, seed, (total, n) => Accum.add(total, n))",
        "export const pureMain = (seed: Int): Int fails SourceStop uses Source.next =>",
        "  foldEffectStream(source, seed, (total, n) => total + n)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Accum, Source, SourceStop, UpdateStop, main, pureMain } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
const updates: Array<[number, number]> = [];
let empty = false;
let failSource = false;
let failUpdate = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failSource ? Effect.fail(new SourceStop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const AccumLive = Layer.succeed(Accum)({
  add: (total, n) => Effect.sync(() => {
    updates.push([total, n]);
    return total + n;
  }).pipe(Effect.flatMap((next) => failUpdate && n === 2 ?
    Effect.fail(new UpdateStop({})) : Effect.succeed(next))),
});
const Live = Layer.mergeAll(SourceLive, AccumLive);
const snapshot = () => ({
  calls: [...calls], released: [...released], updates: [...updates],
});
const reset = () => {
  calls.length = 0;
  released.length = 0;
  updates.length = 0;
};
const pending = main(10).pipe(Effect.provide(Live));
const before = snapshot();
const firstValue = await Effect.runPromise(pending);
const first = { value: firstValue, ...snapshot() };
reset();
const secondValue = await Effect.runPromise(pending);
const second = { value: secondValue, ...snapshot() };
reset();
const pureValue = await Effect.runPromise(pureMain(10).pipe(Effect.provide(SourceLive)));
const pure = { value: pureValue, ...snapshot() };
reset();
empty = true;
const emptyValue = await Effect.runPromise(main(7).pipe(Effect.provide(Live)));
const emptyResult = { value: emptyValue, ...snapshot() };
reset();
empty = false;
failSource = true;
const sourceFailure = await Effect.runPromise(Effect.flip(main(0).pipe(Effect.provide(Live))));
const sourceResult = { tag: sourceFailure._tag, ...snapshot() };
reset();
failSource = false;
failUpdate = true;
const updateFailure = await Effect.runPromise(Effect.flip(main(0).pipe(Effect.provide(Live))));
console.log(JSON.stringify({ before, first, second, pure, emptyResult, sourceResult, updateResult: { tag: updateFailure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [], updates: [] },
      first: {
        value: 16,
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        updates: [[10, 1], [11, 2], [13, 3]],
      },
      second: {
        value: 16,
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        updates: [[10, 1], [11, 2], [13, 3]],
      },
      pure: {
        value: 16,
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        updates: [],
      },
      emptyResult: {
        value: 7,
        calls: [0],
        released: [0],
        updates: [],
      },
      sourceResult: {
        tag: "main#SourceStop",
        calls: [0, 1, 2],
        released: [0, 1, 2],
        updates: [[0, 1], [1, 2]],
      },
      updateResult: {
        tag: "main#UpdateStop",
        calls: [0, 1],
        released: [0, 1],
        updates: [[0, 1], [1, 2]],
      },
    });
  });
});

Deno.test("collectStream gathers ordered values and closes failed pulls", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (): Int[] fails Stop uses Source.next => collectStream(source)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const snapshot = () => ({ calls: [...calls], released: [...released] });
const reset = () => { calls.length = 0; released.length = 0; };
const pending = main().pipe(Effect.provide(SourceLive));
const before = snapshot();
const firstValue = await Effect.runPromise(pending);
const first = { values: firstValue, ...snapshot() };
reset();
const secondValue = await Effect.runPromise(pending);
const second = { values: secondValue, ...snapshot(), freshArray: firstValue !== secondValue };
reset();
empty = true;
const emptyValue = await Effect.runPromise(main().pipe(Effect.provide(SourceLive)));
const emptyResult = { values: emptyValue, ...snapshot() };
reset();
empty = false;
failAtTwo = true;
const failure = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(SourceLive))));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [] },
      first: {
        values: [1, 2, 3],
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
      },
      second: {
        values: [1, 2, 3],
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
        freshArray: true,
      },
      emptyResult: { values: [], calls: [0], released: [0] },
      failure: { tag: "main#Stop", calls: [0, 1, 2], released: [0, 1, 2] },
    });
  });
});

Deno.test("headStream stops after the first element and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (): Option<Int> fails Stop uses Source.next => headStream(source)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
let empty = false;
let fail = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => fail ? Effect.fail(new Stop({})) :
      empty ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const snapshot = () => ({ calls: [...calls], released: [...released] });
const reset = () => { calls.length = 0; released.length = 0; };
const describe = (value: Option.Option<number>) => Option.isSome(value) ? { tag: "Some", value: value.value } : { tag: "None" };
const pending = main().pipe(Effect.provide(SourceLive));
const before = snapshot();
const first = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
const second = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = true;
const emptyResult = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = false;
fail = true;
const failure = await Effect.runPromise(Effect.flip(pending));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [] },
      first: {
        result: { tag: "Some", value: 1 },
        calls: [0],
        released: [0],
      },
      second: {
        result: { tag: "Some", value: 1 },
        calls: [0],
        released: [0],
      },
      emptyResult: {
        result: { tag: "None" },
        calls: [0],
        released: [0],
      },
      failure: { tag: "main#Stop", calls: [0], released: [0] },
    });
  });
});

Deno.test("lastStream consumes through completion and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (): Option<Int> fails Stop uses Source.next => lastStream(source)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const snapshot = () => ({ calls: [...calls], released: [...released] });
const reset = () => { calls.length = 0; released.length = 0; };
const describe = (value: Option.Option<number>) => Option.isSome(value) ? { tag: "Some", value: value.value } : { tag: "None" };
const pending = main().pipe(Effect.provide(SourceLive));
const before = snapshot();
const first = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
const second = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = true;
const emptyResult = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = false;
failAtTwo = true;
const failure = await Effect.runPromise(Effect.flip(pending));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [] },
      first: {
        result: { tag: "Some", value: 3 },
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
      },
      second: {
        result: { tag: "Some", value: 3 },
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
      },
      emptyResult: {
        result: { tag: "None" },
        calls: [0],
        released: [0],
      },
      failure: { tag: "main#Stop", calls: [0, 1, 2], released: [0, 1, 2] },
    });
  });
});

Deno.test("drainStream consumes every value and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export error Stop = {}",
        "export service Source { next(n: Int): Option<[Int, Int]> fails Stop }",
        "const source = unfold(0, (n) => Source.next(n))",
        "export const main = (): void fails Stop uses Source.next => drainStream(source)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { Source, Stop, main } from "./main.ts";

const calls: number[] = [];
const released: number[] = [];
let empty = false;
let failAtTwo = false;
const SourceLive = Layer.succeed(Source)({
  next: (n) => Effect.acquireUseRelease(
    Effect.sync(() => { calls.push(n); return n; }),
    () => n === 2 && failAtTwo ? Effect.fail(new Stop({})) :
      empty || n === 3 ? Effect.succeed(Option.none()) :
      Effect.succeed(Option.some([n + 1, n + 1] as const)),
    () => Effect.sync(() => { released.push(n); }),
  ),
});
const snapshot = () => ({ calls: [...calls], released: [...released] });
const reset = () => { calls.length = 0; released.length = 0; };
const describe = (value: void) => value === undefined;
const pending = main().pipe(Effect.provide(SourceLive));
const before = snapshot();
const first = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
const second = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = true;
const emptyResult = { result: describe(await Effect.runPromise(pending)), ...snapshot() };
reset();
empty = false;
failAtTwo = true;
const failure = await Effect.runPromise(Effect.flip(pending));
console.log(JSON.stringify({ before, first, second, emptyResult, failure: { tag: failure._tag, ...snapshot() } }));
`,
    );
    assertEquals(result, {
      before: { calls: [], released: [] },
      first: {
        result: true,
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
      },
      second: {
        result: true,
        calls: [0, 1, 2, 3],
        released: [0, 1, 2, 3],
      },
      emptyResult: {
        result: true,
        calls: [0],
        released: [0],
      },
      failure: { tag: "main#Stop", calls: [0, 1, 2], released: [0, 1, 2] },
    });
  });
});

Deno.test("a source race interrupts its losing fiber and waits for cleanup", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export service Source {",
        "  slow(): Int",
        "  fast(): Int",
        "}",
        "export const main = (): Int uses Source.slow | Source.fast =>",
        "  run(race(defer(() => Source.slow()), defer(() => Source.fast())))",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Source, main } from "./main.ts";
let started = 0;
let released = 0;
const SourceLive = Layer.succeed(Source)({
  slow: () => Effect.sync(() => { started++; return 0; }).pipe(
    Effect.flatMap(() => Effect.never),
    Effect.onInterrupt(() => Effect.sync(() => { released++; })),
  ),
  fast: () => Effect.sleep("20 millis").pipe(Effect.as(7)),
});
const value = await Effect.runPromise(main().pipe(Effect.provide(SourceLive)));
console.log(JSON.stringify({ value, started, released }));
`,
    );
    assertEquals(result, { value: 7, started: 1, released: 1 });
  });
});
Deno.test("forkScoped outlives its spawning fiber and closes with its scope", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "type Bool = boolean",
        "export service Child { run(): void; wait(): void; alive(): Bool }",
        "const job = defer(() => {",
        "    withFiber(defer(() => { forkScoped(defer(() => Child.run())); 1 }), (fiber) => joinFiber(fiber))",
        "    Child.wait()",
        "    Child.alive()",
        "})",
        "export const main = (): Bool uses Child.run | Child.wait | Child.alive => scoped(job)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Layer } from "effect";
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
`,
    );
    assertEquals(result, { observed: true, active: false, released: 1 });
  });
});
Deno.test("reference updates are atomic under bounded traversal", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export const main = (): Int => {",
        "  const ref = makeRef(0)",
        "  traverse([1, 2, 3, 4], (n) => updateRef(ref, (current) => current + 1), { concurrency: 4 })",
        "  getRef(ref)",
        "}",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { main } from "./main.ts";
console.log(JSON.stringify({ value: await Effect.runPromise(main()) }));
`,
    );
    assertEquals(result, { value: 4 });
  });
});
Deno.test("custom retry schedule sees one-based attempts and stops on None", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Jobs { next(): Int fails Stop }",
        "const policy: RetrySchedule<Stop> = retrySchedule((error: Stop, attempt: Int): Option<Int> =>",
        "  if (attempt < 3) { Some(0) } else { None })",
        "export const main = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Jobs, Stop, main } from "./main.ts";
let attempts = 0;
const Live = Layer.succeed(Jobs)({ next: () => Effect.sync(() => { attempts++; }).pipe(Effect.andThen(Effect.fail(new Stop({})))) });
const error = await Effect.runPromise(Effect.flip(main().pipe(Effect.provide(Live))));
console.log(JSON.stringify({ attempts, tag: error._tag }));
`,
    );
    assertEquals(result, { attempts: 3, tag: "main#Stop" });
  });
});
Deno.test("pure codecs validate both directions and preserve None", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Int = int",
        "export const shift: Codec<Int, Int> = codec((n: Int): Int => n + 1, (n: Int): Int => n - 1)",
        "export const parse = (input: unknown): Option<Int> => decode(shift, input)",
        "export const print = (n: Int): Option<Int> => encode(shift, n)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Option } from "effect";
import { parse, print } from "./main.ts";
const good = parse(4);
const bad = parse("bad");
const encoded = print(5);
console.log(JSON.stringify({ good: Option.getOrUndefined(good), bad: Option.isNone(bad), encoded: Option.getOrUndefined(encoded) }));
`,
    );
    assertEquals(result, { good: 5, bad: true, encoded: 4 });
  });
});
Deno.test("data values carry a tag, keep it when widened, and round trip through a schema and a codec", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/forms/", FIXTURES), dir);
    build(dir, ["data-types.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import * as M from "./data-types.ts";
const user = M.make();
const encoded = await Effect.runPromise(M.encodeUser(user));
const decoded = await Effect.runPromise(M.decodeUser(encoded));
const rejected = await Effect.runPromise(Effect.flip(M.decodeUser({ id: "u1", name: "Ann" })));
console.log(JSON.stringify({
  user,
  plain: M.plain(user),
  twin: M.twin(user),
  piped: M.piped(),
  renamed: M.rename(user, "Bo"),
  mark: M.mark(),
  encoded,
  decoded,
  untaggedRejected: rejected._tag,
}));
`,
    );
    const ann = { _tag: "data-types#User", id: "u1", name: "Ann" };
    assertEquals(result, {
      user: ann,
      plain: ann,
      twin: { _tag: "data-types#Twin", id: "u1", name: "Ann" },
      piped: { _tag: "data-types#Pin", id: "p1" },
      renamed: { ...ann, name: "Bo" },
      mark: { _tag: "data-types#Marker" },
      encoded: ann,
      decoded: ann,
      untaggedRejected: "SchemaError",
    });
  });
});
const WIDENED_RECORDS = [
  "type Int = int",
  "type Text = string",
  "type Fields = { x: Int }",
  "nominal A = Fields",
  "nominal B = Fields",
  "nominal C = { inner: Fields, label: Text }",
  "const fieldsSchema: Schema<Fields> = schema()",
  "export const make = (x: Int): A => A({ x })",
  "export const widen = (a: A): B => B(a)",
  "export const update = (a: A): B => B({ ...a, x: 9 })",
  'export const nested = (a: A): C => C({ inner: a, label: "n" })',
  "export const encodeFields = (a: A): Fields fails SchemaError =>",
  "  schemaEncode(fieldsSchema, a)",
  "",
].join("\n");

Deno.test("a widened record value constructs another nominal type, in a copy, an update, and a nested field, and encodes without its tag", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(`${dir}/main.eff`, WIDENED_RECORDS);
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import * as M from "./main.ts";
const a = M.make(1);
console.log(JSON.stringify({
  widen: M.widen(a),
  update: M.update(a),
  nested: M.nested(a),
  encoded: await Effect.runPromise(M.encodeFields(a)),
  source: a,
}));
`,
    );
    assertEquals(result, {
      widen: { _tag: "main#B", x: 1 },
      update: { _tag: "main#B", x: 9 },
      nested: { _tag: "main#C", inner: { x: 1 }, label: "n" },
      encoded: { x: 1 },
      source: { _tag: "main#A", x: 1 },
    });
  });
});

Deno.test("nominal operators compare and compute on the base value at run time", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/nominal-operators/", FIXTURES), dir);
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import * as M from "./main.ts";
const total = M.Cents.make(21);
console.log(JSON.stringify({
  text: M.asText(M.UserId.make("u1")),
  greet: M.greet(M.UserId.make("u1")),
  first: [M.isFirst(M.UserId.make("u1")), M.isFirst(M.UserId.make("u2"))],
  positive: [M.positive(total), M.positive(M.Cents.make(0))],
  double: M.double(total),
  shifted: M.shifted(total),
  half: M.half(total),
  square: M.square(total),
  sum: M.sum(total, total),
}));
`,
    );
    assertEquals(result, {
      text: "u1",
      greet: "u1!",
      first: [true, false],
      positive: [true, false],
      double: 42,
      shifted: 26,
      half: 10.5,
      square: 441,
      sum: 42,
    });
  });
});

Deno.test("a data value with a missing optional prototype-named field nests in another data value", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Text = string",
        "export nominal Tok = { label: Text, toString?: Text }",
        "export type Toks = Tok[]",
        "export nominal Box = { tok: Tok, all: Toks, maybe: Option<Tok> }",
        "export const tok = (l: Text): Tok => Tok({ label: l })",
        'export const box = (): Box => Box({ tok: tok("a"), all: [tok("b")], maybe: Some(tok("c")) })',
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { box } from "./main.ts";
console.log(JSON.stringify(box()));
`,
    );
    assertEquals(result, {
      _tag: "main#Box",
      tok: { _tag: "main#Tok", label: "a" },
      all: [{ _tag: "main#Tok", label: "b" }],
      maybe: {
        _id: "Option",
        _tag: "Some",
        value: { _tag: "main#Tok", label: "c" },
      },
    });
  });
});
Deno.test("a widened record value with a nested optional prototype-named field loses its tag and keeps the field adapter", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Text = string",
        "export nominal Tok = { label: Text, toString?: Text }",
        "export type Toks = Tok[]",
        "export nominal Box = { tok: Tok, all: Toks, maybe: Option<Tok> }",
        "export nominal Boxed = { tok: Tok, all: Toks, maybe: Option<Tok> }",
        "export const tok = (l: Text): Tok => Tok({ label: l })",
        'export const box = (): Box => Box({ tok: tok("a"), all: [tok("b")], maybe: Some(tok("c")) })',
        "export const rebox = (b: Box): Boxed => Boxed(b)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { box, rebox } from "./main.ts";
console.log(JSON.stringify(rebox(box())));
`,
    );
    assertEquals(result, {
      _tag: "main#Boxed",
      tok: { _tag: "main#Tok", label: "a" },
      all: [{ _tag: "main#Tok", label: "b" }],
      maybe: {
        _id: "Option",
        _tag: "Some",
        value: { _tag: "main#Tok", label: "c" },
      },
    });
  });
});
Deno.test("a match over data and error types selects the arm by tag", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/forms/", FIXTURES), dir);
    build(dir, ["data-types.eff"]);
    const result = await runScript(
      dir,
      `
import * as M from "./data-types.ts";
const user = M.make();
console.log(JSON.stringify({
  circle: M.describe(M.circle()),
  square: M.describe(M.square()),
  lax: [M.circular(M.circle()), M.circular(M.square())],
  outcome: [M.outcome(M.Circle.make({ radius: "r" })), M.outcome(M.reject(user))],
  kind: [M.kind(M.mark()), M.kind(M.Circle.make({ radius: "r" }))],
}));
`,
    );
    assertEquals(result, {
      circle: "r",
      square: "s",
      lax: ["r", "other"],
      outcome: ["r", "no"],
      kind: ["marker", "r"],
    });
  });
});
Deno.test("recursive data types build, encode, decode, and match", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/forms/", FIXTURES), dir);
    build(dir, ["recursive-data.eff"]);
    const result = await runScript(
      dir,
      `
import { Schema } from "effect";
import * as M from "./recursive-data.ts";
const tree = M.nested();
const list = M.two();
const forest = M.forest();
const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A): A =>
  Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(value));
const back = roundTrip(M.List, list);
console.log(JSON.stringify({
  tree: Schema.encodeSync(M.Tree)(tree),
  treeBack: roundTrip(M.Tree, tree),
  list: Schema.encodeSync(M.List)(list),
  listBack: back,
  length: [M.length(list), M.length(back), M.length(M.Nil.make({}))],
  forest: Schema.encodeSync(M.Forest)(forest),
  forestBack: roundTrip(M.Forest, forest)._tag,
  badTag: Schema.decodeUnknownExit(M.List)({ _tag: "recursive-data#Other" })._tag,
}));
`,
    );
    const nil = { _tag: "recursive-data#Nil" };
    const list = {
      _tag: "recursive-data#Cons",
      head: 1,
      tail: {
        _tag: "recursive-data#Cons",
        head: 2,
        tail: nil,
      },
    };
    const leaf = (label: string) => ({
      _tag: "recursive-data#Tree",
      label,
      children: [],
    });
    const tree = {
      _tag: "recursive-data#Tree",
      label: "root",
      children: [leaf("a"), leaf("b")],
    };
    assertEquals(result, {
      tree,
      treeBack: tree,
      list,
      listBack: list,
      length: [2, 2, 0],
      forest: {
        _tag: "recursive-data#Forest",
        first: {
          _id: "Option",
          _tag: "Some",
          value: {
            _tag: "recursive-data#Node",
            rest: {
              _tag: "recursive-data#Forest",
              first: { _id: "Option", _tag: "None" },
            },
          },
        },
      },
      forestBack: "recursive-data#Forest",
      badTag: "Failure",
    });
  });
});
Deno.test("a pure codec over a data type decodes into data and encodes back", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "type Text = string",
        "export nominal Name = { text: Text }",
        "export const names: Codec<Name, Text> = codec((text: Text): Name => Name({ text }), (name: Name): Text => name.text)",
        "export const parse = (input: unknown): Option<Name> => decode(names, input)",
        "export const print = (name: Name): Option<Text> => encode(names, name)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Option } from "effect";
import { Name, parse, print } from "./main.ts";
console.log(JSON.stringify({
  parsed: Option.getOrUndefined(parse("Zed")),
  printed: Option.getOrUndefined(print(Name.make({ text: "Amy" }))),
}));
`,
    );
    assertEquals(result, {
      parsed: { _tag: "main#Name", text: "Zed" },
      printed: "Amy",
    });
  });
});
Deno.test("withFiber interrupts its child and waits for finalizers", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export service Source { slow(): Int; wait(): void }",
        "export const main = (): Int uses Source.slow | Source.wait =>",
        "  withFiber(defer(() => Source.slow()), (fiber) => { Source.wait(); interruptFiber(fiber); 7 })",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Layer } from "effect";
import { Source, main } from "./main.ts";
let started = 0;
let released = 0;
const ready = Effect.runSync(Deferred.make<void>());
const Live = Layer.succeed(Source)({
  slow: () => Effect.sync(() => { started++; }).pipe(
    Effect.andThen(Deferred.succeed(ready, undefined)),
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Effect.sync(() => { released++; })),
  ),
  wait: () => Deferred.await(ready),
});
const value = await Effect.runPromise(main().pipe(Effect.provide(Live)));
console.log(JSON.stringify({ value, started, released }));
`,
    );
    assertEquals(result, { value: 7, started: 1, released: 1 });
  });
});
Deno.test("source Layers merge and provide their declared services", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "service First { one(): Int }",
        "service Second { two(): Int }",
        "const first = layer(First, () => ({ one: () => 1 }))",
        "const second = layer(Second, () => ({ two: () => 2 }))",
        "const both: Layer<First | Second> = mergeLayers(first, second)",
        "export const main = (): Int => provide(both, () => First.one() + Second.two())",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { main } from "./main.ts";
console.log(JSON.stringify({ value: await Effect.runPromise(main()) }));
`,
    );
    assertEquals(result, { value: 3 });
  });
});
Deno.test("source Layer acquisition carries its failure and service requirement", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Source { next(): Int fails Stop }",
        "service First { one(): Int }",
        "const first: Layer<First, Stop, Source.next> = layer(First, () => {",
        "  const value = Source.next()",
        "  ({ one: () => value })",
        "})",
        "export const main = (): Int fails Stop uses Source.next => provide(first, () => First.one())",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Source, main } from "./main.ts";
const SourceLive = Layer.succeed(Source)({ next: () => Effect.succeed(9) });
console.log(JSON.stringify({ value: await Effect.runPromise(main().pipe(Effect.provide(SourceLive))) }));
`,
    );
    assertEquals(result, { value: 9 });
  });
});
Deno.test("stream pull releases a scoped operation on failure and interruption", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "export error Stop = {}",
        "export service Source { open(state: Int): { next: () => Option<[Int, Int]> fails Stop, close: () => void } }",
        "const numbers = unfold(0, (state) => withResource(() => Source.open(state), (source) => source.next(), (source) => source.close()))",
        "const sink = sinkForEach((value: Int) => {})",
        "export const main = (): void fails Stop uses Source.open => runStream(numbers, sink)",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { Source, Stop, main } from "./main.ts";

const events: string[] = [];
let interrupt = false;
let started: Deferred.Deferred<void> | undefined;
const Live = Layer.succeed(Source)({
  open: () => Effect.sync(() => {
    events.push("acquire");
    return {
      next: () => interrupt
        ? Deferred.succeed(started!, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.fail(new Stop({})),
      close: () => Effect.sync(() => { events.push("release"); }),
    };
  }),
});
const failed = Effect.runSyncExit(main().pipe(Effect.provide(Live)));
const failure = { failed: Exit.isFailure(failed), events: [...events] };
events.length = 0;
interrupt = true;
await Effect.runPromise(Effect.gen(function* () {
  started = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(main().pipe(Effect.provide(Live)));
  yield* Deferred.await(started);
  yield* Fiber.interrupt(fiber);
  events.push("interrupted");
}));
console.log(JSON.stringify({ failure, interruption: events }));
`,
    );
    assertEquals(result, {
      failure: { failed: true, events: ["acquire", "release"] },
      interruption: ["acquire", "release", "interrupted"],
    });
  });
});

Deno.test("stored Effect values run twice after deferred construction", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "error Stop = {}",
        "export service Counter { next(): Int fails Stop }",
        "export service Factory { produce(): Effect<Int, Stop, Counter.next> }",
        "export const make = (): Effect<Int, Stop, Counter.next> => defer(() => Counter.next())",
        "export const fromHost = (): Int fails Stop uses Counter.next | Factory.produce => run(Factory.produce())",
        "export const twice = (stored: Effect<Int, Stop, Counter.next>): Int fails Stop uses Counter.next => {",
        "  const first = run(stored)",
        "  const second = run(stored)",
        "  first + second",
        "}",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Layer } from "effect";
import { Counter, make, twice } from "./main.ts";

let calls = 0;
const Live = Layer.succeed(Counter)({
  next: () => Effect.sync(() => ++calls),
});
const stored = make();
const before = calls;
const sum = Effect.runSync(twice(stored).pipe(Effect.provide(Live)));
console.log(JSON.stringify({ before, sum, calls }));
`,
    );
    assertEquals(result, { before: 0, sum: 3, calls: 2 });
  });
});

Deno.test("traverse runs sequentially and stops after a typed callback failure", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "error Stop = { at: int }",
        "service Probe { step(n: Int): Int fails Stop }",
        "export const run = (xs: Int[]): Int[] fails Stop uses Probe.step => traverse(xs, (n) => Probe.step(n))",
        "export const pure = (xs: Int[]): Int[] => traverse(xs, (n) => n + 1)",
        "type Int = int",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Result } from "effect";
import { Probe, Stop, run, pure } from "./main.ts";

const calls: number[] = [];
const Live = Layer.succeed(Probe)({
  step: (n) => Effect.gen(function* () {
    calls.push(n);
    if (n === 3) return yield* Effect.fail(new Stop({ at: n }));
    return n * 2;
  }),
});
const empty = Effect.runSync(run([]).pipe(Effect.provide(Live)));
const success = Effect.runSync(run([1, 2]).pipe(Effect.provide(Live)));
const failed = Effect.runSyncExit(run([1, 2, 3, 4]).pipe(Effect.provide(Live)));
const found = Exit.isFailure(failed) ? Cause.findError(failed.cause) : undefined;
const stoppedAt = found !== undefined && Result.isSuccess(found) &&
    found.success instanceof Stop ? found.success.at : null;
console.log(JSON.stringify({ empty, success, stoppedAt, calls, pure: Effect.runSync(pure([1, 2])) }));
`,
    );
    assertEquals(result, {
      empty: [],
      success: [2, 4],
      stoppedAt: 3,
      calls: [1, 2, 1, 2, 3],
      pure: [2, 3],
    });
  });
});

Deno.test("the emitted examples run: main, a provided fallback, collections, and pay", async () => {
  await withTemporary(async (dir) => {
    buildExamples(dir);
    const result = await runScript(
      dir,
      `
import { Effect, Layer, Option } from "effect";
import { main } from "./main.ts";
import { activeNames, displayName } from "./users.ts";
import { UsersLive } from "./users-live.ts";
import { activeNames as activeUserNames, total } from "./collections.ts";
import { type Order, OrderId, Orders, pay, Payments } from "./pay.ts";

const orders = new Map<string, Order>([
  ["o1", { id: OrderId.make("o1"), totalCents: 250, status: "pending" }],
]);
const OrdersMemory = Layer.succeed(Orders)({
  find: (id) => Effect.succeed(Option.fromNullishOr(orders.get(id))),
  save: (order) => Effect.sync(() => { orders.set(order.id, order); }),
});
const charges: number[] = [];
const PaymentsMemory = Layer.succeed(Payments)({
  charge: (amount) => Effect.sync(() => { charges.push(amount); return "ok"; }),
});
const paid = Effect.runSync(
  pay(OrderId.make("o1")).pipe(
    Effect.provide(Layer.mergeAll(OrdersMemory, PaymentsMemory)),
  ),
);
console.log(JSON.stringify({
  main: Effect.runSync(main()),
  guest: Effect.runSync(displayName("nobody").pipe(Effect.provide(UsersLive))),
  active: Effect.runSync(activeNames().pipe(Effect.provide(UsersLive))),
  total: total([1, 2, 3]),
  activeUsers: activeUserNames([
    { name: "a", active: true },
    { name: "b", active: false },
  ]),
  paidStatus: paid.status,
  paidTotal: paid.totalCents,
  stored: orders.get("o1")?.status,
  charges,
}));
`,
    );
    assertEquals(result, {
      main: "Ada",
      guest: "Guest",
      active: ["Ada"],
      total: 6,
      activeUsers: ["a"],
      paidStatus: "paid",
      paidTotal: 250,
      stored: "paid",
      charges: [250],
    });
  });
});

Deno.test("a catch with two handlers raises a handler failure to the caller (Effect.catchTags)", async () => {
  await withTemporary(async (dir) => {
    buildForms(dir);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { Id, lookup2, Store } from "./forms.ts";

const StoreMemory = Layer.succeed(Store)({
  find: () => Effect.succeed(Option.none()),
  count: () => Effect.succeed(1),
  tick: () => Effect.succeed(undefined),
});
const run = (fail: boolean) =>
  Effect.runSyncExit(
    lookup2(Id.make("x"), fail).pipe(Effect.provide(StoreMemory)),
  );
const describe = (exit: Exit.Exit<string, unknown>) => {
  if (Exit.isSuccess(exit)) return { tag: "success", value: exit.value };
  const found = Cause.findError(exit.cause);
  const error = Result.isSuccess(found) ? found.success : undefined;
  const tag = typeof error === "object" && error !== null && "_tag" in error
    ? error._tag
    : undefined;
  return { tag: "failure", error: tag };
};
// The body fails with NotFound. Its handler fails with Other. The second
// handler must not catch that failure, so the failure reaches the caller.
// The second run fails with Other, and its handler returns a value.
console.log(JSON.stringify({ first: describe(run(true)), second: describe(run(false)) }));
`,
    );
    assertEquals(result, {
      first: { tag: "failure", error: "forms#Other" },
      second: { tag: "success", value: "x" },
    });
  });
});

Deno.test("int arithmetic outside the safe range throws, and a throw inside an effect is a defect", async () => {
  await withTemporary(async (dir) => {
    buildForms(dir);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { hoist, Id, mul, Store } from "./forms.ts";

let thrown: string | undefined;
try {
  mul(2 ** 40, 2 ** 40);
} catch (e) {
  thrown = e instanceof RangeError ? e.message : "other";
}
const StoreMemory = Layer.succeed(Store)({
  find: () => Effect.succeed(Option.none()),
  count: () => Effect.succeed(1),
  tick: () => Effect.succeed(undefined),
});
const exit = Effect.runSyncExit(
  hoist(Id.make("x"), Number.MAX_SAFE_INTEGER).pipe(Effect.provide(StoreMemory)),
);
console.log(JSON.stringify({
  thrown,
  small: mul(6, 7),
  defect: Exit.isFailure(exit) && Cause.hasDies(exit.cause) &&
    !Cause.hasFails(exit.cause),
}));
`,
    );
    assertEquals(result, { thrown: "int overflow", small: 42, defect: true });
  });
});

Deno.test("brand addition outside the safe range throws, and a throw inside an effect is a defect", async () => {
  await withTemporary(async (dir) => {
    buildForms(dir);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer } from "effect";
import { add, bump, Count, Counter, below } from "./brand-operators.ts";

const big = Count.make(Number.MAX_SAFE_INTEGER);
let thrown: string | undefined;
try {
  add(big, Count.make(1));
} catch (e) {
  thrown = e instanceof RangeError ? e.message : "other";
}
const CounterMemory = Layer.succeed(Counter)({
  read: () => Effect.succeed(Count.make(Number.MAX_SAFE_INTEGER)),
});
const exit = Effect.runSyncExit(
  bump(Count.make(1)).pipe(Effect.provide(CounterMemory)),
);
console.log(JSON.stringify({
  thrown,
  sum: add(Count.make(40), Count.make(2)),
  below: below(Count.make(1), Count.make(2)),
  defect: Exit.isFailure(exit) && Cause.hasDies(exit.cause) &&
    !Cause.hasFails(exit.cause),
}));
`,
    );
    assertEquals(result, {
      thrown: "int overflow",
      sum: 42,
      below: true,
      defect: true,
    });
  });
});

Deno.test("a pure function lifted into an effect function slot runs", async () => {
  await withTemporary(async (dir) => {
    buildForms(dir);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { useLift, useLiftClosure } from "./forms.ts";
console.log(JSON.stringify({
  lift: Effect.runSync(useLift(1)),
  closure: Effect.runSync(useLiftClosure(3)),
}));
`,
    );
    assertEquals(result, { lift: 3, closure: 12 });
  });
});

Deno.test("a retry of a pure job runs", async () => {
  await withTemporary(async (dir) => {
    buildForms(dir);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { retryPure, retryPureNamed } from "./forms.ts";
console.log(JSON.stringify({
  closure: Effect.runSync(retryPure()),
  named: Effect.runSync(retryPureNamed()),
}));
`,
    );
    assertEquals(result, { closure: 2, named: 2 });
  });
});

// ------------------------------------------------------------------ formatting (A6b)

Deno.test("deno fmt does not exclude the golden files, and it accepts them unchanged", async () => {
  const config = JSON.parse(
    Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
  );
  const excluded: unknown = config.fmt.exclude;
  assert(Array.isArray(excluded));
  assert(
    !excluded.some((entry) => String(entry).startsWith("fixtures/golden")),
    "deno.json excludes the golden files from deno fmt",
  );
  const root = new URL("../", import.meta.url).pathname;
  const run = await deno(root, ["fmt", "--check", "fixtures/golden"]);
  assertEquals(run.code, 0, `deno fmt --check failed:\n${run.stderr}`);
  const goldenCount = listFixtures("golden", /\.ts$/).length;
  assert(
    run.stderr.includes(`Checked ${goldenCount} files`),
    `deno fmt did not check all ${goldenCount} golden files:\n${run.stderr}`,
  );
});

Deno.test("the emitted forms are a fixed point of deno fmt", async () => {
  await withTemporary(async (dir) => {
    const generated = buildForms(dir);
    assertEquals(
      [...generated].sort(),
      [
        LONG_NAMES + ".ts",
        "array-bodies.ts",
        "brand-operators.ts",
        "conditional-chains.ts",
        "data-types.ts",
        "forms.ts",
        "inline-records.ts",
        "literal-results.ts",
        "names.ts",
        "nominal-records.ts",
        "optional-fields.ts",
        "recursive-data.ts",
      ],
    );
    const run = await deno(dir, ["fmt", "--check", ...generated]);
    assertEquals(run.code, 0, `deno fmt --check failed:\n${run.stderr}`);
    assert(
      run.stderr.includes("Checked 12 files"),
      `deno fmt did not check the twelve files:\n${run.stderr}`,
    );
  });
});

// ------------------------------------------------------------------ host boundary (A6b)

Deno.test("a wrong host module gives one host-boundary diagnostic on the import of UsersLive", async () => {
  const fixtures = hostBoundaryManifest();
  assertEquals(fixtures.length, 1);
  for (const fixture of fixtures) {
    await withTemporary(async (dir) => {
      copyDirectory(new URL("examples/", FIXTURES), dir);
      const built = buildProject(dir, EXAMPLE_ENTRIES);
      // The wrong module replaces the right one.
      Deno.copyFileSync(
        new URL(
          `host-boundary/${fixture.directory}/${fixture.host}`,
          FIXTURES,
        ),
        `${dir}/users-live.ts`,
      );
      const run = await deno(dir, [
        "check",
        "--config",
        "deno.json",
        ...built.paths,
        "users-live.ts",
      ]);
      assertEquals(run.code, 1, `deno check should fail:\n${run.stderr}`);

      const output = parseDenoCheck(run.stderr, Deno.realPathSync(dir));
      assertEquals(output.other, [], run.stderr);
      const imports = hostImportSpans(built.project);
      const tables = new Map(
        [...built.emitted].map(([name, module]) => [
          module.path,
          buildSpanTable(module, imports.get(name)),
        ]),
      );
      const mapped = output.diagnostics.map((d) => mapTscDiagnostic(d, tables));
      assertEquals(mapped.length, 1, run.stderr);
      const only = mapped[0];
      assert(only.tag === "host-boundary", JSON.stringify(only));
      assertEquals(only.diagnostic.code, fixture.code);

      const source = Deno.readTextFileSync(`${dir}/${fixture.expected.source}`);
      const position = positionOf(
        lineStarts(source),
        source,
        only.diagnostic.span.start,
      );
      assertEquals(only.diagnostic.span.source, fixture.expected.source);
      assertEquals(
        [position.line, position.column],
        [fixture.expected.line, fixture.expected.column],
      );
      assertEquals(spanText(source, only.diagnostic.span), "UsersLive");
    });
  }
});

Deno.test("a host layer of the declared service that lacks a method gives one host-module diagnostic", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    const built = buildProject(dir, EXAMPLE_ENTRIES);
    Deno.writeTextFileSync(
      `${dir}/users-live.ts`,
      [
        'import { Effect, Layer, Option } from "effect";',
        'import { Users } from "./users.ts";',
        "export const UsersLive = Layer.succeed(Users)({",
        "  find: () => Effect.succeed(Option.none()),",
        "  save: () => Effect.void,",
        "});",
        "",
      ].join("\n"),
    );
    const run = await deno(dir, [
      "check",
      "--config",
      "deno.json",
      ...built.paths,
      "users-live.ts",
    ]);
    assertEquals(run.code, 1, `deno check should fail:\n${run.stderr}`);
    const output = parseDenoCheck(run.stderr, Deno.realPathSync(dir));
    assertEquals(output.other, [], run.stderr);
    const imports = hostImportSpans(built.project);
    const tables = new Map(
      [...built.emitted].map(([name, module]) => [
        module.path,
        buildSpanTable(module, imports.get(name)),
      ]),
    );
    const hosts = hostModulePaths(built.project.config);
    const mapped = output.diagnostics.map((d) =>
      mapTscDiagnostic(d, tables, hosts)
    );
    assertEquals(mapped.length, 1, run.stderr);
    const only = mapped[0];
    assert(only.tag === "host-module", JSON.stringify(only));
    assertEquals([only.key, only.file, only.line], [
      "providers",
      "users-live.ts",
      3,
    ]);
  });
});

Deno.test("explicit scopes survive root return and share aliases across modules", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/scopes/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const project = checkProject(fileHost, dir, ["consumer.eff"]);
    assert(project.ok);
    assertEquals(project.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        project.value.analysis.project,
        lowerProject(project.value),
      ).values()
    ) {
      assertEquals(diagnostics, []);
    }
    build(dir, ["consumer.eff"]);
    const formatted = await deno(dir, [
      "fmt",
      "--check",
      "owner.ts",
      "consumer.ts",
    ]);
    assertEquals(formatted.code, 0, formatted.stderr);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Layer, Option } from "effect";
import { Child, open, openProvided, close, piped } from "./owner.ts";
import { alias, copied, stash, stop, stopNew, provideNew, registerNew } from "./consumer.ts";
const events: string[] = [];
const ready = Deferred.makeUnsafe<void>();
const live = Layer.succeed(Child)({
  run: () => Effect.acquireUseRelease(
    Effect.sync(() => { events.push("start"); }),
    () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
    () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release"); }))),
  ),
  ready: () => Deferred.await(ready),
});
const owner = await Effect.runPromise(open().pipe(Effect.provide(live)));
events.push("root-returned");
const saved = await Effect.runPromise(stash(owner));
const both = Option.getOrThrow(copied(owner));
const same = both[0] === owner && both[1][0] === owner;
const deferredClose = alias(owner);
await Effect.runPromise(stop(saved));
events.push("closed");
await Effect.runPromise(deferredClose());
await Effect.runPromise(close(owner));
await Effect.runPromise(piped());
await Effect.runPromise(stopNew());
await Effect.runPromise(provideNew(Effect.void));
await Effect.runPromise(registerNew(Effect.void));
const providerReady = Deferred.makeUnsafe<void>();
const provider = Layer.effect(Child)(Effect.acquireRelease(
  Effect.sync(() => {
    events.push("acquire-provider");
    return { run: () => Deferred.succeed(providerReady, undefined).pipe(Effect.andThen(Effect.never)), ready: () => Effect.void };
  }),
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release-provider"); }))),
));
const external = Layer.succeed(Child)({ run: () => Effect.void, ready: () => Deferred.await(providerReady) });
const provided = await Effect.runPromise(openProvided(provider).pipe(Effect.provide(external)));
events.push("provider-root-returned");
await Effect.runPromise(close(provided));
console.log(JSON.stringify({ same, events }));
`,
    );
    assertEquals(result, {
      same: true,
      events: [
        "start",
        "root-returned",
        "release",
        "closed",
        "acquire-provider",
        "provider-root-returned",
        "release-provider",
      ],
    });
  });
});

Deno.test("explicit close callers wait for one cleanup and retain its defects", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/scopes/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["consumer.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { create, close } from "./owner.ts";
import { register, alias } from "./consumer.ts";
const events: string[] = [];
const owner = await Effect.runPromise(create());
const entered = Deferred.makeUnsafe<void>();
const release = Deferred.makeUnsafe<void>();
await Effect.runPromise(register(owner, Deferred.succeed(entered, undefined).pipe(
  Effect.andThen(Deferred.await(release)),
  Effect.andThen(Effect.sync(() => { events.push("release"); })),
)));
await Effect.runPromise(Effect.gen(function* () {
  const first = yield* Effect.forkChild(close(owner));
  yield* Deferred.await(entered);
  const second = yield* Effect.forkChild(alias(owner)().pipe(Effect.andThen(Effect.sync(() => { events.push("second"); }))));
  yield* Effect.yieldNow;
  if (events.length !== 0) throw new Error("close returned before release");
  yield* register(owner, Effect.sync(() => { events.push("late-during-close"); }));
  const cancel = yield* Effect.forkChild(Fiber.interrupt(first));
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(cancel);
  yield* Fiber.join(second);
}));
await Effect.runPromise(close(owner));
await Effect.runPromise(register(owner, Effect.sync(() => { events.push("late"); })));
await Effect.runPromise(close(owner));
const defective = await Effect.runPromise(create());
await Effect.runPromise(register(defective, Effect.sync(() => { events.push("remaining"); })));
await Effect.runPromise(register(defective, Effect.die("cleanup-defect")));
const first = await Effect.runPromiseExit(close(defective));
const second = await Effect.runPromiseExit(alias(defective)());
const replayed = Exit.isFailure(first) && Exit.isFailure(second) && Cause.hasDies(first.cause) && JSON.stringify(first.cause) === JSON.stringify(second.cause);
const lateDefect = await Effect.runPromiseExit(register(owner, Effect.die("late-defect")));
const stillClosed = await Effect.runPromiseExit(close(owner));
console.log(JSON.stringify({ events, replayed, lateIsSeparate: Exit.isFailure(lateDefect) && Exit.isSuccess(stillClosed) }));
`,
    );
    assertEquals(result, {
      events: ["late-during-close", "release", "second", "late", "remaining"],
      replayed: true,
      lateIsSeparate: true,
    });
  });
});

Deno.test("scope registration captures services and evaluates arguments before execution", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/scopes/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["consumer.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Fiber, Layer } from "effect";
import { Audit, Work, Order, create, register, ordinary, close, ordered, provideOrdered } from "./owner.ts";
const events: string[] = [];
const owner = await Effect.runPromise(create());
const audit = (name: string) => Layer.succeed(Audit)({ release: () => Effect.sync(() => { events.push(name); }) });
await Effect.runPromise(register(owner).pipe(Effect.provide(audit("registration-context"))));
events.push("registered");
await Effect.runPromise(close(owner).pipe(Effect.provide(audit("closing-context"))));
await Effect.runPromise(register(owner).pipe(Effect.provide(audit("late-context"))));
const orderOwner = await Effect.runPromise(create());
const order = Layer.succeed(Order)({
  owner: () => Effect.sync(() => { events.push("owner"); return orderOwner; }),
  job: () => Effect.sync(() => { events.push("job"); return Effect.sync(() => { events.push("execute"); }); }),
  mark: (value: string) => Effect.sync(() => { events.push(value); }),
});
await Effect.runPromise(ordered().pipe(Effect.provide(order)));
await Effect.runPromise(provideOrdered().pipe(Effect.provide(order)));
await Effect.runPromise(close(orderOwner));
const another = await Effect.runPromise(create());
const entered = Deferred.makeUnsafe<void>();
const release = Deferred.makeUnsafe<void>();
const work = Layer.succeed(Work)({ wait: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(7)) });
const value = await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(ordinary(another).pipe(Effect.provide(work)));
  yield* Deferred.await(entered);
  yield* close(another);
  events.push("ordinary-still-running");
  yield* Deferred.succeed(release, undefined);
  return yield* Fiber.join(fiber);
}));
const after = await Effect.runPromise(ordinary(another).pipe(Effect.provide(work)));
console.log(JSON.stringify({ events, value, after }));
`,
    );
    assertEquals(result, {
      events: [
        "registered",
        "registration-context",
        "late-context",
        "owner",
        "job",
        "registered",
        "owner",
        "job",
        "execute",
        "execute",
        "ordinary-still-running",
      ],
      value: 7,
      after: 7,
    });
  });
});

Deno.test("mapGroups emits typed live routing with fresh state and closes unused or partial groups", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/groups/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const checked = checkProject(fileHost, dir, ["main.eff"]);
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        checked.value.analysis.project,
        lowerProject(checked.value),
      ).values()
    ) assertEquals(diagnostics, []);
    build(dir, ["main.eff"]);
    const formatted = await deno(dir, [
      "fmt",
      "--check",
      "main.ts",
      "contracts.ts",
    ]);
    assertEquals(formatted.code, 0, formatted.stderr);
    const result = await runScript(
      dir,
      `
import { Effect, Stream } from "effect";
import { grouped, skipped, firsts, branded } from "./main.ts";
import { Key } from "./contracts.ts";
let pulls = 0;
const source = Stream.unfold(0, n => Effect.sync(() => { pulls++; return n < 6 ? [n, n + 1] as const : undefined; }));
const saved = grouped(source);
const before = pulls;
const runs = [];
for (let run = 0; run < 2; run++) runs.push((await Effect.runPromise(Stream.runCollect(saved))).sort((a, b) => a.key - b.key));
const unused = (await Effect.runPromise(Stream.runCollect(skipped(Stream.make(0, 0, 0, 1, 1, 0, 2, 2, 0))))).sort();
const partial = (await Effect.runPromise(Stream.runCollect(firsts(Stream.make(0, 0, 0, 1, 1, 0, 2, 2, 0))))).sort((a, b) => a.key - b.key);
const keys = await Effect.runPromise(Stream.runCollect(branded(Stream.make(Key.make("a"), Key.make("b"), Key.make("a")))));
const empty = await Effect.runPromise(Stream.runCollect(grouped(Stream.empty)));
console.log(JSON.stringify({ before, pulls, runs, unused, partial, keys: keys.sort((a, b) => a[0]!.localeCompare(b[0]!)), empty }));
`,
    );
    const groups = [{ key: 0, items: [0, 3] }, { key: 1, items: [1, 4] }, {
      key: 2,
      items: [2, 5],
    }];
    assertEquals(result, {
      before: 0,
      pulls: 14,
      runs: [groups, groups],
      unused: [0, 1, 2],
      partial: [0, 1, 2].map((key) => ({
        key,
        first: { _id: "Option", _tag: "Some", value: key },
      })),
      keys: [["a", "a"], ["b"]],
      empty: [],
    });
  });
});

Deno.test("mapGroups emits a later live key, waits for cleanup, and applies per-key backpressure", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/groups/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { supervised } from "./main.ts";
import { Pull, Use } from "./contracts.ts";
const ready = Deferred.makeUnsafe<void>();
const events: string[] = [];
const source = Stream.unfold(0, (n): Effect.Effect<readonly [number, number]> => n < 2 ? Effect.succeed([n, n + 1] as const) : Effect.acquireUseRelease(
  Deferred.succeed(ready, undefined), () => Effect.never,
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("source-release"); })))));
const service = { value: (key: number) => Effect.acquireUseRelease(Effect.void,
  () => key === 0 ? Effect.never : Deferred.await(ready).pipe(Effect.as(key)),
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("group-release:" + key); })))) };
const first = await Effect.runPromise(Stream.runHead(supervised(source)).pipe(Effect.provideService(Use, service), Effect.provideService(Pull, { next: () => Effect.die("unexpected pull service") }), Effect.timeout("5 seconds")));
const entered = Deferred.makeUnsafe<void>();
const release = Deferred.makeUnsafe<void>();
const trace: string[] = [];
const pausedSource = Stream.unfold(0, n => Effect.sync(() => { trace.push("pull:" + n); return n < 4 ? [n < 3 ? 0 : 1, n + 1] as const : undefined; }));
let paused: string[] = [];
const outputs = await Effect.runPromise(Effect.gen(function* () {
  const child = yield* Effect.forkChild(Stream.runCollect(supervised(pausedSource)).pipe(Effect.provideService(Use, {
    value: key => key === 0 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(key)) : Effect.succeed(key)
  })));
  yield* Deferred.await(entered);
  yield* Effect.yieldNow;
  paused = trace.slice();
  yield* Deferred.succeed(release, undefined);
  return yield* Fiber.join(child);
}).pipe(Effect.provideService(Pull, { next: () => Effect.die("unexpected pull service") }), Effect.timeout("5 seconds")));
console.log(JSON.stringify({ first: Option.getOrUndefined(first), events: events.sort(), paused, outputs: outputs.sort(), trace }));
`,
    );
    assertEquals(result, {
      first: 1,
      events: ["group-release:0", "group-release:1", "source-release"],
      paused: ["pull:0", "pull:1", "pull:2"],
      outputs: [0, 1],
      trace: ["pull:0", "pull:1", "pull:2", "pull:3", "pull:4"],
    });
  });
});

Deno.test("mapGroups preserves construction and deferred services and closes callback-owned scoped workers", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/groups/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Effect, Exit, Option, Stream } from "effect";
import { deferred, scopedWork } from "./main.ts";
import { BuildStop, Factory, Pull, Use, Worker } from "./contracts.ts";
const calls: string[] = [];
const saved = await Effect.runPromise(deferred().pipe(Effect.provideService(Factory, {
  source: () => Effect.sync(() => { calls.push("build"); return Stream.unfold(0, n => Pull.use(p => p.next(n)).pipe(Effect.map(Option.getOrUndefined))); })
})));
const before = calls.slice();
const runs = [];
for (const prefix of [10, 20]) runs.push((await Effect.runPromise(Stream.runCollect(saved).pipe(
  Effect.provideService(Pull, { next: n => Effect.sync(() => { calls.push("pull:" + prefix + ":" + n); return n < 2 ? Option.some([n, n + 1] as const) : Option.none(); }) }),
  Effect.provideService(Use, { value: key => Effect.sync(() => { calls.push("use:" + prefix + ":" + key); return prefix + key; }) })
))).sort());
const failed = await Effect.runPromiseExit(deferred().pipe(Effect.provideService(Factory, { source: () => Effect.fail(new BuildStop({})) })));
const started = new Map<number, Deferred.Deferred<void>>([[0, Deferred.makeUnsafe<void>()], [1, Deferred.makeUnsafe<void>()]]);
const workerEvents: string[] = [];
const worker = {
  run: (key: number) => Effect.acquireUseRelease(Deferred.succeed(started.get(key)!, undefined), () => Effect.never,
    () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { workerEvents.push("release:" + key); })))),
  wait: (key: number) => Deferred.await(started.get(key)!)
};
const worked: number[] = [];
await Effect.runPromise(Stream.runForEach(scopedWork(Stream.make(0, 1)), key => Effect.sync(() => {
  if (!workerEvents.includes("release:" + key)) throw new Error("result before callback worker cleanup");
  worked.push(key);
})).pipe(Effect.provideService(Worker, worker), Effect.timeout("5 seconds")));
console.log(JSON.stringify({ before, runs, buildFailure: Exit.isFailure(failed) && Option.getOrUndefined(Cause.findErrorOption(failed.cause))?._tag,
  pulls: calls.filter(c => c.startsWith("pull:")).length, uses: calls.filter(c => c.startsWith("use:")).length,
  worked: worked.sort(), workerEvents: workerEvents.sort() }));
`,
    );
    assertEquals(result, {
      before: ["build"],
      runs: [[10, 11], [20, 21]],
      buildFailure: "contracts#BuildStop",
      pulls: 6,
      uses: 4,
      worked: [0, 1],
      workerEvents: ["release:0", "release:1"],
    });
  });
});

Deno.test("mapGroups source failure, callback failure, and interruption await peer cleanup", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/groups/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { supervised } from "./main.ts";
import { Pull, SourceStop, Use, UseStop } from "./contracts.ts";
const outcomes = [];
for (const mode of ["source", "callback", "interrupt"] as const) {
  const entered = Deferred.makeUnsafe<void>();
  const ready = Deferred.makeUnsafe<void>();
  const peer = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const source = mode === "source" ? Stream.concat(Stream.make(0), Stream.fromEffect(Deferred.await(entered).pipe(Effect.andThen(Effect.fail(new SourceStop({}))))))
    : mode === "interrupt" ? Stream.make(0) : Stream.concat(Stream.make(0, 1), Stream.fromEffect(Effect.acquireUseRelease(Deferred.succeed(ready, undefined), () => Effect.never,
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("source-release"); }))))));
  const program = Stream.runDrain(supervised(source)).pipe(Effect.provideService(Use, {
    value: key => Effect.acquireUseRelease(Deferred.succeed(entered, undefined),
      () => mode === "callback" ? key === 0 ? Deferred.await(peer).pipe(Effect.andThen(Deferred.await(ready)), Effect.andThen(Effect.fail(new UseStop({}))))
        : Deferred.succeed(peer, undefined).pipe(Effect.andThen(Effect.never)) : Effect.never,
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("group-release:" + key); }))))
  }), Effect.provideService(Pull, { next: () => Effect.die("unexpected pull service") }));
  const exit = mode === "interrupt" ? await Effect.runPromise(Effect.gen(function* () {
    const child = yield* Effect.forkChild(program);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(child);
    return yield* Fiber.await(child);
  }).pipe(Effect.timeout("5 seconds"))) : await Effect.runPromiseExit(program.pipe(Effect.timeout("5 seconds")));
  outcomes.push({ mode, failed: Exit.isFailure(exit), error: Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag ?? null : null, events: events.sort() });
}
console.log(JSON.stringify(outcomes));
`,
    );
    assertEquals(result, [
      {
        mode: "source",
        failed: true,
        error: "contracts#SourceStop",
        events: ["group-release:0"],
      },
      {
        mode: "callback",
        failed: true,
        error: "contracts#UseStop",
        events: ["group-release:0", "group-release:1", "source-release"],
      },
      {
        mode: "interrupt",
        failed: true,
        error: null,
        events: ["group-release:0"],
      },
    ]);
  });
});

Deno.test("Sink transduction replays chunks, repeats with fresh state, and preserves terminal semantics", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const checked = checkProject(fileHost, dir, ["main.eff"]);
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        checked.value.analysis.project,
        lowerProject(checked.value),
      ).values()
    ) assertEquals(diagnostics, []);
    build(dir, ["main.eff"]);
    const formatted = await deno(dir, [
      "fmt",
      "--check",
      "main.ts",
      "contracts.ts",
    ]);
    assertEquals(formatted.code, 0, formatted.stderr);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Sink, Stream } from "effect";
import { batches, inline, first, broad, discardForeign, makePairs, withSink } from "./main.ts";
const outputs: Array<Array<ReadonlyArray<number>>> = [];
for (const size of [1, 2, 3, 10]) {
  const source = Stream.fromArray([1, 2, 3, 4, 5]).pipe(Stream.rechunk(size));
  const saved = batches(source);
  for (let run = 0; run < 2; run++) outputs.push(await Effect.runPromise(Stream.runCollect(saved)));
}
const exact = await Effect.runPromise(Stream.runCollect(inline(Stream.make(1, 2, 3, 4))));
const empty = await Effect.runPromise(Stream.runCollect(inline(Stream.empty)));
const terminal = await Effect.runPromise(first(Stream.make(1, 2, 3, 4)));
const wider = await Effect.runPromise(Stream.runCollect(broad(Stream.make("a", "b"), Sink.take<string | number>(2))));
const foreign = await Effect.runPromise(discardForeign(Stream.make(1, 2), Sink.succeed("ok", ["rest"])));
const made = await Effect.runPromise(Stream.runCollect(withSink(Stream.make(1, 2, 3), makePairs())));
const trace: string[] = [];
const chunked = Stream.fromPull(Effect.sync(() => {
  let index = 0;
  return Effect.suspend(() => { trace.push("pull:" + index); return index++ === 0 ? Effect.succeed([1, 2, 3, 4, 5] as const) : Cause.done(); });
}));
await Effect.runPromise(Stream.runForEach(batches(chunked), (batch) => Effect.sync(() => { trace.push("batch:" + batch.join(",")); })));
let zeroPulls = 0;
const unpulled = Stream.unfold(0, (n) => Effect.sync(() => { zeroPulls++; return [n, n + 1] as const; }));
const zero = await Effect.runPromise(Stream.runCollect(withSink(unpulled, Sink.succeed([42])).pipe(Stream.take(3))));
console.log(JSON.stringify({ outputs, exact, empty, terminal, wider, foreign, made, trace, zeroPulls, zero }));
`,
    );
    assertEquals(result, {
      outputs: Array.from({ length: 8 }, () => [[1, 2], [3, 4], [5]]),
      exact: [[1, 2], [3, 4], []],
      empty: [[]],
      terminal: [1, 2],
      wider: [["a", "b"], []],
      foreign: "ok",
      made: [[1, 2], [3]],
      trace: ["pull:0", "batch:1,2", "batch:3,4", "pull:1", "batch:5"],
      zeroPulls: 0,
      zero: [[42], [42], [42]],
    });
  });
});

Deno.test("Sink construction effects stay separate from consumption services and failures", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect";
import { Add, Factory, Pull, SourceStop, SinkStop, BuildStop } from "./contracts.ts";
import { fromFactory } from "./main.ts";
const events: string[] = [];
const factory = Layer.succeed(Factory)({
  source: () => Effect.sync(() => { events.push("source"); return Stream.unfold(0, (n) => Pull.use((pull) => pull.next(n)).pipe(Effect.map(Option.getOrUndefined))); }),
  sink: () => Effect.sync(() => { events.push("sink"); return Sink.foldUntil(() => 0, 2, (sum: number, n: number) => Add.use((add) => add.add(sum, n))); }),
});
const stream: Stream.Stream<number, SourceStop | SinkStop, Pull | Add> = await Effect.runPromise(fromFactory().pipe(Effect.provide(factory)));
const atConstruction = [...events];
const consume = (sourceFail: boolean, sinkFail: boolean) => {
  const seen: number[] = [];
  const job = Stream.runForEach(stream, (value) => Effect.sync(() => { seen.push(value); })).pipe(
    Effect.provideService(Pull, { next: (state) => Effect.sync(() => { events.push("pull:" + state); }).pipe(Effect.andThen(sourceFail && state === 3 ? Effect.fail(new SourceStop({})) : Effect.succeed(state < 4 ? Option.some([state + 1, state + 1] as const) : Option.none()))) }),
    Effect.provideService(Add, { add: (sum, n) => Effect.sync(() => { events.push("add:" + n); }).pipe(Effect.andThen(sinkFail && n === 3 ? Effect.fail(new SinkStop({})) : Effect.succeed(sum + n))) }),
  );
  return Effect.exit(job).pipe(Effect.map((exit) => ({ seen, tag: Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag : "Success" })));
};
const sinkFailure = await Effect.runPromise(consume(false, true));
const sourceFailure = await Effect.runPromise(consume(true, false));
const success = await Effect.runPromise(consume(false, false));
const failed = await Effect.runPromiseExit(fromFactory().pipe(Effect.provideService(Factory, {
  source: () => Effect.fail(new BuildStop({})),
  sink: () => Effect.sync(() => { throw new Error("sink constructed after failed source"); }),
})));
console.log(JSON.stringify({ atConstruction, sinkFailure, sourceFailure, success, buildFailure: Exit.isFailure(failed) && Cause.hasFails(failed.cause) }));
`,
    );
    assertEquals(result, {
      atConstruction: ["source", "sink"],
      sinkFailure: { seen: [3], tag: "contracts#SinkStop" },
      sourceFailure: { seen: [3, 3], tag: "contracts#SourceStop" },
      success: { seen: [3, 7, 0], tag: "Success" },
      buildFailure: true,
    });
  });
});

Deno.test("Sink transduction retains consumption scopes and closes pending pulls on interruption", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Sink, Stream } from "effect";
import { batches, withSink } from "./main.ts";
const events: string[] = [];
let index = 0;
const tracked = Sink.fromTransform<number, number[], never, never, number>((upstream, scope) => Effect.gen(function* () {
  const current = ++index;
  events.push("start:" + current);
  yield* Scope.addFinalizer(scope, Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release:" + current); }))));
  return yield* Sink.take<number>(2).transform(upstream, scope);
}));
await Effect.runPromise(Stream.runForEach(withSink(Stream.make(1, 2, 3), tracked), (value) => Effect.sync(() => { events.push("batch:" + value.join(",")); })));
const normal = [...events];
events.length = 0;
const failure = await Effect.runPromiseExit(Stream.runForEach(withSink(Stream.make(1, 2, 3), tracked), () => Effect.fail("consumer-stop")));
const consumerReleased = events.includes("release:3") && Exit.isFailure(failure);
events.length = 0;
const entered = Deferred.makeUnsafe<void>();
const pending = Stream.unfold(0, (state): Effect.Effect<readonly [number, number]> => state === 0 ? Effect.succeed([1, 1] as const) : Effect.acquireUseRelease(
  Deferred.succeed(entered, undefined), () => Effect.never,
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("source-release"); }))),
));
await Effect.runPromise(Effect.gen(function* () {
  const child = yield* Effect.forkChild(Stream.runDrain(withSink(pending, tracked)));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(child);
}));
const interrupted = [...events].sort();
const seen: Array<ReadonlyArray<number>> = [];
const defect = await Effect.runPromiseExit(Stream.runForEach(batches(Stream.concat(Stream.make(1, 2, 3), Stream.fromEffect(Effect.die("source-defect")))), (value) => Effect.sync(() => { seen.push(value); })));
console.log(JSON.stringify({ normal, consumerReleased, interrupted, seen, defect: Exit.isFailure(defect) && Cause.hasDies(defect.cause) }));
`,
    );
    assertEquals(result, {
      normal: [
        "start:1",
        "batch:1,2",
        "start:2",
        "batch:3",
        "release:2",
        "release:1",
      ],
      consumerReleased: true,
      interrupted: ["release:4", "source-release", "start:4"],
      seen: [[1, 2]],
      defect: true,
    });
  });
});

Deno.test("Sink host providers retain leftover types across the existing interface boundary", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(
      `${dir}/effektive.json`,
      JSON.stringify({
        host: { sinks: { interface: "./host.effi", module: "./host.ts" } },
      }),
    );
    build(dir, ["host-main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect, Stream } from "effect";
import { make } from "./host-main.ts";
import { Add, Pull } from "./contracts.ts";
const source = await Effect.runPromise(make());
const values = await Effect.runPromise(Stream.runCollect(source).pipe(
  Effect.provideService(Add, { add: (sum, n) => Effect.succeed(sum + n) }),
  Effect.provideService(Pull, { next: () => Effect.die("unexpected pull service") }),
));
console.log(JSON.stringify(values));
`,
    );
    assertEquals(result, [3, 3]);
    Deno.writeTextFileSync(
      `${dir}/host.ts`,
      `
import { Effect, Layer, Sink, Stream } from "effect";
import { Factory } from "./contracts.ts";
export const FactoryLive = Layer.succeed(Factory)({
  source: () => Effect.succeed(Stream.make(1)),
  sink: () => Effect.succeed(Sink.succeed(1, ["wrong leftover"])),
});
`,
    );
    const wrong = await deno(dir, ["check", "host-main.ts"]);
    assert(
      wrong.code !== 0 && wrong.stderr.includes("string") &&
        wrong.stderr.includes("number"),
      wrong.stderr,
    );
  });
});

Deno.test("aggregateStream emits target batches, replay, and demand behavior", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const checked = checkProject(fileHost, dir, ["main.eff"]);
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        checked.value.analysis.project,
        lowerProject(checked.value),
      ).values()
    ) assertEquals(diagnostics, []);
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { aggregated, aggregatedInline, aggregateOne, aggregatedBroad, aggregateWithSink } from "./main.ts";
const outputs: Array<Array<ReadonlyArray<number>>> = [];
const targetOutputs: Array<Array<ReadonlyArray<number>>> = [];
for (const size of [1, 2, 3, 10]) {
  const source = Stream.fromArray([1, 2, 3, 4, 5]).pipe(Stream.rechunk(size));
  const saved = aggregated(source);
  for (let run = 0; run < 2; run++) {
    outputs.push(await Effect.runPromise(Stream.runCollect(saved)));
    targetOutputs.push(await Effect.runPromise(Stream.runCollect(Stream.aggregate(source, Sink.take<number>(2)))));
  }
}
const exact = await Effect.runPromise(Stream.runCollect(aggregatedInline(Stream.make(1, 2, 3, 4))));
const empty = await Effect.runPromise(Stream.runCollect(aggregatedInline(Stream.empty)));
const broad = await Effect.runPromise(Stream.runCollect(aggregatedBroad(Stream.make("a", "b"), Sink.take<string | number>(2))));
const zero = await Effect.runPromise(Stream.runCollect(aggregateWithSink(Stream.never, Sink.succeed([42])).pipe(Stream.take(3))));
let pulls = 0;
const demand = await Effect.runPromise(Effect.gen(function* () {
  const first = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const source = Stream.unfold(0, (n) => Effect.sync(() => { pulls++; return n < 3 ? [n + 1, n + 1] as const : undefined; }));
  const child = yield* Stream.runForEach(aggregateOne(source), (batch) => batch[0] === 1
    ? Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(release)))
    : Effect.void).pipe(Effect.forkChild);
  yield* Deferred.await(first);
  yield* Effect.yieldNow;
  const blocked = pulls;
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(child);
  return { blocked, total: pulls };
}).pipe(Effect.timeout("5 seconds")));
console.log(JSON.stringify({ outputs, targetOutputs, exact, empty, broad, zero, demand }));
`,
    );
    const actual = result as {
      outputs: unknown[];
      targetOutputs: unknown[];
      exact: unknown;
      empty: unknown;
      broad: unknown;
      zero: unknown;
      demand: unknown;
    };
    assertEquals(actual.outputs, actual.targetOutputs);
    assertEquals(actual.outputs.length, 8);
    assertEquals({
      exact: actual.exact,
      empty: actual.empty,
      broad: actual.broad,
      zero: actual.zero,
      demand: actual.demand,
    }, {
      exact: [[1, 2], [3, 4]],
      empty: [],
      broad: [["a", "b"]],
      zero: [[42], [42], [42]],
      demand: { blocked: 1, total: 4 },
    });
  });
});

Deno.test("aggregateStream retains deferred failures and awaits cancellation cleanup", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/sinks/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Sink, Stream } from "effect";
import { aggregatedFailing, aggregateWithSink, aggregateFromFactory } from "./main.ts";
import { Add, BuildStop, Factory, Pull, SinkStop, SourceStop } from "./contracts.ts";
const seen: Array<ReadonlyArray<number>> = [];
const sourceFailure = await Effect.runPromiseExit(Stream.runForEach(
  aggregatedFailing(Stream.concat(Stream.fromArray([1, 2, 3]), Stream.fail(new SourceStop({})))),
  (batch) => Effect.sync(() => { seen.push(batch); }),
));
const events: string[] = [];
const factory = Layer.succeed(Factory)({
  source: () => Effect.sync(() => { events.push("source"); return Stream.unwrap(Pull.use((pull) => pull.next(0)).pipe(Effect.map(() => Stream.fromArray([1, 2, 3, 4])))); }),
  sink: () => Effect.sync(() => { events.push("sink"); return Sink.foldUntil(() => 0, 2, (sum: number, n: number) => Add.use((add) => add.add(sum, n))); }),
});

const saved = await Effect.runPromise(aggregateFromFactory().pipe(Effect.provide(factory)));
const atConstruction = [...events];
const consume = (failSink: boolean) => {
  const values: number[] = [];
  return Effect.exit(Stream.runForEach(saved, (n) => Effect.sync(() => { values.push(n); })).pipe(
    Effect.provideService(Pull, { next: (state) => Effect.succeed(state < 4 ? Option.some([state + 1, state + 1] as const) : Option.none()) }),
    Effect.provideService(Add, { add: (sum, n) => failSink && n === 3 ? Effect.fail(new SinkStop({})) : Effect.succeed(sum + n) }),
  )).pipe(Effect.map((exit) => ({ values, tag: Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag : "Success" })));
};
const failed = await Effect.runPromise(consume(true));
const succeeded = await Effect.runPromise(consume(false));
const buildFailure = await Effect.runPromiseExit(aggregateFromFactory().pipe(Effect.provideService(Factory, {
  source: () => Effect.fail(new BuildStop({})),
  sink: () => Effect.sync(() => { throw new Error("sink should not be constructed"); }),
})));
const cleanup: string[] = [];
const cancellation = await Effect.runPromise(Effect.gen(function* () {
  const pending = yield* Deferred.make<void>();
  const source = Stream.unfold(0, (n): Effect.Effect<readonly [number, number] | undefined> => n === 0
    ? Effect.succeed([1, 1] as const)
    : Effect.acquireUseRelease(
      Deferred.succeed(pending, undefined), () => Effect.never,
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { cleanup.push("source-release"); }))),
    ));
  const child = yield* Stream.runCollect(aggregateWithSink(source, Sink.take<number>(2))).pipe(Effect.forkChild);
  yield* Deferred.await(pending);
  yield* Fiber.interrupt(child);
  return yield* Effect.exit(Fiber.join(child));
}).pipe(Effect.timeout("5 seconds")));
console.log(JSON.stringify({
  seen, sourceFailure: Exit.isFailure(sourceFailure) && Option.getOrUndefined(Cause.findErrorOption(sourceFailure.cause))?._tag,
  atConstruction, failed, succeeded, buildFailure: Exit.isFailure(buildFailure) && Cause.hasFails(buildFailure.cause),
  cancellation: Exit.isFailure(cancellation) && Cause.hasInterrupts(cancellation.cause), cleanup,
}));
`,
    );
    assertEquals(result, {
      seen: [[1, 2], [3]],
      sourceFailure: "contracts#SourceStop",
      atConstruction: ["source", "sink"],
      failed: { values: [3], tag: "contracts#SinkStop" },
      succeeded: { values: [3, 7], tag: "Success" },
      buildFailure: true,
      cancellation: true,
      cleanup: ["source-release"],
    });
  });
});

Deno.test("general Schedule values drive timed aggregation with fresh state and cleanup", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/schedules/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const checked = checkProject(fileHost, dir, ["main.eff"]);
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        checked.value.analysis.project,
        lowerProject(checked.value),
      ).values()
    ) {
      assertEquals(diagnostics, []);
    }
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Pull, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";
import { controlled, custom, early, mapped, Policy, Stop, timed } from "./main.ts";
let chooseCalls = 0;
let labelCalls = 0;
const good = {
  choose: (_input: Option.Option<ReadonlyArray<number>>, attempt: number) => Effect.sync(() => { chooseCalls++; return attempt; }),
  label: (output: number) => Effect.sync(() => { labelCalls++; return output + 100; }),
};
const atConstruction = [chooseCalls, labelCalls];
const run = Effect.gen(function* () {
  const step = yield* Schedule.toStep(mapped);
  const [first, firstDelay] = yield* step(0, Option.none());
  const [second] = yield* step(1, Option.some([1]));
  const done = yield* Pull.matchEffect(step(2, Option.some([2])), {
    onSuccess: () => Effect.succeed(-1),
    onDone: Effect.succeed,
    onFailure: Effect.failCause,
  });
  return [first, Duration.toMillis(firstDelay), second, done];
});

const first = await Effect.runPromise(Effect.provideService(run, Policy, good));
const second = await Effect.runPromise(Effect.provideService(run, Policy, good));
let failedLabels = 0;
const completionFailure = await Effect.runPromiseExit(Effect.provideService(run, Policy, {
  choose: good.choose,
  label: (output: number) => Effect.sync(() => ++failedLabels).pipe(Effect.flatMap((n) =>
    n === 3 ? Effect.fail(new Stop({})) : Effect.succeed(output + 100))),
}));
let pulls = 0;
const ended = await Effect.runPromise(Stream.runCollect(early(Stream.unfold(0, (n) => Effect.sync(() => {
  pulls++;
  return n < 3 ? [n + 1, n + 1] as const : undefined;
})))).pipe(Effect.timeout("5 seconds")));
const flushed = await Effect.runPromise(Effect.gen(function* () {
  const firstPull = yield* Deferred.make<void>();
  const source = Stream.unfold(0, (n): Effect.Effect<readonly [number, number] | undefined> =>
    n === 0 ? Deferred.succeed(firstPull, undefined).pipe(Effect.as([1, 1] as const)) : Effect.never);
  const fiber = yield* Stream.runCollect(Stream.take(timed(source), 1)).pipe(Effect.forkChild);
  yield* Deferred.await(firstPull);
  yield* TestClock.adjust("1 seconds");
  return yield* Fiber.join(fiber);
}).pipe(Effect.provide(TestClock.layer()), Effect.timeout("5 seconds")));
const events: string[] = [];
const source = Stream.scoped(Stream.fromEffect(Effect.acquireRelease(
  Effect.sync(() => { events.push("acquire"); return 1; }),
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release"); }))),
))).pipe(Stream.concat(Stream.never));
const failed = await Effect.runPromiseExit(Stream.runCollect(controlled(source)).pipe(
  Effect.provideService(Policy, {
    choose: good.choose,
    label: (_output: number) => Effect.fail(new Stop({})),
  }),
  Effect.timeout("5 seconds"),
));
console.log(JSON.stringify({
  atConstruction, first, second, chooseCalls, labelCalls, failedLabels,
  completionFailure: Exit.isFailure(completionFailure) ? Option.getOrUndefined(Cause.findErrorOption(completionFailure.cause))?._tag : "Success",
  ended, pulls, flushed, events,
  failed: Exit.isFailure(failed) ? Option.getOrUndefined(Cause.findErrorOption(failed.cause))?._tag : "Success",
}));
`,
    );
    assertEquals(result, {
      atConstruction: [0, 0],
      first: [101, 0, 102, 102],
      second: [101, 0, 102, 102],
      chooseCalls: 11,
      labelCalls: 6,
      failedLabels: 3,
      completionFailure: "main#Stop",
      ended: [[1]],
      pulls: 1,
      flushed: [[1]],
      events: ["acquire", "release"],
      failed: "main#Stop",
    });
  });
});

Deno.test("composed Schedule values preserve delays, phases, fresh state, and failure", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/schedules/", FIXTURES), dir);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    const checked = checkProject(fileHost, dir, ["composition.eff"]);
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, []);
    for (
      const diagnostics of validateProject(
        checked.value.analysis.project,
        lowerProject(checked.value),
      ).values()
    ) {
      assertEquals(diagnostics, []);
    }
    build(dir, ["composition.eff"]);
    const result = await runScript(
      dir,
      `
import { Cause, Duration, Effect, Exit, Option, Pull, Schedule, Stream } from "effect";
import { assembled, batches, combined, Factory, fastest, LeftPolicy, LeftStop, phases, RightPolicy, RightStop, short, slowest } from "./composition.ts";
const trace = (policy: Schedule.Schedule<number>) => Effect.gen(function* () {
  const step = yield* Schedule.toStep(policy);
  const decisions: unknown[] = [];
  for (let index = 0; index < 6; index++) {
    const result = yield* Pull.matchEffect(step(index * 100, undefined), {
      onSuccess: ([output, delay]) => Effect.succeed({ kind: "Continue" as const, output, delay: Duration.toMillis(delay) }),
      onDone: (output) => Effect.succeed({ kind: "Done" as const, output }),
      onFailure: Effect.failCause,
    });
    decisions.push(result);
    if (result.kind === "Done") break;
  }
  return decisions;
});
const first = [
  await Effect.runPromise(trace(slowest)),
  await Effect.runPromise(trace(fastest)),
  await Effect.runPromise(trace(phases)),
];
const second = [
  await Effect.runPromise(trace(slowest)),
  await Effect.runPromise(trace(fastest)),
  await Effect.runPromise(trace(phases)),
];
let leftCalls = 0;
let rightCalls = 0;
const service = {
  left: { next: () => Effect.sync(() => ++leftCalls).pipe(Effect.flatMap((n) => n === 2 ? Effect.fail(new LeftStop({})) : Effect.succeed(n))) },
  right: { next: () => Effect.sync(() => ++rightCalls) },
};
const atConstruction = [leftCalls, rightCalls];
let factoryCalls = 0;
const built = await Effect.runPromise(assembled().pipe(Effect.provideService(Factory, {
  make: () => Effect.sync(() => { factoryCalls++; return short; }),
})));
const beforeStep = [factoryCalls, leftCalls, rightCalls];
const constructed = await Effect.runPromise(Effect.gen(function* () {
  const step = yield* Schedule.toStep(built);
  const [output, delay] = yield* step(0, Option.none());
  return [output, Duration.toMillis(delay)];
}).pipe(Effect.provideService(LeftPolicy, { next: () => Effect.succeed(7) })));
const failure = await Effect.runPromise(Effect.gen(function* () {
  const step = yield* Schedule.toStep(combined);
  const [output, delay] = yield* step(0, Option.none());
  const exit = yield* Effect.exit(step(1, Option.some([1])));
  return { output, delay: Duration.toMillis(delay), exit };
}).pipe(
  Effect.provideService(LeftPolicy, service.left),
  Effect.provideService(RightPolicy, service.right),
));
let otherRightCalls = 0;
const rightFailure = await Effect.runPromiseExit(Effect.gen(function* () {
  const step = yield* Schedule.toStep(combined);
  return yield* step(0, Option.none());
}).pipe(
  Effect.provideService(LeftPolicy, { next: () => Effect.succeed(1) }),
  Effect.provideService(RightPolicy, { next: () => Effect.sync(() => ++otherRightCalls).pipe(Effect.flatMap(() => Effect.fail(new RightStop({})))) }),
));
const events: string[] = [];
const source = Stream.scoped(Stream.fromEffect(Effect.acquireRelease(
  Effect.sync(() => { events.push("acquire"); return 1; }),
  () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release"); }))),
))).pipe(Stream.concat(Stream.never));
const stopped = await Effect.runPromiseExit(Stream.runCollect(batches(source)).pipe(
  Effect.provideService(LeftPolicy, { next: () => Effect.fail(new LeftStop({})) }),
  Effect.provideService(RightPolicy, { next: () => Effect.succeed(1) }),
  Effect.timeout("5 seconds"),
));
console.log(JSON.stringify({
  first, second, atConstruction, factoryCalls, beforeStep, constructed, leftCalls, rightCalls,
  initial: [failure.output, failure.delay],
  failed: Exit.isFailure(failure.exit) ? Option.getOrUndefined(Cause.findErrorOption(failure.exit.cause))?._tag : "Success",
  rightFailed: Exit.isFailure(rightFailure) ? Option.getOrUndefined(Cause.findErrorOption(rightFailure.cause))?._tag : "Success",
  otherRightCalls,
  events,
  stopped: Exit.isFailure(stopped) ? Option.getOrUndefined(Cause.findErrorOption(stopped.cause))?._tag : "Success",
}));
`,
    );
    const shortExpected = [
      { kind: "Continue", output: 20, delay: 20 },
      { kind: "Done", output: 0 },
    ];
    const longExpected = [
      { kind: "Continue", output: 10, delay: 10 },
      { kind: "Continue", output: 20, delay: 20 },
      { kind: "Continue", output: 20, delay: 20 },
      { kind: "Done", output: 0 },
    ];
    const phasesExpected = [
      { kind: "Continue", output: 0, delay: 10 },
      { kind: "Continue", output: 0, delay: 20 },
      { kind: "Continue", output: 1, delay: 20 },
      { kind: "Continue", output: 2, delay: 20 },
      { kind: "Done", output: 3 },
    ];
    assertEquals(result, {
      first: [shortExpected, longExpected, phasesExpected],
      second: [shortExpected, longExpected, phasesExpected],
      atConstruction: [0, 0],
      factoryCalls: 1,
      beforeStep: [1, 0, 0],
      constructed: [10, 10],
      leftCalls: 2,
      rightCalls: 1,
      initial: [1, 1],
      failed: "composition#LeftStop",
      rightFailed: "composition#RightStop",
      otherRightCalls: 1,
      events: ["acquire", "release"],
      stopped: "composition#LeftStop",
    });
  });
});

Deno.test("a match throws for a value outside its type: pure, effect, and stream callback", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/unmatched/", FIXTURES), dir);
    build(dir, ["main.eff"]);
    await check(dir, ["main.ts"]);
    const result = await runScript(
      dir,
      `
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import * as M from "./main.ts";

const circle = M.Circle.make({ radius: "r" });
const square = M.Square.make({ side: "s" });
const outside = {
  shape: { _tag: "main#Other" },
  status: "refunded",
  figure: { kind: "triangle" },
};
const thrown = (run: () => unknown): string => {
  try {
    run();
    return "no throw";
  } catch (e) {
    return e instanceof TypeError ? e.message : String(e);
  }
};
const NamesLive = Layer.succeed(M.Names)({ label: () => Effect.succeed("n") });
const dies = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)
    ? (Cause.squash(exit.cause) as Error).message
    : "no defect";
const effectExit = (job: Effect.Effect<unknown, never, M.Names>) =>
  Effect.runPromiseExit(job.pipe(Effect.provide(NamesLive)));
const streamExit = <A>(stream: Stream.Stream<A>) =>
  Effect.runPromiseExit(Stream.runCollect(stream));

console.log(JSON.stringify({
  pure: [
    thrown(() => M.shapePure(outside.shape as never)),
    thrown(() => M.statusPure(outside.status as never)),
    thrown(() => M.figurePure(outside.figure as never)),
  ],
  effect: [
    dies(await effectExit(M.shapeEffect(outside.shape as never))),
    dies(await effectExit(M.statusEffect(outside.status as never))),
    dies(await effectExit(M.figureEffect(outside.figure as never))),
  ],
  stream: [
    dies(await streamExit(M.shapeStream(Stream.make(outside.shape as never)))),
    dies(await streamExit(M.statusStream(Stream.make(outside.status as never)))),
    dies(await streamExit(M.figureStream(Stream.make(outside.figure as never)))),
  ],
  valid: {
    pure: [
      M.shapePure(circle), M.shapePure(square),
      M.statusPure("pending"), M.statusPure("paid"),
      M.figurePure({ kind: "circle", radius: "r" }),
      M.figurePure({ kind: "square", side: "s" }),
    ],
    effect: await Effect.runPromise(
      Effect.all([M.shapeEffect(circle), M.shapeEffect(square), M.statusEffect("pending")])
        .pipe(Effect.provide(NamesLive)),
    ),
    stream: Array.from(await Effect.runPromise(Stream.runCollect(M.shapeStream(Stream.make(circle, square))))),
  },
  wild: [M.shapeWild(circle), M.shapeWild(outside.shape as never)],
}));
`,
    );
    const m = "a match received a value outside its type";
    assertEquals(result, {
      pure: [m, m, m],
      effect: [m, m, m],
      stream: [m, m, m],
      valid: {
        pure: ["r", "s", "p", "q", "r", "s"],
        effect: ["n", "s", "n"],
        stream: ["r", "s"],
      },
      wild: ["r", "other"],
    });
  });
});

// ------------------------------------------------------------------ host checks (HB4)

const HOST_CHECKS_ENTRIES = ["main.eff"];

const HOST_CHECKS_SCRIPT = `
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import * as C from "./contracts.ts";
import * as M from "./main.ts";

const ClockLive = Layer.succeed(C.Clock)({ now: () => Effect.succeed(7) });
const exitOf = <A, E>(job: Effect.Effect<A, E, C.Clock>) =>
  Effect.runPromiseExit(job.pipe(Effect.provide(ClockLive)));
const value = async <A, E>(job: Effect.Effect<A, E, C.Clock>): Promise<A> => {
  const exit = await exitOf(job);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};
const defect = async <A, E>(job: Effect.Effect<A, E, C.Clock>): Promise<string> => {
  const exit = await exitOf(job);
  return Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)
    ? (Cause.squash(exit.cause) as Error).message
    : "no defect";
};
const streamValue = <A, E>(job: Effect.Effect<Stream.Stream<A, E, C.Clock>, E, C.Clock>) =>
  job.pipe(Effect.flatMap((stream) => Effect.all([Stream.runCollect(stream), Stream.runCollect(Stream.chunks(stream))])));
`;

function buildHostChecks(dir: string): Built {
  copyDirectory(new URL("emit/host-checks/", FIXTURES), dir);
  return buildProject(dir, HOST_CHECKS_ENTRIES);
}

Deno.test("a host check accepts a data value with a missing optional prototype-named field", async () => {
  await withTemporary(async (dir) => {
    const files: Record<string, string> = {
      "effektive.json":
        '{ "host": { "h": { "interface": "./h.effi", "module": "./h.ts" } } }',
      "h.effi": [
        "export type Text = string",
        "export nominal Tok = { label: Text, toString?: Text }",
        "export service Auth { token(): Tok }",
        "export provider AuthLive provides Auth",
        "",
      ].join("\n"),
      "main.eff": [
        'import { Tok, Auth, AuthLive } from "host:h"',
        "export const token = (): Tok => provide(AuthLive, () => Auth.token())",
        "",
      ].join("\n"),
      "h.ts": [
        'import { Effect, Layer } from "effect";',
        'import { Auth, Tok } from "./h.effi.ts";',
        "// `make` reads the missing `toString` through the prototype chain.",
        'const input = Object.assign(Object.create(null), { label: "a" });',
        "export const AuthLive = Layer.succeed(Auth)({",
        "  token: () => Effect.succeed(Tok.make(input)),",
        "});",
        "",
      ].join("\n"),
    };
    for (const [path, text] of Object.entries(files)) {
      Deno.writeTextFileSync(`${dir}/${path}`, text);
    }
    build(dir, ["main.eff"]);
    const result = await runScript(
      dir,
      `
import { Effect } from "effect";
import { token } from "./main.ts";
console.log(JSON.stringify(await Effect.runPromise(token())));
`,
    );
    assertEquals(result, { _tag: "h#Tok", label: "a" });
  });
});

Deno.test("a wrapped host provider passes correct values, keeps stream chunks, and leaves other methods alone", async () => {
  await withTemporary(async (dir) => {
    const built = buildHostChecks(dir);
    assertEquals([...built.paths].sort(), [
      "contracts.ts",
      "host.effi.ts",
      "main.ts",
    ]);
    await check(dir, ["main.ts", "contracts.ts", "host.ts"]);
    const main = built.emitted.get("main")?.text ?? "";
    assert(main.includes("Layer.mergeAll("), main);
    const result = await runScript(
      dir,
      HOST_CHECKS_SCRIPT + `
const boom = await exitOf(M.get("boom"));
const [items, chunks] = await value(streamValue(M.watch()));
console.log(JSON.stringify({
  get: await value(M.get("k")),
  find: await value(M.find("f")),
  list: await value(M.list()),
  summary: await value(M.summary()),
  items,
  chunks: chunks.length,
  total: await value(M.total()),
  ping: await value(M.ping()),
  token: await Effect.runPromise(M.token()),
  boomFails: Exit.isFailure(boom) && Cause.hasFails(boom.cause) && !Cause.hasDies(boom.cause),
}));
`,
    );
    assertEquals(result, {
      get: { _tag: "contracts#Row", id: "k1" },
      find: {
        _id: "Option",
        _tag: "Some",
        value: { _tag: "contracts#Row", id: "f" },
      },
      list: [{ _tag: "contracts#Row", id: "r" }, {
        _tag: "contracts#Gap",
        id: "g",
      }],
      summary: { count: 2, first: { _tag: "contracts#Row", id: "first" } },
      items: [
        { _tag: "contracts#Row", id: "s1" },
        { _tag: "contracts#Gap", id: "s2" },
        { _tag: "contracts#Row", id: "s3" },
      ],
      chunks: 1,
      total: 7,
      ping: "pong",
      token: { _tag: "host#Token", id: "t" },
      boomFails: true,
    });
  });
});

Deno.test("a wrong tag through a cast dies on each checked method and names the method and the issue path", async () => {
  await withTemporary(async (dir) => {
    buildHostChecks(dir);
    Deno.copyFileSync(`${dir}/host-wrong.ts`, `${dir}/host.ts`);
    await check(dir, ["main.ts", "contracts.ts", "host.ts"]);
    const result = await runScript(
      dir,
      HOST_CHECKS_SCRIPT + `
console.log(JSON.stringify({
  get: await defect(M.get("k")),
  find: await defect(M.find("f")),
  list: await defect(M.list()),
  watch: await defect(streamValue(M.watch())),
  summary: await defect(M.summary()),
  total: await value(M.total()),
  ping: await value(M.ping()),
  token: await defect(M.token()),
}));
`,
    );
    assert(typeof result === "object" && result !== null);
    const found = result as Record<string, unknown>;
    const message = (method: string, path: string) => {
      const text = found[method];
      assert(typeof text === "string", `${method}: ${JSON.stringify(text)}`);
      assert(
        text.startsWith(
          `host value of Rows.${method} does not match its type: `,
        ),
        text,
      );
      assert(!text.includes("\n"), text);
      assert(path === "" || text.includes(path), `${method}: ${text}`);
    };
    message("get", "");
    message("find", "");
    message("list", "at [1]");
    message("watch", "");
    message("summary", 'at ["first"]');
    // A method without a data result passes the value through.
    assertEquals(found.total, 1.5);
    assertEquals(found.ping, "pong");
    // A data type of the host interface has a schema in the companion module, so its result is checked too.
    const token = found.token;
    assert(typeof token === "string", JSON.stringify(token));
    assert(
      token.startsWith("host value of Auth.token does not match its type: "),
      token,
    );
  });
});

Deno.test("the emitted host check modules are a fixed point of deno fmt", async () => {
  await withTemporary(async (dir) => {
    const built = buildHostChecks(dir);
    const run = await deno(dir, ["fmt", "--check", ...built.paths]);
    assertEquals(run.code, 0, `deno fmt --check failed:\n${run.stderr}`);
    assert(
      run.stderr.includes("Checked 3 files"),
      `deno fmt did not check all three files:\n${run.stderr}`,
    );
  });
});

Deno.test("a host module with its own service class and a missing method gives one host-boundary diagnostic on the wrapped provider", async () => {
  await withTemporary(async (dir) => {
    const built = buildHostChecks(dir);
    Deno.writeTextFileSync(
      `${dir}/host.ts`,
      [
        'import { Context, Effect, Layer } from "effect";',
        'import { Pings, Row } from "./contracts.ts";',
        'import { Auth, Token } from "./host.effi.ts";',
        'export const AuthLive = Layer.succeed(Auth)({ token: () => Effect.succeed(Token.make({ id: "t" })) });',
        'class OwnRows extends Context.Service<OwnRows, { readonly get: (key: string) => Effect.Effect<Row> }>()("contracts#Rows") {}',
        "export const RowsLive = Layer.merge(",
        '  Layer.succeed(OwnRows)({ get: () => Effect.succeed(Row.make({ id: "x" })) }),',
        '  Layer.succeed(Pings)({ ping: () => Effect.succeed("pong") }),',
        ");",
        "",
      ].join("\n"),
    );
    const run = await deno(dir, [
      "check",
      "--config",
      "deno.json",
      ...built.paths,
      "host.ts",
    ]);
    assertEquals(run.code, 1, `deno check should fail:\n${run.stderr}`);
    const output = parseDenoCheck(run.stderr, Deno.realPathSync(dir));
    assertEquals(output.other, [], run.stderr);
    const imports = hostImportSpans(built.project);
    const tables = new Map(
      [...built.emitted].map(([name, module]) => [
        module.path,
        buildSpanTable(module, imports.get(name)),
      ]),
    );
    const mapped = output.diagnostics.map((d) => mapTscDiagnostic(d, tables));
    assertEquals(mapped.length, 1, run.stderr);
    const only = mapped[0];
    assert(only.tag === "host-boundary", JSON.stringify(only));
    assertEquals(only.diagnostic.code, "host-boundary/001");
    const source = Deno.readTextFileSync(
      `${dir}/${only.diagnostic.span.source}`,
    );
    assertEquals(spanText(source, only.diagnostic.span), "RowsLive");
  });
});

// Slow tests for parts A6a and A6b. Each test copies a fixture project to a
// temporary directory, builds there, and runs `deno check`, `deno fmt`, or
// `deno run` on the result. Nothing is written under fixtures/.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { emitProject, type EmittedModule } from "../src/core/emit/emit.ts";
import { buildSpanTable, hostImportSpans } from "../src/core/emit/spans.ts";
import {
  hostModulePaths,
  mapTscDiagnostic,
  parseDenoCheck,
} from "../src/core/emit/tsc.ts";
import { lowerProject } from "../src/core/lower.ts";
import type { Project } from "../src/core/project.ts";
import {
  lineStarts,
  positionOf,
  type SourceHost,
  spanText,
} from "../src/core/source.ts";
import { EXAMPLE_ENTRIES, FIXTURES, hostBoundaryManifest } from "./helpers.ts";

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

function copyDirectory(from: URL, to: string): void {
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    const source = new URL(entry.name + (entry.isDirectory ? "/" : ""), from);
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) copyDirectory(source, target);
    else Deno.copyFileSync(source, target);
  }
}

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

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function deno(cwd: string, args: readonly string[]): Promise<Run> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function withTemporary<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix: "effective-emit-" });
  try {
    return await body(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

async function check(dir: string, files: readonly string[]): Promise<void> {
  const run = await deno(dir, ["check", "--config", "deno.json", ...files]);
  assertEquals(run.code, 0, `deno check failed:\n${run.stderr}`);
}

/** Runs a script in `dir` and parses its one line of JSON output. */
async function runScript(dir: string, script: string): Promise<unknown> {
  Deno.writeTextFileSync(`${dir}/run.ts`, script);
  const run = await deno(dir, [
    "run",
    "--config",
    "deno.json",
    "--check",
    "--no-prompt",
    "run.ts",
  ]);
  assertEquals(run.code, 0, `deno run failed:\n${run.stderr}`);
  const last = run.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(last);
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
    "optional-fields.eff",
    "brand-operators.eff",
    LONG_NAMES + ".eff",
  ]);
}

// ------------------------------------------------------------------ type check

Deno.test("the emitted examples and users-live.ts pass deno check under strict settings", async () => {
  await withTemporary(async (dir) => {
    const generated = buildExamples(dir);
    assertEquals(
      [...generated].sort(),
      ["collections.ts", "log.ts", "main.ts", "pay.ts", "users.ts"],
    );
    await check(dir, [...generated, "users-live.ts"]);
  });
});

Deno.test("the emitted forms and name-collision modules pass deno check", async () => {
  await withTemporary(async (dir) => {
    await check(dir, buildForms(dir));
  });
});

// ------------------------------------------------------------------ runtime

Deno.test("withResource releases after success, typed failure, and interruption", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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

Deno.test("source-authored streams pull incrementally through an effectful sink", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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

Deno.test("takeWhileStream omits the false element and closes upstream work", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
        "  runStream(takeWhileStream(source, (n) => n < limit), sink)",
        "",
      ].join("\n"),
    );
    build(dir, ["main.eff"]);
    await check(dir, ["main.ts"]);
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

Deno.test("a source race interrupts its losing fiber and waits for cleanup", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
Deno.test("withFiber interrupts its child and waits for finalizers", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
    await check(dir, ["main.ts"]);
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
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
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
  const goldenCount =
    [...Deno.readDirSync(new URL("../fixtures/golden/", import.meta.url))]
      .filter((entry) => entry.isFile && entry.name.endsWith(".ts")).length;
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
        "brand-operators.ts",
        "conditional-chains.ts",
        "forms.ts",
        "names.ts",
        "nominal-records.ts",
        "optional-fields.ts",
      ],
    );
    const run = await deno(dir, ["fmt", "--check", ...generated]);
    assertEquals(run.code, 0, `deno fmt --check failed:\n${run.stderr}`);
    assert(
      run.stderr.includes("Checked 7 files"),
      `deno fmt did not check the seven files:\n${run.stderr}`,
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

// Slow tests for parts A6a and A6b. Each test copies a fixture project to a
// temporary directory, builds there, and runs `deno check`, `deno fmt`, or
// `deno run` on the result. Nothing is written under fixtures/.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { emitProject, type EmittedModule } from "../src/core/emit/emit.ts";
import { buildSpanTable, hostImportSpans } from "../src/core/emit/spans.ts";
import { mapTscDiagnostic, parseDenoCheck } from "../src/core/emit/tsc.ts";
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

function buildForms(dir: string): string[] {
  copyDirectory(new URL("emit/forms/", FIXTURES), dir);
  return build(dir, ["forms.eff", "names.eff"]);
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
  assert(
    run.stderr.includes("Checked 5 files"),
    `deno fmt did not check the five golden files:\n${run.stderr}`,
  );
});

Deno.test("the emitted forms are a fixed point of deno fmt", async () => {
  await withTemporary(async (dir) => {
    const generated = buildForms(dir);
    assertEquals([...generated].sort(), ["forms.ts", "names.ts"]);
    const run = await deno(dir, ["fmt", "--check", ...generated]);
    assertEquals(run.code, 0, `deno fmt --check failed:\n${run.stderr}`);
    assert(
      run.stderr.includes("Checked 2 files"),
      `deno fmt did not check both files:\n${run.stderr}`,
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

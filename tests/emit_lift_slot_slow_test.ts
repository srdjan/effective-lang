// Slow tests for the slot type of a pure function value from an effect-mode
// expression (decision D6). Each test builds a program with the CLI and the
// `--tsc` check, then runs the emitted code with `Effect.runPromise`. The effect
// of a block runs once, and the returned function gives the right value.

import { assert, assertEquals } from "@std/assert";
import { LIFT_PROGRAMS } from "./lift_slot_programs.ts";
import { deno, runScript } from "./process_helpers.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

async function withProgram<T>(
  text: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix: "effektive-lift-" });
  try {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(`${dir}/m.eff`, text);
    return await body(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Builds the directory with `--validate --tsc`. The run must report no diagnostic. */
async function build(dir: string): Promise<void> {
  const run = await deno(dir, [
    "run",
    "-q",
    "--no-lock",
    "--allow-read",
    "--allow-write",
    "--allow-run=deno",
    CLI,
    "build",
    dir,
    "--validate",
    "--tsc",
  ]);
  assertEquals(run.code, 0, `build failed:\n${run.stdout}\n${run.stderr}`);
  const report = run.stdout + run.stderr;
  assert(
    report.includes(", 0 diagnostics"),
    `the build reports diagnostics:\n${report}`,
  );
}

/** Writes the strict `deno.json` of the lift tests, and runs the script as `runScript` does. */
function runLiftScript(dir: string, script: string): Promise<unknown> {
  Deno.writeTextFileSync(
    `${dir}/deno.json`,
    JSON.stringify({
      compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
      imports: { effect: "npm:effect@4.0.5" },
    }),
  );
  return runScript(dir, script);
}

for (const [name, text] of Object.entries(LIFT_PROGRAMS)) {
  Deno.test(`the ${name} program builds with no tsc diagnostic`, async () => {
    await withProgram(text, build);
  });
}

/** The prelude of a run script: a `Gate` that counts its calls and answers `answer`. */
function gateScript(exports: string, body: string): string {
  return `
import { Effect, Layer } from "effect";
import { ${exports}, Gate } from "./m.ts";

let calls = 0;
const live = (answer: number) => Layer.succeed(Gate)({
  pick: () => Effect.sync(() => { calls++; return answer; }),
});
/** Runs the effect, then the returned function on 3. Gives the value and the call count. */
const run = async (
  make: Effect.Effect<(n: number) => Effect.Effect<number, unknown>, unknown, Gate>,
  answer: number,
) => {
  calls = 0;
  const f = await Effect.runPromise(make.pipe(Effect.provide(live(answer))));
  const afterBlock = calls;
  const value = await Effect.runPromise(f(3));
  return { afterBlock, afterCall: calls, value };
};
${body}
`;
}

Deno.test("an if branch runs the block once and returns the wrapped function", async () => {
  await withProgram(LIFT_PROGRAMS.branch, async (dir) => {
    await build(dir);
    const result = await runLiftScript(
      dir,
      gateScript(
        "choose",
        `console.log(JSON.stringify({
  then: await run(choose(), 1),
  otherwise: await run(choose(), 0),
}));`,
      ),
    );
    assertEquals(result, {
      // The test and the block run `Gate.pick` twice in the then branch.
      then: { afterBlock: 2, afterCall: 2, value: 4 },
      otherwise: { afterBlock: 1, afterCall: 1, value: 5 },
    });
  });
});

Deno.test("a match arm runs the block once and returns the wrapped function", async () => {
  await withProgram(LIFT_PROGRAMS.arm, async (dir) => {
    await build(dir);
    const result = await runLiftScript(
      dir,
      gateScript(
        "choose",
        `console.log(JSON.stringify({
  block: await run(choose(), 0),
  other: await run(choose(), 7),
}));`,
      ),
    );
    assertEquals(result, {
      block: { afterBlock: 2, afterCall: 2, value: 4 },
      other: { afterBlock: 1, afterCall: 1, value: 5 },
    });
  });
});

Deno.test("an effect function body runs its block once and returns the wrapped function", async () => {
  await withProgram(LIFT_PROGRAMS.result, async (dir) => {
    await build(dir);
    const result = await runLiftScript(
      dir,
      gateScript(
        "chosen, viaConstant, declared",
        `console.log(JSON.stringify({
  chosen: await run(chosen(), 0),
  viaConstant: await run(viaConstant(), 0),
  declared: await run(declared(), 0),
}));`,
      ),
    );
    const once = { afterBlock: 1, afterCall: 1, value: 4 };
    assertEquals(result, { chosen: once, viaConstant: once, declared: once });
  });
});

Deno.test("a call with an inferred pure function result runs once and returns the wrapped function", async () => {
  await withProgram(LIFT_PROGRAMS.inferred, async (dir) => {
    await build(dir);
    const result = await runLiftScript(
      dir,
      gateScript(
        "chosen, viaConstant",
        `console.log(JSON.stringify({
  chosen: await run(chosen(), 0),
  viaConstant: await run(viaConstant(), 0),
}));`,
      ),
    );
    const once = { afterBlock: 1, afterCall: 1, value: 4 };
    assertEquals(result, { chosen: once, viaConstant: once });
  });
});

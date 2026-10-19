import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

/**
 * Compiles one Effective module with the validator, writes the emitted
 * TypeScript beside `run.ts`, and runs `run.ts` after a strict type check.
 * Returns the JSON that `run.ts` prints to standard output.
 */
async function compileAndRun(source: string, run: string): Promise<unknown> {
  const project = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-schedule-emit-" });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      }),
    );
    for (
      const result of emitProject(lowered, {
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(`${dir}/run.ts`, run);
    const decoder = new TextDecoder();
    let stdout = "";
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        decoder.decode(result.stderr) + decoder.decode(result.stdout),
      );
      stdout = decoder.decode(result.stdout);
    }
    return JSON.parse(stdout);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("scheduleFromStep runs its initial state per execution, not at module load", async () => {
  const result = await compileAndRun(
    `type Int = int
const big: Int = 9007199254740991
export const overflow: Schedule<Int> = scheduleFromStep(
  (): Int => big + 1,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Int> =>
    ({ kind: "Done", output: state })
)
`,
    `import { Cause, Effect, Exit, Schedule } from "effect";
const loaded = await import("./main.ts");
const step = Effect.gen(function* () {
  const next = yield* Schedule.toStep(loaded.overflow);
  return yield* next(0, undefined);
});
const exit = await Effect.runPromiseExit(step);
console.log(JSON.stringify({
  loaded: loaded.overflow !== undefined,
  defect: Exit.isFailure(exit) && Cause.hasDies(exit.cause) &&
    Cause.pretty(exit.cause).includes("int overflow"),
}));
`,
  );
  assertEquals(result, { loaded: true, defect: true });
});

Deno.test("scheduleFromStep builds a fresh initial record for every execution", async () => {
  const result = await compileAndRun(
    `type Int = int
type Counter = { count: Int }
export const records: Schedule<Counter> = scheduleFromStep(
  (): Counter => ({ count: 0 }),
  (state: Counter, meta: ScheduleInput<unknown>): ScheduleDecision<Counter, Counter> =>
    ({ kind: "Continue", state: state, output: state, delayMillis: 0 })
)
`,
    `import { Effect, Schedule } from "effect";
import { records } from "./main.ts";
const execute = Effect.gen(function* () {
  const next = yield* Schedule.toStep(records);
  const [first] = yield* next(0, undefined);
  const [second] = yield* next(1, undefined);
  return [first, second] as const;
});
const one = await Effect.runPromise(execute);
const two = await Effect.runPromise(execute);
console.log(JSON.stringify({
  one: one[0], two: two[0],
  sameWithinExecution: one[0] === one[1],
  sameAcrossExecutions: one[0] === two[0],
}));
`,
  );
  assertEquals(result, {
    one: { count: 0 },
    two: { count: 0 },
    sameWithinExecution: true,
    sameAcrossExecutions: false,
  });
});

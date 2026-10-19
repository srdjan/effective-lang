import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const widened = `type Int = int
type Millis = number
export const wide: Schedule<Millis> = scheduleFromStep(
  (): Int => 0,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Int> => ({ kind: "Done", output: state })
)
`;

Deno.test("a Schedule annotated wider than its decision output validates and passes strict tsc", async () => {
  const project = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": widened }),
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
  const dir = Deno.makeTempDirSync({ prefix: "effective-schedule-output-" });
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
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Schedule } from "effect";
import { wide } from "./main.ts";
const widest: Schedule.Schedule<number, unknown> = wide;
void widest;
`,
    );
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
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

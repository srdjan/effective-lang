import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

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
  await runStrictTarget(
    emitProject(lowered, { config: project.value.analysis.project.config }),
    `import { Schedule } from "effect";
import { wide } from "./main.ts";
const widest: Schedule.Schedule<number, unknown> = wide;
void widest;
`,
    "effective-schedule-output-",
  );
});

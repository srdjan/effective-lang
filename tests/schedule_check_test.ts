// Tests for the scheduleFromStep output rule: the checker derives the output
// from the decision callback, and the independent validator agrees with it.

import { assert, assertEquals } from "@std/assert";
import { lowerProject, validateProject } from "../src/core/mod.ts";
import { checkModule } from "./helpers.ts";

const checked = (source: string) => checkModule(source, "main.eff");

function codes(source: string): string[] {
  return checked(source).diagnostics.map((d) => d.code);
}

function validatorMessages(source: string): string[] {
  const project = checked(source);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  const messages: string[] = [];
  for (
    const [path, diagnostics] of validateProject(
      project.analysis.project,
      lowered,
    )
  ) {
    for (const d of diagnostics) messages.push(`${path}: ${d.message}`);
  }
  return messages;
}

const widened = `type Int = int
type Text = string
export const wide: Schedule<Int | Text> = scheduleFromStep(
  (): Int => 0,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Int> => ({ kind: "Done", output: state })
)
`;

Deno.test("scheduleFromStep derives its output and accepts a wider annotation", () => {
  assertEquals(codes(widened), []);
  assertEquals(validatorMessages(widened), []);
});

Deno.test("scheduleFromStep infers its output without an annotation", () => {
  const inferred = widened.replace(
    "export const wide: Schedule<Int | Text>",
    "const wide",
  );
  assertEquals(codes(inferred), []);
  assertEquals(validatorMessages(inferred), []);
});

Deno.test("scheduleFromStep rejects a decision output that the annotation cannot hold", () => {
  const mismatched = `type Int = int
type Millis = number
type Text = string
export const bad: Schedule<Millis> = scheduleFromStep(
  (): Int => 0,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Text> => ({ kind: "Done", output: "x" })
)
`;
  assertEquals(codes(mismatched), ["type-mismatch/003"]);
});

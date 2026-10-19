import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const base = new URL(
  "../fixtures/applications/scheduled-worker/",
  import.meta.url,
);
const files = Object.fromEntries(
  ["effective.json", "contracts.eff", "worker.eff"].map((
    name,
  ) => [name, Deno.readTextFileSync(new URL(name, base))]),
);
function checked(source = files["worker.eff"]) {
  const result = checkProject(
    memoryHost({ ...files, "worker.eff": source }),
    "",
    ["worker.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("scheduled worker composes retry, repetition and resource lifetimes in source", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
});

Deno.test("scheduled worker contracts reject lost channels and preserve the general Schedule boundary", () => {
  for (
    const source of [
      files["worker.eff"].replace(
        "fails SchemaError | InvalidPolicy | JobFailure",
        "fails SchemaError | InvalidPolicy",
      ),
      files["worker.eff"].replace(
        "uses Jobs.open | Jobs.execute | Jobs.close | Clock.wait => {",
        "uses Jobs.open | Jobs.execute | Jobs.close => {",
      ),
      files["worker.eff"].replace(
        "(input: unknown): Report",
        "(input: unknown): Int",
      ),
    ]
  ) assert(checked(source).diagnostics.length > 0, source);
  const probe = checked(
    files["worker.eff"] + `
const opaque: Schedule<Int, JobFailure> = scheduleRecurs(2)
const unsupported = (): Int fails JobFailure uses Jobs.open | Jobs.execute | Jobs.close =>
  retry(() => attempt(), { schedule: opaque })`,
  );
  assert(
    probe.diagnostics.some((d) => d.message.includes("RetrySchedule")),
    JSON.stringify(probe.diagnostics),
  );
});

Deno.test("scheduled worker does not claim an opaque Schedule repetition consumer", () => {
  const project = checked(
    files["worker.eff"] + `
const opaque: Schedule<Int> = scheduleRecurs(2)
const unsupported = () => repeat(() => attempt(), opaque)`,
  );
  assert(
    project.diagnostics.some((d) =>
      d.code === "unknown-name/001" && d.message.includes("repeat")
    ),
  );
});

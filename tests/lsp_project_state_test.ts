import { assert, assertEquals } from "@std/assert";
import { revisionDelta } from "../src/core/mod.ts";
import { ProjectState } from "../src/lsp/projects.ts";

Deno.test("project state keeps revisions and deltas paired through initial errors and recovery", () => {
  const project = new ProjectState("");
  assertEquals([
    project.started,
    project.lastGood,
    project.lastDelta,
    project.configError,
  ], [false, undefined, undefined, undefined]);
  const firstError = project.program.update({ set: { "effektive.json": "{" } });
  assert(!firstError.ok);
  project.recordUpdate(firstError);
  assert(project.started);
  assertEquals(project.configError, firstError.error);
  assertEquals(project.lastGood, undefined);
  assertEquals(project.lastDelta, undefined);
  const first = project.program.update({
    set: {
      "effektive.json": "{}",
      "m.eff": "type I = int\nexport const x: I = 1\n",
    },
  });
  assert(first.ok);
  project.recordUpdate(first);
  assertEquals(project.lastGood, first.value);
  assertEquals(project.lastDelta, revisionDelta(undefined, first.value));
  assertEquals(project.configError, undefined);
  const previousDelta = project.lastDelta;
  const failed = project.program.update({ set: { "effektive.json": "{" } });
  assert(!failed.ok);
  project.recordUpdate(failed);
  assert(project.lastGood === first.value);
  assert(project.lastDelta === previousDelta);
  assertEquals(project.configError, failed.error);
  const recovered = project.program.update({
    set: {
      "effektive.json": "{}",
      "m.eff": "type I = int\nexport const x: I = 2\n",
    },
  });
  assert(recovered.ok);
  project.recordUpdate(recovered);
  assert(project.lastGood === recovered.value);
  assertEquals(project.lastDelta, revisionDelta(first.value, recovered.value));
  assertEquals(project.configError, undefined);
});

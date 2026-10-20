import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

const SOURCE = `type Int = int
export const firstTwo = (s: Stream<Int>): Int[] => runStream(s, takeSink(2))
`;

Deno.test("runStream with an inline takeSink compiles and takes the first two elements", async () => {
  const project = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": SOURCE }),
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
  const output = await runStrictTarget(
    emitProject(lowered, { config: project.value.analysis.project.config }),
    `import { Effect, Stream } from "effect";
import { firstTwo } from "./main.ts";
const taken = await Effect.runPromise(firstTwo(Stream.fromIterable([1, 2, 3, 4, 5])));
console.log(JSON.stringify(taken));
`,
    "effective-run-stream-sink-",
  );
  assertEquals(JSON.parse(output.trim().split("\n").pop() ?? ""), [1, 2]);
});

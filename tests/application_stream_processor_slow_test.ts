import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const base = new URL(
  "../fixtures/applications/stream-processor/",
  import.meta.url,
);
const files = Object.fromEntries(
  ["effective.json", "contracts.eff", "processor.eff"].map((
    name,
  ) => [name, Deno.readTextFileSync(new URL(name, base))]),
);

Deno.test("stream processor application passes strict emitted and lifecycle gates", async () => {
  const project = checkProject(
    memoryHost(files),
    "",
    ["processor.eff"],
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
  const dir = Deno.makeTempDirSync({
    prefix: "effective-application-stream-",
  });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      Deno.readTextFileSync(new URL("deno.json", base)),
    );
    for (
      const result of emitProject(lowered, {
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    for (
      const name of ["driver.ts", "runtime_test.ts", "main.ts"]
    ) {
      Deno.writeTextFileSync(
        `${dir}/${name}`,
        Deno.readTextFileSync(new URL(name, base)),
      );
    }
    for (
      const args of [["check", "--no-lock", "main.ts", "runtime_test.ts"], [
        "test",
        "--no-lock",
        "runtime_test.ts",
      ], ["run", "--no-lock", "main.ts"]]
    ) {
      const result = await new Deno.Command(Deno.execPath(), {
        args,
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
      if (args[0] === "run") {
        const report = JSON.parse(new TextDecoder().decode(result.stdout));
        assertEquals(
          report.batches.map((batch: { id: number }[]) =>
            batch.map((item) => item.id)
          ),
          [[1, 2], [3, 4], [5]],
        );
        assertEquals(report.active, 0);
      }
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

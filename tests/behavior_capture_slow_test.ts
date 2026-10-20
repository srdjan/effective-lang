// Slow test of the behavior capture: a subprocess that has no environment
// permission still writes records when the hooks are in its sources.

import { assert, assertEquals } from "@std/assert";
import { countKinds, writeInstrumentedTree } from "./behavior_capture_tree.ts";

Deno.test("a CLI build subprocess without environment permission writes records", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-capture-slow-" });
  try {
    const records = `${dir}/capture.records`;
    writeInstrumentedTree(dir, records);
    const project = `${dir}/project`;
    Deno.mkdirSync(project);
    Deno.writeTextFileSync(`${project}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${project}/m.eff`,
      "export const f = (): Int => 1\ntype Int = int\n",
    );
    // The task `effective` of the copied deno.json has no --allow-env.
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["task", "effective", "build", project, "--validate"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    const kinds = countKinds(Deno.readTextFileSync(records));
    for (const kind of ["program", "lower", "emit", "validate"]) {
      assert((kinds.get(kind) ?? 0) > 0, `no ${kind} record: ${stderr}`);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

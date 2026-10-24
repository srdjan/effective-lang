// Slow test of the directory walk with real symbolic links. The test works in a
// temporary directory that the helper removes.

import { assert, assertEquals } from "@std/assert";
import { withTemporaryDirectory } from "./process_helpers.ts";

const REPOSITORY = new URL("../", import.meta.url).pathname;

Deno.test("check ends on real symlink cycles and reads each module once", async () => {
  await withTemporaryDirectory("effektive-links-", async (dir) => {
    Deno.mkdirSync(`${dir}/project/sub`, { recursive: true });
    Deno.mkdirSync(`${dir}/sibling`);
    Deno.writeTextFileSync(`${dir}/project/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/project/a.eff`,
      "type I = int\nexport const a: I = 1\n",
    );
    Deno.writeTextFileSync(
      `${dir}/project/sub/b.eff`,
      "type I = int\nexport const b: I = 2\n",
    );
    Deno.writeTextFileSync(
      `${dir}/sibling/c.eff`,
      "type I = int\nexport const c: I = 3\n",
    );
    // An upward link, a link to a sibling of the root, and a cycle of two links.
    Deno.symlinkSync("..", `${dir}/project/sub/up`);
    Deno.symlinkSync("../../sibling", `${dir}/project/sub/side`);
    Deno.symlinkSync("y", `${dir}/project/x`);
    Deno.symlinkSync("x", `${dir}/project/y`);
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["task", "effektive", "check", `${dir}/project`],
      cwd: REPOSITORY,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assert(stderr.includes("2 modules, 0 diagnostics"), stderr);
  });
});

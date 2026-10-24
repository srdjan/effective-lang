// Runs the tutorial commands on a copy of `fixtures/tutorial/`: build with
// validation and target checking, type-check the entry point, and run it.

import { assertEquals } from "@std/assert";
import { copyDirectory, FIXTURES } from "./helpers.ts";
import { withTemporaryDirectory } from "./process_helpers.ts";

async function run(args: string[], cwd: string | URL): Promise<string> {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  const stdout = decoder.decode(result.stdout);
  assertEquals(result.code, 0, decoder.decode(result.stderr) + stdout);
  return stdout;
}

Deno.test("the tutorial project builds, type-checks, and prints the shown output", async () => {
  await withTemporaryDirectory("effektive-tutorial-", async (dir) => {
    copyDirectory(new URL("tutorial/", FIXTURES), dir);
    await run(
      ["task", "effektive", "build", dir, "--validate", "--tsc"],
      new URL("../", import.meta.url),
    );
    await run(["check", "--no-lock", "main.ts"], dir);
    const output = await run(["run", "--no-lock", "main.ts"], dir);
    const tutorial = Deno.readTextFileSync(
      new URL("../docs/tutorial.md", import.meta.url),
    );
    assertEquals(
      output.trim(),
      '{"dune":1,"emma":"no copies of b2","lines":["lent Dune","closed"]}',
    );
    assertEquals(tutorial.includes(`\`\`\`text\n${output}\`\`\``), true);
  });
});

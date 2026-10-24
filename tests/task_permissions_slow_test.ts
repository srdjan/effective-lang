// Regression for tasks that restrict subprocess access to PATH's `deno`.
import { assert, assertEquals } from "@std/assert";
import { withTemporaryDirectory } from "./process_helpers.ts";

const repository = new URL("../", import.meta.url).pathname;

Deno.test("actual build task checks targets through canonical and symlinked Deno", async () => {
  await withTemporaryDirectory("effective-path-", async (dir) => {
    Deno.mkdirSync(`${dir}/bin`);
    Deno.symlinkSync(Deno.realPathSync(Deno.execPath()), `${dir}/bin/deno`);
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      "export const answer = (): Int => 42\ntype Int = int\n",
    );
    for (
      const executable of [
        Deno.realPathSync(Deno.execPath()),
        `${dir}/bin/deno`,
      ]
    ) {
      const run = await new Deno.Command(executable, {
        args: ["task", "effective", "build", dir, "--tsc"],
        cwd: repository,
        env: {
          PATH: `${dir}/bin:${Deno.env.get("PATH") ?? ""}`,
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
    }
  });
});

Deno.test("target check reports missing PATH executable usefully", async () => {
  await withTemporaryDirectory("effective-missing-deno-", async (dir) => {
    Deno.writeTextFileSync(`${dir}/effektive.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      "export const answer = (): Int => 42\ntype Int = int\n",
    );
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=deno",
        `${repository}src/cli/main.ts`,
        "build",
        dir,
        "--tsc",
      ],
      env: { PATH: dir, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 1);
    const stderr = new TextDecoder().decode(run.stderr);
    assert(stderr.includes("cannot run deno check"), stderr);
    assert(/deno|[Nn]ot[Ff]ound|[Nn]o such file/.test(stderr), stderr);
  });
});

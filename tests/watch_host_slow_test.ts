import { assert, assertEquals } from "@std/assert";
import { copyDirectory, FIXTURES } from "./helpers.ts";
import { withTemporaryDirectory } from "./process_helpers.ts";

Deno.test("real watch --tsc reports and clears a local dependency error without editing Effective source", async () => {
  await withTemporaryDirectory("effective-watch-host-", async (dir) => {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    const host = `${dir}/users-live.ts`;
    Deno.writeTextFileSync(
      host,
      'import "./helper.ts";\n' + Deno.readTextFileSync(host),
    );
    Deno.writeTextFileSync(`${dir}/helper.ts`, "export const value = 1;\n");
    const child = new Deno.Command("deno", {
      args: ["task", "effective", "watch", dir, "--tsc"],
      cwd: new URL("../", import.meta.url),
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) log += new TextDecoder().decode(chunk);
    };
    const reading = Promise.all([consume(child.stdout), consume(child.stderr)]);
    const until = async (needle: string, start = 0) => {
      for (let i = 0; i < 600; i++) {
        const at = log.indexOf(needle, start);
        if (at >= 0) return at + needle.length;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Missing ${needle}:\n${log}`);
    };
    try {
      const initial = await until("watching ");
      const generated = Deno.readTextFileSync(`${dir}/main.ts`);
      Deno.writeTextFileSync(
        `${dir}/helper.ts`,
        "export const value: string = 1;\n",
      );
      const broken = await until("TS2322", initial);
      Deno.writeTextFileSync(
        `${dir}/helper.ts`,
        'export const value: string = "fixed";\n',
      );
      await until("5 modules, 0 diagnostics", broken);
      assert(
        log.slice(initial).includes("host inputs changed; rechecked: (none)"),
        log,
      );
      assert(!log.slice(initial).includes("rechecked: users"), log);
      assertEquals(Deno.readTextFileSync(`${dir}/main.ts`), generated);
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await reading;
    }
  });
});

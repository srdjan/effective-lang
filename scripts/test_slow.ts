// Runs the slow tests with a fresh DENO_DIR, and removes that DENO_DIR after.
// The slow tests run `deno` in random temporary directories. Deno keeps one
// cache entry for each such path, so a shared DENO_DIR grows on each run.
// Run it with `deno task test:slow`. Extra arguments go to `deno test`.

const denoDir = Deno.makeTempDirSync({ prefix: "effective-slow-deno-dir-" });
let code = 1;
try {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-all",
      "--permit-no-files",
      "tests/**/*_slow_test.ts",
      ...Deno.args,
    ],
    env: { DENO_DIR: denoDir },
  }).spawn();
  code = (await child.status).code;
} finally {
  Deno.removeSync(denoDir, { recursive: true });
}
Deno.exit(code);

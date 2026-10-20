// Shared helpers for the slow tests that start a `deno` subprocess. A fast test
// must not import this file.

import { assertEquals } from "@std/assert";

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `deno` with `args` in `cwd`, with colors off, and collects its output. */
export async function deno(cwd: string, args: readonly string[]): Promise<Run> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Runs `body` in a fresh temporary directory named with `prefix`, and removes the directory after. */
export async function withTemporaryDirectory<T>(
  prefix: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix });
  try {
    return await body(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/**
 * Writes `script` as `run.ts` in `dir`, runs it with `deno run --check` under
 * the `deno.json` of `dir`, and parses its last line of output as JSON.
 */
export async function runScript(dir: string, script: string): Promise<unknown> {
  Deno.writeTextFileSync(`${dir}/run.ts`, script);
  const run = await deno(dir, [
    "run",
    "--config",
    "deno.json",
    "--check",
    "--no-prompt",
    "run.ts",
  ]);
  assertEquals(run.code, 0, `deno run failed:\n${run.stderr}`);
  const last = run.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(last);
}

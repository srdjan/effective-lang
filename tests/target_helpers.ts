// Runs emitted TypeScript against the strict target configuration.

import { assert, assertEquals } from "@std/assert";
import type {
  EmitProjectError,
  EmittedModule,
  Result,
} from "../src/core/mod.ts";

/**
 * Writes the emitted modules and `run` as `run.ts` into a temporary directory
 * with the strict target configuration, then runs `deno check` and `deno run`
 * on `run.ts`. Both commands must exit with code 0. Returns the standard
 * output of the last command. Callers parse it. The directory is removed on
 * return and on failure.
 */
export async function runStrictTarget(
  emitted: ReadonlyMap<string, Result<EmittedModule, EmitProjectError>>,
  run: string,
  prefix: string,
): Promise<string> {
  const dir = Deno.makeTempDirSync({ prefix });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      }),
    );
    for (const result of emitted.values()) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(`${dir}/run.ts`, run);
    const decoder = new TextDecoder();
    let stdout = "";
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        decoder.decode(result.stderr) + decoder.decode(result.stdout),
      );
      stdout = decoder.decode(result.stdout);
    }
    return stdout;
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

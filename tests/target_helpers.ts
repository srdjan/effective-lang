// Runs emitted TypeScript against the strict target configuration.

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  type EmitProjectError,
  type EmittedModule,
  lowerProject,
  memoryHost,
  type Result,
  validateProject,
} from "../src/core/mod.ts";

/**
 * Checks the source project `files` with the entries `entries`, lowers it,
 * and validates it, then runs `runStrictTarget` on the result. The project must
 * have no diagnostic. Returns the standard output of the run.
 */
export function compileStrictTarget(
  files: Readonly<Record<string, string>>,
  entries: readonly string[],
  run: string,
  prefix: string,
): Promise<string> {
  const project = checkProject(
    memoryHost({ "effective.json": "{}", ...files }),
    "",
    entries,
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
  return runStrictTarget(
    emitProject(lowered, { config: project.value.analysis.project.config }),
    run,
    prefix,
  );
}

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

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { deno, withTemporaryDirectory } from "./process_helpers.ts";

Deno.test("portable publisher passes one KV contract on memory and file-backed SQLite", async () => {
  const base = new URL(
    "../fixtures/applications/portable-publisher/",
    import.meta.url,
  );
  const files = Object.fromEntries(
    [...Deno.readDirSync(base)]
      .filter((file) =>
        file.name.endsWith(".eff") || file.name === "effektive.json"
      )
      .map((
        file,
      ) => [file.name, Deno.readTextFileSync(new URL(file.name, base))]),
  );
  const project = checkProject(memoryHost(files), "", ["publisher.eff"]);
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const module of lowered.values()) {
    assert(module.ok, JSON.stringify(module));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);

  await withTemporaryDirectory("effective-publisher-sqlite-", async (dir) => {
    for (
      const name of [
        "deno.json",
        "backend.ts",
        "memory.ts",
        "codecs.ts",
        "runner.ts",
        "sqlite.ts",
        "kv_contract.ts",
        "sqlite_runtime_test.ts",
      ]
    ) {
      Deno.writeTextFileSync(
        `${dir}/${name}`,
        Deno.readTextFileSync(new URL(name, base)),
      );
    }
    for (
      const module of emitProject(lowered, {
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(module.ok, JSON.stringify(module));
      Deno.writeTextFileSync(`${dir}/${module.value.path}`, module.value.text);
    }
    for (
      const args of [
        ["check", "--no-lock", "sqlite_runtime_test.ts"],
        [
          "test",
          "--no-lock",
          "--no-prompt",
          `--allow-read=${Deno.realPathSync(dir)}`,
          `--allow-write=${Deno.realPathSync(dir)}`,
          "sqlite_runtime_test.ts",
        ],
      ]
    ) {
      const result = await deno(dir, args);
      assertEquals(result.code, 0, `${result.stderr}\n${result.stdout}`);
    }
  });
});

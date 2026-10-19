import { assert, assertEquals } from "@std/assert";
import { HOOK_PATHS, instrumentSources } from "../scripts/behavior_capture.ts";

const ROOT = new URL("..", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, ROOT));

Deno.test("behavior capture finds every hook anchor in the current sources", () => {
  const result = instrumentSources(read);
  assert(result.ok, result.ok ? "" : result.error.join("\n"));
  for (const path of HOOK_PATHS) assert(result.value.has(path), path);
  for (
    const path of [
      "src/core/emit/emit.ts",
      "src/core/check_project.ts",
      "src/core/validate/index.ts",
    ]
  ) {
    const text = result.value.get(path);
    assert(text !== undefined && text.includes("capture("), path);
  }
});

Deno.test("behavior capture names each entry point whose anchor is gone", () => {
  const result = instrumentSources((path) =>
    path === "src/core/check_project.ts" ? "" : read(path)
  );
  assert(!result.ok);
  assertEquals(result.error.length, 1);
  assert(result.error[0].startsWith("src/core/check_project.ts: "));
});

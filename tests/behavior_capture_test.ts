import { assert, assertEquals } from "@std/assert";
import { HOOK_PATHS, instrumentSources } from "../scripts/behavior_capture.ts";

const ROOT = new URL("..", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, ROOT));

const HOOKED_FILES = [
  "src/core/emit/emit.ts",
  "src/core/check_project.ts",
  "src/core/lower.ts",
  "src/core/db.ts",
  "src/core/validate/index.ts",
];

Deno.test("behavior capture finds every hook anchor in the current sources", () => {
  const result = instrumentSources(read, "/records");
  assert(result.ok, result.ok ? "" : result.error.join("\n"));
  for (const path of HOOK_PATHS) assert(result.value.has(path), path);
  for (const path of HOOKED_FILES) {
    const text = result.value.get(path);
    assert(text !== undefined && text.includes("capture("), path);
  }
});

Deno.test("behavior capture names each entry point whose anchor is gone", () => {
  const result = instrumentSources(
    (path) => path === "src/core/check_project.ts" ? "" : read(path),
    "/records",
  );
  assert(!result.ok);
  assertEquals(result.error.length, 1);
  assert(result.error[0].startsWith("src/core/check_project.ts: "));
});

Deno.test("behavior capture writes the records path into the hook as a literal", () => {
  const result = instrumentSources(read, '/tmp/a "b"/records');
  assert(result.ok);
  for (const path of HOOK_PATHS) {
    const text = result.value.get(path);
    assert(text !== undefined, path);
    assert(text.includes('"/tmp/a \\"b\\"/records"'), text);
    assert(!text.includes("Deno.env"), text);
  }
});

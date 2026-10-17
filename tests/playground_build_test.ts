// The output directory guard of the playground build. The build removes its
// output directory first, so the guard must refuse every repository directory
// except playground/dist.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { isUnsafe } from "../playground/build.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("the build refuses to remove a repository directory", () => {
  for (const dir of ["", "..", "playground", "src", "src/core", "docs"]) {
    assertEquals(isUnsafe(join(ROOT, dir)), true, dir);
  }
});

Deno.test("the build may remove playground/dist and a directory outside the repository", () => {
  assertEquals(isUnsafe(join(ROOT, "playground", "dist")), false);
  assertEquals(isUnsafe(join(ROOT, "playground", "dist", "nested")), false);
  assertEquals(isUnsafe(join(ROOT, "..", "elsewhere-out")), false);
  assertEquals(isUnsafe("/tmp/playground-out"), false);
});

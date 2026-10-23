// The builtin families of the emitter use `families/context.ts` and never
// import `expr.ts`. An import of `expr.ts` makes an import cycle.

import { assert } from "@std/assert";

Deno.test("src/core/emit/families imports only ir.ts, ids.ts, and emit files other than expr.ts", () => {
  const directory = new URL("../src/core/emit/families/", import.meta.url);
  const emit = new URL("../src/core/emit/", import.meta.url);
  const files: URL[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    assert(entry.isFile, `unexpected entry ${entry.name}`);
    files.push(new URL(entry.name, directory));
  }
  const expr = new URL("expr.ts", emit).href;
  const allowed = new Set(
    ["ir.ts", "ids.ts"].map((name) => new URL(`../${name}`, emit).href),
  );
  const pattern =
    /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let checked = 0;
  for (const file of files) {
    const text = Deno.readTextFileSync(file);
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      assert(
        specifier.startsWith("."),
        `${file.pathname} imports ${specifier}`,
      );
      const target = new URL(specifier, file).href;
      const inEmit = target.startsWith(emit.href) && target !== expr;
      assert(
        inEmit || allowed.has(target),
        `${file.pathname} imports ${specifier}`,
      );
      checked++;
    }
  }
  assert(files.length >= 1, "no family file found");
  assert(checked >= 1, "no import found");
});

// Fast tests of which modules `build` writes. A module whose import is not
// written is not written either. The tests run `main` with the in-memory doubles.

import { assertEquals } from "@std/assert";
import { main } from "../src/cli/main.ts";
import { memoryIo } from "./cli_helpers.ts";

const ROOT = "/proj";

async function build(files: Readonly<Record<string, string>>) {
  const m = memoryIo(
    Object.fromEntries(
      Object.entries({ "effektive.json": "{}", ...files }).map((
        [path, text],
      ) => [`${ROOT}/${path}`, text]),
    ),
  );
  const code = await main(["build", ROOT], m.io);
  const outputs = [...m.files.keys()]
    .map((path) => path.slice(ROOT.length + 1))
    .filter((path) => path.endsWith(".ts") || path.endsWith(".ts.map"))
    .sort();
  return { code, outputs, stdout: m.out.join("") };
}

Deno.test("build writes no module that imports a module with an error", async () => {
  const r = await build({
    "a.eff": 'import { b, I } from "./b.eff"\nexport const a = (): I => b()\n',
    "b.eff": 'export type I = int\nexport const b = (): I => "text"\n',
    "ok.eff": "type I = int\nexport const ok = (): I => 1\n",
  });
  assertEquals(r.code, 1);
  assertEquals(r.outputs, ["ok.ts", "ok.ts.map"]);
  assertEquals(r.stdout.split("\n").filter((l) => l !== "").length, 1);
});

Deno.test("build writes no module that imports an unwritten module through a chain", async () => {
  const r = await build({
    "a.eff":
      'import { m } from "./m.eff"\ntype I = int\nexport const a = (): I => m()\n',
    "m.eff":
      'import { b } from "./b.eff"\ntype I = int\nexport const m = (): I => b()\n',
    "b.eff": 'type I = int\nexport const b = (): I => "text"\n',
  });
  assertEquals(r.code, 1);
  assertEquals(r.outputs, []);
});

Deno.test("build writes no module of an import cycle when one module has an error", async () => {
  const r = await build({
    "c.eff":
      'import { d } from "./d.eff"\nexport type I = int\nexport const c = (): I => 1\n',
    "d.eff": 'import { c, I } from "./c.eff"\nexport const d = (): I => c()\n',
  });
  assertEquals(r.code, 1);
  assertEquals(r.outputs, []);
  assertEquals(r.stdout.split("\n").filter((l) => l !== "").length, 1);
});

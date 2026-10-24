// Slow test of the playground build. It runs `build` into a temporary
// directory, which starts `deno bundle` as a subprocess.

import { assert, assertEquals } from "@std/assert";
import { build } from "../playground/build.ts";

const OUTPUTS: readonly string[] = [
  "index.html",
  "app.js",
  "app.css",
  "examples.json",
  "fonts/bricolage-grotesque-latin.woff2",
  "fonts/OFL.txt",
];

const EXAMPLE_PATHS: readonly string[] = [
  "collections.eff",
  "effektive.json",
  "host/providers.effi",
  "log.eff",
  "main.eff",
  "pay.eff",
  "users.eff",
];

Deno.test("build writes the page files and the examples", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "effective-playground-" });
  try {
    const out = `${dir}/dist`;
    const result = await build(out);
    assert(result.ok, result.ok ? "" : JSON.stringify(result.error));
    for (const name of OUTPUTS) {
      assert(Deno.statSync(`${out}/${name}`).isFile, `${name} is missing`);
    }
    const examples: unknown = JSON.parse(
      Deno.readTextFileSync(`${out}/examples.json`),
    );
    assert(typeof examples === "object" && examples !== null);
    assertEquals(Object.keys(examples).sort(), [...EXAMPLE_PATHS]);
    const app = Deno.readFileSync(`${out}/app.js`);
    assert(app.byteLength > 0);
    assertEquals(result.value.appBytes, app.byteLength);
    assert(result.value.appGzipBytes > 0);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

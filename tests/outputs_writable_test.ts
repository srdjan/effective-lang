// Fast tests of `writableModules`: which modules a build writes. They use
// `Program` over in-memory files.

import { assertEquals } from "@std/assert";
import { Program } from "../src/core/mod.ts";
import { writableModules } from "../src/host/outputs.ts";

function writable(files: Readonly<Record<string, string>>): string[] {
  const revision = new Program().update({
    set: { "effektive.json": "{}", ...files },
  });
  if (!revision.ok) throw new Error(JSON.stringify(revision));
  return writableModules(revision.value);
}

Deno.test("writableModules writes no member of an import cycle with an error", () => {
  assertEquals(
    writable({
      "c.eff":
        'import { d } from "./d.eff"\ntype I = int\nexport const c = (): I => "text"\n',
      "d.eff":
        'import { c } from "./c.eff"\ntype I = int\nexport const d = (): I => c()\n',
    }),
    [],
  );
});

Deno.test("writableModules writes the companion of a host interface target", () => {
  const read = (path: string) =>
    Deno.readTextFileSync(
      new URL(`../fixtures/examples/${path}`, import.meta.url),
    );
  const revision = new Program().update({
    set: {
      "effektive.json": read("effektive.json"),
      "users.eff": read("users.eff"),
      "host/providers.effi": read("host/providers.effi"),
      "main.eff": read("main.eff"),
    },
  });
  if (!revision.ok) throw new Error(JSON.stringify(revision));
  assertEquals(revision.value.diagnostics.map((d) => d.code), []);
  assertEquals(writableModules(revision.value).sort(), [
    "host/providers",
    "main",
    "users",
  ]);
});

Deno.test("writableModules writes every module of a clean chain", () => {
  assertEquals(
    writable({
      "a.eff":
        'import { b } from "./b.eff"\nimport { I } from "./c.eff"\nexport const a = (): I => b()\n',
      "b.eff":
        'import { c, I } from "./c.eff"\nexport const b = (): I => c()\n',
      "c.eff": "export type I = int\nexport const c = (): I => 1\n",
    }).sort(),
    ["a", "b", "c"],
  );
});

Deno.test("writableModules writes no module whose imported host interface has an error", () => {
  const read = (path: string) =>
    Deno.readTextFileSync(
      new URL(`../fixtures/examples/${path}`, import.meta.url),
    );
  const revision = new Program().update({
    set: {
      "effektive.json": read("effektive.json"),
      "users.eff": read("users.eff"),
      "host/providers.effi": `${
        read("host/providers.effi")
      }type Bad = Missing\n`,
      "main.eff": read("main.eff"),
    },
  });
  if (!revision.ok) throw new Error(JSON.stringify(revision));
  assertEquals(
    revision.value.diagnostics.map((d) => d.span.source),
    ["host/providers.effi"],
  );
  // The broken companion stays in the list, and `writeGenerated` skips it. Main is out.
  assertEquals(writableModules(revision.value).sort(), [
    "host/providers",
    "users",
  ]);
});

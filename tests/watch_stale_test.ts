// Fast tests of the outputs that `watch` removes when a module leaves the
// project. The tests run `main` with the in-memory doubles.

import { assert, assertEquals } from "@std/assert";
import { main } from "../src/cli/main.ts";
import { memoryIo } from "./cli_helpers.ts";

const ROOT = "/proj";

const module = (name: string): string =>
  `type I = int\nexport const ${name}: I = 1\n`;

function project(): ReturnType<typeof memoryIo> {
  return memoryIo({
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/a.eff`]: module("a"),
    [`${ROOT}/pay.eff`]: module("pay"),
    [`${ROOT}/old.eff`]: module("old"),
  });
}

function outputs(m: ReturnType<typeof memoryIo>): string[] {
  return [...m.files.keys()]
    .map((path) => path.slice(ROOT.length + 1))
    .filter((path) => path.includes(".ts"))
    .sort();
}

Deno.test("watch removes the outputs of a renamed module", async () => {
  const m = project();
  m.script = [() => {
    m.files.delete(`${ROOT}/pay.eff`);
    m.files.set(`${ROOT}/billing.eff`, module("billing"));
  }];
  assertEquals(await main(["watch", ROOT], m.io), 0);
  assertEquals(outputs(m), [
    "a.ts",
    "a.ts.map",
    "billing.ts",
    "billing.ts.map",
    "old.ts",
    "old.ts.map",
  ]);
  const err = m.err.join("");
  assert(err.includes("removed: pay.ts\n"), err);
  assert(err.includes("removed: pay.ts.map\n"), err);
});

Deno.test("watch keeps a .ts file that lacks the generated header", async () => {
  const m = project();
  m.script = [
    () => {
      m.files.set(`${ROOT}/old.ts`, "export const old = 2;\n");
    },
    () => {
      m.files.delete(`${ROOT}/old.eff`);
      m.files.delete(`${ROOT}/pay.eff`);
    },
  ];
  assertEquals(await main(["watch", ROOT], m.io), 0);
  // The hand-written file and its map stay; the generated pair of pay goes.
  assertEquals(outputs(m), ["a.ts", "a.ts.map", "old.ts", "old.ts.map"]);
  assertEquals(m.files.get(`${ROOT}/old.ts`), "export const old = 2;\n");
  assert(!m.err.join("").includes("removed: old"), m.err.join(""));
});

Deno.test("watch removes outputs after a round with a configuration error", async () => {
  const m = project();
  m.script = [
    () => {
      m.files.set(`${ROOT}/effective.json`, "{");
    },
    () => {
      m.files.delete(`${ROOT}/pay.eff`);
    },
    () => {
      m.files.set(`${ROOT}/effective.json`, "{}");
    },
  ];
  assertEquals(await main(["watch", ROOT], m.io), 0);
  assertEquals(outputs(m), ["a.ts", "a.ts.map", "old.ts", "old.ts.map"]);
  const err = m.err.join("");
  assert(err.includes("error: effective.json is not valid JSON"), err);
  assert(err.includes("removed: pay.ts\n"), err);
});

Deno.test("build removes no file", async () => {
  const m = project();
  assertEquals(await main(["build", ROOT], m.io), 0);
  m.files.delete(`${ROOT}/pay.eff`);
  assertEquals(await main(["build", ROOT], m.io), 0);
  assert(m.files.has(`${ROOT}/pay.ts`));
  assert(m.files.has(`${ROOT}/pay.ts.map`));
});

// Pins the current behavior, kept by Decision 3a: the watch loop forgets a module after a failed removal.
Deno.test("watch forgets a module whose output removal failed", async () => {
  const m = project();
  m.script = [
    () => {
      m.files.delete(`${ROOT}/old.eff`);
      m.unwritable.add(`${ROOT}/old.ts.map`);
    },
    () => {
      m.unwritable.clear();
      m.files.set(`${ROOT}/a.eff`, module("a") + "\n");
    },
  ];
  assertEquals(await main(["watch", ROOT], m.io), 0);
  const err = m.err.join("");
  assert(err.includes("error: cannot remove old.ts.map"), err);
  // The next round does not try again: the generated pair of old stays.
  assertEquals(outputs(m), [
    "a.ts",
    "a.ts.map",
    "old.ts",
    "old.ts.map",
    "pay.ts",
    "pay.ts.map",
  ]);
  assert(!err.includes("removed: old"), err);
});

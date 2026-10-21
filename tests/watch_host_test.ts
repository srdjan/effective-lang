import { assert, assertEquals } from "@std/assert";
import { main } from "../src/cli/main.ts";
import { memoryIo } from "./cli_helpers.ts";

const source = "type Int = int\nexport const answer = (): Int => 42\n";

Deno.test("watch target checks local hosts on edits, additions, removals and polling without source rechecks", async () => {
  const m = memoryIo({
    "p/effective.json": "{}",
    "p/m.eff": source,
    "p/helper.ts": "export const n = 1",
  });
  m.script = [
    () => {
      m.files.set("p/helper.ts", "export const n: string = 1");
      return ["helper.ts"];
    },
    () => {
      m.files.set("p/helper.ts", "export const n = 2");
    },
    () => {
      m.files.set("p/local.js", "export const value = 1");
    },
    () => {
      m.files.delete("p/local.js");
    },
    () => {
      m.files.set("p/deno.json", '{"compilerOptions":{"strict":true}}');
    },
    () => {
      m.files.set("p/config/strict.json", '{"strict":true}');
    },
    () => ["m.ts", "m.ts.map"],
    () => {
      m.files.set("p/node_modules/skip.ts", "bad");
      m.files.set("p/.cache/skip.ts", "bad");
    },
  ];
  assertEquals(await main(["watch", "p", "--tsc"], m.io), 0);
  assertEquals(m.checks.length, 7);
  assertEquals(m.err.filter((text) => text === "rechecked: m\n").length, 1);
  assertEquals(
    m.err.filter((text) => text.includes("host inputs changed")).length,
    6,
  );
});

Deno.test("watch retains configuration and source errors during host-only changes", async () => {
  const m = memoryIo({ "p/effective.json": "{}", "p/m.eff": source });
  m.script = [
    () => {
      m.files.set("p/effective.json", "{");
    },
    () => {
      m.files.set("p/helper.ts", "export const n = 1");
    },
    () => {
      m.files.set("p/effective.json", "{}");
      m.files.set("p/m.eff", source.replace("42", '"bad"'));
    },
    () => {
      m.files.set("p/helper.ts", "export const n = 2");
    },
    () => {
      m.files.set("p/m.eff", source);
    },
  ];
  assertEquals(await main(["watch", "p", "--tsc"], m.io), 0);
  assertEquals(m.checks.length, 2);
  assert(m.err.some((text) => text.includes("not valid JSON")));
  assertEquals(
    m.out.filter((text) => text.includes("type-mismatch")).length,
    2,
  );
});

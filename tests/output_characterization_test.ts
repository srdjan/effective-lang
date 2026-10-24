import { TypeScriptOutputs } from "../src/core/typescript.ts";
const outputs = new TypeScriptOutputs();
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { hoverAt, Program, sourceHoverAt } from "../src/core/mod.ts";

const source = "type Int = int\nexport const value = (): Int => 1\n";

Deno.test("output characterization: lazy queries, old revisions, failures and unrelated edits", () => {
  const program = new Program();
  const first = program.update({
    set: {
      "effektive.json": "{}",
      "main.eff": source,
      "other.eff": source,
    },
  });
  assert(first.ok);
  assertEquals(program.counts.lowerings, 0);
  assertEquals(outputs.counts.emits, 0);
  const emitted = outputs.emitted(first.value, "main");
  const table = outputs.spanTable(first.value, "main");
  const map = outputs.sourceMap(first.value, "main");
  assert(emitted?.ok && table?.ok && map?.ok);
  assertEquals(outputs.counts.emits, 1);
  const second = program.update({ set: { "other.eff": source + "\n" } });
  assert(second.ok);
  assert(outputs.emitted(second.value, "main") === emitted);
  assert(outputs.spanTable(second.value, "main") === table);
  assert(outputs.sourceMap(second.value, "main") === map);
  const broken = program.update({
    set: { "main.eff": source.replace("1", "missing") },
  });
  assert(broken.ok);
  assertNotEquals(outputs.emitted(broken.value, "main"), emitted);
  assertEquals(
    hoverAt(broken.value, "main.eff", source.indexOf("value"), outputs)
      ?.backend,
    { tag: "unavailable" },
  );
  assert(outputs.emitted(first.value, "main") === emitted);
  assert(outputs.sourceMap(first.value, "main") === map);
  assertEquals(outputs.emitted(first.value, "unknown"), undefined);
});

Deno.test("output characterization: imported spans replace lowering results", () => {
  const program = new Program();
  const files = {
    "effektive.json": "{}",
    "a.eff": "export type Int = int\n",
    "main.eff": 'import { Int } from "./a.eff"\nexport const n: Int = 1\n',
  };
  const first = program.update({ set: files });
  assert(first.ok);
  const lowered = first.value.lowered("main");
  const emitted = outputs.emitted(first.value, "main");
  const moved = program.update({ set: { "a.eff": "\n" + files["a.eff"] } });
  assert(moved.ok);
  assertEquals(moved.value.rechecked, ["a"]);
  assert(moved.value.lowered("main") !== lowered);
  assert(outputs.emitted(moved.value, "main") !== emitted);
  assertEquals(
    outputs.emitted(moved.value, "main")?.ok && emitted?.ok &&
      outputs.emitted(moved.value, "main"),
    emitted,
  );
});

Deno.test("source hover stays in the frontend and separate output caches are independent", () => {
  const program = new Program();
  const revision = program.update({
    set: { "effektive.json": "{}", "main.eff": source },
  });
  assert(revision.ok);
  const overlay = new TypeScriptOutputs();
  const disk = new TypeScriptOutputs();
  assertEquals(
    sourceHoverAt(revision.value, "main.eff", source.indexOf("value"))
      ?.declaration,
    "value:main#value",
  );
  assertEquals(program.counts.lowerings, 0);
  assertEquals(overlay.counts.emits, 0);
  const first = overlay.emitted(revision.value, "main");
  assert(first?.ok);
  assertEquals(disk.counts.emits, 0);
  assertEquals(disk.emitted(revision.value, "main"), first);
  assertEquals(disk.counts.emits, 1);
  assertEquals(overlay.counts.emits, 1);
});

Deno.test("host configuration changes replace the lowering key and keep old output queries valid", () => {
  const program = new Program();
  const outputs = new TypeScriptOutputs();
  const config = (module: string) =>
    JSON.stringify({ host: { clock: { interface: "./clock.effi", module } } });
  const first = program.update({
    set: {
      "effektive.json": config("./clock.ts"),
      "clock.effi":
        "export type Int = int\nexport service Clock { now(): Int }\nexport provider Live provides Clock\n",
      "main.eff":
        'import { Int, Clock, Live } from "host:clock"\nexport const now = (): Int => provide(Live, () => Clock.now())\n',
    },
  });
  assert(first.ok);
  const lowered = first.value.lowered("main");
  const before = outputs.emitted(first.value, "main");
  assert(before?.ok);
  const second = program.update({
    set: { "effektive.json": config("./new-clock.ts") },
  });
  assert(second.ok);
  assert(second.value.lowered("main") !== lowered);
  const after = outputs.emitted(second.value, "main");
  assert(after?.ok);
  assert(after.value.text.includes("new-clock.ts"));
  assert(outputs.emitted(first.value, "main") === before);
});

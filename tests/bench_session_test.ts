import { assert, assertEquals } from "@std/assert";
import {
  applyCompanionEdit,
  applyEdit,
  EDIT_KINDS,
  loadInput,
  parseStats,
} from "../bench/lsp_script.ts";
import { sessionDocuments } from "../bench/m4.ts";
import { m4Config } from "../bench/profile.ts";

Deno.test("long-session profile opens multiple documents and reaches 10000 edits", () => {
  const full = m4Config("full");
  assertEquals(full.openDocuments, 3);
  assertEquals(full.stepCounts.at(-1), 10000);
  const input = loadInput("medium", 1);
  const documents = sessionDocuments(input, 3);
  assertEquals(documents, [input.editPath, "m00.eff", "m01.eff"]);
  assertEquals(new Set(documents).size, 3);
});

Deno.test("all 10000 edit texts stay distinct even when semantic toggles repeat", () => {
  const input = loadInput("small", 1);
  let text = [
    "export const bump = (n: Int): Int => n + 1",
    "export const extra: Int = 1",
    "export type Amount = int",
    "export const flip = (n: Int): Int => n + 1",
    "",
  ].join("\n");
  const seen = new Set<string>();
  for (let step = 0; step < 10000; step++) {
    const kind = EDIT_KINDS[step % EDIT_KINDS.length];
    assert(kind !== undefined);
    const result = applyEdit(input, kind, text, step + 2);
    assert(result.ok, JSON.stringify(result));
    text = result.value;
    seen.add(text);
    assertEquals((text.match(/effective-bench revision/g) ?? []).length, 1);
  }
  assertEquals(seen.size, 10000);
  assert(text.length < 300);
});

Deno.test("companion revisions change the actual annotated feature body and replace their marker", () => {
  const original =
    "type Int = int\nexport const link0 = (n: Int): Int => n + 1\n";
  const first = applyCompanionEdit(original, 2);
  const second = applyCompanionEdit(first, 3);
  assert(first.includes("n + 2"));
  assert(second.includes("n + 3"));
  assertEquals((second.match(/effective-bench revision/g) ?? []).length, 1);
  assertEquals(
    applyCompanionEdit("export type Text = string\n", 7),
    "export type Text = string\n\n// effective-bench revision 7\n",
  );
});

const stats = {
  counts: { parses: 1, checks: 1, lowerings: 0, emits: 0 },
  delta: { interfaceChanged: [], modeChanged: [] },
  memory: { rss: 100, heapUsed: 50 },
  typeTableSize: 7,
};

Deno.test("stats parser retains real heap and type-table measurements and marks old metrics absent", () => {
  const parsed = parseStats(stats);
  assert(parsed.ok);
  assertEquals([
    parsed.value.rss,
    parsed.value.heapUsed,
    parsed.value.typeTableSize,
  ], [100, 50, 7]);
  const old = parseStats({
    ...stats,
    memory: { rss: 100 },
    typeTableSize: undefined,
  });
  assert(old.ok);
  assertEquals([old.value.heapUsed, old.value.typeTableSize], [null, null]);
});

Deno.test("stats parser rejects malformed supplied memory measurements instead of fabricating samples", () => {
  for (const metric of [null, "50", -1, NaN, Infinity]) {
    assert(
      !parseStats({ ...stats, memory: { ...stats.memory, heapUsed: metric } })
        .ok,
    );
    assert(!parseStats({ ...stats, typeTableSize: metric }).ok);
    assert(
      !parseStats({ ...stats, memory: { ...stats.memory, rss: metric } }).ok,
    );
  }
  assert(!parseStats({ ...stats, typeTableSize: 1.5 }).ok);
});

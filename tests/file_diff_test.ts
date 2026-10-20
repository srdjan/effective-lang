import { assertEquals } from "@std/assert";
import { diffFiles } from "../src/core/file_diff.ts";

Deno.test("diffFiles lists changed and new files in set and gone files in remove", () => {
  const known = new Map([["a.eff", "1"], ["b.eff", "2"], ["c.eff", "3"]]);
  const wanted = new Map([["c.eff", "3"], ["b.eff", "22"], ["d.eff", "4"]]);
  const diff = diffFiles(known, wanted);
  assertEquals([...diff.set], [["b.eff", "22"], ["d.eff", "4"]]);
  assertEquals(diff.remove, ["a.eff"]);
});

Deno.test("diffFiles gives empty lists for equal maps", () => {
  const files = new Map([["a.eff", "1"]]);
  const diff = diffFiles(files, new Map(files));
  assertEquals(diff.set.size, 0);
  assertEquals(diff.remove, []);
});

Deno.test("diffFiles sets every file when nothing is known", () => {
  const wanted = new Map([["a.eff", ""], ["b.eff", "x"]]);
  const diff = diffFiles(new Map(), wanted);
  assertEquals([...diff.set], [...wanted]);
  assertEquals(diff.remove, []);
});

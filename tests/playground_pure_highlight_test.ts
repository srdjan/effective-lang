import { assertEquals } from "@std/assert";
import { highlightTokens } from "../playground/src/highlight.ts";

Deno.test("nested pure types retain their highlights before incomplete input", () => {
  const complete =
    "type F = pure (callback: pure (value: Int) => Int) => Int\n";
  const input = complete + "pure ( ".repeat(8000);
  const highlighted = highlightTokens(input).filter((range) =>
    range.kind === "keyword" && input.slice(range.from, range.to) === "pure"
  );
  assertEquals(highlighted.map((range) => range.from), [
    complete.indexOf("pure"),
    complete.indexOf("pure", complete.indexOf("pure") + 1),
  ]);
});

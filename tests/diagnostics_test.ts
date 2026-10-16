import { assertEquals } from "@std/assert";
import {
  categoryOf,
  dedupeDiagnostics,
  describeCode,
  DIAGNOSTIC_CODES,
  makeDiagnostic,
  normalizeDiagnostics,
  registeredCodes,
  sortDiagnostics,
} from "../src/core/diagnostics.ts";
import { makeSpan } from "../src/core/source.ts";

Deno.test("every code has the form category/NNN and matches its category", () => {
  for (const code of registeredCodes()) {
    assertEquals(/^[a-z-]+\/\d{3}$/.test(code), true, code);
    assertEquals(code.split("/")[0], categoryOf(code), code);
    assertEquals(describeCode(code).length > 10, true, code);
  }
});

Deno.test("A1 and A2 register only the codes of their own categories", () => {
  const categories = ["syntax", "unknown-name", "module", "declaration"];
  for (const code of registeredCodes()) {
    assertEquals(categories.includes(categoryOf(code)), true, code);
  }
  assertEquals(Object.keys(DIAGNOSTIC_CODES).length > 0, true);
});

Deno.test("makeDiagnostic fills category and severity and keeps related spans only when given", () => {
  const span = makeSpan("a.eff", 1, 2);
  const plain = makeDiagnostic("syntax/008", "m", span);
  assertEquals(plain.category, "syntax");
  assertEquals(plain.severity, "error");
  assertEquals("related" in plain, false);
  const related = makeDiagnostic("syntax/008", "m", span, [{
    span,
    message: "see",
  }]);
  assertEquals(related.related?.length, 1);
  assertEquals("related" in makeDiagnostic("syntax/008", "m", span, []), false);
});

Deno.test("sort orders by span, then code, then message; the input stays unchanged", () => {
  const a = makeDiagnostic("syntax/009", "z", makeSpan("a.eff", 5, 6));
  const b = makeDiagnostic("syntax/008", "y", makeSpan("a.eff", 1, 2));
  const c = makeDiagnostic("syntax/008", "x", makeSpan("a.eff", 1, 2));
  const d = makeDiagnostic("syntax/001", "w", makeSpan("a.eff", 1, 1));
  const input = [a, b, c, d];
  assertEquals(sortDiagnostics(input), [d, c, b, a]);
  assertEquals(input, [a, b, c, d]);
});

Deno.test("dedupe removes equal code, span, and message and keeps the first", () => {
  const span = makeSpan("a.eff", 1, 2);
  const a = makeDiagnostic("syntax/008", "m", span);
  const copy = makeDiagnostic("syntax/008", "m", { ...span });
  const other = makeDiagnostic("syntax/008", "n", span);
  assertEquals(dedupeDiagnostics([a, copy, other]), [a, other]);
  assertEquals(
    normalizeDiagnostics([other, copy, a]),
    [other, a].sort((x, y) => x.message < y.message ? -1 : 1),
  );
});

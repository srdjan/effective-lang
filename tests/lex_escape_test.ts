// The invalid escape of a character outside the Basic Multilingual Plane. The
// lexer counts offsets in UTF-16 code units, so such a character has width two
// and the diagnostic must cover both code units, never a lone surrogate.

import { assertEquals } from "@std/assert";
import { lex, TokenKind } from "../src/core/lex.ts";

function reports(text: string) {
  return lex("t.eff", text).diagnostics.map((
    d,
  ) => [d.code, d.message, d.span.start, d.span.end]);
}

Deno.test("an invalid escape of an astral character reports both code units", () => {
  // `"`, `\`, two code units of U+1F600, `"`: five code units.
  const text = '"\\\u{1F600}"';
  assertEquals(text.length, 5);
  assertEquals(reports(text), [
    ["syntax/003", "invalid escape sequence: \\\u{1F600}", 1, 4],
  ]);
  // The string stays one token, and the closing quote still closes it.
  const lexed = lex("t.eff", text);
  assertEquals(
    [...lexed.kinds],
    [TokenKind.String, TokenKind.Eof],
  );
  assertEquals([lexed.starts[0], lexed.ends[0]], [0, 5]);
});

Deno.test("an invalid escape of a Basic Multilingual Plane character reports one code unit", () => {
  assertEquals(reports('"\\é"'), [
    ["syntax/003", "invalid escape sequence: \\é", 1, 3],
  ]);
});

Deno.test("an astral escape inside a longer string does not hide the later text", () => {
  // The error is reported once, and the later valid escape raises none.
  const text = '"a\\\u{1F600}b\\n"';
  assertEquals(reports(text), [
    ["syntax/003", "invalid escape sequence: \\\u{1F600}", 2, 5],
  ]);
  assertEquals(lex("t.eff", text).ends[0], text.length);
});

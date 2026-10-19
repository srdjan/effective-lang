import { assertEquals } from "@std/assert";
import { lex, type Lexed, TokenKind, TriviaKind } from "../src/core/lex.ts";

function kindsOf(text: string): TokenKind[] {
  const lexed = lex("t.eff", text);
  return [...lexed.kinds] as TokenKind[];
}

function texts(lexed: Lexed): string[] {
  const out: string[] = [];
  for (let i = 0; i < lexed.count; i++) {
    out.push(lexed.text.slice(lexed.starts[i], lexed.ends[i]));
  }
  return out;
}

function codes(text: string): string[] {
  return lex("t.eff", text).diagnostics.map((d) => d.code);
}

Deno.test("|> is one token and | stays a separate token", () => {
  assertEquals(kindsOf("a |> b | c || d"), [
    TokenKind.Ident,
    TokenKind.PipeGt,
    TokenKind.Ident,
    TokenKind.Pipe,
    TokenKind.Ident,
    TokenKind.PipePipe,
    TokenKind.Ident,
    TokenKind.Eof,
  ]);
  assertEquals(kindsOf("a|>b|c"), [
    TokenKind.Ident,
    TokenKind.PipeGt,
    TokenKind.Ident,
    TokenKind.Pipe,
    TokenKind.Ident,
    TokenKind.Eof,
  ]);
});

Deno.test("operators and punctuation", () => {
  assertEquals(
    kindsOf("=> === !== <= >= && || ... ? = < > + - * / ! . , : ; ( ) { } [ ]"),
    [
      TokenKind.Arrow,
      TokenKind.EqEqEq,
      TokenKind.BangEqEq,
      TokenKind.LtEq,
      TokenKind.GtEq,
      TokenKind.AmpAmp,
      TokenKind.PipePipe,
      TokenKind.DotDotDot,
      TokenKind.Question,
      TokenKind.Eq,
      TokenKind.Lt,
      TokenKind.Gt,
      TokenKind.Plus,
      TokenKind.Minus,
      TokenKind.Star,
      TokenKind.Slash,
      TokenKind.Bang,
      TokenKind.Dot,
      TokenKind.Comma,
      TokenKind.Colon,
      TokenKind.Semicolon,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.LBrace,
      TokenKind.RBrace,
      TokenKind.LBracket,
      TokenKind.RBracket,
      TokenKind.Eof,
    ],
  );
});

Deno.test("== and != are reported, with a hint, as unknown tokens", () => {
  const lexed = lex("t.eff", "a == b != c");
  assertEquals(lexed.diagnostics.map((d) => d.code), [
    "syntax/001",
    "syntax/001",
  ]);
  assertEquals(texts(lexed).slice(0, 2), ["a", "=="]);
});

Deno.test("hard keywords are tokens; contextual keywords stay identifiers", () => {
  assertEquals(
    kindsOf("import export const match try catch if else true false null"),
    [
      TokenKind.KwImport,
      TokenKind.KwExport,
      TokenKind.KwConst,
      TokenKind.KwMatch,
      TokenKind.KwTry,
      TokenKind.KwCatch,
      TokenKind.KwIf,
      TokenKind.KwElse,
      TokenKind.KwTrue,
      TokenKind.KwFalse,
      TokenKind.KwNull,
      TokenKind.Eof,
    ],
  );
  assertEquals(
    kindsOf("type error service provider from fails uses provides"),
    [...Array(8).fill(TokenKind.Ident), TokenKind.Eof],
  );
  assertEquals(kindsOf("_x $y z9"), [
    TokenKind.Ident,
    TokenKind.Ident,
    TokenKind.Ident,
    TokenKind.Eof,
  ]);
});

Deno.test("reserved words are reported, except void which the parser checks", () => {
  assertEquals(codes("class"), ["syntax/007"]);
  assertEquals(codes("a this b"), ["syntax/007"]);
  assertEquals(
    codes("eval arguments yield await static"),
    Array(5).fill("syntax/007"),
  );
  assertEquals(codes("void"), []);
  assertEquals(codes("classy thisx"), []);
});

Deno.test("newline tokens are significant and trivia keeps whitespace and comments", () => {
  const lexed = lex("t.eff", "a // c\n  b /* x */\n");
  assertEquals(kindsOf("a // c\n  b /* x */\n"), [
    TokenKind.Ident,
    TokenKind.Newline,
    TokenKind.Ident,
    TokenKind.Newline,
    TokenKind.Eof,
  ]);
  const triviaKinds = [...lexed.trivia.kinds];
  assertEquals(triviaKinds, [
    TriviaKind.Whitespace,
    TriviaKind.LineComment,
    TriviaKind.Whitespace,
    TriviaKind.Whitespace,
    TriviaKind.BlockComment,
  ]);
});

Deno.test("CRLF and lone CR are single newline tokens", () => {
  const lexed = lex("t.eff", "a\r\nb\rc");
  assertEquals(texts(lexed), ["a", "\r\n", "b", "\r", "c", ""]);
});

Deno.test("block comments do not nest", () => {
  const lexed = lex("t.eff", "/* a /* b */ c */");
  // The first `*/` closes the comment. The rest lexes as tokens: c * /
  assertEquals(texts(lexed), ["c", "*", "/", ""]);
  assertEquals(lexed.diagnostics.length, 0);
});

Deno.test("an unterminated block comment is reported at its start", () => {
  const lexed = lex("t.eff", "a /* open");
  assertEquals(
    lexed.diagnostics.map((d) => [d.code, d.span.start, d.span.end]),
    [
      ["syntax/004", 2, 9],
    ],
  );
});

Deno.test("string offsets count UTF-16 code units, including a non-ASCII literal", () => {
  const text = 'const s = "héllo \u{1F600} x"\nconst t = 1';
  const lexed = lex("t.eff", text);
  const stringToken = [...lexed.kinds].indexOf(TokenKind.String);
  // 10 is the offset of the opening quote. The literal has 12 UTF-16 units: the
  // quotes, "h", "e-acute", "llo ", an emoji of two units, " x".
  assertEquals(lexed.starts[stringToken], 10);
  assertEquals(lexed.ends[stringToken], 10 + 12);
  assertEquals(
    text.slice(lexed.starts[stringToken], lexed.ends[stringToken]),
    '"héllo \u{1F600} x"',
  );
  // The token after the newline starts at the correct UTF-16 offset.
  const second = [...lexed.kinds].lastIndexOf(TokenKind.KwConst);
  assertEquals(lexed.starts[second], text.indexOf("\n") + 1);
  assertEquals(lexed.diagnostics.length, 0);
});

Deno.test("an astral character outside a string is one unknown token with width two", () => {
  const lexed = lex("t.eff", "a \u{1F600} b");
  assertEquals(lexed.diagnostics.length, 1);
  assertEquals(
    lexed.diagnostics[0].span.end - lexed.diagnostics[0].span.start,
    2,
  );
});

Deno.test("string escapes follow JSON", () => {
  assertEquals(codes('"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti\\u00e9j"'), []);
  assertEquals(codes('"\\q"'), ["syntax/003"]);
  assertEquals(codes('"\\u12"'), ["syntax/003"]);
  assertEquals(codes('"\\u12g4"'), ["syntax/003"]);
  assertEquals(codes('"\\x41"'), ["syntax/003"]);
});

Deno.test("an unterminated string ends at the line end", () => {
  const lexed = lex("t.eff", '"abc\nd');
  assertEquals(
    lexed.diagnostics.map((d) => [d.code, d.span.start, d.span.end]),
    [
      ["syntax/002", 0, 4],
    ],
  );
  assertEquals(texts(lexed), ['"abc', "\n", "d", ""]);
});

Deno.test("numbers: decimal with fraction and exponent; bad forms are reported", () => {
  assertEquals(codes("0 7 10 1.5 0.25 1e5 1E5 2.5e-3 1e+2"), []);
  assertEquals(codes("01"), ["syntax/006"]);
  assertEquals(codes("1e"), ["syntax/006"]);
  assertEquals(codes("1e+"), ["syntax/006"]);
  assertEquals(codes("12abc"), ["syntax/006"]);
  assertEquals(codes("1e999"), ["syntax/005"]);
  assertEquals(codes("1e308"), []);
});

Deno.test("a number followed by a dot and a name is a number, a dot, and a name", () => {
  assertEquals(kindsOf("1.x"), [
    TokenKind.Number,
    TokenKind.Dot,
    TokenKind.Ident,
    TokenKind.Eof,
  ]);
});

Deno.test("unexpected characters are reported and kept as tokens", () => {
  const lexed = lex("t.eff", "a @ b");
  assertEquals(lexed.diagnostics.map((d) => d.code), ["syntax/001"]);
  assertEquals([...lexed.kinds].includes(TokenKind.Unknown), true);
});

Deno.test("a byte order mark at the start is trivia", () => {
  const lexed = lex("t.eff", "﻿a");
  assertEquals(lexed.diagnostics.length, 0);
  assertEquals(lexed.starts[0], 1);
});

Deno.test("tokens and trivia tile the whole text", () => {
  const text = 'const a = 1 // c\r\n/* b */ const b = "x" |> f\n';
  const lexed = lex("t.eff", text);
  let rebuilt = "";
  for (let t = 0; t < lexed.count; t++) {
    const first = t === 0 ? 0 : lexed.triviaEnd[t - 1];
    for (let k = first; k < lexed.triviaEnd[t]; k++) {
      rebuilt += text.slice(lexed.trivia.starts[k], lexed.trivia.ends[k]);
    }
    rebuilt += text.slice(lexed.starts[t], lexed.ends[t]);
  }
  assertEquals(rebuilt, text);
});

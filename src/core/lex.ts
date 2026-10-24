// Hand-written lexer. It scans a whole file into parallel typed arrays and keeps
// whitespace and comments as trivia, so the syntax tree can print the exact text.
// Newline tokens are significant. The parser decides where they separate items.

import { type Diagnostic, makeDiagnostic } from "./diagnostics.ts";

export enum TokenKind {
  Eof,
  Newline,
  Ident,
  KwImport,
  KwExport,
  KwConst,
  KwMatch,
  KwTry,
  KwCatch,
  KwIf,
  KwElse,
  KwTrue,
  KwFalse,
  KwNull,
  String,
  Number,
  LParen,
  RParen,
  LBrace,
  RBrace,
  LBracket,
  RBracket,
  Comma,
  Colon,
  Semicolon,
  Dot,
  DotDotDot,
  Question,
  Eq,
  Arrow,
  EqEqEq,
  BangEqEq,
  Lt,
  LtEq,
  Gt,
  GtEq,
  AmpAmp,
  PipePipe,
  Pipe,
  PipeGt,
  Plus,
  Minus,
  Star,
  Slash,
  Bang,
  /** A character or sequence that the language does not use. The lexer reported it. */
  Unknown,
  QuestionQuestion,
  KwFinally,
}

export enum TriviaKind {
  Whitespace,
  LineComment,
  BlockComment,
}

interface TriviaTable {
  readonly kinds: Uint8Array;
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
}

export interface Lexed {
  readonly source: string;
  readonly text: string;
  /** Number of tokens, including the final Eof token. */
  readonly count: number;
  readonly kinds: Uint8Array;
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
  readonly trivia: TriviaTable;
  /**
   * `triviaEnd[t]` is the number of trivia items emitted up to token `t`.
   * Token `t` owns trivia items from `triviaEnd[t - 1]` (or 0) up to `triviaEnd[t]`.
   * Trivia after the last real token belongs to the Eof token.
   */
  readonly triviaEnd: Uint32Array;
  readonly diagnostics: readonly Diagnostic[];
}

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["import", TokenKind.KwImport],
  ["export", TokenKind.KwExport],
  ["const", TokenKind.KwConst],
  ["match", TokenKind.KwMatch],
  ["try", TokenKind.KwTry],
  ["catch", TokenKind.KwCatch],
  ["if", TokenKind.KwIf],
  ["else", TokenKind.KwElse],
  ["true", TokenKind.KwTrue],
  ["false", TokenKind.KwFalse],
  ["null", TokenKind.KwNull],
  ["finally", TokenKind.KwFinally],
]);

/**
 * Words that a strict ES module reserves. An identifier with one of these
 * spellings is a `syntax` diagnostic, so the emitter never renames a source
 * identifier. `void` is also on the list but stays valid as a type name: the
 * lexer skips it and the parser checks it in the other positions.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "class",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "enum",
  "extends",
  "for",
  "function",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
  "arguments",
  "eval",
]);

const TOKEN_NAMES: Readonly<Record<TokenKind, string>> = {
  [TokenKind.Eof]: "end of file",
  [TokenKind.Newline]: "end of line",
  [TokenKind.Ident]: "name",
  [TokenKind.String]: "string",
  [TokenKind.Number]: "number",
  [TokenKind.LParen]: "`(`",
  [TokenKind.RParen]: "`)`",
  [TokenKind.LBrace]: "`{`",
  [TokenKind.RBrace]: "`}`",
  [TokenKind.LBracket]: "`[`",
  [TokenKind.RBracket]: "`]`",
  [TokenKind.Comma]: "`,`",
  [TokenKind.Colon]: "`:`",
  [TokenKind.Semicolon]: "`;`",
  [TokenKind.Dot]: "`.`",
  [TokenKind.DotDotDot]: "`...`",
  [TokenKind.Question]: "`?`",
  [TokenKind.QuestionQuestion]: "`??`",
  [TokenKind.KwFinally]: "`finally`",
  [TokenKind.Eq]: "`=`",
  [TokenKind.Arrow]: "`=>`",
  [TokenKind.EqEqEq]: "`===`",
  [TokenKind.BangEqEq]: "`!==`",
  [TokenKind.Lt]: "`<`",
  [TokenKind.LtEq]: "`<=`",
  [TokenKind.Gt]: "`>`",
  [TokenKind.GtEq]: "`>=`",
  [TokenKind.AmpAmp]: "`&&`",
  [TokenKind.PipePipe]: "`||`",
  [TokenKind.Pipe]: "`|`",
  [TokenKind.PipeGt]: "`|>`",
  [TokenKind.Plus]: "`+`",
  [TokenKind.Minus]: "`-`",
  [TokenKind.Star]: "`*`",
  [TokenKind.Slash]: "`/`",
  [TokenKind.Bang]: "`!`",
  [TokenKind.Unknown]: "unknown character",
  [TokenKind.KwImport]: "`import`",
  [TokenKind.KwExport]: "`export`",
  [TokenKind.KwConst]: "`const`",
  [TokenKind.KwMatch]: "`match`",
  [TokenKind.KwTry]: "`try`",
  [TokenKind.KwCatch]: "`catch`",
  [TokenKind.KwIf]: "`if`",
  [TokenKind.KwElse]: "`else`",
  [TokenKind.KwTrue]: "`true`",
  [TokenKind.KwFalse]: "`false`",
  [TokenKind.KwNull]: "`null`",
};

/** A short name for messages. */
export function describeTokenKind(kind: TokenKind): string {
  return TOKEN_NAMES[kind];
}

/** True when token `index` is an identifier that spells `word`. */
export function isWord(lexed: Lexed, index: number, word: string): boolean {
  return lexed.kinds[index] === TokenKind.Ident &&
    lexed.ends[index] - lexed.starts[index] === word.length &&
    lexed.text.startsWith(word, lexed.starts[index]);
}

function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f ||
    c === 0x24;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function describeChar(text: string, index: number): string {
  const cp = text.codePointAt(index) ?? 0;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return `'${String.fromCodePoint(cp)}'`;
}

type Report = (
  code: Parameters<typeof makeDiagnostic>[0],
  message: string,
  s: number,
  e: number,
) => void;

/** Token kind + 1 of each one-character token, by char code. 0 means none. */
const SINGLE = new Uint8Array(128);
for (
  const [ch, kind] of [
    ["(", TokenKind.LParen],
    [")", TokenKind.RParen],
    ["{", TokenKind.LBrace],
    ["}", TokenKind.RBrace],
    ["[", TokenKind.LBracket],
    ["]", TokenKind.RBracket],
    [",", TokenKind.Comma],
    [":", TokenKind.Colon],
    [";", TokenKind.Semicolon],
    ["+", TokenKind.Plus],
    ["-", TokenKind.Minus],
    ["*", TokenKind.Star],
  ] as const
) SINGLE[ch.charCodeAt(0)] = kind + 1;

/** Scans a number that starts at `i`. Returns its end. */
function scanNumber(text: string, i: number, report: Report): number {
  const n = text.length;
  let j = i + 1;
  while (j < n && isDigit(text.charCodeAt(j))) j++;
  const intEnd = j;
  let malformed: string | undefined;
  if (text.charCodeAt(i) === 0x30 && intEnd - i > 1) {
    malformed = "a number cannot have a leading zero";
  }
  if (
    j + 1 < n && text.charCodeAt(j) === 0x2e &&
    isDigit(text.charCodeAt(j + 1))
  ) {
    j++;
    while (j < n && isDigit(text.charCodeAt(j))) j++;
  }
  const ec = j < n ? text.charCodeAt(j) : 0;
  if (ec === 0x65 || ec === 0x45) {
    let k = j + 1;
    if (
      k < n && (text.charCodeAt(k) === 0x2b || text.charCodeAt(k) === 0x2d)
    ) k++;
    if (k < n && isDigit(text.charCodeAt(k))) {
      while (k < n && isDigit(text.charCodeAt(k))) k++;
      j = k;
    } else {
      malformed = malformed ?? "the exponent has no digits";
      j = k;
    }
  }
  if (j < n && isIdentPart(text.charCodeAt(j))) {
    malformed = malformed ?? "a number cannot be followed by letters";
    while (j < n && isIdentPart(text.charCodeAt(j))) j++;
  }
  if (malformed !== undefined) {
    report("syntax/006", `malformed number: ${malformed}`, i, j);
  } else if (!Number.isFinite(Number(text.slice(i, j)))) {
    report("syntax/005", "number literal is not a finite value", i, j);
  }
  return j;
}

/** Scans the escape at `j` (a backslash) inside a string. Returns the next index. */
function scanEscape(text: string, j: number, report: Report): number {
  const n = text.length;
  const e = j + 1 < n ? text.charCodeAt(j + 1) : -1;
  if (
    e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 ||
    e === 0x66 || e === 0x6e ||
    e === 0x72 || e === 0x74
  ) {
    return j + 2;
  }
  if (e === 0x75) {
    let k = j + 2;
    let digits = 0;
    while (digits < 4 && k < n && isHexDigit(text.charCodeAt(k))) {
      k++;
      digits++;
    }
    if (digits < 4) {
      report(
        "syntax/003",
        "invalid escape sequence: \\u needs four hex digits",
        j,
        k,
      );
    }
    return k;
  }
  if (e === -1 || e === 0x0a || e === 0x0d) {
    report(
      "syntax/003",
      "invalid escape sequence: backslash at end of line",
      j,
      j + 1,
    );
    return j + 1;
  }
  const width = (text.codePointAt(j + 1) ?? 0) > 0xffff ? 2 : 1;
  report(
    "syntax/003",
    `invalid escape sequence: \\${text.slice(j + 1, j + 1 + width)}`,
    j,
    j + 1 + width,
  );
  return j + 1 + width;
}

/** Scans a string that starts at `i`. Returns its end. */
function scanString(text: string, i: number, report: Report): number {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const d = text.charCodeAt(j);
    if (d === 0x22) return j + 1;
    if (d === 0x0a || d === 0x0d) break;
    if (d < 0x20 || d === 0x7f) {
      report(
        "syntax/003",
        `string literal contains the control character ${
          describeChar(text, j)
        }; use an escape sequence`,
        j,
        j + 1,
      );
      j++;
    } else if (d === 0x5c) {
      j = scanEscape(text, j, report);
    } else {
      j++;
    }
  }
  report("syntax/002", "string literal has no closing quote", i, j);
  return j;
}

/** Scans a block comment that starts at `i`. Returns its end. */
function scanBlockComment(text: string, i: number, report: Report): number {
  const close = text.indexOf("*/", i + 2);
  if (close >= 0) return close + 2;
  report("syntax/004", "block comment has no closing `*/`", i, text.length);
  return text.length;
}

/** Scans the whole text. Never throws. */
export function lex(source: string, text: string): Lexed {
  const n = text.length;
  const kinds: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const triviaKinds: number[] = [];
  const triviaStarts: number[] = [];
  const triviaEnds: number[] = [];
  const triviaEnd: number[] = [];
  const diagnostics: Diagnostic[] = [];

  const report: Report = (code, message, s, e) => {
    diagnostics.push(
      makeDiagnostic(code, message, { source, start: s, end: e }),
    );
  };
  const push = (kind: TokenKind, s: number, e: number) => {
    kinds.push(kind);
    starts.push(s);
    ends.push(e);
    triviaEnd.push(triviaKinds.length);
  };
  const pushTrivia = (kind: TriviaKind, s: number, e: number) => {
    triviaKinds.push(kind);
    triviaStarts.push(s);
    triviaEnds.push(e);
  };
  /** Pushes `two` when the next char is `second`, else `one`. Returns the next index. */
  const pair = (
    i: number,
    second: number,
    two: TokenKind,
    one: TokenKind,
  ): number => {
    if (text.charCodeAt(i + 1) === second) {
      push(two, i, i + 2);
      return i + 2;
    }
    push(one, i, i + 1);
    return i + 1;
  };

  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) {
    pushTrivia(TriviaKind.Whitespace, 0, 1);
    i = 1;
  }

  while (i < n) {
    const c = text.charCodeAt(i);
    const single = c < 128 ? SINGLE[c] : 0;
    if (single !== 0) {
      push(single - 1, i, i + 1);
      i++;
      continue;
    }

    // Whitespace
    if (c === 0x20 || c === 0x09) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d !== 0x20 && d !== 0x09) break;
        j++;
      }
      pushTrivia(TriviaKind.Whitespace, i, j);
      i = j;
      continue;
    }

    // Newline
    if (c === 0x0a) {
      push(TokenKind.Newline, i, i + 1);
      i++;
      continue;
    }
    if (c === 0x0d) {
      const e = i + 1 < n && text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      push(TokenKind.Newline, i, e);
      i = e;
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text.charCodeAt(j))) j++;
      const word = text.slice(i, j);
      const keyword = KEYWORDS.get(word);
      if (keyword !== undefined) {
        push(keyword, i, j);
      } else {
        if (word !== "void" && RESERVED_WORDS.has(word)) {
          report(
            "syntax/007",
            `\`${word}\` is a reserved word and cannot be a name`,
            i,
            j,
          );
        }
        push(TokenKind.Ident, i, j);
      }
      i = j;
      continue;
    }

    if (isDigit(c)) {
      const j = scanNumber(text, i, report);
      push(TokenKind.Number, i, j);
      i = j;
      continue;
    }

    if (c === 0x22) {
      const j = scanString(text, i, report);
      push(TokenKind.String, i, j);
      i = j;
      continue;
    }

    const next = i + 1 < n ? text.charCodeAt(i + 1) : -1;
    const next2 = i + 2 < n ? text.charCodeAt(i + 2) : -1;

    switch (c) {
      case 0x3f: // ?
        i = pair(i, 0x3f, TokenKind.QuestionQuestion, TokenKind.Question);
        continue;
      case 0x2f: // /
        if (next === 0x2f) {
          let j = i + 2;
          while (j < n) {
            const d = text.charCodeAt(j);
            if (d === 0x0a || d === 0x0d) break;
            j++;
          }
          pushTrivia(TriviaKind.LineComment, i, j);
          i = j;
        } else if (next === 0x2a) {
          const j = scanBlockComment(text, i, report);
          pushTrivia(TriviaKind.BlockComment, i, j);
          i = j;
        } else {
          push(TokenKind.Slash, i, i + 1);
          i++;
        }
        continue;
      case 0x7c: // |
        if (next === 0x7c) {
          push(TokenKind.PipePipe, i, i + 2);
          i += 2;
        } else i = pair(i, 0x3e, TokenKind.PipeGt, TokenKind.Pipe);
        continue;
      case 0x26: // &
        if (next === 0x26) {
          push(TokenKind.AmpAmp, i, i + 2);
          i += 2;
        } else {
          report(
            "syntax/001",
            "unexpected character '&'; the AND operator is `&&`",
            i,
            i + 1,
          );
          push(TokenKind.Unknown, i, i + 1);
          i++;
        }
        continue;
      case 0x3d: // =
        if (next === 0x3d && next2 === 0x3d) {
          push(TokenKind.EqEqEq, i, i + 3);
          i += 3;
        } else if (next === 0x3d) {
          report(
            "syntax/001",
            "unexpected `==`; the equality operator is `===`",
            i,
            i + 2,
          );
          push(TokenKind.Unknown, i, i + 2);
          i += 2;
        } else i = pair(i, 0x3e, TokenKind.Arrow, TokenKind.Eq);
        continue;
      case 0x21: // !
        if (next === 0x3d && next2 === 0x3d) {
          push(TokenKind.BangEqEq, i, i + 3);
          i += 3;
        } else if (next === 0x3d) {
          report(
            "syntax/001",
            "unexpected `!=`; the inequality operator is `!==`",
            i,
            i + 2,
          );
          push(TokenKind.Unknown, i, i + 2);
          i += 2;
        } else {
          push(TokenKind.Bang, i, i + 1);
          i++;
        }
        continue;
      case 0x3c: // <
        i = pair(i, 0x3d, TokenKind.LtEq, TokenKind.Lt);
        continue;
      case 0x3e: // >
        i = pair(i, 0x3d, TokenKind.GtEq, TokenKind.Gt);
        continue;
      case 0x2e: // .
        if (next === 0x2e && next2 === 0x2e) {
          push(TokenKind.DotDotDot, i, i + 3);
          i += 3;
        } else {
          push(TokenKind.Dot, i, i + 1);
          i++;
        }
        continue;
      default: {
        const width = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
        report(
          "syntax/001",
          `unexpected character ${describeChar(text, i)}`,
          i,
          i + width,
        );
        push(TokenKind.Unknown, i, i + width);
        i += width;
      }
    }
  }

  push(TokenKind.Eof, n, n);

  return {
    source,
    text,
    count: kinds.length,
    kinds: Uint8Array.from(kinds),
    starts: Uint32Array.from(starts),
    ends: Uint32Array.from(ends),
    trivia: {
      kinds: Uint8Array.from(triviaKinds),
      starts: Uint32Array.from(triviaStarts),
      ends: Uint32Array.from(triviaEnds),
    },
    triviaEnd: Uint32Array.from(triviaEnd),
    diagnostics,
  };
}

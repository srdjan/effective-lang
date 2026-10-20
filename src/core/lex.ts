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
  "finally",
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

const TOKEN_NAMES: Readonly<Record<number, string>> = {
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
  return TOKEN_NAMES[kind] ?? "token";
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

  const report = (
    code: Parameters<typeof makeDiagnostic>[0],
    message: string,
    s: number,
    e: number,
  ) => {
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

  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) {
    pushTrivia(TriviaKind.Whitespace, 0, 1);
    i = 1;
  }

  while (i < n) {
    const c = text.charCodeAt(i);

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

    // Number
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(text.charCodeAt(j))) j++;
      const intEnd = j;
      let malformed: string | undefined;
      if (
        text.charCodeAt(i) === 0x30 && intEnd - i > 1
      ) {
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
      push(TokenKind.Number, i, j);
      i = j;
      continue;
    }

    // String
    if (c === 0x22) {
      let j = i + 1;
      let terminated = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x22) {
          j++;
          terminated = true;
          break;
        }
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
          continue;
        }
        if (d === 0x5c) {
          const e = j + 1 < n ? text.charCodeAt(j + 1) : -1;
          if (
            e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 ||
            e === 0x66 || e === 0x6e ||
            e === 0x72 || e === 0x74
          ) {
            j += 2;
          } else if (e === 0x75) {
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
            j = k;
          } else if (e === -1 || e === 0x0a || e === 0x0d) {
            report(
              "syntax/003",
              "invalid escape sequence: backslash at end of line",
              j,
              j + 1,
            );
            j += 1;
          } else {
            const width = (text.codePointAt(j + 1) ?? 0) > 0xffff ? 2 : 1;
            report(
              "syntax/003",
              `invalid escape sequence: \\${text.slice(j + 1, j + 1 + width)}`,
              j,
              j + 1 + width,
            );
            j += 1 + width;
          }
          continue;
        }
        j++;
      }
      if (!terminated) {
        report("syntax/002", "string literal has no closing quote", i, j);
      }
      push(TokenKind.String, i, j);
      i = j;
      continue;
    }

    const next = i + 1 < n ? text.charCodeAt(i + 1) : -1;
    const next2 = i + 2 < n ? text.charCodeAt(i + 2) : -1;

    switch (c) {
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
          let j = i + 2;
          let closed = false;
          while (j < n) {
            if (
              text.charCodeAt(j) === 0x2a && j + 1 < n &&
              text.charCodeAt(j + 1) === 0x2f
            ) {
              j += 2;
              closed = true;
              break;
            }
            j++;
          }
          if (!closed) {
            report("syntax/004", "block comment has no closing `*/`", i, n);
            j = n;
          }
          pushTrivia(TriviaKind.BlockComment, i, j);
          i = j;
        } else {
          push(TokenKind.Slash, i, i + 1);
          i++;
        }
        continue;
      case 0x7c: // |
        if (next === 0x3e) {
          push(TokenKind.PipeGt, i, i + 2);
          i += 2;
        } else if (next === 0x7c) {
          push(TokenKind.PipePipe, i, i + 2);
          i += 2;
        } else {
          push(TokenKind.Pipe, i, i + 1);
          i++;
        }
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
        } else if (next === 0x3e) {
          push(TokenKind.Arrow, i, i + 2);
          i += 2;
        } else {
          push(TokenKind.Eq, i, i + 1);
          i++;
        }
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
        if (next === 0x3d) {
          push(TokenKind.LtEq, i, i + 2);
          i += 2;
        } else {
          push(TokenKind.Lt, i, i + 1);
          i++;
        }
        continue;
      case 0x3e: // >
        if (next === 0x3d) {
          push(TokenKind.GtEq, i, i + 2);
          i += 2;
        } else {
          push(TokenKind.Gt, i, i + 1);
          i++;
        }
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
      case 0x28:
        push(TokenKind.LParen, i, i + 1);
        i++;
        continue;
      case 0x29:
        push(TokenKind.RParen, i, i + 1);
        i++;
        continue;
      case 0x7b:
        push(TokenKind.LBrace, i, i + 1);
        i++;
        continue;
      case 0x7d:
        push(TokenKind.RBrace, i, i + 1);
        i++;
        continue;
      case 0x5b:
        push(TokenKind.LBracket, i, i + 1);
        i++;
        continue;
      case 0x5d:
        push(TokenKind.RBracket, i, i + 1);
        i++;
        continue;
      case 0x2c:
        push(TokenKind.Comma, i, i + 1);
        i++;
        continue;
      case 0x3a:
        push(TokenKind.Colon, i, i + 1);
        i++;
        continue;
      case 0x3b:
        push(TokenKind.Semicolon, i, i + 1);
        i++;
        continue;
      case 0x3f:
        push(TokenKind.Question, i, i + 1);
        i++;
        continue;
      case 0x2b:
        push(TokenKind.Plus, i, i + 1);
        i++;
        continue;
      case 0x2d:
        push(TokenKind.Minus, i, i + 1);
        i++;
        continue;
      case 0x2a:
        push(TokenKind.Star, i, i + 1);
        i++;
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

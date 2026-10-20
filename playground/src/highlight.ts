// Syntax highlighting from the core lexer (plan 5.3). The page and the compiler
// then agree on every token. The function merges the token table and the trivia
// table into one sorted list of ranges. Words and spaces that need no color give
// no range.
//
// The lexer reads `type`, `error`, `service`, `provider`, `fails`, `uses`,
// `provides`, and `from` as names. This file gives them the keyword kind by
// position, from the token stream.

import {
  BUILTIN_TYPE_NAMES,
  KEYWORDS,
  lex,
  PRELUDE_NAMES,
  TokenKind,
  TriviaKind,
} from "../../src/core/mod.ts";

export type HighlightKind =
  | "keyword"
  | "builtin"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "operator";

/** A range of the text. `to` is exclusive. Ranges do not overlap. */
interface HighlightRange {
  readonly from: number;
  readonly to: number;
  readonly kind: HighlightKind;
}

/** Words that are keywords at the start of a line or after `export`. */
const DECLARATION_WORDS: ReadonlySet<string> = new Set([
  "type",
  "error",
  "service",
  "provider",
]);

/** Words that are keywords wherever they appear as a name. */
const CLAUSE_WORDS: ReadonlySet<string> = new Set([
  "fails",
  "uses",
  "provides",
  "from",
]);

const OPERATORS: ReadonlySet<TokenKind> = new Set([
  TokenKind.Eq,
  TokenKind.Arrow,
  TokenKind.EqEqEq,
  TokenKind.BangEqEq,
  TokenKind.Lt,
  TokenKind.LtEq,
  TokenKind.Gt,
  TokenKind.GtEq,
  TokenKind.AmpAmp,
  TokenKind.PipePipe,
  TokenKind.Pipe,
  TokenKind.PipeGt,
  TokenKind.Plus,
  TokenKind.Minus,
  TokenKind.Star,
  TokenKind.Slash,
  TokenKind.Bang,
]);

const KEYWORD_KINDS: ReadonlySet<TokenKind> = new Set(KEYWORDS.values());

function isCapitalized(word: string): boolean {
  const first = word.charCodeAt(0);
  return first >= 0x41 && first <= 0x5a;
}

/** The ranges of `text`, sorted by `from`. */
export function highlightTokens(text: string): HighlightRange[] {
  const lexed = lex("", text);
  const ranges: HighlightRange[] = [];

  for (let i = 0; i < lexed.trivia.kinds.length; i++) {
    const kind = lexed.trivia.kinds[i];
    if (kind === TriviaKind.LineComment || kind === TriviaKind.BlockComment) {
      ranges.push({
        from: lexed.trivia.starts[i],
        to: lexed.trivia.ends[i],
        kind: "comment",
      });
    }
  }

  for (let i = 0; i < lexed.count; i++) {
    const kind = lexed.kinds[i] as TokenKind;
    const from = lexed.starts[i];
    const to = lexed.ends[i];
    let result: HighlightKind | undefined;
    if (KEYWORD_KINDS.has(kind)) {
      result = "keyword";
    } else if (kind === TokenKind.String) {
      result = "string";
    } else if (kind === TokenKind.Number) {
      result = "number";
    } else if (OPERATORS.has(kind)) {
      result = "operator";
    } else if (kind === TokenKind.Ident) {
      const word = text.slice(from, to);
      const previous = i === 0 ? undefined : lexed.kinds[i - 1] as TokenKind;
      const startsDeclaration = previous === undefined ||
        previous === TokenKind.Newline || previous === TokenKind.KwExport;
      if (CLAUSE_WORDS.has(word)) result = "keyword";
      else if (DECLARATION_WORDS.has(word) && startsDeclaration) {
        result = "keyword";
      } else if (PRELUDE_NAMES.has(word)) result = "builtin";
      else if (BUILTIN_TYPE_NAMES.has(word) || isCapitalized(word)) {
        result = "type";
      }
    }
    if (result !== undefined) ranges.push({ from, to, kind: result });
  }

  return ranges.sort((a, b) => a.from - b.from);
}

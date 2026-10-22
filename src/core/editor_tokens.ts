import type { Revision } from "./db.ts";
import { symbolIndex, type SymbolOccurrence } from "./editor_index.ts";
import { lex, TokenKind, TriviaKind } from "./lex.ts";
import { parseFileFresh } from "./project.ts";
import type { Span } from "./source.ts";

export const SEMANTIC_TOKEN_TYPES = [
  "type",
  "class",
  "interface",
  "parameter",
  "variable",
  "property",
  "function",
  "method",
  "keyword",
  "string",
  "number",
  "comment",
  "operator",
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "readonly"] as const;
export interface SemanticClassification {
  readonly span: Span;
  readonly type: (typeof SEMANTIC_TOKEN_TYPES)[number];
  readonly modifiers: readonly (typeof SEMANTIC_TOKEN_MODIFIERS)[number][];
}

const contextualKeywords = new Set([
  "type",
  "error",
  "service",
  "provider",
  "opaque",
  "fails",
  "uses",
  "provides",
  "borrow",
]);

function resolvedKind(
  revision: Revision,
  occurrence: SymbolOccurrence,
): SemanticClassification["type"] {
  switch (occurrence.target.kind) {
    case "type":
    case "builtin-type":
      return "type";
    case "error":
      return "class";
    case "service":
      return "interface";
    case "cap":
      return "method";
    case "field":
      return "property";
    case "builtin":
      return "function";
    case "local":
      return symbolIndex(revision).locals.get(
          occurrence.declaration?.source ?? "",
        )?.find((l) => l.identity === occurrence.identity)?.parameter
        ? "parameter"
        : "variable";
    case "value": {
      const declaration = occurrence.declaration;
      const entry = declaration === undefined
        ? undefined
        : revision.moduleInfoAt(declaration.source)?.index.decls.find((d) =>
          d.nameSpan.start === declaration.start
        );
      return entry?.isArrow ? "function" : "variable";
    }
    default:
      return "variable";
  }
}

/** Resolver classifications where available and lexical fallback everywhere else. */
export function semanticClassifications(
  revision: Revision | undefined,
  path: string,
  text: string,
): readonly SemanticClassification[] {
  const matching = revision?.sourceTexts().get(path) === text
    ? revision
    : undefined;
  const occurrences = matching === undefined
    ? []
    : symbolIndex(matching).byPath.get(path) ?? [];
  const byStart = new Map(occurrences.map((o) => [o.span.start, o]));
  const lexed = lex(path, text);
  const output: SemanticClassification[] = [];
  for (let i = 0; i < lexed.count; i++) {
    const kind = lexed.kinds[i];
    const span = { source: path, start: lexed.starts[i], end: lexed.ends[i] };
    if (span.start === span.end || kind === TokenKind.Newline) continue;
    const occurrence = byStart.get(span.start);
    if (
      occurrence !== undefined && occurrence.span.end === span.end &&
      matching !== undefined
    ) {
      output.push({
        span,
        type: resolvedKind(matching, occurrence),
        modifiers: [
          ...(occurrence.isDeclaration ? ["declaration" as const] : []),
          ...(occurrence.declaration !== undefined ||
              occurrence.target.kind === "builtin"
            ? ["readonly" as const]
            : []),
        ],
      });
    } else if (kind === TokenKind.String) {
      output.push({ span, type: "string", modifiers: [] });
    } else if (kind === TokenKind.Number) {
      output.push({ span, type: "number", modifiers: [] });
    } else if (
      kind >= TokenKind.KwImport && kind <= TokenKind.KwNull ||
      kind === TokenKind.Ident &&
        contextualKeywords.has(text.slice(span.start, span.end))
    ) output.push({ span, type: "keyword", modifiers: [] });
    else if (kind === TokenKind.Ident) {
      output.push({ span, type: "variable", modifiers: [] });
    } else if (kind >= TokenKind.Arrow) {
      output.push({ span, type: "operator", modifiers: [] });
    }
  }
  for (let i = 0; i < lexed.trivia.kinds.length; i++) {
    if (
      lexed.trivia.kinds[i] === TriviaKind.LineComment ||
      lexed.trivia.kinds[i] === TriviaKind.BlockComment
    ) {
      output.push({
        span: {
          source: path,
          start: lexed.trivia.starts[i],
          end: lexed.trivia.ends[i],
        },
        type: "comment",
        modifiers: [],
      });
    }
  }
  // Declarations recovered from otherwise broken regions can still be marked.
  if (matching === undefined) {
    const { index } = parseFileFresh(path, text);
    const names = new Set(
      index.decls.flatMap((d) => [
        d.nameSpan.start,
        ...d.methodList.map((m) => m.nameSpan.start),
      ]),
    );
    for (let i = 0; i < output.length; i++) {
      if (names.has(output[i].span.start)) {
        const declaration = index.decls.find((d) =>
          d.nameSpan.start === output[i].span.start
        );
        const type = declaration?.kind === "type"
          ? "type"
          : declaration?.kind === "error"
          ? "class"
          : declaration?.kind === "service"
          ? "interface"
          : declaration?.isArrow
          ? "function"
          : declaration === undefined
          ? "method"
          : "variable";
        output[i] = {
          ...output[i],
          type,
          modifiers: ["declaration", "readonly"],
        };
      }
    }
  }
  return output.sort((a, b) => a.span.start - b.span.start);
}

// Syntax queries shared by indexing, checking and lowering. They depend only
// on the lossless tree and lexer, never on checker state or inferred types.

import { TokenKind } from "./lex.ts";
import {
  childrenOf,
  decodeString,
  kindOf,
  type NodeId,
  nodeText,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";

const TYPE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NamedType,
  SyntaxKind.EffectType,
  SyntaxKind.StreamType,
  SyntaxKind.SinkType,
  SyntaxKind.ScheduleType,
  SyntaxKind.SchemaType,
  SyntaxKind.LayerType,
  SyntaxKind.LiteralType,
  SyntaxKind.RecordType,
  SyntaxKind.TupleType,
  SyntaxKind.ArrayType,
  SyntaxKind.UnionType,
  SyntaxKind.FunctionType,
  SyntaxKind.ParenType,
]);

/** True for the syntax kinds of type nodes. */
export function isTypeKind(kind: SyntaxKind): boolean {
  return TYPE_KINDS.has(kind);
}

/** The lexer kind of a Token node, or undefined for any other node. */
export function tokenKindOf(
  tree: SyntaxTree,
  node: NodeId,
): TokenKind | undefined {
  return kindOf(tree, node) === SyntaxKind.Token
    ? tree.lexed.kinds[tree.tokens[node]] as TokenKind
    : undefined;
}

/** The text of a Name node, or undefined when the parser did not read an identifier. */
export function nameTextOf(
  tree: SyntaxTree,
  nameNode: NodeId,
): string | undefined {
  const first = childrenOf(tree, nameNode)[0];
  if (first === undefined || tokenKindOf(tree, first) !== TokenKind.Ident) {
    return undefined;
  }
  return tree.text.slice(tree.starts[first], tree.ends[first]);
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

const OPERATORS: ReadonlyMap<TokenKind, BinaryOperator> = new Map([
  [TokenKind.Plus, "+"],
  [TokenKind.Minus, "-"],
  [TokenKind.Star, "*"],
  [TokenKind.Slash, "/"],
  [TokenKind.EqEqEq, "==="],
  [TokenKind.BangEqEq, "!=="],
  [TokenKind.Lt, "<"],
  [TokenKind.LtEq, "<="],
  [TokenKind.Gt, ">"],
  [TokenKind.GtEq, ">="],
  [TokenKind.AmpAmp, "&&"],
  [TokenKind.PipePipe, "||"],
]);

/** Child nodes of a node that are not tokens or Missing nodes. */
export function kidsOf(tree: SyntaxTree, node: NodeId): NodeId[] {
  const result: NodeId[] = [];
  for (const child of childrenOf(tree, node)) {
    const kind = kindOf(tree, child);
    if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
      result.push(child);
    }
  }
  return result;
}

export function literalOf(
  tree: SyntaxTree,
  node: NodeId,
): string | number | boolean | null | undefined {
  for (const child of childrenOf(tree, node)) {
    if (kindOf(tree, child) !== SyntaxKind.Token) continue;
    const kind = tree.lexed.kinds[tree.tokens[child]] as TokenKind;
    const text = nodeText(tree, child);
    if (kind === TokenKind.String) return decodeString(text);
    if (kind === TokenKind.Number) {
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    if (kind === TokenKind.KwTrue) return true;
    if (kind === TokenKind.KwFalse) return false;
    if (kind === TokenKind.KwNull) return null;
  }
  return undefined;
}

export function operatorOf(
  tree: SyntaxTree,
  node: NodeId,
): BinaryOperator | undefined {
  for (const child of childrenOf(tree, node)) {
    if (kindOf(tree, child) !== SyntaxKind.Token) continue;
    const kind = tree.lexed.kinds[tree.tokens[child]] as TokenKind;
    const operator = OPERATORS.get(kind);
    if (operator !== undefined) return operator;
  }
  return undefined;
}

/** The last arrow child outside its parameters, clauses and result type. */
export function arrowBody(tree: SyntaxTree, node: NodeId): NodeId | undefined {
  return kidsOf(tree, node).filter((child) => {
    const kind = kindOf(tree, child);
    return kind !== SyntaxKind.ParamList && kind !== SyntaxKind.FailsClause &&
      kind !== SyntaxKind.UsesClause && !isTypeKind(kind);
  }).pop();
}

/** The last declaration child outside its binding name and type annotation. */
export function initOf(
  tree: SyntaxTree,
  node: NodeId,
  nameNode: NodeId | undefined,
): NodeId | undefined {
  return kidsOf(tree, node).filter((child) =>
    child !== nameNode && !isTypeKind(kindOf(tree, child))
  ).pop();
}

const PATTERN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.WildcardPattern,
  SyntaxKind.LiteralPattern,
  SyntaxKind.NamePattern,
  SyntaxKind.CtorPattern,
  SyntaxKind.RecordPattern,
]);

/** True for the syntax kinds of match patterns. */
export function isPatternKind(kind: SyntaxKind): boolean {
  return PATTERN_KINDS.has(kind);
}

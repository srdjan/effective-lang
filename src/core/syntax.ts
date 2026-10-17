// The lossless syntax tree. Node ids are indices into per-file arrays.
// Every token (including newline tokens and the Eof token) is a leaf node, so a
// walk over the leaves in order visits every token once. Trivia stays in the lexer
// tables and the printer emits it in front of its token.

import type { Lexed } from "./lex.ts";
import type { Span } from "./source.ts";

export type NodeId = number;

export type FileMode = "eff" | "effi";

export enum SyntaxKind {
  /** A leaf that wraps one token. */
  Token,
  /** A zero-width leaf where the parser expected a token or a construct. */
  Missing,
  /** A region that the parser could not parse. Its children are token leaves or the nodes of a skipped construct. */
  Error,
  Module,

  // Declarations
  ImportDecl,
  TypeDecl,
  ErrorDecl,
  ServiceDecl,
  ServiceMethod,
  ProviderDecl,
  ConstDecl,
  ParamList,
  Param,
  FailsClause,
  UsesClause,
  ProvidesClause,
  QualifiedName,
  Name,

  // Types
  NamedType,
  TypeArgs,
  LiteralType,
  RecordType,
  FieldType,
  TupleType,
  ArrayType,
  UnionType,
  FunctionType,
  ParenType,

  // Expressions
  LiteralExpr,
  NameExpr,
  ParenExpr,
  ArrowExpr,
  CallExpr,
  ArgList,
  FieldExpr,
  BinaryExpr,
  PipeExpr,
  PipeStage,
  RecordExpr,
  RecordField,
  ShorthandField,
  SpreadField,
  Block,
  IfExpr,
  MatchExpr,
  MatchArm,
  TryExpr,
  CatchClause,
  Handler,

  // Patterns
  WildcardPattern,
  LiteralPattern,
  NamePattern,
  CtorPattern,
  RecordPattern,
  PatternField,
  SpreadPattern,
}

export interface SyntaxTree {
  readonly source: string;
  readonly text: string;
  readonly mode: FileMode;
  readonly lexed: Lexed;
  readonly root: NodeId;
  /** Number of nodes. */
  readonly count: number;
  readonly kinds: Uint8Array;
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
  /** The parent node id, or -1 for the root. */
  readonly parents: Int32Array;
  /** The token index for a Token leaf, or -1. */
  readonly tokens: Int32Array;
  /** Children of node `n` are `children[childStart[n] .. childEnd[n])`. */
  readonly childStart: Uint32Array;
  readonly childEnd: Uint32Array;
  readonly children: Uint32Array;
}

export function kindOf(tree: SyntaxTree, node: NodeId): SyntaxKind {
  return tree.kinds[node] as SyntaxKind;
}

export function kindName(kind: SyntaxKind): string {
  return SyntaxKind[kind] ?? `Kind${kind}`;
}

export function childrenOf(tree: SyntaxTree, node: NodeId): Uint32Array {
  return tree.children.subarray(tree.childStart[node], tree.childEnd[node]);
}

export function nodeSpan(tree: SyntaxTree, node: NodeId): Span {
  return {
    source: tree.source,
    start: tree.starts[node],
    end: tree.ends[node],
  };
}

export function nodeText(tree: SyntaxTree, node: NodeId): string {
  return tree.text.slice(tree.starts[node], tree.ends[node]);
}

/** Pre-order walk. Return `false` from the visitor to skip the children of a node. */
export function walk(
  tree: SyntaxTree,
  node: NodeId,
  visit: (node: NodeId) => boolean | void,
): void {
  const stack: NodeId[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visit(current) === false) continue;
    const kids = childrenOf(tree, current);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** True when the subtree under `node` holds an Error or Missing node. */
export function hasProblem(tree: SyntaxTree, node: NodeId): boolean {
  let found = false;
  walk(tree, node, (n) => {
    const k = kindOf(tree, n);
    if (k === SyntaxKind.Error || k === SyntaxKind.Missing) found = true;
    return !found;
  });
  return found;
}

/** Prints the tree back to text: trivia and token text in tree order. */
export function printTree(tree: SyntaxTree): string {
  const { lexed } = tree;
  const out: string[] = [];
  const stack: NodeId[] = [tree.root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const kind = kindOf(tree, current);
    if (kind === SyntaxKind.Token) {
      const t = tree.tokens[current];
      const firstTrivia = t === 0 ? 0 : lexed.triviaEnd[t - 1];
      for (let k = firstTrivia; k < lexed.triviaEnd[t]; k++) {
        out.push(tree.text.slice(lexed.trivia.starts[k], lexed.trivia.ends[k]));
      }
      out.push(tree.text.slice(lexed.starts[t], lexed.ends[t]));
    } else {
      const kids = childrenOf(tree, current);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  return out.join("");
}

// The declaration index of one file. It lists each top-level declaration by name
// with its kind, export flag, spans, and two content hashes. Later parts use the
// header hash and the body hash to find out what an edit changed.
//
// Header and body. For a const, a type, or an error, the header runs from the
// start of the declaration (the `export` keyword when present) to the end of the
// text before the body. For a const whose value is an arrow, the body is the text
// after `=>` and the header holds the parameter list, the result annotation, and
// the effects. For a type, an error, or a non-arrow const, the body is the text
// after `=`. For a service, the header is `service Name` and the body runs from
// `{` to `}`. A provider has no body: its header is the whole declaration.

import { fnv1a64 } from "./hash.ts";
import { TokenKind } from "./lex.ts";
import type { Span } from "./source.ts";
import { nameTextOf, tokenKindOf } from "./syntax_queries.ts";
import {
  childrenOf,
  decodeString,
  hasProblem,
  kindOf,
  type NodeId,
  nodeSpan,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";

type DeclKind = "type" | "error" | "data" | "service" | "provider" | "const";

export interface MethodEntry {
  readonly name: string;
  /** The ServiceMethod node. */
  readonly node: NodeId;
  readonly nameNode: NodeId;
  readonly nameSpan: Span;
  readonly span: Span;
  /** Hash of the whole method text: a method has a signature and no body. */
  readonly hash: string;
}

export interface DeclEntry {
  readonly name: string;
  readonly kind: DeclKind;
  readonly exported: boolean;
  readonly node: NodeId;
  readonly nameNode: NodeId;
  readonly nameSpan: Span;
  readonly span: Span;
  readonly headerSpan: Span;
  readonly bodySpan: Span;
  readonly headerHash: string;
  readonly bodyHash: string;
  /** Methods by name. The first method wins when a name repeats. Empty unless a service. */
  readonly methods: ReadonlyMap<string, MethodEntry>;
  /** Every method in source order, including repeated names. */
  readonly methodList: readonly MethodEntry[];
  /** True for a const whose value is an arrow expression. */
  readonly isArrow: boolean;
  /** True when the declaration contains an Error or Missing node. */
  readonly broken: boolean;
}

interface ImportName {
  readonly name: string;
  readonly node: NodeId;
  readonly span: Span;
}

export interface ImportEntry {
  readonly node: NodeId;
  readonly span: Span;
  /** The decoded specifier string, or undefined when the string is absent or broken. */
  readonly specifier: string | undefined;
  readonly specifierSpan: Span | undefined;
  readonly names: readonly ImportName[];
}

export interface FileIndex {
  readonly source: string;
  /** Every declaration whose name parsed, in source order. */
  readonly decls: readonly DeclEntry[];
  /** The first declaration for each name. Later declarations of the name are duplicates. */
  readonly byName: ReadonlyMap<string, DeclEntry>;
  readonly imports: readonly ImportEntry[];
}

/** Child nodes that are not tokens or Missing nodes. */
function nodeKids(tree: SyntaxTree, node: NodeId): NodeId[] {
  const result: NodeId[] = [];
  for (const child of childrenOf(tree, node)) {
    const kind = kindOf(tree, child);
    if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
      result.push(child);
    }
  }
  return result;
}

function firstChildOfKind(
  tree: SyntaxTree,
  node: NodeId,
  kind: SyntaxKind,
): NodeId | undefined {
  for (const child of childrenOf(tree, node)) {
    if (kindOf(tree, child) === kind) return child;
  }
  return undefined;
}

function isRealChild(tree: SyntaxTree, child: NodeId): boolean {
  const kind = kindOf(tree, child);
  if (kind === SyntaxKind.Missing) return false;
  return tokenKindOf(tree, child) !== TokenKind.Newline;
}

/**
 * Splits the children of `node` at the first token of `kind`. Returns the end of
 * the last real child up to and including that token, and the child nodes after it.
 */
function splitAfterToken(
  tree: SyntaxTree,
  node: NodeId,
  tokenKind: TokenKind,
): { readonly headerEnd: number; readonly after: NodeId[] } | undefined {
  const children = childrenOf(tree, node);
  for (let i = 0; i < children.length; i++) {
    if (tokenKindOf(tree, children[i]) !== tokenKind) continue;
    const after: NodeId[] = [];
    for (let j = i + 1; j < children.length; j++) {
      const kind = kindOf(tree, children[j]);
      if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
        after.push(children[j]);
      }
    }
    return { headerEnd: tree.ends[children[i]], after };
  }
  return undefined;
}

function lastRealEnd(tree: SyntaxTree, node: NodeId): number {
  let end = tree.starts[node];
  for (const child of childrenOf(tree, node)) {
    if (isRealChild(tree, child)) end = tree.ends[child];
  }
  return end;
}

interface Split {
  readonly headerEnd: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly isArrow: boolean;
}

function emptyBody(at: number, isArrow = false): Split {
  return { headerEnd: at, bodyStart: at, bodyEnd: at, isArrow };
}

/** Header and body offsets for a declaration whose body follows an `=`. */
function splitAtEquals(
  tree: SyntaxTree,
  decl: NodeId,
  allowArrow: boolean,
): Split {
  const split = splitAfterToken(tree, decl, TokenKind.Eq);
  if (split === undefined) return emptyBody(lastRealEnd(tree, decl));
  const body = split.after[0];
  if (body === undefined) return emptyBody(split.headerEnd);
  if (allowArrow && kindOf(tree, body) === SyntaxKind.ArrowExpr) {
    const arrow = splitAfterToken(tree, body, TokenKind.Arrow);
    if (arrow === undefined) {
      const end = lastRealEnd(tree, body);
      return { headerEnd: end, bodyStart: end, bodyEnd: end, isArrow: true };
    }
    const arrowBody = arrow.after[0];
    const headerEnd = headerEndBefore(tree, body, TokenKind.Arrow);
    if (arrowBody === undefined) {
      return emptyBody(headerEnd, true);
    }
    return {
      headerEnd,
      bodyStart: tree.starts[arrowBody],
      bodyEnd: tree.ends[arrowBody],
      isArrow: true,
    };
  }
  return {
    headerEnd: split.headerEnd,
    bodyStart: tree.starts[body],
    bodyEnd: tree.ends[body],
    isArrow: false,
  };
}

/** The end of the last real child before the first token of `tokenKind`. */
function headerEndBefore(
  tree: SyntaxTree,
  node: NodeId,
  tokenKind: TokenKind,
): number {
  let end = tree.starts[node];
  for (const child of childrenOf(tree, node)) {
    if (tokenKindOf(tree, child) === tokenKind) break;
    if (isRealChild(tree, child)) end = tree.ends[child];
  }
  return end;
}

function splitDecl(
  tree: SyntaxTree,
  decl: NodeId,
  kind: DeclKind,
  nameNode: NodeId,
): Split {
  switch (kind) {
    case "const":
      return splitAtEquals(tree, decl, true);
    case "type":
    case "error":
    case "data":
      return splitAtEquals(tree, decl, false);
    case "service": {
      const brace = childrenOf(tree, decl).find((c) =>
        tokenKindOf(tree, c) === TokenKind.LBrace
      );
      if (brace === undefined) return emptyBody(tree.ends[nameNode]);
      return {
        headerEnd: tree.ends[nameNode],
        bodyStart: tree.starts[brace],
        bodyEnd: lastRealEnd(tree, decl),
        isArrow: false,
      };
    }
    case "provider":
      return emptyBody(lastRealEnd(tree, decl));
  }
}

const DECL_KINDS: ReadonlyMap<SyntaxKind, DeclKind> = new Map([
  [SyntaxKind.TypeDecl, "type"],
  [SyntaxKind.ErrorDecl, "error"],
  [SyntaxKind.DataDecl, "data"],
  [SyntaxKind.ServiceDecl, "service"],
  [SyntaxKind.ProviderDecl, "provider"],
  [SyntaxKind.ConstDecl, "const"],
]);

function indexMethods(tree: SyntaxTree, service: NodeId): MethodEntry[] {
  const methods: MethodEntry[] = [];
  for (const child of childrenOf(tree, service)) {
    if (kindOf(tree, child) !== SyntaxKind.ServiceMethod) continue;
    const nameNode = firstChildOfKind(tree, child, SyntaxKind.Name);
    if (nameNode === undefined) continue;
    const name = nameTextOf(tree, nameNode);
    if (name === undefined) continue;
    const span = nodeSpan(tree, child);
    methods.push({
      name,
      node: child,
      nameNode,
      nameSpan: nodeSpan(tree, nameNode),
      span,
      hash: fnv1a64(tree.text.slice(span.start, span.end)),
    });
  }
  return methods;
}

function indexDecl(
  tree: SyntaxTree,
  decl: NodeId,
  kind: DeclKind,
): DeclEntry | undefined {
  const nameNode = firstChildOfKind(tree, decl, SyntaxKind.Name);
  if (nameNode === undefined) return undefined;
  const name = nameTextOf(tree, nameNode);
  if (name === undefined) return undefined;
  const first = childrenOf(tree, decl)[0];
  const exported = tokenKindOf(tree, first) === TokenKind.KwExport;
  const span = nodeSpan(tree, decl);
  const split = splitDecl(tree, decl, kind, nameNode);
  const headerSpan: Span = {
    source: tree.source,
    start: span.start,
    end: Math.max(span.start, split.headerEnd),
  };
  const bodySpan: Span = {
    source: tree.source,
    start: split.bodyStart,
    end: Math.max(split.bodyStart, split.bodyEnd),
  };
  const methodList = kind === "service" ? indexMethods(tree, decl) : [];
  const methods = new Map<string, MethodEntry>();
  for (const method of methodList) {
    if (!methods.has(method.name)) methods.set(method.name, method);
  }
  return {
    name,
    kind,
    exported,
    node: decl,
    nameNode,
    nameSpan: nodeSpan(tree, nameNode),
    span,
    headerSpan,
    bodySpan,
    headerHash: fnv1a64(tree.text.slice(headerSpan.start, headerSpan.end)),
    bodyHash: fnv1a64(tree.text.slice(bodySpan.start, bodySpan.end)),
    methods,
    methodList,
    isArrow: split.isArrow,
    broken: hasProblem(tree, decl),
  };
}

function indexImport(tree: SyntaxTree, node: NodeId): ImportEntry {
  const names: ImportName[] = [];
  let specifier: string | undefined;
  let specifierSpan: Span | undefined;
  for (const child of childrenOf(tree, node)) {
    const kind = kindOf(tree, child);
    if (kind === SyntaxKind.Name) {
      const name = nameTextOf(tree, child);
      if (name !== undefined) {
        names.push({ name, node: child, span: nodeSpan(tree, child) });
      }
    } else if (tokenKindOf(tree, child) === TokenKind.String) {
      specifierSpan = nodeSpan(tree, child);
      specifier = decodeString(
        tree.text.slice(tree.starts[child], tree.ends[child]),
      );
    }
  }
  return {
    node,
    span: nodeSpan(tree, node),
    specifier,
    specifierSpan,
    names,
  };
}

/** Builds the declaration index of a parsed file. */
export function buildIndex(tree: SyntaxTree): FileIndex {
  const decls: DeclEntry[] = [];
  const byName = new Map<string, DeclEntry>();
  const imports: ImportEntry[] = [];
  for (const child of nodeKids(tree, tree.root)) {
    const kind = kindOf(tree, child);
    if (kind === SyntaxKind.ImportDecl) {
      imports.push(indexImport(tree, child));
      continue;
    }
    const declKind = DECL_KINDS.get(kind);
    if (declKind === undefined) continue;
    const entry = indexDecl(tree, child, declKind);
    if (entry === undefined) continue;
    decls.push(entry);
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return { source: tree.source, decls, byName, imports };
}

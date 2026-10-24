// Resolver identities and declaration anchors shared by editor queries. The
// cache belongs to a Revision; retaining a Program does not retain old indices.
import type { Revision } from "./db.ts";
import { methodOfCapability, serviceOfCapability } from "./ids.ts";
import { type Target, targetText } from "./resolve.ts";
import type { Span } from "./source.ts";
import {
  childrenOf,
  kindOf,
  type NodeId,
  nodeSpan,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";

export interface SymbolOccurrence {
  readonly identity: string;
  readonly target: Target;
  readonly span: Span;
  readonly declaration: Span | undefined;
  readonly isDeclaration: boolean;
  readonly node: NodeId;
  readonly shorthand: boolean;
}

export interface LocalScope {
  readonly identity: string;
  readonly name: string;
  readonly declaration: Span;
  readonly scope: Span;
  readonly parameter: boolean;
}

export interface SymbolIndex {
  readonly occurrences: readonly SymbolOccurrence[];
  readonly byIdentity: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  readonly byPath: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  readonly locals: ReadonlyMap<string, readonly LocalScope[]>;
}

export function sameSpan(a: Span | undefined, b: Span | undefined): boolean {
  return a !== undefined && b !== undefined && a.source === b.source &&
    a.start === b.start && a.end === b.end;
}

export function declarationOf(
  revision: Revision,
  module: string,
  target: Target,
): Span | undefined {
  if (target.kind === "local") {
    return revision.resolution(module)?.locals.get(target.id);
  }
  if (!("id" in target)) return undefined;
  const id = target.kind === "cap" ? serviceOfCapability(target.id) : target.id;
  if (id === undefined) return undefined;
  const entry = revision.declEntry(id);
  return target.kind === "cap"
    ? entry?.methods.get(methodOfCapability(target.id) ?? "")?.nameSpan
    : entry?.nameSpan;
}

function localScope(
  tree: SyntaxTree,
  node: NodeId,
  identity: string,
): LocalScope {
  let parent = tree.parents[node];
  const binding = parent >= 0 &&
      [SyntaxKind.BindingField, SyntaxKind.ShorthandBinding].includes(
        kindOf(tree, parent),
      )
    ? tree.parents[tree.parents[parent]]
    : -1;
  const parameter = parent >= 0 && kindOf(tree, parent) === SyntaxKind.Param;
  while (
    parent >= 0 &&
    ![
      SyntaxKind.UsingExpr,
      SyntaxKind.ArrowExpr,
      SyntaxKind.Block,
      SyntaxKind.MatchArm,
      SyntaxKind.Handler,
    ].includes(kindOf(tree, parent))
  ) parent = tree.parents[parent];
  return {
    identity,
    name: tree.text.slice(tree.starts[node], tree.ends[node]),
    declaration: nodeSpan(tree, node),
    scope: parent >= 0
      ? {
        ...nodeSpan(tree, parent),
        start: binding >= 0 ? tree.ends[binding] : tree.starts[parent],
      }
      : nodeSpan(tree, tree.root),
    parameter,
  };
}

const indices = new WeakMap<Revision, SymbolIndex>();

export function symbolIndex(revision: Revision): SymbolIndex {
  const cached = indices.get(revision);
  if (cached !== undefined) return cached;
  const occurrences: SymbolOccurrence[] = [];
  const byIdentity = new Map<string, SymbolOccurrence[]>();
  const byPath = new Map<string, SymbolOccurrence[]>();
  const locals = new Map<string, LocalScope[]>();
  for (const info of revision.moduleInfos()) {
    const module = info.name;
    const resolution = revision.resolution(module);
    if (resolution === undefined) continue;
    const tree = info.tree;
    const file: SymbolOccurrence[] = [];
    const scopes: LocalScope[] = [];
    const seen = new Set<string>();
    for (const [node, target] of resolution.targets) {
      const span = nodeSpan(tree, node);
      const text = tree.text.slice(span.start, span.end);
      // FieldExpr/QualifiedName also carry capability identities. Their Name
      // children own the editable token; never edit the entire S.method span.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) continue;
      const identity = targetText(target);
      const key = `${span.start}:${span.end}:${identity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const declaration = declarationOf(revision, module, target);
      const isDeclaration = sameSpan(span, declaration);
      const parent = tree.parents[node];
      const occurrence: SymbolOccurrence = {
        identity,
        target,
        span,
        declaration,
        isDeclaration,
        node,
        shorthand: parent >= 0 &&
          [SyntaxKind.ShorthandField, SyntaxKind.ShorthandBinding].includes(
            kindOf(tree, parent),
          ),
      };
      occurrences.push(occurrence);
      file.push(occurrence);
      const group = byIdentity.get(identity) ?? [];
      group.push(occurrence);
      byIdentity.set(identity, group);
      if (isDeclaration && target.kind === "local") {
        const local = localScope(tree, node, identity);
        if (parent >= 0 && kindOf(tree, parent) === SyntaxKind.UsingExpr) {
          for (const region of childrenOf(tree, parent)) {
            if (
              [SyntaxKind.ResourceUse, SyntaxKind.ResourceRelease].includes(
                kindOf(tree, region),
              )
            ) {
              scopes.push({
                ...local,
                scope: nodeSpan(tree, region),
                parameter: true,
              });
            }
          }
        } else scopes.push(local);
      }
    }
    file.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    byPath.set(info.path, file);
    locals.set(info.path, scopes);
  }
  occurrences.sort((a, b) =>
    a.span.source.localeCompare(b.span.source) || a.span.start - b.span.start
  );
  const result = { occurrences, byIdentity, byPath, locals };
  indices.set(revision, result);
  return result;
}

export function occurrenceAt(
  revision: Revision,
  path: string,
  offset: number,
): SymbolOccurrence | undefined {
  const file = symbolIndex(revision).byPath.get(path) ?? [];
  return file.find((o) => o.span.start <= offset && offset < o.span.end) ??
    file.find((o) => o.span.end === offset && o.span.start < offset);
}

export function referencesAt(
  revision: Revision,
  path: string,
  offset: number,
  includeDeclaration = true,
): readonly Span[] {
  const hit = occurrenceAt(revision, path, offset);
  if (hit?.declaration === undefined || hit.target.kind === "field") return [];
  return (symbolIndex(revision).byIdentity.get(hit.identity) ?? []).filter(
    (o) => includeDeclaration || !o.isDeclaration,
  ).map((o) => o.span);
}

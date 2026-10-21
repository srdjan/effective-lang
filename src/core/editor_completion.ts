import { isErrorId, isTypeId } from "./ids.ts";
import { TokenKind } from "./lex.ts";
import type { Revision } from "./db.ts";
import { declarationOf, occurrenceAt, symbolIndex } from "./editor_index.ts";
import { isTypeKind } from "./index.ts";
import { BUILTIN_TYPE_NAMES, PRELUDE_NAMES } from "./resolve.ts";
import type { Span } from "./source.ts";
import { kindOf, type NodeId, SyntaxKind, type SyntaxTree } from "./syntax.ts";
import type { TypeRef } from "./types.ts";

export interface Completion {
  readonly label: string;
  readonly kind:
    | "variable"
    | "function"
    | "type"
    | "class"
    | "interface"
    | "method"
    | "property";
  readonly span: Span;
}

function containingNode(tree: SyntaxTree, offset: number): NodeId {
  let best = tree.root;
  for (let n = 0; n < tree.count; n++) {
    if (
      tree.starts[n] <= offset && offset <= tree.ends[n] &&
      tree.ends[n] - tree.starts[n] <= tree.ends[best] - tree.starts[best]
    ) best = n;
  }
  return best;
}

function recordFields(
  revision: Revision,
  ref: TypeRef,
  seen = new Set<TypeRef>(),
): readonly string[] {
  if (seen.has(ref)) return [];
  const table = revision.checked.table;
  const node = table.node(ref);
  if (node.kind === "record") return node.fields.map((f) => f.name);
  if (node.kind === "named") {
    const target = isTypeId(node.id)
      ? table.aliasOf(node.id) ?? table.brandBaseOf(node.id)
      : isErrorId(node.id)
      ? table.errorRecordOf(node.id)
      : undefined;
    return target === undefined
      ? []
      : recordFields(revision, target, new Set([...seen, ref]));
  }
  if (node.kind === "union") {
    const fields = node.members.map((t) =>
      recordFields(revision, t, new Set([...seen, ref]))
    );
    return (fields[0] ?? []).filter((name) =>
      fields.every((f) => f.includes(name))
    );
  }
  return [];
}

/** Visible names, filtered by context and prefix. No automatic import edits. */
export function completionsAt(
  revision: Revision,
  path: string,
  offset: number,
): readonly Completion[] {
  const info = [...revision.project.modules.values()].find((m) =>
    m.path === path
  );
  if (info === undefined || offset < 0 || offset > info.tree.text.length) {
    return [];
  }
  const { tree } = info;
  // A comment/string is never a code-completion context.
  const { lexed } = tree;
  if (
    [...lexed.trivia.starts].some((start, i) =>
      start <= offset && offset < lexed.trivia.ends[i] &&
      lexed.trivia.kinds[i] !== 0
    )
  ) return [];
  if (
    [...lexed.starts].some((start, i) =>
      start < offset && offset <= lexed.ends[i] &&
      lexed.kinds[i] === TokenKind.String
    )
  ) return [];
  const text = tree.text;
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start--;
  const prefix = text.slice(start, offset);
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++;
  const span = { source: path, start, end };
  const make = (label: string, kind: Completion["kind"]): Completion => ({
    label,
    kind,
    span,
  });
  const filter = (values: readonly Completion[]) =>
    values.filter((v) => v.label.startsWith(prefix)).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  if (text[start - 1] === ".") {
    const baseEnd = start - 1;
    const baseOccurrence = occurrenceAt(revision, path, baseEnd);
    if (baseOccurrence?.target.kind === "service") {
      // The resolver's namespace contains imported service declarations too.
      const binding = revision.checked.analysis.resolutions.get(info.name)
        ?.namespace.get(
          text.slice(baseOccurrence.span.start, baseOccurrence.span.end),
        );
      const methods = binding?.service?.entry.methodList ?? [];
      return filter(methods.map((m) => make(m.name, "method")));
    }
    const checked = revision.checked.modules.get(info.name);
    const fields = new Set<string>();
    const tables = [
      ...[...(checked?.functions.values() ?? [])].map((f) => f.table),
      ...[...(checked?.constants.values() ?? [])].map((c) => c.table),
    ];
    for (const table of tables) {
      for (const [node, nodeInfo] of table.info) {
        if (
          tree.ends[node] !== baseEnd || kindOf(tree, node) === SyntaxKind.Token
        ) continue;
        for (const name of recordFields(revision, nodeInfo.type)) {
          fields.add(name);
        }
      }
    }
    return filter([...fields].map((name) => make(name, "property")));
  }
  let node = containingNode(tree, start);
  let context: "value" | "type" | "fails" | "uses" = "value";
  while (node >= 0) {
    const kind = kindOf(tree, node);
    if (kind === SyntaxKind.FailsClause) {
      context = "fails";
      break;
    }
    if (kind === SyntaxKind.UsesClause || kind === SyntaxKind.ProvidesClause) {
      context = "uses";
      break;
    }
    if (isTypeKind(kind)) {
      context = "type";
      break;
    }
    node = tree.parents[node];
  }
  const values = new Map<string, Completion>();
  const namespace = revision.checked.analysis.resolutions.get(info.name)
    ?.namespace;
  for (const [name, binding] of namespace ?? []) {
    const kind = binding.target.kind;
    if (context === "type" && kind !== "type" && kind !== "error") continue;
    if (context === "fails" && kind !== "error") continue;
    if (context === "uses" && kind !== "service") continue;
    if (context === "value" && kind === "service") continue;
    const origin = declarationOf(revision, info.name, binding.target);
    const declaration = origin === undefined
      ? undefined
      : [...revision.project.modules.values()].find((m) =>
        m.path === origin.source
      )?.index.decls.find((d) => d.nameSpan.start === origin.start);
    values.set(
      name,
      make(
        name,
        kind === "type"
          ? "type"
          : kind === "error"
          ? "class"
          : kind === "service"
          ? "interface"
          : declaration?.isArrow
          ? "function"
          : "variable",
      ),
    );
  }
  if (context === "value") {
    const locals = (symbolIndex(revision).locals.get(path) ?? []).filter((l) =>
      l.scope.start <= offset && offset <= l.scope.end &&
      (l.parameter || l.declaration.end <= start)
    ).sort((a, b) =>
      (b.scope.end - b.scope.start) - (a.scope.end - a.scope.start)
    );
    for (const local of locals) {
      values.set(local.name, make(local.name, "variable"));
    }
    for (const name of PRELUDE_NAMES) {
      if (!values.has(name)) values.set(name, make(name, "function"));
    }
  } else if (context === "type") {
    for (
      const name of [
        ...BUILTIN_TYPE_NAMES,
        "Effect",
        "Stream",
        "Sink",
        "Schema",
        "Layer",
        "SchemaError",
        "SchemaIssue",
      ]
    ) if (!values.has(name)) values.set(name, make(name, "type"));
  } else if (context === "fails") {
    for (const name of ["SchemaError", "SchemaIssue"]) {
      values.set(name, make(name, "class"));
    }
  }
  return filter([...values.values()]);
}

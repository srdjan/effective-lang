// Traversals of the typed IR that the emitter shares: children, binders, and
// the references of a declaration.

import type {
  Declaration,
  Expr,
  LocalId,
  Parameter,
  Pattern,
  ValueId,
} from "../ir.ts";

/** The direct sub-expressions of `expr`, in evaluation order. */
export function childrenOf(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "literal":
    case "reference":
    case "none":
      return [];
    case "record":
    case "error":
      return expr.fields.map((f) => f.value);
    case "update":
      return [expr.record, ...expr.fields.map((f) => f.value)];
    case "array":
    case "tuple":
      return [...expr.elements];
    case "get":
      return [expr.record];
    case "brand":
    case "unbrand":
    case "some":
    case "run":
    case "scoped":
      return [expr.value];
    case "closure":
      return [expr.body];
    case "defer":
    case "fork-scoped":
      return [expr.job];
    case "with-resource":
      return [expr.acquire, expr.use, expr.release];
    case "unfold":
      return [expr.seed, expr.next];
    case "map-effect":
    case "flat-map-streams":
      return [expr.stream, expr.transform];
    case "sink-for-each":
      return [expr.consume];
    case "run-stream":
      return [expr.stream, expr.sink];
    case "buffer-stream":
      return [expr.stream];
    case "merge-streams":
    case "zip-streams":
    case "concat-streams":
      return [expr.left, expr.right];
    case "race":
      return [expr.left, expr.right];
    case "make-ref":
      return [expr.value];
    case "get-ref":
      return [expr.ref];
    case "set-ref":
      return [expr.ref, expr.value];
    case "update-ref":
      return [expr.ref, expr.transform];
    case "layer":
      return [expr.acquire];
    case "merge-layers":
      return [expr.left, expr.right];
    case "retry-schedule":
      return [expr.step];
    case "retry-with-schedule":
      return [expr.job, expr.options];
    case "codec":
      return [expr.decode, expr.encode];
    case "decode":
    case "encode":
      return [expr.codec, expr.input];
    case "with-fiber":
      return [expr.job, expr.use];
    case "join-fiber":
    case "interrupt-fiber":
      return [expr.fiber];
    case "call":
      return [expr.callee, ...expr.arguments];
    case "perform":
      return [...expr.arguments];
    case "block":
      return [...expr.steps.map((s) => s.value), expr.result];
    case "if":
      return [expr.condition, expr.then, expr.else];
    case "match":
      return [expr.subject, ...expr.arms.map((a) => a.body)];
    case "fail":
      return [expr.error];
    case "catch":
      return [expr.body, ...expr.handlers.map((h) => h.body)];
    case "retry":
      return [expr.job];
    case "provide":
      return [expr.provider, expr.job];
    case "binary":
      return [expr.left, expr.right];
  }
}

export function patternBinding(pattern: Pattern): Parameter | null {
  switch (pattern.kind) {
    case "some":
    case "error":
      return pattern.binding;
    case "tag":
      return pattern.binding;
    case "wildcard":
    case "literal":
    case "none":
      return null;
  }
}

/** The binders that `expr` itself introduces (not those of its children). */
export function bindersOf(expr: Expr): Parameter[] {
  switch (expr.kind) {
    case "closure":
      return [...expr.parameters];
    case "block":
      return expr.steps.flatMap((s) => s.kind === "bind" ? [s.binding] : []);
    case "match":
      return expr.arms.flatMap((a) => {
        const binding = patternBinding(a.pattern);
        return binding === null ? [] : [binding];
      });
    case "catch":
      return expr.handlers.map((h) => h.binding);
    default:
      return [];
  }
}

/** Calls `visit` on `expr` and on every expression below it, parents first. */
export function walkExpr(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  for (const child of childrenOf(expr)) walkExpr(child, visit);
}

/** The body expression of a function or the value of a constant. */
export function rootOf(declaration: Declaration): Expr | undefined {
  switch (declaration.kind) {
    case "function":
      return declaration.body;
    case "constant":
      return declaration.value;
    default:
      return undefined;
  }
}

/** Calls `visit` for each local binder of a declaration: parameters and inner binders. */
export function collectBinderNames(
  declaration: Declaration,
  visit: (id: LocalId, name: string) => void,
): void {
  if (declaration.kind === "function") {
    for (const p of declaration.parameters) visit(p.id, p.name);
  }
  const root = rootOf(declaration);
  if (root === undefined) return;
  walkExpr(root, (e) => {
    for (const binder of bindersOf(e)) visit(binder.id, binder.name);
  });
}

/** The module-level values that a declaration refers to, without duplicates. */
export function valueReferences(declaration: Declaration): ValueId[] {
  const root = rootOf(declaration);
  if (root === undefined) return [];
  const found = new Set<ValueId>();
  walkExpr(root, (e) => {
    if (e.kind === "reference" && e.target.startsWith("value:")) {
      found.add(e.target as ValueId);
    }
  });
  return [...found];
}

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
import { childrenOf } from "./shape.ts";
import { isValueId } from "../ids.ts";

export function patternBinding(pattern: Pattern): Parameter | null {
  switch (pattern.kind) {
    case "some":
    case "error":
    case "nominal":
      return pattern.binding;
    case "tag":
      return pattern.binding;
    case "wildcard":
    case "literal":
    case "none":
      return null;
    default: {
      const unreachable: never = pattern;
      return unreachable;
    }
  }
}

/** The binders that `expr` itself introduces (not those of its children). */
function bindersOf(expr: Expr): Parameter[] {
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
    if (e.kind === "reference" && isValueId(e.target)) {
      found.add(e.target);
    }
  });
  return [...found];
}

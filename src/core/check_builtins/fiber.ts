// Fiber operations and the lifetime of an inline fiber borrow.
import type { LocalId } from "../ir.ts";
import { kindOf, type NodeId, SyntaxKind } from "../syntax.ts";
import {
  combine,
  EFFECT_ONLY,
  type EffectSet,
  type NodeInfo,
} from "../tables.ts";
import { dataOnly, type TypeRef } from "../types.ts";
import {
  type Arg,
  type BuiltinContext,
  type FactView,
  invocationOf,
  type LocalUseView,
  type ResolveView,
  type SyntaxView,
} from "./context.ts";

export interface FiberContext extends
  Pick<
    BuiltinContext,
    | "table"
    | "argInfo"
    | "callback"
    | "finish"
    | "functionOf"
    | "isError"
    | "report"
  >,
  SyntaxView,
  ResolveView,
  FactView,
  LocalUseView {}

export function withFiberCall(
  c: FiberContext,
  node: NodeId,
  args: readonly Arg[],
  expected: TypeRef | undefined,
): NodeInfo {
  const job = c.argInfo(args[0]);
  const effect = c.table.node(c.table.unfold(job.type));
  if (effect.kind !== "effect") {
    c.report(
      "type-mismatch/010",
      "`withFiber` needs an Effect value",
      args[0].node,
    );
    return c.finish(
      node,
      c.table.error,
      combine([job, c.argInfo(args[1]), EFFECT_ONLY]),
    );
  }
  if (
    args[1].pre !== undefined ||
    kindOf(c.tree, args[1].node) !== SyntaxKind.ArrowExpr
  ) {
    c.report(
      "type-mismatch/010",
      "`withFiber` needs an inline use callback",
      args[1].node,
    );
  }
  const fiber = c.table.fiber(effect.result, effect.failures);
  const use = c.callback("withFiber", args[1], [fiber], expected, true);
  if (!dataOnly(c.table, use.result, "value")) {
    c.report(
      "type-mismatch/010",
      "the fiber use result must be data only",
      args[1].node,
    );
  }
  const fact = c.facts.get(args[1].node);
  if (fact?.kind === "arrow" && fact.parameters[0]?.id !== undefined) {
    const body = c.kids(args[1].node).at(-1);
    if (body !== undefined) {
      scopedFiberUses(c, body, fact.parameters[0].id);
    }
  }
  const useFn = c.functionOf(use.info.type);
  const invocation: EffectSet = invocationOf(useFn);
  return c.finish(
    node,
    use.result,
    combine([
      job,
      use.info,
      { failures: [], requirements: effect.requirements, mode: "effect" },
      invocation,
      EFFECT_ONLY,
    ]),
  );
}

export function fiberOperation(
  c: FiberContext,
  node: NodeId,
  name: "joinFiber" | "interruptFiber",
  args: readonly Arg[],
): NodeInfo {
  const ref = c.argInfo(args[0]);
  const fiber = c.table.node(c.table.unfold(ref.type));
  if (fiber.kind !== "fiber") {
    if (!c.isError(ref.type)) {
      c.report(
        "type-mismatch/010",
        `\`${name}\` needs a Fiber value`,
        args[0].node,
      );
    }
    return c.finish(node, c.table.error, combine([ref, EFFECT_ONLY]));
  }
  return c.finish(
    node,
    name === "joinFiber" ? fiber.result : c.table.unit,
    combine([
      ref,
      name === "joinFiber"
        ? { failures: fiber.failures, requirements: [], mode: "effect" }
        : EFFECT_ONLY,
    ]),
  );
}

function scopedFiberUses(c: FiberContext, body: NodeId, id: LocalId): void {
  for (const { node, parent, grandparent, nested } of c.localUses(body, id)) {
    const call = parent !== undefined &&
        kindOf(c.tree, parent) === SyntaxKind.CallExpr
      ? parent
      : parent !== undefined &&
          kindOf(c.tree, parent) === SyntaxKind.ArgList &&
          grandparent !== undefined &&
          kindOf(c.tree, grandparent) === SyntaxKind.CallExpr
      ? grandparent
      : undefined;
    const callee = call === undefined ? undefined : c.kids(call)[0];
    const called = callee === undefined ? undefined : c.targets.get(callee);
    if (
      nested || callee === undefined ||
      (parent !== call &&
        (parent === undefined || c.kids(parent).length !== 1 ||
          c.kids(parent)[0] !== node)) ||
      called?.kind !== "builtin" ||
      (called.name !== "joinFiber" && called.name !== "interruptFiber")
    ) {
      c.report(
        "type-mismatch/010",
        "a borrowed fiber may only be joined or interrupted directly",
        node,
      );
    }
  }
}

// Layer construction, composition and provision checking.
import type { TypeEnv } from "../check.ts";
import { serviceOfCapability } from "../ids.ts";
import type { ServiceId, ValueId } from "../ir.ts";
import type { Target } from "../resolve.ts";
import { kindOf, type NodeId, SyntaxKind, type SyntaxTree } from "../syntax.ts";
import {
  combine,
  EFFECT_ONLY,
  type EffectSet,
  type NodeFact,
  type NodeInfo,
  PURE_EFFECTS,
  without,
} from "../tables.ts";
import type { Arg, BuiltinContext, FunctionNode } from "./context.ts";
export interface LayerContext extends
  Pick<
    BuiltinContext,
    "table" | "argInfo" | "finish" | "isError" | "report"
  > {
  readonly tree: SyntaxTree;
  readonly targets: ReadonlyMap<NodeId, Target>;
  readonly services: Pick<TypeEnv["services"], "get">;
  fact(node: NodeId, fact: NodeFact): void;
  jobFunction(name: string, arg: Arg, info: NodeInfo): FunctionNode | undefined;
}

export function provideCall(
  c: LayerContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const providerInfo = c.argInfo(args[0]);
  const job = c.argInfo(args[1]);
  const providerNode = kindOf(c.tree, args[0].node) === SyntaxKind.NameExpr
    ? args[0].node
    : undefined;
  const target = providerNode === undefined
    ? undefined
    : c.targets.get(providerNode);
  const providerType = c.table.node(c.table.unfold(providerInfo.type));
  let provider: ValueId | undefined;
  if (target?.kind === "provider" && providerType.kind === "provider") {
    provider = target.id;
  } else if (
    providerType.kind !== "provider" && !c.isError(providerInfo.type)
  ) {
    c.report(
      "type-mismatch/010",
      "`provide` needs a Layer value",
      args[0].node,
    );
  }
  c.fact(node, { kind: "provide", provider });
  const fn = c.jobFunction("provide", args[1], job);
  const construction = combine([providerInfo, job]);
  const supplied = providerType.kind === "provider"
    ? providerType.provides
    : [];
  const acquisition: EffectSet = providerType.kind === "provider"
    ? {
      failures: providerType.failures,
      requirements: providerType.requirements,
      mode: "effect",
    }
    : PURE_EFFECTS;
  const invocation: EffectSet = fn === undefined ? PURE_EFFECTS : {
    failures: fn.failures,
    requirements: without(fn.requirements, supplied),
    mode: fn.execution,
  };
  return c.finish(
    node,
    fn?.result ?? c.table.error,
    combine([construction, invocation, acquisition, EFFECT_ONLY]),
  );
}

export function layerCall(
  c: LayerContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const target = kindOf(c.tree, args[0].node) === SyntaxKind.NameExpr
    ? c.targets.get(args[0].node)
    : undefined;
  const service: ServiceId | undefined = target?.kind === "service"
    ? target.id
    : undefined;
  c.fact(node, { kind: "layer", service });
  if (service === undefined) {
    c.report(
      "type-mismatch/010",
      "`layer` needs a declared service name",
      args[0].node,
    );
  }
  if (kindOf(c.tree, args[1].node) !== SyntaxKind.ArrowExpr) {
    c.report(
      "type-mismatch/010",
      "`layer` needs an inline acquisition callback",
      args[1].node,
    );
  }
  const acquire = c.argInfo(args[1]);
  const fn = c.jobFunction("layer", args[1], acquire);
  const declaration = service === undefined
    ? undefined
    : c.services.get(service);
  const implementation = fn === undefined
    ? undefined
    : c.table.node(c.table.unfold(fn.result));
  if (declaration !== undefined && implementation?.kind === "record") {
    if (implementation.fields.length !== declaration.methods.length) {
      c.report(
        "type-mismatch/010",
        "`layer` must implement exactly the service methods",
        args[1].node,
      );
    }
    for (const method of declaration.methods) {
      const field = implementation.fields.find((f) => f.name === method.name);
      if (
        field === undefined || field.optional ||
        !c.table.isAssignable(field.type, c.table.fromIr(method.type))
      ) {
        c.report(
          "type-mismatch/010",
          `\`layer\` method ${method.name} does not fit its service contract`,
          args[1].node,
        );
      }
    }
  } else if (fn !== undefined) {
    c.report(
      "type-mismatch/010",
      "`layer` acquisition must return a service method record",
      args[1].node,
    );
  }
  const provides = declaration?.methods.map((m) => m.id) ?? [];
  if (fn?.requirements.some((r) => provides.includes(r))) {
    c.report(
      "type-mismatch/010",
      "`layer` acquisition cannot require a method it provides",
      args[1].node,
    );
  }
  const type = c.table.provider({
    provides,
    execution: "effect",
    failures: fn?.failures ?? [],
    requirements: fn?.requirements ?? [],
  });
  return c.finish(node, type, acquire);
}

export function mergeLayersCall(
  c: LayerContext,
  node: NodeId,
  args: readonly Arg[],
): NodeInfo {
  const left = c.argInfo(args[0]);
  const right = c.argInfo(args[1]);
  const a = c.table.node(c.table.unfold(left.type));
  const b = c.table.node(c.table.unfold(right.type));
  if (a.kind !== "provider" || b.kind !== "provider") {
    c.report("type-mismatch/010", "`mergeLayers` needs two Layer values", node);
    return c.finish(node, c.table.error, combine([left, right]));
  }
  const services = new Set(a.provides.map(serviceOfCapability));
  if (b.provides.some((id) => services.has(serviceOfCapability(id)))) {
    c.report(
      "type-mismatch/010",
      "`mergeLayers` cannot provide one service twice",
      node,
    );
  }
  const type = c.table.provider({
    provides: [...a.provides, ...b.provides],
    execution: "effect",
    failures: [...a.failures, ...b.failures],
    requirements: [...a.requirements, ...b.requirements],
  });
  return c.finish(node, type, combine([left, right]));
}

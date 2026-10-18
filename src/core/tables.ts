// The side tables of body checking (plan section 7). For each declaration body
// the checker records, per syntax node, the type, the active failure and
// requirement sets, and the execution mode. It also records the facts that
// lowering (part A4) needs and cannot read from the tree alone: which kind of
// call a call node is, which pattern kind a pattern node is, and so on.
//
// All sets are sorted and unique. The mode is `effect` whenever a set is
// nonempty (spec, "Execution order and mode").

import type {
  CapabilityId,
  ErrorId,
  Execution,
  FunctionType,
  LocalId,
  ServiceId,
  TypeId,
  ValueId,
} from "./ir.ts";
import type { NodeId } from "./syntax.ts";
import { sortedUnique, type TypeRef } from "./types.ts";

/** The effects of one evaluation: failures, requirements, and the mode. */
export interface EffectSet {
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  readonly mode: Execution;
}

/** What the checker records for one syntax node. */
export interface NodeInfo extends EffectSet {
  readonly type: TypeRef;
}

export const PURE_EFFECTS: EffectSet = {
  failures: [],
  requirements: [],
  mode: "pure",
};

export const EFFECT_ONLY: EffectSet = {
  failures: [],
  requirements: [],
  mode: "effect",
};

/**
 * The union of several evaluations. The mode is `effect` when any part is
 * effect or when a set is nonempty.
 */
export function combine(parts: readonly EffectSet[]): EffectSet {
  const failures: ErrorId[] = [];
  const requirements: CapabilityId[] = [];
  let effect = false;
  for (const part of parts) {
    failures.push(...part.failures);
    requirements.push(...part.requirements);
    if (part.mode === "effect") effect = true;
  }
  const f = sortedUnique(failures);
  const r = sortedUnique(requirements);
  return {
    failures: f,
    requirements: r,
    mode: effect || f.length > 0 || r.length > 0 ? "effect" : "pure",
  };
}

/** Items of `items` that are not in `removed`, in their order. */
export function without<T extends string>(
  items: readonly T[],
  removed: readonly string[],
): T[] {
  const set = new Set<string>(removed);
  return items.filter((item) => !set.has(item));
}

/** What a pattern node means, for lowering. */
export type PatternFact =
  | { readonly kind: "wildcard" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "none" }
  | { readonly kind: "some"; readonly binding: LocalId | undefined }
  | {
    readonly kind: "error";
    readonly error: ErrorId;
    readonly binding: LocalId | undefined;
  }
  | {
    readonly kind: "tag";
    readonly field: string;
    readonly value: string;
    readonly binding: LocalId | null;
  }
  /** A pattern that a diagnostic already rejected. */
  | { readonly kind: "invalid" };

export interface ArrowParameterFact {
  readonly id: LocalId | undefined;
  readonly name: string;
  readonly type: TypeRef;
}

/** What a node means, for lowering. The key is the syntax node id. */
export type NodeFact =
  /** An ordinary call of a function value. Also a pipeline stage that calls one. */
  | { readonly kind: "call" }
  /** A service operation: `S.m(args)` or a stage `x |> S.m`. */
  | { readonly kind: "perform"; readonly capability: CapabilityId }
  | { readonly kind: "error-construction"; readonly error: ErrorId }
  | { readonly kind: "brand-construction"; readonly brand: TypeId }
  | { readonly kind: "unbrand" }
  | { readonly kind: "some" }
  | { readonly kind: "none" }
  | { readonly kind: "fail" }
  | { readonly kind: "retry"; readonly times: number | undefined }
  | { readonly kind: "provide"; readonly provider: ValueId | undefined }
  | { readonly kind: "defer" }
  | { readonly kind: "run" }
  | { readonly kind: "scoped" | "fork-scoped" }
  | { readonly kind: "with-resource" }
  | { readonly kind: "unfold" }
  | { readonly kind: "map-effect" }
  | { readonly kind: "map-stream" }
  | { readonly kind: "scan-stream" }
  | { readonly kind: "map-accum-stream" }
  | { readonly kind: "fold-stream" }
  | { readonly kind: "flat-map-streams" }
  | { readonly kind: "take-stream" }
  | { readonly kind: "drop-stream" }
  | { readonly kind: "drop-while-stream" }
  | { readonly kind: "filter-stream" }
  | { readonly kind: "take-while-stream" }
  | { readonly kind: "take-until-stream" }
  | {
    readonly kind: "partition-all";
    readonly concurrency: number | "unbounded" | undefined;
  }
  | {
    readonly kind: "validate-all";
    readonly concurrency: number | "unbounded" | undefined;
  }
  | {
    readonly kind: "all-results";
    readonly concurrency: number | "unbounded" | undefined;
  }
  | { readonly kind: "sink-for-each" }
  | { readonly kind: "run-stream" }
  | { readonly kind: "buffer-stream"; readonly capacity: number | undefined }
  | { readonly kind: "merge-streams" }
  | { readonly kind: "zip-streams" }
  | { readonly kind: "concat-streams" }
  | { readonly kind: "race" }
  | { readonly kind: "make-ref" | "get-ref" | "set-ref" | "update-ref" }
  | { readonly kind: "layer"; readonly service: ServiceId | undefined }
  | { readonly kind: "merge-layers" }
  | { readonly kind: "retry-schedule" | "retry-with-schedule" }
  | { readonly kind: "codec" | "decode" | "encode" }
  | { readonly kind: "with-fiber" | "join-fiber" | "interrupt-fiber" }
  /** A bracket literal, classified by its checked contextual type. */
  | { readonly kind: "list"; readonly shape: "array" | "tuple" }
  /** A collection builtin with its closed function type. */
  | {
    readonly kind: "builtin";
    readonly name: "map" | "filter" | "fold" | "all" | "traverse";
    readonly specialized: TypeRef;
    readonly ir: FunctionType;
  }
  /** A field read. `optional` is true when the field is optional and the read is `Option<T>`. */
  | {
    readonly kind: "field";
    readonly name: string;
    readonly optional: boolean;
  }
  | {
    readonly kind: "arrow";
    readonly parameters: readonly ArrowParameterFact[];
    readonly contract: "explicit" | "inferred";
  }
  /** A block `const`. */
  | {
    readonly kind: "binding";
    readonly id: LocalId | undefined;
    readonly type: TypeRef;
  }
  | { readonly kind: "pattern"; readonly pattern: PatternFact }
  | {
    readonly kind: "handler";
    readonly error: ErrorId | undefined;
    readonly binding: LocalId | undefined;
  };

/** The side tables of one declaration body. */
export interface BodyTable {
  readonly declaration: ValueId;
  /** Syntax node id to type, sets, and mode. */
  readonly info: Map<NodeId, NodeInfo>;
  /** Syntax node id to what lowering needs. */
  readonly facts: Map<NodeId, NodeFact>;
  /** The type of each parameter, block binding, and pattern binding. */
  readonly locals: Map<LocalId, TypeRef>;
}

export function newBodyTable(declaration: ValueId): BodyTable {
  return {
    declaration,
    info: new Map(),
    facts: new Map(),
    locals: new Map(),
  };
}

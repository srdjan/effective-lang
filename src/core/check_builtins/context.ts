// The checker operations used by builtin family handlers. The body checker
// owns argument evaluation, diagnostics and body tables; dispatch owns arity,
// pipeline rules and lowering facts. Keep this interface to the members used
// by the extracted families.

import type { DiagnosticCode } from "../diagnostics.ts";
import type { LocalId } from "../ir.ts";
import type { Target } from "../resolve.ts";
import type { NodeId, SyntaxTree } from "../syntax.ts";
import {
  type EffectSet,
  type NodeFact,
  type NodeInfo,
  PURE_EFFECTS,
} from "../tables.ts";
import type { TypeNode, TypeRef, TypeTable } from "../types.ts";

export interface Arg {
  readonly node: NodeId;
  /** The value of a pipeline's left side, which is evaluated once before the stage. */
  readonly pre?: NodeInfo;
}

/** Shared operations needed by the extracted builtin families. */
export interface BuiltinContext {
  readonly table: TypeTable;
  argInfo(arg: Arg, expected?: TypeRef): NodeInfo;
  callback(
    name: string,
    arg: Arg,
    parameters: readonly TypeRef[],
    resultHint: TypeRef | undefined,
    allowEffects?: boolean,
  ): { readonly info: NodeInfo; readonly result: TypeRef };
  finish(node: NodeId, type: TypeRef, eff: EffectSet): NodeInfo;
  fits(
    node: NodeId,
    found: TypeRef,
    expected: TypeRef | undefined,
    what: string,
  ): boolean;
  functionOf(ref: TypeRef): FunctionNode | undefined;
  inlineStreamCallback(name: string, arg: Arg): void;
  isError(ref: TypeRef): boolean;
  report(code: DiagnosticCode, message: string, node: NodeId): void;
  widen(ref: TypeRef): TypeRef;
}

export type FunctionNode = Extract<TypeNode, { readonly kind: "function" }>;

/** One `name: literal` field of an option record. */
export interface LiteralField {
  readonly node: NodeId;
  readonly value: unknown;
}

/** Invocation effects; an unknown function contributes none during recovery. */
export function invocationOf(fn: FunctionNode | undefined): EffectSet {
  return fn === undefined ? PURE_EFFECTS : {
    failures: fn.failures,
    requirements: fn.requirements,
    mode: fn.execution,
  };
}

/** One use of a local in a body. */
export interface LocalUse {
  readonly node: NodeId;
  readonly parent: NodeId | undefined;
  readonly grandparent: NodeId | undefined;
  /** True when an arrow function between the body and the use encloses it. */
  readonly nested: boolean;
}

// The views below hold the members that several family contexts share. A
// family context extends the views that it uses.

/** The syntax tree and its child lists. */
export interface SyntaxView {
  readonly tree: SyntaxTree;
  kids(node: NodeId): NodeId[];
}

/** What name resolution decided for each node. */
export interface ResolveView {
  readonly targets: ReadonlyMap<NodeId, Target>;
}

/** The facts that the checker recorded so far. */
export interface FactView {
  readonly facts: ReadonlyMap<NodeId, NodeFact>;
}

/** Records a fact about a node. */
export interface FactWriter {
  fact(node: NodeId, fact: NodeFact): void;
}

/** The uses of a local in a body. */
export interface LocalUseView {
  localUses(
    body: NodeId,
    id: LocalId,
    shorthand?: boolean,
  ): readonly LocalUse[];
}

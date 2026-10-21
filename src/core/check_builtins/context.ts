// The checker operations used by builtin family handlers. The body checker
// owns argument evaluation, diagnostics and body tables; dispatch owns arity,
// pipeline rules and lowering facts. Keep this interface to the members used
// by the extracted families.

import type { DiagnosticCode } from "../diagnostics.ts";
import type { NodeId } from "../syntax.ts";
import type { EffectSet, NodeInfo } from "../tables.ts";
import type { TypeNode, TypeRef, TypeTable } from "../types.ts";

export interface Arg {
  readonly node: NodeId;
  /** The value of a pipeline's left side, which is evaluated once before the stage. */
  readonly pre?: NodeInfo;
}

/** The eight shared operations needed by the Schedule family. */
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
  functionOf(
    ref: TypeRef,
  ): Extract<TypeNode, { readonly kind: "function" }> | undefined;
  inlineStreamCallback(name: string, arg: Arg): void;
  report(code: DiagnosticCode, message: string, node: NodeId): void;
}

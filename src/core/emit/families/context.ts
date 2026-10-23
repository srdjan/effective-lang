// The emitter-owned context of the builtin families. The families use this
// context and never import `expr.ts`.

import type { Expr, FunctionType, Type } from "../../ir.ts";
import type { Doc, GroupId } from "../doc.ts";
import type { Emitted, Kid, Mode } from "../emitted.ts";
import type { ExprScope } from "../scope.ts";

/**
 * The operations that the builtin families use from the expression emitter.
 * The emitter owns the printing of child nodes and the naming state.
 */
export interface ExprCore {
  readonly scope: ExprScope;
  pure(e: Expr, expected?: Type): Emitted;
  fit(e: Expr, expected: Type | undefined, mode: Mode): Emitted;
  callback(arg: Expr, kid: Kid): Emitted;
  effectCallback(arg: Expr): Emitted;
  arrow(parameters: Doc, body: Emitted, bodyGroup?: GroupId): Doc;
  genCall(statements: readonly Doc[]): Emitted;
  adaptedInput(
    input: Emitted,
    type: Type,
    direction: "decoded" | "encoded" | "make",
    unknownInput?: boolean,
  ): Emitted;
  suspended(job: Expr): Emitted;
  closure(
    e: Extract<Expr, { kind: "closure" }>,
    annotate: boolean,
    forceEffect?: boolean,
  ): Emitted;
  objectLiteral(fields: readonly Doc[], spreads: readonly Doc[]): Emitted;
  functionTypeOf(type: Type): FunctionType | undefined;
}

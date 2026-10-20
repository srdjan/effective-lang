// The simple calls of the emitter. A simple call prints as `callee(operands)`
// and differs from another only in the callee and in how it prints each
// operand. One table states the structural kinds, and one table states the leaf
// kinds. A kind that is in neither table needs its own case in `expr.ts`, and
// the compiler rejects a kind that has neither.

import type { Expr } from "../ir.ts";
import type { EffectModule } from "./scope.ts";
import type { ExprOf } from "./shape.ts";

/** The runtime helpers that the emitter writes for a closeable scope. */
type ScopeOperation = "make" | "provide" | "register" | "close";

/** The function that a simple call invokes. */
export type Callee =
  | {
    readonly kind: "method";
    readonly module: EffectModule;
    readonly method: string;
  }
  | { readonly kind: "scope"; readonly operation: ScopeOperation };

function method(module: EffectModule, name: string): Callee {
  return { kind: "method", module, method: name };
}

function scopeOperation(operation: ScopeOperation): Callee {
  return { kind: "scope", operation };
}

/**
 * How the emitter prints an operand.
 * - `value`: the expression as it is.
 * - `callback`: a closure prints without parameter types.
 * - `effect-callback`: a function value prints as an effect function.
 */
export type Treatment = "value" | "callback" | "effect-callback";

type Operand = readonly [expression: Expr, treatment: Treatment];

/** A call of a structural kind: the callee and the printed operands. */
interface OperandCall<E extends Expr> {
  readonly callee: Callee;
  readonly operands: (e: E) => readonly Operand[];
}

/** The structural kinds that print as a simple call. */
export type OperandCallKind =
  | "map-stream"
  | "switch-map-streams"
  | "catch-stream"
  | "retry-stream"
  | "take-stream"
  | "drop-stream"
  | "drop-while-stream"
  | "filter-stream"
  | "filter-effect-stream"
  | "take-while-effect-stream"
  | "take-until-effect-stream"
  | "drop-while-effect-stream"
  | "take-while-stream"
  | "take-until-stream"
  | "sink-for-each"
  | "schedule-recurs"
  | "schedule-concat"
  | "merge-streams"
  | "zip-streams"
  | "concat-streams"
  | "merge-layers"
  | "race";

export const OPERAND_CALLS: {
  readonly [K in OperandCallKind]: OperandCall<ExprOf<K>>;
} = {
  "map-stream": {
    callee: method("Stream", "map"),
    operands: (e) => [[e.stream, "value"], [e.transform, "callback"]],
  },
  "switch-map-streams": {
    callee: method("Stream", "switchMap"),
    operands: (e) => [[e.stream, "value"], [e.transform, "callback"]],
  },
  "catch-stream": {
    callee: method("Stream", "catch"),
    operands: (e) => [[e.stream, "value"], [e.recover, "callback"]],
  },
  "retry-stream": {
    callee: method("Stream", "retry"),
    operands: (e) => [[e.stream, "value"], [e.policy, "value"]],
  },
  "take-stream": {
    callee: method("Stream", "take"),
    operands: (e) => [[e.stream, "value"], [e.count, "value"]],
  },
  "drop-stream": {
    callee: method("Stream", "drop"),
    operands: (e) => [[e.stream, "value"], [e.count, "value"]],
  },
  "drop-while-stream": {
    callee: method("Stream", "dropWhile"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "callback"]],
  },
  "filter-stream": {
    callee: method("Stream", "filter"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "callback"]],
  },
  "filter-effect-stream": {
    callee: method("Stream", "filterEffect"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "effect-callback"]],
  },
  "take-while-effect-stream": {
    callee: method("Stream", "takeWhileEffect"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "effect-callback"]],
  },
  "take-until-effect-stream": {
    callee: method("Stream", "takeUntilEffect"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "effect-callback"]],
  },
  "drop-while-effect-stream": {
    callee: method("Stream", "dropWhileEffect"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "effect-callback"]],
  },
  "take-while-stream": {
    callee: method("Stream", "takeWhile"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "callback"]],
  },
  "take-until-stream": {
    callee: method("Stream", "takeUntil"),
    operands: (e) => [[e.stream, "value"], [e.predicate, "callback"]],
  },
  "sink-for-each": {
    callee: method("Sink", "forEach"),
    operands: (e) => [[e.consume, "effect-callback"]],
  },
  "schedule-recurs": {
    callee: method("Schedule", "recurs"),
    operands: (e) => [[e.times, "value"]],
  },
  "schedule-concat": {
    callee: method("Schedule", "concat"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
  "merge-streams": {
    callee: method("Stream", "merge"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
  "zip-streams": {
    callee: method("Stream", "zip"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
  "concat-streams": {
    callee: method("Stream", "concat"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
  "merge-layers": {
    callee: method("Layer", "merge"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
  race: {
    callee: method("Effect", "race"),
    operands: (e) => [[e.left, "value"], [e.right, "value"]],
  },
};

/**
 * The leaf kinds that print as a call of their evaluated children. The
 * emitter prints the children first, so a row states the callee only.
 */
type LeafCallKind =
  | "fail"
  | "scoped"
  | "run-stream"
  | "collect-stream"
  | "head-stream"
  | "last-stream"
  | "drain-stream"
  | "make-ref"
  | "get-ref"
  | "set-ref"
  | "update-ref"
  | "make-scope"
  | "provide-scope"
  | "add-scope-finalizer"
  | "close-scope";

export const LEAF_CALLS: { readonly [K in LeafCallKind]: Callee } = {
  fail: method("Effect", "fail"),
  scoped: method("Effect", "scoped"),
  "run-stream": method("Stream", "run"),
  "collect-stream": method("Stream", "runCollect"),
  "head-stream": method("Stream", "runHead"),
  "last-stream": method("Stream", "runLast"),
  "drain-stream": method("Stream", "runDrain"),
  "make-ref": method("Ref", "make"),
  "get-ref": method("Ref", "get"),
  "set-ref": method("Ref", "set"),
  "update-ref": method("Ref", "update"),
  "make-scope": scopeOperation("make"),
  "provide-scope": scopeOperation("provide"),
  "add-scope-finalizer": scopeOperation("register"),
  "close-scope": scopeOperation("close"),
};

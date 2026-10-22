// The row shapes of the prelude builtins. A family file exports its rows next to
// its handlers, and `registry.ts` composes them. A row holds the prologue that
// the dispatcher runs before the handler, and the handler. A family row table
// must be disjoint from the others: a key that two spreads give compiles with
// no error, so `tests/builtin_rows_test.ts` checks the key sets.

import type { PreludeName } from "../resolve.ts";
import type { NodeId } from "../syntax.ts";
import type { NodeFact, NodeInfo } from "../tables.ts";
import type { TypeRef } from "../types.ts";
import type { Arg } from "./context.ts";

/** The prelude names that have a handler. `None` is a value, so it has none. */
export type PreludeCallName = Exclude<PreludeName, "None">;

/** Camel case to kebab case at the type level: `retrySchedule` gives `retry-schedule`. */
export type Kebab<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `-${Lowercase<Head>}`}${Kebab<
    Tail
  >}`
  : S;

/**
 * The facts of a prologue. `fact` is recorded before the argument count is
 * tested, so a call with a wrong count keeps it. `bailFact` is recorded only
 * after a wrong count, for a handler that records another fact after its checks.
 */
export interface PrologueFacts<K extends PreludeCallName, C> {
  readonly fact?:
    | NodeFact & { readonly kind: Kebab<K> }
    | ((checker: C, name: K, args: readonly Arg[]) => NodeFact);
  readonly bailFact?: NodeFact & { readonly kind: Kebab<K> };
}

/**
 * What a prelude call needs before its handler runs. The dispatcher runs these
 * steps in order: record `fact`, test the argument count, and on a wrong count
 * record `bailFact` and give the error type. A right count is followed by the
 * `pipeline` rule. The handler then runs and may assume the right count.
 * - `bail` "pure": a wrong count gives the effects of the arguments only.
 *   "effect": a wrong count adds `EFFECT_ONLY` to them.
 * - `pipeline` "direct": a pipeline left side is rejected. "any": it is allowed.
 */
export interface Prologue<K extends PreludeCallName, C>
  extends PrologueFacts<K, C> {
  readonly arity: number | ((name: K, args: readonly Arg[]) => number);
  readonly bail: "pure" | "effect";
  readonly pipeline: "direct" | "any";
  /** The message of a wrong count, instead of the counted form. */
  readonly usage?: string;
}

/** A prologue that many names share, so its `fact` is a function of the name and it has no `bailFact`. */
export type SharedPrologue<K extends PreludeCallName, C> =
  & Omit<Prologue<K, C>, "fact" | "bailFact">
  & {
    readonly fact: (checker: C, name: K, args: readonly Arg[]) => NodeFact;
  };

/**
 * One prelude builtin. The row `"own-arity"` marks a handler that tests its own
 * argument count. The context `C` is the set of checker operations that the
 * prologue and the handler use.
 */
export interface BuiltinRow<K extends PreludeCallName, C> {
  readonly prologue: Prologue<K, C> | "own-arity";
  readonly handle: (
    c: C,
    node: NodeId,
    name: K,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ) => NodeInfo;
}

/** One row for each name in `N`. A missing name is a compile error. */
export type Rows<N extends PreludeCallName, C> = {
  readonly [K in N]: BuiltinRow<K, C>;
};

/** A prologue that rejects a pipeline left side. */
export function direct<K extends PreludeCallName, C = unknown>(
  arity: number,
  bail: "pure" | "effect",
  facts: PrologueFacts<NoInfer<K>, C> = {},
): Prologue<K, C> {
  return { arity, bail, pipeline: "direct", ...facts };
}

/** A prologue that allows a pipeline left side. */
export function piped<K extends PreludeCallName, C = unknown>(
  arity: number,
  bail: "pure" | "effect",
  facts: PrologueFacts<NoInfer<K>, C> = {},
): Prologue<K, C> {
  return { arity, bail, pipeline: "any", ...facts };
}

/** A prologue for a call that takes `required` arguments and one optional last argument. */
export function optionalLast<K extends PreludeCallName, C = unknown>(
  required: number,
  usage: string,
): Prologue<K, C> {
  return {
    arity: (_name, args) =>
      args.length === required + 1 ? required + 1 : required,
    bail: "pure",
    pipeline: "any",
    usage,
  };
}

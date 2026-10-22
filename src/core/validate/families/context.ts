// The validator-owned context of the builtin families, and the result types that
// the validator and the families share. The families use this context and never
// import `expr.ts`.

import type { Expr, Span, Type } from "../../ir.ts";
import type { Report } from "../report.ts";
import type { Active } from "../sets.ts";
import {
  type asFunction,
  BOOLEAN,
  INT,
  NUMBER,
  STRING,
  type TypeEnv,
  unfold,
} from "../typing.ts";
import type { Ctx } from "../world.ts";

/** The validation area code of a report entry. */
export type Area = Parameters<Report["add"]>[0];

/**
 * The operations that the builtin families use from the body validator. The
 * validator owns the checks of the child nodes and the report.
 */
export interface ValidatorCore {
  readonly env: TypeEnv;
  readonly ctx: Ctx;
  add(area: Area, path: string, what: string, span: Span): void;
  check(e: Expr, path: string): Out;
  poison(): Comp;
  checkConcurrency(
    e: {
      readonly concurrency: number | "unbounded" | undefined;
      readonly span: Span;
    },
    path: string,
    name: string,
  ): void;
  jobFunction(
    job: Out,
    path: string,
    span: Span,
    what: string,
  ): ReturnType<typeof asFunction>;
}

export const EFFECT_ONLY: Active = {
  failures: [],
  requirements: [],
  execution: "effect",
};

/** What a checked node contributes to its parent. */
export interface Out extends Active {
  readonly type: Type;
}

/** The recomputed annotation of a node. */
export type Comp =
  | {
    readonly kind: "derived";
    readonly type: Type;
    /** Exact equality, or assignability to the recorded type. */
    readonly match: "exact" | "fit";
    readonly active: Active;
  }
  /** The node checks its own type, or reports why it cannot be recomputed. */
  | { readonly kind: "checked"; readonly active: Active }
  /** Effects cannot be recomputed; the recorded sets stand. */
  | { readonly kind: "poisoned" };

export function derivedResult(
  type: Type,
  active: Active,
  match: "exact" | "fit" = "exact",
): Comp {
  return { kind: "derived", type, active, match };
}

/** The type that a mutable state keeps for a stored value: a literal widens to its primitive. */
export function streamState(env: TypeEnv, type: Type): Type {
  const value = unfold(env, type);
  if (value.kind !== "literal" || value.value === null) return type;
  return typeof value.value === "string"
    ? STRING
    : typeof value.value === "boolean"
    ? BOOLEAN
    : Number.isSafeInteger(value.value)
    ? INT
    : NUMBER;
}

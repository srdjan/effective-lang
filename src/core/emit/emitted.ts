// The printed-expression values that `expr.ts` and the builtin families share:
// the precedence levels, `Emitted` with its chain types, and the helpers that
// build and combine them.

import type { Expr, Span, Type } from "../ir.ts";
import {
  alt,
  type Doc,
  group,
  type GroupId,
  hard,
  ifBreak,
  ifBroke,
  indent,
  join,
  line,
  soft,
} from "./doc.ts";

/** Precedence levels of the printed expressions. A larger number binds tighter. */
export const PREC = {
  yield: 0,
  conditional: 1,
  or: 2,
  and: 3,
  equality: 4,
  relational: 5,
  additive: 6,
  multiplicative: 7,
  member: 10,
} as const;

/** The parameter list of one arrow of a chain, with the source span of that arrow. */
export interface ChainHead {
  readonly doc: Doc;
  readonly span: Span | undefined;
}

/** The body at the end of an arrow chain. */
export type ChainTail =
  | { readonly kind: "expr"; readonly body: Emitted }
  | { readonly kind: "block"; readonly statements: readonly Doc[] };

/**
 * An arrow function, seen as a chain of arrows: `(a) => (b) => body` has two
 * heads. `deno fmt` lays out a chain as a unit, so the printer needs the parts.
 */
export interface Chain {
  readonly heads: readonly ChainHead[];
  readonly tail: ChainTail;
}

/** A printed expression with the facts that its parent needs. */
export interface Emitted {
  readonly doc: Doc;
  readonly prec: number;
  /** The text starts with `{`, so a statement or an arrow body needs parentheses. */
  readonly brace: boolean;
  /** An array or tuple literal: an arrow body stays on the line of the arrow. */
  readonly bracket?: true;
  /** A function or object literal that a call can print after the other arguments. */
  readonly huggable: boolean;
  /** Present when the expression is an arrow function. */
  readonly chain?: Chain;
  /** Present when the expression is a binary operation. A larger run can take its operands. */
  readonly run?: Run;
  /** Present when the expression is an arrow with an expression body. Names the group of the body. */
  readonly bodyGroup?: GroupId;
  /** Present when the expression is a conditional. A conditional in its else branch joins it. */
  readonly condChain?: CondChain;
  /**
   * The doc for a position that starts on a line of its own at the indentation
   * of the expression, as the body of an arrow or an array element. Present
   * only when it differs from `doc`.
   */
  readonly flush?: Doc;
}

export function emitted(
  doc: Doc,
  prec: number = PREC.member,
  flags: {
    readonly brace?: boolean;
    readonly bracket?: true;
    readonly huggable?: boolean;
    readonly chain?: Chain;
    readonly run?: Run;
    readonly flush?: Doc;
    readonly bodyGroup?: GroupId;
    readonly condChain?: CondChain;
  } = {},
): Emitted {
  return {
    ...flags,
    doc,
    prec,
    brace: flags.brace ?? false,
    huggable: flags.huggable ?? false,
  };
}

/** The doc of `e` for a position that starts on a line of its own. */
export function flush(e: Emitted): Doc {
  return e.flush ?? e.doc;
}

/**
 * A chain `t0 ? a0 : t1 ? a1 : last`. `deno fmt` prints every `?` and `:` of
 * the chain at one indentation level.
 */
export interface CondChain {
  readonly tests: readonly Emitted[];
  readonly arms: readonly Doc[];
  readonly last: Doc;
  /** The span of the conditional that starts at `tests[j + 1]`, for each `j`. */
  readonly nested: readonly Span[];
  /** The span of the whole chain. Set when the conditional is tagged. */
  readonly self: Span | undefined;
}

/**
 * A chain of binary operations of one precedence level, such as
 * `a && b && c`. `deno fmt` flattens it and puts the operator at the end of
 * the line. It breaks after an operator only where the next operand does not
 * fit. A break indents the lines after the first by one level, except for an
 * arrow body and an array element.
 */
export interface Run {
  readonly operands: readonly Doc[];
  /** `operators[i]` stands between `operands[i]` and `operands[i + 1]`. */
  readonly operators: readonly string[];
  /**
   * The spans of the operations inside the chain: `inner[j]` covers the
   * operands `0` to `j + 1`. The span of the whole chain is `top`.
   */
  readonly inner: readonly Span[];
  readonly top: Span | undefined;
}

/** The doc of `e`, in parentheses when `e` binds weaker than `min`. */
export function at(e: Emitted, min: number): Doc {
  return e.prec < min ? ["(", e.doc, ")"] : e.doc;
}

/** The doc in a position that needs no parentheses. It adds none, and braces get no special case. */
export function free(e: Emitted): Doc {
  return e.doc;
}

/** Call arguments: one line, or the last function or object printed in place, or one for each line. */
export function callArguments(args: readonly Emitted[]): Doc {
  if (args.length === 0) return "()";
  const docs = args.map(free);
  const expanded = (brk: boolean): Doc =>
    group(
      ["(", indent([soft, join([",", line], docs)]), ifBreak(","), soft, ")"],
      brk,
    );
  const last = args[args.length - 1];
  const others = args.slice(0, -1);
  if (!last.huggable || others.some((o) => o.huggable)) return expanded(false);
  const head = others.flatMap((o) => [free(o), ", "]);
  const lastDoc = free(last);
  // A chain stays on the line of the call only when its heads fit there. Else
  // the arguments break, and each head gets a line of its own.
  if (last.chain !== undefined && last.chain.heads.length > 1) {
    return alt([["(", ...head, lastDoc, ")"], expanded(true)]);
  }
  // When the body of the last arrow moves down, `)` moves down with it.
  const close: Doc = last.bodyGroup === undefined
    ? ")"
    : [ifBroke(last.bodyGroup, hard), ")"];
  return alt([
    ["(", ...head, lastDoc, ")"],
    ["(", ...head, group(lastDoc, true), close],
    expanded(true),
  ]);
}

/** The text of a concurrency limit: a number, or `"unbounded"` with its quotes. */
export function concurrencyText(limit: number | "unbounded"): string {
  return limit === "unbounded" ? '"unbounded"' : String(limit);
}

/** The options argument `{ concurrency: n }`, or no argument when the program sets no limit. */
export function concurrencyArguments(
  limit: number | "unbounded" | undefined,
): Emitted[] {
  return limit === undefined
    ? []
    : [emitted(`{ concurrency: ${concurrencyText(limit)} }`)];
}

export type Mode = "pure" | "gen";
export type Kid = (e: Expr, expected?: Type) => Emitted;

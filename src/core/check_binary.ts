// Operator typing for binary expressions. These functions are pure: they read
// the type table and decide the result type of an operator and whether the
// operands fit. `BodyChecker.binary` checks the operands, reports a mismatch,
// and records the node.

import { isErrorId } from "./ids.ts";
import type { TypeId } from "./ir.ts";
import { flattenMembers } from "./patterns.ts";
import type { BinaryOperator } from "./syntax_queries.ts";
import type { TypeRef, TypeTable } from "./types.ts";

function isError(table: TypeTable, ref: TypeRef): boolean {
  return table.node(ref).kind === "error";
}

/** True when the type is `int` or `number` (literals included). */
export function isNumeric(table: TypeTable, ref: TypeRef): boolean {
  return table.isAssignable(ref, table.number) &&
    !isError(table, ref) && ref !== table.never;
}

/**
 * The brand id when the type, after aliases, is a brand of `int` or `number`.
 * A brand of a literal union or of another brand is not numeric.
 */
export function numericBrand(
  table: TypeTable,
  ref: TypeRef,
): TypeId | undefined {
  const node = table.node(table.unfold(ref));
  if (node.kind !== "named" || isErrorId(node.id)) return undefined;
  const id = node.id;
  const base = table.brandBaseOf(id);
  if (base === undefined) return undefined;
  const baseNode = table.node(table.unfold(base));
  return baseNode.kind === "primitive" &&
      (baseNode.name === "int" || baseNode.name === "number")
    ? id
    : undefined;
}

/** The brand id when both operands have one numeric brand. */
export function sharedNumericBrand(
  table: TypeTable,
  left: TypeRef,
  right: TypeRef,
): TypeId | undefined {
  const brand = numericBrand(table, left);
  return brand !== undefined && brand === numericBrand(table, right)
    ? brand
    : undefined;
}

export function isString(table: TypeTable, ref: TypeRef): boolean {
  return table.isAssignable(ref, table.string) &&
    !isError(table, ref) && ref !== table.never;
}

export function isBoolean(table: TypeTable, ref: TypeRef): boolean {
  return table.isAssignable(ref, table.boolean) &&
    !isError(table, ref) && ref !== table.never;
}

/** The comparison class of a type: a primitive name or a brand identity. */
export function comparisonClass(
  table: TypeTable,
  ref: TypeRef,
): string | undefined {
  const members = flattenMembers(table, ref);
  let found: string | undefined;
  for (const member of members) {
    const node = table.node(member);
    let current: string | undefined;
    if (node.kind === "literal") {
      current = node.value === null ? "null" : typeof node.value;
    } else if (node.kind === "primitive") {
      if (node.name === "int" || node.name === "number") current = "number";
      else if (node.name === "string" || node.name === "boolean") {
        current = node.name;
      }
    } else if (node.kind === "named" && !isErrorId(node.id)) {
      const base = table.brandBaseOf(node.id);
      if (base !== undefined && comparisonClass(table, base) !== undefined) {
        current = `brand:${node.id}`;
      }
    }
    if (current === undefined) return undefined;
    if (found !== undefined && found !== current) return undefined;
    found = current;
  }
  return found;
}

/** The result type of a binary operator, and whether the operands do not fit it. */
export interface OperatorResult {
  readonly type: TypeRef;
  readonly mismatch: boolean;
}

export function operatorResult(
  table: TypeTable,
  operator: BinaryOperator,
  left: TypeRef,
  right: TypeRef,
): OperatorResult {
  const either = isError(table, left) || isError(table, right);
  switch (operator) {
    case "&&":
    case "||": {
      const mismatch = !either &&
        !(isBoolean(table, left) && isBoolean(table, right));
      return { type: table.boolean, mismatch };
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const mismatch = !either &&
        !(isNumeric(table, left) && isNumeric(table, right)) &&
        sharedNumericBrand(table, left, right) === undefined;
      return { type: table.boolean, mismatch };
    }
    case "===":
    case "!==": {
      let mismatch = false;
      if (!either) {
        const l = comparisonClass(table, left);
        const r = comparisonClass(table, right);
        const isNull = (ref: TypeRef) => {
          const type = table.node(table.unfold(ref));
          return type.kind === "literal" && type.value === null;
        };
        const nullable = (isNull(left) && table.isAssignable(left, right)) ||
          (isNull(right) && table.isAssignable(right, left));
        if (!nullable && (l === undefined || r === undefined || l !== r)) {
          mismatch = true;
        }
      }
      return { type: table.boolean, mismatch };
    }
    case "+":
    case "-":
    case "*":
    case "/": {
      // An error operand hides whether the result is int or number.
      if (either) return { type: table.error, mismatch: false };
      if (operator === "+" || operator === "-") {
        const brand = sharedNumericBrand(table, left, right);
        if (brand !== undefined) {
          return { type: table.named(brand), mismatch: false };
        }
      }
      if (isNumeric(table, left) && isNumeric(table, right)) {
        const integral = operator !== "/" &&
          table.isAssignable(left, table.int) &&
          table.isAssignable(right, table.int);
        return {
          type: integral ? table.int : table.number,
          mismatch: false,
        };
      }
      if (operator === "+" && isString(table, left) && isString(table, right)) {
        return { type: table.string, mismatch: false };
      }
      return { type: table.error, mismatch: true };
    }
    default: {
      const unreachable: never = operator;
      return unreachable;
    }
  }
}

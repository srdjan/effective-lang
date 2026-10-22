// Validation of the Ref operations: makeRef, getRef, setRef, and updateRef.

import type { Expr } from "../../ir.ts";
import { AREA } from "../report.ts";
import { combine, invocationOf, isQuiet } from "../sets.ts";
import { asFunction, fits, unfold, UNIT } from "../typing.ts";
import {
  type Comp,
  derivedResult,
  EFFECT_ONLY,
  streamState,
  type ValidatorCore,
} from "./context.ts";

export function refOperation(
  c: ValidatorCore,
  e: Extract<
    Expr,
    { kind: "make-ref" | "get-ref" | "set-ref" | "update-ref" }
  >,
  path: string,
): Comp {
  if (e.kind === "make-ref") {
    const value = c.check(e.value, `${path}.value`);
    return derivedResult({
      kind: "ref",
      element: streamState(c.env, value.type),
    }, combine([value, EFFECT_ONLY]));
  }
  const ref = c.check(e.ref, `${path}.ref`);
  const type = unfold(c.env, ref.type);
  if (type.kind !== "ref") {
    c.add(AREA.types, path, `${e.kind} needs a Ref value`, e.span);
    return c.poison();
  }
  if (e.kind === "get-ref") {
    return derivedResult(type.element, combine([ref, EFFECT_ONLY]));
  }
  if (e.kind === "set-ref") {
    const value = c.check(e.value, `${path}.value`);
    if (!fits(c.env, value.type, type.element)) {
      c.add(
        AREA.types,
        `${path}.value`,
        "the new value must fit the Ref element",
        e.value.span,
      );
    }
    return derivedResult(UNIT, combine([ref, value, EFFECT_ONLY]));
  }
  const transform = c.check(e.transform, `${path}.transform`);
  const fn = asFunction(c.env, transform.type);
  if (
    fn === undefined || fn.parameters.length !== 1 ||
    !isQuiet(invocationOf(fn)) ||
    !fits(c.env, type.element, fn.parameters[0]) ||
    !fits(c.env, fn.result, type.element)
  ) {
    c.add(
      AREA.execution,
      `${path}.transform`,
      "updateRef needs a pure element-to-element callback",
      e.transform.span,
    );
  }
  return derivedResult(UNIT, combine([ref, transform, EFFECT_ONLY]));
}

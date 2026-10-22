// Validation of the Fiber builtins: withFiber, joinFiber, and interruptFiber.

import type { Expr, Type } from "../../ir.ts";
import { AREA } from "../report.ts";
import { combine, invocationOf } from "../sets.ts";
import { asFunction, dataOnly, same, unfold, UNIT } from "../typing.ts";
import { walkExprs } from "../expr_walk.ts";
import {
  type Comp,
  derivedResult,
  EFFECT_ONLY,
  type ValidatorCore,
} from "./context.ts";

export function withFiber(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "with-fiber" }>,
  path: string,
): Comp {
  const job = c.check(e.job, `${path}.job`);
  const use = c.check(e.use, `${path}.use`);
  const effect = unfold(c.env, job.type);
  const fn = asFunction(c.env, use.type);
  if (
    effect.kind !== "effect" || e.use.kind !== "closure" ||
    fn === undefined || fn.parameters.length !== 1 ||
    e.use.parameters[0]?.id !== e.useBinding
  ) {
    c.add(
      AREA.control,
      path,
      "with-fiber needs an Effect and one inline use callback",
      e.span,
    );
    return c.poison();
  }
  const fiber: Type = {
    kind: "fiber",
    result: effect.result,
    failures: effect.effects.failures,
  };
  if (!same(c.env, fn.parameters[0], fiber)) {
    c.add(
      AREA.types,
      `${path}.use`,
      "fiber use parameter does not match child type",
      e.use.span,
    );
  }
  if (!dataOnly(c.env, fn.result, "value")) {
    c.add(
      AREA.types,
      `${path}.use`,
      "fiber use result must be data only",
      e.use.span,
    );
  }
  fiberReferences(c, e.use.body, e.useBinding, `${path}.use.body`);
  return derivedResult(
    fn.result,
    combine([
      job,
      use,
      {
        failures: [],
        requirements: effect.effects.requirements,
        execution: "effect",
      },
      invocationOf(fn),
      EFFECT_ONLY,
    ]),
  );
}

export function fiberOperation(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "join-fiber" | "interrupt-fiber" }>,
  path: string,
): Comp {
  const fiber = c.check(e.fiber, `${path}.fiber`);
  const type = unfold(c.env, fiber.type);
  if (type.kind !== "fiber") {
    c.add(
      AREA.types,
      `${path}.fiber`,
      "fiber operation needs a Fiber value",
      e.fiber.span,
    );
    return c.poison();
  }
  return derivedResult(
    e.kind === "join-fiber" ? type.result : UNIT,
    combine([
      fiber,
      e.kind === "join-fiber"
        ? { failures: type.failures, requirements: [], execution: "effect" }
        : EFFECT_ONLY,
    ]),
  );
}

function fiberReferences(
  c: ValidatorCore,
  body: Expr,
  id: string,
  path: string,
): void {
  walkExprs(body, (expr, parent, _grandparent, nested) => {
    if (expr.kind === "reference" && expr.target === id) {
      if (
        nested ||
        (parent?.kind !== "join-fiber" &&
          parent?.kind !== "interrupt-fiber") ||
        parent.fiber !== expr
      ) {
        c.add(
          AREA.control,
          path,
          "borrowed fiber may only be joined or interrupted directly",
          expr.span,
        );
      }
    }
  });
}

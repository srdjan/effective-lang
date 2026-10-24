// Validation of the effect builtins: retry, retrySchedule, defer, run, and race.

import type { Expr } from "../../ir.ts";
import { AREA } from "../report.ts";
import { combine, invocationOf, isQuiet, unionEffects } from "../sets.ts";
import { asFunction, fits, INT, show, unfold } from "../typing.ts";
import {
  type Comp,
  derivedResult,
  EFFECT_ONLY,
  type ValidatorCore,
} from "./context.ts";

export function retry(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "retry" }>,
  path: string,
): Comp {
  const job = c.check(e.job, `${path}.job`);
  const fn = c.jobFunction(job, `${path}.job`, e.job.span, "retry");
  if (!Number.isSafeInteger(e.times) || e.times < 0) {
    c.add(
      AREA.control,
      `${path}.times`,
      `retry needs a finite nonnegative safe integer count, recorded ${e.times}`,
      e.span,
    );
  }
  if (fn === undefined) return c.poison();
  return derivedResult(
    fn.result,
    combine([job, invocationOf(fn), EFFECT_ONLY]),
  );
}

export function retrySchedule(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "retry-schedule" }>,
  path: string,
): Comp {
  const step = c.check(e.step, `${path}.step`);
  const fn = asFunction(c.env, step.type);
  if (fn === undefined || fn.parameters.length !== 2) {
    c.add(
      AREA.control,
      `${path}.step`,
      "retry schedule needs a two-parameter callback",
      e.step.span,
    );
    return c.poison();
  }
  const error = unfold(c.env, fn.parameters[0]);
  if (error.kind !== "named" || !c.env.errors.has(error.id)) {
    c.add(
      AREA.types,
      `${path}.step`,
      "retry schedule needs a declared error parameter",
      e.step.span,
    );
  }
  if (
    !fits(c.env, INT, fn.parameters[1]) ||
    !fits(c.env, fn.result, { kind: "option", element: INT })
  ) {
    c.add(
      AREA.types,
      `${path}.step`,
      "retry schedule needs an Int attempt and Option<Int> result",
      e.step.span,
    );
  }
  if (!isQuiet(invocationOf(fn))) {
    c.add(
      AREA.control,
      `${path}.step`,
      "retry schedule callback must be pure",
      e.step.span,
    );
  }
  return derivedResult(
    { kind: "retry-schedule", error: fn.parameters[0] },
    combine([step]),
  );
}

export function retryWithSchedule(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "retry-with-schedule" }>,
  path: string,
): Comp {
  const job = c.check(e.job, `${path}.job`);
  const options = c.check(e.options, `${path}.options`);
  const fn = c.jobFunction(job, `${path}.job`, e.job.span, "retry");
  const shape = unfold(c.env, options.type);
  const fields = shape.kind === "record" ? shape.fields : [];
  const policy = fields.length === 1 && fields[0].name === "schedule" &&
      !fields[0].optional
    ? unfold(c.env, fields[0].type)
    : undefined;
  if (policy?.kind !== "retry-schedule") {
    c.add(
      AREA.control,
      `${path}.options`,
      "retry needs a schedule option",
      e.options.span,
    );
  } else if (fn !== undefined) {
    for (const failure of fn.effects.failures) {
      if (!fits(c.env, { kind: "named", id: failure }, policy.error)) {
        c.add(
          AREA.types,
          `${path}.options`,
          `retry schedule does not accept ${failure}`,
          e.options.span,
        );
      }
    }
  }
  if (fn === undefined) return c.poison();
  return derivedResult(
    fn.result,
    combine([job, options, invocationOf(fn), EFFECT_ONLY]),
  );
}

export function defer(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "defer" }>,
  path: string,
): Comp {
  const job = c.check(e.job, `${path}.job`);
  const fn = c.jobFunction(job, `${path}.job`, e.job.span, "defer");
  if (fn === undefined) return c.poison();
  return derivedResult({
    kind: "effect",
    result: fn.result,
    effects: fn.effects,
  }, combine([job]));
}

export function run(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "run" }>,
  path: string,
): Comp {
  const value = c.check(e.value, `${path}.value`);
  const type = unfold(c.env, value.type);
  if (type.kind !== "effect") {
    c.add(
      AREA.control,
      `${path}.value`,
      `run needs an Effect value, but the expression has type ${
        show(value.type)
      }`,
      e.value.span,
    );
    return c.poison();
  }
  return derivedResult(
    type.result,
    combine([
      value,
      {
        failures: type.effects.failures,
        requirements: type.effects.requirements,
        execution: "effect",
      },
    ]),
  );
}

export function race(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "race" }>,
  path: string,
): Comp {
  const left = c.check(e.left, `${path}.left`);
  const right = c.check(e.right, `${path}.right`);
  const a = unfold(c.env, left.type);
  const b = unfold(c.env, right.type);
  if (a.kind !== "effect" || b.kind !== "effect") {
    c.add(AREA.types, path, "race needs two Effect values", e.span);
    return c.poison();
  }
  const aFitsB = fits(c.env, a.result, b.result);
  const bFitsA = fits(c.env, b.result, a.result);
  if (!aFitsB && !bFitsA) {
    c.add(AREA.types, path, "race needs compatible success types", e.span);
  }
  return derivedResult({
    kind: "effect",
    result: aFitsB ? b.result : a.result,
    effects: {
      ...unionEffects(a.effects, b.effects),
    },
  }, combine([left, right]));
}

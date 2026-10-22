// Validation of the collection builtins: partitionAll, validateAll, and allResults.

import { containerEntries, rebuildContainer } from "../builtins.ts";
import type { CapabilityId, ErrorId, Expr, Type } from "../../ir.ts";
import { AREA } from "../report.ts";
import { combine, invocationOf, isQuiet } from "../sets.ts";
import { asFunction, fits, unfold, unionOf } from "../typing.ts";
import { type Comp, derivedResult, type ValidatorCore } from "./context.ts";

export function partitionAll(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "partition-all" }>,
  path: string,
): Comp {
  const jobs = c.check(e.jobs, `${path}.jobs`);
  const array = unfold(c.env, jobs.type);
  const job = array.kind === "array" ? unfold(c.env, array.element) : undefined;
  if (job?.kind !== "effect") {
    c.add(
      AREA.types,
      path,
      "partitionAll needs an array of Effect values",
      e.span,
    );
    return c.poison();
  }
  c.checkConcurrency(e, path, "partitionAll");
  const errors = unionOf(
    c.env,
    job.effects.failures.map((id) => ({ kind: "named", id })),
  );
  return derivedResult(
    {
      kind: "tuple",
      elements: [
        { kind: "array", element: job.result },
        { kind: "array", element: errors },
      ],
    },
    combine([jobs, {
      failures: [],
      requirements: job.effects.requirements,
      execution: "effect",
    }]),
  );
}

export function validateAll(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "validate-all" }>,
  path: string,
): Comp {
  const jobs = c.check(e.jobs, `${path}.jobs`);
  const onErrors = c.check(e.onErrors, `${path}.onErrors`);
  const array = unfold(c.env, jobs.type);
  const job = array.kind === "array" ? unfold(c.env, array.element) : undefined;
  const wrapper = asFunction(c.env, onErrors.type);
  const errors = job?.kind === "effect"
    ? unionOf(
      c.env,
      job.effects.failures.map((id) => ({ kind: "named", id })),
    )
    : undefined;
  const failure = wrapper === undefined
    ? undefined
    : unfold(c.env, wrapper.result);
  if (
    job?.kind !== "effect" || wrapper === undefined ||
    errors === undefined || wrapper.parameters.length !== 1 ||
    !fits(
      c.env,
      { kind: "array", element: errors },
      wrapper.parameters[0],
    ) ||
    !isQuiet(invocationOf(wrapper)) || failure?.kind !== "named" ||
    !c.env.errors.has(failure.id)
  ) {
    c.add(
      AREA.types,
      path,
      "validateAll needs Effect jobs and a pure error-array wrapper returning a nominal error",
      e.span,
    );
    return c.poison();
  }
  c.checkConcurrency(e, path, "validateAll");
  return derivedResult(
    { kind: "array", element: job.result },
    combine([jobs, onErrors, {
      failures: [failure.id as ErrorId],
      requirements: job.effects.requirements,
      execution: "effect",
    }]),
  );
}

export function allResults(
  c: ValidatorCore,
  e: Extract<Expr, { kind: "all-results" }>,
  path: string,
): Comp {
  const jobs = c.check(e.jobs, `${path}.jobs`);
  const shape = unfold(c.env, jobs.type);
  const container = containerEntries(shape);
  if (
    container === undefined ||
    (shape.kind === "record" && shape.fields.some((field) => field.optional))
  ) {
    c.add(
      AREA.types,
      path,
      "allResults needs a tuple, record, or array of Effect values with required fields",
      e.span,
    );
    return c.poison();
  }
  const outcomes: Type[] = [];
  const requirements: CapabilityId[] = [];
  for (const type of container.entries) {
    const member = unfold(c.env, type);
    if (member.kind !== "effect") {
      c.add(
        AREA.types,
        path,
        "allResults requires an Effect value at every position",
        e.span,
      );
      return c.poison();
    }
    const error = unionOf(
      c.env,
      member.effects.failures.map((id) => ({ kind: "named", id })),
    );
    outcomes.push(unionOf(c.env, [
      {
        kind: "record",
        fields: [
          {
            name: "_tag",
            type: { kind: "literal", value: "Success" },
            optional: false,
          },
          { name: "success", type: member.result, optional: false },
        ],
      },
      {
        kind: "record",
        fields: [
          {
            name: "_tag",
            type: { kind: "literal", value: "Failure" },
            optional: false,
          },
          { name: "failure", type: error, optional: false },
        ],
      },
    ]));
    requirements.push(...member.effects.requirements);
  }
  c.checkConcurrency(e, path, "allResults");
  const result = rebuildContainer(container, outcomes);
  return derivedResult(
    result,
    combine([jobs, {
      failures: [],
      requirements,
      execution: "effect",
    }]),
  );
}

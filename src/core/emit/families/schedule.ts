// Emission of the Schedule builtins: spaced, map, max, min, and fromStep.

import {
  at,
  callArguments,
  type Emitted,
  emitted,
  type Kid,
  PREC,
} from "../emitted.ts";
import { internal, resolvedAs } from "../scope.ts";
import type { ExprOf } from "../shape.ts";
import { typeDoc } from "../types.ts";
import type { ExprCore } from "./context.ts";

export type ScheduleStructuralKind =
  | "schedule-spaced"
  | "schedule-map"
  | "schedule-max"
  | "schedule-min"
  | "schedule-from-step";

export function scheduleStructural(
  c: ExprCore,
  e: ExprOf<ScheduleStructuralKind>,
  kid: Kid,
): Emitted {
  switch (e.kind) {
    case "schedule-spaced":
      return emitted([
        `${c.scope.effect("Schedule")}.spaced`,
        callArguments([emitted([
          `${c.scope.effect("Duration")}.millis`,
          callArguments([kid(e.delayMillis)]),
        ])]),
      ]);
    case "schedule-map": {
      const schedule = c.scope.effect("Schedule");
      const duration = c.scope.effect("Duration");
      const meta = c.scope.temp();
      const callback = c.effectCallback(e.transform);
      const enriched = emitted(
        `{ ...${meta}, durationMillis: ${duration}.toMillis(${meta}.duration) }`,
      );
      return emitted([
        `${schedule}.map`,
        callArguments([
          kid(e.schedule),
          emitted(c.arrow(
            `(${meta})`,
            emitted([
              at(callback, PREC.member),
              callArguments([enriched]),
            ]),
          )),
        ]),
      ]);
    }
    case "schedule-max":
    case "schedule-min": {
      const schedule = c.scope.effect("Schedule");
      const effect = c.scope.effect("Effect");
      const duration = c.scope.effect("Duration");
      const meta = c.scope.temp();
      const operation = e.kind === "schedule-max" ? "max" : "min";
      return emitted([
        `${schedule}.map(${schedule}.${operation}([`,
        at(kid(e.left), PREC.yield),
        ", ",
        at(kid(e.right), PREC.yield),
        `]), (${meta}) => ${effect}.succeed(${duration}.toMillis(${meta}.output)))`,
      ]);
    }
    case "schedule-from-step": {
      const policy = resolvedAs(
        c.scope,
        e.type,
        "schedule",
        "scheduleFromStep has wrong type",
      );
      const schedule = c.scope.effect("Schedule");
      const effect = c.scope.effect("Effect");
      const cause = c.scope.effect("Cause");
      const duration = c.scope.effect("Duration");
      const state = c.scope.temp();
      const decide = c.scope.temp();
      const meta = c.scope.temp();
      const decision = c.scope.temp();
      const initialCallback = c.effectCallback(e.initial);
      const decideCallback = c.effectCallback(e.decide);
      const decideType = resolvedAs(
        c.scope,
        e.decide.type,
        "function",
        "schedule decision is not a function",
      );
      return emitted([
        `${schedule}.fromStepWithMetadata(${effect}.suspend(() => ${effect}.map(`,
        at(initialCallback, PREC.member),
        "(), (",
        state,
        ") => { const ",
        decide,
        ": ",
        typeDoc(c.scope, { ...decideType, execution: "effect" }),
        " = ",
        decideCallback.doc,
        "; return (",
        meta,
        `: ${schedule}.InputMetadata<`,
        typeDoc(c.scope, policy.input),
        ">) => ",
        `${effect}.flatMap(${decide}(${state}, ${meta}), (${decision}) => { `,
        `if (${decision}.kind === "Done") return ${cause}.done(${decision}.output); `,
        `${state} = ${decision}.state; `,
        `return ${effect}.succeed([${decision}.output, ${duration}.millis(${decision}.delayMillis)] as [`,
        typeDoc(c.scope, policy.output),
        `, ${duration}.Duration]); }); })))`,
      ]);
    }
    default: {
      const rest: never = e;
      throw internal(`unhandled schedule kind ${rest}`);
    }
  }
}

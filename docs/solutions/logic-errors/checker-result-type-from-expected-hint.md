---
title: The checker must not take a builtin result type from the expected hint when the validator derives it
date: 2026-10-19
category: logic-errors
module: src/core/check_builtins/schedule.ts and src/core/validate/expr.ts
problem_type: logic_error
component: type_checker
symptoms:
  - "`check` reports 0 diagnostics, but `build --validate` reports validation/002 on the same declaration"
  - "The validator message shows two different types, for example expected Schedule<int> and recorded Schedule<number>"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [checker, validator, expected-type, contextual-typing, schedule, ir-validation]
---

# The checker must not take a builtin result type from the expected hint when the validator derives it

## Problem

The source checker and the independent IR validator disagreed about a valid
program. The checker gave `scheduleFromStep` the output type of the annotation.
The validator derived the output type from the decision callback. A widened
annotation, such as `Schedule<number>` with an `int` decision, therefore passed
`check` and failed `build --validate`.

## Symptoms

- `deno task effektive check <dir>` reports `1 module, 0 diagnostics`.
- `deno task effektive build <dir> --validate` reports
  `validation/002: declarations[2].value.type: expected Schedule<type:main#Int, unknown, never, never>, recorded Schedule<type:main#Millis, unknown, never, never>`.

The source that showed the defect:

```effektive
type Int = int
type Millis = number
export const wide: Schedule<Millis> = scheduleFromStep(
  (): Int => 0,
  (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Int> => ({ kind: "Done", output: state })
)
```

## What Didn't Work

- The full gate passed. No test used an annotation that was wider than the
  callback output, so the defect stayed hidden until an audit probe.
- One possible repair let the validator accept any derived output that fits
  the recorded output. This repair was rejected. It weakens the validator, and
  the recorded IR type then holds the annotation instead of the real output.

## Solution

The checker now always derives the output from the decision callback
(the `scheduleFromStepCall` handler in `src/core/check_builtins/schedule.ts`). The `expected` parameter of
`scheduleFromStepCall` was removed, because the checker no longer reads it.
The binding annotation is checked by ordinary assignability. Schedule output
is covariant in `TypeTable.assignable` (`src/core/types.ts`, the `schedule`
case). The independent validator derivation in `src/core/validate/expr.ts` did not
change.

Before:

```ts
const output = hint?.kind === "schedule"
  ? hint.output
  : outputs.length > 0
  ? this.table.union(outputs)
  : this.table.error;
```

After:

```ts
// The output comes from the decision callback only. An annotation then
// checks through Schedule covariance, as the validator does.
const output = outputs.length > 0
  ? c.table.union(outputs)
  : c.table.error;
```

Tests: `tests/schedule_check_test.ts` covers the widened program, an
inferred-output control, and a mismatch that must report `type-mismatch/003`.
`tests/strict_target_slow_test.ts` builds the widened program with the
validator and strict TypeScript.

## Why This Works

The checker records each node type in the IR. The validator recomputes the
type of a builtin call from its children and compares the result with the
recorded type. If the checker copies the expected hint into the recorded type,
the two values differ whenever the hint is wider than the derived type. When
both derive the type from the children, the two values agree. The annotation
check then happens once, at the binding, where assignability allows the
wider type.

## Prevention

- Before a new builtin rule uses `expected` as its result type, find how the
  validator types the same IR node. Use the hint as the result only when the
  validator also reads it from the recorded node or a recorded closure type.
  The identity and recursive Schema rules and contextual list literals use the
  hint in this way. An audit in this session checked `scheduleMap`, identity,
  recursive Schemas, and `takeSink` and found them consistent.
- When the validator derives the type from the children, derive it the same
  way in the checker. Let the binding annotation check assignability.
- For each new builtin that takes a contextual type, add one case where the
  annotation is wider than the derived type. Run the case through `check`,
  the validator, and strict TypeScript.
- Do not repair a disagreement by relaxing the validator. The validator is the
  independent second check of the IR.

## Related Issues

- Audit finding B1 (checker and validator disagree on `scheduleFromStep`),
  found in the audit of the Codex Effect 4 feature commits. Evidence probes were
  kept outside the repository.

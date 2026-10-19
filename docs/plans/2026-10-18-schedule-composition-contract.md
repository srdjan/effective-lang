# General Schedule composition contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: implemented in design draft 0.39 for binary composition with comparable inputs.

## Decision and evidence

Add call-only, shadowable `scheduleMax(left, right)`, `scheduleMin(left,
right)`, and `scheduleConcat(left, right)`. They compose existing four-channel
Schedule values without running them at construction. Two new
[target tests](schedule-probes/composition.ts) confirm normal completion and
the input handed to the second phase; the earlier
[delay probe](stream-schedule-probes/target.ts) distinguishes the three
termination and delay rules. The pinned target signatures give each result the
intersection of its inputs and the union of its failures and requirements.
The source language has no general intersection type, so this first slice
accepts two inputs only when one is assignable to the other. `unknown` accepts
any supplied Schedule input for this purpose, as in the earlier
[Schedule contract](2026-10-18-general-schedule-contract.md). The narrower
input becomes the result input. Incomparable inputs are rejected, even though
the target can express their intersection. That limitation avoids inventing a
source type or silently widening the policy's accepted inputs. For example,
source `int` fits `number`; distinct record field sets do not fit under the
current source record rule. The [Effect guide](https://effect.website/docs/v4/scheduling/choosing-and-combining-schedules)
describes the target's composition intent.

## Source rules

For `left: Schedule<O1,I1,E1,R1>` and
`right: Schedule<O2,I2,E2,R2>`, choose `I` as follows:

1. If every `I1` value fits `I2`, choose `I1`.
2. Otherwise, if every `I2` value fits `I1`, choose `I2`.
3. Otherwise reject the call. A Schedule input of `unknown` accepts either
   value in these checks; ordinary source `unknown` remains unchanged.

`scheduleConcat` returns `Schedule<O1 | O2,I,E1 | E2,R1 | R2>`.
`scheduleMax` and `scheduleMin` each return
`Schedule<number,I,E1 | E2,R1 | R2>`. Their output is the selected delay in
milliseconds, including zero on normal completion. This is distinct from
either operand's output. All arguments evaluate once, left to right, and their
construction effects remain active. Policy stepping, failures, and services
remain deferred. Pipeline syntax is not accepted. `RetrySchedule` is not an
operand and is not converted implicitly.

The backend emits typed `Schedule.max([left, right])` or
`Schedule.min([left, right])`, followed by `Schedule.map` that converts the
target Duration output with `Duration.toMillis`. `scheduleConcat` emits typed
`Schedule.concat(left, right)`. No unchecked cast erases a Schedule channel.
The checker and independent validator derive the same narrowed input, output,
unioned channels, and active construction effects. The version 2 IR adds three
binary expression variants without changing existing payloads.

## Execution and ownership

`max` steps both policies for an input, recurs only if both recur, and uses the
longer delay. `min` recurs while either policy recurs and uses the shorter delay
among active policies. With one 10 ms recurrence and three 20 ms recurrences,
their delays are `[20]` and `[10,20,20]` respectively. Both normally complete
with output `0` milliseconds. `concat` finishes the left before starting the
right; the input that completes the left is immediately supplied to the first
right step. It emits recurrence outputs from either phase and completes with
the right policy's Done output. The same sample policies give delays
`[10,20,20,20]`.

Each execution creates fresh child Schedule state. Construction does not call
a state factory or service. A typed failure from either child fails the
composed Schedule; defects and interruption retain their target causes. A
consumer such as `aggregateWithinStream` owns the execution and awaits its
upstream cleanup on failure or interruption under the existing Schedule rule.
No separate scope or fiber is introduced by the source forms.

## Validation and boundary

The [source fixture](../../fixtures/emit/schedules/composition.eff) checks and
validates; emitted TypeScript passes strict target checking. The compiled
runtime test verifies delays, normal Done outputs, phase outputs, fresh state
on repeated execution, construction deferral, both typed failure channels,
and awaited upstream cleanup when a composed policy fails in aggregation.
Checker tests reject non-Schedules, wrong arity, pipelines, and incomparable
inputs; validator mutations reject forged output, failure, requirement, mode,
and input facts. `deno task check` passes with 1,102 fast and 101 slow tests.

This binary source API can be nested for more policies. It does not expose
general intersections, heterogeneous arrays of policies, `concatResult`,
manual stepping, or other Schedule consumers. Those require separate source
rules and witnesses. Broader package interoperability remains deferred by
user instruction.

## Reproduce

```sh
deno test --no-lock docs/plans/schedule-probes/composition.ts
deno test --no-lock docs/plans/stream-schedule-probes/target.ts
deno test --allow-read tests/check_body_test.ts --filter 'Schedule composition'
deno test --allow-read tests/validate_test.ts --filter 'Schedule composition'
deno test --allow-all tests/emit_slow_test.ts --filter 'composed Schedule'
deno task check
```


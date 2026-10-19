# General Schedule value and timed aggregation contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: implemented in design draft 0.38 for the selected first slice.

## Decision and evidence

Add a four-channel `Schedule<Output, Input, Error, Requirements>` value and
make `aggregateWithinStream` its first consumer. The existing
`RetrySchedule<E>` remains the small pure retry policy; it is not silently
converted to or from a general Schedule.

The [target probes](schedule-probes/contract.ts) pass strict type checking and
four runtime tests. `Schedule.fromStepWithMetadata` starts fresh state for
each `toStep` execution; a step can recur with an output and delay, end normally
with an output, or fail with a typed error. A schedule mapped through a service
is inert at construction. In `Stream.aggregateWithin`, a mapper can fail even
when the underlying schedule ends normally, and that failure and service appear
in the Stream channels. Schedule failure awaits an upstream resource release.
A schedule that only accepts `string` cannot be passed where the consumer
supplies `Option<number[]>`. The earlier
[Stream/Schedule probes](stream-schedule-probes/target.ts) distinguish
`max`, `min`, and `concat` delays and show an effectful, reusable policy; the
[aggregation probes](aggregate-probes/contract.ts) show timed partial flushing
and early upstream stop. Before this slice, the source reported
`unknown-name/001` for `Schedule`; a pure `RetrySchedule` callback could not
use a service. The [compiled source fixture](../../fixtures/emit/schedules/main.eff)
now checks, validates, and emits strict target code for the selected source rule.

The acceptance measure is one compiled source policy whose state resets on
each consumption, whose service and typed failure remain deferred, and whose
normal end does not become a typed failure. The scheduled aggregation witness
must flush a partial Sink on virtual time, stop upstream when the schedule ends,
and await cleanup on interruption. Strict target checking and independent IR
validation are required, as with other Stream operations. These probes do not
establish parity for every target Schedule constructor or consumer.

## Alternatives and trade-offs

| Option | Benefit and cost | Disposition |
| --- | --- | --- |
| Add `{ everyMillis }` to aggregation | Small emitter change, but cannot carry schedule input, output, early end, step failure, or services. | Rejected. |
| Reuse `RetrySchedule<E>` | Preserves the existing retry API, but its pure error/attempt callback has none of the general channels or a normal-end output. | Keep for retry only. |
| Expose target `Pull` and `Schedule.toStep` directly | Covers the full target protocol, but adds target Cause/Done and mutable step ownership to the source language. | Defer manual stepping. |
| Add a typed Schedule decision and a scheduled Stream consumer | Represents the witnessed protocol while leaving target execution and cancellation to Effect. Requires a new source type, constructor and checker rules. | Selected. |

## Source surface and typing

`Schedule<O, I = unknown, E = never, R = never>` is a deferred, reusable value.
`O`, `E`, and `R` are covariant; `I` is contravariant. The output channel
includes the value carried by normal completion. The source decision shape is
structural and discriminated:

```text
ScheduleDecision<S, O> =
  { kind: "Continue", state: S, output: O, delayMillis: number }
  | { kind: "Done", output: O }

ScheduleInput<I> = {
  input: I, attempt: int, start: number, now: number,
  elapsed: number, elapsedSincePrevious: number
}
```

`scheduleFromStep(initial, decide)` is the general constructor. `initial` is
an inline nullary callback that creates `S` for each schedule execution;
`decide` is an inline callback from `(S, ScheduleInput<I>)` to
`ScheduleDecision<S,O>`. Both callbacks may declare typed failures and service
requirements. The resulting Schedule unions their failure and requirement
channels. `ScheduleInput.attempt` starts at one for each execution. A
`Continue` step updates private state, emits `output`, and waits
the requested millisecond delay before the next recurrence. A `Done` step
ends normally and carries `output`; it does not emit a recurrence or wait.
An effectful callback failure or defect keeps its original cause. The compiler
lowers the state factory and decision callback through target
`Schedule.fromStepWithMetadata` and `Duration.millis`; the tagged decision is
translated to target success or Done only at this boundary. The source
callbacks cannot see or mutate the target step function.

The first constructor and modifier set is `scheduleFromStep`,
`scheduleRecurs(times)`, `scheduleSpaced(delayMillis)`, and
`scheduleMap(schedule, callback)`. The latter receives
`ScheduleMetadata<O,I>`, which adds `output` and `durationMillis` to the input
metadata. It preserves the input channel and delay, changes the output
channel, and unions callback failure and requirements. It runs on both a
continuing step and normal completion; on completion `durationMillis` is zero.
The two simple constructors emit zero-based attempt numbers and accept
`unknown` input, as their target counterparts do. Their numeric arguments use
the target `recurs` and `spaced(Duration.millis(...))` semantics; this rule adds
no new rounding or clamping.

The first consumer is a call-only prelude builtin, with the same shadowing rule
as `aggregateStream`:

```text
aggregateWithinStream(
  source: Stream<A, E1, R1>,
  sink: Sink<I, O, E2, R2, L>,
  schedule: Schedule<C, J, E3, R3>
): Stream<O, E1 | E2 | E3, R1 | R2 | R3>
```

Require `A` and `L` assignable to `I` for original input and leftover replay.
Require `Option<O>` assignable to `J`: the target supplies the previous Sink
result, starting with `None`. The Schedule's output `C` does not become a
Stream element; the Sink output does. A schedule accepting `unknown` input is
valid here. Source `unknown` is not generally a top type, so Schedule input
compatibility must explicitly treat `unknown` as accepting any supplied input.
This exception applies only to the contravariant Schedule input slot and does
not widen ordinary source assignments. A `Schedule<C, string, ...>` is invalid
for a Sink producing `number[]`. The checker, IR, and independent validator
must enforce all three
assignability checks and rederive the unioned channels. The emitter uses a
typed `Stream.aggregateWithin(source, sink, schedule)` call, with no cast that
erases schedule channels.

## Execution and ownership

Evaluate source, Sink, and Schedule expressions once in source order when
constructing the Stream. Do not run their deferred work then. Each terminal
consumption allocates one fresh Schedule execution and the aggregation's
producer, queue, Sink runs, and scope. A policy reused under another provider
resolves its services during that consumption. Schedule state is private to
the execution; two consumers of one Schedule value do not share a counter.

The target steps the Schedule at most once per aggregation, after the first
element arrives, with the preceding aggregation's `Option<O>` result. An
immediate Sink completion from leftovers may skip a Schedule step. A successful
step races with Sink completion; its delay can flush a partial Sink. On normal
Schedule end, the current result and leftovers are emitted, then the Stream
stops without another upstream pull. A typed Schedule failure fails the
Stream; a defect remains a defect. The terminal scope owns and awaits source,
Sink, and Schedule cleanup on failure or interruption. Time between
aggregations is excluded from the policy clock, so `scheduleSpaced` is the
simple flush timer; fixed cadence is a different operation.

## Boundaries and implementation gates

The first implementation need not expose `Schedule.toStep`, general
`Effect.repeat` or `Effect.retry`, or native `scheduleMax`, `scheduleMin`, and
`scheduleConcat`. Their target equations remain recorded in the
[Stream/Schedule investigation](2026-10-18-general-stream-schedule-design.md).
In particular, combined inputs use intersection, failures and services use
union, and `max` and `min` output durations rather than their operands' output
types. They require separate source and runtime witnesses before adding names.
The selected `scheduleFromStep` can represent one custom state machine; it
does not claim composition of opaque Schedule values.
The follow-up [composition contract](2026-10-18-schedule-composition-contract.md)
implements binary `max`, `min`, and `concat` for comparable source inputs in
draft 0.39. The first-slice gate below remains the draft 0.38 result.

The implementation gate passes: a checked source fixture uses an effectful
`scheduleFromStep` policy with nontrivial input and a service; the same fixture
uses `scheduleSpaced` with `aggregateWithinStream`; the checker rejects a
string-input policy for `Option<number[]>` while accepting an `unknown` input
policy; validator mutation tests reject wrong input, output, failure,
requirement, and execution-mode facts. Emitted TypeScript passes strict target
checking. A compiled runtime test covers reuse, partial flush, normal end,
failure, and awaited cleanup. `deno task check` passes with 1,100 fast and 100
slow tests. Native composition of opaque policies remains separate work.

The main implementation risk is modeling `ScheduleDecision` as a static
record union while preserving a distinct Done cause in the emitted target
step. Keep the translation inside `scheduleFromStep`; do not expose target
Cause through source types. A second risk is accidental state sharing if
`initial` runs at Schedule construction. The repeated-consumption probe makes
that observable. Reopen this decision if the source callback model cannot
express the selected factory and decision callbacks with precise channels, or
if a target probe shows a different aggregation input or completion rule.

## Reproduce

```sh
deno test --no-lock docs/plans/schedule-probes/contract.ts
deno test --no-lock docs/plans/aggregate-probes/contract.ts
deno test --no-lock docs/plans/stream-schedule-probes/target.ts
deno test --no-lock --allow-all docs/plans/stream-schedule-probes/source_slow_test.ts
```

The pinned Effect declarations and executable probes are the versioned
reference. The [async aggregation contract](2026-10-18-async-aggregation-contract.md)
defines the untimed behavior already implemented in draft 0.37.

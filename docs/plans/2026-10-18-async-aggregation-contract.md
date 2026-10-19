# Async stream aggregation contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: untimed aggregation implemented in design draft 0.37. Timed
aggregation is implemented with general Schedule values in draft 0.38.

## Decision and evidence

Add `aggregateStream(source, sink)` as a fused source operation. It lowers to
`Stream.aggregate`, using the existing five-channel source Sink type. No
capacity parameter belongs to this operation: the pinned target uses a
zero-capacity producer/sink handoff queue internally. It does not supply a
general bounded-memory guarantee for arbitrary upstream chunks or sinks.

The [source witness](aggregate-probes/source.eff) now checks, validates, and
emits a typed `Stream.aggregate` call. It originally reached resolution with
only `unknown-name/001` for `aggregateStream`. The
[target probes](aggregate-probes/contract.ts) have eleven passing tests. They
cover leftovers, completion, read-ahead,
deferred service failure, source failure, failure and interruption cleanup,
early stopping, virtual-time flushing, schedule completion, and a sink that
does not consume input. The target implementation's `aggregateWithin` body
also shows a `Queue.make({ capacity: 0 })`, a producer latch, and a scoped
producer fiber. Two compiled-source runtime tests also compare chunked output
with the pinned target and verify deferred providers, failures, demand, and
interruption cleanup. These observations do not establish parity with every
possible Sink or upstream Stream.

The acceptance measure is an emitted Stream that reproduces those observable
results and lifecycle traces on repeated consumption, passes strict target
checking, and retains the source and Sink failure and requirement channels.
Construction must remain deferred. A matching finite batch array alone is
insufficient, because producer demand and cancellation are part of the rule.

## Alternatives and trade-offs

| Option | Evidence and cost | Disposition |
| --- | --- | --- |
| `transduceStream(source, sink)` | Shares Sink replay and many finite results, but has no separate producer fiber. | Remains the synchronous operation. |
| `transduceStream(bufferStream(source, { capacity: 1 }), sink)` | Adds a producer fiber, but the probe pulls beyond the first item while the first result is blocked; `aggregate` has pulled only one. | Not equivalent. |
| A source-configurable aggregation queue | Could express a different throughput/backpressure policy, but would not map to the pinned target's `aggregate` contract. | Not in this rule. |
| `aggregateWithinStream(source, sink, { everyMillis: N })` | A timer shortcut could flush partial sinks, but hides schedule termination, input/output metadata, typed failure, and services. | Superseded by the general Schedule contract. |
| `aggregateStream(source, sink)` | Reuses the Sink type and maps directly to the tested target operation. Adds a distinct checker, IR, validator, and emitter rule. | Selected. |

## Source surface and typing

The first source rule is a call-only prelude builtin, like
`transduceStream`. It may be shadowed by a source binding. Its schematic type
is:

```text
aggregateStream(
  source: Stream<A, E1, R1>,
  sink: Sink<I, O, E2, R2, L>
): Stream<O, E1 | E2, R1 | R2>
```

Require both `A` and `L` assignable to `I`: the sink accepts original chunks
and later replayed leftovers. The result has the Sink output element type.
Failures and requirements are the union of active source and Sink channels,
without eager provider capture. The source's `Sink<I,O,E,R,L>` maps to the
target's `Sink.Sink<O,I,L,E,R>`. This rule does not change `runStream` or the
default `Sink<I,O>` meaning of no leftovers.

The selected lowering is:

```text
Stream.aggregate(source, sink)
```

The compiler requires two arguments, a Stream followed by a Sink, and
reject incompatible inputs and leftovers with the existing `type-mismatch/010`
family. The `aggregate-stream` IR node stores both operands and its
output/channel result. Independent validation rederives compatibility and
effects rather than trusting the checker fact. The emitter uses typed
`Stream.aggregate` without casting away Sink channels. This slice adds no
pipeline spelling.

## Execution, demand, and completion

Evaluate the two source expressions once, left to right. No source pull or
Sink transform runs at construction. Each terminal consumption allocates fresh
producer, queue, Sink-run, and scope state. The same aggregate Stream can be
consumed again under different providers.

The target hands non-empty upstream chunks through a capacity-zero queue.
When the Sink asks for a chunk, a latch permits one producer pull and queue
offer. Sink leftovers are replayed before another upstream pull. With
`takeSink(1)`, blocking the consumer on its first result leaves one source
pull observed; an otherwise identical positive-capacity buffered transduction
has pulled more. This is a tested demand distinction, not a promise that an
arbitrary upstream operator does no work of its own.

For a positive-count `takeSink(2)` and a single `Stream.fromArray` chunk,
preserve these pinned target results:

| Input | Aggregated outputs | Synchronous transduction |
| --- | --- | --- |
| `[1,2,3,4,5]` | `[[1,2],[3,4],[5]]` | `[[1,2],[3,4],[5]]` |
| `[1,2,3,4]` | `[[1,2],[3,4]]` | `[[1,2],[3,4],[]]` |
| `[]` | `[]` | `[[]]` |

The target's `Schedule.forever` handoff can flush a partial sink between
chunks. Rechunking the five values can therefore change aggregation boundaries;
the compiled-source test compares each chunk size directly with
`Stream.aggregate` instead of asserting one batch partition for all sizes.
Repeated consumption still starts fresh state.

Aggregation suppresses a new Sink run after upstream completion when there
are no leftovers. It still emits a partial Sink result after source failure
where the Sink can finish: `[1,2,3]` followed by `source-stop` yields
`[1,2]`, then `[3]`, then failure. The failure is not turned into a successful
stream end. A Sink failure emits no invented batch for its incomplete run.
Sink services are looked up on each consumption; the probe fails on the third
element under one provider and succeeds under another.

An arbitrary host Sink may complete without consuming input. The target
repeatedly emits such a result: `aggregate(Stream.never, Sink.succeed(7))`
produces `[7,7,7]` under `take(3)`. The compiler must not invent a
progress check or silently drop outputs. `takeSink`'s positive literal rule
keeps the native constructor consuming; callers of a zero-progress host Sink
must bound their own consumption.

The producer fiber belongs to the terminal consumption scope. A Sink failure
closes a scoped source resource before the terminal failure returns, including
yielding cleanup. Interrupting while an upstream pull is pending runs and
awaits that pull's release. Taking the first completed result with
`takeSink(1)` stops before requesting the next source pull. Preserve typed
failure, defects, and interruption as separate causes; do not manufacture a
partial result on interruption.

## Timed and scheduled aggregation dependency

The pinned `Stream.aggregateWithin` accepts a general
`Schedule<C, Option<O>, E3, R3>`. It may flush the current Sink before its
ordinary completion. A `Schedule.spaced` policy flushes a pending partial
`take(2)` Sink after a virtual hour; `Schedule.recurs(0)` emits the current
partial value and stops upstream after one element. The schedule is stepped
at most once per aggregation, after its first element, with the previous
aggregation result as input. Immediate leftover-only Sink completions may
skip a step. Its clock excludes time between aggregations; a fixed-duration
shortcut would not express its output, early end, typed step failure, or
service requirements. The
[general Schedule contract](2026-10-18-general-schedule-contract.md) now
defines these channels, lifecycle, and source syntax;
`aggregateWithinStream` now emits the target operation with those channels.
The untimed rule needs no Schedule source value.

The target documents that `Schedule.fixed` and `Schedule.upTo` do not serve
as idle flush timers in this operation; `Schedule.spaced` does. The virtual
clock probe verifies the latter. It does not measure wall-clock precision or
establish all schedule compositions.

## Implementation and verification

Source resolution, checker facts, IR lowering, independent validation, typed
emission, and editor recognition now support `aggregateStream`. Checker tests
cover inferred and annotated Sinks, wider Sink inputs, deferred channels,
invalid operands, pipeline rejection, and shadowing. Validator mutations
cover replay compatibility, result channels, active channels, and execution
mode. The source witness passes checking, validation, and emission.

The emitted fixture passes strict target checking. Two compiled-source tests
cover odd/exact/empty input, repeated runs with several chunk sizes, wider
inputs, zero-progress host Sinks, blocked downstream demand, construction
order, provider rebinding, source and Sink failure, and awaited pending-pull
cleanup. The target probes cover timed flushing and schedule termination as
future Schedule work. The canonical spec and IR reference carry the same
rule. The repository gate results are recorded in the validation ledger.

Broader package interoperability, item 9 in the API gap list, remains deferred
by user instruction. This rule uses the already established typed host Sink
boundary.

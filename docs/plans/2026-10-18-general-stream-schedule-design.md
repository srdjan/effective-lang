# General Stream and Schedule audit

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: representative investigation complete. Sink leftovers and keyed
grouping are implemented in design drafts 0.35 and 0.36. Untimed async
aggregation is implemented in draft 0.37. The selected general Schedule slice
and timed aggregation are implemented in draft 0.38. Binary Schedule
composition with comparable inputs follows in draft 0.39.

The follow-up [Sink leftover contract](2026-10-18-sink-leftover-contract.md)
implements an appended fifth type argument, positive-count `takeSink`, and
synchronous `transduceStream`. Nine additional target tests and four compiled
source tests verify replay, completion, channels, and resource lifetime.
The [async aggregation contract](2026-10-18-async-aggregation-contract.md)
implements a fused untimed `aggregateStream` source rule after target demand,
completion, and cancellation probes. Timed aggregation follows the implemented
[general Schedule contract](2026-10-18-general-schedule-contract.md).

## Decision and acceptance measure

The original investigation classified keyed live grouping, async aggregation,
custom sink-building callbacks, and general Schedule values as uncovered.
Grouping and synchronous transduction with typed leftovers now have native
support; untimed aggregation is also implemented. The selected external-stop
behavior and a fixed combined retry policy have existing source compositions.
Their existence is not sufficient reason to add same-named builtins.

The acceptance measure is equivalent observable consumption behavior with the
same deferred failure and requirement channels. The checks include repeated
consumption, per-key order, leftover handling, interruption of pending work,
and completed finalizers. Construction must defer execution. A finite output
array alone does not establish equivalence for a live or reusable API.

The [target probes](stream-schedule-probes/target.ts) have six passing tests.
The [compiler/runtime probes](stream-schedule-probes/source_slow_test.ts) have
two passing tests covering three illustrative source diagnostics, accepted Sink
leftover and aggregation construction, emitted-source execution,
the inline tuple regression, and one expected strict target rejection for Sink
leftovers. The probes use handshakes rather
than elapsed-time assertions; schedule delays are inspected without sleeping.
All claims here are bounded by those experiments, not an inventory of every
Stream, Sink, or Schedule export.

## External interruption: an existing source composition

The target operation is `Stream.interruptWhen(source, signal)`: the signal runs
alongside consumption. Signal success ends the stream, signal failure fails it,
and a pending source pull is interrupted. Source completion must also cancel a
signal that would otherwise wait forever.

[compositions.eff](stream-schedule-probes/compositions.eff) expresses the tested
behavior with existing forms:

1. Map source elements to `Value` events.
2. Concatenate a single `End` event after successful source completion.
3. Unfold a second stream that runs the signal once and emits `End` on success.
4. Merge both streams, take through the first `End`, discard that marker, and
   unwrap the remaining `Value` events.

The source-end marker matters: `mergeStreams` alone waits for both sides to end.
Without that marker, a completed source could leave consumption waiting for
the signal. Source and signal failures pass through the merge and retain their
nominal types and service requirements.

The emitted source passes checking, independent IR validation, strict target
checking, and runtime comparison with `Stream.interruptWhen`:

| Scenario after an observed first value | Result | Completed cleanup before terminal return |
| --- | --- | --- |
| Signal succeeds while the next source pull waits | Prefix `[1]`, success | Pending source pull and signal |
| Signal fails while the next source pull waits | Prefix `[1]`, `SignalError` | Pending source pull and signal |
| Source ends while the signal waits | Prefix `[1]`, success | Signal |
| Source fails while the signal waits | Prefix `[1]`, `SourceError` | Signal |

The same emitted Stream is consumed again with fresh providers. A yielding,
failing consumer also observes one source pull with either construction. This
does not establish identical scheduling for simultaneous events, arbitrary
chunk boundaries, or every backpressure configuration. No new interruption
operator is selected from these witnesses; a stronger demand or scheduling
counterexample would reopen the decision. `haltWhen`, which lets a current
pull finish, is a distinct contract and was not established by these tests.

### Contextual tuple emission regression

[inline-marker.eff](stream-schedule-probes/inline-marker.eff) returns
`Some([{ kind: "End", value: 0 }, true])` from an annotated `unfold` callback
branch. The initial emission widened the tuple to an array and failed strict
target checking with `TS2375` despite passing source and IR validation.

The emitter now supplies the checked payload type to `Option.some`. The original
program passes strict target checking and emits the expected marker on repeated
consumption. The working composition uses inline markers, and the
[compiler fixture](../../fixtures/emit/contextual-options.eff) covers nested
Options, tuples, arrays, literal fields, and effectful payloads. The existing
source rule is unchanged.

## Keyed grouping: live routing is the boundary

The checked target form is:

```text
Stream<A,E,R>
  -> groupByKey(key, { bufferSize: 1 })
  -> Stream<[Key, Stream<A>], E, R>
```

The test consumes a single source and collects each group concurrently. Values
`0..5` produce groups `0:[0,3]`, `1:[1,4]`, `2:[2,5]`, preserving per-key order.
There are seven source pulls, including completion, per execution; repeating
the same Stream allocates fresh group state. Construction performs no pulls.

A second test starts two group consumers and leaves the source in a pending
pull. One consumer then fails. Before the terminal failure returns, the source
pull and both consumer finalizers have completed.

The illustrative source name `groupByKey` fails resolution with
`unknown-name/001`. That diagnostic alone would not establish an expressiveness
gap: fixed-key filtering, adjacent batches, and per-key counters can be encoded
as ordinary source transformations. They do not establish the tested contract
of one live producer routing to dynamically discovered group streams.
No equivalent source routing implementation is established by this audit.

Before adding a grouping form, specify:

- Supported key equality and identity, discovery order, and per-key order.
- Per-group queue bounds, backpressure when a group is not consumed, and how
  consumers run concurrently. The buffer bound is per group; it does not bound
  the number of distinct keys or total memory.
- Ownership of the shared producer and group streams. A callback-based form
  could keep consumption inside that lifetime; an unrestricted nested Stream
  result needs a rule for use after its routing scope closes.
- How source, classifier, and consumer failures and requirements combine. In
  the pinned target, group substreams have no independent failure/requirement
  channels; the outer grouping stream carries source/classifier channels.
- Cleanup on consumer failure and downstream interruption. Idle eviction and
  unconsumed-group policy need additional witnesses before inclusion.

The follow-up [live keyed grouping contract](2026-10-18-keyed-group-contract.md)
settles those rules for one fused `mapGroups` form. Its nine target probes
establish a runtime lowering with callback-owned group pulls, concurrent
consumers, unordered data results, explicit queue capacity, and awaited cleanup.
Draft 0.36 implements its conservative source borrow checks, independent IR
validation, typed emission, and compiled-source runtime witnesses.

## Arbitrary Sinks: preserve the leftover channel

The target witness is `Stream.transduce(source, Sink.take(2))`. A single source
chunk `[1,2,3,4,5]` produces `[[1,2],[3,4],[5]]`; leftovers feed later sink runs
without losing or duplicating elements. Exact input `[1,2,3,4]` produces an
additional final empty result, `[[1,2],[3,4],[]]`; empty input produces `[[]]`.
These results are observed behavior of this target version.

The second aggregation witness uses effectful `Sink.foldUntil` through
`Stream.aggregate`. Its result retains a typed sink failure and service
requirement. Construction makes no service calls; a failure on input `3`
stops the sink after three calls. The target operators have different execution
contracts: transduction restarts a sink over a pull, while aggregation runs
upstream and downstream in separate fibers. This audit does not equate them.

The four-argument source `Sink<I,O,E,R>` still emits:

```text
Effect Sink<O, I, never, E, R>
                  ^ leftover channel fixed to never
```

This is a concrete typed adapter boundary. The emitted alias
`PairSink = Sink<Int, Int[]>` cannot accept target `Sink.take<number>(2)`:
strict target checking reports `TS2375`, `number` is not assignable to `never`.
Draft 0.35 accepts a fifth source Sink argument for explicit leftovers.
`takeSink` and `transduceStream` now compile and pass source/runtime acceptance.
Their original parse/resolution failures established the pre-extension boundary.

A specialized batching state machine can reproduce a fixed list of pairs.
That does not represent an arbitrary reusable Sink value with leftovers.
Terminal `runStream` discards the producer continuation and cannot by itself
restart that same sink over unconsumed input. An adapter can instead own the
complete transformation and return a Stream.

The [follow-up contract](2026-10-18-sink-leftover-contract.md) appends the
leftover parameter without changing existing argument positions. Transduction
checks that source elements and replayed leftovers fit sink input; terminal
execution can discard arbitrary leftover types. The implementation preserves
leftover replay before new pulls, fresh state, partial/empty results, deferred
channel unions, and whole-consumption finalizer lifetime. Zero-progress host
sinks remain permitted; bounded downstream consumption is the caller's concern.
The [async aggregation contract](2026-10-18-async-aggregation-contract.md)
now implements its capacity-zero handoff, demand, completion, and cancellation
rules. Timed flushing depends on the
general Schedule value from draft 0.38.

## Schedules: fixed retry arithmetic versus a general policy value

The pinned target uses `Schedule.max`, `Schedule.min`, and `Schedule.concat`.
The tests manually step a one-recurrence 10 ms policy and a three-recurrence
20 ms policy:

| Composition | Delays before completion |
| --- | --- |
| `max`: continue while every policy recurs | `[20]` |
| `min`: continue while any policy recurs | `[10,20,20]` |
| `concat`: finish the left, then start the right | `[10,20,20,20]` |

The names alone are not missing-behavior evidence. The source `combined`
policy in `compositions.eff` computes a bounded retry delay with ordinary
arithmetic. Strictly checked emission produces `[10,10,15]`, matching
`Schedule.max` of a three-step linear delay and 10 ms spacing. This comparison
preserves retry delays and termination, not Schedule outputs: target `max`
outputs durations while the source RetrySchedule emits attempt numbers.

The stronger target witness has this checked type:

```text
Schedule<string, string, "policy-stop", Policy>
         output  input   step failure   service
```

It concatenates two schedules and maps their metadata through a service.
Inputs `a,b` produce `a:0,b:0`; a later input `stop` fails with `policy-stop`.
Mapping is also invoked on normal schedule completion, where it can fail.
Re-execution resets the schedule state. Construction calls no service.

At the time of this investigation, source had no `Schedule` type
(`unknown-name/001`). `RetrySchedule<E>` instead
accepts a pure `(nominal error, attempt) -> Option<Int>` callback. Asking that
callback to consult a service yields `execution-mode/001`, `the retry schedule
callback must be pure`. The type has no independent output, input, policy
failure, or service channels. Matching one delay sequence does not supply
that general policy contract.

The [general Schedule contract](2026-10-18-general-schedule-contract.md) now
selects a four-channel source value, a per-execution state and decision rule,
and timed aggregation as its first consumer. It distinguishes normal
completion from typed step failure and defect, and retains metadata and
deferred channels. The follow-up
[composition contract](2026-10-18-schedule-composition-contract.md) implements
binary `max`, `min`, and `concat` when one source input type fits the other.
Incomparable inputs still need a source intersection rule. Existing
`RetrySchedule` behavior remains intact.

## Options, next steps, and review

| Option | Benefit and cost | Disposition |
| --- | --- | --- |
| Add names for all target operations | Familiar surface, but leaves lifetime, leftovers, and policy channels unspecified. | Rejected as an implementation plan. |
| Keep supported compositions and specify the uncovered contracts first | Immediately useful stop/retry forms; no compiler surface growth. Requires explicit designs for the broader contracts. | Selected for remaining contracts. |
| Add one narrow grouping, transducer, or policy slice | Could address one witnessed contract with limited scope. Effort unmeasured. | Sink leftovers, transduction, grouping, and untimed aggregation are implemented; other slices require their own decisions. |

The [Schema/ecosystem investigation](2026-10-18-schema-ecosystem-design.md)
is complete, and the inline tuple emission defect is repaired. Reopen these dispositions
when a stronger source counterexample or a proposed type/lifetime design is
available. Supersede a native-gap classification only with checked and
independently validated source, strict target checks, and runtime behavior
matching the selected contract. No compiler feature is implemented by this audit.

## Reproduce and references

```sh
deno test --no-lock docs/plans/stream-schedule-probes/target.ts
deno test --no-lock --allow-all docs/plans/stream-schedule-probes/source_slow_test.ts
```

The pinned package declarations and executable probes are the versioned oracle.
The Effect guides describe [stream operations](https://effect.website/docs/v4/stream/operations)
and [schedule composition](https://effect.website/docs/v4/scheduling/choosing-and-combining-schedules).
Related decisions: [initial Stream/Sink slice](2026-10-17-stream-design.md),
[raw Scope ownership boundary](2026-10-18-explicit-scope-design.md), and
[gap audit](../effect-4-gap-audit.md).

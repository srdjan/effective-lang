# Live keyed grouping contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: implemented in design draft 0.36. Source checking, IR validation,
emission, canonical spec, and compiled-source tests cover this slice.

## Decision and evidence

Add one fused `mapGroups` builtin. It routes one source into live keyed groups,
runs a callback for each group concurrently, and emits each callback's data
result when ready. Each group stays inside its callback's lifetime.

The [initial investigation](2026-10-18-general-stream-schedule-design.md#keyed-grouping-live-routing-is-the-boundary)
establishes the missing contract: dynamically discovered groups share one live
producer. Fixed filters, finite array grouping, adjacent batches, and per-key
counters do not establish that behavior. No equivalent source routing program
has been demonstrated. The user requested concrete lifetime and cancellation
rules before implementation; no usage or performance measurements are available.

The primary acceptance measure is a later key producing a result while an
earlier key and the shared source remain live. Guardrails are one source
execution, preserved per-key order, checked non-escape, explicit queue capacity,
deferred channels, and completed cleanup on failure or cancellation.

Nine [target contract probes](group-probes/contract.ts) cover these behaviors.
The [compiled-source fixture](../../../fixtures/emit/groups) and checker,
validator, and runtime tests enforce the key, data-only, and borrowed-use
restrictions that the initial TypeScript prototype could not express.

## Alternatives and accepted trade-offs

| Option | Value and cost | Disposition |
| --- | --- | --- |
| Keep only existing stream transformations | No new type or lifetime rules. | Does not establish the live routing witness. |
| Return unrestricted `Stream<[K, Stream<A>]>` | Closely follows the target and allows arbitrary group composition. | Deferred: nested streams could escape the router through results, storage, or closures. |
| Run a bounded number of group callbacks | Limits active consumers. | Rejected for this slice: long-lived groups can occupy every slot while later groups need consumers to unblock routing. |
| Fuse routing with concurrently running, borrowed callbacks | Keeps routing and consumers inside one terminal lifetime. Requires a checked special binding and unbounded fan-out. | Selected, with explicit per-key capacity and data-only results. |

The selected scope favors a provable lifetime over arbitrary group-stream
composition. Effort and throughput are unmeasured. It introduces no general
ownership type, keyed eviction, effectful classifier, total memory bound,
custom equality, or package import mechanism. Broader package interoperability,
item 9 in the API design gap list, remains deferred by user instruction.

## Source surface

This is a builtin contract, not a user-defined generic function:

```text
mapGroups(
  source: Stream<A,E1,R1>,
  key: (A) => K,
  use: (K, Stream<A>) => B fails E2 uses R2,
  { bufferSize: N }
): Stream<B, E1|E2, R1|(R2 minus Scope)>
```

`key` and `use` must be inline callbacks. Their parameter types are supplied
from the source and classifier. The classifier is pure: it adds no typed
failure or requirement. The use callback may fail, require services, and perform
effects. Its result must satisfy the existing recursive data-only predicate,
including records, arrays, tuples, Options, unions, brands, and error records
whose contents are data only. Runtime values such as Streams, Effects, Refs,
Fibers, scopes, functions, and opaque handles cannot occur in that result.

The required final argument is a literal record containing only `bufferSize`.
`N` must be a positive safe integer literal; dynamic, zero, negative,
fractional, and non-finite capacities fail checking. There is no implicit
per-key default. The first slice uses ordinary call syntax, allows the usual
prelude-name shadowing, and adds no pipeline stage.

Illustrative source:

```effective
type Event = { kind: string, value: int }
type Batch = { key: string, items: Event[] }

export const grouped = (source: Stream<Event>): Stream<Batch> =>
  mapGroups(source, (event) => event.kind,
    (key, values) => ({ key, items: collectStream(values) }),
    { bufferSize: 1 })
```

This example needs source completion before collecting whole groups. A
head-only callback can finish a group while the source remains live.

## Key identity and ordering

Permit `string`, `boolean`, and `int`, their aliases, homogeneous literal
unions, and one primitive brand whose base belongs to one of those classes.
Flatten unions and aliases before checking. Every member must have the same
primitive class or the same brand identity. Reject `never` as a key result,
mixed classes, unions of different brands, and unions mixing a brand with its
unbranded base. Numeric literals must be safe integers.

Reject general `number`, records, tuples, arrays, Options, opaque values, and
user-defined equality/hash implementations. This avoids choosing structural
identity or a NaN rule in this slice. It needs a narrower check than existing
comparison compatibility, which also accepts general numbers.

Keys use primitive value equality. String comparison is exact and case
sensitive; `0` and `-0` share a group. Brands retain source nominal checking
and use their underlying primitive at runtime. There is one callback per
distinct key in each execution. Empty input starts none.

Classification observes source element order, and each group receives its
values in that order. Discovery follows first occurrence, but callback start,
effect interleaving, and result order have no ordering guarantee. Results are
merged as ready; an earlier live group cannot hold back a later completed one.
There is no cross-group fairness guarantee.

## Borrowed group use

The second use parameter is a special borrowed local with type `Stream<A>`
and empty deferred failure/requirement channels. Source and producer failures
remain on the outer stream. An ordinary Stream annotation does not remove the
special binding's restrictions.

Allow zero or one syntactic reference to this binding. If present, it must be
the direct first operand of one terminal builtin: `collectStream`, `runStream`,
`foldStream`, `foldEffectStream`, `headStream`, `lastStream`, or `drainStream`.
Resolve the actual builtin; a shadowing function with the same spelling does
not qualify. A sink or fold callback can process values normally, subject to
existing capture rules.

Reject aliases, assignments, aggregates, Refs, returned group values, host
arguments, ordinary helper calls, stream transformations, and captures in
nested closures, deferred effects, or fibers. Even two references in mutually
exclusive branches are rejected. This deliberately conservative rule avoids
introducing flow-sensitive ownership analysis. Ordinary captures of borrowed
resources and Fibers retain their current restrictions.

The data-only result check alone is insufficient: a callback could otherwise
store the stream in an existing Ref and return an integer. Both the reference
rule and result rule are mandatory in the checker and validator.

Before invoking `use`, acquire a group pull in a fresh callback-owned Scope.
Pass a stream backed by that pull. Acquiring the pull installs queue shutdown
even when the callback never references the group. The scope closes when the
callback succeeds, fails, or is interrupted, including after an early terminal
result. A successful result becomes available only after its callback cleanup.

Finishing a callback closes that key permanently for this execution. Later
values for it are discarded; the key does not reopen or start another callback.
Its identity remains in the router until the whole execution ends. Skipping a
group therefore cannot leave an unread queue blocking all later keys.

## Demand, capacity, and lifetime

Construction evaluates the source and options once, in source order, but
performs no pulls, classification, callback work, or service acquisition.
Every terminal execution creates fresh routing, queues, callbacks, and scopes.
One producer routes to all groups; it is never restarted per key.

Run group consumers with unbounded concurrency. `bufferSize` bounds each live
key queue's stored elements. If a live callback pauses and its queue fills,
the producer's next offer waits, delaying other keys behind that offer. The
probe with capacity one observes two upstream pulls, then no later key until
the paused callback resumes. Completion or shutdown of that group releases
the blocked offer.

This is no total memory bound. The current source chunk and classification
batch, pending offers, unbounded key announcements, distinct-key map, active
callbacks, and retained callback results are additional state. The runtime
prototype fixes the merged result queue capacity to one; each blocked worker
can still retain its result. There is no maximum key count, idle timeout,
eviction, reopening policy, or bound on active resources.

Normal source completion ends live group inputs and waits for all callbacks.
A callback that remains live after its input ends can keep the result stream
live. A callback collecting an unbounded group can likewise wait indefinitely.
The API does not infer termination from a finite capacity.

Source or callback failure fails the outer stream and interrupts peers and the
producer. It must not wait for a callback's normal completion to expose that
failure. Downstream early stop, downstream failure, and external interruption
also close the routing lifetime. Terminal completion waits for yielding
callback and source finalizers. Uninterruptible user work may delay cleanup.

Previously delivered results remain observable. Do not manufacture results
for interrupted callbacks or promise delivery of every result racing with a
failure. Defects and interruption remain distinct from typed failures; the
contract does not prescribe ordering or aggregation of simultaneous causes.

## Target lowering and checked channels

The tested runtime composition is:

```text
Stream.groupByKey(source, key, { bufferSize: N })
  -> Stream.flatMap(each group =>
       Stream.fromEffect(Effect.scoped(acquire group pull; use group)),
       { concurrency: "unbounded", bufferSize: 1 })
```

Use the concurrent stream supervisor. An exploratory lowering through pinned
`Stream.mapEffect` with unbounded, unordered callbacks failed the source-error
probe: it waited for a never-ending callback and timed out. Its external
interruption probe also returned before a yielding callback release completed.
That lowering is rejected. The selected `flatMap` composition passes both
cleanup probes as well as the online-result witness. Preserve those gates
when changing target versions or lowering strategy.

The primary oracle is the pinned package source: `Stream.groupByKey`,
`groupByImpl`, `fromQueueShutdownOnEnd`, and `Channel.mergeAll`. Acquiring the
group pull installs a finalizer that shuts its queue; the wrapper then supplies
that same pull to the terminal consumer. No unchecked target cast is needed.

Let active construction channels come from evaluated argument expressions.
They remain active; only deferred source and use channels enter the resulting
Stream. Its error channel is `E1 | E2`. Its requirements are
`R1 | (R2 minus Scope)`: callback-local Scope is supplied by the owned scope.
Do not discharge a Scope requirement belonging to the source or to active
construction. Other callback services remain deferred and resolve under that
terminal execution's bindings. Reusing a derived Stream under different
providers must invoke the corresponding services each time.

Add a `map-groups` IR node with explicit source, inline key/use closures,
positive capacity, and the borrowed group `LocalId`. The group identifier
must be the second use parameter, unique in that closure's bindings. Independent
validation reconstructs parameter, key-class, data-only, reference/capture,
capacity, execution-mode, and active/deferred channel checks. Do not rely on
checker side tables or a forged group identifier to authorize ordinary values.
No new public value type or IR wire-version change is required.

## Implementation gates and review

1. Canonical spec and IR encode this source surface and borrow rule. Checker,
   validator, emitter, and editor recognition implement one slice.
2. Accept primitive/alias/brand keys and direct terminal uses, including skipped
   groups. Reject invalid capacities, effectful keys, incompatible parameters,
   escaping/reused/captured groups, and runtime-containing results.
3. Mutated IR cannot bypass the borrowed binding, key class, Scope discharge,
   or active/deferred channel equations. Ordinary Stream transport is unchanged.
4. Compiled source reproduces fresh routing, per-key order, unused/early-close
   behavior, backpressure, online later-key output, and provider rebinding.
5. Source failure, consumer failure, empty input, early stop, and external
   interruption preserve the tested cleanup barrier. Strict target checking
   and the canonical repository gate pass.

Review when the pinned Effect version changes.
Supersede the decision if a concrete program needs transformed borrowed groups,
stable result ordering, bounded total fan-out, or reusable group authority.
Those contracts need separate witnesses; they must not weaken non-escape or
the cleanup barrier silently. Async aggregation and general Schedule values
remain later queue items.

## Reproduce

```sh
deno task check
deno test --allow-read tests/check_body_test.ts --filter mapGroups
deno test --allow-read tests/validate_test.ts --filter mapGroups
deno test --allow-all tests/emit_slow_test.ts --filter mapGroups
deno test --no-lock docs/plans/group-probes/contract.ts
deno test --no-lock docs/plans/stream-schedule-probes/target.ts
deno test --no-lock --allow-all docs/plans/stream-schedule-probes/source_slow_test.ts
```

The nine grouping probes pass under the pinned versions. Five focused checker
tests, two IR validator tests, and four compiled-source runtime tests cover the
implemented rule. The tests do not establish a total memory or performance
bound.
The canonical repository gate passes 1,095 fast tests and 97 slow tests under
Deno 2.9.7. All 17 focused grouping and Stream/Schedule probes pass. The
canonical specification site passes 11 tests and 30 strict illustrative units.

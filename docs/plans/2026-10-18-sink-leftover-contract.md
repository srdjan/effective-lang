# Sink leftovers and synchronous transduction contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: implemented in design draft 0.35. The compiler accepts the fifth Sink
argument, `takeSink`, and `transduceStream`; canonical spec and IR are updated.

## Decision and evidence

Append a leftover type to the existing Sink application:

```text
Sink<Input, Output, Errors = never, Requirements = never, Leftover = never>
```

Keep all existing argument positions and defaults. Add a positive-count
`takeSink` constructor and synchronous `transduceStream` consumption. Terminal
`runStream` continues to return one sink result and discard leftovers.

The user-visible problem is a reusable sink that finishes partway through a
pulled chunk. A four-argument source Sink fixes its leftover channel to `never`; the target's
`Sink.take(2)` needs the explicit fifth argument to satisfy the declared type. The primary acceptance measure is
lossless, ordered replay of leftovers across successive sink runs, with the
same sink value reusable across separate stream consumptions. Guardrails are
unchanged four-argument Sink meaning, preserved active/deferred channels,
checked replay compatibility, and completed cleanup on failure or interruption.

The [original audit](2026-10-18-general-stream-schedule-design.md#arbitrary-sinks-preserve-the-leftover-channel)
establishes the compiler and strict-target boundary. Nine additional
[target contract tests](sink-leftover-probes/contract.ts) support this decision,
including positive and negative target type assertions. The
[source fixtures](../../fixtures/emit/sinks/) and
[strict target/runtime tests](../../tests/emit_slow_test.ts) now verify the
implemented contract through compiled source and the existing host boundary.

## Alternatives and accepted trade-offs

| Option | Value and cost | Disposition |
| --- | --- | --- |
| Keep Sink unchanged and implement fixed batching with ordinary state | Avoids type changes and can reproduce finite arrays of pairs. | Does not represent a reusable host Sink with leftovers. |
| Insert Leftover before Errors or Requirements | Resembles the target's parameter order. | Rejected: changes the meaning of existing source annotations. |
| Introduce a separate transducer type with leftovers equal to input | Smaller initial type surface, but duplicates the Sink abstraction and needs a conversion boundary for host values. | Not selected; replay requires compatibility, not equality. |
| Append Leftover with a `never` default | Preserves source compatibility and supports arbitrary leftover types at terminal execution. Extends every Sink type traversal and compatibility check. | Selected; transduction separately checks that leftovers fit sink input. |

This slice covers synchronous transduction. Async aggregation and general
sink-building callbacks remain separate work. It uses the existing typed
service/provider boundary for other sinks. Broader package interoperability
(item 9 in the API gap list) is deferred by user instruction.

## Source surface and inference

The contracts below are builtin rules, not user-defined generic functions:

```text
takeSink(count): Sink<I, I[], never, never, I>
transduceStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>): Stream<O,E1|E2,R1|R2>
runStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>): O
```

Both consumers require `A` assignable to `I`. Transduction additionally requires
`L` assignable to `I`, since each leftover is an input to another sink run.
It need not be assignable to the narrower original source element type `A`.
Terminal execution imposes no leftover/input compatibility constraint because
it does not replay leftovers. The output `O` can differ from either input type.

`takeSink` needs a positive safe integer literal count. Zero, negative,
fractional, dynamic, and non-finite counts are outside this first source rule.
This prevents the native constructor from producing an immediate, non-consuming
sink. The source adds no runtime count error or arbitrary target normalization.

Its input `I` comes from an expected Sink type, such as a binding annotation,
function result, or parameter position. `transduceStream` supplies its source
element type as an input hint to an inline `takeSink` call. It does not force
an independently typed sink to have exactly that input or an array output.
An uncontextualized `const pairs = takeSink(2)` needs a type annotation; the
count alone cannot determine its input type. No explicit generic call syntax
is added.

This source program retains the leftover type:

```effective
type Int = int
type Pairs = Sink<Int, Int[], never, never, Int>
const pairs: Pairs = takeSink(2)

export const batches = (source: Stream<Int>): Stream<Int[]> =>
  transduceStream(source, pairs)
```

`Sink<Int, Int[]>` still means no leftovers and cannot annotate that constructor.
To spell a fifth argument, write both channel placeholders explicitly. Omitting
Errors or Requirements retains the existing grammar and defaults; no slot is
reinterpreted. Sink aliases remain runtime-only and have no derived Schema.

Both new operations use ordinary call syntax and allow existing source
bindings to shadow their prelude names. The first slice does not add pipeline
stages for them; `runStream` retains its current call-only rule.

## Type and boundary rules

Sink compatibility remains contravariant in input and covariant in output,
failures, and requirements, and becomes covariant in leftovers. In particular,
a no-leftover sink can fit a type permitting leftovers; the reverse is invalid.
Failure and requirement compatibility uses the existing subset rules.

Source-to-target mapping is explicit:

```text
Source: Sink<I,O,E,R,L>
Target: Sink.Sink<O,I,L,E,R>
```

Strict host assertions must preserve all five positions. The target probe
accepts a sink with `string | number` input and leftovers on a string source.
A numeric-input sink with string leftovers can run terminally but cannot
transduce numeric input. These rules require no unchecked target casts.

Sink values retain existing value transport and borrow restrictions. Returning
or storing one does not authorize capture of a borrowed resource or Fiber.
Host implementations remain responsible for honoring their declared types and
allocating run-local state inside each transform invocation.

## Execution, demand, and completion

Construction evaluates source and sink expressions once, left to right, but
does not pull the source, run a sink transform, or acquire its required services.
Each terminal consumption creates fresh upstream state. Each requested output
invokes the reusable sink transform anew. `takeSink` allocates a fresh array
per invocation, rather than sharing a partially filled array across runs.

A sink may read a chunk beyond its stopping point. Its returned leftovers
become the first input to the next sink invocation, ahead of a new upstream
pull. For pairs from one chunk `[1,2,3,4,5]`, the probe records:

```text
pull:0, batch:1,2, batch:3,4, pull:1, batch:5
```

Synchronous transduction adds no producer fiber, queue, or read-ahead task.
It does not impose new chunking on the source. Existing upstream operations
may already buffer or run concurrently. The first slice adds no memory bound
beyond the selected operators and target chunk sizes.

Preserve the pinned target's completion results with `takeSink(2)`:

| Source values | Output batches |
| --- | --- |
| `[1,2,3,4,5]` | `[[1,2],[3,4],[5]]` |
| `[1,2,3,4]` | `[[1,2],[3,4],[]]` |
| `[]` | `[[]]` |

Exact-sized input can require a fresh sink run to discover upstream completion;
that run emits the empty result. The contract does not filter such outputs.
The probe checks multiple chunk sizes and repeated consumption. Arbitrary sinks
determine their own completion result; the consumer does not synthesize a
generic partial or empty value.

Terminal `runStream` performs one sink run, discards its leftover values, and
closes the producer without executing its remaining continuation. It exposes
neither a resumable stream nor a continuation handle.

### Failures and interruption

Already emitted results remain observable before a later typed failure. With
`takeSink(2)`, a source yielding `1,2,3` and then failing emits `[1,2]`, then `[3]`,
then propagates the source failure. The pinned transducer lets the sink finish
when its upstream reports a typed failure, then exposes that pending failure
on the next demand. A sink can itself fail while attempting to finish; this
slice preserves target behavior rather than promising to combine every cause.

A sink failure does not emit an invented result for its incomplete run. Defects
and interruption remain distinct from typed failures. The probe observes a
source defect after `[1,2]` without emitting its incomplete `[3]`. Interruption
does not force a final partial batch.

Service requirements stay deferred until consumption and use that execution's
bindings. They are not captured when the Sink or derived Stream is constructed.
The effectful host-sink probe fails on its third input under one provider and
consumes the same value afresh under a different provider.

### Resource lifetime

Fresh sink state does not imply a fresh resource scope for every result. The
pinned `Stream.transduce` passes its enclosing consumption scope into each
sink transform. Finalizers registered in that scope remain until the whole
consumption ends, then run under the target strategy. The probe records:

```text
start:1, batch:1,2, start:2, batch:3, release:2, release:1
```

Retain that behavior. A sink that needs release before its individual result
must bracket that resource inside its transform. Repeated scope registrations
can retain resources through a long-lived stream; the source type does not
promise bounded resource retention. Downstream failure and interruption wait
for yielding sink finalizers and cleanup of an active upstream pull.

### Zero-progress host sinks

An arbitrary typed host sink may finish without consuming input, or return all
its input as leftovers. Transduction does not guarantee progress or termination
from its type. The pinned target can repeatedly emit such sink results without
pulling new input; it may never discover source completion. The probe bounds
`Sink.succeed("tick")` with a downstream take and observes three outputs and
zero upstream pulls. `Sink.take(0)` similarly emits empty batches indefinitely
under transduction, which is why the native constructor rejects zero.

Do not silently drop these outputs, insert a typed error, or add a progress
watchdog. Host sinks and their callers remain responsible for progress or a
bounded downstream consumer. A stronger guarantee needs a separate contract.

## Checked channels and IR

Let construction effects be the union of the evaluated source and sink
expressions. `takeSink` is pure with empty active channels. `transduceStream`
retains construction effects as active and stores source/sink failure and
requirement unions in its resulting Stream. `runStream` activates both deferred
channel sets along with construction effects and always executes in effect
mode. Leftovers add a value type, not a failure or service requirement.

The IR Sink type has an optional `leftover: Type` field, with absence meaning
`never`. Default no-leftover payloads omit that field; existing four-argument
interfaces and hashes retain their meaning. Interning, compatibility, independent
validation, and emission normalize absence identically. Input, output, and leftover types all participate in graph walks,
depth checks, serialization, and diagnostic printing. The IR wire version remains 2 with this additive optional field.

The `take-sink` node carries the checked positive literal count;
`transduce-stream` has explicit stream/sink operands. Closed annotations provide the constructor
input type without checker side tables. The independent validator checks count,
result/leftover shape, input compatibility, replay compatibility, execution
mode, and active/deferred equations. It rejects omitted or forged leftover annotations on a producing constructor. Existing `sink-for-each` still has
leftover `never`.

Emission uses `Sink.take<I>(count)` and explicit `Stream.transduce` type
arguments retaining the sink's wider input `I`. Construction preserves argument
order. `runStream` accepts any leftover channel and discards it without erasing
its operand's declared target type.

## Acceptance and next work

Spec, parser, types, checker, IR/lowering, independent validator, emitter, and
editor recognition implement one source slice. Verification covers:

1. Old Sink annotations and serialized payloads keep their meaning; leftover
   variance and all type traversals are covered, including imports and aliases.
2. Annotated and contextually inferred `takeSink` compile; missing input context
   and invalid counts fail before emission. A default no-leftover annotation
   cannot hide produced leftovers.
3. Source transduction preserves the chunk/replay/completion traces and repeated
   execution, with construction versus consumption channels checked separately.
4. Typed host sinks retain deferred failures and services. Replay-incompatible
   leftovers are rejected for transduction and permitted for terminal execution.
5. Source failure, sink failure, defect, early stop, and interruption preserve
   observed output and cleanup. Scoped finalizers retain the tested lifetime.
6. Mutated IR fails independent validation; emitted source passes strict Effect
   checks and runtime witnesses, followed by the canonical repository gate.

Review this decision when a counterexample breaks
replay, channel preservation, compatibility, or resource lifetime. Supersede it
if a bounded-progress or per-result resource contract becomes necessary.
Async `aggregate`/timed flushing, custom source sink constructors, and live
grouping remain separate designs. General package imports remain deferred.

The canonical gate passes 1,088 fast tests and 93 slow tests under Deno 2.9.7.
All 17 focused Sink/Stream/Schedule probes also pass, including the nine contract
tests. Four new compiled-source runtime tests cover the slice.

## Reproduce

```sh
deno task check
deno test --no-lock docs/plans/sink-leftover-probes/contract.ts
deno test --no-lock docs/plans/stream-schedule-probes/target.ts
deno test --no-lock --allow-all docs/plans/stream-schedule-probes/source_slow_test.ts
```

The oracle is the pinned package source and executable probes. Related source
contracts are the [initial Stream/Sink design](2026-10-17-stream-design.md) and
the [current gap audit](../effect-4-gap-audit.md#follow-up-queue).

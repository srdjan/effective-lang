# Effect 4 expressiveness audit

Research snapshot: 2026-10-17. Compiler: this repository, Deno 2.9.7. Target: `effect@4.0.5`, the version used by `build --tsc` and the slow emitter tests. This is a representative audit of native `.eff` source, not an inventory of every Effect export.

Update, 2026-10-17: language core 1 is specified in design draft 0.3.
The compiler emits and validates `light-functional-ir` version 2. The coverage
map below reflects the implemented core 1 slices. The probes later in this
document remain the original audit snapshot.

Update, 2026-10-18: design draft 0.4 adds unbounded `traverse`. The compiler
accepts only the literal `{ concurrency: "unbounded" }`, validates it in IR,
and emits `Effect.forEach` with that option. A runtime test covers full startup,
input-order results, failure and interruption cleanup, and an empty input.
Homogeneous `Effect.all` work can be expressed by traversing Effect values
with `run`. Heterogeneous tuple and record collection remained open at this step.

Update, 2026-10-18: design draft 0.5 adds `all` for tuple, record, and
array collections of first-class Effect values. The compiler preserves result
shape and unions failure and requirement channels. Its independent validator
checks the closed builtin signature and literal concurrency option. A runtime
test covers tuple and record results and sibling cleanup. `Effect.forkScoped`,
raw `Scope`, and non-default `Effect.all` error modes remained open at this step.

Update, 2026-10-18: design draft 0.6 adds `scoped` and `forkScoped`.
`forkScoped` requires a reserved Scope capability and accepts an Effect value
without typed failures. `scoped` supplies that capability and closes the local
scope. A runtime test confirms a child can outlive its spawning fiber and is
interrupted with finalizer completion when its scope closes. Raw `Scope` values,
explicit `Scope.close`, and non-default `Effect.all` error modes remained open at this step.

Update, 2026-10-18: design draft 0.7 adds `zipStreams` for streams with
different element types. It preserves ordered pairs and unions deferred
failure and requirement channels. Runtime tests confirm deferred production,
shorter-input termination, and interruption of the peer after failure.
Other stream combinators remain open.

Update, 2026-10-18: design draft 0.8 adds `concatStreams`. It emits all left
elements before starting the right stream, unions different element types and
deferred channels, and skips the right stream if the left fails. A strict
target and runtime test verifies both completion and failure paths.

Update, 2026-10-18: design draft 0.9 adds bounded and unbounded `mapEffect` and `flatMapStreams`.
An inline pure callback constructs each inner Stream. The result combines
outer and inner deferred channels. Runtime tests verify inner pull order,
failure cutoff, and interruption cleanup. Concurrent flatMap and switch
behavior remain open.

Update, 2026-10-18: design draft 0.10 adds `partitionAll` for homogeneous
arrays of Effect values. It runs every job and returns ordered successes and
typed errors as data, with combined service requirements and no typed failure
channel. A literal concurrency option bounds simultaneous jobs. The checker,
independent IR validator, strict target check, and runtime test cover the form.
Accumulated errors in the failure channel were deferred at this step.

Update, 2026-10-18: design draft 0.11 adds `validateAll`. It uses
`Effect.validate` to run a homogeneous array of Effect jobs and collect all
typed failures. A pure source callback wraps the nonempty error array in a
nominal error so the result fits Effective's failure contracts. The checker,
independent IR validator, strict target check, and runtime test cover both
success and accumulated failure with a literal concurrency bound.

Update, 2026-10-18: design draft 0.12 adds `allResults` for Effect tuples,
records, and homogeneous arrays. It emits `Effect.all` in result mode, retaining
each success or typed failure at its input position as a tagged record union.
The checker and independent IR validator preserve shape and combined service
requirements while removing typed job failures from the active channel. Strict
target and runtime tests cover all three collection shapes and sibling work
after a typed failure. The `Effect.all` discard option has no direct source
form; a final block binding can evaluate `all` and return void.

Update, 2026-10-18: design draft 0.13 adds `takeStream` for bounded stream
consumption. It accepts a pure dynamic Int count and retains the source's
deferred channels. Zero and negative counts do not pull the source. A strict
target and runtime test confirms bounded pulls, failure cutoff, and completion
of started pull finalizers. The checker and independent IR validator enforce
the type and purity rules.

Update, 2026-10-18: design draft 0.14 adds `takeWhileStream` for a prefix
selected by an inline pure boolean predicate. The first rejected element is
consumed but omitted, and later elements are not pulled. Strict target and
runtime checks cover deferred execution, typed failure before the boundary,
and completion of started pull finalizers. The checker and independent IR
validator enforce predicate purity, result type, and deferred channels.

Update, 2026-10-18: design draft 0.15 adds inclusive `takeUntilStream`.
An inline pure boolean predicate stops at the first matching element, which
remains in the output. Strict target and runtime checks cover deferred
execution, a missing match, failure before a match, and finalizer completion.
The checker and independent IR validator preserve deferred channels.

Update, 2026-10-18: design draft 0.16 adds `dropStream` with a pure dynamic
Int count. Nonpositive counts leave the source unchanged; positive counts
consume a prefix before emitting the remainder. Strict target and runtime
tests cover exhaustion, failure in a discarded prefix, deferred execution,
and started pull finalizers. The checker and independent IR validator enforce
the count and deferred channels.

Update, 2026-10-18: design draft 0.17 adds `dropWhileStream` for an initial
prefix selected by an inline pure boolean predicate. The first false element
and every later element are emitted. Strict target and runtime tests cover
deferred execution, an immediately false predicate, an all-true prefix,
failure while dropping, and finalizer completion. The checker and independent
IR validator preserve deferred channels and enforce predicate purity.

Update, 2026-10-18: design draft 0.18 adds `filterStream` with an inline pure
boolean predicate. Each source element is tested during consumption, accepted
elements retain order, and failures after rejected elements still propagate.
Strict target and runtime tests cover deferred execution, matching and empty
output, failure, and finalizer completion. The checker and independent IR
validator preserve deferred channels.

Update, 2026-10-18: design draft 0.19 adds pure `mapStream`. An inline
callback changes the stream element type without adding deferred failures or
requirements. Strict target and runtime tests cover deferred execution,
ordered values of a new type, source failure, and started pull finalizers.
The checker and independent IR validator enforce callback purity and preserve
the source's deferred channels.

Update, 2026-10-20: `takeWhileStream`, `takeUntilStream`, `dropWhileStream`,
`filterStream`, and `mapStream` are removed from the prelude. The
`takeWhileEffectStream`, `takeUntilEffectStream`, `dropWhileEffectStream`,
`filterEffectStream`, and `mapEffect` forms accept pure callbacks. With a pure
callback that has empty failure and requirement sets, the checker records the
pure operation, so the general form compiles to `Stream.takeWhile`,
`Stream.takeUntil`, `Stream.dropWhile`, `Stream.filter`, and `Stream.map`. A
pure predicate keeps the stream type, so a stream alias survives. A
`concurrency` option keeps `mapEffect` as `Stream.mapEffect`. The IR, the
validator, and the emitter are unchanged. The 0.14 to 0.19 entries above
describe the removed names and stay as history.

Update, 2026-10-18: design draft 0.20 adds pure `scanStream`. It evaluates a
lazy seed for each consumption, emits that seed before pulling, and then emits
each updated state. Strict target and runtime tests cover fresh state, empty
sources, source failure, and started pull finalizers. The checker and IR
validator enforce update purity and preserve deferred source channels.

Update, 2026-10-18: design draft 0.21 adds pure `mapAccumStream`. An inline
callback threads state and emits zero, one, or many values per source element.
Strict target and runtime tests cover deferred construction, fresh state,
ordered outputs, empty sources, source failure, and pull finalizers. The
checker and independent IR validator enforce the tuple result and preserve
deferred source channels.

Update, 2026-10-18: design draft 0.22 adds terminal `foldStream`. A lazy seed
and pure update reduce a stream to one final value. Strict target and runtime
tests cover repeated execution, the empty-source seed result, typed failure,
and pull finalizers. The checker and independent IR validator move deferred
source failures and requirements into the active effect contract.

Update, 2026-10-18: design draft 0.23 adds terminal `foldEffectStream` with an
effectful update callback. Strict target and runtime tests cover sequential
updates, fresh state, empty input, source and callback failures, stopping
later pulls, and pull finalizers. The checker and independent IR validator
combine source and callback failures and service requirements in the active
effect contract.

Update, 2026-10-18: design draft 0.24 adds terminal `collectStream`. Strict
target and runtime tests cover deferred construction, ordered output, a fresh
array per execution, empty input, source failure, and pull finalizers. The
checker and independent IR validator move source failures and requirements
into the active effect contract.

Update, 2026-10-18: design draft 0.25 adds terminal `headStream`. Strict
target and runtime tests cover deferred construction, first-element output,
early stop, empty input, source failure, repeated execution, and pull
finalizers. The checker and independent IR validator move source failures
and requirements into the active effect contract.

Update, 2026-10-18: design draft 0.26 adds terminal `lastStream`. Strict
target and runtime tests cover deferred construction, final-element output,
full consumption, empty input, source failure after prior elements, repeated
execution, and pull finalizers. The checker and independent IR validator move
source failures and requirements into the active effect contract.

Update, 2026-10-18: design draft 0.27 adds terminal `drainStream`. Strict
target and runtime tests cover deferred construction, full consumption with
discarded values, void output, empty input, source failure after prior pulls,
repeated execution, and pull finalizers. The checker and independent IR
validator move source failures and requirements into the active effect contract.

Update, 2026-10-18: design draft 0.28 adds literal bounded and unbounded
concurrency options to `mapEffect` and `flatMapStreams`. Strict target
and runtime tests cover bounded active work, ordered mapping output,
concurrent inner streams, failure interruption, and finalizer completion.
The checker and independent IR validator verify the bound.

Update, 2026-10-18: design draft 0.29 adds effectful stream filtering and
prefix predicates. Strict target and runtime tests cover each operation's
selection or stopping rule, deferred source and predicate channels, empty
input, typed predicate failure, and pull finalizers. The checker and
independent IR validator combine the deferred channels.

Update, 2026-10-18: design draft 0.30 adds `switchMapStreams`. Strict
target and runtime tests confirm that a new outer element interrupts the
previous active inner, emitted values come from the latest inner, source
failure closes active work, and finalizers complete before return. The
checker and independent IR validator combine outer and inner deferred
channels.

Update, 2026-10-18: design draft 0.31 adds `catchStream`. A typed source
failure switches to a replacement stream after keeping earlier values.
Strict target and runtime tests cover deferred execution, repeated runs,
replacement failure, and finalizer completion. The checker and independent
IR validator remove source failures and retain recovery failures and both
service sets.

Update, 2026-10-18: design draft 0.32 adds `retryStream` with a source
`RetrySchedule<E>`. Strict target and runtime tests cover deferred
construction, replayed values, schedule reset after output, repeated
consumption, and completed pull finalizers. The checker and independent IR
validator enforce nominal error compatibility and preserve deferred source
channels.

Update, 2026-10-18: design draft 0.33 adds `debounceStream` and
`throttleStream`. The latter rechunks to one element before applying a token
bucket so its configured units count elements, not source chunks. Strict
target and runtime tests cover synchronous burst coalescing, enforced drops,
shaped delivery, and deferred construction. The checker and independent IR
validator enforce nonnegative or positive literal millisecond settings and
preserve source channels.

Update, 2026-10-17: `bufferStream` and `mergeStreams` now compile to Effect 4
streams. A slow runtime test covers deferred production and per-source order.
The original probes remain the audit snapshot.
Update, 2026-10-17: `race` now accepts compatible first-class Effect values.
The runtime regression confirms loser interruption and finalizer completion.
Other unbounded concurrent compositions remain a gap.
Update, 2026-10-17: `Ref<A>` and source make/get/set/update operations now
compile. Ref is invariant, and update requires a pure callback. A bounded
concurrency runtime test checks atomic updates.
Update, 2026-10-17: `fixtures/host-adapter-files/` demonstrates a typed
`effect/FileSystem` host adapter with Node services, input validation, and
nominal error translation. The CLI's target check pins the Node platform
package to 4.0.5. This covers one operation, not general ecosystem parity.
Update, 2026-10-17: source `Layer<Services,E,R>`, `layer`, `mergeLayers`, and
expression-valued `provide` now compile. Acquisition channels are retained,
and overlapping service sets are rejected.
Update, 2026-10-17: `RetrySchedule<E>` and `retrySchedule` now author a
conditional millisecond retry policy. Pure `Codec<Decoded,Encoded>` values
validate both directions with derived schemas. `withFiber`, `joinFiber`, and
`interruptFiber` supervise a child and restrict its handle to the inline use
callback. Host interfaces can declare opaque handles and borrow-qualified
methods; `withResource` can pass those handles through checked source helpers.
Strict target checks and runtime tests cover these slices.

Update, 2026-10-17: the pipeline validation defect described below was fixed
in phase 1 of the [implementation plan](plans/2026-10-17-effect4-gap-closure.md).
The original probe is retained as historical evidence. The current
`build --validate --tsc` regression passes for that source.
Phases 2 and 3 add bracket array and contextual tuple literals and sequential
effectful `traverse`. Phase 4 adds first-class `Effect<A,E,R>` values through
`defer` and `run`. Phase 5 adds scoped operation records through
`withResource`. Phase 6 adds bounded concurrent `traverse`. Phase 7 adds
incremental `Stream` and `Sink` values through `unfold`, `mapEffect`,
`sinkForEach`, and `runStream`. General borrowed scopes and concurrency,
broader stream combinators and general Effect
combinators remain native gaps. The original probes below remain the audit
snapshot and should be read with these updates.

## Answer and boundary

**Yes. There are valid Effect 4 programs whose behavior and typed API cannot
currently be authored in Effective source.** General stream combinators, raw
`Scope` values, recursive Option data, and direct ecosystem
package APIs remain examples. Effective
now supports the selected core 1 forms in the
[language spec](../../effective/public/effective-spec.html#core1) and
[typed IR](../src/core/ir.ts). Effect's documentation describes the broader
[concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency),
[stream](https://effect.website/docs/v4/stream/introduction), and
[scope](https://effect.website/docs/v4/resource-management/scope) APIs.

Here, **native support** means a program can be written in `.eff`, checked with its intended contract, and emitted to equivalent Effect behavior. A host TypeScript module may implement any of these behaviors behind an Effective service, but that implementation is then authored in TypeScript. This distinction matters for ecosystem coverage. The `host:` boundary accepts declared providers, service tags, and opaque types from a registered interface; it does not import arbitrary package functions or Effect constants. `.effi` still rejects `const`, and imports accept only relative `.eff` files or registered `host:` modules. A service method can return a nested Effect value ([parser](../src/core/parse.ts), [project linker](../src/core/project.ts), [emitter](../src/core/emit/decls.ts)).

This is an expressiveness result for the current language and compiler, not a
claim that an Effective application cannot _use_ these services through an
adapter. It also does not claim that every Effect combinator needs a same-named
Effective construct. An equivalent composition in `.eff` would count as support.

## Remaining and deferred gaps

Current disposition: 2026-10-19, design draft 0.57, `effect@4.0.5`.
This section consolidates the remaining boundaries after all three
[application gates](plans/2026-10-19-application-acceptance-rule.md) passed.
Earlier update entries and probe diagnostics describe their original snapshots.
The tables below are a record of gaps, not an implementation queue.

### Open API and language gaps outside the accepted target

| Area | Remaining boundary | Existing support and evidence |
| --- | --- | --- |
| General Effect and concurrency APIs | Other first-class combinators, coordination primitives and cause-level recovery APIs lack general source forms. | Effect values, collections, racing, supervised fibers and scope-bound children cover the selected subset. See the [coverage map](#coverage-map). |
| Full Scope parity | Supplied close Exits, exit-aware callbacks, parallel finalization strategies, mandatory closure and static dependency-cycle detection remain outside the selected contract. | Shared CloseableScope authority closes once with Exit.void and caches cleanup completion. See the [ownership contract](plans/2026-10-18-scope-ownership-contract.md). |
| General Stream and Sink APIs | Other operators, arbitrary source Sink constructors, chunk-cost throttling and unrestricted nested group streams need additional source and lifetime rules. | Leftovers, transduction, aggregation and callback-owned keyed groups are implemented. Selected external interruption has a source composition. See the [investigation](plans/2026-10-18-general-stream-schedule-design.md). |
| General Schedule APIs | Opaque Schedule consumers for retry and repetition, composition with incomparable input types, other combinators and cron policies remain uncovered. | RetrySchedule and a concrete source repetition policy meet the worker gate. General schedules support aggregation and selected comparable-input composition. See the [worker limits](plans/2026-10-19-scheduled-worker-application.md#disposition-and-limits). |
| Time control | A general source clock and time-control API remains a candidate without a demonstrated application blocker. | Primitive clock services and native virtual-time checks cover the selected applications. See the [accepted rule](plans/2026-10-19-application-acceptance-rule.md#feature-selection). |
| Schema and recursion | Recursive Option data, mutual recursion, arbitrary self-bearing transformations and general Schema AST construction remain unsupported. | Guarded recursion preserves separate decoded, encoded and make-input types through selected adapters. See the [recursive field contract](plans/2026-10-19-schema-recursive-adapters-contract.md). |
| General language extensions | User-defined generics, effect-row polymorphism, source purity assertions, macros and early returns remain deferred language extensions. | Builtin generic types and concrete source compositions cover the accepted applications. The [specification](../../effective/public/effective-spec.html#examples) retains the broader language boundary. |

Reopen an item only for a demonstrated application blocker or an explicit
change to the accepted target. First check equivalent existing source
compositions. Record a minimal witness, intended contract, observed diagnostic
or behavior, and the required failure, cancellation and cleanup semantics.
No item has an automatic priority or implementation commitment.

### Explicit user deferral: item 9

Broader package interoperability remains deferred until the user revisits it.
This covers arbitrary external package imports, external values and constructors,
and package-specific API objects or builders authored directly in source.
Direct source composition of HTTP, SQL, RPC, AI and observability builders
belongs to this deferral.
The registered typed host interface remains available for concrete adapters.
The [adapter investigation](plans/2026-10-18-schema-ecosystem-design.md) records
the supported route and its limits.

A new application blocker does not revoke the explicit deferral of item 9.
The user must change that instruction before broader interoperability work starts.

### Runtime behavior and evidence limits

These are limits of the selected witnesses, not automatically selected features.
The three application gates establish neither complete Effect API parity nor
external integration coverage.

| Boundary | Recorded behavior or evidence limit |
| --- | --- |
| Typed recovery and mixed causes | Native catchTags can select a typed reason and discard an accompanying defect. The stream witness records this limit. Its session finalizers run outside item recovery. |
| Transaction cancellation | Body interruption awaits rollback and release. Interruption after COMMIT starts can preserve a committed row. The simulated COMMIT error proves no retry, not actual ambiguous-commit behavior. |
| Stream failure and buffering | Native transduction can emit a partial batch before upstream failure. The pinned backpressure trace establishes no global memory bound. |
| Delivery guarantees | The applications promise neither exactly-once delivery nor rollback of earlier successful batches. |
| External services | Recording drivers and local adapters perform no external HTTP, database, RPC, AI or telemetry integration acceptance checks. |

The [service workflow](plans/2026-10-19-service-workflow-application.md#disposition-and-limits)
and [stream processor](plans/2026-10-19-stream-processor-application.md#disposition-and-limits)
record these boundaries with compiled checks.

### Separate release acceptance

Editor behavior, packaging, performance and external integration acceptance
remain separate work. Passing the application gates does not establish their
completion or declare existing editor and packaging implementations absent.
This gap record selects no release task or additional language implementation.

## Coverage map

| Effect 4 program family                                                                 | Native Effective status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Limiting boundary and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Host route                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary typed effects, service calls, tagged failures, recovery, and fixed-count retry | **Supported subset.** Effective emits `Effect`, `Context`, `Layer`, `Option`, and `Schema`; its examples cover these forms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [Examples](../fixtures/examples/), [emitter import set](../src/core/emit/scope.ts#L26), [source control rules](../../effective/public/effective-spec.html#control).                                                                                                                                                                                                                                                                                                                                                                                                 | Host supplies the provider and invokes exported entry functions.                                                                                             |
| First-class Effect values and general combinators                                       | **Partial.** `Effect<A,E,R>`, `defer`, and `run` let source construct, store, pass, return, and execute a typed Effect value. General Effect combinators remain absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [IR type model](../src/core/ir.ts#L31), [spec: execution](../../effective/public/effective-spec.html#execution), [Phase 4 runtime test](../tests/emit_slow_test.ts); Effect [the Effect type](https://effect.website/docs/v4/getting-started/the-effect-type). The original probe below predates Phase 4.                                                                                                                                                                                                                                                           | Host may expose a specific composed operation as a service method.                                                                                           |
| Concurrency, racing, fibers, interruption                                               | **Supported core 1 subset.** Bounded and unbounded `traverse`, heterogeneous `all` and `allResults` over Effect tuples and records, `partitionAll` and `validateAll` over homogeneous arrays, `race`, supervised `withFiber`, and scope-bound `forkScoped` are native. Discarding an `all` result is expressible with a block.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency) and [fibers](https://effect.website/docs/v4/concurrency/fibers).                                                                                                                                                                                                                                                                                                   | A service can expose other concurrent policies.                                                                                                              |
| Effectful collection traversal                                                          | **Supported sequentially and concurrently.** `traverse` accepts effectful callbacks and preserves their failure and requirement sets. `map`, `filter`, and `fold` still require pure callbacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [Spec: collections](../../effective/public/effective-spec.html#pipelines), [prelude names](../src/core/resolve.ts#L53), [Phase 3 runtime test](../tests/emit_slow_test.ts); Effect [`forEach`](https://effect.website/docs/v4/code-style/control-flow). The original `filter` probe still fails.                                                                                                                                                                                                                                                                    | A host service can expose other traversal policies.                                                                                                          |
| Streams and sinks                                                                       | **Supported core 1 subset.** `unfold`, `mapEffect`, `mapGroups`, `scanStream`, `mapAccumStream`, `foldStream`, `foldEffectStream`, `collectStream`, `headStream`, `lastStream`, `drainStream`, `sinkForEach`, `takeSink`, `transduceStream`, `aggregateStream`, `aggregateWithinStream`, `runStream`, `bufferStream`, `mergeStreams`, `zipStreams`, `concatStreams`, bounded and unbounded `mapEffect` and `flatMapStreams`, `switchMapStreams`, `catchStream`, `retryStream`, `debounceStream`, `throttleStream`, `takeStream`, `dropStream`, `filterEffectStream`, `takeWhileEffectStream`, `takeUntilEffectStream`, and `dropWhileEffectStream` are native. Other stream combinators remain absent. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [streams](https://effect.website/docs/v4/stream/introduction) and [sinks](https://effect.website/docs/v4/sink/introduction).                                                                                                                                                                                                                                                                                                                   | A host adapter can expose other stream policies.                                                                                                             |
| Resource scopes and finalizers                                                          | **Supported core 1 subset.** `withResource` scopes operation records and opaque host handles; borrow-qualified methods and checked source helpers prevent handle escape. `scoped` supplies a local scope for `forkScoped` jobs. `CloseableScope` and make/provide/register/close operations add manual shared authority across roots. General close Exits and raw Scope composition remain deferred.                                                                                                                                                                                                                                                                                                                                                                                         | [Core 1 spec](../../effective/public/effective-spec.html#core1), [borrow runtime test](../tests/cli_slow_test.ts), [scoped fiber runtime test](../tests/emit_slow_test.ts); Effect [scope](https://effect.website/docs/v4/resource-management/scope).                                                                                                                                                                                                                                                                                                               | A host adapter owns the handle and its operations.                                                                                                           |
| Schedules and timed repetition                                                          | **Supported core 1 subset.** `retrySchedule` authors a pure retry policy. Four-channel `Schedule` values use `scheduleFromStep`, `scheduleRecurs`, `scheduleSpaced`, and `scheduleMap`; binary `scheduleMax`, `scheduleMin`, and `scheduleConcat` compose policies with comparable inputs. `aggregateWithinStream` is their first consumer. General input intersections, other consumers, and cron policies remain absent.                                                                                                                                                                                                                                                                                                                                                                   | [Schedule contract](plans/2026-10-18-general-schedule-contract.md), [composition contract](plans/2026-10-18-schedule-composition-contract.md), [runtime test](../tests/emit_slow_test.ts); Effect [schedules](https://effect.website/docs/v4/scheduling/using-schedules).                                                                                                                                                                                                                                                                                           | Host can implement other policies.                                                                                                                           |
| Mutable concurrent state                                                                | **Supported core 1 subset.** `Ref<A>` and make/get/set/update operations are native; update is atomic under bounded traversal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime test](../tests/emit_slow_test.ts); Effect [`Ref`](https://effect.website/docs/v4/state-management/ref).                                                                                                                                                                                                                                                                                                                                                                                   | Other state primitives can live in services.                                                                                                                 |
| Schema codecs, filters, and transformations                                             | **Supported core 1 subset.** Pure `Codec` remains; four-channel `Schema` values compose exact optional and required records, arrays, general ordered unions, effectful transformations, optional getters, missing-key defaults, and guarded required-encoded to optional-decoded fields with bounded authored Schema issues. Runners use `SchemaError` and separate decode and encode services. Nullable optional keys now have explicit preserve-null and null-as-missing policies. Default encoding supports passthrough and unconditional omission. Missing-or-null defaults now return required nonnullable decoded fields. Encoded-value defaults now run through the wrapped decoder and retain encoder work before omission. Type-side schemaMake validates explicit factory defaults without wire services. Constructor defaults now carry a separate make-input type through nonrecursive and guarded recursive composition. Optional adapters now retain wrapped or target make inputs; Option fields require complete decoded contents. Recursive Schemas now retain separate D/E/M and directional services. Constructor defaults now compose with field descriptors while retaining presence flags. Unary adapters now retain preceding defaults, optional bridges select target defaults, and Option adaptation explicitly resets them. Guarded self references now pass through wire-default and optional-bridge adapters, including nullable wire fields. Recursive Option data, arbitrary self-bearing transformations and Schema AST construction remain open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Schema contracts](plans/2026-10-18-schema-optional-union-issues-contract.md), [general-union rule](plans/2026-10-19-schema-general-union-contract.md), [compiled union witness](../tests/strict_target_slow_test.ts), [nullable field rule](plans/2026-10-19-schema-nullable-optional-contract.md), [nullable runtime witness](../tests/strict_target_slow_test.ts), [default encoding rule](plans/2026-10-19-schema-default-encoding-contract.md), [missing-or-null default rule](plans/2026-10-19-schema-null-default-contract.md), [encoded-value default rule](plans/2026-10-19-schema-encoded-default-contract.md), [type-side construction](plans/2026-10-19-schema-constructor-contract.md), [constructor metadata](plans/2026-10-19-schema-constructor-metadata-contract.md), [optional constructor inputs](plans/2026-10-19-schema-constructor-optional-contract.md), [recursive constructor inputs](plans/2026-10-19-schema-constructor-recursive-contract.md), [recursive wire types](plans/2026-10-19-schema-recursive-wire-contract.md), [constructor field defaults](plans/2026-10-19-schema-constructor-fields-contract.md), [adapter order](plans/2026-10-19-schema-constructor-order-contract.md), [recursive field adapters](plans/2026-10-19-schema-recursive-adapters-contract.md); Effect [unions](https://effect.website/docs/v4/schema/basic-usage#unions).                                                                                                                                                                                                                                                                                                                                               | Host handles other validation needs.                                                                                                                         |
| Layer construction and runtime assembly                                                 | **Supported core 1 subset.** `layer`, `mergeLayers`, and expression-valued `provide` build source Layer graphs. Launching an Effect runtime remains a host concern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [Layers](https://effect.website/docs/v4/requirements-management/layers).                                                                                                                                                                                                                                                                                                                                                                       | Host runs exported functions.                                                                                                                                |
| Platform, HTTP, SQL, RPC, AI, observability                                             | **Adapter access only.** No arbitrary Effect package import, platform DSL, tagged SQL template, or first-class package API object in `.eff`. Some operations can be modeled as Effective service methods.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Project linker](../src/core/project.ts#L412), [host assertion](../src/core/emit/decls.ts#L451); Effect [platform](https://effect.website/docs/v4/platform/introduction), [HTTP API](https://effect.website/docs/v4/api/effect/http-api/HttpApi), [SQL client](https://effect.website/docs/v4/api/effect/sql/SqlClient), [RPC serialization](https://effect.website/docs/v4/api/effect/rpc/RpcSerialization), [AI language model](https://effect.website/docs/v4/api/effect/ai/LanguageModel), and [metrics](https://effect.website/docs/v4/observability/metrics). | Implement the integration in TypeScript and expose a narrower Effective service. Streaming, schemas, transactions, and scoped handles need special scrutiny. |
| User generics and recursive schemas                                                     | **Partial.** Guarded self-recursive data aliases support arrays, optional keys and terminal-tagged choices. Recursive Schemas retain distinct decoded, encoded and make-input types through selected field adapters. User generics, mutual recursion and recursive Option data remain gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [Schema contract](plans/2026-10-18-schema-composition-recursion-contract.md), [runtime test](../tests/schema_slow_test.ts); Effect [recursive Schema](https://effect.website/docs/v4/schema/advanced-usage).                                                                                                                                                                                                                                                                                                                                                        | Host can retain the richer type and expose a concrete interface.                                                                                             |

The ecosystem row began as an **interface audit**, not a claim that HTTP, SQL,
RPC, AI, or telemetry calls all fail when wrapped as service methods. The
[local adapter follow-up](plans/2026-10-18-schema-ecosystem-design.md) now
executes selected package operations through checked source, fake
drivers/providers, and in-memory data. An HTTP API builder or SQL statement
value is a different kind of program: its API object, schema, or statement must
exist in source if Effective authors are to compose it themselves. The current
import and type rules do not provide that route.
[Effect's platform guide](https://effect.website/docs/v4/platform/introduction)
and
[HTTP API reference](https://effect.website/docs/v4/api/effect/http-api/HttpApi)
show the distinction.

## Reproduced probes

Each `.eff` probe below used a separate temporary project containing `effective.json` with `{"host":{}}`. Run `deno task effective check <project>` from this repository. The results are the original audit observations; the updates above and in the last column identify behavior that has since changed.

| `main.eff` body                                                                                                                    | Original result                                                                                   | Current interpretation                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `export const pair = (): int[] => [1, 2]`                                                                                          | `syntax/008: expected an expression, found [`                                                     | Phase 2 now accepts the array literal. The [source rule](phase-a-rules.md#lexer-and-parser-a1) records its inference and contextual behavior. |
| `import { Effect } from "effect"` followed by `export const answer = (): int => 1`                                                 | `module/001: import effect must start with ./ or ../, or use the host: prefix`                    | `.eff` cannot directly import the package API.                                                                                                |
| `export const delayed = (): Effect<int> => 1`                                                                                      | `unknown-name/001: unknown type Effect`                                                           | Phase 4 now recognizes the type. The initializer remains invalid because `1` is not an Effect value; `defer(() => 1)` constructs one.         |
| `export const numbers = (): Stream<int> => 1`                                                                                      | `unknown-name/001: unknown type Stream`                                                           | Phase 7 recognizes `Stream<int>`. The body remains invalid because `1` is not a Stream; `unfold(0, (n) => ...)` constructs one.               |
| `service Metrics { keep(x: int): boolean }` and a `filter` callback calling `Metrics.keep`, in a function with `uses Metrics.keep` | `execution-mode/001: the callback of filter must be pure with empty failure and requirement sets` | `filter` still requires a pure callback. Phase 3's `traverse` accepts an effectful mapping callback.                                          |
| `export const answer = (): int => retry(() => 1, { times: 2 })`                                                                    | 0 diagnostics                                                                                     | The fixed-count retry subset works; its existence does not imply general Schedule support.                                                    |

The effectful collection probe used this complete source:

```effective
service Metrics {
  keep(x: int): boolean
}
export const selected = (xs: int[]): int[] uses Metrics.keep =>
  xs |> filter((x) => Metrics.keep(x))
```

The following target program passed `deno check --no-lock` with `effect` mapped to `npm:effect@4.0.5`. It supplies concrete target witnesses for the first several gaps. Each declaration can be checked without running a long-lived or infinite computation.

The temporary `deno.json` contained `{"imports":{"effect":"npm:effect@4.0.5"},"compilerOptions":{"strict":true}}`; the command was `deno check --no-lock --config deno.json main.ts`.

```ts
import { Effect, Ref, Schedule, Schema, Stream } from "effect";

export const parallel = Effect.all(
  [Effect.succeed(1), Effect.succeed(2)],
  { concurrency: "unbounded" },
);
export const traversed = Effect.forEach(
  [1, 2],
  (n) => Effect.logInfo(String(n)).pipe(Effect.as(n + 1)),
  { concurrency: "unbounded" },
);
export const numbers = Stream.iterate(0, (n) => n + 1);
export const scoped = Effect.scoped(
  Effect.acquireRelease(Effect.succeed("handle"), () => Effect.void),
);
export const spaced = Effect.retry(
  Effect.fail("temporary"),
  Schedule.spaced("1 second"),
);
export const state = Effect.gen(function* () {
  const ref = yield* Ref.make(0);
  yield* Ref.update(ref, (n) => n + 1);
  return yield* Ref.get(ref);
});
export const decoded = Schema.decodeUnknownSync(Schema.NumberFromString)("42");
```

**Resolved compiler hole:** the original audit found a validator disagreement for this pipeline. It now passes `check`, `build --validate`, and `build --tsc`.

```effective
service Jobs {
  next(): () => int
}
export const run = (): int uses Jobs.next =>
  Jobs.next() |> retry({ times: 1 })
```

The fix moved the left expression's active requirements to the block binding and kept the retry stage's local annotation limited to its own work. A named host-provider `provide` pipeline also validates.

## Stream follow-up disposition

The planned native stream follow-up selected behavior that the earlier core
operators could not express while staying within the existing `Stream` and
`RetrySchedule` source types. Each selected function now has a spec rule,
checker and independent IR validation, strict Effect 4.0.5 target checking,
and a runtime witness:

| Behavior                                        | Source function  | Runtime witness                                          |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------- |
| Keep prior output, then replace a failed source | `catchStream`    | Earlier values survive; replacement failure propagates.  |
| Restart the whole source after typed failure    | `retryStream`    | Prior values replay; schedule resets after new output.   |
| Coalesce a burst by elapsed time                | `debounceStream` | A synchronous burst emits its last element.              |
| Apply element-rate policy                       | `throttleStream` | `enforce` drops excess; `shape` delays without dropping. |

Some common Effect Stream names are compositions of forms already present.
`runForEach` is `runStream` with `sinkForEach`; `runCount` is `foldStream` with
a `number` state; `tap` is `mapEffect` returning the original element after
the observation; and `runForEachWhile` is `drainStream` after an effectful
inclusive stop predicate. A [source checker test](../tests/check_body_test.ts)
accepts those compositions with their service contracts. They do not need
separate source names for this follow-up.

General keyed grouping, aggregation with arbitrary Sinks, chunk-cost
throttling, custom stream interruption, and other specialized policies remain
part of broader Effect API parity. They need additional source rules or a
separate expressiveness witness. This follow-up does not claim every Effect
Stream export.

## General concurrency and scope disposition

The [explicit Scope investigation](plans/2026-10-18-explicit-scope-design.md)
now has a pinned Effect 4.0.5 witness and compiler probes. A lexical create/close
lifetime is expressible with `scoped` and `forkScoped`: the emitted source
records startup, body, completed release, then continuation after close.
`withResource` similarly handles a lexical acquisition/use/release bracket.

The stronger witness returns live scope authority from one root execution and
closes it in a later root, waiting for the child's finalizer. Design draft 0.34
implements the bounded
[ownership contract](plans/2026-10-18-scope-ownership-contract.md) with
`CloseableScope`, `makeScope`, `provideScope`, `addScopeFinalizer`, and
`closeScope`. Authority is shared across aliases and source modules. Closing
waits uninterruptibly for one cached cleanup outcome, including defect replay;
registration captures service bindings while preserving provider-lifetime
responsibility. Existing borrowed resource and Fiber escape rules remain.

The original seven raw-target tests and two compiler probes, eight ownership
prototype tests, checker/validator tests, and four strict target/runtime tests
cover the boundary. Source witnesses retain a live child and child-owned
provider across root return, close through an alias in another module, and
verify finalizer services, concurrent completion, late registration, argument
order, and host-wrapper compatibility. Ordinary provided work remains
unsupervised. Close currently supplies `Exit.void`; general Exits, exit-aware
callbacks, and other concurrency APIs remain outside this slice.

## General Stream and Schedule disposition

The [general Stream/Schedule investigation](plans/2026-10-18-general-stream-schedule-design.md)
adds six target tests and two compiler/runtime probes. A tagged end-marker
composition with existing stream forms matches the selected external-stop
cases, including interruption of a pending pull and cleanup of the signal on
source completion. A fixed combined retry-delay policy also fits the current
pure `RetrySchedule` callback. These witnesses do not select new builtins.

Untimed async aggregation and the selected general Schedule slice now have
implemented source rules. General source Sink constructors and Schedule
composition with incomparable inputs remain uncovered native contracts. The
investigation records target behavior, source diagnostics, equivalent-program
limits, and lifetime/type rules. The four-argument Sink form retains its `never`
leftover default. The implemented
[Sink leftover contract](plans/2026-10-18-sink-leftover-contract.md) adds a
fifth type argument, positive-count `takeSink`, and synchronous
`transduceStream`. Nine contract probes, compiler/validator tests, and four
strict target/runtime tests verify replay, final partial/empty results, deferred
channels, zero-progress host behavior, and whole-consumption cleanup.

The [live keyed grouping contract](plans/2026-10-18-keyed-group-contract.md)
implements `mapGroups` in draft 0.36: primitive keys, callback-owned borrowed
group inputs, concurrent consumers, unordered data results, and explicit per-key
capacity. Nine target probes verify online later-key output, fresh routing,
closed-key discard, backpressure, deferred providers, and completed
failure/cancellation cleanup. The tested lowering uses concurrent
`Stream.flatMap`; an unordered `mapEffect` lowering failed the source-failure
and cleanup gates. Source checking, independent IR validation, typed emission,
and four compiled-source runtime tests now enforce the rule.

The
[inline `Some([record, state])` regression](plans/stream-schedule-probes/inline-marker.eff)
now passes source checking, IR validation, strict target checking, and repeated
stream execution. Emission supplies the checked payload type to `Option.some`,
preserving tuple shape and record literals through lifted callbacks. The
[compiler regression](../fixtures/emit/contextual-options.eff) also covers
nested Options and tuples, arrays, empty tuples, and effectful payloads.

## Schema and ecosystem disposition

The
[Schema/ecosystem investigation](plans/2026-10-18-schema-ecosystem-design.md)
adds three target tests and two compiler/adapter probes. A concrete source
decoder can validate with a pure Codec and then call an effectful service. The
follow-up
[Schema/recursion contract](plans/2026-10-18-schema-composition-recursion-contract.md)
adds two pinned target probes and selects a four-channel Schema value, an
explicit SchemaError rule, and an array-guarded self-recursive source type. The
bounded source forms now compile, validate independently, and run against the
pinned target. Pure `Codec` callbacks still reject effects; guarded recursive
record aliases are accepted while direct and mutual cycles remain rejected.

Typed host adapters now execute representative HTTP response validation, SQL
transactions, RPC framing/validation, AI generation, local metrics, and
recursive tree validation through emitted source. Provider failures and
requirements are checked. SQL commits or rolls back and releases its scoped
connection; borrowed parser sessions close after success, failure, and
interruption. The write-up records intentional error translation and the limits
of each fixture. It does not claim native package builders or external
integration coverage.

## Follow-up queue

The user accepted the [application acceptance rule](plans/2026-10-19-application-acceptance-rule.md)
on 2026-10-19. It supersedes the automatic feature-by-feature queue below.
The stopping rule requires three complete applications: a service workflow,
a scheduled worker, and a stream processor. Each must compile with precise
contracts and pass failure, cancellation, and cleanup checks. Application
orchestration stays in `.eff`; typed host adapters may supply drivers and the
runtime entry point. The [scheduled worker](plans/2026-10-19-scheduled-worker-application.md)
now passes its application gate. The
[service workflow](plans/2026-10-19-service-workflow-application.md) also passes.
The [stream processor](plans/2026-10-19-stream-processor-application.md) also
passes. All three application gates are complete using existing source forms.

The scheduled worker uses existing source recursion, RetrySchedule, primitive
clock waits and withResource. Nine compiled application checks cover virtual
time, Effect replay, selective retry, validation, failures, defects and awaited
cleanup during work and both kinds of wait. No new API is selected. Separate
source probes retain the opaque Schedule retry and repetition consumer gaps.

The service workflow keeps validation, catalog use, total calculation and
selective retry in source. Its registered native SQL adapter owns one atomic
save and connection lifecycle. Fourteen compiled cases cover parameterized
commit, input rejection, retry timing and replay, failure classification,
rollback, defects and cancellation. Body interruption awaits rollback and release;
interruption after COMMIT starts can preserve a committed row. No new API is
selected. Recording drivers establish no external database integration.

The stream processor keeps live pulls, ordered concurrent mapping, selective
fallback, buffering, batching and session brackets in source. Thirteen runtime
cases cover order, partial and empty batches, replay, live arrivals, stalled
upstream progress under blocked output, failures, defects and awaited cleanup.
The pinned pipeline stops at seven pull calls while the first write is blocked.
Queue capacity is no global memory limit.

Native transduction can emit a
partial batch before input failure. Item recovery follows native catchTags
and can discard accompanying reasons from a mixed transformation cause.
Session finalizers run outside item recovery. No new API is selected.

The accepted stopping rule is satisfied. Stop automatic feature additions.
Editor, packaging, performance and external integration acceptance remain
separate work. Further language work requires a demonstrated application
blocker or an explicit change to the accepted target.
Try equivalent existing source compositions before selecting a new builtin.
Time control, general Schedule consumers and user generics remain candidates, subject to demonstrated
application blockers. Further Schema expansion, including recursive Option,
does not take priority without such a blocker. Item 9 remains deferred.

The representative investigation queue, explicit shared scopes,
[Sink leftovers](plans/2026-10-18-sink-leftover-contract.md), and
[live keyed grouping](plans/2026-10-18-keyed-group-contract.md) are complete.
All three source slices have canonical spec/IR rules, checker and independent
validator enforcement, typed emission, and runtime evidence.

The [async aggregation contract](plans/2026-10-18-async-aggregation-contract.md)
now implements untimed `aggregateStream` from eleven target probes and a
compiled source witness. Checker, IR validation, typed emission, and two
compiled-source runtime tests cover the target's capacity-zero handoff, Sink
leftover replay, distinct completion results, deferred channels, and awaited
interruption cleanup. Buffered transduction has a different read-ahead trace;
aggregation partitions can also change across chunk boundaries. Timed flushing
now uses general Schedule values, with virtual-time and schedule-stop target
witnesses.

The [general Schedule contract](plans/2026-10-18-general-schedule-contract.md)
now implements a four-channel source value, a per-execution state factory and
decision callback, and `aggregateWithinStream` as the first consumer. Four
target probes cover fresh state, normal completion versus typed failure,
deferred services, awaited upstream cleanup, and the consumer's
`Option<SinkOutput>` input constraint. Checker and independent validator tests,
strict emission, and one compiled runtime test cover the selected source slice.
The [composition contract](plans/2026-10-18-schedule-composition-contract.md)
now adds binary `scheduleMax`, `scheduleMin`, and `scheduleConcat` when one
source input type fits the other. Target probes and a compiled source witness
cover delays, normal end, phase input, fresh state, and both failure channels.
The remaining native Schedule boundary is general intersections for incomparable
inputs. The selected Schema composition and guarded-recursion rule now has a
compiled source witness and runtime regression. The
[optional/union/issue contract](plans/2026-10-18-schema-optional-union-issues-contract.md)
now implements exact optional keys, tagged unions, authored issue trees, and
finite optional and tagged recursion from seven pinned target probes. A compiled
source witness and independent IR mutations cover the selected rule. The
[optional-field transformation and default contract](plans/2026-10-19-schema-optional-transform-defaults-contract.md)
now implements exact Option-from-optional-key conversion, a per-decode
missing-key default, and pure optional-to-optional field transformation. Seven
target tests, a compiled source witness, and independent IR validation pin the
selected behavior. The [effectful optional callback contract](plans/2026-10-19-schema-effectful-optional-contract.md)
now permits effectful optional getters and defaults with direction-specific
services and bounded authored issues. Five target tests, a strict compiled
runtime witness, source boundary probes, and independent IR mutations cover
missing and present keys, repeated defaults, issue paths, defects, and
interruption. The [required-to-optional field contract](plans/2026-10-19-schema-required-optional-contract.md)
now adds `SchemaDecodedOptional` and `schemaOptionalFromRequired`. A guard
rejects a missing encoded key before the getter runs, restoring the required
encoded contract that the raw target builder does not enforce. Three pinned
target tests, source boundary probes, a strict compiled witness, and
independent IR mutations cover omission, restoration, services, issue paths,
and cancellation. The [general-union contract](plans/2026-10-19-schema-general-union-contract.md)
now admits unlike and overlapping Schema branches. Four pinned target tests
and a strict compiled source witness cover ordered decode and encode fallback,
service directions, branch overlap, defects, and interruption. The [nullable optional contract](plans/2026-10-19-schema-nullable-optional-contract.md)
now adds the null singleton and an explicit null-as-missing field constructor.
Four target tests, strict compiled source execution, source boundaries, and
IR mutations cover exact presence, directional services, defaults, and the
null/unit distinction. The [default encoding contract](plans/2026-10-19-schema-default-encoding-contract.md)
now extends schemaDefaultKey with literal passthrough and omit options. Four
target tests, strict compiled execution, source boundaries, and IR mutations
cover unconditional omission, retained static encoder services, skipped runtime
encoder calls, validation, and failures. The
[missing-or-null default contract](plans/2026-10-19-schema-null-default-contract.md)
now adds schemaDefaultNullKey with required nonnullable decoded fields and exact
optional nullable encoded fields. Five target tests, strict compiled execution,
source boundaries, and independent IR mutations cover decoded defaults,
directional services, encoding policies, issue paths, defects, and cancellation.
The [encoded-value default contract](plans/2026-10-19-schema-encoded-default-contract.md)
now adds schemaDefaultEncodedKey. Six target tests, source boundaries, independent
IR mutations, and a strict compiled witness cover encoded callback values,
wrapped decoding, and both encoding strategies. Under omit, the encoder still
runs, can fail or defect, and awaits cleanup on interruption. This differs from
the otherwise useful decoded-default composition, which skips the encoder under
omit. The [type-side construction contract](plans/2026-10-19-schema-constructor-contract.md)
now adds schemaMake, which validates D with structured SchemaIssue and no wire
services. Ordinary factories fill defaults and attach nested issue paths.
Six target tests, source and independent IR boundaries, and strict compiled
execution cover the selected values, defaults, paths, argument effects, and
SchemaIssue catch/match dispatch. The initial probes also identified a separate
make-input shape and raw constructor replay aliasing.
The [constructor metadata contract](plans/2026-10-19-schema-constructor-metadata-contract.md)
now implements a fifth Schema parameter M and a constructor-default field
constructor. Four target tests, source boundaries, independent IR mutations,
and strict compiled execution cover nested defaults, arrays, ordered unions,
optional keys, transformation targets, module imports, replay identity, full
issue paths, and cancellation. Known default descriptors and changed M cannot
be silently erased. The [optional adapter extension](plans/2026-10-19-schema-constructor-optional-contract.md)
now retains wrapped M through nullable and decoding-default fields, and target M
through optional transformations. Option fields explicitly require complete
Option<D>, without nested construction. Three target tests, source and independent
IR boundaries, and strict compiled execution cover all adapters, imported fields,
nested paths, and unchanged wire effects and services. The
[recursive constructor extension](plans/2026-10-19-schema-constructor-recursive-contract.md)
now carries separate M through array, optional-key, and terminal-tagged self
references, including constructor defaults. Three target tests, source and IR
boundaries, and strict compiled execution cover nested partial inputs, imports,
fresh defaults, full paths, separate wire services, defects, and awaited cleanup.
Defaults cannot capture self, and constructor wrappers do not supply a recursive
guard. The [recursive wire extension](plans/2026-10-19-schema-recursive-wire-contract.md)
now removes the D=E restriction while preserving separate M and directional
services. Three target probes, source and IR boundaries, and strict compiled
execution cover array, optional-key and tagged forms, imported arrays, distinct
wire presence, roundtrips, nested wire failures, defects, and awaited cleanup in
both directions. The [field-default extension](plans/2026-10-19-schema-constructor-fields-contract.md)
now attaches constructor defaults to all three presence descriptors. Four target
probes and source, IR, import, strict TypeScript and runtime checks cover nested M,
independent wire defaults, Option contents, failures, defects and cleanup. The
new combined descriptor types preserve every flag, and IR permits a default
alongside one mutually exclusive presence flag. The
[adapter-order extension](plans/2026-10-19-schema-constructor-order-contract.md)
now retains defaults through unary adapters, selects optional bridge target
defaults, and explicitly resets Option defaults. Three pinned probes, source
and linked IR boundaries, and strict compiled execution cover imports, partial
inputs, exact public flags, wire independence, omission, failures and cleanup.
Field emission now uses checked Codec metadata views without adapter-specific
helper properties. The
[recursive field-adapter extension](plans/2026-10-19-schema-recursive-adapters-contract.md)
now traverses wire-default and optional-bridge Schema arguments while forbidding
self capture in their callbacks. Null-as-missing provides an optional guard;
unions beneath an established data guard retain it. Three pinned target probes,
source and independent IR boundaries, and strict compiled execution cover nested
M, nullable recursive fields, wire defaults, bridge target construction, imports,
directional services, failure paths, defects and awaited cleanup. Recursive
Option data remains open under the accepted application acceptance rule. Arbitrary self-bearing ordinary
transformations and general AST construction remain open.
Ecosystem builders need their own
object and lifetime contracts; concrete adapters already cover the selected
operations.

Broader package interoperability, item 9 in the API design gap list, is deferred
to later work by user instruction. This includes arbitrary external package
imports and external values/constructors beyond the current registered host
boundary. The Sink implementation uses that existing boundary.

The [explicit Scope contract](plans/2026-10-18-scope-ownership-contract.md) now
has spec, checker, IR/validator, emitter, strict host assertions, and source
runtime evidence. General close Exits remain deferred. Other general concurrency
APIs need their own witnesses before any parity claim. `Effect.all` discard mode
remains expressible by calling `all` and ignoring its result in a block.

The representative general Stream/Schedule investigation is complete. Untimed
and timed aggregation are implemented for the selected Schedule slice. Other
Schedule combinators and consumers remain open. Contextual tuple emission is
fixed under the existing source rule. These slices do not establish full API
parity.

For each item, record a minimal `.eff` or TypeScript witness, the observed compiler phase and diagnostic (or emitted output), an equivalent-program argument, and a disposition. This audit did not execute external HTTP, SQL, RPC, AI, or telemetry services.

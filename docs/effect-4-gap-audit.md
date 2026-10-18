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

Update, 2026-10-18: design draft 0.9 adds sequential `flatMapStreams`.
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

**Yes. There are valid Effect 4 programs whose behavior and typed API cannot currently be authored in Effective source.** General stream combinators, raw `Scope` values, effectful Schema transformations, and direct ecosystem package APIs remain examples. Effective now supports the selected core 1 forms in the [language spec](../../effective/public/effective-spec.html#core1) and [typed IR](../src/core/ir.ts). Effect's documentation describes the broader [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency), [stream](https://effect.website/docs/v4/stream/introduction), and [scope](https://effect.website/docs/v4/resource-management/scope) APIs.

Here, **native support** means a program can be written in `.eff`, checked with its intended contract, and emitted to equivalent Effect behavior. A host TypeScript module may implement any of these behaviors behind an Effective service, but that implementation is then authored in TypeScript. This distinction matters for ecosystem coverage. The `host:` boundary accepts declared providers, service tags, and opaque types from a registered interface; it does not import arbitrary package functions or Effect constants. `.effi` still rejects `const`, and imports accept only relative `.eff` files or registered `host:` modules. A service method can return a nested Effect value ([parser](../src/core/parse.ts), [project linker](../src/core/project.ts), [emitter](../src/core/emit/decls.ts)).

This is an expressiveness result for the current language and compiler, not a claim that an Effective application cannot *use* these services through an adapter. It also does not claim that every Effect combinator needs a same-named Effective construct. An equivalent composition in `.eff` would count as support.

## Coverage map

| Effect 4 program family | Native Effective status | Limiting boundary and evidence | Host route |
| --- | --- | --- | --- |
| Ordinary typed effects, service calls, tagged failures, recovery, and fixed-count retry | **Supported subset.** Effective emits `Effect`, `Context`, `Layer`, `Option`, and `Schema`; its examples cover these forms. | [Examples](../fixtures/examples/), [emitter import set](../src/core/emit/scope.ts#L26), [source control rules](../../effective/public/effective-spec.html#control). | Host supplies the provider and invokes exported entry functions. |
| First-class Effect values and general combinators | **Partial.** `Effect<A,E,R>`, `defer`, and `run` let source construct, store, pass, return, and execute a typed Effect value. General Effect combinators remain absent. | [IR type model](../src/core/ir.ts#L31), [spec: execution](../../effective/public/effective-spec.html#execution), [Phase 4 runtime test](../tests/emit_slow_test.ts); Effect [the Effect type](https://effect.website/docs/v4/getting-started/the-effect-type). The original probe below predates Phase 4. | Host may expose a specific composed operation as a service method. |
| Concurrency, racing, fibers, interruption | **Supported core 1 subset.** Bounded and unbounded `traverse`, heterogeneous `all` and `allResults` over Effect tuples and records, `partitionAll` and `validateAll` over homogeneous arrays, `race`, supervised `withFiber`, and scope-bound `forkScoped` are native. Discarding an `all` result is expressible with a block. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency) and [fibers](https://effect.website/docs/v4/concurrency/fibers). | A service can expose other concurrent policies. |
| Effectful collection traversal | **Supported sequentially and concurrently.** `traverse` accepts effectful callbacks and preserves their failure and requirement sets. `map`, `filter`, and `fold` still require pure callbacks. | [Spec: collections](../../effective/public/effective-spec.html#pipelines), [prelude names](../src/core/resolve.ts#L53), [Phase 3 runtime test](../tests/emit_slow_test.ts); Effect [`forEach`](https://effect.website/docs/v4/code-style/control-flow). The original `filter` probe still fails. | A host service can expose other traversal policies. |
| Streams and sinks | **Supported core 1 subset.** `unfold`, `mapEffect`, `sinkForEach`, `runStream`, `bufferStream`, `mergeStreams`, `zipStreams`, `concatStreams`, sequential `flatMapStreams`, `takeStream`, `takeWhileStream`, `takeUntilStream`, `dropStream`, and `dropWhileStream` are native. Other stream combinators remain absent. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [streams](https://effect.website/docs/v4/stream/introduction) and [sinks](https://effect.website/docs/v4/sink/introduction). | A host adapter can expose other stream policies. |
| Resource scopes and finalizers | **Supported core 1 subset.** `withResource` scopes operation records and opaque host handles; borrow-qualified methods and checked source helpers prevent handle escape. `scoped` supplies a local scope for `forkScoped` jobs. Raw `Scope` composition remains absent. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [borrow runtime test](../tests/cli_slow_test.ts), [scoped fiber runtime test](../tests/emit_slow_test.ts); Effect [scope](https://effect.website/docs/v4/resource-management/scope). | A host adapter owns the handle and its operations. |
| Schedules and timed repetition | **Supported core 1 subset.** `retrySchedule` authors a conditional millisecond policy for `retry`. General Schedule operators and cron policies remain absent. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime test](../tests/emit_slow_test.ts); Effect [schedules](https://effect.website/docs/v4/scheduling/using-schedules). | Host can implement other policies. |
| Mutable concurrent state | **Supported core 1 subset.** `Ref<A>` and make/get/set/update operations are native; update is atomic under bounded traversal. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime test](../tests/emit_slow_test.ts); Effect [`Ref`](https://effect.website/docs/v4/state-management/ref). | Other state primitives can live in services. |
| Schema codecs, filters, and transformations | **Supported core 1 subset.** Pure `Codec` values validate inputs and outputs with derived schemas. General Schema values and effectful transformations remain absent. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime test](../tests/emit_slow_test.ts); Effect [Schema introduction](https://effect.website/docs/v4/schema/introduction) and [transformations](https://effect.website/docs/v4/schema/transformations). | Host handles other validation needs. |
| Layer construction and runtime assembly | **Supported core 1 subset.** `layer`, `mergeLayers`, and expression-valued `provide` build source Layer graphs. Launching an Effect runtime remains a host concern. | [Core 1 spec](../../effective/public/effective-spec.html#core1), [runtime tests](../tests/emit_slow_test.ts); Effect [Layers](https://effect.website/docs/v4/requirements-management/layers). | Host runs exported functions. |
| Platform, HTTP, SQL, RPC, AI, observability | **Adapter access only.** No arbitrary Effect package import, platform DSL, tagged SQL template, or first-class API/schema object in `.eff`. Some operations can be modeled as Effective service methods. | [Project linker](../src/core/project.ts#L412), [host assertion](../src/core/emit/decls.ts#L451); Effect [platform](https://effect.website/docs/v4/platform/introduction), [HTTP API](https://effect.website/docs/v4/api/effect/http-api/HttpApi), [SQL client](https://effect.website/docs/v4/api/effect/sql/SqlClient), [RPC serialization](https://effect.website/docs/v4/api/effect/rpc/RpcSerialization), [AI language model](https://effect.website/docs/v4/api/effect/ai/LanguageModel), and [metrics](https://effect.website/docs/v4/observability/metrics). | Implement the integration in TypeScript and expose a narrower Effective service. Streaming, schemas, transactions, and scoped handles need special scrutiny. |
| User generics and recursive schemas | **Native gap.** The source spec defers user generics and rejects recursive type definitions. | [Spec: types](../../effective/public/effective-spec.html#types) and [deferred work](../../effective/public/effective-spec.html#examples); Effect [recursive Schema](https://effect.website/docs/v4/schema/json-schema#references-and-recursion). | Host can retain the richer type and expose a concrete interface. |

The ecosystem row is an **interface audit**, not a claim that HTTP, SQL, RPC, AI, or telemetry calls all fail when wrapped as service methods. For example, a `readFile(path): string` method is a plausible Effective interface over an Effect platform adapter. An HTTP API builder or SQL statement value is a different kind of program: its API object, schema, or statement must exist in source if Effective authors are to compose it themselves. The current import and type rules do not provide that route. [Effect's platform guide](https://effect.website/docs/v4/platform/introduction) and [HTTP API reference](https://effect.website/docs/v4/api/effect/http-api/HttpApi) show the distinction.

## Reproduced probes

Each `.eff` probe below used a separate temporary project containing `effective.json` with `{"host":{}}`. Run `deno task effective check <project>` from this repository. The results are the original audit observations; the updates above and in the last column identify behavior that has since changed.

| `main.eff` body | Original result | Current interpretation |
| --- | --- | --- |
| `export const pair = (): int[] => [1, 2]` | `syntax/008: expected an expression, found [` | Phase 2 now accepts the array literal. The [source rule](phase-a-rules.md#lexer-and-parser-a1) records its inference and contextual behavior. |
| `import { Effect } from "effect"` followed by `export const answer = (): int => 1` | `module/001: import effect must start with ./ or ../, or use the host: prefix` | `.eff` cannot directly import the package API. |
| `export const delayed = (): Effect<int> => 1` | `unknown-name/001: unknown type Effect` | Phase 4 now recognizes the type. The initializer remains invalid because `1` is not an Effect value; `defer(() => 1)` constructs one. |
| `export const numbers = (): Stream<int> => 1` | `unknown-name/001: unknown type Stream` | Phase 7 recognizes `Stream<int>`. The body remains invalid because `1` is not a Stream; `unfold(0, (n) => ...)` constructs one. |
| `service Metrics { keep(x: int): boolean }` and a `filter` callback calling `Metrics.keep`, in a function with `uses Metrics.keep` | `execution-mode/001: the callback of filter must be pure with empty failure and requirement sets` | `filter` still requires a pure callback. Phase 3's `traverse` accepts an effectful mapping callback. |
| `export const answer = (): int => retry(() => 1, { times: 2 })` | 0 diagnostics | The fixed-count retry subset works; its existence does not imply general Schedule support. |

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

## Remaining investigation queue

1. **General concurrency and scope.** Compare raw `Scope` composition with the scoped fiber source forms. `Effect.all` discard mode can be expressed by calling `all` and ignoring its result in a block. Keep cancellation and finalizer behavior explicit.
2. **General stream and Schedule APIs.** Identify further operators whose behavior cannot be expressed by `unfold`, `bufferStream`, `mergeStreams`, `zipStreams`, `concatStreams`, `flatMapStreams`, `takeStream`, `takeWhileStream`, `takeUntilStream`, `dropStream`, `dropWhileStream`, and `retrySchedule`; require target and runtime witnesses.
3. **Schema and ecosystem APIs.** Test effectful transformations, recursive schemas, and representative HTTP, SQL, RPC, AI, and observability objects through typed adapters. Preserve failures, requirements, and scoped lifetimes.

For each item, record a minimal `.eff` or TypeScript witness, the observed compiler phase and diagnostic (or emitted output), an equivalent-program argument, and a disposition. This audit did not execute external HTTP, SQL, RPC, AI, or telemetry services.

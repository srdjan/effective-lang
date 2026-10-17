# Effect 4 expressiveness audit: questions for Astra

Research snapshot: 2026-10-17. Compiler: this repository, Deno 2.9.7. Target: `effect@4.0.5`, the version used by `build --tsc` and the slow emitter tests. This is a representative audit of native `.eff` source, not an inventory of every Effect export.

Update, 2026-10-17: language core 1 is specified in design draft 0.3.
The compiler now emits and validates `light-functional-ir` version 2.
The source features in the coverage map below remain implementation gaps.

Update, 2026-10-17: the pipeline validation defect described below was fixed
in phase 1 of the [implementation plan](plans/2026-10-17-effect4-gap-closure.md).
The original probe is retained as historical evidence. The current
`build --validate --tsc` regression passes for that source.
Phases 2 and 3 add bracket array and contextual tuple literals and sequential
effectful `traverse`. Phase 4 adds first-class `Effect<A,E,R>` values through
`defer` and `run`. Phase 5 adds scoped operation records through
`withResource`. Phase 6 adds bounded concurrent `traverse`. Phase 7 adds
incremental `Stream` and `Sink` values through `unfold`, `mapEffect`,
`sinkForEach`, and `runStream`. General borrowed scopes, unbounded concurrency,
fibers, broader stream combinators, and general Effect
combinators remain native gaps. The original probes below remain the audit
snapshot and should be read with these updates.

## Answer and boundary

**Yes. There are valid Effect 4 programs whose behavior and typed API cannot currently be authored in Effective source.** A race or unbounded concurrent computation, a buffered or merged stream with dynamic demand, and a scoped program that passes a borrowed handle to host methods are concrete examples. Effect's documentation describes [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency), [streams](https://effect.website/docs/v4/stream/introduction), and [scoped resources](https://effect.website/docs/v4/resource-management/scope). Effective's [language spec](../../effective/public/effective-spec.html#execution) specifies bounded concurrent traversal, scoped operation records, and one incremental stream slice, while deferring general fibers, stream combinators, and borrowed handles. Its [typed IR](../src/core/ir.ts) lacks the corresponding general forms.

Here, **native support** means a program can be written in `.eff`, checked with its intended contract, and emitted to equivalent Effect behavior. A host TypeScript module may implement any of these behaviors behind an Effective service, but that implementation is then authored in TypeScript. This distinction matters for ecosystem coverage. The current `host:` boundary accepts declared providers, not arbitrary package functions or an opaque Effect constant: `.effi` rejects `const`, imports accept only relative `.eff` files or registered `host:` modules, and emission requires a host value to be a provider. A service method can return a nested Effect value ([parser](../src/core/parse.ts#L740), [project linker](../src/core/project.ts#L412), [emitter](../src/core/emit/decls.ts#L451)).

This is an expressiveness result for the current language and compiler, not a claim that an Effective application cannot *use* these services through an adapter. It also does not claim that every Effect combinator needs a same-named Effective construct. An equivalent composition in `.eff` would count as support.

## Coverage map

| Effect 4 program family | Native Effective status | Limiting boundary and evidence | Host route |
| --- | --- | --- | --- |
| Ordinary typed effects, service calls, tagged failures, recovery, and fixed-count retry | **Supported subset.** Effective emits `Effect`, `Context`, `Layer`, `Option`, and `Schema`; its examples cover these forms. | [Examples](../fixtures/examples/), [emitter import set](../src/core/emit/scope.ts#L26), [source control rules](../../effective/public/effective-spec.html#control). | Host supplies the provider and invokes exported entry functions. |
| First-class Effect values and general combinators | **Partial.** `Effect<A,E,R>`, `defer`, and `run` let source construct, store, pass, return, and execute a typed Effect value. General Effect combinators remain absent. | [IR type model](../src/core/ir.ts#L31), [spec: execution](../../effective/public/effective-spec.html#execution), [Phase 4 runtime test](../tests/emit_slow_test.ts); Effect [the Effect type](https://effect.website/docs/v4/getting-started/the-effect-type). The original probe below predates Phase 4. | Host may expose a specific composed operation as a service method. |
| Concurrency, racing, fibers, interruption | **Partial.** `traverse(items, callback, { concurrency: N })` runs at most N callbacks, preserves input order, and interrupts siblings on failure. Source still has no race or fiber handle. | [Spec: collections](../../effective/public/effective-spec.html#pipelines), [Phase 6 runtime test](../tests/emit_slow_test.ts); Effect [concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency) and [fibers](https://effect.website/docs/v4/concurrency/fibers). | A service can expose other concurrent policies. |
| Effectful collection traversal | **Supported sequentially.** `traverse` accepts effectful callbacks and preserves their failure and requirement sets. `map`, `filter`, and `fold` still require pure callbacks. | [Spec: collections](../../effective/public/effective-spec.html#pipelines), [prelude names](../src/core/resolve.ts#L53), [Phase 3 runtime test](../tests/emit_slow_test.ts); Effect [`forEach`](https://effect.website/docs/v4/code-style/control-flow). The original `filter` probe still fails. | A host service can expose other traversal policies. |
| Streams and sinks | **Partial.** `Stream<A,E,R>` and `Sink<I,O,E,R>` support `unfold`, `mapEffect`, `sinkForEach`, and `runStream` with one-element pull demand. Buffered, merged, and concurrent stream operators remain absent. | [Spec: collections](../../effective/public/effective-spec.html#pipelines), [IR type variants](../src/core/ir.ts#L39), [Phase 7 runtime test](../tests/emit_slow_test.ts); Effect [streams](https://effect.website/docs/v4/stream/introduction), [sinks](https://effect.website/docs/v4/sink/introduction), and [backpressure operations](https://effect.website/docs/v4/stream/operations). The original probe below predates Phase 7. | A host adapter can expose other stream policies. |
| Resource scopes and finalizers | **Partial.** `withResource` lets source compose acquisition, use, and release around a scoped operation record. It rejects handle escape and combines all three invocation channels. General borrowed handles and `Scope` composition remain absent. | [Spec: control](../../effective/public/effective-spec.html#control), [IR expressions](../src/core/ir.ts#L101), [Phase 5 runtime test](../tests/emit_slow_test.ts); Effect [scope and `acquireRelease`](https://effect.website/docs/v4/resource-management/scope). | A host adapter creates the operation record and implements its functions. |
| Schedules and timed repetition | **Partial.** `retry(job, { times: N })` is supported; source cannot author a `Schedule` value or delayed, exponential, or cron policy. | [Spec: retry](../../effective/public/effective-spec.html#control), [checker rule](phase-a-rules.md); Effect [schedules](https://effect.website/docs/v4/scheduling/using-schedules) and [timing policies](https://effect.website/docs/v4/scheduling/choosing-and-combining-schedules). | Host can implement a particular policy. |
| Mutable concurrent state | **Native gap.** Source values are immutable; there is no `Ref` type or update operation. | [Spec: status](../../effective/public/effective-spec.html#status), [IR types](../src/core/ir.ts#L39); Effect [`Ref`](https://effect.website/docs/v4/state-management/ref). | Encapsulate state in a service implementation. |
| Schema codecs, filters, and transformations | **Partial.** The emitter derives schemas for supported data, error, and brand declarations, but source cannot construct or pass a `Schema` value, define a codec, or decode unknown input with a custom transformation. | [Schema emitter](../src/core/emit/types.ts#L203), [IR types](../src/core/ir.ts#L39); Effect [Schema introduction](https://effect.website/docs/v4/schema/introduction) and [transformations](https://effect.website/docs/v4/schema/transformations). | Host validates and converts at the boundary, as the spec requires. |
| Layer construction and runtime assembly | **Partial.** Source can declare services and `provide` a host-declared provider. It cannot build a new `Layer` graph or launch an Effect runtime from `.eff`. | [Host interface example](../fixtures/examples/host/providers.effi), [spec: modules](../../effective/public/effective-spec.html#modules); Effect [Layers](https://effect.website/docs/v4/requirements-management/layers) and [runtime](https://effect.website/docs/v4/runtime). | Host constructs layers and runs exported functions. |
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

**A distinct compiler hole:** a valid source pipeline can disagree with the IR validator. This program has 0 diagnostics under `check`, and `build --tsc` emits TypeScript accepted by Deno, but `build --validate` reports `validation/003` on the `retry` stage: expected `[]`, recorded `[cap:main#Jobs.next]` for `declarations[1].body.result.effects.requirements`.

```effective
service Jobs {
  next(): () => int
}
export const run = (): int uses Jobs.next =>
  Jobs.next() |> retry({ times: 1 })
```

This matches the [known lowering limit](phase-a-rules.md#lowering-a4) and [README note](../README.md#using-the-validator). It is **not** evidence that the program cannot transpile: `build --tsc` passed. It is evidence that the validator gives a false disagreement for this shape. Astra should check whether `provide` has the same behavior and whether any generated runtime behavior is wrong.

## Astra investigation queue

1. **P1 — Resolved: valid-pipeline validator disagreement.** The `Jobs.next() |> retry(...)` case now passes `check`, `--validate`, and `--tsc`. The local stage annotation excludes the left value's earlier evaluation, while the outer block retains it. A named host-provider `provide` pipeline validates too. The checker requires that provider to be a host-provider name, so an effectful-left `provide` stage is not currently expressible.
2. **P1 — Define the native expressiveness boundary.** Decide which programs Effective intends authors to compose in `.eff` and which remain host implementations. Use concurrent `Effect.all`, `Effect.acquireRelease`, and `Stream.iterate` as decisive cases. A host adapter that returns a final array does not preserve a stream's incremental delivery; a host method that owns a fiber does not expose source-level cancellation policy.
3. **P2 — Test effectful traversal and scheduling proposals.** Starting from the `execution-mode/001` probe, determine the minimum source type and contract rules for a sequential effectful traversal, then for bounded concurrency. Compare fixed-count `retry` with delayed and conditional schedules. Require target programs that typecheck under `effect@4.0.5` and tests of failure, cancellation, and requirement propagation.
4. **P2 — Audit first-class types and host interop.** For `Stream`, `Scope`, `Ref`, `Schema.Codec`, `Layer`, and representative HTTP/SQL/AI objects, determine whether Effective needs native types, opaque foreign types, or only service methods. Test that proposed `.effi` signatures preserve errors and requirements rather than hiding them in an untyped adapter. The current `.effi` grammar is provider-only for values.
5. **P3 — Close basic source/IR mismatches.** Investigate array and tuple literals: both expression nodes exist in the IR, but source grammar does not construct them. Decide whether that omission is intentional; use parser, checker, lowering, emitter, and `--tsc` probes before calling it emitter support.

For each item, Astra should return a minimal `.eff` or TypeScript witness, the observed compiler phase and diagnostic (or emitted output), an equivalent-program argument, and a disposition: **design exclusion**, **missing implementation**, **compiler defect**, **host-only by policy**, or **supported by another source composition**. Keep untested ecosystem claims marked as questions. This audit did not execute external HTTP, SQL, RPC, AI, or telemetry services.

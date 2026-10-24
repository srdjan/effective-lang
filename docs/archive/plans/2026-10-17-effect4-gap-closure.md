# Plan: close the verified Effect 4 gaps in stages

Status: phases 0–7 implemented and verified as scoped slices,
2026-10-17. Planned at
commit `dd56bfb` with the companion audit `docs/effect-4-gap-audit.md`.
The target is
`effect@4.0.5` and Deno 2.9.7. This is an implementation plan, not a claim of
full Effect API parity.

> **Executor drift check:** Run `git rev-parse --short HEAD` and compare it with
> `dd56bfb`. If it differs, inspect the live files named in the affected phase
> before editing. Stop that phase when its stated invariant or fixture no longer
> matches. Execute one phase at a time and run its gate before proceeding.

## Goal and boundary

Make valid Effektive programs pass the compiler's own validation, then add
small native source features that fit its sequential execution model. Introduce
first-class effect values, scopes, concurrency, and streams only behind explicit
language-design gates. Platform, HTTP, SQL, RPC, AI, and observability packages
remain TypeScript host implementations exposed through typed Effektive services;
this plan does not add arbitrary package imports to `.eff`.

The [gap audit](../effect-4-gap-audit.md) supplies reproducible `.eff` and
Effect 4 witnesses. The current language spec in
`../effektive/public/effektive-spec.html` (relative to this repository root)
explicitly defers general concurrency, general resource scopes, and broader streams. A phase that
changes those rules must first update the canonical spec in a workspace where
it is writable, then align `docs/phase-a-rules.md` and `README.md`. Do not treat
an emitter feature as language support until parsing, checking, lowering,
validation, emission, and `build --tsc` all pass for it.

## Baseline and shared gates

At planning, `deno task check` passed format, lint, typecheck, 888 fast tests,
and 27 slow tests. One slow test, `watch rebuilds when a source changes
and prints the rechecked modules` in `tests/cli_slow_test.ts:179`, timed out.
It failed again in an isolated run. That baseline verification failure was
independent of the Effect gaps. `src/cli/watch.ts` printed `watching` before it
started iterating the event source; `src/cli/deno_io.ts` created `Deno.watchFs`
inside a lazy async generator. The test edits the file as soon as it sees
`watching`, so that edit could occur before the subscription existed. An
isolated `Deno.watchFs` probe also received no events in this environment.
Phase 0 now starts iteration before printing `watching` and rescans the
project every second when events are absent. The isolated watch test and the
full `deno task check` pass: 888 fast and 28 slow tests.

| Gate | Command | Expected result |
| --- | --- | --- |
| Fast core tests | `deno task test` | All tests pass. |
| Watch reproduction | `deno test --allow-all --filter 'watch rebuilds when a source changes' tests/cli_slow_test.ts` | Pass after phase 0. |
| Full repository gate | `deno task check` | Exit 0 before each phase is declared done and before each commit. |
| Target oracle | Existing `build --tsc` slow-test helpers in `tests/cli_slow_test.ts` and `tests/emit_slow_test.ts` | Generated code checks against `effect@4.0.5`. |

Use temporary projects for CLI builds because `build` writes generated files
next to `.eff` sources. Add tests with `Deno.test` and `@std/assert`; subprocess
tests belong in `*_slow_test.ts`. Keep existing golden output byte-identical
unless a phase intentionally changes emission for an existing valid program.
Do not regenerate mutation or golden fixtures merely to conceal a disagreement.

## Execution order

| Phase | Deliverable | Dependency | Gate |
| --- | --- | --- | --- |
| 0 | Watch readiness and green baseline — **done** | None | Isolated watch test and `deno task check` pass. |
| 1 | Valid pipeline passes IR validation — **done** | 0 for reliable full gate | Retry witness passes `check`, `--validate`, and `--tsc`; mutation tests still catch wrong annotations. |
| 2 | Array and tuple literals in source — **done** | 1 and an accepted narrow source rule | Parser through emitter tests, including generated TypeScript, pass. |
| 3 | Sequential effectful traversal — **done** | 2 and an accepted prelude rule | `traverse` orders calls and preserves failures and requirements. |
| 4 | First-class effect value design and vertical slice — **done** | 3 and an accepted spec change | Effect values can be stored and composed without executing during construction. |
| 5 | Scoped operation records — **done** | 4 and an accepted lifetime model | Release occurs on success, failure, and interruption. |
| 6 | Bounded concurrent traversal — **done** | 5 and an accepted concurrency policy | At most N jobs run; failure and interruption semantics match the spec. |
| 7 | Incremental stream and sink — **done** | 5 and 6, plus a backpressure design | A source-authored stream emits incrementally with bounded demand. |

Phases 0–1 repair behavior under the earlier language design. The source
rules for phases 2–5 are recorded in `docs/phase-a-rules.md` and the canonical
spec. Each later extension needs its own source rule,
not permission to add underspecified syntax now. Each phase is a separate
reviewable change; a failed gate blocks dependent work.

## Phase 0 — make watch readiness truthful

**Current state:** `watchLoop` in `src/cli/watch.ts` awaits its first build,
prints `watching`, then begins `for await (const _batch of events)`. The real
source in `src/cli/deno_io.ts` is lazy through `sourceEvents` and
`debounceBatches` (`src/cli/events.ts`). `tests/cli_slow_test.ts:179` waits for
the message and then changes `users.eff`.

1. Change the real watch subscription or the watch-loop startup so the
   `Deno.watchFs` subscription exists before `watching` is printed. Preserve the
   injected `CliIo.watch` interface and close the watcher on cancellation or
   normal exit. Do not solve the test with a sleep or retrying writes.
2. Keep the slow test as the observable readiness contract. Add a focused fast
   test in `tests/cli_test.ts` only if it can prove the ordering through an
   injected event source; the real subprocess test remains decisive.
3. Run the isolated watch test and `deno task check`; both must pass.

**In scope:** `src/cli/watch.ts`, `src/cli/deno_io.ts`, `src/cli/events.ts`,
`tests/cli_test.ts`, `tests/cli_slow_test.ts` as needed. **Stop** if Deno's
watcher has no observable subscription readiness point; document the smallest
reliable adapter-level readiness signal before altering the test contract.

## Phase 1 — repair pipeline effect annotations

Completed 2026-10-17. The retry witness passes `check`, `--validate`, and
`--tsc`; a deliberately wrong stage requirement still gives
`validation/003`. A named host-provider `provide` pipeline validates. The
checker requires its left value to be a host-provider name, so an
effectful-left provider stage is unavailable under current source rules.
`deno task check` passes.

**Current state:** `src/core/lower.ts:691` computes local stage effects after
moving the left expression into a block binding. Its `retry` and `provide`
branches return `this.info(stage)`, which still includes the already evaluated
left expression. The independent validator recomputes effects from the IR
children. `tests/validate_test.ts:320` currently asserts the false
`validation/003`. `README.md` and `docs/phase-a-rules.md` call this a known
limit.

1. Retain the audit's `Jobs.next() |> retry({ times: 1 })` as a regression
   fixture. Confirm that `check` has no diagnostic, `build --tsc` succeeds, and
   the current `build --validate` reports `validation/003`.
2. Trace the job's invocation effects, the provider's acquisition/provision
   effects, and the effects of other stage arguments. Compute the annotation
   for the *local IR stage* from those operands and operations, excluding only
   effects already paid by the preceding block binding. Do not relax
   `src/core/validate/expr.ts` to accept inconsistent annotations.
3. Probe an effectful-left `provide` pipeline using a real registered host
   provider. Fix it if reachable and mismatched; otherwise record the checked
   reason it cannot occur under the current types. Cover multi-stage pipelines
   and effectful extra arguments so the change does not discard their effects.
4. Change `tests/validate_test.ts:320` to expect zero diagnostics for the valid
   witness, retain mutation fixtures that reject deliberately wrong sets, and
   add a CLI `--validate --tsc` regression in `tests/cli_slow_test.ts`.
5. Remove the obsolete known-limit text from `README.md` and
   `docs/phase-a-rules.md`. Run `deno task check`.

**In scope:** `src/core/lower.ts`, focused validator code only if a separate
validator error is demonstrated, the named tests/fixtures, `README.md`, and
`docs/phase-a-rules.md`. **Stop** if the only apparent fix changes source
evaluation order or makes the validator depend on checker side tables; report
the precise IR and expected effects instead.

## Phase 2 — add collection literals

Implemented and verified 2026-10-17. The parser, checker, lowerer, validator,
emitter, error fixtures, and `build --validate --tsc` tests pass. Existing
golden files are unchanged. The canonical spec amendment is applied.

1. Ratify this narrow source rule, then add one bracket-list expression form
   to `src/core/syntax.ts` and `src/core/parse.ts`; preserve the lossless token
   tree and normal recovery for a missing element or `]`. Resolve and check
   its children in source order. For an expected tuple type, require exactly
   its element count and check each element against the corresponding type.
   Otherwise infer a homogeneous array, widening literal element types as
   existing unannotated bindings do. Require contextual type for `[]`; give a
   specific diagnostic for an uncontextualized heterogeneous list instead of
   silently choosing a union. Specify trailing-comma handling alongside
   existing record lists.
2. Carry the checker choice (array or tuple) in a side fact, lower to the
   existing IR variants, and combine element effects in order. Preserve the
   validator's independent array/tuple checks. Extend emitter handling only
   where tests show a gap, including effectful elements and source spans.
3. Add parser, checker, lower, validation, emitter, CLI `--tsc`, and error
   fixture cases. Include nested lists, `[]` with and without a type, tuple
   arity/type failures, and an element calling a service. Update the source
   rules and canonical spec before declaring the syntax stable.
4. Run `deno task check` and inspect the golden diff; existing programs must
   keep their current output.

**In scope:** `src/core/{syntax,parse,resolve,check_expr,lower}.ts`, related
checker side-fact/diagnostic modules, focused validator/emitter files,
`tests/`, `fixtures/`, `docs/phase-a-rules.md`, and the canonical spec when
writable. **Stop** if array/tuple inference needs a new general union or
subtyping rule; settle that as a spec decision first.

## Phase 3 — add sequential effectful traversal

Implemented and verified 2026-10-17. Direct and pipeline calls pass
`build --validate --tsc`; the runtime test proves left-to-right order and
stopping at the first typed failure. An effectful callback to `map` remains
rejected. The VS Code grammar recognizes `traverse`, and all six golden files
pass `deno fmt --check`. The full gate passes: 895 fast and 32 slow tests.
The canonical spec amendment is applied. `map`, `filter`, and `fold` still
require pure callbacks. Effect 4's
[`Effect.forEach`](https://effect.website/docs/v4/concurrency/basic-concurrency)
runs sequentially when no concurrency option is supplied; pin that behavior
in the target probe.

1. Ratify a separate `traverse(xs, callback)` prelude operation for ordered,
   sequential effectful mapping. Leave the contracts of `map`, `filter`, and
   `fold` intact. Accept both pure and effectful callback functions, but include
   callback *invocation* failures, requirements, and execution mode in the
   traversal's result annotation. Constructing the callback stays pure.
2. Extend prelude resolution and specialization (`src/core/resolve.ts`,
   `src/core/check_expr.ts`), lowering (`src/core/lower.ts`), independent
   builtin validation (`src/core/validate/expr.ts`), and emission
   (`src/core/emit/expr.ts`). Emit an `Effect.forEach` composition against the
   pinned target, with no concurrency option. Handle empty input, callback
   failure, requirements, and pipeline form.
3. Add a runtime slow test with a host service that records call order and
   fails on a chosen element. Add checker/validator tests that reject an
   undeclared callback failure or requirement, and that keep rejecting the
   same callback passed to `map`. Add `--tsc` and golden coverage.
4. Document the new operation and run `deno task check`.

**In scope:** the named core files, supporting prelude/IR type declarations,
focused tests/fixtures, `README.md`, `docs/phase-a-rules.md`, and the canonical
spec when writable. **Stop** if the validator cannot distinguish the new
builtin's effectful callback contract without trusting checker facts; add an
independent rule before shipping.

## Phase 4 — first-class effect values

Implemented and verified 2026-10-17. The accepted
[source design](2026-10-17-effect-value-design.md) and
[canonical amendment](2026-10-17-spec-amendment-effect-values.md) define
`Effect<A, E, R>`, `defer(job)`, and `run(value)`. The compiler stores deferred
channels in the type, activates them only at `run`, and emits
`Effect.suspend` for construction. The independent validator recomputes both
operations. `build --validate --tsc` passes; the generated runtime test
observes zero calls at construction and two calls after two runs. A host
service returning a nested Effect value passes generated TypeScript checking.
Existing source bindings named `run` remain valid and shadow the prelude
operation. The full repository gate passes: 902 fast and 34 slow tests.

## Later native-core milestones

### Phase 5 — scopes

The [Effect 4 target probe and lifetime analysis](2026-10-17-scoped-resource-design.md)
support the accepted operation-record rule. Four target probe cases pass,
including finalizer execution after success, typed failure, and interruption.
The compiler checks direct operation calls and rejects scoped escapes.

The canonical spec now defines `withResource(acquire, use, release)` with an
operation record as its scoped parameter. The distinct `with-resource` IR node,
checker, and independent validator enforce the data-only and no-escape rules
and combine callback invocation channels. The emitter targets
`Effect.acquireUseRelease`; a runtime test verifies release after success,
typed failure, and interruption. The CLI `build --validate --tsc` gate passes.
General borrowed handles still need a separate lifetime and host contract.

### Phase 6 — bounded concurrency

The [bounded traversal target probe and source rule](2026-10-17-bounded-traversal-design.md)
are implemented. Three target tests and the compiler runtime test pass for the
concurrency bound, input order, fail-fast sibling interruption, and finalizer
completion. The CLI `build --validate --tsc` gate passes.

`traverse(items, callback, { concurrency: N })` accepts a positive safe integer
literal and preserves input order. Callback failures and requirements remain
active. On a typed failure it starts no queued job, interrupts active siblings,
and waits for scoped finalizers; explicit interruption also waits. `race`,
unbounded concurrency, and fiber APIs require separate acceptance criteria.

### Phase 7 — streams and sinks

The [stream and sink target probe and source rule](2026-10-17-stream-design.md)
are implemented. The target probe and compiler runtime test pass with one
producer, one effectful transform, and one sink, and measure at most one
produced element ahead of consumption. The CLI `build --validate --tsc` gate
passes.

`Stream<A,E,R>` and `Sink<I,O,E,R>` store deferred channels. `unfold`,
`mapEffect`, and `sinkForEach` construct them; `runStream` activates the
channels. Pull demand has no prefetch: the next pull follows consumer
completion. The source callback forms are inline arrows. Buffered or
concurrent stream operations and general sink results need separate rules.

## Deferred queue and host policy

General `Schedule`, `Ref`, custom Schema codecs, source-defined `Layer` graphs,
user generics, and recursive schemas remain individually scoped design items
from the gap audit. Their absence must remain documented; do not silently
claim Effect parity when phases 0–7 pass. For ecosystem packages, add a small
typed service adapter example for a representative package only when an
application needs it. The adapter must state source-visible failures and
requirements and keep package-specific objects in TypeScript unless a native
type milestone explicitly admits them. Review streaming, transactions,
scoped handles, and codec-bearing APIs against phases 4–7 before promising an
equivalent Effektive interface.

## Completion and stop conditions

For each implemented phase: relevant targeted tests pass; `deno task check`
exits 0; generated TypeScript passes the pinned `effect@4.0.5` oracle; the
canonical source rules and README match behavior; unrelated golden output is
unchanged. Recheck the original audit witnesses and update the coverage map
only for behaviors actually demonstrated.

Stop the affected phase and report its witness if the target Effect API at
`4.0.5` rejects the proposed emission, a source-spec decision is unresolved,
an IR annotation cannot be independently validated, the full gate fails twice
after a focused correction, or a needed file lies outside the writable
workspace. Do not bypass a failing gate by disabling a test or weakening the
validator.

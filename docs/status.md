# Project status

This file is the one place for the current project status. It holds the application stopping rule, the three application dispositions, the remaining and deferred gaps, and the open items. Other documents link here and do not restate these facts.

## Stopping rule

The accepted [application acceptance rule](plans/2026-10-19-application-acceptance-rule.md) bounds gap work. Gap features stop when three complete applications compile with precise contracts and pass failure, cancellation, and cleanup checks. The three applications are a service workflow, a scheduled worker, and a stream processor. Application orchestration stays in `.eff`. Typed host adapters may supply drivers and the runtime entry point.

All three application gates pass with existing language forms. The stopping rule is satisfied, so automatic API parity additions stop. Select a new language feature only for a demonstrated application blocker or an explicit change to the accepted target. First try existing source compositions. Gap item 9 (broader package interoperability) remains deferred by user instruction. Release acceptance (editor behavior, packaging, performance, external integration) is separate work. The full rule is in the linked plan.

## Application dispositions

Each application uses existing Effective forms. No compiler, IR, builtin, or syntax change was selected for any of them. The drivers record calls in memory and perform no external I/O. The fixture README of each application gives the build and run commands.

| Application | Gate result | Limits |
| --- | --- | --- |
| [Service workflow](../fixtures/applications/service-workflow/README.md) | Passes with a registered atomic SQL adapter and fifteen compiled runtime cases. Source owns validation, catalog use, retry selection, and the exported contract. The adapter owns one atomic save and its connection lifecycle. | No check covers external database behavior, source-authored transaction callbacks, idempotency, or exactly-once submission. An ambiguous commit stays Permanent, because a retry could duplicate a committed write. The simulated COMMIT error proves no retry, not real ambiguous-commit behavior. Plan: [service workflow](archive/plans/2026-10-19-service-workflow-application.md#disposition-and-limits). |
| [Scheduled worker](../fixtures/applications/scheduled-worker/README.md) | Passes with ten compiled runtime cases. A source-authored concrete policy owns repetition, transient retry, and resource release. The runtime entry point owns whole-worker interruption. | General opaque Schedule consumers remain an API gap. The native reference comparison covers the selected fixed policy, timing, and results only. A future application that needs opaque policies, richer scheduling, or an in-source shutdown protocol must supply its own blocker witness. Plan: [scheduled worker](archive/plans/2026-10-19-scheduled-worker-application.md#disposition-and-limits). |
| [Stream processor](../fixtures/applications/stream-processor/README.md) | Passes with ordered concurrent mapping, backpressure, selective fallback, and thirteen compiled runtime cases. Source owns the whole pipeline and the session lifetime. | The application promises no rollback, no exactly-once delivery, no recovery of arbitrary mixed causes, and no global memory bound from one queue capacity. Native `catchTags` can hide an accompanying defect. Plan: [stream processor](archive/plans/2026-10-19-stream-processor-application.md#disposition-and-limits). |

## Remaining and deferred gaps

Current disposition: 2026-10-19, design draft 0.57, `effect@4.0.5`.
This section consolidates the remaining boundaries after all three
[application gates](plans/2026-10-19-application-acceptance-rule.md) passed.
Earlier update entries and probe diagnostics describe their original snapshots.
The tables below are a record of gaps, not an implementation queue.

### Open API and language gaps outside the accepted target

| Area | Remaining boundary | Existing support and evidence |
| --- | --- | --- |
| General Effect and concurrency APIs | Other first-class combinators, coordination primitives and cause-level recovery APIs lack general source forms. | Effect values, collections, racing, supervised fibers and scope-bound children cover the selected subset. See the [coverage map](archive/effect-4-gap-audit.md#coverage-map). |
| Full Scope parity | Supplied close Exits, exit-aware callbacks, parallel finalization strategies, mandatory closure and static dependency-cycle detection remain outside the selected contract. | Shared CloseableScope authority closes once with Exit.void and caches cleanup completion. See the [ownership contract](archive/plans/2026-10-18-scope-ownership-contract.md). |
| General Stream and Sink APIs | Other operators, arbitrary source Sink constructors, chunk-cost throttling and unrestricted nested group streams need additional source and lifetime rules. | Leftovers, transduction, aggregation and callback-owned keyed groups are implemented. Selected external interruption has a source composition. See the [investigation](archive/plans/2026-10-18-general-stream-schedule-design.md). |
| General Schedule APIs | Opaque Schedule consumers for retry and repetition, composition with incomparable input types, other combinators and cron policies remain uncovered. | RetrySchedule and a concrete source repetition policy meet the worker gate. General schedules support aggregation and selected comparable-input composition. See the [worker limits](archive/plans/2026-10-19-scheduled-worker-application.md#disposition-and-limits). |
| Time control | A general source clock and time-control API remains a candidate without a demonstrated application blocker. | Primitive clock services and native virtual-time checks cover the selected applications. See the [accepted rule](plans/2026-10-19-application-acceptance-rule.md#feature-selection). |
| Schema and recursion | Recursive Option data, mutual recursion, arbitrary self-bearing transformations and general Schema AST construction remain unsupported. | Guarded recursion preserves separate decoded, encoded and make-input types through selected adapters. See the [recursive field contract](archive/plans/2026-10-19-schema-recursive-adapters-contract.md). |
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
The [adapter investigation](archive/plans/2026-10-18-schema-ecosystem-design.md) records
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

The [service workflow](archive/plans/2026-10-19-service-workflow-application.md#disposition-and-limits)
and [stream processor](archive/plans/2026-10-19-stream-processor-application.md#disposition-and-limits)
record these boundaries with compiled checks.

### Separate release acceptance

Editor behavior, packaging, performance and external integration acceptance
remain separate work. Passing the application gates does not establish their
completion or declare existing editor and packaging implementations absent.
This gap record selects no release task or additional language implementation.

## Open items

The hardening plan [section 9](plans/2026-10-20-hardening-pruning.md) tracks the work items. This list gives the items that still need a person.

| Item | State | Owner |
| --- | --- | --- |
| T6 (stale local state) | `.claude/worktrees/` holds three git worktrees, and one is locked. Ignored build output sits in `fixtures/applications/stream-processor/` and `fixtures/errors/declaration-primitive-position-host/`. The user removes them, because the locked worktree may be in use. | User |
| Hand test of the VS Code client | Acceptance check 5 of the [language server plan](archive/plans/2026-10-16-lsp.md) is not done. | User |
| Playground acceptance | The user has not accepted the page (acceptance check 5 of the [playground plan](archive/plans/2026-10-16-playground.md)). A manual browser review on 2026-10-16 passed at 375 and 1280 pixels. Three later commits changed the page: the 720 pixel threshold, the hover feedback, and the wrap indent. No review ran after them. | User |
| Documentation items W1, W2, W3, W5 | Done in the documentation batch. The plan owner records them in section 9 of the hardening plan. | Plan owner |
| Measured numbers | The documents hold no measured number from the bench harnesses. The user decides which numbers enter the docs. | User |

## Implementation parts

The implementation followed parts A1 to A8 of the [Phase A plan](archive/plans/2026-10-16-phase-a.md), parts L1 to L6 of the [language server plan](archive/plans/2026-10-16-lsp.md), and parts G1 to G4 of the [playground plan](archive/plans/2026-10-16-playground.md). All parts exist. The rules that they chose are in [language-rules.md](language-rules.md).

| Part | What it added |
| --- | --- |
| A1 | The project skeleton, the lexer, a lossless parser with error recovery, and the `syntax` diagnostics. |
| A2 | The declaration index, the project loader, the module graph, and the name resolver. |
| A3a | The declaration level of the checker: type intern table, compatibility rules, signatures, and module interfaces with hashes. |
| A3b | Body checking, effect and execution-mode inference, contracts, patterns, the module initialization graph, and the hover query. |
| A4 | Lowering of a checked module to typed IR, its serialization, and a synchronous SHA-256 for builtin identities. |
| A5 | The independent IR validator and the mutation fixtures in `fixtures/validate/`. |
| A6a | The Effect-TS emitter, the five golden files, the host module `users-live.ts`, and the slow tests that check and run the emitted code. |
| A6b | The span table, version 3 source maps, and the mapping of `deno check` errors to Effective spans. The printer is a fixed point of `deno fmt` for the golden files and for `fixtures/emit/forms/`. |
| A7 | The program with module cutoff (`src/core/db.ts`), the public API (`src/core/mod.ts`), and the command-line tool (`src/cli/main.ts`) with the commands `check`, `build`, and `watch` and the flags `--tsc` and `--validate`. |
| A8 | The measurement harnesses in `bench/`: a synthetic module generator and the measurements M2, M5, and M6. |
| L1 to L6 | The language server in `src/lsp/`, the VS Code client in `editors/vscode/`, and the measurements M1, M3, and M4. |
| G1 to G4 | The playground in `playground/`. |


# Project status

This file is the one place for the current project status. It holds the
application stopping rule, the application dispositions (three gate applications
and witnesses for nominal types and portability), the remaining and deferred gaps, and
the open items. Other documents link here and do not restate these facts.

## Stopping rule

The accepted
[application acceptance rule](plans/2026-10-19-application-acceptance-rule.md)
bounds gap work. Gap features stop when three complete applications compile with
precise contracts and pass failure, cancellation, and cleanup checks. The three
applications are a service workflow, a scheduled worker, and a stream processor.
Application orchestration stays in `.eff`. Typed host adapters may supply
drivers and the runtime entry point. The order lifecycle application is a
witness for nominal types. It is not one of the three gate applications.

All three application gates pass with existing language forms. The order
lifecycle witness also passes. The portable publisher is an additional
exploratory witness, not a gate application.

The stopping rule is satisfied, so automatic API parity additions stop. Select a new language feature only for a demonstrated
application blocker or an explicit change to the accepted target. First try
existing source compositions. Gap item 9 (broader package interoperability)
remains deferred by user instruction. Release acceptance (editor behavior,
packaging, performance, external integration) is separate work. The full rule is
in the linked plan.

## Application dispositions

Each application uses existing Effektive forms. No compiler, IR, builtin, or
syntax change was selected for any of them. The original deterministic drivers
record calls in memory. A separate service-workflow acceptance driver now uses
loopback HTTP and file-backed SQLite; [integration evidence](integration.md)
records its narrower guarantees. The fixture README of each application gives
the build and run commands.

| Application                                                             | Gate result                                                                                                                                                                                                                                                                | Limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Service workflow](../fixtures/applications/service-workflow/README.md) | Passes with a registered atomic SQL adapter and fifteen compiled runtime cases. Source owns validation, catalog use, retry selection, and the exported contract. The adapter owns one atomic save and its connection lifecycle.                                            | Separate [HTTP/SQLite checks](integration.md) cover local persistence, rollback, cancellation and cleanup. Source-authored transaction callbacks, idempotency and exactly-once submission remain outside the witness. An ambiguous commit stays Permanent, because a retry could duplicate a committed write. The simulated COMMIT error proves no retry, not real ambiguous-commit behavior. Plan: [service workflow](archive/plans/2026-10-19-service-workflow-application.md#disposition-and-limits). |
| [Scheduled worker](../fixtures/applications/scheduled-worker/README.md) | Passes with ten compiled runtime cases. A source-authored concrete policy owns repetition, transient retry, and resource release. The runtime entry point owns whole-worker interruption.                                                                                  | General opaque Schedule consumers remain an API gap. The native reference comparison covers the selected fixed policy, timing, and results only. A future application that needs opaque policies, richer scheduling, or an in-source shutdown protocol must supply its own blocker witness. Plan: [scheduled worker](archive/plans/2026-10-19-scheduled-worker-application.md#disposition-and-limits).                                                                                                   |
| [Stream processor](../fixtures/applications/stream-processor/README.md) | Passes with ordered concurrent mapping, backpressure, selective fallback, and thirteen compiled runtime cases. Source owns the whole pipeline and the session lifetime.                                                                                                    | The application promises no rollback, no exactly-once delivery, no recovery of arbitrary mixed causes, and no global memory bound from one queue capacity. Native `catchTags` can hide an accompanying defect. Plan: [stream processor](archive/plans/2026-10-19-stream-processor-application.md#disposition-and-limits).                                                                                                                                                                                |
| [Order lifecycle](../fixtures/applications/order-lifecycle/README.md)   | A witness for nominal types, not a gate application. Passes with nine compiled runtime cases. Four nominal record states cross a module boundary. A `match` by name covers each state. A recursive pricing rule tree uses a nominal record. Decoding keeps the module-qualified `_tag`. | The application has no service, no driver, and no concurrency. Percent pricing is not possible, because `/` gives `number`. Plan: [nominal examples](archive/plans/2026-10-23-nominal-examples.md).                                                                                                                                                                                                                                                                                                              |
| [Portable publisher](../fixtures/applications/portable-publisher/README.md) | An exploratory portability witness, not a gate application. Source owns publication, conflict policy, grants, and serial batching. Memory and SQLite pass one shared KV suite. | The checks cover local storage in one process, finite batch completion, interruption, and cleanup. A committed write with a simulated lost acknowledgement returns uncertainty without retry. No crash recovery, exactly-once delivery, or HTTP admission protocol is promised. [Plan](plans/2026-10-23-portable-applications.md); [gap assessment](plans/portable-applications-gaps.md). |

## Remaining and deferred gaps

Current disposition: 2026-10-19, design draft 0.57, `effect@4.0.5`. The
specification is now at draft 0.58. That draft removes seven builtins in favor
of existing forms and adds no gap to the tables below. This section consolidates
the remaining boundaries after all three
[application gates](plans/2026-10-19-application-acceptance-rule.md) passed.
Earlier update entries and probe diagnostics describe their original snapshots.
The tables below are a record of gaps, not an implementation queue.

### Open API and language gaps outside the accepted target

| Area                                | Remaining boundary                                                                                                                                                                                                                                              | Existing support and evidence                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General Effect and concurrency APIs | Other first-class combinators, coordination primitives and cause-level recovery APIs lack general source forms.                                                                                                                                                 | Effect values, collections, racing, supervised fibers and scope-bound children cover the selected subset. See the [coverage map](archive/effect-4-gap-audit.md#coverage-map).                                                                                          |
| Full Scope parity                   | Supplied close Exits, exit-aware callbacks, parallel finalization strategies, mandatory closure and static dependency-cycle detection remain outside the selected contract.                                                                                     | Shared CloseableScope authority closes once with Exit.void and caches cleanup completion. See the [ownership contract](archive/plans/2026-10-18-scope-ownership-contract.md).                                                                                          |
| General Stream and Sink APIs        | Other operators, arbitrary source Sink constructors, chunk-cost throttling and unrestricted nested group streams need additional source and lifetime rules.                                                                                                     | Leftovers, transduction, aggregation and callback-owned keyed groups are implemented. Selected external interruption has a source composition. See the [investigation](archive/plans/2026-10-18-general-stream-schedule-design.md).                                    |
| General Schedule APIs               | Opaque Schedule consumers for retry and repetition, composition with incomparable input types, other combinators and cron policies remain uncovered.                                                                                                            | RetrySchedule and a concrete source repetition policy meet the worker gate. General schedules support aggregation and selected comparable-input composition. See the [worker limits](archive/plans/2026-10-19-scheduled-worker-application.md#disposition-and-limits). |
| Time control                        | A general source clock and time-control API remains a candidate without a demonstrated application blocker.                                                                                                                                                     | Primitive clock services and native virtual-time checks cover the selected applications. See the [accepted rule](plans/2026-10-19-application-acceptance-rule.md#feature-selection).                                                                                   |
| Schema and recursion                | Recursive Option data in an alias, mutual recursion of aliases, arbitrary self-bearing transformations and general Schema AST construction remain unsupported. Nominal records support guarded and mutual recursion (see [nominal types](#nominal-types)). | Guarded recursion preserves separate decoded, encoded and make-input types through selected adapters. See the [recursive field contract](archive/plans/2026-10-19-schema-recursive-adapters-contract.md).                                                              |
| General language extensions         | User-defined generics, effect-row polymorphism, source purity assertions, macros and early returns remain deferred language extensions.                                                                                                                         | Builtin generic types and concrete source compositions cover the accepted applications. The [specification](../../effektive/public/effektive-spec.html#examples) retains the broader language boundary.                                                                |

Reopen an item only for a demonstrated application blocker or an explicit change
to the accepted target. First check equivalent existing source compositions.
Record a minimal witness, intended contract, observed diagnostic or behavior,
and the required failure, cancellation and cleanup semantics. No item has an
automatic priority or implementation commitment.

### Explicit user deferral: item 9

Broader package interoperability remains deferred until the user revisits it.
This covers arbitrary external package imports, external values and
constructors, and package-specific API objects or builders authored directly in
source. Direct source composition of HTTP, SQL, RPC, AI and observability
builders belongs to this deferral. The registered typed host interface remains
available for concrete adapters. The
[adapter investigation](archive/plans/2026-10-18-schema-ecosystem-design.md)
records the supported route and its limits.

A new application blocker does not revoke the explicit deferral of item 9. The
user must change that instruction before broader interoperability work starts.

### Runtime behavior and evidence limits

These are limits of the selected witnesses, not automatically selected features.
The three application gates, and the order lifecycle witness, establish neither
complete Effect API parity nor external integration coverage.

| Boundary                        | Recorded behavior or evidence limit                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed recovery and mixed causes | Native catchTags can select a typed reason and discard an accompanying defect. The stream witness records this limit. Its session finalizers run outside item recovery.                         |
| Transaction cancellation        | Body interruption awaits rollback and release. Interruption after COMMIT starts can preserve a committed row. The simulated COMMIT error proves no retry, not actual ambiguous-commit behavior. |
| Stream failure and buffering    | Native transduction can emit a partial batch before upstream failure. The pinned backpressure trace establishes no global memory bound.                                                         |
| Delivery guarantees             | The applications promise neither exactly-once delivery nor rollback of earlier successful batches.                                                                                              |
| External services               | Seven [loopback HTTP and file-backed SQLite checks](integration.md) cover the service workflow. Remote services, RPC, AI and telemetry acceptance remain outside that coverage.                 |

The
[service workflow](archive/plans/2026-10-19-service-workflow-application.md#disposition-and-limits)
and
[stream processor](archive/plans/2026-10-19-stream-processor-application.md#disposition-and-limits)
record these boundaries with compiled checks.

### Nominal types

The `nominal` declaration is in place as of 2026-10-23
([plan](archive/plans/2026-10-23-nominal-keyword.md)). It replaces the `data` declaration
([earlier plan](archive/plans/2026-10-23-nominal-data-types.md)) and `Brand<T>`.
The form is `nominal Name = <type>`, and `type` stays the structural form. A body
that is a record after aliases unfold gives a nominal record with a runtime
`_tag`. Any other body lowers to an Effect brand that the source does not name.
`data` is an ordinary name, and `Brand` and `unbrand` are unknown names.

An open nominal value fits its base type, so `unbrand` is removed. Sealed types restrict that conversion to their declaring module. A base value needs
the constructor. Operators compare and combine nominal values by class:
`id === "u1"` and `total > 0` are legal, `total * 2` gives `int`, and
`cents + meters` is an error. A nominal body cannot hold a nominal record or a
union with a record (`declaration/014`). A function, deferred, or opaque type in
a body or field gives `declaration/015` or `declaration/016`.

A `match` selects nominal records and errors by name. A nominal record can be
recursive when every cycle has a base case. The IR has the version 3, with one
definition kind and one construction node `nominal`. The editor, the TextMate
grammar, and the playground highlighter know the word `nominal`. The website and
the canonical specification describe nominal types from draft 0.60.

Each `.effi` file has a generated companion module, such as `host.effi.ts`
([plan](archive/plans/2026-10-23-host-interface-companion.md)). It holds the
types, nominal types, errors, and services of the interface. Source modules and
host modules import them from it, so the compiler owns every tag string. So
`.eff` code can construct an `.effi` nominal type, and a provider result of a
nominal record is checked at run time.

Nominal record values from unsound host code fail loudly at run time
([plan](archive/plans/2026-10-23-host-boundary-checks.md)). A `match` whose last arm is
not `_` tests that arm and throws for a value outside its type. A host provider
whose methods return nominal record values is wrapped, and each such result or stream
element goes through `Schema.is`. The language rules list the positions that
stay trusted, under "Host provider checks".

The table gives the measured cost on emitted code, with an in-memory host. The
machine was an Apple M4 Pro with Deno 2.9.8 and Effect 4.0.5. The cost in an
application with real I/O is not measured.

| Case                                   | Plain alias | Wrapped provider | Added cost                     |
| -------------------------------------- | ----------- | ---------------- | ------------------------------ |
| One `provide`, one data result         | 3.7 us      | 9.0 us           | 5.3 us                         |
| One `provide`, 100 calls               | 12.0 us     | 31.6 us          | about 0.14 us for each call    |
| One `provide`, one array of 100 values | 3.6 us      | 19.4 us          | 15.8 us                        |
| One `provide`, a stream of 1000 values | 6.6 us      | 133.4 us         | about 0.13 us for each element |
| The extra arm test of one `match`      | -           | -                | about 0.27 ns                  |

### Portable extensions

The user approved the [portable extensions](plans/2026-10-23-portable-extensions.md)
after the publishing witness established its existing composition.
Sealed nominal types restrict construction, updates, arithmetic, widening, and schema derivation to the declaring module.
Pure function types require pure execution and empty effect sets. Optional import rules restrict direct dependency edges.
Existing open nominal types, unmarked function types, and projects without import rules retain their behavior.

The [extension worklog](plans/portable-extensions-worklog.md) records the compiler, validator, editor, and example checks.
The sibling website includes paired source and TypeScript panels and a runnable project for all three controls.
These changes do not expand the three-application stopping rule. Named platforms continue to use existing services and Layers.

### Separate release acceptance

Editor behavior, packaging, performance and external integration acceptance are
tracked separately from the application gates. The selected automated release
checks now pass; user manual editor and playground acceptance remains pending.
The accepted [editor and release plan](plans/2026-10-21-editor-release.md)
selects editor capabilities, local installation, HTTP/SQLite integration and
automated release checks. It selects no new language forms. The
[correctness plan](archive/plans/2026-10-21-correctness-fixes.md) records the
prerequisite fixes.

The [audit fix batch](archive/plans/2026-10-21-audit-fixes.md) and all its
follow-ups are complete. The
[save-transpilation plan](archive/plans/2026-10-21-save-transpilation.md) is
also complete; the
[save-round measurements](release-measurements.md#save-rounds) record its M7 and
M4 results. Both plans are archived.

## Open items

The hardening plan [section 9](plans/2026-10-20-hardening-pruning.md) tracks the
work items. This list gives the items that still need a person.

| Item                            | State                                                                                                                                                                                                                                                                                                                                                                                                                    | Owner |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Hand test of the VS Code client | The installed VSIX passed automated references, rename, completion, semantic tokens, contract quick fixes, generated output, save, error recovery and restart on 2026-10-21; [installation evidence](installation.md). User acceptance check 5 of the [language server plan](archive/plans/2026-10-16-lsp.md) remains pending.                                                                                           | User  |
| Playground acceptance           | The user has not accepted the page (acceptance check 5 of the [playground plan](archive/plans/2026-10-16-playground.md)). An [automated browser review on 2026-10-21](playground-review-2026-10-21.md) passed at 375, 720 and 1280 pixels, including keyboard navigation, type/syntax error recovery and screenshot inspection. It does not replace the user’s manual acceptance.                                        | User  |
| Rederive review                 | VAL-8 of the [rederive review](plans/2026-10-20-rederive-review.md) is complete. ARC-5 is declined after its name-only mapping prerequisite failed; the [assessment](plans/rederive-review-evidence/arc-5-builtin-facts.md) records six names with context-dependent lowering kinds. R12 FE-2, CHK-11, CHK-12, R13, R15a, R15b, C10 and A6 are complete. The refactor plan defers C7, F3, and F9b. No item has an owner. | User  |
| Measured numbers                | Earlier evidence remains in `rejected.md` (the lexer split) and the audit fix plan (AU1). The [full release measurements](release-measurements.md) meet the unchanged 100 ms large-input p90 diagnostics budget and include three open documents with 10,000 distinct edits. Raw RSS, heap and type-table samples record growth; they establish no memory bound.                                                         | User  |

## Implementation parts

The implementation followed parts A1 to A8 of the
[Phase A plan](archive/plans/2026-10-16-phase-a.md), parts L1 to L6 of the
[language server plan](archive/plans/2026-10-16-lsp.md), and parts G1 to G4 of
the [playground plan](archive/plans/2026-10-16-playground.md). All parts exist.
The rules that they chose are in [language-rules.md](language-rules.md).

| Part     | What it added                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1       | The project skeleton, the lexer, a lossless parser with error recovery, and the `syntax` diagnostics.                                                                                                                        |
| A2       | The declaration index, the project loader, the module graph, and the name resolver.                                                                                                                                          |
| A3a      | The declaration level of the checker: type intern table, compatibility rules, signatures, and module interfaces with hashes.                                                                                                 |
| A3b      | Body checking, effect and execution-mode inference, contracts, patterns, the module initialization graph, and the hover query.                                                                                               |
| A4       | Lowering of a checked module to typed IR, its serialization, and a synchronous SHA-256 for builtin identities.                                                                                                               |
| A5       | The independent IR validator and the mutation fixtures in `fixtures/validate/`.                                                                                                                                              |
| A6a      | The Effect-TS emitter, the five golden files, the host module `users-live.ts`, and the slow tests that check and run the emitted code.                                                                                       |
| A6b      | The span table, version 3 source maps, and the mapping of `deno check` errors to Effektive spans. The printer is a fixed point of `deno fmt` for the golden files and for `fixtures/emit/forms/`.                            |
| A7       | The program with module cutoff (`src/core/db.ts`), the public API (`src/core/mod.ts`), and the command-line tool (`src/cli/main.ts`) with the commands `check`, `build`, and `watch` and the flags `--tsc` and `--validate`. |
| A8       | The measurement harnesses in `bench/`: a synthetic module generator and the measurements M2, M5, and M6.                                                                                                                     |
| L1 to L6 | The language server in `src/lsp/`, the VS Code client in `editors/vscode/`, and the measurements M1, M3, and M4.                                                                                                             |
| G1 to G4 | The playground in `playground/`.                                                                                                                                                                                             |

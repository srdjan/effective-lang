# Application acceptance rule

Date: 2026-10-19. Status: accepted by the user; all three application gates complete.
Compiler target: Deno 2.9.7 and `effect@4.0.5`.

## Decision

Stop adding gap features when three complete applications compile with precise
contracts and pass failure, cancellation, and cleanup checks. The three
applications are a service workflow, a scheduled worker, and a stream processor.
The current core 1 subset is the baseline for these applications.

Application orchestration stays in `.eff`. Typed host adapters may supply
drivers and the runtime entry point. A host adapter must not conceal missing
application orchestration. A transaction adapter may own its connection and
commit or rollback lifecycle under the existing host contract.

This rule bounds the application target. It does not establish full Effect API
parity or completion of editor, packaging, performance, or external integration
acceptance checks. All three application witnesses now pass using existing language forms.
The accepted language stopping rule is satisfied. This does not complete
the separate release acceptance checks.

## Application gates

| Application | Required behavior | Status |
| --- | --- | --- |
| Service workflow | Validate input, call services, retry a transient failure, and use a scoped transaction adapter. Check the successful result, rejected input, exhausted retries, rollback after failure or cancellation, and completed release. | Complete: [service workflow witness](../archive/plans/2026-10-19-service-workflow-application.md). |
| Scheduled worker | Run repeated work under a policy, handle selected transient failures, and shut down while work or a delay is pending. Check policy completion, terminal failure, fresh state on another execution, and completed cleanup after cancellation. | Complete: [worker witness](../archive/plans/2026-10-19-scheduled-worker-application.md). |
| Stream processor | Transform and batch a live input under backpressure, with explicit recovery behavior. Check ordered results where promised, partial batches, failure propagation, cancellation of pending work, and completed upstream and consumer cleanup. | Complete: [stream processor witness](../archive/plans/2026-10-19-stream-processor-application.md). |

Each witness must pass source checking, independent IR validation, and strict
checking of emitted TypeScript against the pinned target. Negative source
checks must reject incorrect result, failure, and service contracts. Runtime
checks must exercise the complete orchestration, including its host adapters.
Existing operator tests and small adapter probes are supporting evidence.

Use deterministic drivers and synchronization for application behavior checks.
Record any real network or database coverage separately. Fake drivers do not
establish external integration coverage. Record commands, results, and remaining
limits alongside each completed application witness.

## Feature selection

All three application gates pass with existing source forms. For a newly
required behavior, try existing source compositions first.
If a required behavior fails, record the minimal witness, compiler diagnostic
or runtime difference, and the reason an existing composition cannot express it.

Select a new feature only when that evidence establishes an application blocker.
Keep the existing spec, checker, independent validator, emitted target checks,
runtime checks, and documentation gates for any selected feature. Commit each
complete addition separately.

Time control and explicit user generics remain open candidates. They are
not mandatory additions if the application gates pass without them. Further
coordination primitives, Sink builders, and Schema extensions follow the same
evidence rule. Recursive Option data no longer takes automatic priority.

## Deferred boundary

The [remaining and deferred gap record](../status.md#remaining-and-deferred-gaps)
consolidates current open APIs, explicit deferrals and evidence limits. It is
not an implementation queue.

Broader package interoperability, gap item 9, remains deferred by user instruction.
Direct package imports and package-specific builders are not application gate
requirements. The existing registered typed host boundary remains available.

Cron policies, general Schedule input intersections, arbitrary Schema AST
access, mutual recursion, and full Scope parity are outside this target unless
a demonstrated application blocker changes the decision. Any change must retain
the explicit deferral of item 9 until the user revisits it.

## Next action

The implementing agent will stop automatic API additions under this accepted
rule. All three applications pass without new language forms. Further language
work requires a demonstrated application blocker or an explicit target change.
Editor, packaging, performance and external integration acceptance remain
separate work. Item 9 stays deferred until the user revisits it.

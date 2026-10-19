# Application acceptance rule

Date: 2026-10-19. Status: accepted by the user; application gates pending.
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
acceptance checks. The three application gates remain pending until their
complete witnesses pass.

## Application gates

| Application | Required behavior | Status |
| --- | --- | --- |
| Service workflow | Validate input, call services, retry a transient failure, and use a scoped transaction adapter. Check the successful result, rejected input, exhausted retries, rollback after failure or cancellation, and completed release. | Pending |
| Scheduled worker | Run repeated work under a policy, handle selected transient failures, and shut down while work or a delay is pending. Check policy completion, terminal failure, fresh state on another execution, and completed cleanup after cancellation. | Pending |
| Stream processor | Transform and batch a live input under backpressure, with explicit recovery behavior. Check ordered results where promised, partial batches, failure propagation, cancellation of pending work, and completed upstream and consumer cleanup. | Pending |

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

Start with the scheduled worker baseline and investigate general Schedule
consumers for retry and repetition. Try the existing source forms first.
If a required behavior fails, record the minimal witness, compiler diagnostic
or runtime difference, and the reason an existing composition cannot express it.

Select a new feature only when that evidence establishes an application blocker.
Keep the existing spec, checker, independent validator, emitted target checks,
runtime checks, and documentation gates for any selected feature. Commit each
complete addition separately.

Time control and explicit user generics are subsequent candidates. They are
not mandatory additions if the application gates pass without them. Further
coordination primitives, Sink builders, and Schema extensions follow the same
evidence rule. Recursive Option data no longer takes automatic priority.

## Deferred boundary

Broader package interoperability, gap item 9, remains deferred by user instruction.
Direct package imports and package-specific builders are not application gate
requirements. The existing registered typed host boundary remains available.

Cron policies, general Schedule input intersections, arbitrary Schema AST
access, mutual recursion, and full Scope parity are outside this target unless
a demonstrated application blocker changes the decision. Any change must retain
the explicit deferral of item 9 until the user revisits it.

## Next action

The implementing agent owns the scheduled worker baseline and Schedule consumer
investigation. Update this plan and the gap audit with each application result.

# Service workflow application

Date: 2026-10-19. Status: implemented and verified application witness.
Target: Deno 2.9.7 and `effect@4.0.5`.
This follows the accepted [application acceptance rule](2026-10-19-application-acceptance-rule.md).

## Required behavior

The workflow validates an unknown order request before calling a service.
It checks quantity and SKU rules, obtains a catalog price, validates the price
range, computes a bounded integer total, and stores the resulting order.
Source code selects transient storage retries and returns the stored receipt.
Catalog failures and permanent storage failures propagate without retry.

Use a fixed maximum of two additional storage attempts, with delays of five
and ten milliseconds. Retry only failures marked Transient after a transaction
body failure. Do not repeat the catalog call or validation during storage retry.
Replaying the exported Effect starts a new workflow and fresh retry budget.

## Adapter boundary

Declare StoreLive through the existing registered .effi host boundary. It
provides the source Store service and retains a Runtime.database capability
and StoreFailure acquisition channel. Runtime.database returns an opaque
Backend whose implementation stays in TypeScript. Catalog remains a separate
source-visible service. Strict host assertions must check the provider and
service interfaces.

Store.save is one atomic adapter operation. It uses the pinned SqlClient
transaction wrapper, parameterized statement construction, and receipt row
validation over a recording in-memory connection. The adapter owns lease,
BEGIN, COMMIT or ROLLBACK, and release. Source owns the business workflow and
retry decision. Source withResource has no outcome argument and is not used
to invent transaction semantics.

Only explicitly retryable write failures map to Transient StoreFailure.
Commit errors map to Permanent, so an ambiguous commit is not automatically
retried. Rollback and release defects retain their native channels. A cancelled
transaction body rolls back and releases before interruption completes.
Cancellation after commit starts follows the native transaction boundary;
this witness must not promise rollback after a completed commit.

## Application checks

Check successful receipts, SQL parameters, stored state and the complete
transaction trace. Invalid input must cause no service calls. Business or
catalog rejection must cause no transaction. Retry tests must verify rollback
and release before another lease, exhaustion after three total attempts, no
catalog repetition, and fresh budgets when replaying one Effect.

Check provider and lease acquisition failure, invalid receipt rows, typed
write failures, permanent errors, commit errors, execution defects and cleanup
defects. Cancel an executing write with staged data and deliberately block
rollback or release. Interruption must remain pending until cleanup finishes;
no rows may commit after body cancellation. Gate-opening test cleanup must
survive assertion failure.

The fixture needs a runnable entry point, deterministic drivers, source contract
rejections, independent IR validation, strict emitted and host checking, and
compiled runtime cases. It performs no external database or HTTP I/O.

## Feature decision

Try the existing Schema, RetrySchedule, service, provider and host forms first.
Select a new language feature only if the complete application exposes a
blocker. Broader package interoperability, gap item 9, stays deferred.

## Review resolution

Only a retryable SqlError inside the statement body maps to Transient.
Provider, lease, BEGIN and COMMIT failures stay Permanent, even with misleading
operation metadata. Translate each typed reason with Cause.map
inside Effect.catchCause, preserving the full cause. Effect.mapError can select
a typed reason from a mixed cause and discard a cleanup defect. The pinned
Effect.retry retries typed-only causes, so preserved defects prevent another
attempt. Test combined body failure and cleanup defects explicitly.

The fixed delays are five and ten milliseconds. Test virtual time, cancellation
during both delays, all exported failure channels, retained services, and
Store capability discharge through the registered provider.

The independent implementation review found no blocking issues and reran both
application test files successfully. Its evidence limit concerns simulated
COMMIT failure: the recording driver fails before changing committed state.
The documentation records that distinction below.

## Completion evidence

The [application fixture](../../fixtures/applications/service-workflow/README.md)
contains source contracts, registered host declarations, a source workflow,
the native SQL adapter, recording drivers, an entry point and fourteen runtime checks.
Two [source checks](../../tests/application_service_workflow_test.ts) validate
linked IR and reject erased result, failure and retained service contracts.
The [compiled application harness](../../tests/application_service_workflow_slow_test.ts)
checks emitted TypeScript and the registered adapter strictly, runs all fourteen
runtime cases and executes the standalone entry point.

Success returns the expected receipt and commits one parameterized insert.
Schema rejection causes no service calls. Business and catalog rejection cause
no transaction. Transient writes attempt at virtual milliseconds 0, 5 and 15.
Replaying the same Effect attempts at 100, 105 and 115 with a fresh budget.
Catalog and provider acquisition occur once per workflow. Each failed attempt
rolls back and releases before the next lease.

The checks cover exhausted and permanent failures, provider and lease failure,
BEGIN failure, invalid receipt rows and simulated COMMIT failure.
Execution defects bypass typed retries. Combined transient body failure and
rollback or release defects retain both causes and prevent another attempt.
Cancellation during either retry delay prevents a later transaction.
Blocked rollback or release keeps body interruption pending with no committed row.
Interruption after COMMIT starts waits for commit and release, preserving the
committed row and returning an interrupted exit.

## Disposition and limits

The service workflow application gate passes using existing language forms.
No compiler, IR, builtin or syntax change is selected. Source owns business
validation, catalog use, total calculation, retry selection and the exported contract.
The registered adapter owns one atomic save and its connection lifecycle.
Source withResource does not need an Exit argument for this boundary.

The recording driver performs no external I/O and recognizes one insert shape.
These checks do not establish external database behavior, source-authored
transaction callbacks, idempotency or exactly-once submission. An ambiguous
commit stays Permanent because retry could duplicate a committed write.
The simulated COMMIT error precedes the driver's committed-state mutation.
That case proves no retry, not actual ambiguous-commit behavior.
The stream processor baseline is next. Gap item 9 stays deferred.

## Reproduce

```sh
deno test --allow-all tests/application_service_workflow_test.ts tests/application_service_workflow_slow_test.ts
deno task check
```

The final repository gate passes on Deno 2.9.7: 1,142 fast tests and 130 slow
tests. The compiled harness runs all fourteen application cases and the entry point.
The full gate also required explicit type-only imports in the recording
drivers and the existing native worker reference; those changes preserve behavior.

The website passes eleven tests and strict checking of all 47 illustrative
Effect-TS units, with no missing translations. A fresh copy of the public
service project builds two modules with zero diagnostics using --validate --tsc.
It passes all fourteen checks.ts cases and runs main.ts with one committed
receipt and no active connection. All nine published source, configuration and
host files match the checked fixture; runtime_test.ts is published as checks.ts.

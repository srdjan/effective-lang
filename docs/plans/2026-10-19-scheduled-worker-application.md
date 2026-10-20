# Scheduled worker application

Date: 2026-10-19. Status: implemented and verified application witness.
Target: Deno 2.9.7 and `effect@4.0.5`.
This follows the accepted [application acceptance rule](2026-10-19-application-acceptance-rule.md).

## Required behavior

The worker runs a configured number of successful jobs. It starts the first job
immediately and waits between successful jobs. It retries transient failures
under a bounded retry policy and propagates permanent or exhausted failures.
Each attempt acquires and releases its own job resource. Release completes
before another attempt or a repetition delay starts.

The worker returns the completed count and optional last job result. A run with
zero jobs acquires nothing. Reusing the exported function starts fresh state.
Invalid policy input fails before any job or timer starts.

The runtime entry point may interrupt the whole worker for shutdown. Interrupted
work, repetition delays, retry delays, and resource release must finish cleanup
before interruption returns. Drivers may implement job operations and waiting;
source code owns repetition, error selection, retry, and resource lifetime.

## First composition to test

Use a source policy record with run count, repetition delay, retry count and
retry delay. A recursive source function tracks the completed count and last
result. The existing RetrySchedule callback accepts one nominal JobFailure with a
Transient or Fatal kind field. Source code retries only the Transient kind. withResource brackets each attempt. A Clock.wait service is a primitive
clock driver, with no repetition or retry logic in the driver.

Use deterministic recording drivers and virtual time or handshakes. Verify
results, attempt counts, ordering, fresh state, failure contracts, defects,
interruption while working or waiting, and awaited release. Strict emitted
TypeScript checking and independent IR validation are required.

## Schedule consumer investigation

The current general Schedule value has only the aggregation consumer. Record
the diagnostic for using one with retry, and compare the worker composition
with the pinned native repetition and retry behavior. An aggregation race does
not by itself establish a policy that waits between completed jobs.

The application does not require taking an opaque Schedule as input. If the
source composition meets its required behavior, retain the general consumer
API gap without adding a builtin. Only a concrete application blocker can
select a new language feature under the accepted rule.

## Review resolution

The plan review identified the single nominal error restriction on RetrySchedule.
JobFailure retains a typed kind field instead of passing separate error types.
Retries mean additional attempts, and each successful job starts a fresh retry
budget. Invalid policy fields fail before the zero-job branch. Tests cover
replaying one returned Effect, failed acquisition without release, execution
defects, native retry sleeps, and interruption pending behind a blocked release.

## Completion evidence

The [application fixture](../../fixtures/applications/scheduled-worker/README.md)
contains source contracts, the worker, recording drivers, a runtime entry point,
a native reference, and nine compiled runtime checks. The
[source boundary checks](../../tests/application_worker_test.ts) verify result,
failure and service contracts. They retain separate diagnostics for opaque
Schedule retry and repetition consumers. The
[compiled application test](../../tests/application_slow_test.ts) validates
linked IR, checks emitted TypeScript strictly, runs all nine runtime cases, and
executes the standalone entry point.

The virtual-time comparison uses the same policy and transient failure sequence
with emitted source and native Effect.repeat/Effect.retry. Both start attempts
at milliseconds 0, 5, 25 and 30. Both return two completed jobs and the last
result. Replaying the same Effect starts fresh progress and retry budgets.
Separate checks cover zero jobs, invalid policy precedence, zero retries,
exhaustion, permanent failure, acquisition failure, execution and release
defects, and cancellation during work, repetition waits and native retry waits.
A blocked release holds shutdown pending and prevents another attempt.

The native clock observation forwards time reads and replaces sleep with a
synchronized pending operation. Copying
a class-based clock with object spread loses prototype methods and invalidates
the test double. The repaired observer confirms entry into the native retry
sleep and completed wait cleanup on interruption.

## Disposition and limits

The scheduled-worker application gate passes using existing language forms.
No compiler, IR, builtin or syntax change is selected. A source-authored concrete
policy is sufficient for this application. General opaque Schedule consumers
remain an API gap; these checks do not establish their equivalence through
aggregation or recursion. The native reference comparison covers the selected
fixed policy, timing and results only.

The recording driver performs no external I/O. The runtime entry point owns
whole-worker interruption; source owns retry, repetition and resource release.
A future application that requires opaque policies, richer scheduling, or an
in-source shutdown protocol must supply its own blocker witness.
The service workflow baseline is next. Gap item 9 stays deferred.

## Reproduce

```sh
deno test --allow-all tests/application_worker_test.ts tests/application_slow_test.ts
deno task check
```

The final repository gate passes on Deno 2.9.7: 1,140 fast tests and 129 slow
tests. The compiled application harness runs nine application cases and the
standalone entry point. The standalone application README also gives build and
execution commands.

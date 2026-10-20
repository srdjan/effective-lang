# Scheduled worker application

This application uses existing Effective forms. Source code owns the repetition
policy, transient retry selection, resource brackets and result state.
The TypeScript driver supplies recording in-memory jobs and primitive waits.
The runtime entry point supplies drivers and runs the exported worker.

From the effective-lang repository root:

```sh
deno task effective build fixtures/applications/scheduled-worker --validate --tsc
deno run --config fixtures/applications/scheduled-worker/deno.json fixtures/applications/scheduled-worker/main.ts
deno test --config fixtures/applications/scheduled-worker/deno.json fixtures/applications/scheduled-worker/runtime_test.ts
```

Build writes generated TypeScript beside the source files. The repository test
runs the same compilation and application checks in a temporary directory.

```sh
deno test --allow-all tests/application_worker_test.ts tests/application_worker_slow_test.ts
```

Policy fields are safe nonnegative integers. Validation precedes all work,
including the zero-job branch. runs counts successful jobs. retries counts
additional attempts per job. The first job starts immediately; delayMillis
applies only between successful jobs. retryMillis applies after a transient
failure when a retry remains. A Fatal JobFailure stops without retrying.
A zero-job policy returns an empty report and opens no resources.

The entry point can shut down the worker by interrupting its root Effect.
Cancellation waits for active resource release and timer cleanup. No shutdown
or retry loop lives in the driver. Replaying one returned Effect resets source
progress and retry budgets; the driver can still retain its own resource IDs.

runtime_test.ts runs ten application checks, including a virtual-time comparison
with reference.ts. The native reference uses Effect.repeat, Effect.retry and
Schedule composition for valid policies. It compares job times and results;
it does not establish equivalence for every opaque Schedule value.
The two source probes retain the general Schedule consumer gap separately.

The driver performs no network or database I/O. These checks establish the
scheduled-worker application gate, not external driver integration or full
Schedule parity. Gap item 9 remains deferred.

# Stream processor application

Date: 2026-10-19. Status: implemented and verified application witness.
Target: Deno 2.9.7 and `effect@4.0.5`.
This follows the accepted [application acceptance rule](2026-10-19-application-acceptance-rule.md).

## Required behavior

Source opens input and output sessions with nested resource brackets.
It pulls a live input, transforms items with concurrency two, preserves input
order, buffers with suspending backpressure and writes batches of two items.
Normal completion writes a final partial batch. Empty terminal batches from
native transduction cause no output operation. Replaying one returned Effect
starts fresh sessions and source progress.

Source recovers a selected Recoverable transformation failure into a marked
fallback item containing the original value. Fatal transformation failures,
input failures and output failures propagate. Recovery does not restart input
or retry writes. Already completed writes remain visible after later failure.
The application promises no exactly-once delivery or rollback of earlier batches.

Input and output drivers supply primitive open, next, transform, write and close
operations. Source owns resource brackets, pipeline composition, recovery and
batch selection. The drivers contain no stream orchestration or shutdown loop.

## Existing composition

Try unfold, bufferStream with capacity two, mapEffect with concurrency two,
transduceStream with takeSink(2), sinkForEach and runStream. Use source
withResource to close output before input after success, failure and cancellation.
Acquire-created operation records capture ordinary session identifiers, as in
the scheduled worker. Borrowed handles do not escape their resource callbacks.
Use a source fold to suppress native transduction's empty terminal batch.

The exported Effect must retain all three nominal failure types and all input,
transform and output service requirements. Source checks must reject erased
failure or service contracts and an incorrect result. Linked IR validation and
strict emitted TypeScript checks must pass before runtime checks.

## Application checks

Check deferred construction, ordered batches, partial and empty input, and
fresh state on Effect replay. Force transformations to finish out of order
and verify ordered output and a maximum of two active transformations.
Pause a consumer over a longer input and measure the quiescent pull trace.
Verify that pulls stop under backpressure and resume when demand returns.
Do not infer a global memory limit from one queue's capacity.

Check selective fallback, fatal transformation failure, input failure after a
completed batch, output failure, acquisition failure and execution defects.
Verify that pending peer work is cancelled before session closure completes.
Interrupt pending input and pending output separately. Block output or input
close and verify that interruption waits for both finalizers. Test cleanup
defects and confirm that remaining finalizers are attempted. Always open a
blocked cleanup gate even when a test assertion fails.

Use deterministic recording drivers, Deferred handshakes and scheduler
quiescence, without wall-clock sleeps. The driver performs no network or file I/O.
Record precise observed backpressure behavior and any remaining limits.

## Feature decision

Select no new API unless this complete application demonstrates a blocker.
Passing all three application gates completes the accepted language stopping
rule. It does not establish full API parity, external driver integration,
performance, packaging or editor acceptance. Gap item 9 remains deferred.

## Review resolution

The independent plan review approves the existing composition for implementation.
Item recovery lowers to native Effect.catchTags. A matched typed failure in a
mixed cause can hide another cause reason. Add a direct mixed-cause probe and
record native behavior; do not promise blanket defect preservation through recovery.
Input and output session finalizers run outside that item recovery handler.
The adapter's normal transformation cleanup only records completion and cannot fail.

The pinned [Stream reference](https://effect.website/docs/v4/api/effect/Stream)
and [Sink reference](https://effect.website/docs/v4/api/effect/Sink) support the
selected composition. Local target sources and runtime checks establish the
exact transduction and backpressure behavior for version 4.0.5.

The implementation review found no orchestration defect and independently ran
the application harness successfully. It identified an early-failure risk in
the blocked-finalizer test. The corrected test registers gate release around
the entire shutdown handshake before either child fiber starts. A temporary
injected handshake defect confirms that the test fails promptly without
waiting forever for the blocked finalizer. The backpressure check asserts
the exact pinned pull trace rather than a broad count bound.

## Completion evidence

The [application fixture](../../fixtures/applications/stream-processor/README.md)
contains source contracts, source pipeline, primitive recording drivers, an
entry point and thirteen compiled runtime cases. Two
[source checks](../../tests/application_stream_processor_test.ts) validate
linked IR and independently reject each erased failure, service and result contract.
The [compiled harness](../../tests/application_slow_test.ts)
checks emitted TypeScript, runs all application cases and executes main.ts.

The success trace writes item identifiers [1,2], [3,4] and [5]. Empty input
writes nothing. Exact multiples produce no empty terminal write. Replaying one
returned Effect resets pull progress and opens fresh sessions. A live input
can wait for later arrivals without triggering a partial write.
Forced completion order [2,1] still produces ordered batches with at most two
active transformations. With the first output blocked, scheduler quiescence
leaves pull indices [0,1,2,3,4,5,6]. Demand resumption consumes the remaining
input. This trace does not establish a global memory bound.

Selected transformation failures become marked original-value fallbacks without
retry. Fatal transformation and output failures cancel pending peer work
before session closure. Input failure after a completed batch propagates while
preserving previously emitted full and partial batches. The first expectation
that transduction would suppress a partial batch on failure was incorrect.
Pinned native transduction emits the partial result before its saved failure.

Cancellation during pending input or output waits behind either blocked session
finalizer. Output closes before input. Execution defects and session cleanup
defects retain their native channel, and remaining finalizers are attempted.
A direct comparison with native catchTags confirms the mixed-cause recovery
limit: matching a Recoverable typed reason can hide an accompanying defect.
The normal primitive transformation cleanup cannot fail. Session cleanup occurs
outside that item recovery handler.

## Disposition and limits

No compiler, IR, builtin or syntax change is selected. Source owns the complete
pipeline and resource lifetime; drivers perform primitive operations only.
The application does not guarantee rollback, exactly-once delivery, recovery
of arbitrary mixed causes or a global bound from one queue's capacity.
Recording drivers establish no external integration or performance claim.
The accepted stopping rule covers these three application witnesses; broader
API parity and other release acceptance checks remain separate. Item 9 stays deferred.

## Reproduce

```sh
deno test --allow-all tests/application_stream_processor_test.ts tests/application_slow_test.ts
deno task check
```

The final repository gate passes on Deno 2.9.7: 1,144 fast tests and 131 slow
tests. The compiled application harness runs all thirteen runtime cases and
the standalone entry point. The separate injected test failure returns promptly,
confirming gate release before child cleanup can wait indefinitely.

The website passes eleven tests and strict checking of all 47 illustrative
Effect-TS units, with no missing translations. A fresh public project copy
builds two modules with zero diagnostics using --validate --tsc. All thirteen
checks.ts cases pass. main.ts writes the expected three batches and leaves
no active session. All seven published source, configuration and host driver
files match the fixture; runtime_test.ts is published as checks.ts.

All three accepted application gates pass using existing forms. The accepted
language stopping rule is satisfied. No further API addition is selected.

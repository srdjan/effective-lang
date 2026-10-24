# Stream processor application

This application uses existing Effective forms. Source owns session brackets,
live pulls, ordered concurrent transformation, selective fallback, buffering,
batch selection and terminal consumption. The recording driver supplies only
primitive operations. It performs no network or file I/O.

From the effektive-lang repository root:

```sh
deno task effective build fixtures/applications/stream-processor --validate --tsc
deno run --config fixtures/applications/stream-processor/deno.json fixtures/applications/stream-processor/main.ts
deno test --config fixtures/applications/stream-processor/deno.json fixtures/applications/stream-processor/runtime_test.ts
```

Build writes generated TypeScript beside the source files. The repository
harness runs compilation and application checks in a temporary directory.

```sh
deno test --allow-all tests/application_stream_processor_test.ts tests/application_slow_test.ts
```

runProcessor retains InputFailure, TransformFailure and OutputFailure channels
and all seven declared service operations. The input buffer has capacity two.
Mapping runs at most two transformations and preserves input order. Source
replaces Recoverable transformation failures with marked original values.
Fatal transformation failures, input failures and output failures propagate.
Recovery does not restart input or retry output writes.

Source transduces items through takeSink(2) and suppresses empty terminal batches.
Normal completion writes a final partial batch. Native transduction can also
emit a partial batch before propagating an upstream failure. Earlier writes
remain visible after later failure or interruption. There is no rollback,
delivery acknowledgement protocol or exactly-once promise.

With the first write blocked, the pinned pipeline stops at pull indices zero
through six. It resumes when output accepts work. This observed trace includes
queue contents and work in progress; queue capacity is no global memory limit.
Live input may wait for later arrivals without ending the stream.

Source opens input before output and closes output before input. Cancellation
of pending input or output awaits pipeline work and both session finalizers.
An output acquisition failure closes only the acquired input session.
Execution defects and session cleanup defects remain defects. Remaining
session finalizers still run after a cleanup defect.

Item recovery uses native catchTags semantics. A matched typed reason can hide
an accompanying defect from an arbitrary mixed transformation cause. The
normal transformation driver has no defecting cleanup. A separate runtime
probe records this limitation; session cleanup runs outside item recovery.

runtime_test.ts runs thirteen compiled cases. Together with source contract,
IR and strict emitted checks, these cases complete the stream processor gate.
See [docs/status.md](../../../docs/status.md) for the project status.

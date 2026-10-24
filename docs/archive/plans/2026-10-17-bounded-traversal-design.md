# Phase 6 bounded traversal source rule

Status: source rule accepted and implemented. The Effect 4 target probe,
compiler tests, runtime test through scoped operation records, and
`build --validate --tsc` gate pass. Unbounded concurrency and fiber APIs
remain deferred.

The [target probe](phase6-probes/bounded.ts) passes `deno test --no-lock` against
`effect@4.0.5`. It verifies `Effect.forEach(items, callback, { concurrency: 2 })`
keeps at most two jobs active and returns results in input order even when jobs
finish out of order. A typed failure interrupts an active sibling, prevents a
queued job from starting, and waits for both acquired resources to release.
Explicit interruption of the traversal also waits for both finalizers. The
[Effect 4 concurrency guide](https://effect.website/docs/v4/concurrency/basic-concurrency)
describes the concurrency option and sibling interruption; the
[error guide](https://effect.website/docs/v4/error-management/parallel-and-sequential-errors)
describes fail-fast behavior.

The source form extends the existing operation:

```effektive
traverse(items, callback, { concurrency: 2 })
```

The third argument must be a literal record with a positive safe integer
`concurrency` field. Omission retains the current sequential behavior.
The source result type remains an array in input order. Callback invocation
failures and requirements remain active. The operation starts at most N
callbacks simultaneously. On a typed failure, it starts no queued callbacks,
interrupts active siblings, and waits for their scoped finalizers before
returning failure. Explicit interruption follows the same cleanup rule.
`concurrency: 0`, negative values, fractions, and values outside the safe
integer range are source errors.

This rule uses Phase 5's checked operation-record lifetime. The canonical spec
now states the concurrency and cancellation policy. The checker requires a
positive safe integer literal; the independent IR validator checks the same
record and the specialized builtin signature. The emitter passes the options
record to `Effect.forEach`. The native runtime test verifies the bound, input
order, fail-fast sibling interruption, and finalizer completion after failure
and explicit interruption.

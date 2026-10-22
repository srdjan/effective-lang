# ARC-5: resolved builtin names do not determine every lowering fact

Date: 2026-10-22. Disposition: decline the blanket name-to-kind replacement. The prerequisite of ARC-5 fails on the current implementation. Keep the existing facts and lowering; a selective storage change would need a separate measured proposal.

## Inventory

Count distinct `kind` literals in the `NodeFact` union, expanding grouped literal unions. A payload-free member has only the `kind` property. The current source has 90 distinct kinds, of which 66 are payload-free and 24 carry payloads. The original scout's 44 payload-free builtin facts is a historical count.

| Payload-free group | Kinds | Source of the decision |
| --- | ---: | --- |
| Fixed builtin call tags | 54 | 48 literal `fact` entries in `PRELUDE_PROLOGUES`, plus `Some`, `unbrand`, `fail`, `switchMapStreams`, `catchStream` and `retryStream` handlers |
| Context-dependent builtin call tags | 10 | Callback execution mode or retry options; six resolved builtin names can select different IR kinds |
| Ordinary function call | 1 | `call`, resolved to a function value rather than a builtin |
| Prelude value | 1 | `none`, recorded for `None` as a value rather than a call |

The 54 fixed mappings found in the prologues and handlers are:

- `retrySchedule` → `retry-schedule`
- `codec` → `codec`
- `decode` → `decode`
- `encode` → `encode`
- `withFiber` → `with-fiber`
- `joinFiber` → `join-fiber`
- `interruptFiber` → `interrupt-fiber`
- `defer` → `defer`
- `run` → `run`
- `scoped` → `scoped`
- `forkScoped` → `fork-scoped`
- `makeScope` → `make-scope`
- `provideScope` → `provide-scope`
- `addScopeFinalizer` → `add-scope-finalizer`
- `closeScope` → `close-scope`
- `withResource` → `with-resource`
- `unfold` → `unfold`
- `scanStream` → `scan-stream`
- `mapAccumStream` → `map-accum-stream`
- `foldStream` → `fold-stream`
- `foldEffectStream` → `fold-effect-stream`
- `collectStream` → `collect-stream`
- `headStream` → `head-stream`
- `lastStream` → `last-stream`
- `drainStream` → `drain-stream`
- `takeStream` → `take-stream`
- `dropStream` → `drop-stream`
- `sinkForEach` → `sink-for-each`
- `transduceStream` → `transduce-stream`
- `aggregateStream` → `aggregate-stream`
- `aggregateWithinStream` → `aggregate-within-stream`
- `scheduleFromStep` → `schedule-from-step`
- `scheduleRecurs` → `schedule-recurs`
- `scheduleSpaced` → `schedule-spaced`
- `scheduleMap` → `schedule-map`
- `scheduleMax` → `schedule-max`
- `scheduleMin` → `schedule-min`
- `scheduleConcat` → `schedule-concat`
- `runStream` → `run-stream`
- `mergeStreams` → `merge-streams`
- `zipStreams` → `zip-streams`
- `concatStreams` → `concat-streams`
- `race` → `race`
- `makeRef` → `make-ref`
- `getRef` → `get-ref`
- `setRef` → `set-ref`
- `updateRef` → `update-ref`
- `mergeLayers` → `merge-layers`
- `Some` → `some`
- `unbrand` → `unbrand`
- `fail` → `fail`
- `switchMapStreams` → `switch-map-streams`
- `catchStream` → `catch-stream`
- `retryStream` → `retry-stream`

## Counterexamples

| Resolved name | Input distinction | Lowered IR kinds |
| --- | --- | --- |
| `mapEffect` | Pure callback without options; effectful callback or explicit concurrency | `map-stream`; `map-effect` with concurrency payload |
| `filterEffectStream` | Pure or effectful callback | `filter-stream`; `filter-effect-stream` |
| `takeWhileEffectStream` | Pure or effectful callback | `take-while-stream`; `take-while-effect-stream` |
| `takeUntilEffectStream` | Pure or effectful callback | `take-until-stream`; `take-until-effect-stream` |
| `dropWhileEffectStream` | Pure or effectful callback | `drop-while-stream`; `drop-while-effect-stream` |
| `retry` | Counted or scheduled policy | `retry` with count payload; `retry-with-schedule` |

These contribute ten payload-free tags: `map-stream`, eight predicate variants, and `retry-with-schedule`. Their alternative outcomes can carry payloads. Lowering cannot choose all these kinds from `Target.name` alone. Recomputing the choice from callback annotations and options would duplicate checker decisions in lowering.

Two tests in [lower_test.ts](../../../tests/lower_test.ts) reproduce 13 valid cases: eleven stream cases cover both callback modes for all five stream names and explicit concurrency for a pure `mapEffect` callback; two retry cases use counted and scheduled policies. The tests verify resolved builtin names, exact lowered body kinds, and independent validator acceptance. They assert observable IR rather than the presence of a particular fact-table entry, so a future storage refactor can retain them.

## Decision and verification

The name-to-kind table is valid for a subset, but it cannot replace all payload-free facts. The 48 fixed prologue entries are already declarative; relocating them would still leave contextual facts, payload facts and missing-fact checks. No selective implementation or performance comparison was made, and no size, speed or memory saving is claimed. The blanket proposal is declined on its semantic prerequisite; the fixed subset remains an unmeasured possibility rather than accepted cleanup work.

All 231 focused tests pass:

```sh
deno test --allow-read tests/lower_test.ts tests/check_body_test.ts tests/lower_stage_effects_test.ts
```

`deno task check` passes 1830 fast tests and 177 slow tests.

Production checker, fact-table and lowering source is unchanged by this assessment. CHK-12 and FE-2 remain separate pending changes. No compiler behavior-capture comparison is needed for this test/documentation-only increment.

The inspected source SHA-256 values are:

| File in `src/core/` | SHA-256 |
| --- | --- |
| `tables.ts` | `ee1621a4bdaed81fcc15d8a9861fa10935145fd7225d20ba1a36d9aa106f38bf` |
| `check_expr.ts` | `8aca85f4eeb072fc327fefa7c5cc67b00a5801e0f06f5aab2195632a67deb59e` |
| `check_builtins/stream.ts` | `5bf5b705563499137dbdfd8e185df5ab058b6a842b81b7854b4c61bdc71ba51d` |
| `check_builtins/effect.ts` | `a8a585770d7870ee25a98ad982bfb6d49b59efbc2213917fb74d40789ce837a6` |
| `lower.ts` | `41380d0f62b3a0c6c527d0b54b34b7511f2f3a016cacbab9f3399de102c29f5d` |

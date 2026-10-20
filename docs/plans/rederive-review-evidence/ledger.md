# Measurement ledger

Each row gives one commit, its measured AST branch delta and cyclomatic delta from `measure.ts` and `fns.ts`, and the other measurements that its plan item asks for.

| Commit | Item | Measurement |
| --- | --- | --- |
| 730977c | baseline | 9617 branches in `src/` and `playground/src`; full suite 1370 tests, 91.0% branches, 91.3% lines |
| d6bf00c | P0-4 | 0 branch delta (tests only); 54 of 55 arity-guard bodies have line hits, the 55th is a one-line guard (`check_expr.ts:6055`) whose return branch runs 6 times |
| 9e051df | P0-5, P0-6a | 71 of 72 listed report sites run; `check_expr.ts:911` (construct SchemaError or SchemaIssue) cannot be reached from source; `None(1)` test added |
| 2cca1d4 | P0-6b | the 6 unrun stageEffects groups run, except the codec/schema/decode/encode arm (`lower.ts:1207-1211`), which is dead because `noPipeline` rejects those stages |
| 7ec4a24 | P0-0 | `deno task measure`: `domainOf` 27 branches, cyclomatic 22; 9617 branches over 72 files (unchanged) |
| 5d5c8fa, 62de9ab | P0-1 | `behavior:capture 5d5c8fa`: 5891 records (2458 check, 1041 emit, 1 emit-error, 1260 lower, 35 lower-error, 357 program, 16 program-error, 723 validate). Correction: an earlier entry gave 5501 records, probably from the S1 worktree before the S3 tests; a rerun on main gives 5891. Two runs on one revision gave identical counts; fast suite stays read-only |
| 4a5f41e..ac22e93 (10 commits) | P0-2, P0-3, P0-10 | 9617 branches over 72 files (unchanged, tests only); sourcemap round trip 501 ms to 13 ms, parse depth test 492 ms to 114 ms; lexer snapshot tests 145 ms and 44 ms; boundary test 48 ms; gate: 1574 fast, 131 slow passed; unreachable from source: `types.ts:859`, `check.ts:431`, `check.ts:445`, the `?? 0` arm at `lex.ts:438` |
| 6acb185, c872137, a96f765 | P0-7, P0-8, P0-9 | 9617 branches over 72 files (unchanged: the extraction moves the switch, and `exprChildren` has cyclomatic 101); fast-suite unhit `return this.poison()` lines in `validate/expr.ts` 48 of 69 to 23 of 69; 13 of 13 `unsupported` sites run; 2 sites can be reached from source (plan section 11, D5 and D6); gate: 1603 fast, 131 slow passed |
| a96f765 | Phase 0 result | `behavior:capture 62de9ab a96f765`: 5891 to 6356 records, 465 new, 0 missing, 3m20s; fast suite 1603 tests in 7 s, slowest fast test 250 ms; full suite under coverage 1734 tests in 1m55s, no fast test at 1 s or more; coverage of `src/` 94.4% branches, 98.7% functions, 95.5% lines (baseline 91.0%, 98.2%, 91.3%); `check_expr.ts` 96.7/99.5/98.8, `validate/expr.ts` 92.3/99.2/90.4, `lower.ts` 91.8/100/95.7, `emit/expr.ts` 90.3/97.9/95.1 (branch/function/line) |
| 5da2bbf | D2 | 9617 to 9626 branches (+9, all in `namedIn`: 34 to 43 branches, cyclomatic 22 to 28); 7 of 8 new export tests fail before the fix; the 6 golden files do not change; gate: 1611 fast, 131 slow passed |
| 99f28f4 | D1 | 9626 to 9634 branches (+8); 10 of 14 new tests fail before the fix; CLI: both reserved-error reproductions stop with `type-mismatch/010`, codec over `void` builds with 0 diagnostics |
| 4aa22e0 | R14 | 9634 to 9589 branches (-45); 4 functions (checker `dataOnly` 25 branches after D1, `schemaData` 25; validator `dataOnly` 24 after D1, `recursiveDataOnly` 24) become 2 (`types.ts` `dataOnly` 27, `validate/typing.ts` `dataOnly` 26); 12 rule mutations each fail a test |
| 5a4d684 | D3 | 9589 to 9592 branches (+3); 9 of 9 new tests fail before the fix; gate: 1643 fast, 131 slow passed |
| 5a4d684 | Phase 1 result | single-revision captures: a96f765 6356, 5da2bbf 6380, 99f28f4 6406, 4aa22e0 6423, 5a4d684 6457 records; 4 records missing, all `emit` at D2: the emission of `fixtures/emit/schema-constructor-fields.eff` now exports `OptionInput` (2 added `export`); D1, R14, and D3 remove 0 records; branches 9617 to 9592 over the phase (-25) |
| 6b1759f | R2, lowering and emitter | 9592 to 9668 (+76, listed arms); `invoke` cyclomatic 108 to 115, `stageEffects` 27 to 100, `armBinding` now calls `patternBinding` |
| 7443af7 | R6, deferred types | 9668 to 9635 (-33); `encodedTypeDoc` 24 to 13, `schemaDoc` 30 to 19, `containsFunction` 21 to 10 (cyclomatic) |
| 254dee6 | R3 | 9635 to 9354 (-281); new `emit/shape.ts`; `childrenOf` 101 to 1, `isLeaf` 36 to 2, `evaluatedChildren` 33 to 4, `structural` 126 to 93 (cyclomatic); capture 5a4d684 to 254dee6: 0 missing |
| 57e7993, cdb12bb | D5 | `x \|> Stop()` and `x \|> Stop` give one `type-mismatch/010` on the stage when the value fits; a value that does not fit gives only `type-mismatch/003`, as in the direct form; +3 branches |
| a23f194 | R1 | 9595 to 9427 (-168); `builtinCall` cyclomatic 103 to 2; one cast removed |
| ee1dd02 | R2, checker | 9427 to 9518 (+91, listed arms at 9 sites) |
| 3f6448c | R6, height | 9518 to 9489 (-29); `heightWithin` cyclomatic 56 to 7, new `childRefs` 25 |
| d330377 | R2, validator | +72 (listed arms at 6 sites) |
| 94bd86e | R4 | -42 with the new `validate/type_children.ts`; `checkRecordFields` walk 24 to 4, `reaches` 27 to 7 (cyclomatic) |
| 303f15a | R5 | -60; 4 reflective walkers and their casts removed |
| 303f15a | Phase 2 result | 9592 to 9224 branches (-368) over 74 files; capture 254dee6 to 303f15a: 0 missing; same-tests capture (Phase 1 tests on 5a4d684 and on 303f15a source): 6455 and 6455 records, 0 missing, 0 new; gate: 1662 fast, 131 slow passed |
| 0844b30 | D8 | `check`, `program`, and `validate` records hold an input hash; a new slow test proves that two clean programs give different records; capture 303f15a to 0844b30: 6754 and 6754 records, 0 missing, 0 new (deterministic); gate: 1662 fast, 132 slow passed |
| 4851ceb | D6 | the emitter gives the slot type to block results, `if` branches, and `match` arms; other effect-mode values bind once; the three repro forms and an inferred form build with `--tsc` and run with the block effect once; the `unsupported` throw in `fit` is gone (12 sites remain); 9224 to 9235 (+11) |
| efaec3d | R9 | 9235 to 9102 (-133); `invoke` cyclomatic 115 to 47; 67 builder rows, no cast |
| 9adc5cd | R10 | 9102 to 9031 (-71); `structural` 93 to 64, `leaf` 66 to 43 (cyclomatic); new `emit/calls.ts` |
| 9adc5cd | track E3 capture | 0844b30 to 9adc5cd: 1 missing record, the `emit-error` of the old form-1 test (expected for D6); 45 new; gate: 1666 fast, 140 slow passed |
| eaa8383 | P7, dead exports | 9088 to 9088 branches; non-blank code lines in `src/` and `playground/src` 37984 to 37974 (-10); `isReservedWord`, `tokenText`, and `Program.revisions` had 0 uses |
| f2313c6 | P7, typeAt | 9088 to 9067 (-21); lines 37974 to 37916 (-58); fast tests 1689 to 1687 (two `typeAt` tests of `check_body_test.ts` repeated `editor_test.ts` assertions) |
| 92d5ba3 | P3, checkCycles | 9067 to 9054 (-13); lines 37916 to 37869 (-47); the `?? 0` fallbacks are gone; roots stay in declaration order, so the component order is unchanged |
| 8cae721 | H5 follow-up, fallbacks | 9054 to 9055 (+1); lines 37869 to 37889 (+20); 4 silent fallbacks become `internal:` throws |
| edf12e7 | P5, identity parser | 9055 to 9054 (-1); lines 37889 to 37896 (+7); one `serviceOfCapability` and one `shortName` in `ids.ts`; the emitter keeps a throwing wrapper |
| 879e8e3 | P5, decodeString | 9054 to 9048 (-6); lines 37896 to 37886 (-10) |
| 02d12d3 | P9, watch loop | 9048 to 9047 (-1); lines 37886 to 37872 (-14); 75 to 74 files; `events.ts` and `explicit_scope.ts` stay |
| c9cdc29 | R17, adapters through mod.ts | 9047 to 9047 (0); lines 37872 to 37893 (+21); 46 adapter imports of core files now use `mod.ts`; 11 new re-exports in `mod.ts` (a 12th name, `Span`, already came from the IR star export) |
| 6ea9d53 | P4, src/host | 9047 to 9047 (0); lines 37893 to 37893 (0); `io.ts`, `workspace.ts`, `outputs.ts`, `deno_io.ts`, and `events.ts` move to `src/host/`; `src/lsp` imports nothing from `src/cli` |
| 934576e | P8, exports | 9047 to 9047 (0); lines 37893 to 37893 (0); 100 exports removed; 2 dead constants in `src/lsp/protocol.ts` keep `export` for the lint rule `no-unused-vars` |
| 01c5f96 | P1, R16 | 9047 to 9040 (-7); lines 37893 to 37843 (-50); `checkAnalysis` branches 7 to 3, `Program.check` branches 17 to 13; new `checkModuleStep` (1) and `reachedModules` (3); `checkDeclarations` is gone from `src/core/interface.ts`; capture af26d21 to 01c5f96: 7042 and 7042 records, 0 missing, 0 new |
| 5021917 | P2, diffFiles | 9040 to 9038 (-2); lines 37843 to 37858 (+15); 74 to 75 files; one `diffFiles` for `Session.sync` and `ProjectSet.flush`; the playground keeps its own payload code |

# Refactor and simplify pass

Date: 2026-10-21. Base: `5e4c3c7`. Status: accepted for APPLY by the user on 2026-10-21. Each item must keep the observable behavior.

This plan is a sibling of `2026-10-20-rederive-review.md` and `2026-10-20-hardening-pruning.md`. It does not restate their items. Section 9 of the rederive review ("What not to touch") applies here. In particular: do not share code between the checker and the validator, do not change `ir.ts`, do not convert internal throws to `Result`, and do not run `golden:update` or `validate:update`.

Three read-only audits collected the evidence on 2026-10-21: checker, back end, and front end with edges. "M" marks a fact measured or read in source. "I" marks an inference. The ID prefix is RS.

Baseline (M): `deno fmt --check`, `deno lint`, and `deno check` pass. The fast suite passes 1723 of 1723.

## 1. Lane A: checker

Files: `src/core/check_expr.ts`, `src/core/check.ts`, `src/core/check_project.ts`, `src/core/types.ts`, and checker tests.

RS1 (range-arity bails into the prologue). `check_expr.ts` `mapEffectCall` (:3627), `flatMapStreamsCall` (:4021), `allCall` (:5303), `partitionAllCall` (:5407), `validateAllCall` (:5463), and `allResultsCall` (:5529) each start with `if (args.length !== N && args.length !== N+1)`, report a custom `type-mismatch/004` message, and return the error type with the argument effects. `collectionCall` (:5631-5644) holds its own arity code for `traverse`, `map`, `filter`, and `fold` through `count` and `unspecialized` (M). Fix: add `usage?: string` to `Prologue` and pass it to `arity()`. Add an `optionalLast(required, usage)` row builder with `pipeline: "any"`, so each handler keeps its `noPipeline` call where it is. Add rows for the 7 range names, `map` and `filter` as `piped(2, "pure")`, and `fold` as `piped(3, "pure")`. Delete the inline bails, `count`, and `unspecialized`. Update the `PRELUDE_PROLOGUES` comment at `check_expr.ts:1407-1410`, which the optional-last rows make stale. The bail is the first statement at every site and no fact is recorded before it (M). `tests/builtin_arity_test.ts` pins all 7 messages (M). Prototype: -38 lines, -23 branches (M, scratch).

RS2 (seeded-stream helper). `scanStreamCall` (:3829), `mapAccumStreamCall` (:3868), `foldStreamCall` (:3928), and `foldEffectStreamCall` (:3970) repeat `argInfo(stream)`, `argInfo(seed)`, `streamOf`, the "seed must be pure" report (`execution-mode/001`), and the element ternary (M). Fix: one `seededStream(name, args)` that returns `{ stream, seed, source, element }`. `inlineStreamCallback` and the extra `type-mismatch/011` check of `mapAccumStream` stay in the callers. Precondition: in a separate commit first, add tests that pin the seed message text for all four names (M, validator: `check_body_test.ts:973` asserts only the code for `scanStream`, and no test triggers the report for the other three). Prototype: -29 lines, -6 branches (M, scratch).

RS3 (stream-pair helper). `mergeStreamsCall` (:4888), `zipStreamsCall` (:4918), and `concatStreamsCall` (:4939) repeat 12 lines that take two arguments and report "`X` needs two Stream values". Only the element rule differs (M). Fix: one `streamPairCall(node, name, args)` that chooses the element rule by name. `race` and `mergeLayers` stay out. Precondition: in a separate commit first, add rows for `zipStreams` and `concatStreams` beside the `mergeStreams` rows of `builtin_report_sites_test.ts:512-527`. Prototype: -27 lines, -4 branches (M, scratch).

RS4 (flatMap and switchMap stream tail). `check_expr.ts:4038-4067` and `:4081-4110` hold about 30 identical lines from `inlineStreamCallback` to the `table.stream(...)` result (M). Fix: one checker-side `innerStreams(name, args)` that returns `{ stream, transform, type }`. The flatMap concurrency, fact, and `noPipeline` steps stay in front of it. Prototype: -23 lines, -7 branches (M, scratch).

RS5 (one predicate in `schemaOf`). `check_expr.ts:2085-2125` writes the acceptance condition twice: once negated for the report and once for the return (M). Fix: `const accepted = ...`, then `if (!accepted && !isError) report`, then `return accepted ? type : undefined`. The make-input report stays between them. Prototype: cyclomatic 19 to 13 (M, scratch).

RS6 (checker `invocationOf`). Five sites (:1043, :1792, :1805, :3098, :3482) build `{ failures: fn.failures, requirements: fn.requirements, mode: fn.execution }`, most with an `undefined` test that gives `PURE_EFFECTS` (M). Fix: one module function `invocationOf(fn: FunctionNode | undefined): EffectSet` in `check_expr.ts`. It must not import `validate/sets.ts`. Leave the `traverse` site (:5747). Prototype: -13 lines (M, scratch).

RS7 (one function-type builder in `check.ts`). `signatureType` (:217-252) repeats `TypeLowerer.functionOf` (:864-892), and `checkService` casts `type.ir as FunctionType` (:1500). `checkProvider` (:1541-1566) repeats the provider ref and IR that `deferredType` builds (:790-805) (M). Fix: a module function `loweredFunction(table, ...)` that returns `{ ref, ir: FunctionType }`, used by both, and a `TypeLowerer.providerOf(provides, failures, requirements)`. The `provides` clause loops stay. Prototype: +3 lines, -4 branches, -1 cast (M, scratch).

RS8 (dead field and stray exports). `BodyEnv.module` (`check_expr.ts:86`) has 0 reads; `check_project.ts:268` sets it (M). `checkModuleBodies` (`check_project.ts:214`) is used only in its own file, and `ReachedModules` and `ModuleStep` have no importer (M). Fix: delete the field and remove the 3 `export` keywords.

RS9 (two checker `compareText` copies). `check.ts:1089` and `types.ts:251` copy `compareText` from `util.ts` (M). Fix: import it. `serialize.ts:30` stays (section 9).

## 2. Lane B: back end

Files: `src/core/emit/doc.ts`, `src/core/emit/types.ts`, `src/core/emit/expr.ts`, `src/core/emit/scope.ts`, `src/core/lower.ts`, `src/core/validate/expr.ts`, `tests/validate_family_mutation_test.ts`.

RS10 (process-wide memo). `emit/doc.ts:336` keeps `sharedHardCheck` for the life of the process; `hasHardLine` (:342-344) uses it (M). An A/B run showed no measurable speed difference without it, and the per-render memo in `render` must stay (removing that one costs 10x at depth 100, M). Fix: delete `sharedHardCheck`; `hasHardLine` builds a local check for each call. Required: one `deno task bench --quick` A/B run recorded in the ledger.

RS11 (validator accumulator and map families). `validate/expr.ts` `scanStream` (:3669), `foldStream` (:3781), `foldEffectStream` (:3833), the shared prefix of `mapAccumStream` (:3721), and the pair `mapEffect` (:3585) and `mapStream` (:3628) are clones that differ in operator name, purity rule, message wording, result type, result effects, and active set (M). Fix: one keyed method with a `Record` row for the accumulator family, and one for the map pair, as R8 did with `streamTerminal` and `pureStreamPredicate`. Messages stay byte-identical as row data. `tests/validate_family_mutation_test.ts` pins all three messages of each method (M). Precondition: in a separate commit first, add mutation rows that replace the callback with an effectful closure for `mapStream`, `scanStream`, `mapAccumStream`, and `foldStream`, so a dropped purity rule fails a test (M, validator: no test reaches these paths today). Keep `checkConcurrency` as the first step of the `mapEffect` row. Estimate: about -110 lines (I).

RS12 (trailing `never` arguments). `emit/types.ts` `effectTypeDoc` (:93), `deferredArguments` (:109), and `layerTypeDoc` (:125) build the same argument list (M). Fix: the other two call `deferredArguments`. Compute the arguments before `scope.effect(...)`, so the order of name allocation stays. Prototype: -8 branches, -14 lines, identical output (M).

RS13 (conditional spreads in `emitted`). `emit/expr.ts:153-182` uses six conditional spreads, but `exactOptionalPropertyTypes` forbids an explicit `undefined` (M). Fix: `return { ...flags, doc, prec, brace: flags.brace ?? false, huggable: flags.huggable ?? false }`. Prototype: -6 branches, identical output (M).

RS14 (redundant `stageEffects` arms). `lower.ts:1218-1226` (retry-schedule, codec, schema, decode, encode) and `:1240-1243` (defer) return the same value as the fall-through `combine(parts)` (M for codec; M arity 1 for the other two, `check_expr.ts:1415`, `:1444`). Fix: move the 6 labels into the `break` list. Prototype: -3 branches (M).

RS15 (two back-end `compareText` copies). `lower.ts:1696` and `emit/scope.ts:167` (M). Fix: import from `util.ts`.

RS16 (cast in `preludeImport`). `lower.ts:1768` reads `(builtins.get(id) as BuiltinInstance).type` (M). Fix: sort the entries once and read `type` from each entry.

RS17 (stale `free()` comment). `emit/expr.ts:465` `free()` is an identity function whose comment says that it handles braces; it has not since `defebfe` (M). Fix: correct the comment. Keep the 26 call sites.

## 3. Lane C: front end and edges

Files: the RS18 and RS24 test files, `scripts/measure*.ts`, `scripts/lex_snapshot.ts`, `docs/api.md`, `src/cli/`, `src/host/workspace.ts`, `bench/`, `src/lsp/projects.ts`, `src/lsp/features.ts`, `src/lsp/server.ts`, `src/core/lex.ts`, `src/core/project.ts`, `src/core/db.ts`, `src/core/parse.ts`, `playground/src/app.ts`.

RS18 (local `checked` helpers). 15 test files define `checked(source)`, which does the same as `checkModule(source, "main.eff")` (`tests/helpers.ts:453`) (M). Nine bodies are byte-identical: `null_test`, `schedule_check_test`, `schema_constructor_metadata_test`, `schema_constructor_test`, `schema_default_encoding_test`, `schema_encoded_default_test`, `schema_identity_test`, `schema_null_default_test`, `schema_slow_test`. Five differ only by a default `source = fixture`: `schema_constructor_fields`, `schema_constructor_optional`, `schema_constructor_recursive`, `schema_recursive_adapters`, `schema_recursive_wire`. One differs by a return annotation: `run_stream_sink_hint_test`. Fix: `const checked = (source = fixture) => checkModule(source, "main.eff")`, or a direct call. Every call must pass `"main.eff"`, because `checkModule` defaults to `"m.eff"`, and the capture hashes the path (M, validator probe). Leave `schema_constructor_order` and the application tests. Size: about -135 lines (M).

RS19 (one measurement kernel). `scripts/measure.ts:28-92` and `scripts/measure_functions.ts:8-72` hold 65 identical lines: `isBranch`, `isDecision`, `countIn`, `fnName` (M). Fix: move them to `scripts/measure_kernel.ts`, imported by both. Add a `measure_kernel.ts` line to the scripts table at `docs/api.md:91-92`. Check: both task outputs over the same file list are byte-identical before and after.

RS20 (CLI sync and dead field). `src/cli/main.ts:128-143` runs `session.sync()` and the same `isSyncFailure` block in both the watch branch and the check and build branch (M). The `error: ConfigError` field of the `config-error` `SyncResult` (`session.ts:26-31`) has no reader (M). `main.ts:100` repeats the `errorMessage` expression (M). Fix: sync once, check failure once, then branch on watch; drop the field and its import; import `errorMessage` from `core/mod.ts`.

RS21 (edge `compareText` and `errorMessage` copies). Inline `compareText` copies in `src/host/workspace.ts:41`, `scripts/lex_snapshot.ts:82`, and `bench/m2.ts:177`, and the `errorMessage` expression in `bench/m5_variants.ts:67`, `bench/m5_target.ts:111` and `:132`, `bench/lsp_client.ts:214`, `bench/main.ts:188`, and `bench/lsp_script.ts:198` (M). Fix: import from `core/mod.ts`. Leave `scripts/lex_snapshot.ts:141`, which has no 0 case. Check: `deno task lex:update`, then `git diff --exit-code fixtures/lex/snapshot.json`.

RS22 (dead `FlushOutcome` payload). `src/lsp/projects.ts:95-101`: `afterFlush` (`features.ts:255-259`) reads only `tag` and `revision`, and returns at once on `config-error` (M). Fix: call `flushed(project, revision)` only on success, and delete `FlushOutcome`. `src/lsp/server.ts` imports `FlushOutcome` (:49), wires `ports.flushed` (:228), and declares `#flushed` (:409), so it changes too.

RS23 (unreachable fallbacks and defaults). `lex.ts:196` `TOKEN_NAMES[kind] ?? "token"`: all 46 kinds have a name (M); type the table as `Readonly<Record<TokenKind, string>>` and drop the fallback. `project.ts:494`, `:506`, and `:514` have `?? []` fallbacks on names that come from the same map (M); remove the fallbacks, but keep the `compareText` order of `names` when the code builds `graph`, because `GraphResult` exposes the insertion order. The `counters` default of the `Revision` constructor (`db.ts:160-165`) is never used, because the only `new Revision` (`db.ts:431`) passes it (M); drop the default.

RS24 (test-only `parseFromHost`). `parse.ts:68-76` has no production caller; only `tests/parse_test.ts:408` uses it, and `parse` with `SourceHost.readText` covers the same behavior (M). Fix: delete the function, its test, and the imports that only it uses.

RS25 (playground config constant). `playground/src/app.ts:32` declares `CONFIG_FILE = "effective.json"`, but `core/mod.ts` exports `CONFIG_FILE` and `app.ts` already imports from `mod.ts` (M). Fix: import it.

## 4. Out of scope

- C7 (stream effect ternaries, 25 sites): the gain needs measurement after RS2 and RS4.
- C10 (syntax selectors `arrowBody`, `initOf`, and the `TypeLowerer` copies of `kidsOf` and `literalOf`): do it with R15a, because `check.ts` cannot import `check_expr.ts` without a cycle.
- F3 (one path-to-module lookup for `editor.ts`, `lsp/features.ts`, and the playground): it adds a lazy cache to `Revision` across three layers. Reconsider with R13.
- F9b (one hover constant): it adds an export to the published `mod.ts` surface.
- The `fit` closure reorder in `emit/expr.ts:817-819`: it renames emitted temporaries, so it is a behavior change.
- Probable defect, not a refactor: `src/host/deno_io.ts:156-161` writes stdout and stderr with one `writeSync`, which can return a short count on a pipe. `src/lsp/main.ts:17-25` loops for this reason. Confirm by piping a large CLI output through a slow reader and comparing byte counts.

## 5. Verification

The plan owner runs these checks. The implementer's claim is not evidence.

1. After each commit: `deno check` on the changed roots and `deno task test`.
2. At the end of each lane, and once after all lanes are on `main`: `deno task check` (fast and slow suites).
3. For each lane range and for the whole pass: `deno task behavior:capture 5e4c3c7 HEAD` shows 0 missing records. New records may come only from tests added in RS2, RS3, and RS11.
4. `deno task measure` and `deno task measure:functions` over the tracked `.ts` files of `src/` and `playground/src` give the delta, recorded in `docs/plans/rederive-review-evidence/ledger.md`.
5. RS10: one `deno task bench --quick` A/B run. RS19: byte-identical measure output. RS21: unchanged lex snapshot.

## 6. Validation record

A Fable subagent validated this plan on 2026-10-21. It confirmed all 25 items and probed RS1 with 340 generated programs (10 names, 0 to 5 arguments, direct and pipeline forms): identical diagnostics on base and patched trees (M). It found an oracle for RS14 in `tests/lower_stage_effects_test.ts`. It required the changes now written into RS1, RS2, RS11, RS18, RS19, RS22, and RS23, the lane file lists, and section 5. The checker prototype script `c3.ts` edits `mapEffectCall` instead of `flatMapStreamsCall`, so implementers must not reuse it as is. None of the findings was rejected.

The main session writes the ledger rows and this progress section after each lane lands on `main`. Implementers do not write them.

## 7. Progress

In this section, D1, D2, and D3 are decisions of this plan. They are not the D1 to D6 of the rederive review. Commit `4ffe6cc` names D2 of this plan.

Status on 2026-10-21: all 25 items are done on `main`. Three Sonnet implementers worked in separate worktrees, one for each lane, and the plan owner reviewed each diff line by line before landing it.

- Done: lane A, RS1 to RS9 (`01d64f9` to `34a5309`), fast-forwarded.
- Done: lane B, RS10 to RS17 (`af42d75` to `c56cb70`), cherry-picked.
- Done: lane C, RS18 to RS25, cherry-picked, plus one comment fix for the `flushed` port after RS22.
- Measured: 8525 to 8407 branches (-118) and 37225 to 36905 lines (-320) over `src/` and `playground/src`. The ledger has one row for each lane.
- RS14 also removed two `required(...)` guards. The checker fixes arity 1 for those stages, so the guards could not fire.

Found during the pass, not fixed (outside refactor scope):

- `deno task lex:update` read the gitignored probe directories under `docs/plans/`, so each checkout wrote a different snapshot. The base and new scripts gave the same output, so this drift existed before the pass. Decided on 2026-10-21 (D2, restrict to tracked files): `4ffe6cc` keeps only the files that `git ls-files` lists. The regenerated snapshot keeps the random hashes and the output hash of all 124 unchanged files (M).
- The probable short write in `src/host/deno_io.ts` (section 4). Decided on 2026-10-21 (D3, confirm first): not reproduced (M). An 8,000,000-byte write through `denoIo().stdout` arrived complete in three cases: a shell pipe with a reader that starts 2 s late, a `Deno.Command` parent that waits 2 s before it reads, and a Node parent that pauses the stream for 2 s. On this machine and Deno 2.9.7, `writeSync` on stdout writes all bytes in one call. No code change. The `writeAll` loop in `src/lsp/main.ts` stays as a guard.
- The three lane branches were deleted on 2026-10-21 (D1). Their former tips are `34a5309`, `b6c350b`, and `d986483`.

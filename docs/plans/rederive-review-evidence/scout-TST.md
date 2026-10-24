# Scout TST: the test suite as the judge of a rederive

Scope: every file in `tests/`, the fixture conventions in README.md and `fixtures/`, `scripts/behavior_capture.ts`, `scripts/golden_update.ts`, `scripts/validate_fixtures.ts`. The five large units under judgment are `src/core/check_expr.ts`, `src/core/lower.ts`, `src/core/emit/expr.ts`, `src/core/validate/expr.ts`, and `src/core/types.ts`.

Answer first: the suite can judge a rederive of `check_expr.ts`, `types.ts`, and the success paths of `lower.ts` and `emit/expr.ts`. It cannot judge the error paths of any of the five units, and `deno task behavior:capture` does not record checker diagnostics on 3 of the 4 paths that produce them. The capture also records nothing from subprocesses that lack `--allow-env`. Fix TST-1 (capture hooks) before a rederive starts.

Scratch evidence: `/tmp/rederive/scratch-TST/` (analyzer `analyze_tests.ts`, `tests.json`, `loops.txt`, `taut.txt`, `uncovered.txt` (fast lcov), `uncovered_all.txt` (full lcov), benchmark tests `rt_bench_test.ts`, `nest_bench_test.ts`, `nest_unguarded_test.ts`).

## 1. Baseline

### 1a. Suite size and runtime (measured)

| Run | Tests | Files | Runtime | Source |
| --- | --- | --- | --- | --- |
| Fast suite, no coverage | 1241 | 62 | 15.7 s wall | `/tmp/rederive/test_fast.time` |
| Fast suite, coverage | 1241 | 62 | 14 s (deno report) | `/tmp/rederive/test_fast.clean` |
| Full suite, coverage | 1370 | 94 | 3m24s (deno report), 3:30.88 wall | `/tmp/rederive/test_all.log`, `test_all.time` |
| Slow files only (sum of per-test times, coverage run) | 129 | 32 | 149.8 s | same log |
| Slow suite without coverage | - | - | needs measurement | - |

Slow files by runtime (coverage run): `emit_slow_test.ts` 74 tests 111.2 s; `cli_slow_test.ts` 18 tests 12.7 s; `application_service_workflow_slow_test.ts` 1 test 2.0 s; `application_worker_slow_test.ts` 1 test 2.0 s; `bench_lsp_slow_test.ts` 5 tests 1.8 s; `schema_slow_test.ts` 2 tests 1.3 s; `schedule_emit_slow_test.ts` 2 tests 1.3 s; 23 more files with 1 test each at 0.6-1.0 s; `lsp_slow_test.ts` 2 tests 0.2 s; `playground_build_slow_test.ts` 1 test 0.1 s.

Fast files by test count: check_body 201, fixtures 180, validate 138, emit 69, lsp_server 41, check 41, resolve 35, cli 31, parse 30, types 29, lsp_features 27, lower 27, editor 25, lsp_jsonrpc 21, emit_doc 21, project 20, validate_typing 18, lex 18, db 16, sourcemap 14, lsp_positions 14, index 14, playground_highlight 13, tsc 12, playground_compile 12, lsp_protocol 12, bench_generate 12, spans 9, bench_smoke 9, playground_model 8, validate_mutation 7, schema_validator_forged 7, run_stream_sink_hint 7, vscode_client 6, source 6, schema_adapter_source 6, diagnostic_cascade 6, sha256 5, schema_identity 5, diagnostics 5, temporal_stream 4, schema_null_default 4, schema_encoded_default 4, 12 files with 3, 4 files with 2. Full list: `/tmp/rederive/scratch-TST/fast_counts.txt`.

### 1b. Scripts and helpers (measure.ts)

| File | LOC | Branches | Max cyclomatic | Top functions by cyclomatic |
| --- | --- | --- | --- | --- |
| scripts/behavior_capture.ts | 214 | 28 | 7 | captureRevision 7, instrumentSources 5, difference 5 |
| scripts/golden_update.ts | 8 | 1 | 0 | - |
| scripts/validate_fixtures.ts | 468 | 42 | 7 | buildFixtures 7, canonical 6, at 5 |
| tests/helpers.ts | 548 | 100 | 20 | treeProblems 20 (inner visit 17), sexp 13, constInitializer 8 |
| tests/lsp_helpers.ts | 248 | 20 | 15 | makeHarness 15 |
| tests/cli_helpers.ts | 125 | 21 | 17 | memoryIo 17 |
| tests/target_helpers.ts | 57 | 2 | 3 | runStrictTarget 3 |
| tests/schema_diagnostics.ts | 97 | 6 | 5 | assertValidation 5 |

### 1c. Coverage of the five units (lcov, line and branch)

| Unit | Fast lines | Fast branches | Full lines | Full branches | Functions with an uncovered item (full) |
| --- | --- | --- | --- | --- | --- |
| check_expr.ts | 5743/6506 88.3% (763 uncovered) | 2665/2978 89.5% (313) | 5745/6506 88.3% (761) | 2670/2981 89.6% (311) | 111 |
| lower.ts | 1399/1565 89.4% (166) | 433/484 89.5% (51) | 1400/1565 89.5% (165) | 434/484 89.7% (50) | 28 |
| emit/expr.ts | 1873/2601 72.0% (728) | 874/1047 83.5% (173) | 2462/2601 94.7% (139) | 1045/1164 89.8% (119) | 33 |
| validate/expr.ts | 4146/5064 81.9% (918) | 1603/1932 83.0% (329) | 4169/5064 82.3% (895) | 1619/1945 83.2% (326) | 89 |
| types.ts | 1081/1175 92.0% (94) | 682/734 92.9% (52) | 1090/1175 92.8% (85) | 694/742 93.5% (48) | 17 |

Observation: only `emit/expr.ts` depends on the slow suite. The slow suite covers 589 more of its lines. For the other four units the fast suite gives the same coverage as the full suite (difference of 0 to 23 lines).

## 2. Findings, ranked by leverage

### TST-1 (MECHANICAL, script) - the refactor oracle misses most checker diagnostics and all subprocess runs

Problem. `behavior_capture.ts` hooks three anchors: the success line of `emitModule` (`src/core/emit/emit.ts:186`), the success line of `checkProject` (`src/core/check_project.ts:513`), and a wrapper around `validateModule` (`src/core/validate/index.ts:26`). It records `kind hash length` of `JSON.stringify(value)`.

Evidence (measured):
- The check hook sits in `checkProject`, not in `checkAnalysis`. Three other paths produce checker diagnostics without the hook:
  - The error fixture runner `diagnosticsOfCase` calls `analyzeProject` + `checkAnalysis` (tests/helpers.ts:388-405). Its cases are 48 project error cases of the 62 in `fixtures/errors/` (the other 14 are `syntax-*` parse-only cases, also not recorded). The fast log has 48 tests named "project diagnostics match the markers exactly".
  - `check_test.ts:42` calls `checkAnalysis` directly.
  - `Program` in `src/core/db.ts` runs "the same steps as `checkAnalysis`" (db.ts:347) and never calls `checkProject`. Its users: CLI session (`src/cli/session.ts:38`), LSP (`src/lsp/projects.ts:76`), editor, playground. Tests on this path: 13 `new Program(` sites (db_test 8, playground_compile 2, bench_generate 2, editor 1), plus in-process `cli_test.ts` (31 tests) and the LSP harness tests (lsp_server 41, lsp_features 27).
- Subprocesses record nothing. The hook reads `Deno.env.get("EFFEKTIVE_CAPTURE")` and returns on an exception. I measured that Deno 2.9.7 throws `NotCapable` without `--allow-env`. The CLI subprocess (`deno task effektive` at tests/cli_slow_test.ts:19, which has no `--allow-env` in deno.json), the watch subprocess (cli_slow_test.ts:457), and the LSP subprocess (lsp_slow_test.ts:34) all lack `--allow-env`. So 18 CLI slow tests and 2 LSP slow tests add no records.
- The capture does not record the IR. `lowerModule` output and `serializeModule` text have no hook. The IR is the contract with the sibling repo. The capture sees the IR only through emitted text and validator results.
- The capture does not record error results. The emit hook records only `ok: true`, and no hook exists on `LowerError`.
- The capture does not record LSP responses (hover, definition, symbols, published diagnostics), `typeAt` text, CLI stdout/stderr/exit codes, or source maps. Source maps are a function of the recorded `spans` plus the source text. So the capture covers source maps indirectly but not `sourcemap.ts` itself.
- Anchor fragility: 2 of 3 hooks anchor on a body line (`return { ok: true, value: build(ir, context) };` and `return { ok: true, value: checkAnalysis(analysis.value) };`). A rederive that touches `emit.ts` or `check_project.ts` makes the head capture fail with "hook anchors not found". The failure is loud, but the oracle is then not available for that change. The validator hook wraps the exported function by name and survives body changes.
- The capture fails only when a base record is missing at the head (behavior_capture.ts:229-236). Extra head records are printed but accepted.

Proposed refactor. Do the steps in this order:
1. Move the check hook from `checkProject` to `checkAnalysis`, as a wrapper by function name (the technique of the validator hook). This covers the 48 error cases and `check_test.ts:42`.
2. Add a wrapper on the `Program` method that returns revision diagnostics. The method name needs measurement, because the method was not read.
3. Wrap `emitModule` by name instead of anchoring on its body line. Record both `ok` and error results.
4. Add a `lower` hook as a wrapper on `lowerModule` that records the `Result`.
5. Replace `Deno.env.get` in `HOOK_MODULE` with the records path as a string literal. `instrumentSources` writes the literal into the temporary tree. A process with `--allow-write` then records without `--allow-env`. The CLI task and the LSP subprocess have `--allow-write`.

Projected delta (counted): +2 hook kinds (`lower`, `program`). The 48 error cases, 1 direct checkAnalysis site, and 3 subprocess spawn sites start to record. 2 body-line anchors become 2 name wrappers. 1 env dependency is removed. The record counts per kind need measurement: they need one capture run (about 3.5 min, slow suite included). I did not run it, because the brief says that I must not run the slow suite.

Contract of `behavior:capture` (from the script and its 2 tests):
- Inputs: one or two git revisions.
- Output: the sorted record multiset of each revision, or the difference.
- Effects: `git archive`, a temporary tree, two `deno test` runs in the tree.
- Invariants: each hook anchor occurs exactly once (tests/behavior_capture_test.ts:7, :23). A tree is removed after use.
- Error cases: export failure, missing anchors, failed tests (exit 1), missing base records (exit 1), bad usage (exit 2).

Judging tests: `behavior_capture_test.ts`, 2 tests. They check only the anchors. No test checks that a hook records anything, or that the records are equal for two equal revisions.

Risk: low. The script changes only a temporary tree.

### TST-2 (MECHANICAL, fixtures) - error fixture markers do not pin columns or messages, and the capture does not see them

Problem. `caseActual` (tests/helpers.ts:408-420) compares `path:line code` only. The README "Error fixture convention" confirms this design. The 62 error cases (48 project, 14 syntax) and the `fixtures/parse/recovery-*` files pin no column, end offset, or message text.

Evidence. Together with TST-1, a `check_expr.ts` rederive passes both the fixtures test and the capture for those 48 cases, even if it moves a span inside a line or changes a message. Other tests pin messages only partly. In `check_body_test.ts`, 130 `assertEquals(codes(...))` assertions check codes only. 37 `assertEquals(messages(...))` assertions and the Schema characterization table (check_body_test.ts:3497-3530, `code | message | span text`) pin messages and span text.

Proposed fix. TST-1 step 1 closes this gap with no fixture churn, because the hook then records the full diagnostic JSON with spans and messages. Do not change the marker format.

Projected delta: 0 test LOC. The 48 cases become span-exact and message-exact under the capture.

### TST-3 (MECHANICAL, coverage) - no test reaches the error contract of lowering and emission

Evidence (full lcov):
- `lower.ts`: none of the 30 `internal(`/`unsupported(` failure sites runs. The `LowerFailure` catch in `lowerModule` (lower.ts:1809-1823) does not run. The `no-interface` return (lower.ts:1781, `lowerImports` 1590-1611) does not run.
- The README names six `LowerError` cases. Tests cover 3 of them (`unknown-module` at lower_test.ts:228, `host-interface` at :226, `diagnostics` at :541/:551/:561). No test covers `no-interface`, `unsupported`, or `internal`.
- `emit/expr.ts`: 32 of 35 failure sites do not run (lines 561, 741, 807, 1096, 1107, 1124, 1148, 1224, 1238, 1319, 1339, 1447, ...). One test reaches `EmitError.unsupported` (emit_test.ts:1005), and it goes through `scope.ts`, not `expr.ts`.
- `types.ts`: none of the 3 `throw` sites runs (lines 325, 580, 1153).

Proposal (TYPE-DRIVEN for the source scouts, test work here). For each failure site, choose one of two actions. Make the site unrepresentable through types, so that the branch disappears. Otherwise add a forged-IR test through the public `lowerModule`/`emitModule`, as `schema_validator_forged_test.ts` does for the validator. A rederive must not keep a failure branch that no test reaches.

Projected delta: 30 + 32 + 3 = 65 sites to remove or test (counted).

### TST-4 (MECHANICAL, coverage) - checker and validator diagnostic paths that never run

Evidence (full lcov):
- `check_expr.ts`: 72 of 204 `this.report(` sites never run (53 are `type-mismatch/010`, 9 `type-mismatch/004`, 3 `type-mismatch/005`, 2 `execution-mode/001`, 5 other).
- `check_expr.ts`: the bodies of 46 of 55 `if (!this.arity(` failure guards never run. Example: `layerCall` (check_expr.ts:5448-5456, 37 uncovered lines, 14 branches).
- The top uncovered functions in `check_expr.ts`: layerCall L37/B14, retryScheduleCall L29/B9, allResultsCall L25/B4, retryStreamCall L20/B7, allCall L23/B4, pattern L17/B9, mapEffectCall L16/B8, withFiberCall L19/B4, recordPattern L14/B8, scheduleFromStepCall L16/B5.
- `validate/expr.ts`: 118 of 203 `this.add(` sites never run. The child-expression switch at validate/expr.ts:3047 has 96 lines and 96 branches uncovered. The other top functions: schema L23/B38, codecOperation L31, layer L26/B4, retrySchedule L25/B4, withResource L25/B4. The suite has 17 mutation fixtures (`fixtures/validate/manifest.json`: 001×4, 008×3, 002/003/004/006×2, 005/007×1).

Effect. A table-driven rederive of the arity guards (46 identical "report, fact, finish with error type" bodies) would be judged by only 9 covered instances. A rederive of the validator child switch would be judged by no test for 96 of its cases.

Proposal. Do these steps before the rederive:
1. Add one table-driven wrong-arity test: one `name()` call with a wrong argument count for each builtin. The test then reaches all 55 guards.
2. For `validate/expr.ts`, extend `scripts/validate_fixtures.ts` with one mutation per IR expression kind. The mutation drops or changes one annotation, so that the child switch and the `add` sites run.

The count of new mutations needs measurement against the 95 Expr kinds of `ir.ts`.

### TST-5 (MECHANICAL, coverage) - lowering of pipeline stages for 9 stage kinds is untested

Evidence. In `lower.ts` `stageEffects` (1136-1296), 6 of 13 case groups never run (lines 1204, 1211, 1213, 1226, 1249, 1265). The groups hold 9 stage kinds: `retry-schedule`, `codec`, `schema`, `decode`, `encode`, `retry-with-schedule`, `defer`, `run`, `provide`. This is the largest uncovered function of lower.ts (62 lines, 12 branches). A rederive of `stageEffects` has no judge for these forms.

Proposal. Add one `|>` pipeline test for each of the 6 groups through `lowerProject`. Assert the IR sets, as lower_test.ts:385 does for the pay pipeline. Count: +6 tests.

### TST-6 (TYPE-DRIVEN, test helper) - a non-exhaustive IR walker in lower_test duplicates production

Evidence. `walk` in tests/lower_test.ts:80-148 switches over 22 IR kinds with no `default` and no `never` check. `Expr` in `src/core/ir.ts:119` has 95 members. The production enumerator is `childrenOf` in `src/core/emit/walk.ts:14`. The test "every expression kind and pattern kind lowers" (lower_test.ts:612) asserts a list of 21 expression kinds. The walker does not descend into the other 73 kinds, so their subexpressions are invisible to the test.

Proposal. Use `childrenOf` from `emit/walk.ts`, or add `default: { const never: never = e; }`. Delta: -1 hand-written 22-case switch (about 60 LOC), +exhaustiveness checked by the compiler.

### TST-7 (MECHANICAL) - two fast tests exceed or approach 1 second

1. `tests/sourcemap_test.ts:193` "every position of the forms and of a module in a directory round-trips". It took 2 s in the coverage run, 3 s in the full coverage run, and 482 ms alone without coverage.
   - Cause (measured): `assertRoundTrip` calls `lineStarts(source)` for every generated offset (sourcemap_test.ts:174). Each call scans the whole source file, so the cost is O(generated offsets × source length). The run has 24,534 offsets over 3 modules.
   - A copy that caches `lineStarts` for each source runs in 27 ms. A copy that also builds the assertion message only on a mismatch runs in 6 ms. The same fix applies to the example test at :186 (58 ms in the coverage run).
   - Delta: 482 ms to 6-27 ms. The checks stay the same.
2. `tests/parse_test.ts:493` "nesting up to 100 levels parses...". It took 1 s in the coverage run and 433 ms alone.
   - Cause (measured): 10 inputs × 50,000 repeats. The parser limit is `MAX_NESTING = 512` (src/core/parse.ts:79).
   - I removed the guard in a copy of the parser. Then 10,000 repeats overflow the stack for all 6 nesting openers. 5,000 repeats do not overflow for `if (a) { 1 } else `, and 2,000 do not overflow for `-` either.
   - At 10,000 repeats the test runs in 91 ms, and it keeps its power to detect a missing guard.
   - Delta: 433 ms to 91 ms (repeat count 50000 to 10000). Neither test needs to move to `*_slow_test.ts`.

The other fast tests over 200 ms (coverage run) are all under 1 s: fixtures_test.ts:253 739 ms, check_body_test.ts:3353 475 ms, :3340 471 ms, bench_generate 402 ms, check_test.ts:719 364 ms, :734 299 ms, spans_test.ts:128 269 ms, fixtures_test.ts:273 202 ms.

### TST-8 (TYPE-DRIVEN hazard) - internal-API tests that a rederive of types.ts or check_expr.ts must port

Evidence (AST scan of 1182 `Deno.test` call sites):
- `types_test.ts`: all 29 tests use `TypeTable`, which `src/core/mod.ts` does not export. 15 of them pin the representation: ref identity, sort order, and `toIr` shape. 14 test semantics through `isAssignable`/`show`.
  - The interning checks at types_test.ts:94-101 use `assertEquals(t.array(t.int), t.array(t.int))`. They are meaningful only while `TypeRef` is a number. If a rederive makes `TypeRef` an object, the deep comparison of `assertEquals` passes with or without interning, so the checks become vacuous. Use `assertStrictEquals` for identity.
- `check_body_test.ts`: 24 tests read the node-fact side table (`factsOf`, check_body_test.ts:1889, `NodeFact` from `tables.ts`). The README ("Using the body checker") documents this table as the contract from checker to lowering. 3 tests use `typeAt`, 1 `solveModeGroup`, and 1 `buildInterface`/`buildTypeGraph`/`reachableModules`.
- `check_test.ts`: 14 tests use `checkDeclarations`, `signatureType`, `executionOf`, `TypeTable`, `checkModuleDeclarations`, `stripSpans`, or `buildInterface`.
- `validate_typing_test.ts` (18 tests) and 8 tests in `validate_test.ts` call `validate/typing.ts` internals (`fits`, `same`, `show`).
- `emit_test.ts`: 1 test uses `relativeSpecifier`.

Proposal. Keep the documented table vocabulary and the `TypeTable` method names, or port these 24 + 29 tests in the same commit. Change the 5 identity assertions at types_test.ts:94-101 to `assertStrictEquals` before the rederive.

### TST-9 (MECHANICAL, weak oracle) - acceptance-only checker tests

Evidence. In `check_body_test.ts`, 27 tests have only `assertEquals(codes(...), [])` as assertions. Examples: :90 "mapGroups defers callback channels...", and the 21 tests "a source binding named X shadows the prelude operation" (189 lines, 585-1450). These tests cannot detect a checker that accepts too much. A declared signature in the source gives part of a check, because the checker enforces the expected type (docs/solutions/logic-errors/checker-expected-type-is-enforced-not-a-hint.md).

Proposal. Do two things. Pair each acceptance test with one rejecting variant, or assert the inferred sets through `fn(...)`. Put the 21 shadow tests into one table-driven test. The counted delta for the shadow tests is 21 tests to 1 table, about -150 LOC. The exact delta needs measurement after the merge.

### TST-10 (MECHANICAL, duplication in tests) - small helper duplicates

- `validate_test.ts:27-60` (`segments`, `at`, `setAt`) duplicates `scripts/validate_fixtures.ts:39-86`. `validate_test.ts` already imports that module (line 15). The test copy uses casts where the script copy checks the types. Delta: -30 LOC, after the script exports the 3 functions.
- `exampleFiles` exists twice. `tests/helpers.ts:433` holds a hard-coded list of 7 files. `tests/lsp_helpers.ts:44` reads the whole `fixtures/examples` tree. A new example file appears in only one of the two lists.

Leverage: low.

### Tautology scan result (no finding)

- No `assert(true)` exists.
- 3 tests without assert calls (fixtures_test.ts:253, :273, :293) fail by `throw`, so their checks are real.
- 53 tests have all assertions inside loops. Every loop iterates a literal table or a fixture set. The fixture sets are guarded by count assertions (fixtures_test.ts:53-56, :169, validate_test.ts:2168) or by helpers that throw on any failure (`emitFilesWithProject`, helpers.ts:492-516). Full list: `scratch-TST/loops.txt`.
- The golden tests (emit_test.ts:567, :585, cli_test.ts:220, cli_slow_test.ts:121, editor_test.ts:146) read committed files and do not regenerate them.
- `golden:update` and `validate:update` are bless scripts. A rederive must not run them. `validate_test.ts:2202` pins the exact lowered IR of the 4 example base modules, so it is a strong lowering oracle as long as nobody re-blesses it.
- 4 tests compare a function result with a second call to the same function: emit_test.ts:604, lower_test.ts:505, bench_smoke_test.ts:113, types_test.ts:94-101. These are deliberate determinism or interning properties. TST-8 covers the interning hazard.

## 3. Test gaps that block a rederive

| Unit | Gap | Count | Location |
| --- | --- | --- | --- |
| all five | capture does not record checker diagnostics on the `checkAnalysis` and `Program` paths, the IR, error results, or subprocesses | 48 error cases + 13 Program sites + 3 spawn sites | TST-1 |
| check_expr.ts | wrong-arity bodies never run | 46/55 | TST-4 |
| check_expr.ts | report sites never run | 72/204 | TST-4 |
| lower.ts | `LowerError` tags untested | 3/6 | TST-3 |
| lower.ts | failure sites never run | 30/30 | TST-3 |
| lower.ts | pipeline-stage groups never run | 6/13 (9 kinds) | TST-5 |
| emit/expr.ts | failure sites never run | 32/35 | TST-3 |
| emit/expr.ts | coverage needs the slow suite | 589 lines | 1c |
| emit/expr.ts | residual uncovered with the full suite | structural L50/B46, isTrivial L12/B11, leaf B11 | uncovered_all.txt |
| validate/expr.ts | `add` sites never run | 118/203 | TST-4 |
| validate/expr.ts | child switch uncovered | 96 lines / 96 branches (validate/expr.ts:3047) | TST-4 |
| types.ts | depth-limit failure for non-record kinds (`heightWithin` 793) | 32 lines / 17 branches | uncovered_all.txt |
| types.ts | `assignable` for ref, retry-schedule, codec | 12 lines / 5 branches | uncovered_all.txt |
| types.ts | `show` | 10 lines / 6 branches | uncovered_all.txt |
| types.ts | `fromIr` | 9 lines / 5 branches | uncovered_all.txt |

## 4. Docs that the proposals would make stale

- README.md line 132 ("Compares the check, emit, and validate results of two revisions over all tests"). TST-1 changes the record kinds and the scope. The current text already overstates the scope (TST-1 evidence).
- README.md "Using the lowering" (six error cases). Update it if TST-3 removes cases through types.
- README.md "Error fixture convention" stays valid under TST-2, because the marker format does not change.
- No file in docs/solutions or CONCEPTS.md names the capture or the test layout.

## 5. What not to touch

- `treeProblems` (tests/helpers.ts:128) and `bruteForce` in spans_test.ts. They are deliberate independent oracles. spans_test.ts:128 is a brute-force differential at 269 ms.
- `canonical()` in scripts/validate_fixtures.ts:101 is a duplicate of `serializeModule` printing, but it must stay. It prints invalid IR (unsorted sets for the 3 `validation/008` fixtures) that `serializeModule` rejects.
- The guards of the fixture generators (fixtures_test.ts:53-56, :118, :123, :169) and the disk-equality test (validate_test.ts:2202).
- The `emit_slow_test.ts` runtime oracle: 69 of 74 tests run the emitted code with `deno run --check` and parse its output. It is the strongest judge of `emit/expr.ts`. Its cost is 111 s under coverage. Keep it in the slow suite.
- The validator independence check and the `validateModule` direct use in 14 test files. The README documents `validateModule` as the validator entry.

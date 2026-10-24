# Rederive review: measured re-basing plan

Date: 2026-10-20. Base revision: 730977c. Status: Phase 0 accepted on 2026-10-20. The user chose option (a) for D1, D2, D3, and D4. Phases 0 to 2 are done on main. R1 to R6, R9, R10, R14, and D1 to D6 are done. R7, R8, R11 (checker and validator sides), R12 (FE-1, FE-3, FE-5), and R18 (compareText, isRecord, errorMessage, the editor search, and the dead exports) are done on main. R12 FE-1, FE-3, FE-5, and R18 were replayed in `d25a6a6..c542847`. R7 and the checker side of R11 are in `39e94ba..d858322`. R8 and the validator side of R11 are in `044c2e3..7c2d151`. R16 and R17 are done through P1 and R17 of the hardening plan. FE-2 now completes R12. CHK-11 and CHK-12 are complete. The historical CHK-12 implementation remains at `keep/chk-12` (`21449db`); the current adaptation preserves the later checker changes. The R18 closing-token parser sites are done in `463b872`. R13 and R15b are complete through the accepted completion batch. R15a and C10 are complete through the shared syntax queries; A6 is complete in `docs/builtin-changes.md`. The sibling plan `2026-10-20-hardening-pruning.md` carries the remaining cleanup work.

This document is a plan, not a change. It ranks the weak units of the transpiler by measured leverage. For each rederived unit, it gives the contract to keep, the judging tests, and the verification. The evidence is in `docs/plans/rederive-review-evidence/`. Each finding ID (for example CHK-2) points to a section of a scout report in that directory. The scratch paths under `/tmp/rederive/` in those reports are not kept.

## 1. Executive summary

The current state is better than the size suggests. `src/core` has 0 Deno or global calls and 0 mutable module-level bindings. Its 46 files have 0 import cycles. The ports in `src/host/io.ts` (moved from `src/cli/io.ts` by P4) and the `LanguageServer` constructor already sit at the edge. So the hexagonal target is met at the module level.

The weak parts are inside the four largest stage files: `check_expr.ts`, `validate/expr.ts`, `emit/expr.ts`, and `lower.ts`. They hold 4757 of the 9617 AST branches in `src/` and `playground/src`.

The dominant problem is one shape repeated for each builtin and each IR kind. Six dispatch functions have an own cyclomatic complexity over 100. Some are switches, and some are chains of `if` tests. Each builtin touches 13 to 19 code sites in 7 to 10 files. Much of that cost is real stage semantics, and the validator sites are deliberate. But the stages also repeat guards, prologues, walkers, and name lists inside themselves.

The review found three behavior defects. Their fixes change output, so they need user decisions before any rederive (section 10).

- D1 (codec over a reserved Schema error). The checker and the validator accept `codec` over `SchemaIssue` and over `SchemaError`. Then `deno check` fails on the emitted TypeScript: 4 errors for `SchemaIssue` and 8 for `SchemaError`. Confirmed by reproductions in `rederive-review-evidence/repro/`.
- D2 (export rule through Ref and Fiber). `export type A = { r: Ref<B> }` emits `type B` without `export`, but the documented export rule requires `export`. Confirmed by a reproduction. The schema case also skips `makeInput`, which the emitter prints. No downstream compile failure was found.
- D3 (validator depth cutoff). Three type walkers in `validate/world.ts` stop silently at depth 200. Past that depth, the validator does not report an unknown type id. Confirmed for `validation/001`. The probe module was still rejected by `validation/002`, so no wrong acceptance was shown.

The refactor oracle is weaker than the README states. `deno task behavior:capture` does not record checker diagnostics on 3 of the 4 paths that produce them. It records nothing from CLI and LSP subprocesses, and it does not record the IR. The tests also never run most error paths of the large units. These two gaps block a safe rederive, so Phase 0 fixes them first.

Headline metrics. The baseline values are measured. The target column gives a direction or a design target, not a measured result.

| Metric | Baseline (measured) | Target after Phases 0-4 |
| --- | --- | --- |
| AST branches, `src/` and `playground/src` | 9617 | lower; the net delta needs measurement (see the ledger rule below) |
| Own cyclomatic of the six weak functions (section 2) | 195, 142, 126, 124, 108, 103 | each under 60 (design target); the five tight functions over 100 stay |
| `check_expr.ts` size | 7474 raw lines, 7316 own-body lines | about 3100 own-body lines after R15 (design target, unmeasured) |
| Closed-union switches without a compile-time exhaustiveness check | 19 (see R2 and R3 for the three kinds) | 0 |
| Full-suite coverage | 91.0% branches, 98.2% functions, 91.3% lines | no unit drops; the after-values need measurement |
| Fast tests over 1 s under coverage | 2 | 0 under coverage and in isolation |

The scouts counted the deltas for each finding. Those counts mix labels and decisions, and some counts overlap: CHK-3 removes clones that contain CHK-2 prologues. So this plan gives no projected total. Ledger rule: after each commit of Phases 1 to 4, the reviewing agent runs `measure.ts` and `fns.ts`. The agent records the measured branch and cyclomatic delta in `docs/plans/rederive-review-evidence/ledger.md`. Only the ledger is evidence of a reduction.

## 2. Baseline measurements

Method: `measure.ts` walks the TypeScript AST and counts branches. A branch is an `if`, `?:`, `case`, loop, `catch`, `&&`, `||`, `??`, or `?.`. A `return` inside an `if` or `case` is also a branch. Cyclomatic complexity is the decisions without returns, plus 1. `fns.ts` gives the same counts for each function body, without nested functions. A hand count of `patterns.ts` `domainOf` gave 27 branches and cyclomatic 22, equal to the script.

LOC in the table counts non-blank lines that are not line comments. Run the commands from the repository root. After P0-0, the same scripts are `scripts/measure.ts` and `scripts/measure_functions.ts`. Use `--no-lock`, because these scripts import `npm:typescript` and otherwise change `deno.lock`.

```
deno run --no-lock -A docs/plans/rederive-review-evidence/measure.ts $(git ls-files 'src/*.ts' 'playground/src/*.ts') > /tmp/baseline.json
deno run --no-lock -A docs/plans/rederive-review-evidence/fns.ts $(git ls-files 'src/*.ts' 'playground/src/*.ts') > /tmp/fns.tsv
deno test --allow-all --coverage=/tmp/cov tests/ && deno coverage /tmp/cov --include='src/'
```

Test baseline, measured on 2026-10-20. The fast suite has 1241 tests in 62 files and takes 15.7 s wall time. The full suite has 1370 tests and takes 3 min 31 s under coverage, with 0 failures. The 129 slow tests sum to 149.8 s, and `emit_slow_test.ts` alone takes 111.2 s. Only `emit/expr.ts` depends on the slow suite for coverage: 72.0% lines in the fast suite and 94.7% in the full suite.

The table shows the 24 modules with the most branches. The other 48 modules hold 6651 LOC and 932 branches. Coverage is from the full suite.

| Module | LOC | AST branches | Max own cyclomatic (function) | Imports out | Branch cov | Line cov |
| --- | --- | --- | --- | --- | --- | --- |
| src/core/check_expr.ts | 7233 | 1972 | 142 (schemaCall:1608) | 12 | 89.6% | 88.3% |
| src/core/validate/expr.ts | 5372 | 1629 | 195 (schema:1716) | 6 | 83.2% | 82.3% |
| src/core/emit/expr.ts | 2872 | 768 | 126 (structural:760) | 4 | 89.8% | 94.7% |
| src/core/types.ts | 1383 | 558 | 116 (assignable:1178) | 1 | 93.5% | 92.8% |
| src/core/check.ts | 1766 | 439 | 40 (named:426) | 10 | 92.1% | 93.9% |
| src/core/lower.ts | 1742 | 388 | 108 (invoke:458) | 13 | 89.7% | 89.5% |
| src/core/validate/world.ts | 1091 | 361 | 64 (checkBuiltinShape:834) | 5 | 86.8% | 80.2% |
| src/core/resolve.ts | 1437 | 342 | 39 (expr:1237) | 6 | 95.0% | 95.9% |
| src/core/parse.ts | 1449 | 332 | 31 (parsePrimaryTypeInner:990) | 4 | 98.3% | 98.5% |
| src/core/validate/typing.ts | 469 | 314 | 121 (assignable:93) | 2 | 96.1% | 94.5% |
| src/core/emit/walk.ts | 249 | 196 | 101 (childrenOf:14) | 1 | 99.6% | 99.6% |
| src/core/emit/types.ts | 495 | 168 | 36 (typeDoc:174) | 4 | 86.5% | 91.2% |
| src/core/lex.ts | 636 | 143 | 124 (lex:244) | 1 | 98.1% | 98.9% |
| src/core/project.ts | 559 | 125 | 17 (parseConfig:124) | 5 | 93.2% | 97.2% |
| src/core/emit/decls.ts | 504 | 122 | 22 (namedIn:45) | 7 | 97.4% | 98.5% |
| src/core/emit/doc.ts | 579 | 117 | 51 (render:302) | 1 | 97.5% | 98.9% |
| src/core/check_project.ts | 545 | 99 | 20 (checkModuleBodies:215) | 15 | 91.7% | 97.3% |
| src/core/emit/scope.ts | 513 | 97 | 21 (containsFunction:458) | 5 | 95.3% | 97.0% |
| src/core/editor.ts | 336 | 92 | 20 (targetSpan:238) | 15 | 91.3% | 94.9% |
| src/lsp/projects.ts | 430 | 89 | 10 (anonymous:345) | 8 | 88.5% | 94.5% |
| src/lsp/protocol.ts | 395 | 88 | 11 (narrowDidChange:356) | 1 | 98.5% | 99.1% |
| src/lsp/features.ts | 271 | 83 | 11 (hoverRequest:66) | 12 | 87.8% | 95.2% |
| src/core/interface.ts | 350 | 82 | 26 (foreignTypeGraph:174) | 7 | 96.4% | 99.3% |
| playground/src/app.ts | 500 | 81 | 8 (anonymous:145) | 5 | no test loads it | no test loads it |

Six weak functions have an own cyclomatic complexity over 100:

- `validate/expr.ts` schema (195) and `check_expr.ts` schemaCall (142).
- `emit/expr.ts` structural (126) and `lex.ts` lex (124).
- `lower.ts` invoke (108) and `check_expr.ts` builtinCall (103).

Five more functions are over 100 but already exhaustive and correct. They are `validate/typing.ts` assignable (121), `types.ts` assignable (116), and `validate/expr.ts` compute (102). The other two are the 100-label child switches in `emit/walk.ts` childrenOf and at `validate/expr.ts:3047`.

The test counts for each file, the slow-suite timings, and the coverage for each function are in `scout-TST.md` section 1. Each area report also has them in its section 1.

## 3. Findings ranked by leverage

Leverage is the quality gained for each unit of effort, and risk lowers the rank. A MECHANICAL finding is judged by its AST branch delta at equal behavior. A TYPE-DRIVEN finding is judged by an illegal state that becomes unrepresentable, or by exhaustiveness that the compiler enforces. Its branch count can rise. The scouts counted every delta. "Needs measurement" marks a delta that they could not count.

### 3.1 TYPE-DRIVEN: closed dispatch and exhaustiveness (highest leverage, mixed risk)

R1, R2, R4, and R6 have low risk. R3 and R5 have medium risk: a wrong deferred field changes the hoist order, and a missed field hides a reference.

#### R1. One prelude registry (CHK-1, ARC-1)

- Problem. `resolve.ts` holds the 103 prelude names twice: the `PreludeName` union (lines 46-149) and `PRELUDE_NAMES` (151-255). `SHADOWABLE_PRELUDE_NAMES` (322, 71 names) is an untyped `Set<string>`, so a typo compiles. The 21 schema names occur in 5 lists.
- Problem in the checker (state before commit a23f194; `builtinCall` is now table-driven, as the proposal says). `builtinCall` (`check_expr.ts:1008`) widens the name to `string` and switches over 102 cases. Its `default` (line 1201) catches only `None`, and no test runs it.
- Proposal. Write one `as const` record in `resolve.ts` with a `shadowable` flag. Derive `PreludeName` and both sets from it, in the current order. In the checker, replace the switch with a `Record<Exclude<PreludeName, "None">, Handler>` table. Then a missing handler is a compile error.
- Delta. -103 duplicate name lines and -71 lines for the shadowable list. builtinCall cyclomatic goes from 103 to about 2. One cast goes.
- Contract and tests. The contract is in `scout-CHK.md` CHK-1. The judging tests are `resolve_test.ts` (35), `resolve_shadow_test.ts`, `vscode_client_test.ts`, `playground_highlight_test.ts`, and `check_body_test.ts`. A `None(1)` test (P0-6) comes first.

#### R2. Compile-time exhaustiveness for 17 closed-union switches (CHK-9, EMT-3, EMT-4 part, EMT-7, VAL-1 part)

The 17 sites are of three kinds. The 3 emitter walker defaults are part of R3, which makes 19 in the headline table.

- Silent fallbacks (14). Checker: `check_expr.ts:735`, `:803`, `:1201`, `:2972`, and `:6710`; `check.ts:304` and `:1260`; `types.ts:57` and `:102`; `resolve.ts:434` and `:889`. Lowering: stageEffects `default: break` (`lower.ts:1136`). Validator: `validate/world.ts:393` and `:796`.
- Runtime failures (2). `lower.ts` invoke has `default: throw internal` (983), so a missing call fact fails only at run time. `emit/expr.ts` armBinding throws in its default and repeats `walk.ts` patternBinding.
- Non-exhaustive switch (1). `emit/decls.ts` namedIn (45) returns void and has no default. It omits 5 of the 20 Type kinds. Its schema case also skips `makeInput`. This part is decision D2.
- Proposal. List each member, and end the switch with a `never` check. The 7 defaults over `SyntaxKind` are correct and stay.
- Delta. A new kind at these 17 sites becomes a compile error. The branch count rises by the listed arms, which is accepted for this class.

#### R3. One IR shape table for the emitter walkers (EMT-1)

- Problem. Five switches encode the same facts for each Expr kind. `walk.ts` childrenOf has 100 labels, and 89 of them are plain field lists. `isLeaf` has 35 labels and a default. `structural` repeats 34 leaf labels as a throw list that never runs (35 lines).
- Hidden default. `evaluatedChildren` has 30 labels, and 27 of them equal childrenOf. Its `default: return []` gives `[]` to 5 kinds by omission. `tests/lower_test.ts:80` is a fourth walker over 22 kinds.
- Proposal. Add one mapped table `{ [K in Expr["kind"]]: { children; deferred?; leaf } }` in a new `src/core/emit/shape.ts`. Do not put it in `ir.ts`. Derive the four functions from it. The validator must not import it.
- Delta. About -199 case labels and -3 defaults, plus about 100 table rows.
- Contract and tests. The contract is in `scout-EMT.md` EMT-1. The emit hash in `behavior:capture` judges the text byte for byte over both suites. Binder names in `scope.ts` and constant order in `decls.ts` also judge it.
- Risk. Medium. The mapped type for child fields needs a compile check without a cast.

#### R4. One Type walker in `validate/world.ts` with one reported bound (VAL-1)

- Problem. Three walkers (lines 164, 331, 737) repeat 20 recursive calls each. Each stops silently at `depth > 200`. `typing.ts` uses `MAX_DEPTH = 1536` with a documented reason.
- Proposal. Add one exhaustive `typeChildren(t)` in `validate/` that also gives path suffixes. Use one bound, and report a diagnostic when a walk reaches it. The path strings must stay byte-identical.
- Delta. -40 call sites, -31 case labels, and -2 defaults. The silent cutoff (D3) goes.

#### R5. One Expr child list in `validate/expr.ts` (VAL-2)

- Problem. Four of five walkers use reflection over `unknown`, with 7 casts. One walker uses a typed 100-label switch at line 3047.
- Evidence. A probe gave equal results on 3151 nodes. These nodes cover only 48 of the 100 kinds.
- Proposal. Move the typed switch to module scope as `exprChildren`, and build the four walkers on it.
- Delta. -4 reflective walkers, -7 casts, and about -22 decisions.
- Prerequisite and risk. P0-8 comes first. The risk is medium, because a field that `exprChildren` misses hides a reference from the borrow checks.

#### R6. Type-guard tables for deferred types and for height (EMT-5, CHK-7)

- Deferred types. `emit/types.ts` encodedTypeDoc and schemaDoc, and `emit/scope.ts` containsFunction, list the same 12 deferred Type kinds. The throw arms never run.
- Height. `types.ts` heightWithin (cyclomatic 56) has 19 copies of the Infinity guard. It omits `closeable-scope`, and the compiler does not see the gap.
- Proposal. Add `isDeferredType`, backed by a `satisfies Record<DeferredKind, true>` table. Add a total `childRefs(node)` for heightWithin.
- Delta. -35 labels. heightWithin goes from 56 to about 6, and childRefs has 21 case arms.
- Prerequisite. P0-10 adds tests for the 32 uncovered lines of heightWithin first.

### 3.2 MECHANICAL: repeated prologues and clone families (high leverage, medium risk)

#### R7. Checker handler prologue and clones (CHK-2, CHK-3, CHK-5, CHK-6, CHK-14)

- Counted repeats. 45 arity-bail blocks of 7 lines with one control shape and two result modes: 34 give a pure result and 11 add `EFFECT_ONLY`. Also 49 `noPipeline` calls, 20 identical stream guards, 18 element-or-error ternaries, and 9 purity triples. The bail mode must stay data in the handler row.
- More repeats. 10 stream handlers form 3 clone families: 4 terminals, 2 count operations, and 4 predicates. 2 more handlers are 3-line wrappers. 4 option-record readers repeat 33 shape decisions. 4 borrowed-local walkers share one recursion. The capability-to-service parse exists 3 times, with 2 different split rules.
- Proposal. Put arity, bail mode, pipeline rule, and fact into the R1 handler row. Add `streamArg`, `isPureInfo`, `literalRecord`, and `localUses`. Use `serviceOfCapability` at all 3 parse sites.
- Counted deltas. CHK-2: about -121 branches and -315 lines. CHK-3: -37 branches and -280 lines. CHK-5: -24, and CHK-6: -15.
- Overlap. CHK-3 overlaps CHK-2, because its clones contain the prologues. So the sum is not a net delta, and the ledger gives the measured value.
- Risk. Diagnostic order is observable. Some handlers record their fact after the bail, for example `layerCall` at lines 5450 and 5464.
- Prerequisites. P0-4 and P0-5 come first. Today 46 of 55 arity-bail bodies and 13 of 25 "needs a Stream value" sites never run.

#### R8. Validator stream families and repeated guards (VAL-3, VAL-4, VAL-9, VAL-10)

- Clones. 4 predicate methods, 4 terminal methods, and take/drop are identical except for the name. flatMap equals switchMap plus a concurrency block.
- Repeated guards. The "pure with empty sets" test occurs at 26 sites, the concurrency test at 5, and the paired effect-set union at 17.
- Proposal. Write one method for each family, keyed by kind, as `effectStreamPredicate` already does. Add the helpers `isQuiet`, `validConcurrency`, `unionEffects`, and `withLocals`. All of them stay inside `validate/`.
- Counted deltas. VAL-3: -273 LOC and -46 decisions. VAL-4: -62 decisions and -121 LOC. VAL-9: -22, and VAL-10: about -4.
- Overlap. VAL-3 and VAL-4 overlap at the purity guards inside the clones. The ledger gives the measured value.
- Prerequisite. P0-7 comes first, because 48 of 69 `return this.poison()` lines never run.

#### R9. Lowering builder table (EMT-2)

- Problem. `lower.ts` invoke has 80 clause groups. 60 only move positional arguments into fields, 13 add fact fields, and 7 have logic.
- Proposal. Write a typed one-line builder for each of the 60 positional kinds. The 5 groups that only add `concurrency: fact.concurrency` become builder rows that also copy that field. The other 8 fact-field groups and the 7 logic groups stay in the switch.
- Counted delta. -63 labels, plus -5 for the concurrency groups. The scout projects cyclomatic from 108 to about 45; the ledger gives the measured value.
- Prerequisite. The lower hook of P0-1 comes first. `behavior:capture` records no IR today. `validate_test.ts:2202` pins the lowered IR of only the 4 example base modules.

#### R10. Emitter simple-call table (EMT-6)

- Problem. 27 clauses (169 lines) in structural and leaf differ only in module, method, and argument treatment. The concurrency snippet occurs 5 times.
- Delta. -27 labels and -6 net branches.
- Order. Do it after R3, because R3 changes the leaf union.

#### R11. Schema handlers for each op (CHK-4, VAL-5)

- Checker. `schemaCall` (666 lines, cyclomatic 142) selects the op through 12 `if` heads. Its last block has no op test, so a new op falls into `transform` silently.
- Validator. `schema` (559 lines, cyclomatic 195) has 23 repeated argument guards. `guardedSchemaBody` makes 17 more op comparisons.
- Proposal. On each side, write one handler for each op from a `Record<SchemaOp, ...>` table with a recursion-role column. The two sides stay independent.
- Validator guard. The validator reads IR that can be forged. So it must check that `e.op` is a member of the table before the lookup. Today an unknown op gives a `validation/002` report (`validate/expr.ts:2273`). An unchecked lookup would throw and give `validation/008` through `validate/index.ts:49`. Add a forged unknown-op test that pins the code, path, and message before the change.
- Delta. Checker: -20 dispatch decisions and -11 string tests. Validator: -22 ternaries and -17 comparisons. The cyclomatic value of each handler needs measurement after a draft.
- Tests and risk. The tests are strong: 24 of 538 validator lines are uncovered, and every checker schema report site runs. The risk is medium, because the order of argument checks is visible in the side table.

#### R12. Front-end and edge reductions with working sketches (FE-1, FE-2, FE-3, FE-5)

- Method. The FE scout wrote four sketches and swapped them in with an import map. With all four, the fast suite (1241) and the slow suite (129) passed. The sketches are not kept, so the implementer rewrites each from `scout-FE.md`.
- Lexer split (FE-1). `lex` cyclomatic goes from 124 to 50. The output was identical on 139 files and 20,000 random inputs.
- LSP param schema kit (FE-2). Complete. Private primitive, object, array, optional and params checks replace repeated validation with ordered schemas. The current `protocol.ts`, including newer editor requests, goes from 110 to 57 AST branches and 479 to 469 filtered lines; maximum cyclomatic complexity falls from 11 to 10. Initialization defaults and warnings remain explicit. Editor requests retain position-before-version validation. All ten public narrowers retain their signatures. A deterministic corpus compares 30,000 inputs per narrower: all 300,000 results, exact errors and serialized key order match the pre-refactor source. The 100 focused tests and full gate (1828 fast, 177 slow) pass. Two compile probes reject a missing required schema field and an explicitly undefined optional field; valid optional fields compile. See the measurement ledger for source hashes and procedure.
- Reachability closure (FE-3). `interface.ts` branches go from 82 to 58.
- Type-word slot table (FE-5). parsePrimaryTypeInner goes from 31 to 21. The output was identical on 20,139 inputs.
- Speed. FE-1 needs a `deno task bench` A/B run, recorded in `docs/rejected.md`, before anyone claims equal speed.
- Prerequisites (P0-10). Before FE-1, commit the lexer differential test (A2) and a test for line 438 (invalid escape of an astral character). The FE-2 prerequisite is satisfied by the existing exact-message, nested-path and field-order tests. Two added editor characterization tests also pass against the frozen pre-refactor source, pinning optional versions, request fields and error precedence. Before FE-5, test a Sink without its required comma (`parse.ts:1010-1011`).

### 3.3 TYPE-DRIVEN: state representations (medium leverage)

#### R13. Tagged unions for states with optional fields

- VAL-6. Complete: validator results distinguish derived types, locally checked types and poisoned recovery. Checked results carry only active effects; poisoned results carry no ignored type or effect metadata.
- CHK-8. Complete: internal schema nodes have one four-state presence value, and schema construction takes named options. Constructor defaults remain independent; canonical IR keeps its original flags.
- CHK-13. Complete: tagged entries carry their matching run results, and solver assumptions overlay settled modes through a lookup-only view. Only final results are published into the owned mode map.
- FE-9. Complete: overlay project state is new, ready or failed, with each last-good revision paired with its delta. Configuration failure may retain that pair; the four legacy read properties are derived getters.
- FE-4. Complete: `host/outputs.ts` writes through the tagged `GeneratedSource` port; the revision adapter and injected generation failures are tested. The public `Revision` API is unchanged.
- Delta. Each change makes illegal states unrepresentable. The branch deltas are about neutral and need measurement.

#### R14. One data-only rule on each side (CHK-10, VAL-7)

- Checker. `dataOnly` (`check_expr.ts:2934`) and `schemaData` (`check.ts:262`) are two versions of one rule.
- Validator. `dataOnly` (`validate/expr.ts:2964`) and `recursiveDataOnly` (`world.ts:661`) are two versions of the same rule.
- Difference. On both sides, the two versions differ in the same 2 rules. One rejects `unit` and the reserved `SchemaError` and `SchemaIssue`; the other accepts them.
- Proposal. Write one function with a named rule parameter on each side. The codec rule is decision D1. R14 runs once, in Phase 1, right after the D1 fix. R11 must keep the policy that R14 sets.
- Delta. -1 function on each side. On the checker side, about -40 lines and -21 branches.

### 3.4 Structural moves (do last)

#### R15. Split `check_expr.ts` along builtin families (ARC-3, ARC-4)

- Evidence. The family methods hold 4270 of 7316 own lines. Stream has 1514, schema 916, collection 489, scope 392, and schedule 316. Effect has 268, layer 180, fiber 108, and ref 87.
- Coupling. The families share 29 helper members. No test imports `check_expr.ts`.
- R15a (ARC-3). `lower.ts` imports 4 syntax helpers from `check_expr.ts`. Move them and `shortName` to `syntax.ts`, and keep one `decodeString`.
- R15b (ARC-4). Define a `BuiltinContext` of about 22 members. Move each family to `src/core/check_builtins/<family>.ts`.
- Delta. Branch delta 0. `check_expr.ts` goes from 7316 own-body lines to about 3100 (design target; the size of `BuiltinContext` is not measured).
- Validator. `validate/expr.ts` has the same seam. Its split must not reuse the checker modules.
- Completion. R15a and R15b are complete. The [accepted completion batch](#accepted-completion-batch) records each family, context and verification unit. `check_expr.ts` is 2,997 raw lines after formatting; the common context has ten operations and the largest family context has nineteen members.

#### R16. One check step for each module, shared by the project drivers (ARC-2, FE-11)

- Problem. `Program.check` (`db.ts:348`) restates `checkAnalysis` (`check_project.ts:441`): about 43 duplicated lines and 5 branches. `checkDeclarations` (`interface.ts:357`) is a third copy, and only `check_test.ts` uses it.
- Evidence. Only `db_test.ts` keeps the drivers aligned.
- Proposal. Extract `checkModuleStep`, and use it in both drivers. The Program hook of P0-1 comes first.

#### R17. Adapters through the public API (ARC-7)

- Problem. `src/cli`, `src/lsp`, and `playground/src` have 46 imports from core, and 0 go through `mod.ts`. They use 24 distinct names that `mod.ts` does not export.
- Proposal. Route the three adapter directories through `mod.ts`, with about 14 new re-exports.
- Order. Do this before R15, so that the file moves stop editing the adapters.

### 3.5 Small, independent reductions (low leverage, very low risk)

#### R18. Dead code and helper copies (FE-6, FE-7, FE-8, FE-10, FE-12, FE-13, CHK-12, CHK-11)

- Dead exports. `isReservedWord` and `tokenText` in `lex.ts`, and `Program.revisions` (`db.ts:294`), have zero uses.
- Copies. `compareText` has 9 copies outside the validator, `isRecord` has 3, and the error-message expression has 6. The innermost-node search exists twice in `editor.ts`.
- Repeats. The closing-token parser sites are complete in `463b872`. CHK-12 now derives the builtin type union and name set from one ordered list in `resolve.ts`.
- Builtin types. CHK-12 is complete. An exhaustive table covers all 17 named builtin types, with plain, generic and declaration-only Brand rows. Generic rows share one arity check and lower their arguments in source order. The resolver retains its exported name set and insertion order; no public export or source form changes. The two source files have 3009 filtered lines (+32) and 724 AST branches (-38). `TypeLowerer.named` falls from 153 to 46 raw lines and from cyclomatic 41 to 15. Existing exact-message/span tests pass; three compile probes reject a missing row, unknown row and invalid arity. The full gate passes 1826 fast and 177 slow tests. Constant-input captures match all 8986 suite records and all 11416 records after an additional 1088-case named-type corpus.
- Casts. CHK-11 is complete. The current remainder was 24 ID casts and four duplicate prefix checks across `check.ts`, `check_expr.ts`, `types.ts`, `patterns.ts` and the Stream, Effect and collection checker families. All are removed. Declaration metadata now pairs alias/brand kinds with TypeId and error kinds with ErrorId. Explicit guards preserve the existing nominal-error lookup results; public query signatures and definition-map key types remain unchanged.
- Delta. The earlier deltas are in `scout-FE.md` and `scout-CHK.md`. CHK-11 retains 8082 filtered lines across its seven source files and changes AST branches from 2113 to 2125 (+12 explicit guards). All 274 focused tests, 1826 fast tests and 177 slow tests pass. Three compile probes reject mismatched declaration kinds and IDs that the baseline accepted. Constant-input behavior capture has 8986 records on each side, zero missing and zero new; the evidence ledger records the source identity and capture procedure.
- Prerequisites (P0-10). Before the `cli/format.ts` changes, make the sort test reach the same-path tie-breaks. The CHK-12 prerequisite is satisfied by `tests/type_lowerer_named_test.ts`, which pins RetrySchedule and Fiber diagnostics, messages and spans.

### 3.6 Deferred: needs measurement before ranking

- ARC-5 (payload-free check-to-lower facts). Assessed and declined as proposed: the name-only prerequisite fails. The current union has 90 kinds, 66 payload-free: 54 fixed builtin call tags, ten contextual builtin tags, ordinary `call`, and the `None` value tag. Six resolved names select different kinds from callback modes or options. Two regression tests pin 13 counterexamples through resolution, lowering and independent validation; all 231 focused tests pass. Checker, fact-table and lowering code stays unchanged. A selective rewrite of fixed tags has no measured benefit and is not accepted work. See [the inventory and counterexamples](rederive-review-evidence/arc-5-builtin-facts.md).
- ARC-6 (13 `unsupported` throws, 12 never run). P0-9 classifies each site first. Then each site becomes `internal`, or a diagnostic with a fixture.
- VAL-8 (validator builtin classification). Complete. The independent validator caches typed identity and call classifications for the five collection builtin names. Every prelude value remains marked as a builtin, including invalid IDs; raw names retain malformed non-string failures in the original guarded call phase. Import shape validation still uses the ID, while call rules still follow the first recorded name. Shared container and concurrency helpers remove repeated structural checks. An exhaustive result-shape switch rejects an unhandled name at compile time. Three new characterization tests also pass against the frozen validator; 16,560 targeted differential results match full diagnostics for malformed IDs/names, duplicates and type/container mutations. The full gate passes 1833 fast and 177 slow tests. Across the two existing files and one new helper, filtered LOC rises from 5685 to 5748 (+63), AST branches remain 1631, and checkBuiltinShape cyclomatic falls from 66 to 50. No performance gain is claimed. See the measurement ledger for constant-input capture evidence.

## 4. Test-correctness findings (prerequisites)

The suite is sound where it runs. The tautology scan found 0 cases. There is no `assert(true)`, every loop-only test is guarded by a count, and the golden files are committed, not regenerated. The weaknesses are reach and the oracle.

T1. The refactor oracle has gaps (TST-1).

- The check hook sits in `checkProject` only. It does not record the 48 project error-fixture cases (`tests/helpers.ts:388`) or `check_test.ts:42`. It also misses the whole `Program` path, which the CLI, LSP, and playground use.
- Subprocesses record nothing. The hook reads `Deno.env`, and the CLI and LSP subprocesses run without `--allow-env`. Deno 2.9.7 then throws `NotCapable`, which the scout confirmed.
- No hook records the IR, the error results, or the LSP responses.
- Two of the three hooks anchor on one exact body line. A rederive of `emit.ts` or `check_project.ts` therefore disables the oracle. `behavior_capture_test.ts` checks only the anchors.

T2. The error paths of the large units never run (TST-3, TST-4, TST-5, CHK section 3, VAL section 3). The counts are from the full suite.

- `check_expr.ts`: 72 of 204 report sites and 46 of 55 arity-bail bodies.
- `validate/expr.ts`: 118 of 203 `add` sites, 48 of 69 poison returns, and 96 branches of the child switch at line 3047.
- `lower.ts`: 0 of 30 failure sites run, and tests reach 3 of 6 `LowerError` tags. In stageEffects, 6 of 13 case groups never run. They hold 9 stage kinds, including the valid `|> run` and `|> defer`.
- `emit/expr.ts`: 32 of 35 failure sites.
- Mutation fixtures: the 17 fixtures cover all 8 codes but mutate only 4 example programs. None touches streams, Schema, fibers, scopes, layers, or builtin payloads.

T3. Error fixtures pin only `path:line code` (TST-2). This is the documented convention. Step 1 of P0-1 makes the capture pin spans and messages for those cases, with no fixture change.

T4. Some tests would turn vacuous, and some pin internals (TST-8, TST-9).

- The interning checks at `types_test.ts:94-101` use `assertEquals`. If `TypeRef` becomes an object, they pass without interning.
- 29 `types_test` tests and 24 `check_body_test` tests read internal tables. A rederive must keep the `TypeTable` method names and the documented fact vocabulary. Otherwise it must port these tests in the same commit.
- 27 checker tests assert only "no diagnostics". They cannot catch a checker that accepts too much.

T5. Two fast tests break the 1 s rule under coverage (TST-7). In isolation, without coverage, both take less than 1 s. The acceptance threshold in this plan applies to both conditions.

- `sourcemap_test.ts:193` takes 482 ms alone and 2 to 3 s under coverage. `lineStarts` rescans the source for each of 24,534 offsets. A cache gives 27 ms, and a message built only on a mismatch gives 6 ms.
- `parse_test.ts:493` takes 433 ms alone and 1 s under coverage. Without the guard, 10,000 repeats still overflow the stack, in place of 50,000. With 10,000, the test takes 91 ms.

T6. Smaller weaknesses.

- The CLI sort test (`cli_test.ts:102`) does not reach the tie-breaks that its name gives.
- `tests/cli_helpers.ts` memoryIo cannot fail a listing, a read, or `deno check`.
- `cli/events.ts:13` uses the real timer, so its test waits 90 ms (ARC-9).
- No test guards the rule that core does no I/O (ARC-8).
- `tests/lower_test.ts:80` walks 22 of 100 kinds without an exhaustiveness check (TST-6).

## 5. Architecture findings

Hexagonal boundaries hold (ARC section 1.1). `src/core` makes 0 calls to `Deno.*`, the clock, random, console, timers, or fetch. It has 0 non-relative imports. The CLI keeps its Deno calls in `deno_io.ts` and on `main.ts:79`. The language server takes its ports in its constructor. One clock is not injected: `src/cli/events.ts` (ARC-9).

Capabilities hold (ARC section 1.2). `src/` has 0 mutable module-level bindings. `Program` is the only memo across calls, and its `TypeTable` is append-only by design. Session and ProjectState construct `Program` themselves. `Program` is pure, so this is not a hidden I/O dependency.

Purity (ARC section 1.3). Direct mutation for each 1000 lines is 14.3 in `check_expr.ts`, 21.2 in `lower.ts`, 11.3 in `emit/expr.ts`, and 5.6 in `validate/expr.ts`. Almost all of it is local accumulation in one instance for each body. Three kinds of writes leave their owner:

- the 151 interning calls into the shared `TypeTable`, which are deliberate;
- 4 parameter writes into pattern-coverage state in `check_expr.ts` (lines 2941, 7166, 7210, 7366);
- the `modes` map that `checkModuleBodies` shares (R13).

Errors (ARC section 1.5). `src/core` has 84 real throws. 71 are internal invariant checks, which are acceptable. 13 are expected `unsupported` failures, which the entry points convert to `Result`. Keep the throw-then-convert design, and reclassify the 13 sites as ARC-6 describes.

The proposed boundaries are R15 (family modules behind a `BuiltinContext`) and R16 (one shared module step). R17 routes the adapters through `mod.ts`. ARC-8 adds a guard test for the core boundary.

## 6. Docs to update

These docs go stale when R1 to R17 change the code. Update each doc in the commit that changes its subject.

- README.md "Layout" (lines 141-248). Change the lines for `check_expr.ts`, `resolve.ts`, `tables.ts`, `lower.ts`, `db.ts`, `interface.ts`, `mod.ts`, and `walk.ts`. Change the validator file list. Add lines for `emit/shape.ts`, `check_builtins/`, and any new validator walker module.
- README.md line 132 (`behavior:capture`). It overstates the scope today. Update it with T1.
- README.md line 206 and `docs/plans/2026-10-16-lsp.md` lines 75, 309, and 369. They give the `writeGenerated` signature, which changes if FE-4 adds a port.
- README.md line 268 ("Using the declaration checker"). It names `checkDeclarations`, which R16 can remove.
- README.md "Using the lowering" (six error cases). Update it if ARC-6 removes cases.
- `docs/solutions/logic-errors/checker-result-type-from-expected-hint.md` (lines 55, 59) and `checker-expected-type-is-enforced-not-a-hint.md` (line 30). Their 3 line references have already drifted. Their `module:` frontmatter changes with R15.
- `docs/rejected.md`. Add the FE-1 bench result, a win or a null result.
- `CONCEPTS.md`. Add "prelude registry" with R1. Add "leaf" and "evaluated children" with R3, if the terms enter shared use.
- Header comments. `validate/expr.ts` lines 2-9 call the validator "the checker", a term that CONCEPTS.md lists under "Avoid". The `db.ts` header (lines 22-24) and the `interface.ts` header (lines 12-14) change with R16. The `protocol.ts` header changes with FE-2.
- The 45 dated plans in `docs/plans/` are history. Do not edit them for these changes.

## 7. Additional re-basing tasks

- A1 (Phase 0, P0-0). Move the two measurement scripts to `scripts/measure.ts` and `scripts/measure_functions.ts`, with two task entries. Pin the `npm:typescript` version in the import map. Today the scripts are only in the evidence directory.
- A2 (Phase 0, P0-10). Commit a fixed-seed differential test for the lexer before the lexer split. Its oracle is a hash snapshot of the current lexer output, made at the base revision (P0-10).
- A3 (Phase 0, P0-3). Add a guard test for the core boundary (ARC-8). It walks `src/core` with `Deno.readDir` and scans for Deno and global APIs and for non-relative imports. It skips emitted code strings. It must also skip the capture hook files that `behavior:capture` writes into a temporary tree (`HOOK_PATHS` in `scripts/behavior_capture.ts`).
- A4 (Phase 3, with R18). Remove the dead exports (FE-6). First search `editors/` and `bench/` to confirm zero uses.
- A5 (Phase 3, with R18). Export one shared `compareText` outside the validator (FE-7).
- A6 (after Phase 3). Write a "touch one builtin" checklist after R1, R3, and R9, because they remove sites. The measured cost is 13 to 19 sites in 7 to 10 files (ARC section 1.4). `docs/plans/2026-10-17-effect4-gap-closure.md` lists only 5 stages.

## 8. Phased plan

The reviewing agent runs these checks at the end of each commit. The implementer's claim is not evidence.

1. Run `deno task check`, and confirm that it passes.
2. Run `deno task behavior:capture <base> HEAD`. In Phases 2 to 4, confirm that no base record is missing. In Phase 1, confirm that the missing and new records are exactly the expected differences of that defect.
3. Run the measurement commands of section 2. Record the measured deltas in the ledger (section 1).

Commit each finding as its own commit. Phase 0 must land before any later phase. The capture base for Phases 2 to 4 is the last commit of Phase 1.

### Phase 0: make the judge sound

Phase 0 changes no production behavior. P0-0 and P0-1 come first, because the later steps use their tools.

- P0-0 (A1). Move `measure.ts` to `scripts/measure.ts` and `fns.ts` to `scripts/measure_functions.ts`. Add the tasks `measure` and `measure:functions`, and pin `npm:typescript` in the import map. Both outputs keep their current format. After P0-0, the section 2 commands use these two scripts. Check the hand count of `patterns.ts` `domainOf` again: 27 branches and cyclomatic 22.
- P0-1 (T1). Change `scripts/behavior_capture.ts` in this order:
  1. Replace the check hook with a wrapper on the exported `checkAnalysis`, keyed by function name. Record the full diagnostic list of each call, with spans and messages.
  2. Wrap `Program.update` (`db.ts:317`) by name. For an `ok` result, record `revision.diagnostics` (`db.ts:179`) once for each call. For an error result, record the `ConfigError` value. A cached revision records again, because the capture compares multisets.
  3. Wrap `emitModule` by name. Record the success value as today, and record each error result too.
  4. Wrap `lowerModule` by name. For `ok`, record `serializeModule(value)`. For an error, record the `LowerError` value.
  5. Write the records path into the hook module as a string literal, and remove `Deno.env`. A subprocess with `--allow-write` then records without `--allow-env`.
  6. Exclude the capture tests (`tests/behavior_capture*_test.ts`) from the suites that the capture runs. Otherwise the capture runs itself recursively.
  7. Add a fast test: two captures of the same in-memory program give equal, nonempty record sets for each hook kind.
  8. Add one slow test that runs one CLI build subprocess under the hook. It confirms that a subprocess writes records.
  9. Run one full capture of HEAD, and record the count for each kind in the ledger. The full run takes about 3.5 min.
- P0-2 (T5). In `sourcemap_test.ts`, cache `lineStarts` for each source, and build the message only on a mismatch. In `parse_test.ts:493`, set the repeat count to 10,000. Measure both tests in isolation and under coverage.
- P0-3 (A3). Add the guard test for the core boundary. It walks `src/core` with `Deno.readDir`, not with git, because `behavior:capture` runs the tests in an exported tree without `.git`. It skips the `HOOK_PATHS` files of `scripts/behavior_capture.ts`. Change `types_test.ts:94-101` to `assertStrictEquals`.
- P0-4 (T2). Add one table-driven wrong-arity test with one row for each prelude builtin. Each row gives the builtin, a call with a wrong argument count, the expected code, and the expected message. Rows that have two arities, such as `all(effects, options?)`, test both bounds. `None` is not callable, so it has its own test (P0-6). Measure that all 55 arity-bail bodies run.
- P0-5 (T2). Add one table-driven test for the report sites in `rederive-review-evidence/checker-unhit-report-sites.txt` (120 lines, 72 sites). Each row gives the builtin, a valid setup, the one change that triggers the site, the expected code, and a message fragment. Measure that each listed line runs. A site that no source program can reach goes to the ledger as dead code, with the reason.
- P0-6. Add a `None(1)` test for the builtinCall default. Add one `|>` pipeline test for each of the 6 stageEffects groups that never run (TST-5), and assert the IR sets. Add a test of `x |> codec(...)` to confirm that the `codec` arm is dead.
- P0-7 (T2). Add validator mutations in memory, inside `tests/validate_mutation_test.ts`. Do not change `scripts/validate_fixtures.ts`, so the committed fixtures and `validate_test.ts:2202` stay byte-equal.
  - For each stream family, add three mutations. The first replaces an inline closure with a reference. The second replaces the stream operand with a non-stream value. The third makes a seed, count, or policy impure.
  - For each Schema family, add two mutations. The first replaces a schema argument with a non-schema value. The second gives a getter or default callback a failure other than `SchemaIssue` or `SchemaError`.
  - Assert the code, the path, and a message fragment. Measure the poison returns of `validate/expr.ts` that still never run, and list them in the ledger.
- P0-8 (for R5). First extract the typed child switch at `validate/expr.ts:3047` to an exported module-level `exprChildren`, with no other change. Then add a test that compares `exprChildren` with an independent reflective walker in the test file, over every fixture IR. List the Expr kinds that no fixture reaches, and add a synthetic IR node for each. Replace the walker at `tests/lower_test.ts:80` with `walkExpr`, or add a `never` check (TST-6).
- P0-9 (ARC-6). Classify each of the 13 `unsupported` sites. For each site, find the checker or validator rule that excludes the shape, or a source program that reaches it. Record the result in the ledger. Then add tests for the sites that stay:
  - for `lower.ts` sites, a forged `CheckedProject` through `lowerModule` (`lower.ts:1751`);
  - for emitter sites, forged IR through `emitModule` (`emit/emit.ts:181`);
  - the `no-interface` result of `lowerImports`, and both throw-to-`Result` conversions (`lower.ts:1808-1823`, `emit/emit.ts:185-209`).
- P0-10 (prerequisites of later items). Add these tests before the item that needs them:
  - for R6, the uncovered arms of `types.ts` heightWithin (32 lines);
  - for R11, a forged unknown Schema op through `validateModule`;
  - for R12, the lexer differential test (A2) and the astral-escape case at `lex.ts:438`. The oracle is a frozen snapshot. A script generates a fixed-seed corpus of 20,000 inputs, plus every `.eff` and `.effi` file. It records the current `lex` output for each input as a hash, at the base revision, in a committed fixture. The test regenerates the corpus and compares the hashes;
  - for R12, exact messages in `lsp_protocol_test.ts` for one case of each primitive, and the Sink missing-comma case at `parse.ts:1010-1011`;
  - for R18, a CLI sort test with two diagnostics in one file, and the `check.ts` named error paths (lines 445, 495-551).
- Expected measurement. No fast test takes 1 s or more, in isolation or under coverage. The line coverage of `check_expr.ts`, `validate/expr.ts`, and `lower.ts` rises. The new values and the new fast-suite time need measurement.

### Phase 1: fix the decided defects

Phase 1 starts after the user answers D1 to D3. Each fix is one commit, and its regression test comes first. The capture must show exactly the expected differences of the defect, and no other change.

- D1. Add checker tests for `codec` over `SchemaIssue` and over `SchemaError`, using the files in `repro/`. Add a test that `codec` over `void` stays valid. The checker stops before lowering, so the validator needs forged IR: add a forged codec node for each reserved error to a validator test. Then fix both sides, each in its own code, and do R14 in the next commit.
- D2. Add an emitter test for each newly traversed child: Ref, both Fiber channels, both Codec types, RetrySchedule, and Schema `makeInput`. `CloseableScope` has no child (`ir.ts:55`), so namedIn only lists it for exhaustiveness. Each test has a private type that only that child reaches. Then make namedIn exhaustive (part of R2). The 6 committed golden files do not change, because their inputs use none of these kinds.
- D3. Implement the contract in section 10 (part of R4). Test the walks for identities, duplicate fields, and recursion at depth 1536 and at 1537.
- Expected. The D1 programs give a checker diagnostic, and the forged IR gives a validator diagnostic. The D2 programs emit `export` for every reached type. The D3 tests give one explicit report beyond the bound.

### Phase 2: closed dispatch (R1 to R6)

Phase 2 has mixed risk (section 3.1), and each step removes a failure class.

- Order. R1, then R2, then R6, then R3, then R4, then R5. R5 uses the `exprChildren` that P0-8 extracted.
- Expected. builtinCall cyclomatic is about 2. childrenOf, isLeaf, and evaluatedChildren are about 3 each. The 19 sites of the headline table have a compile-time exhaustiveness check. The ledger gives the measured branch delta.

### Phase 3: mechanical reductions (R7 to R12, R18)

- Checker order. R7 (CHK-2 before CHK-3), then R11.
- Validator order. R8, then the VAL-5 part of R11.
- Lowering. R9, after the lower hook of P0-1.
- Emitter. R10, after R3.
- Front end. R12, each sketch rewritten as its own commit, after its P0-10 tests. FE-1 comes with the bench A/B run.
- Small items. R18 with A4 and A5, after their P0-10 tests.
- Expected. The ledger gives the measured branch delta of each commit.

### Phase 4: state types and structure (R13, R15 to R17)

- Order. R17, then R15a, then R15b. R16 comes after P0-1. The R13 items can come in any order. R14 is in Phase 1.
- Expected. `check_expr.ts` has about 3100 own-body lines (design target). The branch delta of the moves is about 0.

## 9. What not to touch

These units are already tight, by measurement:

- `types.ts` assignable (116), keyOf, toIr, fromIr, and show, and `validate/typing.ts` assignable (121). They are exhaustive switches over closed unions with no `default`. Only small helpers apply (VAL-9).
- `validate/expr.ts` compute (102). 100 of its decisions are case labels of a dispatch that the compiler checks for exhaustiveness. 2 of its 211 lines are uncovered. A table would need a cast on the lookup.
- `binary` in the checker and in the validator. Both are exhaustive over the operators.
- `emit/doc.ts`: render (51) is the layout state machine, with 98.9% lines covered. Also `serialize.ts`, `emit/sourcemap.ts`, `spans.ts`, `tsc.ts`, `explicit_scope.ts`, `schemaExpr`, and `typeDoc`.
- `tables.ts`, `modes.ts`, `initialization.ts`, `patterns.ts`, `sha256.ts`, `hash.ts`, `source.ts`, and `diagnostics.ts`.
- `syntax.ts`, `analyze.ts`, `positions.ts`, `args.ts`, `events.ts`, `build.ts`, `jsonrpc.ts` classifyMessage, and `server.ts`.
- `Lowered { ref, ir }` in `check.ts`. A probe over 3620 lowerings found 70 where `ir` differs from `toIr(ref)`. 65 differ in source order, and 5 keep a schema `makeInput`. So the two forms are not redundant.

Scope traps:

- Do not share code between the checker and the validator. Their parallel logic is the differential oracle. D1 shows the cost when both agree on a wrong rule: fix both sides, each in its own code.
- Do not change `src/core/ir.ts`. It is copied from the sibling repository.
- Do not propose object tokens for the lexer (`docs/rejected.md`).
- Do not merge the diagnostic sort orders of the CLI, the core, and the playground. The merge changes the visible order.
- Do not convert the 71 internal throws to `Result`. They guard invariants that never run.
- Do not run `golden:update` or `validate:update` during a rederive. They re-bless the oracle.
- Do not add language features. The application acceptance rule in AGENTS.md stops feature work.
- Run scratch scripts with `--no-lock`. Otherwise `deno.lock` changes.

## 10. Decisions for the user

D1. Codec over a reserved Schema error.

- Observation. `codec` over `SchemaIssue` and over `SchemaError` passes the checker and the validator. `deno check` then fails on the output: 4 `TS2551` errors for `SchemaIssue` (`SchemaIssue.Issue` does not exist), and 8 `TS2322` and `TS2345` errors for `SchemaError`. `codec` over `void` passes all three gates. The inputs and outputs are in `rederive-review-evidence/repro/d1-*`.
- Command. In an empty directory with `effektive.json` containing `{}` and the `.eff` file as `m.eff`, run `deno run --allow-read --allow-write --allow-run=deno src/cli/main.ts build <dir> --validate --tsc` from the repository root.
- Option (a). Reject `SchemaIssue` and `SchemaError` as codec types in the checker and in the validator, each in its own code. Keep `void` valid for codec, although `schemaData` rejects `unit` for `Schema<...>`. No fixture or test in `fixtures/` or `tests/` uses a codec over a reserved error.
- Option (b). Teach the emitter to derive a schema for them.
- Recommendation: (a). It removes a class of programs that pass every Effektive gate but fail `deno check`, and it changes no output for valid programs.

D2. Export rule through Ref, Fiber, Codec, RetrySchedule, and Schema `makeInput`.

- Observation. A private type that only `Ref<B>` reaches is emitted without `export` (`repro/d2-export-ref.eff` and its output). The EMT scout observed the same for `Fiber<B, E>`. Codec, RetrySchedule, and Schema `makeInput` are probable cases from the same code path. No compile failure was found.
- Option (a). Make namedIn exhaustive, and visit every child, including `makeInput`. This changes emitted text only for programs that reach a private type through these children.
- Option (b). Keep the output, and amend the rule in README.md line 330 and `docs/phase-a-rules.md` line 92.
- Recommendation: (a). The rule is documented, and an importing module can need to name the type.

D3. Validator depth bound.

- Observation. Three walkers in `validate/world.ts` (lines 165, 332, 738) stop at depth 200 without a report (`repro/d3-depth.ts` and its output). The missed unknown id is observed. A missed duplicate field or cycle is probable from the same code, and the D3 tests confirm it.
- Option (a). One bound with an explicit report. The bound is 1536, the documented `MAX_DEPTH` of `validate/typing.ts`, so the validator has one depth limit. A walk accepts depth 1536. At depth 1537, the walk reports one `validation/002` diagnostic, `<path>: type nesting exceeds 1536 levels`, and stops that branch. The validator reports at most one such diagnostic for each declaration.
- Option (b). Raise the bound to 1536, and keep the silent stop.
- Recommendation: (a). A silent stop is a class of false negatives in the oracle.

D4. Scope of acceptance.

- Option (a). Accept Phase 0 only now. Decide the later phases after its measurements.
- Option (b). Accept Phases 0 to 4 as ordered.
- Recommendation: (a). Phase 0 changes the oracle that judges every later phase. Its record counts and coverage values are not measured yet.

## 11. Defects that Phase 0 found

P0-9 found two programs that pass the checker but fail in a later stage. `tests/unsupported_sites_test.ts` records the current `unsupported` result of each. A fix must change that test in the same commit.

D5. Pipeline into an error constructor.

- Observation. `const mk = (): Stop => ({ code: 1 }) |> Stop()` passes the checker. Lowering then fails with `unsupported` at `lower.ts:529`. The form `|> Stop` fails the same way. The direct call form gets `type-mismatch/010` from `check_expr.ts:944-952`.
- Option (a). Reject the pipeline form in the checker with the diagnostic of the direct form.
- Option (b). Lower the pipeline form as a direct construction.
- Recommendation: (a). No fixture uses the form, and option (b) adds a language form.

D6. A pure function value from an effect-mode expression in an effect function slot.

- Rules. `docs/phase-a-rules.md:39` says that a function type in type syntax has the `effect` execution by default. Line 88 says that a pure function fits an effect function type directly in a value position, and that the emitter wraps it there.
- Observation. The checker and the validator accept all three forms below. The emitter fails on each form. It gives a block result, a branch, or an arm its own type, not the slot type.
- Form 1, a branch of an `if`. Emission fails with `unsupported` at the `fit` method of `emit/expr.ts`. `tests/unsupported_sites_test.ts` pins this result.
- Form 2, an arm of a `match` (`repro/d6-match-arm.eff`). The emitter writes `return pure;` without the wrap. `deno check` then fails with `TS2375`.
- Form 3, the body of an effect function whose declared result is a function type (`repro/d6-result.eff`). The IR gives the declared result `execution: "effect"` and the body result `execution: "pure"`. The emitter writes `return pure;`, and `deno check` fails with `TS2375`. This form is the smallest program: `const mk = (): ((n: Int) => Int) fails Stop uses Gate.pick => { Gate.pick(); pure }`.
- Option (a). The emitter gives the slot type to the result of a block, to each branch of an `if`, and to each arm of a `match`. The existing wrap then applies to the pure value, after the effects run once. Programs that need no wrap keep their exact text.
- Option (b). The checker and the validator reject a pure function value from an effect-mode expression in an effect function slot. This rejects form 3, which the documented rules allow.
- Recommendation: (a). The documented rules, the checker, and the validator agree. Only the emitter is wrong. The fix comes after track E of Phase 2, because track E edits `emit/expr.ts`.

## 12. Oracle limit found in Phase 2

- Observation. The `check`, `program`, and `validate` records of `behavior:capture` hash only the result, not the input. So every clean result gives the same record, the hash of `[]`.
- Effect. The comparison is a multiset difference. When a clean program gains a diagnostic, one `[]` record goes missing. A new test with a clean program adds a `[]` record, and the loss is hidden. A commit that adds tests can therefore hide a behavior change.
- Phase 2 check. The coordinator captured the Phase 2 source with the Phase 1 test set, so that no new test is in the comparison.
- Proposal, before Phase 3. Add the input to each `check`, `program`, and `validate` record: the module path and a hash of its source text. This is a test infrastructure change in `scripts/behavior_capture.ts` only. Done in `0844b30`.

## Architectural cleanup on 2026-10-21

R15a and the deferred C10 now use `src/core/syntax_queries.ts` for child,
literal, operator, arrow-body, initializer and type-kind queries. That module
depends only on the lexer and lossless syntax tree. Lowering no longer imports
the expression checker. `shortName` and `decodeString` keep the shared owners
established by P5. No public core export, IR shape, checker policy or validator
code changes. A6 is the [builtin-change checklist](../builtin-changes.md).

Verification is recorded in the rederive evidence ledger. That batch left
R15b open; its old family/context size estimates required fresh measurement.

The second cleanup unit completes CHK-13 entry/result pairing: separate
function and constant entries carry only their applicable syntax node, and
each run owns the matching entry. Recursive-group result publication uses
those pairs instead of parallel array positions. The existing SCC solver,
shared mode map, diagnostic order and public checked-body types are unchanged.
The rest of R13 remains open.

The next bounded unit implements the R15b Schedule pilot. Four handlers for
seven general Schedule builtins move to `src/core/check_builtins/schedule.ts`.
They use eight members of `BuiltinContext`: the type table, argument checking,
callback checking, result recording, assignability diagnostics, function-type
lookup, inline-arrow checking and diagnostic reporting. `BodyChecker` implements
that interface directly; no wrapper object or bound callback is allocated for
each call. The argument shape moves unchanged to `check_builtins/context.ts`.
Prelude dispatch, arity and pipeline checks, lowering facts, retry schedules,
stream aggregation and independent validation retain their existing owners.

This is a module-boundary change, not a branch reduction: the measured branch
delta is zero. `check_expr.ts` goes from 6929 to 6750 raw lines; the three
affected source files together add 42 filtered lines for imports and contracts.
The four handler bodies have identical token sequences after replacing their
`this` receiver with the context parameter. The other R15b families remain open;
the original whole-checker size target is still unmeasured.

The Codec unit moves `codecCall` and `codecOperation` to
`src/core/check_builtins/codec.ts`. The same context gains `isError` and `widen`,
for ten shared members. Construction still checks pure transformations,
reversed input/output types and compiler-derived schemas; decode and encode keep their
existing input checking and Option results. `dataOnly` stays in `types.ts` and
the independent validator remains separate. The two handler bodies have
identical tokens after receiver normalization. The checker falls from 6750 to
6669 raw lines; the three affected files add 12 filtered lines overall, with no
branch change. Other R15b families remain open.

The Ref unit moves the single handler for `makeRef`, `getRef`, `setRef` and
`updateRef` to `src/core/check_builtins/ref.ts`. It reuses the ten-member context
without adding members. Argument order, element widening, effect mode, input
checking and pure update callbacks retain their rules; all handler-body tokens
match after receiver normalization. The checker falls from 6669 to 6627 raw
lines. Across the two affected files, filtered LOC rises by 5 and the branch
count stays the same. Schedule, Codec and Ref extraction is complete; the other
R15b families remain open.

## Accepted completion batch

The user accepted closing the remaining R13 and R15b work after the Schedule,
Codec and Ref units. Recheck each original finding against the current code,
including save-transpilation changes. Keep behavior, diagnostic text/order,
public core contracts and the independent validator intact. The order is R13
FE-4 (generation boundary), VAL-6 (validator result states), CHK-13 (mode-map
ownership), CHK-8 (schema presence), FE-9 (project state), then the remaining
R15b families: collections, Effect/Layer, Fiber/Scope, Stream/Sink and Schema.
Retire an obsolete finding only with current evidence; a last-good revision
alongside a configuration error is a valid state. Each complete unit gets its
own local commit after the full gate and constant-input behavior comparison.

FE-4 now gives `writeGenerated` a `GeneratedSource` port whose result is one of
skip, lower failure, emit failure, map failure or ready output. The adapter in
`src/host/generation.ts` preserves all four lazy query calls and their order;
the writer receives a complete emitted module, span table and source map only
in the ready variant. It retains silent diagnostic skips, exact notes,
continuation after errors, dry runs and changed-file-only writes. The public
`Revision` API is unchanged. Failure injection uses the port and a structural
query adapter without casts. Verification is in the evidence ledger.

VAL-6 replaces `Comp`'s optional-field encoding with derived, checked and
poisoned variants. Derived results require a type and comparison rule;
checked results carry only recomputed effects; poisoned recovery uses the
recorded sets. The factories retain exact/fit comparisons and `finish` retains
type-identity checks and diagnostic order. The unbrand path explicitly returns
a checked result when a base type cannot be found, after its existing report.
The independent validator shares no checker code. All 209 focused validation
tests pass, and TypeScript rejects three forged invalid result states in a
separate compile check. Full gate and capture evidence follow in the ledger.

CHK-13 now also separates round-local solver assumptions from published modes.
`signatureType` and `executionOf` consume a getter-only `ModeLookup`. Each
recursive round supplies a lookup that checks its assumptions before settled
modes, without mutating the published map or copying that whole map per round.
Final mode publication, inference tables, SCC ordering and the solver remain
unchanged. All 254 focused checker/declaration/incremental tests pass; a
negative type check rejects `ModeLookup.set` with TS2339. This completes R13's
mode-map remainder; the gate and comparison are recorded in the ledger.

CHK-8 replaces the three exclusive internal schema flags with required,
optional, encoded-optional or decoded-optional presence. Twelve construction
sites now pass named schema options, including make input and the independent
constructor-default flag. Intern keys retain their former legal-state bits;
IR conversion, source type-word metadata, directional effects, assignability
and display names retain their contracts. Neither `ir.ts` nor public core
exports changes. The new internal tests check all four presence values with
both constructor-default states, canonical IR roundtrips and make-input
normalization. All 141 focused tests pass; three negative compile probes reject
unknown presence, positional flags and legacy flags on internal schema nodes.

FE-9 gives `ProjectState` one tagged overlay-update phase. New state has no
revision; ready state owns a revision/delta pair; failed state owns a config
error and may retain the last good pair. The existing `started`, `lastGood`,
`lastDelta` and `configError` reads are getters; only `recordUpdate` changes
the phase. Configuration errors deliberately coexist with the last good
revision, so editor fallback and diagnostic retention keep their behavior.
Disk-program inputs track attempts, and disk module ownership tracks successful
rounds and failed removals; those distinct save-round timelines are unchanged.
All 96 focused state/server/editor/save tests pass. Four negative compile
checks reject independent assignments to the legacy properties. This closes
R13; the evidence ledger records its full gate and comparison.

R15b collections move five entry handlers and two collection-only helpers to
`check_builtins/collections.ts`. Its twelve-member `CollectionContext` selects
nine shared operations and adds fact recording, direct-call checking and
concurrency-option checking. The shared context stays at ten members. Dispatch
still selects the handler; arity, pipeline order and specialization facts keep
their behavior. Argument evaluation and body tables remain in `BodyChecker`.
The moved array-element helper calls `table.show` directly, the same query that
the former checker wrapper delegated to. The two collection-only helpers are
private to the family module. All 466 focused tests pass; full gate and capture
are recorded in the ledger.

R15b Effect/Layer moves six Effect entry handlers, two retry helpers and three
Layer handlers into their owning modules. `EffectContext` has fourteen members;
`LayerContext` has ten, including a read-only service-signature view rather than
the body environment. The shared ten-operation context gains no operations.
Function shapes, literal-field shapes and invocation effects now have one shared
owner in `context.ts`. The checker still owns argument evaluation, diagnostics,
body facts and generic callback checking. All 466 focused tests pass; full gate
and constant-input behavior comparison are recorded in the ledger.

R15b Fiber/Scope moves fiber operations and their borrowed-use policy to
`fiber.ts`, and scope/resource operations and borrowed-parameter validation to
`scope.ts`. Their contexts have twelve and fourteen members respectively;
read views expose facts, resolver targets and service lookup, with a dedicated
value-type lookup for borrowed calls. The common context keeps ten operations.
The checker still owns fact writes and diagnostics; its generic local-use walker
supplies the same ordered uses. All 509 focused tests pass, and all twelve moved
method bodies match in normalized AST comparison. Four negative type probes
reject mutation through the read views and access to body tables. Full gate and
constant-input capture evidence are recorded in the ledger.

R15b Stream/Sink moves twenty-three entry handlers and ten private helpers to
`stream.ts`, including grouping lifetimes, temporal controls, callback channels
and aggregation hints. Its nineteen-member context includes the ten shared
operations plus the required syntax, read views and option/fact ports. Pure and
effect predicate metadata remains shared with dispatch. The existing pattern-kind
set moves to `syntax_queries.ts` behind `isPatternKind`, used by both ordinary
match checking and Stream hints. All 520 focused tests pass. Normalized AST
comparison matches all thirty-three moved bodies and both metadata initializers;
four negative probes reject mutation and body/environment access. Full gate and
constant-input behavior comparison are recorded in the ledger.

R15b Schema moves twenty-nine methods, Schema metadata and its exhaustive
operation table to `schema.ts`. A seventeen-member context exposes the needed
checking operations, syntax queries and read-only facts, infos and targets;
the body environment, lowerer and writable body tables stay private. Recursion
guards, defaults, presence, make-input metadata, directional effects and report
order retain their behavior. Normalized AST comparison matches all twenty-nine
moved bodies and all four metadata initializers, including the handler table.
Four negative probes reject mutation and body-table access. The full gate,
focused tests and constant-input comparison are recorded in the ledger.

This completes every unit of the accepted R13/R15b batch. All named builtin
families now have an owner module, the common context remains ten operations,
and the independent validator imports no checker policy. Existing source syntax,
public core exports and canonical IR are unchanged. Other rederive items and
manual release acceptance remain separate work.

Across the remaining R15b family moves, normalized AST comparison matches all
ninety-two moved method bodies and six metadata initializers against the
post-R13 source baseline (`42c7830`). Receiver and helper-call substitutions,
read-view projections and formatter-only blocks/parentheses are normalized;
no existing local binding can capture the new context receiver. This evidence
supplements the full gates and constant-input behavior captures.

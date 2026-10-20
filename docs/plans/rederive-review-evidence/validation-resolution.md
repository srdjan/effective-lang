# Resolution of the plan validation, round 1

The validator was codex astra (`gpt-6-astra`) in a read-only sandbox, on 2026-10-20. Its report is `validation-astra-round1.md`. A Fable validation run failed at once: the account had no Fable usage credits (HTTP 429). Each row gives the finding, the decision, and the change in the plan.

| Finding | Severity | Decision | Change in the plan |
| --- | --- | --- | --- |
| V1 boundary test conflicts with capture hooks | blocker | accepted; confirmed: `HOOK_PATHS` are `src/core/capture_hook.ts` and `src/core/validate/capture_hook.ts` | P0-3 and A3 scan tracked sources and skip `HOOK_PATHS` |
| V2 Program hook target does not exist | major | accepted; confirmed: `Program.update` returns `Result<Revision, ConfigError>` (`db.ts:317`), and `Revision.diagnostics` is at `db.ts:179` | P0-1 steps 2 to 4 name the targets, payloads, frequency, and error cases; steps 6 and 8 add self-exclusion and a subprocess test |
| V3 test inventory incomplete | major | accepted | the full unhit list is now `checker-unhit-report-sites.txt` (72 sites); P0-4 and P0-5 give the row format; P0-7 adds the purity mutation |
| V4 fixture extension conflicts with the re-bless ban | major | accepted | P0-7 keeps the new mutations in memory; the generator and committed fixtures do not change |
| V5 equivalence test has no access method | major | accepted | P0-8 first extracts `exprChildren` with no other change, keeps a reflective oracle in the test, and adds synthetic nodes for unreached kinds |
| V6 wrong lowering input and deferred selection | major | accepted | P0-9 classifies the 13 sites first; lowering tests use a forged `CheckedProject`; emitter tests use forged IR; `no-interface` and both conversions are added |
| V7 refactors before their tests | major | accepted | new P0-10 lists the prerequisite tests for R6, R11, R12, and R18; each R item names its prerequisite |
| V8 Phase 1 cannot meet the equality gate | major | accepted | the gate allows exactly the reviewed differences of each defect; the capture base for Phases 2 to 4 is the last Phase 1 commit |
| V9 R14 and R15 scheduled twice | major | accepted | R14 runs once in Phase 1; R15 has substeps R15a and R15b; Phase 4 order is R17, R15a, R15b |
| V10 malformed op handling in R11 | major | accepted | R11 has a validator guard rule and a forged unknown-op test (P0-10) |
| V11 D1 evidence and regression contract | major | accepted; the SchemaError case was run in addition: 8 `TS2322` and `TS2345` errors | `repro/d1-*` holds inputs, command, and outputs; D1 tests both reserved errors on both sides, with forged IR for the validator, and keeps `codec` over `void` valid |
| V12 export traversal misses `makeInput` | major | accepted; confirmed at `emit/decls.ts:79` and `emit/types.ts:234` | R2 and D2 include `makeInput`; Phase 1 tests each newly traversed child |
| V13 D3 boundary contract undefined | major | accepted | D3 option (a) gives the bound (1536), first rejected depth (1537), code (`validation/002`), message, and one report per declaration |
| V14 projected totals not additive | major | accepted | the plan gives no projected total; a measured ledger replaces the sums; overlaps are named in R7 and R8 |
| V15 size targets overstate | major | accepted | the headline targets name the six weak functions and `check_expr.ts` own-body lines, marked as design targets |
| V16 R7 clone descriptions | minor | accepted | 45 blocks with two result modes (34 and 11); 10 handlers in 3 families plus 2 wrappers |
| V17 broad terms | minor | accepted | R2 separates 14 silent fallbacks, 2 runtime failures, and 1 non-exhaustive switch; R9 says that `behavior:capture` has no IR records and that `validate_test.ts:2202` pins 4 modules; section 2 says "functions" |
| V18 R9 leaves 13 groups unassigned | minor | accepted | R9 converts the 5 concurrency groups and keeps the other 8 fact-field groups |
| V19 timing conditions | minor | accepted | T5 and the headline say "under coverage"; the threshold applies in isolation and under coverage |
| V20 ranking and dispositions | major | accepted | section 3.1 is "mixed risk" with R3 and R5 named; R18 separates counted and uncounted deltas; VAL-8 is deferred with its constraint; A1 to A6 have phases |

No finding was rejected.

## Round 2

Astra checked the revision on 2026-10-20 (`validation-astra-round2.md`). It gave 15 findings as resolved, 4 as partial, and 1 new major problem. The author fixed all five. Astra did not run a third round.

| Finding | Decision | Change in the plan |
| --- | --- | --- |
| V1 partial: the capture tree has no `.git` | accepted | P0-3 and A3 walk `src/core` with `Deno.readDir` |
| V3 partial: Schema families take no stream | accepted | P0-7 gives stream families three mutations and Schema families two mutations (non-schema argument, wrong callback failure) |
| V7 partial: no lasting lexer oracle | accepted | P0-10 and A2 commit a hash snapshot of the current lexer output over a fixed-seed corpus, made at the base revision |
| V12 partial: CloseableScope has no child | accepted; confirmed at `ir.ts:55` | D2 and Phase 1 drop the CloseableScope test; namedIn lists the kind only for exhaustiveness |
| New: P0-0 moves two scripts to one path | accepted | P0-0, A1, and section 2 name `scripts/measure.ts` and `scripts/measure_functions.ts` |

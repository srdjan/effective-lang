The plan is **not ready for Phase 0 acceptance**. Its baseline is sound, but Phase 0 contains conflicting instructions and incomplete test specifications.

I checked more than 12 load-bearing claims. Confirmed counts include 103 duplicated prelude names, 71 shadowable names, and 102 builtin cases excluding `None`. I also confirmed 100 child labels, 30 evaluated-child labels, three depth guards, five omitted Type kinds, and four lowering imports. The recount confirms 9,617 branches overall and 4,757 across the four named stage files.

No files changed. Measurement scripts used `--no-lock`. I did not repeat the full coverage run or the reported timing experiments.

1. **V1 — blocker — P0-1, P0-3, A3: the boundary test conflicts with capture instrumentation.**

   The proposed test rejects Deno calls anywhere in `src/core`. Capture inserts files there that call `Deno.writeTextFileSync`.

   Evidence: [behavior_capture.ts:38](/Users/srdjans/Code/effektive-lang/scripts/behavior_capture.ts:38), hook paths at line 69, and instrumented test execution at line 145.

   **Recommended fix:** run the boundary test against uninstrumented sources. Define a narrow capture-only exclusion or inspect tracked source files. Preserve the production invariant.

2. **V2 — major — P0-1: the Program hook target does not exist as described.**

   `Program` has no method that returns revision diagnostics. `Program.update` returns a `Result<Revision, ConfigError>`. The diagnostics getter belongs to `Revision`.

   Evidence: [db.ts:179](/Users/srdjans/Code/effektive-lang/src/core/db.ts:179) and [db.ts:317](/Users/srdjans/Code/effektive-lang/src/core/db.ts:317). The scout explicitly left the target unread at `scout-TST.md:70`.

   **Recommended fix:** name the exact hook target, payload, and recording frequency. Specify handling for failed updates and cached revisions. Define serialization for successful and failed lower results.

   Also specify a bounded subprocess smoke test. A full-capture test must exclude itself from captured suites to prevent recursive execution.

3. **V3 — major — P0-4, P0-5, P0-7: the required test inventory is incomplete.**

   P0-5 refers to “other unhit report sites” in the checker report. That report contains only selected groups. The full list exists only in an unretained scratch file.

   Evidence: [scout-CHK.md:386](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-CHK.md:386). Validator gaps also include purity checks beyond the two proposed mutation forms: `scout-VAL.md:262`.

   **Recommended fix:** retain a site-to-test matrix. Include the builtin, valid setup, mutation, expected diagnostic, and required coverage hit. Distinguish fixed arities, overloaded forms, and non-callable `None`.

4. **V4 — major — P0-7: fixture extension conflicts with the prohibition on regeneration.**

   Adding generator mutations changes the expected disk fixtures. The existing equality test then fails until the corresponding files and manifest change. The plan prohibits `validate:update` without explaining this exception.

   Evidence: [validate_test.ts:2202](/Users/srdjans/Code/effektive-lang/tests/validate_test.ts:2202) and [validate_fixtures.ts:454](/Users/srdjans/Code/effektive-lang/scripts/validate_fixtures.ts:454).

   **Recommended fix:** permit reviewed additions while requiring existing fixture bytes to remain unchanged. Alternatively, keep the new mutations entirely in memory.

5. **V5 — major — P0-8, R5: the equivalence test lacks an access method and coverage target.**

   The typed child switch is inside a private method. The reflective walkers are also private. P0-8 precedes R5, which would extract the typed switch.

   Evidence: [validate/expr.ts:3027](/Users/srdjans/Code/effektive-lang/src/core/validate/expr.ts:3027). The retained probe reached only 48 of 100 kinds: `scout-VAL.md:93`.

   **Recommended fix:** specify temporary test instrumentation or an initial behavior-preserving extraction. Retain the independent reflective oracle. Inventory uncovered kinds and add synthetic cases where fixtures provide none.

6. **V6 — major — P0-9: the lowering test input is wrong, and its selection depends on deferred work.**

   `lowerModule` accepts a `CheckedProject`, not forged IR. The emitter accepts IR. P0-9 also tests unsupported sites “that stay,” but their classification remains deferred.

   Evidence: [lower.ts:1751](/Users/srdjans/Code/effektive-lang/src/core/lower.ts:1751), [emit/emit.ts:181](/Users/srdjans/Code/effektive-lang/src/core/emit/emit.ts:181), and `scout-ARC.md:303`.

   **Recommended fix:** classify the sites first. Specify forged checked-project inputs for lowering and forged IR for emission. Include the uncovered `no-interface` result and error-conversion paths.

7. **V7 — major — R6, R12, R18, A2: several refactors still precede their required tests.**

   Phase 0 does not cover `heightWithin`’s 32 uncovered lines and 17 branches. It also omits the stronger CLI sort test required by R18.

   R12 lacks scheduled exact-message checks for protocol narrowing. A2 requires a lexer differential test before the split, but Phase 3 does not explicitly schedule it.

   Evidence: `scout-TST.md:201`, `scout-FE.md:76`, `:92`, `:201`, and `scout-CHK.md:395`.

   **Recommended fix:** add explicit prerequisite edges and acceptance checks. Include the parser’s missing-comma case and checker builtin-type cases identified by the reports.

8. **V8 — major — D1–D3, P0-1: Phase 1 cannot satisfy the universal behavior-preservation gate.**

   Phase 1 deliberately changes diagnostics and emitted output. The phase gate nevertheless requires every baseline record to remain present.

   Evidence: [behavior_capture.ts:229](/Users/srdjans/Code/effektive-lang/scripts/behavior_capture.ts:229) treats missing records as failure.

   **Recommended fix:** define reviewed expected differences for each defect commit. Establish the refactor baseline after those fixes. Keep strict equality for subsequent behavior-preserving work.

9. **V9 — major — R14, R15: the phase schedule assigns work twice.**

   Phase 1 performs R14 after D1. Phase 4 includes R14 again, placing it on both sides of R11.

   R15 already includes the syntax-helper extraction. Phase 4 separately schedules that extraction before R15.

   **Recommended fix:** keep R14 once, immediately after D1. Require R11 to preserve its policies. Name R15’s extraction and family-move substeps explicitly.

   The other highlighted dependencies are sound: R1 precedes R7 and R15; R3 precedes R10.

10. **V10 — major — R11: the table proposal omits malformed-operation handling.**

    The validator currently reports an unknown Schema operation as a type diagnostic. An unchecked table lookup can instead throw and produce a serialization diagnostic.

    Evidence: [validate/expr.ts:2273](/Users/srdjans/Code/effektive-lang/src/core/validate/expr.ts:2273) and [validate/index.ts:49](/Users/srdjans/Code/effektive-lang/src/core/validate/index.ts:49). `scout-VAL.md:180` explicitly requires the runtime guard.

    **Recommended fix:** preserve membership validation before dispatch. Add a forged unknown-operation test that pins the diagnostic code, path, and message.

11. **V11 — major — D1, R14: the defect evidence and regression contract are incomplete.**

    The code supports the reserved-error diagnosis. However, the retained checker report calls it probable. No retained reproduction supports the exact four-`TS2551` claim.

    Evidence: `scout-CHK.md:301–318`; the plan supplies only an abbreviated `codec(...)` example.

    A checker rejection also cannot prove the independent validator fix. Normal lowering stops before producing that invalid codec IR.

    Evidence: [check_expr.ts:1594](/Users/srdjans/Code/effektive-lang/src/core/check_expr.ts:1594) and [validate/expr.ts:1701](/Users/srdjans/Code/effektive-lang/src/core/validate/expr.ts:1701).

    **Recommended fix:** retain the complete reproduction, target configuration, command, and output. Test both reserved errors independently in checker and validator tests. Preserve a valid `codec<void, void>` case: `schemaData` rejects `unit`, while codec’s current rule accepts it.

    Searches found no existing reserved-error codec in `fixtures/` or `tests/`. Option (a) therefore has no identified regression against those cases.

12. **V12 — major — D2, R2: adding five kinds does not complete export traversal.**

    The existing Schema case omits `makeInput`. The emitted Schema type can expose that field through `"~type.make.in"`.

    Evidence: [emit/decls.ts:79](/Users/srdjans/Code/effektive-lang/src/core/emit/decls.ts:79) and [emit/types.ts:234](/Users/srdjans/Code/effektive-lang/src/core/emit/types.ts:234).

    **Recommended fix:** traverse `makeInput` when present. Add an emitter regression with a private type reachable only through that field. Source-level reachability still needs a reproduction.

    Also test every newly traversed child, including Fiber failures and both Codec types. Exhaustive kind handling alone does not verify field handling.

    Option (a) changes none of the six committed golden files. Their input programs do not exercise these missing kinds.

13. **V13 — major — D3, R4: the chosen option does not define an executable boundary contract.**

    The three silent guards are confirmed. The plan does not select the maximum depth, first rejected depth, diagnostic code, path, or duplicate-report policy.

    Evidence: [validate/world.ts:165](/Users/srdjans/Code/effektive-lang/src/core/validate/world.ts:165), line 332, and line 738.

    **Recommended fix:** specify those values and behaviors. Test below, at, and beyond the boundary for identities, duplicate fields, and recursion. Keep the latter two defect effects marked probable until reproduced.

14. **V14 — major — R1–R12, R18: the projected branch totals are not additive measurements.**

    One reconstruction of Phase 2 gives `102 + 199 + 31 + 22 + 34 = 388`. These terms mix labels and decisions. They omit new control flow and the complete height rewrite.

    Phase 3 also double-counts branches. R7 counts prologue removal and then counts clone removal containing those same prologues. R8 repeats this pattern with purity guards.

    Evidence: `scout-CHK.md:115–145`, `scout-VAL.md:143–158`, and `scout-EMT.md:50`.

    A reconstruction approaches 643 before overlap corrections. It does not establish a net reduction of 630. The headline reduction of 1,020 therefore has no valid derivation.

    **Recommended fix:** replace the totals with “needs measurement.” Retain a ledger of non-overlapping changes measured with one counter. Distinguish historical sketch measurements from projections for rewritten implementations.

15. **V15 — major — R11, R15: both headline size targets overstate the result.**

    The largest cyclomatic value cannot fall below 60 while unchanged functions remain at 121, 116, and 102.

    Evidence: `scout-VAL.md:25–29` and the confirmed function-counter output.

    The 3,100-line target concerns `check_expr.ts`, not necessarily the largest repository file. `validate/expr.ts` currently has 5,517 raw lines, without a specified equivalent split.

    Evidence: `scout-VAL.md:14` and `scout-ARC.md:231–270`.

    **Recommended fix:** scope both targets to named functions or files. Separate raw lines, measured LOC, and own-body lines. Mark the interface-size and resulting file-size projections as unmeasured design targets.

16. **V16 — minor — R7: the clone descriptions contain two factual errors.**

    The 45 arity blocks are not identical. Thirty-four use pure results; eleven add `EFFECT_ONLY`.

    The three listed stream families contain ten handlers: four terminals, two count operations, and four predicates. They do not contain eleven.

    Evidence: [scout-CHK.md:89](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-CHK.md:89) and line 124.

    **Recommended fix:** describe one control shape with two result modes. Correct the family count and recount the claimed line reduction.

17. **V17 — minor — R2, T1, R9: several claims use broader terms than the evidence supports.**

    Not all listed defaults silently swallow cases. `invoke` throws, and `namedIn` has no default at all.

    Evidence: [lower.ts:983](/Users/srdjans/Code/effektive-lang/src/core/lower.ts:983) and [emit/decls.ts:45](/Users/srdjans/Code/effektive-lang/src/core/emit/decls.ts:45).

    R9’s claim that no gate records IR is also false. The mutation-fixture equality test pins lowered IR for four example modules.

    Evidence: [validate_test.ts:2202](/Users/srdjans/Code/effektive-lang/tests/validate_test.ts:2202).

    **Recommended fix:** separate silent fallbacks, runtime failures, and non-exhaustive switches. Say that *behavior capture* lacks IR records. Describe the six high-complexity units as functions, since several use conditional chains rather than switches.

18. **V18 — minor — R9: the proposal leaves thirteen groups unassigned.**

    The counted 80 groups comprise 60 positional groups, 13 groups with fact fields, and seven logic groups. The proposal specifies only positional builders and retained logic groups.

    Evidence: [scout-EMT.md:58](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-EMT.md:58).

    **Recommended fix:** explicitly retain or convert the thirteen fact-field groups. State whether the five concurrency groups belong to this change.

19. **V19 — minor — T5, P0-2: the timing headline omits its measurement conditions.**

    Both tests ran below one second individually without coverage. The reported overruns occurred under coverage. The parser result is reported as one second, not a precise value above one second.

    Evidence: [scout-TST.md:140](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-TST.md:140).

    **Recommended fix:** label the headline “under coverage.” Define whether the acceptance threshold applies to isolated execution, suite execution, or both.

20. **V20 — major — R3, R5, R18, A1–A6: ranking and disposition are incomplete.**

    Phase 2 is labelled low risk, although R3 and R5 carry medium risks involving evaluation order and missed references. R18 also combines measured reductions with unmeasured cast removal.

    Evidence: `scout-EMT.md:52`, `scout-VAL.md:112–115`, and `scout-CHK.md:323–334`.

    The validator’s duplicate builtin-name parsing finding has no accepted, deferred, or rejected disposition. The evidence identifies malformed-payload behavior that must survive any rewrite.

    Evidence: [scout-VAL.md:226](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-VAL.md:226).

    **Recommended fix:** rank individual work units, mark Phase 2 as mixed risk, and assign every additional task a phase or disposition. Explicitly defer or reject omitted evidence findings. Schedule the measurement tool and lexer oracle before dependent work.

**Verdict:** Phase 0 is not ready for acceptance. The production proposals preserve validator independence and prohibit changes to `ir.ts` and language features. The immediate blockers concern the test process, missing execution details, and unsupported projections. The plan author owns the next action: resolve these findings and present a revised Phase 0 for user acceptance.
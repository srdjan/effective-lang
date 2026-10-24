**Phase 0 needs revision before acceptance.** I checked the source and retained evidence, and reran the read-only checker and depth probes. No files changed.

| Finding | Status | Reason |
|---|---|---|
| V1 | PARTIAL | `HOOK_PATHS` exclusion is correct; tracked-file enumeration remains undefined inside capture archives without `.git`. |
| V2 | RESOLVED | `Program.update`, `Revision.diagnostics`, payloads, recording frequency, failures, self-exclusion, and subprocess testing now match the APIs. |
| V3 | PARTIAL | All 72 unique entries identify report calls; P0-7 still assigns stream mutations to Schema families without stream operands. |
| V4 | RESOLVED | In-memory mutations preserve the generator and committed fixture equality. |
| V5 | RESOLVED | Extraction now precedes equivalence testing, with an independent reflective oracle and synthetic nodes for uncovered kinds. |
| V6 | RESOLVED | Classification precedes tests; lowering receives `CheckedProject`, emission receives IR, and missing failure paths are included. |
| V7 | PARTIAL | Prerequisites are scheduled, but the lexer differential test lacks a retained reference implementation or specified frozen baseline. |
| V8 | RESOLVED | Phase 1 allows reviewed defect differences; subsequent phases use the corrected baseline. |
| V9 | RESOLVED | R14 occurs once; R15 has distinct extraction and family-move steps. |
| V10 | RESOLVED | The membership guard and forged unknown-operation regression preserve the existing diagnostic. |
| V11 | RESOLVED | Retained reproductions support four and eight TypeScript errors; separate checker/validator regressions preserve valid `void` codecs. |
| V12 | PARTIAL | `makeInput` traversal is included, but the required CloseableScope child regression is impossible because CloseableScope has no child. |
| V13 | RESOLVED | Depths 1536/1537, `validation/002`, message, path behavior, and deduplication are defined; the constant and diagnostic code match source. |
| V14 | RESOLVED | Measured deltas replace unsupported additive totals; overlaps are explicit. |
| V15 | RESOLVED | Targets identify the six functions and `check_expr.ts` metric, with projections labelled unmeasured. |
| V16 | RESOLVED | The revised counts distinguish 34 pure blocks, 11 effect blocks, and ten stream handlers. |
| V17 | RESOLVED | Fallback classes and existing IR fixture coverage are distinguished correctly. |
| V18 | RESOLVED | R9 assigns all groups: 60 positional, five concurrency, eight other fact-field, and seven logic groups. |
| V19 | RESOLVED | Timing conditions and acceptance thresholds distinguish isolation from coverage. |
| V20 | RESOLVED | Risks, prerequisites, deferred work, and additional-task dispositions are explicit. |

The remaining Phase 0 gaps have concrete consequences:

- **V1:** Capture exports an archive before running tests ([behavior_capture.ts:128](/Users/srdjans/Code/effektive-lang/scripts/behavior_capture.ts:128)). P0-3 needs an archive-safe source inventory; `git ls-files` cannot supply one there.
- **V3:** P0-7 needs mutations for each family. Schema operations accept arguments such as messages and schemas, not streams ([validate/expr.ts:1756](/Users/srdjans/Code/effektive-lang/src/core/validate/expr.ts:1756)).
- **V7:** The referenced differential scripts existed only in scratch directories ([scout-FE.md:8](/Users/srdjans/Code/effektive-lang/docs/plans/rederive-review-evidence/scout-FE.md:8)). The plan must specify a persistent comparison oracle.

**NEW major problem:** P0-0 moves two measurement scripts into one destination ([plan:352](/Users/srdjans/Code/effektive-lang/docs/plans/2026-10-20-rederive-review.md:352)). Mandatory commands still invoke both original paths ([plan:43](/Users/srdjans/Code/effektive-lang/docs/plans/2026-10-20-rederive-review.md:43)). Following the move breaks those checks. Define the destination layout, preserve both outputs, and update the commands. The revision also introduces the impossible CloseableScope regression at [plan:389](/Users/srdjans/Code/effektive-lang/docs/plans/2026-10-20-rederive-review.md:389); its type is nullary ([ir.ts:55](/Users/srdjans/Code/effektive-lang/src/core/ir.ts:55)).

**Verdict:** The user should not accept Phase 0 as written. Most original findings are resolved, but a separate executor still needs missing test-oracle and inventory decisions. The measurement relocation also contradicts the required verification commands. The plan author owns the next action: correct these execution requirements and submit Phase 0 for acceptance again.
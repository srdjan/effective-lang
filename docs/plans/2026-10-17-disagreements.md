# Disagreement audit, 2026-10-17

Status: the user chose option (a) for the six decisions on 2026-10-17. All six
are done. D21 and D23 followed the plan `docs/plans/2026-10-17-d21-d23.md`. This
ledger lists each disagreement that the audit found between the code, the
tests, and the documents. Each item has a status: done (with its commit),
rejected (with a reason), or decision (it waits for the user).

Method: Opus read every document. Five read-only agents checked the claims of
one area each against the code, with probes. Opus reproduced each code defect
again with a probe before the fix. Each code fix has a regression test that
fails without the fix, except C11 and C12. Baseline: `deno task check` passed
with 871 fast tests and 26 slow tests. At the end it passed with 883 fast tests
and 28 slow tests.

## Code defects

| Id | Defect | Evidence | Confidence | Status |
| --- | --- | --- | --- | --- |
| C1 | A source local named `$p1` captures the pipeline binding | `y \|> add($p1)` emitted `add($p1, $p1)`; `p(1)` gave 2, not 11 | High | done, 7042b15 |
| C2 | A binding type on a module arrow is not checked | `const f: (x: int) => string = (x: int): int => x` gave no diagnostic | High | done, f0c93a7 |
| C3 | An error operand of `-`, `*`, or `/` causes a cascade | `const x: int = y - 1` also gave `type-mismatch/003`. The audit also named `%`, but `%` is not an operator of the language | High | done, 900b0ed |
| C4 | A pure job of `retry` or `provide` emits code that `deno check` rejects | `retry(() => 2, { times: 2 })` gave TS2322 | High | done, 4266474 |
| C5 | A source name can shadow a global that the emitted code uses | `const Number = "x"` with int `+` gives TS2339. `const undefined = 5` changes a unit result. `type ReadonlyArray` gives TS2315, and `type any` gives TS2457 | High | done, 8e64f9f (D20) |
| C6 | The nesting-limit recovery skips the rest of the file | 300 nested `(` hid the next two declarations and their error | High | done, c71d41a |
| C7 | The type comparison has a silent depth cap of 256 | Record types 300 levels deep, `int` to `number`, give a false `type-mismatch/003`. A chain of aliases can exceed any fixed cap | High | done, a6db2a3 (D21) |
| C8 | A second handler for an absent error gets `/002`, not `/003` | Probe and fixture | High | done, 4cade14 |
| C9 | `validateModule` throws on a malformed IR | A `null` declaration gave a TypeError | High | done, fa0757b |
| C10 | `playground:build <dir>` can delete a source directory | The guard refused only the root and its parents | High | done, 73e310a |
| C11 | Generated `.ts.map` files in `fixtures/` are not ignored | `git check-ignore` found no rule | High | done, 8d4614d |
| C12 | The message for `!x` says to write `0 - x` | Wrong advice for a boolean | High | done, 2ace490 |
| C13 | Every `deno` command warns that `exports` is missing | `name` and `version` in `deno.json`, commit dc0687b | High | done, 2aae498 and c3c0286 (D22) |
| C14 | The grammar test copies the prelude names by hand | A new prelude name passes unnoticed | High | done, 82e83fa |
| C15 | A string of 80 characters in a `match` arm is not a `deno fmt` fixed point | The ledger records the form. The README now says that user source can reach it | High | done for the first arm, a691b71 (D23). A later arm is N5 |

## Document corrections

All rows are done. The commits are 9d98fc4 (design), e2aab79 (README and
bench), 3d38a2a and 2d86114 (plans, ledger, and gaps), and ba3c788 (agent
guide and code comments). The STE checker passes on every changed document.

| Id | File | Disagreement |
| --- | --- | --- |
| X1 | design 2.2 | The hover example used source order and no name prefix. Go-to-definition from `users.ts` does not exist |
| X2 | design 2.4, 8 | The text still required a cancellation loop. The LSP plan section 3 deviates |
| X3 | design 4.5, README | Three documents named M1, M2, or M3 as the Phase B gate. Only M1 measures the D9 budget. A dependent module is rechecked when any reached module changes |
| X4 | design 4.6 | The text promised a cap on the diagnostic count. No such cap exists |
| X5 | design 5.4 | The text recommended source order. Commit 8da88fb chose sorted order |
| X6 | design 6.2, 6.3; plan 7 | Identities and effect sets are strings, not interned integers. `lineStarts` is computed on demand. No code uses the `Compile` type |
| X7 | design 6.4 | `provider` is also a sync point. A block syncs at `;`, not at a comma |
| X8 | design 3.2, 10 | The eight book targets are not goldens and not M5 inputs |
| X9 | README | Deno API scope, "pure" core, six lowering errors, validator limit, `hostAssertions`, `deno fmt` scope, stdout and exit codes, publish order, save with `writeOnSave` false, requests before the first revision, browser review date |
| X10 | README, bench | `--full` also changes warm-ups and edits. `ts.LanguageService` is not in the temporary workspace |
| X11 | Phase A plan | Validator imports, the base pipeline binding, `$p` names, `Effect.Effect<A>`, an empty `R` is left out, the lift of a pure job |
| X12 | rules ledger | Nesting counts, interface hash, hoisting list, union continuation, contract diagnostics, array literals |
| X13 | LSP plan | A private mode flip does not change the hash. 52 and 53 modules count different units |
| X14 | rejected.md | The A/B rule contradicted itself. Gaps for D14, module size, quick-scale time, and few M5 pairs were missing |
| X15 | AGENTS.md | It said there was no Git repository and named only `src/core/` |
| X16 | code comments | `deno_io.ts`, `editor.ts`, `mod.ts`, `syntax.ts` |

## Rejected findings

| Finding | Reason |
| --- | --- |
| The check key over-invalidates, because it holds every reached module | The checker reads the type graphs of all reached modules (`src/core/db.ts`), so the key must hold them. Design 4.5 now says so |
| The validator accepts a builtin hash of any length | No document promises a length check in the validator. The lowering makes the 12-digit form |
| The parser has no array literal | The spec grammar has none. The ledger now records the gap |

## New tasks found

| Id | Task | Status |
| --- | --- | --- |
| N1 | No CI exists, but D5 places `tsc` and the validator in CI | done, 81be512 (D24). The workflow has not run, because nothing is pushed |
| N2 | Decide whether the eight book targets become goldens | done, 731e76e (D25) |
| N3 | Long names and module paths break the `deno fmt` fixed point in six forms besides C15 | done, a691b71 (D23). Six forms of very long identifiers stay out of scope |
| N4 | `deno publish --dry-run` fails: the repository has no license file | open; publication is not part of this audit |
| N5 | A selector test longer than 80 columns in a match arm after the first is not a `deno fmt` fixed point. `deno fmt` joins the earlier links on the first line | decision: model it, or keep it as a known limit |

## Decisions of the user

The user chose option (a) for each decision on 2026-10-17. The design records
them as D20 to D25.

1. C5, global names. (a) Reject `undefined`, `Number`, `RangeError`, `ReadonlyArray`, `any`, `bigint`, `object`, and `symbol` as source names, as Q12 did for reserved words. Recommended. (b) Change the emitter: print `void 0`, `globalThis.Number`, and `readonly T[]`, and reject only `globalThis` and the type names.
2. C7, type depth. (a) Add a named diagnostic for a type deeper than the cap, as design 4.6 asks. Recommended. (b) Raise the cap and record the limit.
3. C13, `exports`. (a) Add `"exports": "./src/core/mod.ts"`, the documented public API. Recommended. (b) Remove `name` and `version`.
4. C15, `deno fmt` fixed point. (a) Teach the printer to break after `===` as `deno fmt` does. Recommended. (b) Keep it as a known limit.
5. N1, CI. Design D5 places `tsc` and the validator in CI, and none exists. The remote is on GitHub. (a) Add a workflow that runs `deno task check`. Recommended. (b) Remove CI from the design.
6. N2, book targets. (a) Accept the five examples and close design 3.2 item 3. Recommended: the book tabs use short tags and source order, and D7 and the sorted order make byte equality impossible. (b) Add the book targets as tests with a looser comparison.

Also open, owned by the user: the playground review after commits 7086d67, b4ae459, and 4d0fcae, and the two pending hand tests.

## Areas checked and found sound

| Area | Claims that hold |
| --- | --- |
| Front end | Hard and contextual keywords; the reserved word list; the grammar addendum; the A1 and A2 ledger rows except the nesting count; FNV-1a 64; typed token arrays; local suffixes; import rules |
| Front end | `printTree` is lossless: 40,000 random inputs gave no mismatch. The core has no Deno API, no async code, and no clock |
| Checker | Every item of plan section 7; the A3a and A3b rows except the interface hash; D13, Q5, Q10, Q11, Q14, Q15; the registry test; the README checker APIs |
| Lowering and emitter | The emission scheme; leaf and control forms; `catchTags`; `yield*` parentheses; declaration order; schema and type printers; builtin ids; the prelude import |
| Lowering and validator | The `log.ir.json` equality; the `ir.ts` copy, which differs only in its header; span table; source map; identity formats |
| Program and CLI | The check key; the differential test; the sort order; the `--tsc` configuration; the debounce |
| Server, client, playground | Protocol and lifecycle rules; client versions; colors, access rules, and layout of the playground |
| Measurements | M2 stages; the M6 floor formula; M5 cache busting; the edit script; M1, M3, and M4 mechanics; the D16 sample count |

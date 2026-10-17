# Disagreement audit, 2026-10-17

Status: in progress. This ledger lists each disagreement that the audit found
between the code, the tests, and the documents. Each item has a status: open,
done, rejected (with a reason), or decision (it waits for the user).

Method: Opus read every document. Five read-only agents checked the claims of
one area each against the code, with probes. Opus reproduced each code defect
again with a probe before the fix. Baseline: `deno task check` passed, 871 fast
tests and 26 slow tests.

## Code defects

| Id | Defect | Evidence | Confidence | Status |
| --- | --- | --- | --- | --- |
| C1 | A source local named `$p1` captures the pipeline binding | `y \|> add($p1)` emits `add($p1, $p1)`; `p(1)` gives 2, not 11; no diagnostic without `--validate` (`lower.ts:299`) | High | open |
| C2 | A binding type on an arrow is not checked | `const f: (x: int) => string = (x: int): int => x` gives no diagnostic (`check.ts:1179`) | High | open |
| C3 | An error-typed operand of `-`, `*`, `/`, `%` causes a cascade | `const x: int = y - 1` gives `unknown-name/001` and also `type-mismatch/003` (`check_expr.ts:1694`) | High | open |
| C4 | A pure job of `retry` or `provide` emits code that `deno check` rejects | `retry(() => 2, { times: 2 })` gives TS2322 (`emit/expr.ts:1335`) | High | open |
| C5 | A source name can shadow a global that the emitted code uses | `const Number = "x"` with int `+` gives TS2339; `const undefined = 5` changes a unit result; `type ReadonlyArray`, `type any` | High | decision |
| C6 | The nesting-limit recovery skips the rest of the file | 300 nested `(` then two declarations: only one declaration remains (`parse.ts:572`) | Medium | open |
| C7 | The type comparison has a silent depth cap of 256 | Record types 300 levels deep, `int` to `number`, give a false `type-mismatch/003` (`types.ts:150`) | High | open |
| C8 | A second handler for an absent tag gets `/002`, not `/003` | `catch { E(e) => 1, E(e2) => 2 }` on a block without `E` (`check_expr.ts:1963`) | High | open |
| C9 | `validateModule` throws on a malformed IR | `buildWorld` runs outside the guard (`validate/index.ts:32`); the ledger says such a fault gives `validation/008` | High | open |
| C10 | `playground:build <dir>` can delete a source directory | The guard refuses only the root and its parents (`playground/build.ts:84`) | High | open |
| C11 | Generated `.ts.map` files in `fixtures/` are not ignored by git | `.gitignore` lists `fixtures/**/*.ts` only | High | open |
| C12 | The message for `!x` says to write `0 - x` | Wrong advice for a boolean (`parse.ts:1183`) | High | open |
| C13 | Every `deno` command warns that `exports` is missing | `name` and `version` in `deno.json` (commit dc0687b) | High | decision |
| C14 | The grammar test copies the word lists by hand | A new prelude name passes unnoticed (`tests/vscode_client_test.ts:117`) | High | open |
| C15 | A string of 80 characters in a `match` arm is not a `deno fmt` fixed point | Probe; the ledger records the form, but user source can reach it | High | decision |

## Document corrections

| Id | File | Disagreement | Status |
| --- | --- | --- | --- |
| X1 | design 2.2 | Hover example uses source order and no name prefix; go-to-definition from `users.ts` does not exist | open |
| X2 | design 2.4, 8 | Still requires a cancellation loop and version discard; the LSP plan section 3 deviates | open |
| X3 | design 4.5, D4, D9, README | Three documents name M1, M2, or M3 as the Phase B gate; only M1 measures the D9 budget. A dependent module is rechecked when any reached module changes, not only a direct import | open |
| X4 | design 4.6 | Promises a cap on the diagnostic count; no such cap exists | open |
| X5 | design 5.4 | Recommends source order for explicit contracts; commit 8da88fb chose sorted order everywhere | open |
| X6 | design 6.2, 6.3; plan 7 | Identities and effect sets are strings, not interned integers; `line_starts` is computed on demand; no single-source `Compile` form exists | open |
| X7 | design 6.4 | Recovery sync points: `provider` is also a sync point; a block syncs at `;`, not at a comma | open |
| X8 | design 3.2, 10 | The eight book targets are not goldens and not M5 inputs; no note records this | open |
| X9 | README | Deno API scope, "pure" core, five lowering errors (six), validator "reports it", `hostAssertions`, `deno fmt` claim, stdout and exit codes, publish order, `writeOnSave` false, `null` before the first revision, browser review date | open |
| X10 | README, bench | `--full` also changes warm-ups and `editsPerKind`; `ts.LanguageService` is not in the temporary workspace | open |
| X11 | Phase A plan | validator imports, the base pipeline binding, `$p` names, `Effect.Effect<A>`, empty `R` is left out | open |
| X12 | rules ledger | nesting counts, interface hash row, hoisting list, union continuation in parentheses | open |
| X13 | LSP plan 5.11, 5.5 | A private mode flip does not change the hash; 52 and 53 modules count different units | open |
| X14 | rejected.md | A/B rule contradicts itself; gaps for D14 cost, module size, and quick-scale time are missing | open |
| X15 | AGENTS.md | Says there is no Git repository; names only `src/core/` | open |
| X16 | code comments | `deno_io.ts:2`, `editor.ts:2`, `syntax.ts:19` | open |

## New tasks found

| Id | Task | Status |
| --- | --- | --- |
| N1 | No CI configuration exists, but D5 and design 5.1 place `tsc` and the validator in CI | decision |
| N2 | Decide whether the eight book targets become goldens (design 3.2) | decision |

## Areas checked and found sound

See the final section, which the audit fills in at the end.

# Portable extensions worklog

## Objective and authority

Implement all three designs approved by the user after the portable application roadmap.
The [execution plan](2026-10-23-portable-extensions.md) records scope and verification. The earlier roadmap remains complete.

Baseline: `9498cb3` on local `main`. Both repositories started clean. The user prohibits pushes.

## Accepted direction update

The user requires the sibling website specification and examples to stay current. The main agent owns both updates.
The website includes paired source and TypeScript examples plus a runnable project for the new forms and import policy.

## Current work

Import rules and purity contracts are committed as `843b011`.
All four implementation units pass their acceptance checks. The main agent owns local delivery.
The source and website use separate commits. The user owns publication.

## Evidence

The main agent observed both new playground highlighting tests fail before implementation. All sixteen highlighting cases now pass.

The purity worker observed four failures among seven initial contract tests before source edits. The failures identify missing pure-type syntax.

The main agent reviewed the import-rule implementation and reran forty-nine project, cache, and language-server cases. All passed.

The main agent reran thirty-three focused purity, import, and highlighting cases plus one strict emitted runtime case. All passed.

The first full gate passed format, lint, and type checks, then reported five fast-test failures. Existing display and mutation expectations needed updates.
The gate also required marked fixtures for each new diagnostic code. The new forbidden-import fixture passes all three focused checks.

The sealing explorer identified module-aware assignability, schema authority, and stale type-table flags as required enforcement paths.
Foreign arithmetic and recursive base widening must fail. Owner conversions and primitive comparisons remain legal.

The corrected full gate passed format, lint, type checking, 2,000 fast tests, and 198 slow tests.
The main agent committed the import and purity controls locally without pushing.

The function-execution mutation now changes an empty-row effect signature to pure. It still tests execution, without violating the new row rule first.

The sealing worker observed two initial failures before implementation: the parser rejected the modifier and construction could not resolve.
The sealing worker finished source, validator, editor, fixture, and runtime coverage. The main agent reran forty-nine focused extension cases and one strict runtime case. All passed.

The main agent audited every authority-neutral assignability call. The remaining calls classify comparisons or normalize schema metadata.
Source conversions use an explicit module argument. An open wrapper cannot bypass the arithmetic restriction on a foreign sealed base.

Codec construction derives schemas internally. The implementation must apply sealed authority to that path as well as explicit Schema constructors.
The validator retains its existing dependency boundary and implements its authority check independently.

The sibling site first passed eleven tests and fifty-two illustrative TypeScript units under strict checking.
After the example update, all fifty-four illustrative units pass, with no missing TypeScript panel.

An additional public API probe composes a recursive pure function, a function-type alias, and a higher-order call.
Checking, lowering, and independent validation all accept that composition.

The user-prioritized website example builds as two modules with zero diagnostics under `--validate --tsc`. All three runtime cases pass.
The main agent also checked all four existing website application projects; each reports zero diagnostics.

Both new Effektive panels pass checking, lowering, and independent validation. Three mutations of the runnable example reject foreign construction, an effect callback, and a forbidden import.

The first sealing full gate found one outdated category whitelist. The main agent added the new sealed category; all five diagnostic tests now pass.
The main agent then restarted the full gate. No production behavior changed for this expectation fix.

The simplification review found repeated playground scans on incomplete pure types. The main agent replaced them with one parenthesis scan.
For 8,000 incomplete prefixes, the measured median changed from 32.514 ms to 0.975 ms. Each run used seven samples after warmup.
The validator now reuses its own `typeChildren` traversal. Forty-seven affected checks passed after these changes.

The code review found a nested keyword completion and two identity validation defects. The main agent reproduced and fixed all three.
Imported declarations cannot claim the consumer's identity. Project validation binds the IR module name to its lowered map key.
Three identity regressions and 154 affected validator cases passed. A nested Schema forgery also receives a validator regression case.

The full review receipt is complete: `/tmp/compound-engineering-501/ce-code-review/20261023-192809-92f50bb9/review.json`.
The receipt reports zero actionable findings after fixes. Native Sol reviewers performed the review; no external model received code.

After that review, the main agent confirmed one additional source bypass through `schemaTransform`.
A foreign source Schema can pass a sealed value into an effectful callback while the final decoded type stays unsealed.
That callback can store the sealed value in a Ref. Both source checking and independent validation accepted the probe before the fix.
The corrected regression exposes only one owner-created value, without an arbitrary constructor function.
The checker and validator now inspect callback inputs for transforms and both optional bridges.
The main agent reran nineteen affected cases; all passed. A narrow independent Sol review found no leakage or false positive.

## Final verification

The final `deno task check` passes formatting, linting, type checking, 2,030 fast tests, and 199 slow tests.
The main agent reran the website example build after the callback fix: two modules, zero diagnostics.

The website passes eleven tests, fifty-four strict TypeScript units, and three compiled runtime checks for the new example.
The linked public IR model passes `deno check`. The website script passes `node --check`.

## Limits and dispositions

Generated TypeScript and host implementations remain trusted. The validator treats declaration metadata as foundational and does not compare producer payloads.
The import identity and lowered-name checks reject the two confirmed identity forgeries within that contract.

The TextMate fallback remains conservative for multiline function types. Parsed multiline types receive correct LSP semantic tokens.
The review rejected an IR version bump because the accepted contract extends optional version 3 metadata.

Three small test additions and broader traversal decomposition remain advisory suggestions. Existing coverage and simple branches support leaving those suggestions outside this batch.
The deep malformed-IR probe returns validation diagnostics; no stack error escapes the public validator.

## Next action

The user owns review and publication of the local commits.

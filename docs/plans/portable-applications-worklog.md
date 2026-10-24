# Portable applications worklog

## Objective and constraints

Complete the six phases of [the accepted plan](2026-10-23-portable-applications.md), with evidence for each phase.

Keep orchestration in Effektive. Use existing forms. Retain the language stopping rule and the package-interoperability deferral.

Work on local main, commit complete units after the full gate, and never push. Preserve concurrent edits.

## Accepted direction

Memory and file-backed SQLite share a textual KV contract. Source code owns publication decisions and adapter policy.

The host reports trim-based blankness. The pure source decision retains original text. Extension designs require user review before implementation.

## Current state

Initial revision: `5d0a2a9`. The initial working tree was clean. Deno reports version 2.9.8.

All six phases pass their acceptance checks. Full native review is complete. No language forms were added.

| Phase | Passing evidence |
| --- | --- |
| PP1: contracts and baseline | Seven source modules build with zero diagnostics; generated TypeScript passes strict checking. |
| PP2: memory publication | Fourteen workflow cases pass; negative compiler checks reject weakened contracts. |
| PP3: SQLite compatibility | Both platforms pass ten common cases; five SQLite cases cover parity, concurrency, persistence, and failures. |
| PP4: lifetime and capabilities | Six cases cover grants, revocation, interruption, cleanup, and combined failures. |
| PP5: gap dispositions | Ten compiler probes support existing composition, two language proposals, and one tooling proposal. |
| PP6: acceptance | The full repository gate and eleven website tests pass; the stopping rule remains unchanged. |

Current source syntax includes `nominal`. Earlier architecture analysis used the removed `Brand` and `unbrand` forms. Sealing probes must use current forms.

## Evidence and remaining work

The existing application harness supports temporary emitted projects. Existing integration tests use file-backed SQLite and narrow filesystem permissions.

The initial fast test failed because publisher.eff did not exist. The completed source now passes checking, lowering, and independent IR validation.

The primitive smoke took 0.66 seconds. The main agent reran the completed source check and negative contracts: two tests passed in 226 milliseconds.

The emitted memory/lifetime harness and scoped SQLite integration harness both passed in two seconds. The child SQLite process had no network permission.

The main agent reran ten architecture probes: ten passed in 80 milliseconds. These use current nominal syntax and the independent validator.

Review corrections include ordinary callable acquisition for every adapter dependency, pure assessment results, separate feature ports, Unicode validation, and bigint version sequences.

A new probe corrected the sealing report. An exported alias hides a private nominal constructor, but it does not prevent invariant-breaking record updates.

Named platforms use existing composition. Sealed predicates and reusable purity contracts remain unselected language proposals. Import policy remains an unselected tooling proposal.

The first full gate passed 1,974 fast tests and 197 slow tests in 135.56 seconds. Its first attempt found seven type-only import lint issues; those issues were corrected.

Full native Sol review completed with receipt `20261023-175732-a26c1449`. It confirmed malformed-ID classification and missing closed-write coverage. Both findings are fixed.

Malformed Unicode identifiers now return InvalidArticle before KV access and time sampling. Blankness still follows JavaScript trim semantics.

The shared contract now refuses reads and writes after close and verifies unchanged storage through a fresh lease. SQLite tests now prove stale-token refusal across two leases.

One imported generated publisher now runs on both platform layers. Its receipt and persisted data match, and malformed input remains InvalidArticle on both.

Post-review verification passed 45 runtime cases in 226 milliseconds and 12 compiler probes in 140 milliseconds. The source build reports seven modules and zero diagnostics.

The report's grant-import concern was rejected: the imported name describes a callback failure, not ambient authority. Unused source declarations were removed without changing behavior.

The sibling site passed eleven tests. The existing asset stamp task repaired versioned links that did not match its manifest. The site records the portability witness separately from the accepted gates.

The final full gate passed format, lint, type checking, 1,974 fast tests, and 197 slow tests. No compiler extension was added.

Real COMMIT-error and rollback/close failure classification remain outside the simulation evidence. No production test hooks were added.

Next action: the user owns review of the retained extension designs. Extension implementation requires a separate accepted scope.

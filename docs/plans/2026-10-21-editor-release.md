# Editor and release capabilities (ER)

Accepted plan based on `4235bd7`; execute after the correctness fixes.

| ID | Work | State |
| --- | --- | --- |
| ER1 | Revision-scoped resolver-identity occurrence index and protocol-neutral queries with unsaved overlays and parser recovery; no stale edits. | Complete |
| ER2 | References; prepare-rename and validated versioned edits; scoped completion without auto-imports; full semantic tokens and lexical fallback; validated missing `fails`/`uses` actions from checked effects. | Complete |
| ER3 | Self-contained VSIX with bundled server closure and client runtime; default bundled server and explicit checkout override; Deno 2.9.7 checks; standalone CLI bundle, local install instructions, reproducible commands and isolated offline empty-cache smoke test. Local artifacts only. | Complete |
| ER4 | Loopback HTTP and file-backed `node:sqlite` acceptance through service-workflow `.eff` orchestration and typed host boundary: persistence, invalid input/HTTP, permanent DB failure, rollback, cancellation and cleanup with explicit synchronization. | Complete |
| ER5 | Full M1/M3/M4 against 100 ms p90 diagnostics budget; multiple documents and 10,000 distinct edits with RSS, heap and type-table growth; installed VSIX behavior; playground at 375/720/1280 with keyboard/error recovery. Separate automated evidence from manual acceptance. | Automated complete; user manual acceptance pending |

Test cross-module identity, shadowing, unsaved/malformed text, UTF-16, rename
capture/conflicts and stale versions. Pure/protocol tests stay fast; subprocess,
integration and installation tests use `*_slow_test.ts`. Run `deno task check`
before each commit plus packaging/integration checks and final
`deno task bench --full m1 m3 m4`. Keep complete units reviewable on local
`main`, update owning docs and the sibling site separately for status changes.

Language extensions, external package imports, source formatting, cross-language
rename and R13/R15 remain outside scope. Publishing is excluded. Make no
bounded-memory, distributed-transaction, ambiguous-commit or exactly-once claim
without evidence.

## ER1 evidence

The revision-scoped index and pure editor queries are documented in
[editor queries](../editor.md). `tests/editor_queries_test.ts` covers imports,
service capabilities, separate local scopes, recoverable malformed text,
identity-preserving rename and shorthand expansion, capture/conflict/reserved
name rejection, host-origin rejection, contextual completion, UTF-16 spans,
semantic fallback and checked-effect contract actions. The checker and
independent validator remain separate and unchanged.

## ER2 evidence

Six protocol regressions in `tests/lsp_editor_test.ts` cover versioned edits,
unsaved overlays, UTF-16, malformed source, invalid configuration, stale disk
and stale document versions, contextual completion, semantic tokens and
missing-effect actions. Existing hover, definition, save and lifecycle tests
still pass. The installed VSIX harness also exercised all new providers,
applied rename and both effect quick fixes, and recovered diagnostics.

## ER3 evidence

[Local installation](../installation.md) documents the complete CLI/server bundles,
locked client runtime closure, deterministic VSIX archive, exact Deno version
checks, and development override. `tests/installation_slow_test.ts` builds twice,
compares archive bytes, starts the unpacked server outside the checkout offline
with an empty cache, and installs and runs the CLI. The separate installed VS Code
harness passes all providers, generated output, save, recovery and restart.

## ER4 evidence

[Integration acceptance](../integration.md) records seven real loopback HTTP and
file-backed SQLite cases through unchanged `.eff` orchestration and typed host
boundaries. The slow wrapper independently validates and strictly checks emitted
TypeScript before runtime tests. Cancellation waits for request receipt or a
post-insert gate; reopened database connections verify commit and rollback.
Existing deterministic tests retain retry and cleanup-defect coverage.

## ER5 evidence

The installed VSIX rerun passed all new providers, generated output, save, error
recovery and a fresh-process restart; [artifact hashes and phase results](../release-assets/installed-vscode-review.json)
record the final byte-identical local package. The [playground review](../playground-review-2026-10-21.md)
passed on frozen release source at 375, 720 and 1280 pixels with keyboard
navigation and type/syntax error recovery. User manual acceptance remains pending.

M4 now rotates distinct edits across three simultaneously open documents and
records every step's RSS, heap and type-table size for two fresh sessions at
200, 500, 1,000 and 10,000 edits. It does not accumulate source comments or claim
that step-end samples measure within-step peaks. Focused regressions preserve
M1/M3 behavior and validate distinct revisions and numeric memory metrics.

The [full release measurements](../release-measurements.md) meet the unchanged
100 ms large-input p90 diagnostics budget and retain raw M1/M3/M4 evidence.
Both sessions completed 10,000 distinct edits across three open documents.
Measured growth establishes no memory bound.

Final verification: `deno task check` passed formatting, lint, type checking,
1,786 fast tests and 174 slow tests with zero failures. That gate includes the
portable installation smoke and the real integration wrapper. The separate
installed VSIX rerun, browser review and full benchmark also passed. Local
artifacts are in `dist/`; publishing remains outside scope.

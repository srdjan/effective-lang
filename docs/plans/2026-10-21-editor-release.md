# Editor and release capabilities (ER)

Accepted plan based on `4235bd7`; execute after the correctness fixes.

| ID | Work | State |
| --- | --- | --- |
| ER1 | Revision-scoped resolver-identity occurrence index and protocol-neutral queries with unsaved overlays and parser recovery; no stale edits. | Pending |
| ER2 | References; prepare-rename and validated versioned edits; scoped completion without auto-imports; full semantic tokens and lexical fallback; validated missing `fails`/`uses` actions from checked effects. | Pending |
| ER3 | Self-contained VSIX with bundled server closure and client runtime; default bundled server and explicit checkout override; Deno 2.9.7 checks; standalone CLI bundle, local install instructions, reproducible commands and isolated offline empty-cache smoke test. Local artifacts only. | Pending |
| ER4 | Loopback HTTP and file-backed `node:sqlite` acceptance through service-workflow `.eff` orchestration and typed host boundary: persistence, invalid input/HTTP, permanent DB failure, rollback, cancellation and cleanup with explicit synchronization. | Pending |
| ER5 | Full M1/M3/M4 against 100 ms p90 diagnostics budget; multiple documents and 10,000 distinct edits with RSS, heap and type-table growth; installed VSIX behavior; playground at 375/720/1280 with keyboard/error recovery. Separate automated evidence from manual acceptance. | Pending |

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

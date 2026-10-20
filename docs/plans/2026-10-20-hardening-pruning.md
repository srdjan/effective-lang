# Hardening and pruning list

Date: 2026-10-20. Base: `9adc5cd` plus the uncommitted disagreements work. Status: proposed. No item has started.

This list is the cleanup step before more features. Its goal is a smaller design with the same functionality. It is a sibling of `2026-10-20-rederive-review.md`, not a replacement. That plan keeps its open items R7, R8, R11, R12, R13, R15, R16, R17, and R18. This list refers to them by number and does not restate them. Section 9 of that plan ("What not to touch") also applies here.

Four read-only scouts collected the evidence on 2026-10-20: language surface, docs, tests and tooling, and remaining code. "M" marks a measured count from grep, wc, or git. "I" marks an inference from reading code. An item with "needs measurement" has no measured delta.

ID prefixes. This list uses new prefixes so that no ID collides with the D, C, N, or R labels of other ledgers:

- H: hardening (a defect or a probable defect).
- P: code pruning (same behavior, less code).
- S: language surface (changes what a source program can write).
- T: tests and tooling.
- W: docs and process.
- Q: a decision for the user.

## 0. Precondition

H0 (commit the open disagreements work). The working tree has 25 modified and 7 untracked files (M). They implement `docs/disagreements-2026-10-20.md` items C1 to C10 and N1 to N6. Run `deno task check` on them, and commit them as one unit before any item below starts. Every later item needs a clean base for `behavior:capture`.

## 1. Hardening (do first)

H1 (recursive module-graph walk). `linkModules` (`src/core/project.ts:499`) runs Tarjan's algorithm with one recursive call for each import edge (M, read). A long import chain can probably overflow the stack and crash the check (I). Confirm the overflow with a generated chain of a few thousand modules. Fix: use the iterative form that `check.ts:1330-1395` already uses, or the generic `modes.ts:19`. This also closes P3.

H2 (CLI has no top-level catch). `src/cli/main.ts:79` calls `main` without a `try` (M, read). The checker path has about 10 internal throws that `Program.update` does not convert (M, scout count: `types.ts`, `check.ts:1838`, `check_project.ts`, `source.ts`). On such a throw, the CLI ends with an uncaught error and exit code 1. Exit code 1 also means "diagnostics found", so a crash looks like a normal failed check (I). The LSP (`server.ts:351,402`) and the playground already catch. Fix: catch in `main`, print one internal-error line, and return a distinct exit code. Add one test with an `io` double that throws.

H3 (builtin identity without a collision check). `specialize` (`src/core/lower.ts:1008`) builds an id from 12 hex digits of a SHA-256 and reuses an existing entry without a type comparison (M, read). Two different types with the same 48-bit prefix would silently share one builtin instance. The probability is very low, but the guard is one comparison of `canonicalJson` on a hit. Report an internal error on a mismatch.

H4 (serializer set check keyed by field name). `findProblem` (`src/core/serialize.ts:48`) checks sorted sets only for the 4 names in `SET_KEYS` (M). A new or renamed IR set field is skipped without a report. Fix: derive the key list from a typed table checked against the IR types, or add a test that fails when an IR set field is missing from `SET_KEYS`. `ir.ts` does not change.

H5 (non-null assertions). `src/` has 37 `!` assertions (M): 10 in `check.ts`, 7 in `project.ts`, 6 in `check_expr.ts`, and 5 in `initialization.ts`. The 17 in the two Tarjan copies go with H1 and P3. Replace the others with a narrowing or an explicit `internal` throw that names the invariant. Delta: needs a check at each site.

H6 (id casts). `src/` has about 114 `as` casts (M, loose regex). 32 target `TypeId`, 12 `ErrorId`, and 8 `ValueId`. This overlaps R18 (the `isErrorId` guard). Add constructor functions in `ids.ts` for each id kind, and use them at the cast sites. The number of casts that go needs a check at each site.

H7 (unchecked probe code in docs). `docs/plans/` holds 57 probe and repro files in 11 `*-probes` directories plus `rederive-review-evidence/repro/` (M). `deno task check` does not format, lint, type-check, or run them, because `docs/` is excluded (M). They can rot without a signal (I). This item is solved by W5: archive them, or delete them.

## 2. Code pruning (same behavior)

These items reduce code without a change to the language. Each one keeps `behavior:capture` equal to its base.

P1 (one project driver). `checkAnalysis` (`check_project.ts:441`) repeats `Program.check` (`db.ts:348`) without the memo (M, read; the `db.ts` comment says so). R16 proposes a shared `checkModuleStep`. A smaller option: make the batch path a one-shot `new Program(root).update(...)` and delete the second driver (I). Decide between them in R16. Also delete `checkDeclarations` and its `ModuleCheck` and `ProjectCheck` types (`interface.ts:315-387`), which only `tests/check_test.ts` uses (M). Port that test to the public driver in the same commit.

P2 (one sync loop for CLI and LSP). `Session.sync` (`cli/session.ts:44-67`) and `ProjectSet.flush` (`lsp/projects.ts:377-408`) do the same diff of wanted and known files, then call `program.update` (I, read). The playground (`playground/src/compile.ts:133-150`) has a third, simpler copy. Extract one pure function that returns the `set` and `remove` lists. Delta: needs measurement.

P3 (one strongly connected components function). Three Tarjan copies exist: `modes.ts:19` (generic, iterative), `check.ts:1330-1395`, and `project.ts:499-556` (M). Keep the generic one, and use it at the other two sites. Prerequisite: H1 test.

P4 (one host-adapter layer). The LSP imports `readWorkspace`, `isSourcePath`, `CliFs`, `writeGenerated`, and `denoFs` from `src/cli/` (M). These modules are a shared host layer under the wrong directory. Move them to `src/host/` (or similar), with no code change. Do this together with R17, before R15.

P5 (one identity parser). Identity strings are parsed in 4 places: `ids.ts`, `check.ts:1073 serviceOfCapability`, `emit/scope.ts:150` (a second `serviceOfCapability`), and `check_expr.ts:188 shortName` plus 2 inline slices (M). Move all of them into `ids.ts`. This closes the capability-parse part of R7 and part of R15a. Also merge the two `decodeString` copies (`check.ts:970`, `index.ts:355`).

P6 (one canonical JSON walk). `types.ts:276 canonicalJson` and `serialize.ts:74 print` sort keys the same way and drop `undefined` (M, read). `interface.ts:70 stripSpans` makes a third walk before hashing. Make `print` call one shared key-order walk. The hashes must stay byte-identical, so `behavior:capture` and the interface hash tests judge this item.

P7 (test-only production code). `typeAt` (`check_project.ts`) is used only by `editor_test.ts` and `check_body_test.ts`, and it duplicates `hoverAt` (M). Move the tests to `hoverAt`, and delete `typeAt`. Delete the dead exports `isReservedWord` (`lex.ts:149`), `tokenText` (`lex.ts:207`), and `Program.revisions` (`db.ts:294`), as R18 already lists.

P8 (exports wider than needed). About 85 exported symbols are used only in their own file (M, mostly types). Examples: `linkModules`, `resolveModule`, `PRELUDE_MODULE`, `PREC`, `groupDiagnostics`. Remove `export` from them. The public surface then shows the real seams. Do this after R17, because R17 changes which names `mod.ts` exports.

P9 (small module inlines). `cli/events.ts` (51 lines) into `deno_io.ts`, `emit/explicit_scope.ts` (51) into `emit.ts`, and `cli/watch.ts` (64) into `main.ts` each have one importer (M). Also merge the identical `read-error` and `config-error` arms at `watch.ts:33-38`. Low value: do it only if the files are touched anyway.

Open rederive items in order of value for this goal. R7 and R8 (repeated prologues and stream clones) remove the most code: the scouts counted about -400 lines on each side, before overlap (M, rederive review section 3.2). R11 (Schema handlers) and R15 (split `check_expr.ts`) remove the largest single functions. If Q1 selects option (b) or (c), do the S items first, because they delete some of the clones that R7 and R8 would otherwise refactor.

## 3. Language surface (needs decision Q1)

The prelude has 103 names (M, `resolve.ts:52-156`): stream 36, schema 21, schedule 8, collection 8, scope 7, effect 6, ref 4, codec 3, fiber 3, sink 2, layer 2, other 3. The three application witnesses (157 lines of `.eff`) use 17 of them (M): `fail`, `withResource`, `Some`, `None`, `retry`, `retrySchedule`, `schema`, `schemaDecode`, `provide`, `unfold`, `mapEffect`, `bufferStream`, `transduceStream`, `takeSink`, `sinkForEach`, `runStream`, and `fold`. About 50 builtins occur in no `.eff` fixture, only in inline test sources (M).

Each builtin with its own IR kind costs code in 6 places: the prelude row, a checker handler, a fact kind in `tables.ts`, a lowering entry, a validator method, and an emitter row or case (M). So each removed builtin removes code in about 6 files.

Hard rule: no name that the witnesses use is a candidate. The acceptance rule stops additions. It does not say anything about removals. A removal also changes the canonical spec in the sibling repository (`effective/public/effective-spec.html`).

Candidates where a general form already expresses the special form:

- S1 (pure stream predicates). `takeWhileStream`, `takeUntilStream`, `dropWhileStream`, and `filterStream` are the `*EffectStream` forms with a pure callback (I, read). Their 4 checker handlers are near copies (`check_expr.ts:4336-4544`, M). Lowering can choose the IR kind from the callback's effects, so no IR change is needed (I). Delta: about -230 checker lines and -230 validator lines (scout estimate, needs measurement).
- S2 (`mapStream`). It is `mapEffect` with a pure callback (I). The same lowering choice applies.
- S3 (stream runners). `collectStream`, `headStream`, `lastStream`, and `drainStream` look expressible as `foldStream` with an array, an `Option`, or unit (I). `scanStream` looks derivable from `mapAccumStream` (I). Each needs a compiled check of equal output, including chunk and early-stop behavior.
- S4 (three Schema default keys). `schemaDefaultKey`, `schemaDefaultNullKey`, and `schemaDefaultEncodedKey` already share one emitter case (`emit/expr.ts:1472-1546`, M). They could become one builtin with an `on: "missing" | "null" | "encoded"` option. `schemaOptionalFromRequired`, `schemaNullToMissingKey`, and `schemaOptionFromOptionalKey` look like fixed instances of `schemaOptionalTransform` (I).
- S5 (Codec). `codec`, `decode`, and `encode` duplicate the pure subset of Schema, with an `Option` result (I). They have 0 application uses and 1 emit fixture (M).
- S6 (RetrySchedule and Schedule). `RetrySchedule<E>` emits as a restricted `Schedule` (`emit/expr.ts:1237-1261`, M). One concept has two types and two authoring forms. `retry` and `retrySchedule` are witness names, so only the type unification is a candidate. This item is the largest and needs a separate design.
- S7 (manual scope operations). `makeScope`, `provideScope`, `addScopeFinalizer`, and `closeScope` have 0 fixture uses and 2 to 3 test files each (M). They were added under the Scope contract for a named use case, so a removal needs that reason checked first.

Not carried as candidates. `traverse` as `all(map(xs, f))` is not proven: `map` requires a pure callback, so the equivalence needs a compiled check. `partitionAll` and `validateAll` may differ from `allResults` in short-circuit and concurrency behavior (I).

## 4. Tests and tooling

T1 (slow-suite cost). `emit_slow_test.ts` takes about 111 s of about 150 s slow total (M, rederive baseline). It starts about 138 type-checking processes (M, scout count). Many tests run `deno check` on a file and then `deno run --check` on a script that imports the same file (I). Drop the first check where the second already checks. The speedup needs measurement.

T2 (many single-test slow files). About 25 slow files each hold one strict-target test, mostly the same boilerplate: check, lower, validate, `runStrictTarget` (M). Each pays a cold `deno check` against `npm:effect` (I). Merge them into one or two table-driven files with one shared temporary project. The three application slow tests differ by 17 to 21 lines (M): make one loop over the three fixtures (about -280 lines, M).

T3 (duplicated test helpers). `copyDirectory` exists 4 times, a `deno()` spawn wrapper 3 times, `withTemporary` and `runScript` 2 times each, and `exampleFiles` 2 times (M). Local `check` and `valid` helpers are redefined in 7 files (M). Move them into `tests/helpers.ts`.

T4 (two LSP protocol test files). `lsp_protocol_messages_test.ts` pins exact messages that `lsp_protocol_test.ts` checks as fragments (M, header comments). Merge them.

T5 (script without a task). `scripts/lex_snapshot.ts` writes the 335 KB `fixtures/lex/snapshot.json` and has no `deno.json` task (M). Add a `lex:update` task, so that the regenerate commands are all in one place.

T6 (stale local state). `.claude/worktrees/` holds 3 git worktrees, one locked (M). Ignored build output sits in `fixtures/applications/stream-processor/` and `fixtures/errors/declaration-primitive-position-host/` (M). These inflate every grep. The user removes them, because one worktree is locked and may be in use.

Keep off this list: `scripts/measure.ts` and `scripts/measure_functions.ts`. The rederive ledger rule uses them, although a scout proposed their removal. Also keep `sha256.ts`: the builtin identity is a documented contract, and Web Crypto is asynchronous while the core is synchronous.

## 5. Docs and process

`docs/` holds 121,330 words of Markdown (M). `docs/plans/` alone holds 47 plans and 85 support files (M). README.md has 10,809 words (M): about 22% feature reference, 31% API usage, 13% measurements, and 1% overview.

W1 (README). The Status section is a changelog in commit order, and line 49 alone is 467 words on Schema (M). Several paragraphs repeat rows of `phase-a-rules.md` (README 25, 27, 41, 99, 293, 299, M). Cut the README to the overview, the commands, a short layout, and pointers (target about 1,500 words, I). Move the feature reference to W2 and the API usage to `docs/api.md`.

W2 (one rules document). The 24 `*-contract.md` files are the only statement in this repository of their language rules (M: 0 hits in `phase-a-rules.md` or `transpiler-design.md`). Only 8 of them have a `## Source rule` heading (M). Merge `phase-a-rules.md`, the source-rule parts of the 24 contracts, and README feature lines 23-99 into one `docs/language-rules.md`. Each row links to its evidence. The canonical spec stays the authority.

W3 (one status document). The stopping rule is restated in 12 files (M). Put it, the gap audit "Remaining and deferred gaps" (`effect-4-gap-audit.md:268-332`), and the three application dispositions into one `docs/status.md`. AGENTS.md then links to that one file.

W4 (stale facts). Fix these now. Rederive review line 3 says Phases 2 to 4 wait for a decision, but R1 to R6, R9, R10, D5, and D6 are on main (M). Its line 100 describes the old `builtinCall` switch (M). Its ledger cites `6720381` and `6e6af2d`, which are on no branch; the main commits are `d330377` and `94bd86e` (M). README Layout lacks `emit/calls.ts`, `emit/shape.ts`, four scripts, and three fixture directories (M). Two solution docs have drifted line references (M).

W5 (archive). Move the finished plans, the contract bodies after W2, both disagreement ledgers, `raw-types-and-nominal-records.md`, and the probe directories to `docs/archive/`, unchanged. Delete `rederive-review-evidence/measure.ts` and `fns.ts`, which `scripts/` replaces (M). This also closes H7.

W6 (ID collisions). Two disagreement ledgers both use C1 to C11 for different defects, and D1 has three meanings across the design, the 10-20 disagreements, and the rederive review (M). From now on, give each ledger its own prefix, as this list does.

W7 (`.gitignore` and tracked plans). `docs/plans/` is gitignored, but 46 files under it are tracked (M). A new plan is ignored unless someone adds it with `git add -f`. Decide the rule in Q3.

## 6. Decisions for the user

Q1 (scope of language surface pruning).

- (a) Keep the surface. Do only code-side deduplication (R7, R8, R11).
- (b) Remove the special forms that a general form already expresses: S1, S2, and S4. Keep every witness name. This changes the canonical spec.
- (c) Option (b) plus S3, S5, and S7, after a compiled equivalence check for each.
- Recommendation: (b). It removes the clearest clones with the lowest risk. S3, S5, and S7 need evidence first, and S6 needs its own design.

Q2 (status of `ir.ts`). The rule says "copied from the sibling repository, do not change". But `ir.ts` has 45 commits in this repository and differs from the sibling copy in about 300 lines (M). So the rule is already false in practice.

- (a) Allow the deletion of IR kinds that Q1 makes unused, and update the sibling copy in the same change.
- (b) Keep unused IR kinds. The validator never sees them.
- Recommendation: (b) for now. Revisit after Q1, when the list of unused kinds is known.

Q3 (where plans live). `docs/plans/` is gitignored, but most plans are tracked with `git add -f`.

- (a) Remove the ignore rule. Ignore only the probe and evidence directories.
- (b) Keep the rule and the forced adds.
- Recommendation: (a). An ignored directory with tracked content hides new files.

Q4 (order).

- (a) H0, then H1 to H7, then W4 and W6, then P and T items, then the S items selected by Q1, then W1 to W3 and W5 last, after the code stops moving.
- (b) Docs first.
- Recommendation: (a). Hardening fixes defects. Docs written before the code moves would go stale again.

## 7. Verification for each item

The reviewing agent runs these checks after each commit. The implementer's claim is not evidence.

1. `deno task check` passes.
2. For H and P items, `deno task behavior:capture <base> HEAD` shows no missing record. For an H item, the only differences are the expected ones of that defect.
3. For P and S items, `deno task measure` and `deno task measure:functions` give the delta, recorded in `docs/plans/rederive-review-evidence/ledger.md`.
4. For T1 and T2, the slow-suite wall time before and after, on the same machine and day.

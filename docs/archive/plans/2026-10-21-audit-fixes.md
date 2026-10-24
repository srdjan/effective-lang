# Audit fix batch

Date: 2026-10-21. Base: `69c4b60`. Status: complete on 2026-10-22, including follow-ups through `1af80d7`. Accepted by the user on 2026-10-21 (decision 2 (a) of the completeness audit). The ID prefix is AU.

The completeness audit of 2026-10-21 ran four read-only lanes and one adversarial Fable pass. This plan fixes the seven confirmed defects that the user selected. "M" marks a fact measured or read in source. "I" marks an inference. The audit evidence and the probes are in the session scratchpad. Each item below repeats the probe that it needs, so the plan does not depend on that scratchpad.

Section 9 of `docs/plans/2026-10-20-rederive-review.md` ("What not to touch") applies, with the exceptions that each item names. In particular: do not share code between the checker and the validator, do not change `src/core/ir.ts`, and run scratch scripts with `--no-lock`. These items are behavior fixes, so a golden or mutation fixture may change. If an item changes `fixtures/golden/` or `fixtures/validate/`, stop and report the diff before you regenerate; no item below expects such a change (I).

Baseline (M): `deno task check` passes at `4235bd7`: fast suite 1726 of 1726, slow suite 152 of 152.

Order: AU1 with AU2, AU3, AU4, AU5, AU6, AU7, AU8. Each item is one commit, except AU1 and AU2, which land in one commit: AU1 alone makes a valid program fail until AU2 lands (M, Fable review). Run `deno task check` before each commit.

## AU1 (stable union member order)

Defect (M): `TypeTable.union()` (`src/core/types.ts:659-674`) sorts members by `TypeRef`, which is the intern index. The intern index depends on the order in which types were first created. `Program` (`src/core/db.ts:266`) keeps one `TypeTable` for all revisions, so an earlier revision changes the member order of a later union. The checker reads member order in `recordTarget` (`check_expr.ts:5873-5906`) and in diagnostic text. `toIr` (`types.ts:1034-1041`) already sorts members by `canonicalJson(toIr(m))`, so the IR, the emitted code, the source maps, and the interface hashes do not depend on history (M: 27 of 55,230 fuzz mutants differed between incremental and fresh results, all in diagnostic text only).

Witness (M), as a script through the public API (`src/core/mod.ts`): revision 1 is `type N = int\ntype Q = { k: N[], v: N }`. Revision 2 is the AU2 program `p11a` below. A fresh `Program` given only revision 2 reports `type-mismatch/003`; a `Program` given revision 1 and then revision 2 reports nothing. After AU1 alone, both must give the same result.

Fix: in `union()`, sort the members by the same canonical key that `toIr` uses. Memoize the key per `TypeRef` in a private `Map<TypeRef, string>` on the table, because a `TypeRef` never changes its node. Make sure that `toIr` handles every member kind that can reach `union()`; if a kind cannot lower to IR, give it a fixed key prefix and record the reason in a comment. Keep the "sorts by ref" doc comment correct.

`toIr` covers all 21 `TypeNode` kinds, and the error type leaves `union()` before the sort (M). The memo is sound, because the node list only grows (`types.ts:463-471`) and `toIr` of a named type uses only its id (M). Rewrite the doc comment of `union()` to name the canonical key.

Tests: add a fast test in `tests/` that builds the two-revision sequence above and compares the incremental diagnostics with a fresh build. Expected changes (M, Fable review on a patched copy): 6 fast tests change only in the order of union members in a message: `check_body_test.ts:4168`, `:4384`, `:4583`, `:5469`, `:5724`, and `schema_adapter_source_test.ts:327`. Update each one only after you confirm that the new text equals the `toIr` order. No golden, mutation, or error fixture changes (M). Any other change: stop and report.

Measure: run `deno task bench --quick` three times before and three times after. Record the median of the check time of each set in the commit body, and name the metric. If the median grows by more than 5%, stop and report.

## AU2 (record literal against a union: narrow by known field types)

Defect (M): with `type U = { k: S[], v: S } | { k: N[], v: N }` (N = int, S = string), `export const f = (x: N): U => ({ k: [], v: x })` gives `main.eff:4:44: error type-mismatch/003: the field v has type N, but S is expected`. The same program with the two members swapped (`p11b`) gives 0 diagnostics and passes `deno check`. `recordTarget` takes `discriminated[0] ?? fitting[0]`. Only literal field values discriminate. `docs/language-rules.md:46` says "Ambiguous candidates keep their existing order".

The validator does not choose a member. It checks the record against the target that the IR carries (`validate/expr.ts:1188-1195`, M). So the fix is in the checker only.

Fix: in `recordTarget`, when more than one candidate remains after the literal filter, narrow further by field values whose type is known without context. Collect them in `recordConstruction` next to `literals`: a field value (after parentheses) that is a `NameExpr` whose target (`this.targets.get(node)`, as at `check_expr.ts:818`) is a `local` that is not pending (type from `this.body.locals`), or a `value` or `provider` (type from `this.benv.values`). Treat a missing local entry or `this.table.error` as unknown, and skip that field. A shorthand field `{ v }` uses the same lookup through its label node. This lookup records no fact and reports nothing. Keep a candidate only when each known type is assignable to the candidate's field type. If the filter removes every candidate, fall back to the current choice, so the existing diagnostic appears. Do not check any field value twice.

Tests (M, Fable review): after AU1 alone, `p11a` and `p11b` both give 0 diagnostics, so they do not test AU2. Use this witness, in both member orders: `type A = string`, `type Z = int`, `type U = { k: Z[], v: Z } | { k: A[], v: A }`, `export const f = (x: Z): U => ({ k: [], v: x })`. It passes at the base and fails after AU1 alone; both orders must give 0 diagnostics after this commit. Add the shorthand form `({ k: [], v })` with a parameter `v`. Add a case where the known type fits no member; use a declared alias such as `type B = boolean`, because a bare `boolean` parameter adds `declaration/013`. Pin its diagnostic. A slow test or an existing emit test shows that the witness passes `deno check`.

Docs: replace the `language-rules.md:46` row text with the new rule: literal values select first, then the types of name references, then the canonical member order.

## AU3 (deep left chains crash the compiler)

Defect (M): `export const x: int = 1 + 1 + ... + 1` with 4000 `+` gives `effektive: internal error: Maximum call stack size exceeded` (exit 3). 5000 `|>` stages crash the same way. The first overflow is in `Resolver.expr` (`resolve.ts:1160`); later passes were not measured (I). 2000 terms pass. In the language server, the version gets no diagnostics.

Cause (M): `parseBinary` and `parseExprInner` (`parse.ts:1134-1164`) build left-deep `BinaryExpr` and `PipeExpr` chains in a loop that does not call `enter()`. `parsePostfix` builds `CallExpr` and field chains the same way, and `parsePostfixType` (`parse.ts:967-978`) builds `ArrayType` chains the same way (M, Fable review: `type T = int` with 5000 `[]` parses clean, then `Program.update` throws). The guard `MAX_NESTING = 512` (`parse.ts:69`) covers only recursive entry points. A parenthesized group costs two levels (M: 250 nested parentheses pass, 300 give `syntax/009`).

Emitter limit (M, Fable review): a 500-link binary chain passes parse, check, and lower, then throws `RangeError` in `emit/doc.ts` `makeHardCheck` on a cold run; 450 and 255 links pass. `emit/doc.ts` is in section 9, so the fix stays in the parser.

Fix: in each of the five loops, call `enter()` twice before each wrap, so a chain link costs two levels, the same as a parenthesized group. This caps a chain at 256 links. The longest chain in `fixtures/`, `tests/`, and `bench/` has 16 links (M). At the end of the loop, call `leave()` once for each successful `enter()`. When `enter()` fails, the existing `skipJunk` path reports `syntax/009` "nesting is too deep". Do not change `MAX_NESTING`.

Tests: one fast test generates, for each chain form (binary, pipeline, call, field, array type), a chain of 300 links and a chain of 250 links. Use `type I = int` for annotations; a bare `int` gives `declaration/013`. The long chain gives no throw from `Program.update`, and its diagnostics include `syntax/009`. Pin the exact measured list: for the binary form the Fable probe gave two `syntax/009` and one `syntax/008`, and for the others one of each (M, with one `enter()` per link; recheck with two). The short chain goes through check, lower, emit, source map, and `validateProject` with no throw, in a fresh process (cold). Add one combined case: 120 nested parentheses around a 120-link binary chain, which must also emit. If any pass throws, stop and report the pass and the depth. Keep each test under one second.

## AU4 (function-type alias on a module-level constant)

Defect (M): `type F = (x: Count) => Count fails Boom uses Svc.m` and `export const f: F = (x: Count): Count fails Boom uses Svc.m => Svc.m(x)` gives `type-mismatch/003: the value is a function, but F is expected`. A plain `type F = (x: int) => int` fails the same way. The inline function type passes. A block-local constant with the same alias builds and passes `--tsc`.

Cause (M): `check.ts:1644` and `check.ts:1739` test `binding.ir.kind === "function"`. For an alias, `binding.ir.kind` is `"named"`.

Fix: `check.ts` reads `binding.ir` at five sites: `:1644`, `:1650`, `:1739`, `:1749`, and `:1759` (M). At each, unfold the binding type with `this.table.unfold(binding.ref)`. When the unfolded node is a function, use it and its IR (`this.table.toIr(unfoldedRef)`). The block-local path already unfolds through `functionOf` (`check_expr.ts:690-701`); follow it. A brand of a function type stays rejected unless the block-local path accepts it. The emitted constant must type-check: compare the emitted text for the alias form and the inline form, and explain any difference.

Tests: a fast checker test for the plain alias and for the alias with `fails` and `uses`, and an arity mismatch through the alias. Pin its message, which becomes "the function takes N parameters, but F is expected" (`check.ts:1752`). A slow test that builds the alias form with `--tsc`.

## AU5 (directory walk follows link cycles)

Defect (M): `readWorkspace` (`src/host/workspace.ts:32-66`) follows every directory link (`deno_io.ts:56-59`) and keeps no visited set. Two link cycles made `check` run for minutes at 100% CPU. One upward link made `check` read 677 modules from sibling directories. The CLI session (`src/cli/session.ts:47`) and the language server (`src/lsp/projects.ts:349`) both use this walk.

Fix: keep a set of the real paths of the visited directories, through `CliFs.absolute`. Apply the check to every directory, because `DirectoryEntry` has no link flag. Skip a directory whose real path is already in the set. Skip a directory whose real path is not the real root and does not start with the real root plus `/`. `Deno.realPathSync` throws when a directory disappears and `absolute` returns no `Result` (M): catch that case in `denoFs.absolute` callers or change `absolute` to return a `Result`, and skip the directory.

Tests (M, Fable review): the memfs double in `tests/cli_helpers.ts` derives `list()` from flat keys and cannot express links, and its `absolute()` maps only `.` to `/mem`. Do not change it in a way that breaks `cli_test.ts:85`, which uses root `.`. Write a purpose-built fake `CliFs` for this test with a link table and a consistent `absolute()`: a link cycle, a link to the parent of the root, and a link to a directory inside the root. Only the files under the root appear, once each. Add one slow test with a real symlink cycle in a temporary directory.

## AU6 (build writes a module whose import was not written)

Defect (M): when module `b` has an error, `build` writes `a.ts`, which imports `./b.ts`, but does not write `b.ts`. In an import cycle between `c` and `d`, `build` reports the error on `c` only and writes `d.ts`, which imports the missing `c.ts`. `deno check` is skipped because the build has errors, so nothing reports the dangling import. `docs/api.md:269` documents that `build` writes "every module without an error".

Exception to section 9: `build.ts` is listed as tight. The reason to touch it: the current filter writes output that cannot load.

Fix: in `buildRevision`, extend the `passed` filter so that a module passes only when each `.eff` module that it imports, directly or transitively, also passes. Use `revision.project.graph` (`project.ts:255`, built at `:486-523`). It also holds host interface targets, so keep only edges whose target has mode `"eff"`. Compute the result with a depth-first search with a memo, or with a fixpoint, because a single forward pass is wrong inside an import cycle. The language server's save path (`features.ts:299`) has the same exposure; it is out of scope here. In `watch`, the last good `a.ts` stays on disk, which matches the stale rule of the language server.

Tests: a fast test of `buildRevision` with the in-memory host for both witnesses: no `a.ts` and no `d.ts` is written, and the diagnostics do not change. Update `docs/api.md:269` to state the new rule.

## AU7 (renamed modules leave outputs behind)

Defect (M): in `watch`, after `pay.eff` is renamed, `pay.ts` and `pay.ts.map` stay on disk. No code path removes outputs.

Fix (M, Fable review): `CliFs` (`src/host/io.ts:16-24`) has no remove method. Add `remove(path): Result<void, FileFailure>` to the port, to `denoFs` (`src/host/deno_io.ts`), and to the memfs double (`tests/cli_helpers.ts`). `watchLoop` (`src/cli/main.ts:43-66`) keeps the `effModuleNames()` of the last revision that loaded, across rounds, so that a round with a configuration error does not lose it. When a module of that list is absent from the new revision, delete its `<module>.ts` (path rule in `emit/scope.ts:276`) and `<module>.ts.map`. Delete a `.ts` file only when its first line is exactly the header that the emitter writes for that module (`emit.ts:144-146`: `// Generated from <name>.eff by the Effektive compiler. Do not edit.`). Delete the `.map` only together with its `.ts`. Report each deletion on stderr. `build` does not delete files; state this in `docs/api.md`.

Tests: a fast test of the watch loop with the in-memory host: rename a module; its old outputs are gone; a `.ts` file without the header at the same path stays; a configuration-error round between the two revisions does not prevent the deletion.

## AU8 (build tests for builtin pipeline stages)

Gap (M): website commit `3f0028a` stated that all, joinFiber, interruptFiber, retrySchedule, scoped, forkScoped, provideScope, addScopeFinalizer, and closeScope accept a pipeline stage. The checker accepts these nine stage forms; a probe over all prelude names with one to five arguments found "requires direct call syntax" for the other core 1 builtins only. No test or fixture uses `|> all`, `|> joinFiber`, `|> interruptFiber`, `|> scoped`, or `|> forkScoped` (M, grep over `tests/` and `fixtures/`). So no test shows that these stage forms lower, emit, and pass `deno check`.

Fix: add one slow test that builds, for each of the nine names, a small program that uses the name as a pipeline stage, with `--validate` and `--tsc` equivalents, and runs it where the program has an observable result. If a stage form fails to lower, emit, or type-check, stop and report it: the spec text then needs a correction, and that is a user decision.

## Closing

After AU7: run `deno task check` and `deno task bench --quick`. Add a line for this plan to the open items of `docs/status.md`, and add the prefix AU to the list in `AGENTS.md`. Then record each item's commit in a section "Progress" at the end of this file.

## Progress

Status on 2026-10-21. Three Sonnet lanes implemented the items in separate worktrees from `1150e1d`. The plan owner reviewed each diff and applied the commits to `main`. `deno task check` on `main` after the last commit: fast suite 1760 of 1760, slow suite 162 of 162 (M). The audit probes for AU1 to AU4 give the fixed results on `main` (M). `deno task bench --quick` completed; this plan records no number from it.

- AU1 with AU2: `d3a1633`. Exactly the 6 predicted message-order expectations changed. M2 check medians of three runs each, on a shared machine (noisy): large 74.4 ms before, 68.2 ms after.
- AU3: `30b175b`. A link costs two levels. Measured diagnostics of a 300-link chain: `syntax/009` and `syntax/008` for each form, plus `declaration/012` for the array type. A 250-link call or field chain has no valid type by construction, so it stops at a type error before emit. The through-all-passes array case uses 120 links, because `declaration/012` limits array types to 128 levels.
- AU4: `8a0abf2`. The alias form emits the same constant as the inline form, plus the unused alias declaration. Follow-up `ac9db59`: `8a0abf2` read inline function types through `toIr`, which changed the emitted order of inferred parameter unions (`x: B | A` became `x: A | B`, M) and could drop schema make inputs (I). Only an alias now goes through `toIr`; the probe output equals `1150e1d` again (M), and a fast test pins the source order.
- AU5: `f39d15b`. AU6: `b25405e`. AU7: `8873a3e`.
- AU8: `5520fc6`. Seven of the nine stage forms lower, emit, pass `deno check`, and run. `joinFiber` and `interruptFiber` as stages always fail: a borrowed fiber may only be joined or interrupted by a direct call (`type-mismatch/010`). Website commit `a724c20` removes them from the spec stage list.

Follow-up review on 2026-10-22:

- AU7 header concern retired: the current loader derives each module name from its root-relative source path (`moduleNameOf`), and configuration accepts only `host`, with no custom module roots. Lowering records that same source path. The removal header therefore agrees with the emitter for every supported `.eff` module.
- Fixed by SV1 and SV3/SV4 (`90ecd76`, `7fcf1d9`): the language server save path wrote a module whose import was not written (the AU6 defect).
- Pure function alias concern already fixed: `functionTypeDoc` wraps the result only for effect execution. `tests/function_alias_binding_slow_test.ts` checks pure alias bindings under strict TypeScript and runs them.
- Benchmark cleanup race fixed: harness directory prefixes include the creating process ID. Cleanup assertions still detect that process's leftovers while ignoring other runs. A regression creates both owned and foreign directories, verifies that the owned directory is detected, then removes it and verifies that the foreign directory is ignored.

Benchmark fix verification on 2026-10-22: the regression failed with the original shared prefix. The focused file then passed all eight tests, and two concurrent copies each passed all eight tests. The initial restricted run of `deno task check` passed formatting, lint, type checking, 1826 fast tests and 175 slow tests. Two slow tests could not pass there: HTTP/SQLite failed to open a loopback listener (`Operation not permitted`), and installation failed to fetch an npm tarball (`ENOTFOUND registry.npmjs.org`). A focused HTTP/SQLite rerun confirmed the listener restriction. After those restrictions were lifted, the full gate passed with Deno 2.9.7: formatting, lint, type checking, 1826 fast tests and all 177 slow tests, including HTTP/SQLite and installation.

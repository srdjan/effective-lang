# Transpilation on every save (SV)

Proposed plan based on `cd1b899`. It is not accepted. Decisions SV-D1 to SV-D4
are open. Codex astra validated the first draft. Section 7 records each finding
and its resolution.

## 1. Current state

The incremental compiler exists. `Program` in `src/core/db.ts` keeps a parse
memo, a check memo with an interface-hash cutoff, and a lowering memo for each
module (design D4, Phase A). A revision computes emitted text, span tables, and
source maps on demand, and reuses them for a module with an unchanged key.

Save already writes files. `didSave` in `src/lsp/features.ts` writes
`<module>.ts` and `<module>.ts.map` for the saved `.eff` module. The setting
`effective.writeOnSave` is true by default in the server and in the VS Code
extension. Section 2.1 of `docs/transpiler-design.md` already selects save as
the trigger for file output.

So this plan does not build a new compiler. It makes the save path correct and
complete, with the existing memoized `Program`.

## 2. Confirmed gaps

Gaps A, B, and D were reproduced with the in-process LSP harness of
`tests/lsp_helpers.ts` on `fixtures/examples`. Gap C is a code observation, and
no probe ran for it. The probe scripts are not in the repository. Unit SV4
turns each gap into a regression test.

**Gap A: the save path ignores the import-closure rule.** Commit `b25405e`
made `build` write a module only when each `.eff` module that it reaches is
also written. That fixpoint is in `src/cli/build.ts`, and `didSave` does not
use it. Probe: `users.eff` on disk has an error, and the user saves `main.eff`.
Result: the server writes `main.ts`, and `users.ts` does not exist. So
`main.ts` imports a file that is missing. The existing test "didSave writes the
saved module and its map only" asserts this state, because the fixture has no
`users.ts`.

**Gap B: dependents stay stale on disk.** Save writes only the saved module.
Probe: the user saves `main.eff`, and then changes `displayName` in
`users.eff` to a pure function and saves `users.eff`. The mode flip changes the
emitted call in `main.ts`. Result: `main.ts` on disk is unchanged and differs
from a fresh build. Four other edits did not change `main.ts`: a parameter
rename, a new record field, a new error field, and moved declarations. So the
gap occurs only when an import changes the emitted text of its importer.

**Gap C: the server never removes the outputs of a deleted module.**
`watchLoop` in `src/cli/main.ts` calls `removeStaleOutputs`. The language
server has no call to it.

**Gap D: save writes text that comes from unsaved documents.** `didSave` emits
from `project.lastGood`, which lays every open document over the disk text.
Probe: `users.eff` is open with the unsaved mode flip, and the user saves
`main.eff`. Result: `main.ts` agrees with the unsaved `users.eff` and differs
from a build of the disk sources. A later close without save leaves `main.ts`
wrong.

## 3. Design

### 3.1 Invariant

The invariant has two parts. Each part holds when every file read and write of
the round succeeds, and when no other process changes the sources during the
round.

Part 1 (current modules). After a save round, each generated file of a current
module equals the file that `effective build` would write from the disk
sources. A module that `build` would not write keeps its old files, as `build`
does.

Part 2 (deleted modules). A round removes the outputs of a module that was in
the disk project in an earlier round of the same server session and is not in
it now. This is the `watch` policy. `build` removes nothing, so Part 2 is not
build parity. A module deleted before the first round of a session keeps its
outputs.

Diagnostics in the editor still come from the open documents. The test oracle
for Part 1 is a fresh `Program` over the disk texts with the shared write rule.

### 3.2 The disk program

`ProjectState` gets three fields when `writeOnSave` is true. They are created
on the first save round, not at project discovery.

- `diskProgram`: a second `Program` that sees only disk texts.
- `diskInputs`: the texts that the last round gave to `diskProgram`, whether or
  not that update succeeded. `Program.update` keeps changed files after a
  configuration error, so the next diff must start from these texts.
- `diskModules`: the `.eff` module names of the last successful round, for
  Part 2.

One save round does these steps in order:

1. Read the full workspace from disk with `readWorkspace`, as `Session.sync`
   does. Replace `project.disk` with the result. This also refreshes open
   documents that changed on disk and paths that a rename removed. On a read
   error, log it and write nothing.
2. Diff the workspace against `diskInputs`, call `diskProgram.update`, and set
   `diskInputs` to the workspace.
3. On a configuration error, log it and write nothing. The disk configuration
   decides this, not the overlay configuration.
4. Remove the outputs of each name in `diskModules` that is not in the new
   revision, with `removeStaleOutputs`. Keep a name whose removal failed in
   `diskModules`, so that the next round tries again. Set `diskModules` to the
   new names plus the failed names.
5. Compute the writable set with the shared fixpoint from unit SV1. Remove each
   module whose source has a nearer project root than this project (section
   3.4).
6. Call `writeGenerated` for the writable set. It compares both files of each
   module with the disk text, so a deleted or partly written output is repaired
   on the next round.
7. Log each written path, removed path, and held module with its reason.

The overlay `Program` stays unchanged. It serves diagnostics, hover, and the
generated-TypeScript virtual document.

### 3.3 Triggers

A `didSave` of a `.eff` or `.effi` document starts a round. The VS Code client
sends `didSave` for both, because both belong to the `effective` language.

The client does not send `didSave` for `effective.json`. It sends a watched-file
event instead. So a watched-file event for the `effective.json` of a project
starts a round. Other watched-file events start no round, under SV-D2 (a).

`writeOnSave` comes from the initialization options. A change to the VS Code
setting takes effect after the extension restarts. SV6 documents this, and SV4
tests that the server keeps the value of its start.

The round runs synchronously in the handler, as the current write does. SV5
measures one round and a "Save All" sequence. Coalescing is added only if that
measurement misses the budget of SV-D3.

### 3.4 Output ownership

Two project roots can be nested. Then the outer project can also read a source
of the inner project, and both projects can write the same output path with
different headers. The codex probe showed this. Rule: a round writes and
removes only the outputs of modules whose source file has this project as its
nearest root. This is the same "longest root wins" rule that `lookup` in
`src/lsp/projects.ts` uses for documents.

A concurrent `effective watch` or `build` on the same project is outside the
invariant. Both writers use the same emitter and skip equal text, but their
writes can interleave from different source texts.

### 3.5 Why a second program

A single overlay program cannot satisfy Part 1. When an open importer has
unsaved edits, the disk text of that importer still needs new output after its
import changes (Gap B with Gap D). Only a program over the disk texts can emit
that output. The cost is a second set of memo entries and a second type table
for each project. SV5 measures that cost with M4. No memory bound is claimed.

### 3.6 Outside scope

Declaration-level incremental checking (design Phase B) stays outside scope.
That decision rests on M1, which measures diagnostics and not saves. SV5 gives
the first save measurement. `deno check` on save, IR validation on save,
go-to-definition from generated files, live reconfiguration of `writeOnSave`,
and changes to the CLI `watch` loop are also outside scope.

## 4. Work units

The decisions in section 6 come before SV2, because they fix the trigger, the
write scope, and the log level.

| ID | Work | Depends on |
| --- | --- | --- |
| SV1 | Move the writable-set fixpoint from `src/cli/build.ts` into `src/host/outputs.ts` as a pure function of a revision and an optional validation map. `buildRevision` calls it. No behavior change: `tests/build_imports_test.ts` passes unchanged. A new unit test covers a cycle and a host target. | None |
| SV2 | Fix `removeStaleOutputs`: remove the map before the `.ts` file, so that a failed map removal keeps the header that proves ownership. Add a test with an unremovable map. | None |
| SV3 | Add the disk program and the save round (section 3.2) to `src/lsp/projects.ts`, with the ownership rule (section 3.4). Tests over the in-memory file system compare each round with a fresh `Program` over the same disk texts. | SV1, SV2, decisions |
| SV4 | Call the round from `didSave` and from the `effective.json` watched-file event (section 3.3). Change the existing save tests so that each test sets the disk text before it sends `didSave`. Replace the test that asserts the dangling import. Add regression tests for gaps A to D. Add tests for: the first round, a no-change save, a `.effi` save, a configuration error and its recovery in both directions, a disk read error, a write failure, a partial write that the next save repairs, a deleted output that the next save repairs, an open document changed on disk, a rename, a close without save, nested roots, a failed map removal, and `writeOnSave` false (no disk program exists). | SV3 |
| SV5 | Measure. Add bench row M7 on the small, medium, and large presets: a cold first round, a repeated save with no change, a body edit save, an interface edit save, and a "Save All" of every module. Extend M4 with the disk program enabled. Record the results in `docs/measurements.md`. If M7 misses the SV-D3 budget, stop and bring a narrowing proposal that keeps the repair of step 6. | SV4 |
| SV6 | Update `docs/transpiler-design.md` section 2.1 (the per-save row), `docs/editor.md`, `docs/api.md`, `docs/installation.md` (the restart for `writeOnSave`), the `effective.writeOnSave` description in `editors/vscode/package.json`, and the README known limits. Add the term "disk program" to `CONCEPTS.md`. Update `docs/status.md` and, in a separate commit, the sibling site `../effective/public/` if the status changes. Run the installed VSIX check. | SV5 |

Each unit is one commit on local `main`. Run `deno task check` before each
commit. SV5 also runs `deno task bench --full m1 m4 m7`.

## 5. Risks

| Risk | Effect | Control |
| --- | --- | --- |
| The first save in a session writes every writable module, not only the saved one. | Files appear that the user did not build. | This is the `build` result, and Part 1 needs it. SV-D1 lets the user choose a narrower rule. |
| Each round reads the full workspace. | Save time grows with the project size. | SV5 measures it in M7. |
| A second program per project. | More memory in a long session. | SV5 measures it with M4. `writeOnSave` false creates no disk program. |
| A synchronous round blocks the message loop. | A late diagnostics publish after a save. | SV5 measures it with M7 against SV-D3. |
| A concurrent `effective watch` or `build`. | Interleaved writes from different source texts. | Outside the invariant (section 3.4). SV6 documents it. |
| A disk read sees a partial write from another tool. | One round emits from a broken text. | The broken module gets diagnostics and is held. The next round repairs the outputs. |

## 6. Decisions

**SV-D1. Which modules does a save round write?**
(a) Every writable module of the project, so that Part 1 equals `build`.
Recommended.
(b) The saved module, the modules that it reaches, and the modules that reach
it. Unrelated modules that were never built get no files.

**SV-D2. Which watched-file events start a round?**
(a) Only an event for `effective.json`, because the client sends no `didSave`
for it. The next save catches up with changes from `git checkout` or other
tools. Recommended, because the setting is named "write on save".
(b) Every event for a source file, as `effective watch` does.

**SV-D3. What is the budget for one save round?**
(a) 100 ms p90 for a body edit save on the large preset, measured by M7. This
reuses the value of the D9 diagnostics budget. Recommended.
(b) No budget. Record M7 only.

**SV-D4. Where does the server report held modules?**
(a) `window/logMessage` at type 3 (info), in the Effective output channel.
Recommended.
(b) A status bar item in the VS Code extension, in addition to (a).

## 7. Validation record

Codex astra (`gpt-6-astra`) reviewed the first draft. A Fable review could not
run, because the Fable rate limit was reached.

| Finding | Resolution |
| --- | --- |
| Refreshing only the saved path compiles stale text for other open documents and renamed paths. | Accepted. Step 1 reads the full workspace. |
| The client sends no `didSave` for `effective.json`, and `writeOnSave` changes need a restart. | Accepted. Section 3.3. |
| Nested roots let two projects write one output path. | Accepted. Section 3.4. |
| Removal contradicts build parity, the first round cannot see earlier deletions, and the removal order loses ownership evidence. | Accepted. Invariant Part 2, step 4, and SV2. |
| Skipping by emitted-object identity breaks the repair of deleted outputs. | Accepted. The skip is removed. Step 6 compares on every round. |
| A configuration error needs the attempted inputs, separate from success state. | Accepted. `diskInputs` and `diskModules` are separate. |
| More tests, doc owners, and save-specific measurements. | Accepted. SV4, SV5, and SV6. |
| Use a lazy disk `Program` in `ProjectState`, not a separate abstraction. | Accepted. Section 3.2. |

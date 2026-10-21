---
title: Hold the test set constant to read behavior:capture when a change also moves tests
date: 2026-10-20
category: workflow-issues
module: scripts/behavior_capture.ts
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - "A refactor commit also moves, deletes, merges, or rewrites tests"
  - "behavior:capture reports missing or new records after a change that should keep behavior"
  - "A change renames or removes a source form, so tests rewrite their own Effective sources"
tags: [behavior-capture, oracle, refactor, git-commit-tree, byte-identity, rederive]
---

# Hold the test set constant to read behavior:capture when a change also moves tests

## Context

`deno task behavior:capture <base> <head>` is the refactor oracle of this
project. It runs the fast and slow suites on both revisions and compares the
record sets as multisets (`scripts/behavior_capture.ts:300`, `:341-342`).
Each `check`, `program`, and `validate` record holds a hash of its input
(`scripts/behavior_capture.ts:13-17`, `:56`). That hash makes a clean program
visible, but it also ties every record to the test that produced it.

So a commit that moves or rewrites tests changes the record set even when no
source behavior changes. In this session, deleting `typeAt` and moving its
tests onto `hoverAt` gave "missing in HEAD: 2" (`check`) and "new: 3"
(`program`), because the same programs now ran through `Program.update` and
not through `checkAnalysis`. A missing record normally means a behavior
change, so the raw result is a false alarm that a reviewer cannot dismiss
without more evidence.

The same procedure was needed earlier, by the rederive Phase 2 coordinator,
which captured the Phase 2 source with the Phase 1 test set (session history;
see `docs/plans/2026-10-20-rederive-review.md` section 12).

## Guidance

Build a temporary commit object that holds the base source and the head tests.
Then capture it against the head. Both sides then run the same tests, so any
difference comes from the source. `main` does not move, and the working tree
does not change: the commands use a separate index file.

```bash
export GIT_INDEX_FILE=<scratch>/tmpindex
git read-tree <base>                       # base tree into the temporary index
git rm -r -q -f --cached tests             # -f: the index differs from HEAD and the work tree
git read-tree --prefix=tests/ HEAD:tests   # head tests over the base source
T=$(git write-tree)
C=$(git commit-tree "$T" -p <base> -m "temp: base src with HEAD tests")
unset GIT_INDEX_FILE
deno task behavior:capture "$C" HEAD
```

Read the result as follows. "new 0, missing 0" proves that the source change
keeps behavior for every program the head tests run. Any remaining difference
is a real source behavior change.

Two refinements:

- Without `-f`, `git rm --cached` refuses with "staged content different from
  both the file and the HEAD". Both sessions hit this.
- When a head test does not compile against the base source (it calls a
  function the change adds), patch that one file in the temporary index:
  `git hash-object -w <edited copy>`, then
  `git update-index --cacheinfo 100644,<blob>,tests/<file>`.

The method fails when the tests rewrite their own Effective sources, for
example when a builtin is renamed or removed. Then the base compiler rejects
the new sources, and the input hashes differ on both sides. For such a change,
use a byte-identity proof: extract the base compiler with
`git archive <base> src | tar -x -C <dir>`, compile each old source with it,
compile the rewritten source with the head compiler, and compare the emitted
TypeScript, the serialized IR, the interface hash, and the hover text. The S1,
S2, and S4 builtin removals were verified this way.

## Why This Matters

Without this step, a reviewer has two bad choices for a commit that moves tests.
The reviewer can accept unexplained missing records, and so hide a real
behavior change. Or the reviewer can reject a correct refactor. The capture
exists to judge refactors that agents implement, and claims from the
implementer are not evidence. A false alarm that only the implementer can
explain defeats that purpose.

## When to Apply

- Before you accept any refactor commit that deletes, moves, merges, or
  rewrites a test, when its capture against the base shows any difference.
- When an implementer reports "the differences come from the test changes".
  Run this check; do not accept the claim.
- Not needed when the capture already shows "new 0, missing 0", or when the
  only differences are new records from added tests and no record is missing.

## Examples

In this session, the batch after `e2832b4` (up to `af26d21`) deleted `typeAt` and
moved its tests to `hoverAt`. The direct capture
`behavior:capture e2832b4 HEAD` reported 2 missing `check` records and 3 new
`program` records. The capture of the temporary commit (base source `e2832b4`
plus the head tests) against HEAD reported "new 0, missing 0". That result
showed that the source changes of the batch kept behavior, and that the whole
difference came from the test move.

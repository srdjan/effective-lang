# Rejected ideas and evidence gaps

This file lists each idea that the project measured and did not adopt. It also lists what the project did not measure. The protocol comes from the goose skill `measurement.md`. Read this file before you implement a new optimization. A rejected idea saves the next agent from a repeat of a measured non-win.

## Protocol for an entry

Add an entry only after a measurement. A guess is not an entry. Give each entry these fields.

- Idea: what the change does, in one sentence.
- Commit: the commit hash of the branch or patch that was measured.
- Rows: the measurement and the size, for example M2 `check` at `large`.
- Ratio: the A/B ratio of baseline time to candidate time. A value above 1.00 means that the candidate is faster.
- Noise floor: the floor of the same row from M6, on the same machine and the same day.
- Samples: the number of pairs, and the profile (`--quick` or `--full`).
- Date: the day of the measurement.
- Verdict: why the idea is rejected. A ratio inside the noise floor is a null result and counts as a non-win.

Keep the entries sorted by date, newest last. Write "Not measured" when no number exists. Do not fill a gap with an estimate. Run `deno task bench` on both builds, side by side, minutes apart.

## Rejected ideas

None yet. Part A8 added the harness. No candidate change has been measured.

## Evidence gaps

These items are not measured. Each one names the reason.

- Token representation. M2 of the design compares object arrays with typed arrays for tokens. The lexer in `src/core/lex.ts` has only the typed-array form (`Lexed.kinds`, `starts`, `ends`). The comparison needs a second lexer that builds object tokens. No second lexer exists, so the comparison is not run.
- M1, M3, and M4 of the design. They need the LSP server and an edit script on the LSP process. Part A8 covers M2, M5, and M6.
- A/B between two builds. The harness runs A/A pairs only. It gives the noise floor. An A/B run needs two builds of the compiler and a harness that loads both.
- Memory. The harness does not measure peak resident memory.
- Core pinning. macOS has no `taskset` equivalent. The runs are not pinned.
- Garbage collection. The harness does not force a collection between runs. A collection that falls in a timed region is part of the distribution.

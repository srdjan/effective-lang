# Rejected ideas and evidence gaps

This file lists each idea that the project measured and did not adopt. It also lists what the project did not measure. The protocol comes from the goose skill `measurement.md`. Read this file before you implement a new optimization. A rejected idea saves the next agent from a repeat of a measured non-win.

## Protocol for an entry

Add an entry only after a measurement. A guess is not an entry. Give each entry these fields.

- Idea: what the change does, in one sentence.
- Commit: the commit hash of the branch or patch that was measured.
- Rows: the measurement and the size, for example M2 `check` at `large`.
- Ratio: the A/B ratio of baseline time to candidate time. A value above 1.00 means that the candidate is faster.
- Noise floor: the floor of the same row from M6, or from M1 for an M1 row, on the same machine and the same day.
- Samples: the number of pairs, and the profile (`--quick` or `--full`).
- Date: the day of the measurement.
- Verdict: why the idea is rejected. A ratio inside the noise floor is a null result and counts as a non-win.

Keep the entries sorted by date, newest last. Write "Not measured" when no number exists. Do not fill a gap with an estimate. Until the harness can load two builds (see the gaps), run `deno task bench` on both builds, minutes apart. Such a run does not interleave the sides, so its floor does not include the drift between the runs. Say so in the entry.

## Rejected ideas

None yet. Part A8 added the harness. No candidate change has been measured.

## Evidence gaps

These items are not measured. Each one names the reason.

- Token representation. M2 of the design compares object arrays with typed arrays for tokens. The lexer in `src/core/lex.ts` has only the typed-array form (`Lexed.kinds`, `starts`, `ends`). The comparison needs a second lexer that builds object tokens. No second lexer exists, so the comparison is not run.
- M4 samples `rss` only at the end of a step. A short memory peak inside a step is not seen.
- M1 times hover only on a declaration name. Hover on other nodes is not timed.
- M1 and M3 run with only the edited document open. A session with many open documents is not measured.
- The bench runs no `--full` profile by default. The default run uses the quick scale.
- A/B between two builds. The harness runs A/A pairs only. It gives the noise floor. An A/B run needs two builds of the compiler and a harness that loads both.
- Memory of the compiler stages. M2 and M5 do not measure memory. M4 measures the `rss` of the server only.
- Core pinning. macOS has no `taskset` equivalent. The runs are not pinned.
- Garbage collection. The harness does not force a collection between runs. A collection that falls in a timed region is part of the distribution.
- The cost of the `$int` helper (D14). No harness compares `$int` with plain arithmetic.
- The size of one module. Synthetic feature modules have at most 60 feature declarations. The small preset has one module with 30; the medium and large presets add modules with 60 each. Design section 4.5 asks for the largest realistic module, which is not measured.
- The duration of the quick profile. No test or record shows that each measurement ends in less than one minute. M2 and M5 do not print their elapsed time.
- Few pairs at the quick scale. M5 has two pairs for each target, so its p90 floor is almost the larger of two deviations.

# Measurements

The harnesses in `bench/` follow the measurement protocol of the design (section 10). They run on this machine and print plain text tables on stdout. Run every command from the repository root.

| Command                                                       | What it does                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deno task bench`                                             | Runs all six measurements at the quick scale. The quick scale aims at less than one minute for each. |
| `deno task bench --full`                                      | Runs the same measurements with larger iteration counts and more pairs.                              |
| `deno task bench m1`, `m2`, `m3`, `m4`, `m5`, or `m6`         | Runs the named measurements. `m6` runs M2 and prints only the noise floor.                           |
| `deno task bench --no-variants`                               | Skips the optional M5 variants.                                                                      |
| `deno task bench --json <file>`                               | Also writes the raw samples to the file.                                                             |
| `deno run --allow-write bench/generate.ts <size> <directory>` | Writes a synthetic project of the size `small`, `medium`, or `large`.                                |

`--quick` is the default. `--full` changes only these counts: iterations, steps, warm-ups, M2 edits of each kind, and pairs. The three sizes stay the same: 30, 300, and 3000 feature declarations. Each generated module also declares the aliases `Int`, `Num`, and `Text`, because rule R1 needs names for primitives.

The bench task passes `--no-lock`, so the optional variants never change `deno.lock`. The harness leaves nothing in the working tree. It uses temporary directories and removes them.

## What each measurement decides

M2 times the whole-module recheck for each stage: lex, parse, index, link, resolve, check, lower, emit, and validate. It also replays a body edit and an interface edit through `Program.update` and prints the modules that each revision checked again. M2 shows which stage costs the time when M1 misses the D9 budget, which is the gate for Phase B (design section 4.5). It also decides whether typed arrays pay for tokens and whether a Zig port is worth its cost.

M5 times a cold `deno check` over the emitted five examples and the three synthetic sizes. It uses the configuration that `effective build --tsc` generates, with `effect` mapped to `npm:effect@4.0.5`. M5 decides the oracle runner and whether `watch --tsc` can default to on.

M5 also tries three optional variants: `tsc` as a cold process, a warm `ts.LanguageService` in the same process, and `tsgo` from `@typescript/native-preview`. The harness installs `tsc` and `tsgo` into a temporary workspace with `deno install`. The `ts.LanguageService` variant imports `npm:typescript` into the bench process from the Deno cache. The first run needs network access. A variant that cannot run is skipped, and the report names the reason.

M6 gives the noise floor. Each iteration runs two sides, A and B, of the same build. The order of the sides alternates. The floor is the 90th percentile of the absolute value of `A/B - 1` over the pairs, in percent. A later A/B difference below the floor of its row counts as null. M6 uses the pairs of M2 and M5, so every row of M2 and M5 shows its floor in the column `floor %`.

M1 gets its floor from the A/B pairs of its own steps.

Measure the floor again when the machine or its load changes.

M1, M3, and M4 run the real language server as a subprocess. All three replay the same edit script. The harness opens only the edited document. It starts the server with `writeOnSave` false and `debounceMs` 0.

M1 times the path from an edit to its diagnostics. The time runs from just before the write of `textDocument/didChange` to the receipt of the matching `publishDiagnostics`. Then M1 times one hover on a fixed function name. Two server processes, A and B, run the same script, and the side that goes first alternates. M1 reports a distribution and the noise floor for each row.

M1 decides the debounce time and whether the server needs a worker thread or can stay on the main thread. It also checks the latency budget D9: 100 ms at p90 from `didChange` to `publishDiagnostics` on the large synthetic size. The decision record of the design has the evidence.

M3 counts the work that one edit causes. After each step, the client sends `effective/stats`. M3 reports the median and the maximum of the per-step change in the counts `parses`, `checks`, `lowerings`, and `emits`. It also reports the fraction of steps with an interface change and with a mode change.

M3 runs no hover, so the counts show the compile alone. The counts are exact, so M3 has no noise floor. M3 shows whether the recheck of whole modules causes a miss of the D9 budget. It also informs the later review of the mode firewall (D8).

M4 measures the memory of the server over a long script. It runs two servers, A and B, on the medium size. The script repeats the four edit kinds for N steps, and each row starts a new pair of servers. After each step, the client reads `rss` from `effective/stats`. A row shows the peak `rss` of each side and the `rss` after the last step.

M4 samples `rss` only at the end of a step, so it does not see a short peak inside a step. M4 decides the release policy for old revisions: whether the memory of a long session stays flat or grows.

## The edit script

The script makes one edit in each step and sends it as a full-text `didChange`. The edited module is the module with the edit target. After each step, the diagnostic list of the edited file must be empty. Any other list stops the run with an error value, and the run prints no time.

On the synthetic sizes, there are four kinds of edit.

| Kind     | What the edit does                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`   | Changes the literal in the body of `bump`. The interface of the module does not change.                                                             |
| `header` | Toggles the annotated type of the constant `extra` between the aliases `Int` and `Num`. The interface hash changes.                                 |
| `alias`  | Toggles the type alias `Amount` between `int` and `number`. The exported function `scale` names the alias, so the interface hash changes.           |
| `flip`   | Toggles the body of the function `flip` between `n + 1` and `retry(() => n + 1, { times: 1 })`. The mode of `flip` changes between pure and effect. |

For the five examples, the script has only the body edit. It changes the string literal in `displayName` of `users.eff` from `"Guest"` to `"Guest<n>"`, where `<n>` is a number that is new in each step. The hover of M1 names `displayName` on the examples and `bump` on the synthetic sizes.

## Protocol

Each M2 run ends with a checksum of the emitted text. Every run must give the same checksum, or the run stops with an error and prints no time. The first runs of each size are warm-ups, and the report drops them. Each row is a distribution: `n`, `min`, `p10`, `median`, `p90`, and `max`. The harness never reports a best of N. The rows of M2 pool the runs of both sides.

The stage `parse` includes `lex`, because the parser lexes its own input. The row `total` is the sum of every stage except `lex`. M5 ends one generated file with a unique comment before each sample, so that `deno check` cannot answer from its type-check cache. The column `control` shows a repeat on unchanged input.

The token representation test of the design (object arrays against typed arrays) is not run. The lexer has only the typed-array form, so the comparison needs a second lexer. `docs/rejected.md` records this gap.

M1 and M3 run on the examples and on the three synthetic sizes. M4 runs on the medium size. The step counts of the quick and the full profile are in `bench/profile.ts`.

A number from a run enters the README, the docs, or the ledger only with its noise floor, its size, and its number of samples. The user decides what to record. The timer is `performance.now()`, and the process is not pinned to a core, because macOS has no `taskset` equivalent.

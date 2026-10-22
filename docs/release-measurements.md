# Release measurements — 2026-10-21

The full M1/M3/M4 run completed successfully. All four large-input diagnostics p90 values are below the accepted **100 ms** budget; the highest is **73.923 ms** for alias edits. The long session completed **10,000 distinct edits per server across three concurrently open documents**. These measurements do not establish a memory bound.

## Reproduce and inspect

Frozen application source: `bf8e570493285d0322fbddccfebfdf398d75614b`, with the unchanged measurement infrastructure committed alongside this evidence. The supervisor held CPU-heavy checks and browser/installed-extension runs until outside this measurement window.

```sh
deno task bench --full m1 m3 m4 --json docs/release-measurements-2026-10-21.json > docs/release-measurements-2026-10-21.txt
```

Exit status: **0**. M1/M3/M4 wall times were **47.7 / 20.5 / 72.5 seconds**. Environment: Deno **2.9.7**, V8 **15.0.245.2-rusty**, TypeScript **6.0.3**, `aarch64-apple-darwin`, **14 logical cores**. Timing uses `performance.now()`; execution is not pinned to a core. Memory units below are MiB (1,048,576 bytes).

- [Raw samples](release-measurements-2026-10-21.json): all latency pairs, count deltas, memory baselines and step-end samples.
- [Complete text report](release-measurements-2026-10-21.txt): latency distributions and row noise floors, work counts and session summaries.
- [General measurement methodology](measurements.md).

## Diagnostics latency and work

M1 uses independent A/A server processes with alternating execution order, `writeOnSave: false` and `debounceMs: 0`. Only the edited document is open in M1. Each input/edit kind drops five warm-up steps per side, then records 100 timed pairs (**200 pooled samples**). Inputs contain 30, 300 and 3,000 synthetic feature declarations, plus fixed project scaffolding; the examples are a separate input. The budget applies to diagnostics latency on the large input.

| Large-input edit | Samples | Median ms | p90 ms | Maximum ms | A/A floor % |
| --- | ---: | ---: | ---: | ---: | ---: |
| body | 200 | 10.922 | 11.770 | 22.562 | 10.9 |
| header | 200 | 54.451 | 57.817 | 88.614 | 6.4 |
| alias | 200 | 58.301 | 73.923 | 89.972 | 22.2 |
| flip | 200 | 54.189 | 56.096 | 85.678 | 5.7 |

The A/A floor is the p90 of `abs(A/B - 1)` expressed as a percentage. It describes within-run relative timing noise; differences below that floor do not establish a speed change. Every one of the 13 diagnostics rows, including smaller inputs and the examples, also has p90 below 100 ms. The complete report retains hover distributions and every row's floor. This run measures the source language server, with diagnostic and hover traffic; it does not measure every new editor feature or VS Code UI latency.

M3 ran 100 steps per input/edit kind (**1,300 steps**) without hover. Every step parsed exactly one module and performed zero lowerings and emissions. Body edits checked one module. Header, alias and mode-flip edits checked two modules on small, four on medium and 26 on large. Interface and mode deltas remain recorded per step in the raw data. These counts have no timing noise floor.

## Multiple-document sessions

M4 starts a fresh pair of servers for each row and keeps `m02.eff`, `m00.eff` and `m01.eff` open concurrently in the existing medium project. Edits rotate among them. The primary document cycles body, header, alias and mode-flip edits. Companion documents change the literal in their annotated `link` function bodies. Each submitted text has a unique global revision comment; the previous marker is replaced so comments do not accumulate. This keeps semantic toggles from revisiting identical text. M1/M3 use the same distinct-revision marker without changing their single-document work oracles.

After initial document diagnostics, M4 records a baseline. After every edit it records RSS, heap used and the project type-table size through `effective/stats`. Both sides pass the empty-diagnostics gate before the next step. No hover runs in M4. Peaks are sampled at step ends and can miss shorter peaks inside a step. Garbage collection is not forced.

| Edits per side | Side | RSS start / sampled peak / last MiB | Heap start / sampled peak / last MiB | Type table start → last |
| ---: | --- | ---: | ---: | ---: |
| 200 | A | 68.4 / 201.5 / 201.5 | 11.7 / 79.1 / 69.7 | 174 → 176 |
| 200 | B | 68.3 / 205.1 / 205.1 | 11.6 / 87.1 / 60.4 | 174 → 176 |
| 500 | A | 68.3 / 200.0 / 200.0 | 11.4 / 80.8 / 30.3 | 174 → 176 |
| 500 | B | 68.3 / 200.5 / 200.5 | 11.5 / 84.3 / 32.5 | 174 → 176 |
| 1,000 | A | 68.4 / 203.0 / 203.0 | 11.5 / 82.3 / 70.3 | 174 → 176 |
| 1,000 | B | 68.5 / 213.2 / 213.2 | 11.7 / 90.8 / 83.3 | 174 → 176 |
| 10,000 | A | 68.2 / 216.4 / 200.1 | 11.7 / 91.6 / 79.3 | 174 → 176 |
| 10,000 | B | 70.1 / 228.0 / 205.3 | 11.4 / 107.8 / 37.1 | 174 → 176 |

For the 10,000-edit row, each server submitted **3,334 / 3,333 / 3,333** edits to `m02.eff` / `m00.eff` / `m01.eff`. The raw document counters sum to 10,000 on each side; each side has exactly 10,000 complete memory samples. Baselines are separate from those samples. RSS arrays and their peak/last summaries independently agree with the RSS in the complete samples. Type-table sizes are positive integers and never decrease within a row.

The type table grew from 174 to 176 entries in both long-session processes. The script cycles a fixed set of declarations and type shapes: 10,000 distinct texts do not mean 10,000 distinct type shapes. RSS rose substantially from its startup baseline, and sampled heap varied across the session. This finite run provides no bound for longer sessions, other edit patterns, new type shapes, more documents, or complete editor workloads.

## Verification and acceptance boundary

The focused benchmark suite passed 31 tests before the full run:

```sh
deno test --allow-all tests/bench_lsp_slow_test.ts tests/bench_session_test.ts tests/bench_smoke_test.ts tests/bench_generate_test.ts
```

The final M4 smoke row was then extended to 13 steps to cover all four primary edit kinds with companion edits between them; `deno test --allow-all --filter M4 tests/bench_lsp_slow_test.ts` passed. Scoped formatting and lint checks passed. The pure regression independently confirms that 10,000 successive primary edit texts are distinct and retain only one revision marker.

The saved JSON was independently checked for sample counts, per-document edit counts, distinct-edit totals, positive numeric baselines and samples, matching RSS summaries, monotonic type-table counts, and all M1/M3 count/budget claims above. These are automated measurements. They do not represent the user's manual release acceptance; installed-extension and browser acceptance evidence is recorded separately.

## Save rounds

The [completed save plan](archive/plans/2026-10-21-save-transpilation.md), unit SV5, added M7 and a second M4 run with `writeOnSave` true. One full run measured the tree that was committed as `539dda6`:

```sh
deno task bench --full m1 m4 m7
```

The [complete text report](release-measurements-2026-10-21-save.txt) holds every row of that run, including a new M1 run. No JSON file was written for it. [Measurements](measurements.md) describes the M7 completion signal and its scenarios.

M7 times one save from the write of `didSave` to the reply of a following `effective/stats` request. Two server processes, A and B, run each warm row, so `n` counts both sides. The cold rows use a fresh server for each sample. The budget SV-D3 applies to the `body` row on the large preset.

| Preset and scenario | Saves | n | Median ms | p90 ms | Maximum ms | A/B floor % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| large cold | 1 | 30 | 242.132 | 267.823 | 275.262 | 4.5 |
| large stats only | 0 | 200 | 0.058 | 0.079 | 0.138 | 43.5 |
| large repeat | 1 | 200 | 14.241 | 15.284 | 37.037 | 9.3 |
| large body | 1 | 200 | 19.964 | 24.927 | 104.506 | 21.6 |
| large interface | 1 | 200 | 94.877 | 104.494 | 287.177 | 10.9 |
| large save all | 52 | 30 | 808.095 | 838.374 | 859.244 | 4.4 |

The large `body` p90 of **24.927 ms** is within the 100 ms budget of SV-D3. The large `interface` p90 is above 100 ms, but SV-D3 does not apply to it. A `save all` of 52 modules runs 52 full rounds, one for each `didSave`. The small and medium rows are in the text report.

M4 ran twice on the medium input with three open documents. In the second run, each step writes the edited text to disk and sends `didSave`, so each server holds a disk program. The difference includes the disk program and the file reads and writes of the saves.

| Edits per side | RSS sampled peak A/B MiB, no saves | RSS sampled peak A/B MiB, with saves | Type table start → last |
| ---: | ---: | ---: | ---: |
| 200 | 189.2 / 200.4 | 273.7 / 235.6 | 174 → 176 |
| 500 | 203.2 / 213.1 | 268.7 / 239.6 | 174 → 176 |
| 1,000 | 211.6 / 221.3 | 277.6 / 274.2 | 174 → 176 |
| 10,000 | 218.0 / 210.0 | 275.9 / 290.4 | 174 → 176 |

The sampled RSS peak was higher with saves in every row. Peaks are sampled at step ends, and garbage collection is not forced. This run establishes no memory bound and no memory budget.

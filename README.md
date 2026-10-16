# effective-lang

Effective is a small functional language that transpiles to Effect-TS 4. This repository holds the transpiler core library and, in later parts, its command-line tool.

The design is in `docs/transpiler-design.md`. The Phase A plan is in `docs/plans/2026-10-16-phase-a.md`. The plan splits the work into parts A1 to A8.

## Status

Part A1 is the only part in the repository. It adds the project skeleton, the lexer, a lossless parser with error recovery, and the `syntax` diagnostics. The parser reads `.eff` source files and `.effi` host interface files. The checker, the emitter, and the command-line tool do not exist yet.

## Requirements

The project needs Deno 2.9.7. The first test run downloads `@std/assert` from jsr, so it needs network access once.

## Commands

Run every command from the repository root.

| Command               | What it does                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| `deno task check`     | Runs the format check, the lint, the type check, the fast tests, and the slow tests. |
| `deno task test`      | Runs the fast tests. It skips files named `*_slow_test.ts`.                          |
| `deno task test:slow` | Runs only files named `*_slow_test.ts`. A1 has none, and the task still succeeds.    |
| `deno task fmt`       | Formats the source files.                                                            |
| `deno task lint`      | Runs the linter.                                                                     |

The tasks `effective`, `golden:update`, and `bench` do not exist yet. Later parts add them.

## Layout

```
src/core/      The core library. It is synchronous and pure.
  ir.ts          Typed IR model, copied from the sibling repository effective.
  source.ts      SourceHost, line tables, positions, and span helpers.
  diagnostics.ts Diagnostic type, the registry of codes, sort and dedupe.
  lex.ts         Lexer: typed arrays of tokens plus trivia.
  syntax.ts      Syntax tree types and the printer.
  parse.ts       Parser with recovery.
tests/         Deno tests and test helpers.
fixtures/      Input files for the tests.
  examples/      The five example programs and the host interface file.
  ir/example/    The log example and its IR fixture.
  parse/         Valid syntax forms (ok-*) and recovery inputs (recovery-*).
  errors/        One file for each error case, with markers.
docs/          Design and plans.
```

The core reads files only through `SourceHost`. It calls no Deno API. Tests may use Deno APIs.

## Using the parser

`parse(source, text, mode)` returns the syntax tree and the diagnostics. The `source` value is the path that diagnostic spans carry. The `mode` value is `"eff"` or `"effi"`. `fileModeOf(path)` picks the mode from the extension.

`printTree(tree)` prints the tree back to text. The result equals the input for every input, including input with errors. Positions count UTF-16 code units, and an end position is exclusive.

## Error fixture convention

An error fixture is a file in `fixtures/errors/`. Its name is `syntax-<topic>.eff`. A host interface file error uses the extension `.effi`.

A line that contains only `// error: <code>` marks one expected diagnostic. The diagnostic span must start on the line directly below the marker. A diagnostic code looks like `syntax/008`.

Several marker lines in a row all apply to the first line below the run. The test compares the sorted list of line and code pairs. The file must produce exactly the marked diagnostics and no others.

A missing token has an empty span. The span sits at the end of the last real token. The marker goes above the incomplete line.

The files `fixtures/parse/recovery-*.eff` use the same markers. The files `fixtures/parse/ok-*` and the files in `fixtures/examples/` must parse with no diagnostics.

## Format and lint scope

`deno fmt` skips `docs/`, `src/core/ir.ts`, and every `.eff` and `.effi` file. The copy of `ir.ts` stays as it is in the sibling repository. `deno lint` skips `docs/` and `fixtures/golden/`.

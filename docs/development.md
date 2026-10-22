# Development

This file gives the task commands, the repository layout, the error fixture convention, and the format and lint scope. The [README](../README.md) gives a short overview.

## Commands

Run every command from the repository root.

| Command                       | What it does                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task check`             | Runs the format check, the lint, the type check, the fast tests, and the slow tests.                                                                    |
| `deno task test`              | Runs the fast tests. It skips files named `*_slow_test.ts`.                                                                                             |
| `deno task test:slow`         | Runs only files named `*_slow_test.ts`. They run `deno check`, `deno fmt`, and `deno run` with a fresh `DENO_DIR` that the task removes after.                                                              |
| `deno task golden:update`     | Writes `fixtures/golden/<module>.ts` again from `fixtures/examples` and `fixtures/emit/traverse`.                                                       |
| `deno task validate:update`   | Writes the mutation fixtures in `fixtures/validate/` again from the current lowering.                                                                   |
| `deno task lex:update`        | Writes `fixtures/lex/snapshot.json` again from the current lexer. Run it only after a deliberate change of the lexer output.                            |
| `deno task behavior:capture`  | Compares two revisions using instrumented compiler entry points during tests, including subprocesses. See the capture note below. Use it for refactors. |
| `deno task measure`           | Prints the lines, branches, and cyclomatic numbers of the files that you name, as JSON.                                                                 |
| `deno task measure:functions` | Prints the branches and cyclomatic number of each function in the files that you name, as TSV.                                                          |
| `deno task effective`         | Runs the command-line tool. See [Using the command line](api.md#using-the-command-line).                                                           |
| `deno task lsp`               | Runs the language server over standard input and output. See [Language server](api.md#language-server).                                            |
| `deno task bench`             | Runs the measurement harnesses. See [Measurements](measurements.md).                                                                               |
| `deno task playground:build`  | Writes the playground page to `playground/dist/`. See [Playground](api.md#playground).                                                             |
| `deno task playground:serve`  | Builds the playground page, then serves it on `http://127.0.0.1:8790/`.                                                                                 |
| `deno task package`           | Builds standalone CLI/server bundles and the complete local VSIX. See [installation](installation.md).                                             |
| `deno task test:installation` | Checks reproducible packaging and isolated offline installation.                                                                                        |
| `deno task test:vscode`       | Runs installed VSIX acceptance in a local VS Code application.                                                                                          |
| `deno task fmt`               | Formats the source files.                                                                                                                               |
| `deno task lint`              | Runs the linter.                                                                                                                                        |

The capture records completed calls to `checkAnalysis`, `Program.update`, `lowerModule`, `emitModule`, and `validateModule`, including returned error results where present. It excludes its own tests and does not record every lower-level checker call. The temporary hooks embed their destination path, so child processes need write permission but no environment permission. A recording failure fails the capture visibly.

## Layout

The core reads files only through `SourceHost`. It calls no Deno API. Tests may use Deno APIs. The file-level map of `src/` is in [api.md](api.md#source-file-map).

| Directory         | Content                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`       | The core library. It is synchronous and does no I/O. `Program` memoizes its queries. The `validate/` subdirectory holds the independent IR validator, and `emit/` holds the Effect-TS emitter. |
| `src/cli/`        | The command-line tool. Deno APIs stay here, in `src/host/`, `src/lsp/main.ts`, `bench/`, `playground/build.ts`, `playground/serve.ts`, `scripts/`, and `tests/`.                               |
| `src/host/`       | The host adapters that the command-line tool and the language server share.                                                                                                                    |
| `src/lsp/`        | The language server.                                                                                                                                                                           |
| `editors/vscode/` | The VS Code client. It is plain JavaScript with no build step.                                                                                                                                 |
| `playground/`     | The browser playground. The page is in `src/`, the build in `build.ts`.                                                                                                                        |
| `scripts/`        | The scripts that the tasks run: golden files, mutation fixtures, behavior capture, the lexer snapshot, the measure scripts, packaging, and the VS Code smoke test.                                                            |
| `tests/`          | Deno tests and test helpers.                                                                                                                                                                   |
| `bench/`          | The measurement harnesses of parts A8 and L5. They are not part of the core.                                                                                                                   |
| `fixtures/`       | Input files for the tests.                                                                                                                                                                     |
| `docs/`           | Design, rules, status, API, measurements, and the archive of finished plans.                                                                                                                   |

The directories of `fixtures/` are these.

| Directory             | Content                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `examples/`           | The five example programs, the host interface file, and `users-live.ts`.                   |
| `golden/`             | The expected emitted TypeScript of each example.                                           |
| `emit/forms/`         | Extra programs for the emitter tests. They are not golden examples.                        |
| `host-boundary/`      | A wrong host module, captured `deno check` output, and `manifest.json`.                    |
| `ir/example/`         | The log example and its IR fixture.                                                        |
| `applications/`       | The three application witnesses: service-workflow, scheduled-worker, and stream-processor. |
| `host-adapter-files/` | A project with a typed host adapter for `effect/FileSystem`.                               |
| `lex/`                | `snapshot.json`: hashes of the lexer output for a fixed corpus.                            |
| `validate/`           | Mutated copies of lowered IR and `manifest.json`, which names the expected code of each.   |
| `parse/`              | Valid syntax forms (`ok-*`) and recovery inputs (`recovery-*`).                            |
| `errors/`             | One file or one project directory for each error case, with markers.                       |

## Error fixture convention

An error fixture is a file in `fixtures/errors/` or a project directory in `fixtures/errors/`. Its name is `<category>-<topic>`, where the category is a diagnostic category such as `syntax` or `module`. A host interface file error uses the extension `.effi`.

A single file runs as a project with one module and an empty project file. A file whose name starts with `syntax-` only goes through the parser.

A project directory holds its own `effective.json` and the files of the case. The test loads every `.eff` file of the directory as an entry. A host interface file must have an import that reaches it.

A line that contains only `// error: <code>` marks one expected diagnostic. The diagnostic span must start on the line directly below the marker. A diagnostic code looks like `syntax/008`.

Several marker lines in a row all apply to the first line below the run. The test compares the sorted list of file, line, and code. The case must produce exactly the marked diagnostics and no others.

A missing token has an empty span. The span sits at the end of the last real token. The marker goes above the incomplete line.

The files `fixtures/parse/recovery-*.eff` use the same markers. The files `fixtures/parse/ok-*` and the files in `fixtures/examples/` must parse with no diagnostics. The project files `fixtures/examples/effective.json` and `fixtures/ir/effective.json` set the module roots.

## Format and lint scope

`deno fmt` skips `docs/`, `src/core/ir.ts`, `editors/vscode/node_modules/`, and every `.eff` and `.effi` file. The copy of `ir.ts` stays as it is in the sibling repository. `deno fmt` checks `fixtures/golden/`. `deno lint` skips `docs/` and `fixtures/golden/`, because generated code keeps unused handler parameters. It also skips `editors/vscode/`, which holds plain JavaScript. Both tools skip `playground/dist/`, but `deno fmt` checks `playground/index.html` and `playground/app.css`. The shared Deno exclusion keeps local `.claude/worktrees/` copies out of root checks.

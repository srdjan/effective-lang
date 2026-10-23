# effective-lang

Effective is a small functional language that transpiles to Effect-TS 4. This
repository holds the transpiler core library, its command-line tool, a language
server, a VS Code client, and a browser playground.

The canonical specification is in the sibling repository
`../effective/public/effective-spec.html` and governs the language. The
implemented language rules are in
[docs/language-rules.md](docs/language-rules.md).

## Features

The command-line tool checks a project, writes the generated TypeScript with
source maps, and can run `deno check` over the result. The `watch` command
builds again after each source change. The language server gives diagnostics,
hover, go-to-definition, references, rename, completion, semantic tokens, and
contract quick fixes. The VS Code client shows the generated TypeScript and
writes it on save. The playground runs the core in the browser and shows the
problems and the generated TypeScript.

## Requirements

The project needs Deno 2.9.8. The first test run downloads `@std/assert` from
jsr, so it needs network access once. Generated TypeScript targets Effect 4.0.5.
To build the VS Code extension, you also need Node 20 or later with npm.

## Installation

To use the tools from a checkout, clone the repository and run the tasks from
its root. No other installation step is necessary.

To install the standalone command-line tool and the VS Code extension, read
[docs/installation.md](docs/installation.md).

## Usage

Run each command from the repository root. Give the project directory that holds
`effective.json`:

```sh
deno task effective check fixtures/examples
deno task effective build fixtures/examples
deno task effective watch fixtures/examples
```

`check` prints the diagnostics. `build` also writes `<module>.ts` and
`<module>.ts.map` next to each source file. `watch` builds again after each
source change. [docs/api.md](docs/api.md) describes the command-line tool, the
language server, the VS Code client, and the playground.

## Development

Run `deno task check` before each commit. It runs the format check, the lint,
the type check, the fast tests, and the slow tests. Run `deno task test` for the
fast tests only.

[docs/development.md](docs/development.md) lists every task, the repository
layout, the error fixture convention, and the format and lint scope.

## Project layout

| Directory         | Content                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `src/core/`       | The core library: parser, checker, lowering, IR validator, and emitter. |
| `src/cli/`        | The command-line tool.                                                  |
| `src/host/`       | The host adapters that the command-line tool and the server share.      |
| `src/lsp/`        | The language server.                                                    |
| `editors/vscode/` | The VS Code client.                                                     |
| `playground/`     | The browser playground.                                                 |
| `bench/`          | The measurement harnesses.                                              |
| `scripts/`        | The scripts that the tasks run.                                         |
| `tests/`          | Tests and test helpers.                                                 |
| `fixtures/`       | Test inputs.                                                            |
| `docs/`           | Design, rules, status, plans, and reference documents.                  |

## Documentation

| Topic                                                          | Document                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tasks, layout, fixture conventions, format and lint scope      | [docs/development.md](docs/development.md)                                   |
| Design of the transpiler                                       | [docs/transpiler-design.md](docs/transpiler-design.md)                       |
| Language rules that the implementation chose                   | [docs/language-rules.md](docs/language-rules.md)                             |
| Project status and open items                                  | [docs/status.md](docs/status.md)                                             |
| API, command line, language server, VS Code client, playground | [docs/api.md](docs/api.md)                                                   |
| Editor queries and rename boundaries                           | [docs/editor.md](docs/editor.md)                                             |
| Local installation and artifacts                               | [docs/installation.md](docs/installation.md)                                 |
| HTTP/SQLite integration acceptance                             | [docs/integration.md](docs/integration.md)                                   |
| Measurement harnesses and protocol                             | [docs/measurements.md](docs/measurements.md)                                 |
| Release benchmark results                                      | [docs/release-measurements.md](docs/release-measurements.md)                 |
| Playground browser acceptance                                  | [docs/playground-review-2026-10-21.md](docs/playground-review-2026-10-21.md) |
| Rejected ideas                                                 | [docs/rejected.md](docs/rejected.md)                                         |
| Solved problems                                                | `docs/solutions/`                                                            |
| Live plans                                                     | `docs/plans/`                                                                |
| Finished plans and ledgers                                     | `docs/archive/`                                                              |
| Shared terms                                                   | [CONCEPTS.md](CONCEPTS.md)                                                   |

## Status

All parts of the Phase A plan, the language server plan, and the playground plan
exist. The three application gates pass with existing language forms. A fourth
application, order-lifecycle, is a witness for nominal data types and is not a
gate. [docs/status.md](docs/status.md) gives the project status, the application
stopping rule, the open items, and the deferred gaps.

## Contributing

[AGENTS.md](AGENTS.md) gives the repository rules: structure, commands, style,
tests, commits, and plan ID prefixes. Use one commit for each complete unit of
work, and run `deno task check` before each commit.

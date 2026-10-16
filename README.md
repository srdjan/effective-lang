# effective-lang

Effective is a small functional language that transpiles to Effect-TS 4. This repository holds the transpiler core library, its command-line tool, a language server, and a VS Code client.

The design is in `docs/transpiler-design.md`. The Phase A plan is in `docs/plans/2026-10-16-phase-a.md`. The plan splits the work into parts A1 to A8. The plan for the language server is in `docs/plans/2026-10-16-lsp.md`. It splits the work into parts L1 to L6.

## Status

Parts A1, A2, A3a, A3b, A4, A5, A6a, A6b, A7, and A8 exist. Part A1 adds the project skeleton, the lexer, a lossless parser with error recovery, and the `syntax` diagnostics. The parser reads `.eff` source files and `.effi` host interface files.

Part A2 adds the declaration index, the project loader, the module graph, and the name resolver. It adds the diagnostic codes `unknown-name`, `module`, and `declaration`.

Part A3a adds the declaration level of the checker. It adds the type intern table, the compatibility rules, function and provider signatures, and module interfaces with hashes. It adds the codes `type-mismatch/001`, `type-mismatch/002`, and `declaration/005` to `declaration/011`.

Part A3b adds body checking. It checks every function and constant body, infers effects and execution modes, and checks contracts, patterns, `try` and `catch`, `retry`, and `provide`. It builds the module initialization graph and the `typeAt` query. It adds the codes `type-mismatch/003` to `type-mismatch/011`, `failure-contract/001` to `/003`, `requirement-contract/001`, `execution-mode/001` to `/004`, `pattern/001` to `/004`, and `module/004`.

Part A4 lowers a checked module to typed IR and serializes it. It adds a synchronous SHA-256 for builtin identities.

Part A6a adds the Effect-TS emitter. It turns the IR of each module into the text of one TypeScript module. It adds the five golden files, the host module `users-live.ts`, and the slow tests that check and run the emitted code. Part A7 adds the command-line tool.

Part A6b adds the span table, version 3 source maps, and the mapping of `deno check` errors to Effective spans. It adds the diagnostic code `host-boundary/001`, a parser for `deno check` output, and the fixtures in `fixtures/host-boundary/`. It also makes the printer a fixed point of `deno fmt` for the golden files and for the programs in `fixtures/emit/forms/`. The golden files are no longer excluded from `deno fmt`.

Part A5 adds the independent IR validator. It recomputes every annotation of a module from the IR and the source texts, and it reports each disagreement with its validation area. It adds the category `validation` with the codes `validation/001` to `validation/008`, and the mutation fixtures in `fixtures/validate/`.

Part A7 adds the program with module cutoff (`src/core/db.ts`), the public API (`src/core/mod.ts`), and the command-line tool (`src/cli/main.ts`). The tool has the commands `check`, `build`, and `watch`, and the flags `--tsc` and `--validate`. It also adds the line `//# sourceMappingURL=<file>.map` to each emitted file.

Part A8 adds the measurement harnesses in `bench/`: a synthetic module generator and the measurements M2, M5, and M6 of the design. See "Measurements". The README holds no measured number. The user decides which numbers enter the docs.

Parts L1 to L6 add the language server in `src/lsp/`, the VS Code client in `editors/vscode/`, and the measurements M1, M3, and M4. See "Language server", "VS Code client", and "Measurements". The README holds no measured number for these parts either. The hand test of the client in VS Code (acceptance check 5 of the plan) is not done yet.

## Requirements

The project needs Deno 2.9.7. The first test run downloads `@std/assert` from jsr, so it needs network access once.

## Commands

Run every command from the repository root.

| Command                     | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `deno task check`           | Runs the format check, the lint, the type check, the fast tests, and the slow tests.       |
| `deno task test`            | Runs the fast tests. It skips files named `*_slow_test.ts`.                                |
| `deno task test:slow`       | Runs only files named `*_slow_test.ts`. They run `deno check`, `deno fmt`, and `deno run`. |
| `deno task golden:update`   | Writes `fixtures/golden/<module>.ts` again from `fixtures/examples`.                       |
| `deno task validate:update` | Writes the mutation fixtures in `fixtures/validate/` again from the current lowering.      |
| `deno task effective`       | Runs the command-line tool. See "Using the command line".                                  |
| `deno task lsp`             | Runs the language server over standard input and output. See "Language server".            |
| `deno task bench`           | Runs the measurement harnesses. See "Measurements".                                        |
| `deno task fmt`             | Formats the source files.                                                                  |
| `deno task lint`            | Runs the linter.                                                                           |

## Layout

```
src/core/      The core library. It is synchronous and pure.
  ir.ts          Typed IR model, copied from the sibling repository effective.
  source.ts      SourceHost, line tables, positions, and span helpers.
  diagnostics.ts Diagnostic type, the registry of codes, sort and dedupe.
  lex.ts         Lexer: typed arrays of tokens plus trivia.
  syntax.ts      Syntax tree types and the printer.
  parse.ts       Parser with recovery.
  hash.ts        Synchronous content hash (FNV-1a 64).
  index.ts       Declaration index of one file: names, kinds, spans, hashes.
  project.ts     effective.json, module identity, module graph, cycles, order.
  resolve.ts     Names to identities, scopes, prelude, side table of targets.
  types.ts       Interned types, compatibility, IR conversion, canonical JSON.
  check.ts       Declaration checker: type lowering, signatures, providers.
  check_expr.ts  Body checker: expressions, calls, patterns, contracts.
  check_project.ts Project driver: bodies, modes, interfaces, and typeAt.
  tables.ts      Side tables of a body: node info and lowering facts.
  patterns.ts    Pattern domains of match subjects.
  modes.ts       Strongly connected components and the mode fixed point.
  initialization.ts Eager dependency graph of module constants.
  interface.ts   Module interfaces, their hashes, and the declaration driver.
  analyze.ts     Public entry: load a project, resolve it, collect diagnostics.
  db.ts          Program: revisions, parse memo, check memo with module cutoff, lazy IR, text, and maps.
  editor.ts      hoverAt, definitionAt, and documentSymbols over a revision.
  ids.ts         Parts of a declaration identity: module, name, and method.
  mod.ts         The public API of the core: a list of re-exports.
  sha256.ts      Synchronous SHA-256 over the UTF-8 bytes of a string.
  lower.ts       Checked modules to typed IR: pipelines, builtin specialization, imports.
  serialize.ts   Canonical JSON of a module IR, with the set and number checks.
  validate/      The independent IR validator. It imports only ir.ts, source.ts, and diagnostics.ts.
    index.ts       validateModule: the public entry.
    world.ts       Identities in scope, imports, declaration headers, recursive types.
    expr.ts        Bottom-up recomputation of types, sets, and modes of each body.
    typing.ts      Type compatibility, including the lift rule.
    sets.ts        Sorted effect sets and the combine rule.
    serialization.ts Sorted sets, finite numbers, and spans against the source texts.
    report.ts      The eight area codes and the diagnostic collector.
  validate_project.ts validateProject: validates the output of lowerProject.
  emit/          The Effect-TS emitter.
    emit.ts        emitModule and emitProject: the public entries.
    spans.ts       The span table: generated position to source span, and host import spans.
    sourcemap.ts   Version 3 source maps and the base64 VLQ coding.
    tsc.ts         Parser for deno check output and the mapping of its errors.
    doc.ts         The printer: documents, layout at 80 columns, span tags.
    scope.ts       Names, fresh names, imports, host bindings, specifiers.
    types.ts       The type printer and the schema printer.
    expr.ts        The expression scheme: pure, inGen, asEffect.
    decls.ts       Declarations, their order, and the export rule.
    walk.ts        Traversals of the IR.
src/cli/       The command-line tool. Only this directory calls Deno APIs, besides the scripts and the slow tests.
  main.ts        main(args, io) returns the exit code. The last lines wire the real io.
  args.ts        The command line: commands, root, and flags.
  io.ts          The ports: file system, deno check runner, and watch source.
  deno_io.ts     The real ports: Deno file system, subprocess, and Deno.watchFs.
  workspace.ts   The walk over the root: .eff and .effi files and effective.json.
  session.ts     One project directory and one program: sync, then build.
  build.ts       One build: validate, write the files, run deno check.
  tsc.ts         The generated deno check configuration and the mapping of its output.
  format.ts      The output line of a diagnostic.
  report.ts      Printing of a build outcome: diagnostics on stdout, the rest on stderr.
  watch.ts       The watch loop over an injected event source.
  events.ts      Debouncing of file system events.
  outputs.ts     writeGenerated: the write of the .ts and .ts.map files, shared by build and the language server.
src/lsp/       The language server. See "Language server".
  main.ts        The stdio entry: reads frames, writes frames, and ends the process.
  server.ts      LanguageServer: lifecycle, dispatch, and the flush schedule.
  projects.ts    Project discovery, the open-document overlay, and the flush of a project.
  features.ts    The handlers: hover, definition, symbols, generated text, save, and stats.
  jsonrpc.ts     Content-Length frames and the message shapes.
  protocol.ts    The subset of the protocol: types and the narrowing of incoming params.
  positions.ts   Positions, ranges, and the conversion between URIs and paths.
  methods.ts     The names of the custom methods, shared with the client.
editors/vscode/ The VS Code client. See "VS Code client". Plain JavaScript, no build step.
scripts/       Scripts that the tasks run. golden_update.ts writes the golden files.
               validate_fixtures.ts writes the mutation fixtures.
tests/         Deno tests and test helpers.
fixtures/      Input files for the tests.
  examples/      The five example programs, the host interface file, and users-live.ts.
  golden/        The expected emitted TypeScript of each example.
  emit/forms/    Extra programs for the emitter tests. They are not golden examples.
  host-boundary/ A wrong host module, captured deno check output, and manifest.json.
  ir/example/    The log example and its IR fixture.
  validate/      Mutated copies of lowered IR and manifest.json, which names the expected code of each.
  parse/         Valid syntax forms (ok-*) and recovery inputs (recovery-*).
  errors/        One file or one project directory for each error case, with markers.
bench/         The measurement harnesses of parts A8 and L5. They are not part of the core.
  main.ts        The entry: arguments, profiles, and the report.
  profile.ts     The scale of --quick and --full.
  generate.ts    The synthetic module generator and the edit scripts.
  m1.ts          M1: edit latency through the language server.
  m3.ts          M3: work per edit, from the stats of the server.
  m4.ts          M4: server memory over a long edit script.
  lsp_client.ts  A client over a spawned server process.
  lsp_script.ts  The inputs, the edit script, and the server session of M1, M3, and M4.
  m2.ts          M2: time per stage and the incremental path, with the checksum gate.
  m5.ts          M5: cold deno check over the emitted code.
  m5_target.ts   The inputs of M5: the emitted examples and synthetic projects.
  m5_variants.ts The optional M5 variants: tsc, ts.LanguageService, and tsgo.
  m6.ts          M6: the noise floor report.
  stats.ts       Quantiles, the noise floor, the checksum, and plain text tables.
docs/          Design, plans, and rejected.md, the ledger of rejected ideas.
```

The core reads files only through `SourceHost`. It calls no Deno API. Tests may use Deno APIs.

## Using the parser

`parse(source, text, mode)` returns the syntax tree and the diagnostics. The `source` value is the path that diagnostic spans carry. The `mode` value is `"eff"` or `"effi"`. `fileModeOf(path)` picks the mode from the extension.

`printTree(tree)` prints the tree back to text. The result equals the input for every input, including input with errors. Positions count UTF-16 code units, and an end position is exclusive.

## Using the front end

`analyzeProject(host, root, entries)` loads a project, resolves every name, and returns all diagnostics. The `host` value reads files. The `root` value is the project directory. The `entries` value is a list of root-relative paths.

The function reads `effective.json` in the root. A missing or malformed file gives an error value, not an exception. The function follows imports from the entry files. Relative imports must end in `.eff`. The import `host:key` selects a host interface file from `effective.json`.

The result holds the project, one resolution table for each module, and the sorted diagnostics. The project holds the parse trees, the module graph, and the topological order. A resolution table maps a syntax node id to its target. The target is a declaration identity, a local identity, a prelude builtin, or a builtin type.

A diagnostic span names its file by the root-relative path, for example `users.eff`.

## Using the declaration checker

`checkDeclarations(analysis, modes)` checks the declarations of every module in topological order. The `analysis` value comes from `analyzeProject`. The `modes` value maps a `ValueId` to `"pure"` or `"effect"`. It is optional.

The result holds one shared type table and one entry for each module. A module entry holds the declarations, the signatures, the interface, and the sorted declaration diagnostics. The result also holds all diagnostics of the project, sorted and without duplicates.

A function with a nonempty `fails` or `uses` set always has effect mode. A function with empty sets needs an entry in `modes`, because its body decides the mode. Without the entry, the `interface` field of the module is an error value. The diagnostics do not depend on `modes`.

A module interface holds `exports`, `values`, `types`, `errors`, and `services`. It also holds each declaration that an export reaches, private or from another module. Part A3b builds interfaces with `buildInterface` after it knows the modes. The hash covers the content without source spans.

## Using the body checker

`checkProject(host, root, entries)` loads and resolves a project, then checks every module in topological order. It returns an error value only for a bad project file. Every other problem is a diagnostic. `checkAnalysis(analysis)` does the same for an analysis that exists already.

For each module, the result holds `declarations`, `functions`, `constants`, `modes`, `initialization`, `interface`, `hash`, and `diagnostics`. A module sees the finished interfaces of the modules that it imports. These interfaces carry the computed execution modes. The `modes` map holds the invocation mode of every function.

Each function and constant has a body table. The table maps a syntax node id to `{ type, failures, requirements, mode }`. The failure and requirement sets are sorted. The table maps each local identity to its type.

The table also maps a node id to a fact that lowering needs. A call node has the fact `call`, `perform`, `error-construction`, `brand-construction`, `unbrand`, `some`, `fail`, `retry`, `provide`, or `builtin`. A `builtin` fact carries the closed function type of the `map`, `filter`, or `fold` use. A field read, an arrow, a block binding, a pattern, and a catch handler have facts too.

A module constant needs a pure initializer with empty sets. The `initialization` value lists the constants in a safe order. It also lists the dependencies of each constant and every dependency cycle.

`typeAt(check, path, offset)` returns text for the innermost checked node at an offset. A function name gives its signature, for example `getUser(id): User fails StoreUnavailable | UserMissing uses Users.find`. Any other node gives its type and its sets. Sets print in sorted identity order.

A declaration with a syntax error is checked, but its body diagnostics are not published. The parser has reported the syntax error already. This rule prevents cascades from a half-parsed body.

## Using the lowering

`lowerModule(checked, module)` returns the typed IR of one module, as a `Result`. The `checked` value comes from `checkProject`. The function returns an error value that names the module in five cases. The cases are an unknown module, a `.effi` file, and a diagnostic. A missing imported interface and a form without IR are the other two.

`lowerProject(checked)` does this for every `.eff` module. A `.effi` module has no entry, because it emits nothing.

The IR holds the declarations in source order, the sorted export identities, and one `Import` for each import declaration. The `module` of an `Import` is the module name for a relative import. It is the import string, such as `host:providers`, for a host import. A module that uses `map`, `filter`, or `fold` has one more `Import` with the module `effective:prelude`.

Each distinct closed instance of a builtin gets the identity `value:<module>#$builtin/<name>/<hash>`. The hash is the first 12 hex digits of the SHA-256 of the canonical JSON of the closed function type. A pipeline lowers to a block with the generated bindings `$p1`, `$p2`, and so on. A generated binding and each reference to it carry the span of the left expression. Each call carries the span of its stage.

`serializeModule(ir)` returns the canonical JSON text: sorted object keys, two-space indentation, and a trailing newline. It returns an error value when an effect set is not sorted and unique or when a number literal is not finite.

## Using the validator

`validateModule(ir, sources)` returns the validation diagnostics of one module. The `sources` value maps each source identifier to its text. An empty list means that the module is valid. The diagnostics are sorted and carry the IR path of the node, for example `declarations[2].body.arguments[0]`.

`validateProject(project, lowered)` validates each module in the map that `lowerProject` returns. It reads the source texts from the parse trees of the project. A module that did not lower has no entry in the result. The command `build --validate` calls this function.

The validator recomputes types, failure sets, requirement sets, and execution modes from the children of each node, with the equations of the spec. It compares the result with the recorded annotation. After a disagreement it continues with the recomputed value, so one fault gives one diagnostic. It reimplements type compatibility and does not call the checker. A test checks that `src/core/validate/` imports only `ir.ts`, `source.ts`, and `diagnostics.ts`.

Each code names a validation area. `validation/001` is Identity, `002` is Types, `003` is Contracts, `004` is Execution, `005` is Recovery, `006` is Control, `007` is Initialization, and `008` is Serialization. The registry in `src/core/diagnostics.ts` describes each code.

A mutation fixture in `fixtures/validate/` is a lowered example IR with one change. `manifest.json` names the expected code, the IR path, and the source texts of each fixture. Run `deno task validate:update` to write them again. A test compares the files on disk with the regenerated files.

Known limit: a `retry` or `provide` pipeline stage with an effectful left value keeps the checker sets in the lowered IR. The validator reports it. No example uses that form.

## Using the emitter

`emitModule(ir, { config })` returns the TypeScript text of one module, as a `Result`. The `config` value is the project configuration, `checked.analysis.project.config`. It gives the paths of the host modules. The function reads only the IR and the configuration. It writes no file.

The result holds `module`, `path`, `text`, and `spans`. The `path` is the generated file next to the source, for example `users.ts`. The `spans` list holds the generated range of each printed declaration and expression, with its source span. Part A6b builds the span table and the source map from it.

`emitProject(lowered, { config })` emits every module of the map that `lowerProject` returns. A module that did not lower gives a `lowering` error value. Expected failures are error values with the tag `unsupported` or `internal`.

An import of another module becomes a relative `.ts` specifier. A host import becomes a relative path to the host module of `effective.json`. The emitter checks the host module against the registry: `const UsersLive$host: Layer.Layer<Users> = UsersLive`. The code for `provide` uses the `$host` constant.

The emitter adds `export` to each declaration that the source exports and to each declaration that an exported interface reaches. It never renames a source name. It gives its own names, such as `$t0`, `$int`, and `Option$1`, only when no source name is taken.

The printer has one fixed style, and `deno fmt` leaves its output unchanged (decision D12). Two slow tests check this: one runs `deno fmt --check` on `fixtures/golden/`, and one runs it on the emitted programs of `fixtures/emit/forms/`. The printer breaks a long binary expression and an arrow chain with a broken head as `deno fmt` does. The ledger in `docs/phase-a-rules.md` lists the layouts and the two forms that are not yet at a fixed point.

The slow tests copy a fixture project to a temporary directory and build there. They check the emitted code with `deno check` under `effect@4.0.5` with strict settings. They run the emitted code with `deno run`. They need the npm package in the Deno cache, so the first run needs network access.

To change the output on purpose, edit the emitter and run `deno task golden:update`. Then read the diff of `fixtures/golden/`.

## Using the span table and the source map

`buildSpanTable(emitted, importSpans)` returns the span table of one emitted module. The table holds the generated ranges with their source spans, nested from the outside in. `importSpans` maps the name that the `.eff` source binds in a host import to the span of that name. Get it with `hostImportSpans(project).get(emitted.module)`.

`mapGenerated(table, line, column)` returns the source span of a generated position, or `undefined`. The line and the column are one-based, in UTF-16 units. `mapOffset(table, offset)` does the same for a zero-based offset. The innermost record that contains the position wins. A position outside every record has no span. The header, the imports, and the host assertions are outside every record.

`buildSourceMap(table, sourceTexts, options)` returns a version 3 source map as a `Result`. The `sourceTexts` value maps each source path to its text. `serializeSourceMap(map)` returns the text of the `.ts.map` file. The emitted `.ts` text ends with the line `//# sourceMappingURL=<file>.map`, so a written `.ts.map` file takes effect. `decodeMappings` and `lookupMapping` read a map back. `encodeVlq` and `decodeVlqList` are the base64 VLQ coding.

## Using the host-boundary mapping

`parseDenoCheck(text, root)` reads the text that `deno check` prints. It returns the TypeScript diagnostics, each with a root-relative file, a one-based line and column, the TypeScript code, and the message. Lines that belong to no diagnostic go to `other`.

`mapTscDiagnostic(diagnostic, tables, hosts)` maps one diagnostic. The `tables` value maps each generated path, such as `main.ts`, to its span table. The `hosts` value comes from `hostModulePaths(config)` and maps each host module path to its registry key. The result has one of four tags:

| Tag             | Meaning                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-boundary` | The position lies on a host assertion constant. The diagnostic has the code `host-boundary/001` and the span of the imported name in the `.eff` import. |
| `host-module`   | The position lies in a registered host module. The CLI prints it with the code `host-boundary/001` at that position.                                    |
| `source`        | The position lies inside a printed node. The result has the innermost source span. This probably means a defect of the emitter.                         |
| `generated`     | The file has no span table and is not a host module, or the position lies outside every record. The result keeps the generated position.                |

The fixture `fixtures/host-boundary/users-live-missing-method/` holds a wrong `users-live.ts`. A slow test copies the examples to a temporary directory, replaces `users-live.ts`, and runs `deno check`. It requires exactly one diagnostic: `host-boundary/001` on `UsersLive` in the import of `main.eff`. The directory also holds two captured outputs of `deno check` for the parser tests.

## Using the program

`new Program(root)` holds the state of one project across revisions. `program.update({ set, remove })` applies file changes and starts a revision. The `set` value maps root-relative paths to texts. The `remove` value lists deleted paths.

The program reads its files only from these calls, so it needs no `SourceHost`. Every `.eff` file in the set is an entry. The call returns a `Result`. A missing or invalid `effective.json` is an error value, and no revision starts.

A `Revision` answers one query for each module name: `checkedModule`, `lowered`, `emitted`, `spanTable`, and `sourceMap`. It also holds `diagnostics`, `interfaceHash`, and `rechecked`. The `rechecked` list names the modules that this revision checked again, in topological order. It includes the host interface modules.

The IR, the emitted text, the span table, and the source map are computed on first use. A module that is not checked again and not lowered again returns the same objects as in the revision before.

The program has three memos. The parse memo keeps the syntax tree of a file whose text is equal. The check memo keeps a checked module when its key is equal. The lowering memo keeps the IR and the emitted values when the lowering key is equal.

The check key holds five items: the text of the module, its path, the project configuration, and the analysis diagnostics of its file. The fifth item is the interface hash of each module that it reaches. The program calls the same per-module steps as `checkAnalysis`, in the same order. A revision therefore equals a run from scratch. The test `tests/db_test.ts` compares both after each edit of a sequence.

The lowering key holds the hash of the full interface payload of each reached module. The IR import of a module carries source spans of the imported declarations. An edit that only moves such a declaration keeps the interface hash, so the importer is not checked again. The program builds the interface of the importer again and lowers the importer again.

One `TypeTable` lives as long as the program, so reused modules keep valid type references. The table only grows. Its memory growth in a long watch session is measurement M4.

`src/core/mod.ts` re-exports the program and the pipeline functions. It also re-exports the span table and source map builders, the `deno check` parser and mapper, and the diagnostic types with `describeCode`. The IR types are in the list too.

## Using the command line

Run `deno task effective <command> [root] [flags]` from the repository root. The task runs in the repository directory, so pass an explicit root, for example `fixtures/examples`. The default root is the current directory.

| Command                                       | What it does                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `deno task effective check [root]`            | Prints the diagnostics of the project.                                                                    |
| `deno task effective build [root]`            | Also writes `<module>.ts` and `<module>.ts.map` next to each source for every module without an error.    |
| `deno task effective build [root] --validate` | Also runs the IR validator and prints its diagnostics.                                                    |
| `deno task effective build [root] --tsc`      | Also runs `deno check` over the written files and the host modules, and maps each error to the source.    |
| `deno task effective watch [root] [--tsc]`    | Builds once, then builds again after each change of a source file. It prints the modules that it checked. |

The root is the project directory with `effective.json`. The modules are the `.eff` files under the root, found by a recursive walk. The walk skips directories whose names start with `.` and directories named `node_modules`. The `.effi` files come from `effective.json`.

A diagnostic prints as `path:line:column: error code: message`. The path is relative to the root. The line and the column are one-based, and the column counts UTF-16 code units. The tool sorts the lines by path, position, and code.

The message is one line. Stdout holds only diagnostics. A summary line and all other messages go to stderr.

The exit code is 0 when there is no diagnostic, 1 when there is at least one, and 2 for a usage or configuration error. A usage error is an unknown command or flag, an extra argument, or a missing root directory. A configuration error is a missing or invalid `effective.json`.

`build` writes a module only when it has no error. A module with an error keeps its last good `.ts` and `.ts.map` files. The tool writes a file only when its text changes. `--validate` runs `validateProject` on the lowered IR. A module with a validation diagnostic is not written.

`--tsc` runs `deno check` with a generated configuration. The configuration sets strict mode, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. It maps `effect` to `npm:effect@4.0.5`. The tool writes the configuration to a temporary directory and removes it after the run. It passes `--no-lock`, so the project directory gets no new file.

The tool skips `deno check` when the build has an error. A `host-boundary` result prints as a normal diagnostic. A host-module error prints as `<hostfile>:<line>:<column>: error host-boundary/001: <message>`. A source error prints at the `.eff` position. A generated error prints at the generated position. Both use the code `TS<number>`.

A line that belongs to no diagnostic goes to stderr. Any `deno check` diagnostic gives exit code 1.

`watch` reads the root again after each batch of file events. It gives the program the files that changed. When no file changed, it prints nothing. A batch joins the events that arrive within 100 milliseconds of the previous event.

After each build, `watch` prints `rechecked: <modules>` to stderr, then the diagnostics. A broken `effective.json` prints an error, and the loop goes on. At start, a broken `effective.json` gives exit code 2. The loop takes its event source as a parameter, so a fast test drives it with a fake source.

`main(args, io)` in `src/cli/main.ts` returns the exit code. The `io` value gives the stdout and stderr writers, the file system, the `deno check` runner, and the watch source. The fast tests in `tests/cli_test.ts` run `main` with in-memory doubles from `tests/cli_helpers.ts`. The slow tests in `tests/cli_slow_test.ts` run the real tool.

## Language server

The language server is in `src/lsp/`. It wraps `Program` from the core. Run `deno task lsp` from the repository root to start it. The task runs `deno run --allow-read --allow-write src/lsp/main.ts`.

The server talks to its client over standard input and output. A message is a frame: a `Content-Length: <n>` header line, an empty line, and a JSON body of `n` bytes. The server writes only frames to stdout. It writes log text to stderr or sends `window/logMessage`.

The `exit` notification ends the process. End of input ends it too. The exit code is 0 after `shutdown` and 1 without it.

### Capabilities

The server announces `positionEncoding: "utf-16"`. It supports these features.

- Incremental text sync. A change event without a range replaces the whole text.
- Diagnostics. The server publishes `textDocument/publishDiagnostics` after each compile. The `code` field holds the code of the diagnostic, for example `failure-contract/001`. The `source` field is `effective`.
- Hover. The text has the source contract of the node. On the name of a function or constant, it also has the backend type, which is the TypeScript signature that the emitter prints. When the module has errors, the backend line says that it is not available.
- Definition. The server resolves types, errors, services, values, providers, service methods, and local bindings. It also finds declarations in `.effi` files. A builtin, a builtin type, and a field have no definition.
- Document symbols. The result lists the declarations of the file in source order, with service methods as children. A file with syntax errors still has a symbol for each declaration whose name parsed.

Diagnostics follow a fixed order. The server publishes each open document of the project first, sorted by path. It then publishes each closed file whose list changed. A closed file with an unchanged list gets no message.

### Custom methods

The names are in `src/lsp/methods.ts`. Each request takes the params `{ textDocument: { uri } }`. The URI selects the project, as for every other request.

| Method                          | Kind         | Result                                                                                                                                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effective/generatedTypeScript` | Request      | `{ text, stale }` or `null`. The text is the emitted module. When the module has errors, the text is the last good output and `stale` is true. The result is `null` if it never emitted.                     |
| `effective/generatedChanged`    | Notification | The params are `{ uri }`, the URI of the `.eff` source. The first `effective/generatedTypeScript` request for a module subscribes it. The server sends this message when its text or its stale flag changes. |
| `effective/stats`               | Request      | `{ revision, rechecked, counts, delta, memory }`, or `null` for a document with no project. The measurements M3 and M4 use it.                                                                               |

In the `effective/stats` result, `rechecked` lists the modules that the last compile checked again. The `counts` value holds the cumulative query counts `parses`, `checks`, `lowerings`, and `emits`. The `delta` value holds `interfaceChanged` and `modeChanged`, the modules whose interface hash or mode map changed in the last compile. The `memory` value holds `rss` and `heapUsed` in bytes.

### Options

The client passes `initializationOptions` with the `initialize` request. Both options are optional.

| Option        | Default | Meaning                                                                                            |
| ------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `debounceMs`  | `0`     | A finite number of at least 0. The delay in milliseconds before the server compiles after an edit. |
| `writeOnSave` | `true`  | A boolean. When true, a save writes the `.ts` and `.ts.map` files of the saved module.             |

A missing or invalid value takes the default. The server logs an invalid value. A request on a project with unsaved changes compiles first, so an answer never comes from an old revision.

### Projects, save, and configuration errors

A project is a directory with an `effective.json` file. When a document opens, the server walks up from its directory to the nearest `effective.json`. It keeps one `Program` for each project root. A document with no project gets no diagnostics, and its requests return `null`.

An open document overrides the disk text of its path. When the document closes, the server reads the disk text again. The client sends `workspace/didChangeWatchedFiles` for changes on disk. The server ignores such an event for an open document, because the editor owns that text.

On `textDocument/didSave` of an `.eff` file, the server compiles first. Then it writes the files of the saved module only. It does not write other modules. A module with an error keeps its last good `.ts` and `.ts.map` files, as `build` does. A write failure goes to `window/logMessage`.

When `effective.json` is missing or invalid, the server publishes one diagnostic on `effective.json`, at line 0 and character 0. It keeps the last good revision for hover, definition, symbols, and generated text. It keeps the published diagnostics of the other files. The next good update clears the configuration diagnostic. Before the first good revision, each request on the project returns `null`.

### Known limits

- The server has no cancellation inside the core. `Program.update` runs as one synchronous call, and the server handles one message at a time. The plan, section 3, explains the reason. Measurement M1 measures the stall.
- Nested projects are not supported. The disk walk of an outer project also reads the files of an inner project, so one file can belong to two programs.
- An `.effi` file that no `.eff` module imports is not in the module graph. For such a file, the server gives document symbols only. Hover and definition return `null`.
- A generated `.ts` file has no go-to-definition into the `.eff` source.
- The server has no completion, semantic tokens, rename, references, or code actions.

## VS Code client

The client is in `editors/vscode/`. It is plain JavaScript with no build step. It starts the language server, adds syntax highlighting, and adds the command `Effective: Show Generated TypeScript`. Its README, `editors/vscode/README.md`, lists the settings and the versions.

Run `npm ci` once in `editors/vscode`. Then start VS Code with the extension and the example files. Replace `<repo>` with the path of this repository.

```sh
code --extensionDevelopmentPath=<repo>/editors/vscode <repo>/fixtures/examples
```

A fast test, `tests/vscode_client_test.ts`, checks `package.json`, the grammar, and the method names. No automated test covers the user interface of the client.

## Measurements

The harnesses in `bench/` follow the measurement protocol of the design (section 10). They run on this machine and print plain text tables on stdout. Run every command from the repository root.

| Command                                                       | What it does                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deno task bench`                                             | Runs all six measurements at the quick scale. The quick scale aims at less than one minute for each. |
| `deno task bench --full`                                      | Runs the same measurements with larger iteration counts and more pairs.                              |
| `deno task bench m1`, `m2`, `m3`, `m4`, `m5`, or `m6`         | Runs the named measurements. `m6` runs M2 and prints only the noise floor.                           |
| `deno task bench --no-variants`                               | Skips the optional M5 variants.                                                                      |
| `deno task bench --json <file>`                               | Also writes the raw samples to the file.                                                             |
| `deno run --allow-write bench/generate.ts <size> <directory>` | Writes a synthetic project of the size `small`, `medium`, or `large`.                                |

`--quick` is the default. `--full` changes only the iteration counts, the step counts, and the number of pairs. The three sizes stay the same: 30, 300, and 3000 declarations. The bench task passes `--no-lock`, so the optional variants never change `deno.lock`. The harness leaves nothing in the working tree. It uses temporary directories and removes them.

### What each measurement decides

M2 times the whole-module recheck for each stage: lex, parse, index, link, resolve, check, lower, emit, and validate. It also replays a body edit and an interface edit through `Program.update` and prints the modules that each revision checked again. M2 decides whether Phase B needs declaration-level tracking (design section 4.5). It also decides whether typed arrays pay for tokens and whether a Zig port is worth its cost.

M5 times a cold `deno check` over the emitted five examples and the three synthetic sizes. It uses the configuration that `effective build --tsc` generates, with `effect` mapped to `npm:effect@4.0.5`. M5 decides the oracle runner and whether `watch --tsc` can default to on.

M5 also tries three optional variants: `tsc` as a cold process, a warm `ts.LanguageService` in the same process, and `tsgo` from `@typescript/native-preview`. The harness installs them into a temporary workspace with `deno install`. The first run needs network access. A variant that cannot run is skipped, and the report names the reason.

M6 gives the noise floor. Each iteration runs two sides, A and B, of the same build. The order of the sides alternates. The floor is the 90th percentile of the absolute value of `A/B - 1` over the pairs, in percent. A later A/B difference below the floor of its row counts as null. M6 uses the pairs of M2 and M5, so every row of M2 and M5 shows its floor in the column `floor %`.

M1 gets its floor from the A/B pairs of its own steps.

Measure the floor again when the machine or its load changes.

M1, M3, and M4 run the real language server as a subprocess. All three replay the same edit script. The harness opens only the edited document. It starts the server with `writeOnSave` false and `debounceMs` 0.

M1 times the path from an edit to its diagnostics. The time runs from just before the write of `textDocument/didChange` to the receipt of the matching `publishDiagnostics`. Then M1 times one hover on a fixed function name. Two server processes, A and B, run the same script, and the side that goes first alternates. M1 reports a distribution and the noise floor for each row.

M1 decides the debounce time and whether the server needs a worker thread or can stay on the main thread. It also gives the baseline for the latency budget D9. The design needs this baseline before it sets the budget.

M3 counts the work that one edit causes. After each step, the client sends `effective/stats`. M3 reports the median and the maximum of the per-step change in the counts `parses`, `checks`, `lowerings`, and `emits`. It also reports the fraction of steps with an interface change and with a mode change.

M3 runs no hover, so the counts show the compile alone. The counts are exact, so M3 has no noise floor. M3 decides whether Phase B needs declaration-level tracking. It also informs the later review of the mode firewall (D8).

M4 measures the memory of the server over a long script. It runs two servers, A and B, on the medium size. The script repeats the four edit kinds for N steps, and each row starts a new pair of servers. After each step, the client reads `rss` from `effective/stats`. A row shows the peak `rss` of each side and the `rss` after the last step.

M4 samples `rss` only at the end of a step, so it does not see a short peak inside a step. M4 decides the release policy for old revisions: whether the memory of a long session stays flat or grows.

### The edit script

The script makes one edit in each step and sends it as a full-text `didChange`. The edited module is the module with the edit target. After each step, the diagnostic list of the edited file must be empty. Any other list stops the run with an error value, and the run prints no time.

On the synthetic sizes, there are four kinds of edit.

| Kind     | What the edit does                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`   | Changes the literal in the body of `bump`. The interface of the module does not change.                                                             |
| `header` | Toggles the annotated type of the constant `extra` between `int` and `number`. The interface hash changes.                                          |
| `alias`  | Toggles the type alias `Amount` between `int` and `number`. The exported function `scale` names the alias, so the interface hash changes.           |
| `flip`   | Toggles the body of the function `flip` between `n + 1` and `retry(() => n + 1, { times: 1 })`. The mode of `flip` changes between pure and effect. |

For the five examples, the script has only the body edit. It changes the string literal in `displayName` of `users.eff` from `"Guest"` to `"Guest<n>"`, where `<n>` is a number that is new in each step. The hover of M1 names `displayName` on the examples and `bump` on the synthetic sizes.

### Protocol

Each M2 run ends with a checksum of the emitted text. Every run must give the same checksum, or the run stops with an error and prints no time. The first runs of each size are warm-ups, and the report drops them. Each row is a distribution: `n`, `min`, `p10`, `median`, `p90`, and `max`. The harness never reports a best of N. The rows of M2 pool the runs of both sides.

The stage `parse` includes `lex`, because the parser lexes its own input. The row `total` is the sum of every stage except `lex`. M5 ends one generated file with a unique comment before each sample, so that `deno check` cannot answer from its type-check cache. The column `control` shows a repeat on unchanged input.

The token representation test of the design (object arrays against typed arrays) is not run. The lexer has only the typed-array form, so the comparison needs a second lexer. `docs/rejected.md` records this gap.

M1 and M3 run on the examples and on the three synthetic sizes. M4 runs on the medium size. The step counts of the quick and the full profile are in `bench/profile.ts`.

A number from a run enters the README, the docs, or the ledger only with its noise floor, its size, and its number of samples. The user decides what to record. The timer is `performance.now()`, and the process is not pinned to a core, because macOS has no `taskset` equivalent.

## Error fixture convention

An error fixture is a file in `fixtures/errors/` or a project directory in `fixtures/errors/`. Its name is `<category>-<topic>`, where the category is a diagnostic category such as `syntax` or `module`. A host interface file error uses the extension `.effi`.

A single file runs as a project with one module and an empty project file. A file whose name starts with `syntax-` only goes through the parser.

A project directory holds its own `effective.json` and the files of the case. The test loads every `.eff` file of the directory as an entry. A host interface file must have an import that reaches it.

A line that contains only `// error: <code>` marks one expected diagnostic. The diagnostic span must start on the line directly below the marker. A diagnostic code looks like `syntax/008`.

Several marker lines in a row all apply to the first line below the run. The test compares the sorted list of file, line, and code. The case must produce exactly the marked diagnostics and no others.

A missing token has an empty span. The span sits at the end of the last real token. The marker goes above the incomplete line.

The files `fixtures/parse/recovery-*.eff` use the same markers. The files `fixtures/parse/ok-*` and the files in `fixtures/examples/` must parse with no diagnostics. The project files `fixtures/examples/effective.json` and `fixtures/ir/effective.json` set the module roots.

## Format and lint scope

`deno fmt` skips `docs/`, `src/core/ir.ts`, `editors/vscode/node_modules/`, and every `.eff` and `.effi` file. The copy of `ir.ts` stays as it is in the sibling repository. `deno fmt` checks `fixtures/golden/`. `deno lint` skips `docs/` and `fixtures/golden/`, because generated code keeps unused handler parameters. It also skips `editors/vscode/`, which holds plain JavaScript.

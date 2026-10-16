# effective-lang

Effective is a small functional language that transpiles to Effect-TS 4. This repository holds the transpiler core library and, in later parts, its command-line tool.

The design is in `docs/transpiler-design.md`. The Phase A plan is in `docs/plans/2026-10-16-phase-a.md`. The plan splits the work into parts A1 to A8.

## Status

Parts A1, A2, A3a, A3b, A4, A5, and A6a exist. Part A1 adds the project skeleton, the lexer, a lossless parser with error recovery, and the `syntax` diagnostics. The parser reads `.eff` source files and `.effi` host interface files.

Part A2 adds the declaration index, the project loader, the module graph, and the name resolver. It adds the diagnostic codes `unknown-name`, `module`, and `declaration`.

Part A3a adds the declaration level of the checker. It adds the type intern table, the compatibility rules, function and provider signatures, and module interfaces with hashes. It adds the codes `type-mismatch/001`, `type-mismatch/002`, and `declaration/005` to `declaration/011`.

Part A3b adds body checking. It checks every function and constant body, infers effects and execution modes, and checks contracts, patterns, `try` and `catch`, `retry`, and `provide`. It builds the module initialization graph and the `typeAt` query. It adds the codes `type-mismatch/003` to `type-mismatch/011`, `failure-contract/001` to `/003`, `requirement-contract/001`, `execution-mode/001` to `/004`, `pattern/001` to `/004`, and `module/004`.

Part A4 lowers a checked module to typed IR and serializes it. It adds a synchronous SHA-256 for builtin identities.

Part A6a adds the Effect-TS emitter. It turns the IR of each module into the text of one TypeScript module. It adds the five golden files, the host module `users-live.ts`, and the slow tests that check and run the emitted code. The span table, the source map, and the `deno fmt` check of the golden files belong to part A6b. The command-line tool does not exist yet.

Part A5 adds the independent IR validator. It recomputes every annotation of a module from the IR and the source texts, and it reports each disagreement with its validation area. It adds the category `validation` with the codes `validation/001` to `validation/008`, and the mutation fixtures in `fixtures/validate/`.

## Requirements

The project needs Deno 2.9.7. The first test run downloads `@std/assert` from jsr, so it needs network access once.

## Commands

Run every command from the repository root.

| Command                     | What it does                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `deno task check`           | Runs the format check, the lint, the type check, the fast tests, and the slow tests.  |
| `deno task test`            | Runs the fast tests. It skips files named `*_slow_test.ts`.                           |
| `deno task test:slow`       | Runs only files named `*_slow_test.ts`. They run `deno check` and `deno run`.         |
| `deno task golden:update`   | Writes `fixtures/golden/<module>.ts` again from `fixtures/examples`.                  |
| `deno task validate:update` | Writes the mutation fixtures in `fixtures/validate/` again from the current lowering. |
| `deno task fmt`             | Formats the source files.                                                             |
| `deno task lint`            | Runs the linter.                                                                      |

The tasks `effective` and `bench` do not exist yet. Later parts add them.

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
    doc.ts         The printer: documents, layout at 80 columns, span tags.
    scope.ts       Names, fresh names, imports, host bindings, specifiers.
    types.ts       The type printer and the schema printer.
    expr.ts        The expression scheme: pure, inGen, asEffect.
    decls.ts       Declarations, their order, and the export rule.
    walk.ts        Traversals of the IR.
scripts/       Scripts that the tasks run. golden_update.ts writes the golden files.
               validate_fixtures.ts writes the mutation fixtures.
tests/         Deno tests and test helpers.
fixtures/      Input files for the tests.
  examples/      The five example programs, the host interface file, and users-live.ts.
  golden/        The expected emitted TypeScript of each example.
  emit/forms/    Extra programs for the emitter tests. They are not golden examples.
  ir/example/    The log example and its IR fixture.
  validate/      Mutated copies of lowered IR and manifest.json, which names the expected code of each.
  parse/         Valid syntax forms (ok-*) and recovery inputs (recovery-*).
  errors/        One file or one project directory for each error case, with markers.
docs/          Design and plans.
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

`lowerModule(checked, module)` returns the typed IR of one module, as a `Result`. The `checked` value comes from `checkProject`. The function returns an error value that names the module in these cases: the module is unknown, it is a `.effi` file, it has a diagnostic, an imported interface is missing, or a form has no IR. `lowerProject(checked)` does this for every `.eff` module. A `.effi` module has no entry, because it emits nothing.

The IR holds the declarations in source order, the sorted export identities, and one `Import` for each import declaration. The `module` of an `Import` is the module name for a relative import. It is the import string, such as `host:providers`, for a host import. A module that uses `map`, `filter`, or `fold` has one more `Import` with the module `effective:prelude`.

Each distinct closed instance of a builtin gets the identity `value:<module>#$builtin/<name>/<hash>`. The hash is the first 12 hex digits of the SHA-256 of the canonical JSON of the closed function type. A pipeline lowers to a block with the generated bindings `$p1`, `$p2`, and so on. A generated binding and each reference to it carry the span of the left expression. Each call carries the span of its stage.

`serializeModule(ir)` returns the canonical JSON text: sorted object keys, two-space indentation, and a trailing newline. It returns an error value when an effect set is not sorted and unique or when a number literal is not finite.

## Using the validator

`validateModule(ir, sources)` returns the validation diagnostics of one module. The `sources` value maps each source identifier to its text. An empty list means that the module is valid. The diagnostics are sorted and carry the IR path of the node, for example `declarations[2].body.arguments[0]`.

`validateProject(project, lowered)` validates each module in the map that `lowerProject` returns. It reads the source texts from the parse trees of the project. A module that did not lower has no entry in the result. Part A7 wires this function to `build --validate`.

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

A manual run of `deno fmt` left the five golden files unchanged. Part A6a has no test for this. Part A6b adds the test and removes the exclusion of `fixtures/golden/` from `deno fmt`.

The slow tests copy a fixture project to a temporary directory and build there. They check the emitted code with `deno check` under `effect@4.0.5` with strict settings. They run the emitted code with `deno run`. They need the npm package in the Deno cache, so the first run needs network access.

To change the output on purpose, edit the emitter and run `deno task golden:update`. Then read the diff of `fixtures/golden/`.

## Error fixture convention

An error fixture is a file in `fixtures/errors/` or a project directory in `fixtures/errors/`. Its name is `<category>-<topic>`, where the category is a diagnostic category such as `syntax` or `module`. A host interface file error uses the extension `.effi`.

A single file runs as a project with one module and an empty project file. A file whose name starts with `syntax-` only goes through the parser.

A project directory holds its own `effective.json` and the files of the case. The test loads every `.eff` file of the directory as an entry. A host interface file must have an import that reaches it.

A line that contains only `// error: <code>` marks one expected diagnostic. The diagnostic span must start on the line directly below the marker. A diagnostic code looks like `syntax/008`.

Several marker lines in a row all apply to the first line below the run. The test compares the sorted list of file, line, and code. The case must produce exactly the marked diagnostics and no others.

A missing token has an empty span. The span sits at the end of the last real token. The marker goes above the incomplete line.

The files `fixtures/parse/recovery-*.eff` use the same markers. The files `fixtures/parse/ok-*` and the files in `fixtures/examples/` must parse with no diagnostics. The project files `fixtures/examples/effective.json` and `fixtures/ir/effective.json` set the module roots.

## Format and lint scope

`deno fmt` skips `docs/`, `src/core/ir.ts`, `fixtures/golden/`, and every `.eff` and `.effi` file. The copy of `ir.ts` stays as it is in the sibling repository. Part A6b removes the exclusion of `fixtures/golden/`. `deno lint` skips `docs/` and `fixtures/golden/`, because generated code keeps unused handler parameters.

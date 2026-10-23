# API and editors

This file describes the public interfaces of the core library, the command-line
tool, the language server, the VS Code client, and the playground. It also holds
the map of the source files. [Development](development.md) gives the commands
and the repository layout.

## Source file map

```
src/core/      The core library. It is synchronous and does no I/O. Program memoizes its queries.
  ir.ts          Typed IR model, copied from the sibling repository effective.
  source.ts      SourceHost, line tables, positions, and span helpers.
  file_diff.ts   diffFiles: the set and remove lists that turn one file map into another, for Program.update.
  diagnostics.ts Diagnostic type, the registry of codes, sort and dedupe.
  lex.ts         Lexer: typed arrays of tokens plus trivia.
  syntax.ts      Syntax tree types and the printer.
  syntax_queries.ts Pure child, type/pattern-kind, literal, operator, arrow-body and initializer queries shared by the front end.
  parse.ts       Parser with recovery.
  hash.ts        Synchronous content hash (FNV-1a 64).
  index.ts       Declaration index of one file: names, kinds, spans, hashes.
  project.ts     effective.json, module identity, module graph, cycles, order.
  resolve.ts     Names to identities, scopes, prelude, side table of targets.
  types.ts       Interned types, compatibility, IR conversion, canonical JSON.
  check.ts       Declaration checker: type lowering, signatures, providers.
  check_expr.ts  Body checker: expressions, calls, contracts, and the prelude dispatch.
  check_patterns.ts Match patterns, bindings, and coverage through PatternContext.
  check_binary.ts Pure operand rules and result types of the binary operators.
  check_builtins/ Source-checker builtin families; shared dispatch and body-table writes stay in check_expr.ts.
    context.ts     Shared argument, function, literal-field and local-use shapes, invocation effects, the shared views, and the checker operations.
    rows.ts        The row shape of a builtin: its prologue and its handler, and the prologue helpers.
    registry.ts    FAMILY_ROWS: the rows of all families, composed once.
    codec.ts       Codec construction, decode and encode, including pure transformations and derived-schema checks.
    collections.ts Collection callbacks, traversal, grouped effects and result accumulation through a family-specific context.
    effect.ts      Effect construction, execution, failures and retry options through EffectContext.
    fiber.ts       Fiber operations and inline borrow lifetimes through FiberContext.
    layer.ts       Layer construction, merging and provision through LayerContext.
    ref.ts         Mutable reference construction, reads, writes and pure update callbacks.
    schedule.ts    General Schedule construction, mapping and comparable-input composition.
    schema.ts      Schema metadata, exhaustive handlers, defaults, directional effects and recursion through SchemaContext.
    scope.ts       Scope operations, resource lifetimes and borrowed parameters through ScopeContext.
    stream.ts      Stream/Sink callbacks, grouping lifetimes, aggregation hints and execution through StreamContext.
  check_project.ts Project driver: paired declaration entries and body results, modes, interfaces, the shared per-module step, and effectText.
  tables.ts      Side tables of a body: node info and lowering facts.
  patterns.ts    Pattern domains of match subjects.
  modes.ts       Strongly connected components and the mode fixed point.
  initialization.ts Eager dependency graph of module constants.
  interface.ts   Module interfaces, their hashes, and the reachable modules.
  analyze.ts     Public entry: load a project, resolve it, collect diagnostics.
  db.ts          Program: revisions, parse memo, check memo with module cutoff, lazy IR, text, and maps.
  editor.ts      hoverAt, definitionAt, and documentSymbols over a revision.
  editor_index.ts Revision-scoped resolver identities, occurrences and lexical scopes.
  editor_rename.ts References, prepare-rename and re-resolved rename edits.
  diagnostic_delta.ts Diagnostics that an edit adds and removes, by code, source, and moved span.
  editor_completion.ts Visible names, record fields and service-method completion.
  editor_tokens.ts Semantic classifications with lexical recovery.
  editor_actions.ts Validated missing fails/uses actions from checked body effects.
  ids.ts         Parts of a declaration identity: module, name, and method.
  util.ts        Small pure helpers of the front end and the edges: compareText, errorMessage, and isRecord.
  mod.ts         The public API of the core: a list of re-exports.
  sha256.ts      Synchronous SHA-256 over the UTF-8 bytes of a string.
  lower.ts       Checked modules to typed IR: pipelines, builtin specialization, imports.
  serialize.ts   Canonical JSON of a module IR, with the set and number checks.
  validate/      The independent IR validator. It imports only ir.ts, source.ts, and diagnostics.ts.
    index.ts       validateModule: the public entry.
    world.ts       Identities in scope, imports, declaration headers, recursive types.
    expr.ts        Bottom-up recomputation of types, sets, and modes of each body.
    expr_walk.ts   The child expressions of a node, and a walk over them.
    families/      The builtin families of the validator, behind the validator-owned ValidatorCore in context.ts.
    typing.ts      Type compatibility, including the lift rule.
    type_children.ts The child types of a type with their IR path suffixes: one descent for the type walkers.
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
    calls.ts       The simple calls: tables of the structural and leaf kinds that print as callee(operands).
    fields.ts      Own-field construction, optional reads and declared schema input adapters.
    shape.ts       The shape table of every IR expression kind: children, deferred children, and leaf effects.
    explicit_scope.ts Shared scope representation, service capture, and close completion.
    types.ts       The type printer and the schema printer.
    expr.ts        The expression scheme: pure, inGen, asEffect.
    decls.ts       Declarations, their order, and the export rule.
    walk.ts        Traversals of the IR.
src/cli/       The command-line tool. Deno APIs stay here, in src/host/, src/lsp/main.ts, bench/, playground/build.ts, playground/serve.ts, scripts/, and tests/.
  main.ts        main(args, io) returns the exit code, and the watch loop over an injected event source. The last lines wire the real io.
  args.ts        The command line: commands, root, and flags.
  session.ts     One project directory and one program: sync, then build.
  build.ts       One build: validate, write the files, run deno check.
  tsc.ts         The generated deno check configuration and the mapping of its output.
  format.ts      The output line of a diagnostic.
  report.ts      Printing of a build outcome: diagnostics on stdout, the rest on stderr.
src/host/      The host adapters that the command-line tool and the language server share.
  generation.ts  A tagged generation result over the revision's four lazy queries; the narrow source port of file writing.
  io.ts          The ports: file system, deno check runner, and watch source.
  deno_io.ts     The real ports: Deno file system, subprocess, and Deno.watchFs.
  workspace.ts   Source/configuration walks and separate local target-check inputs.
  events.ts      Debouncing of file system events.
  outputs.ts     writeGenerated: the write of the .ts and .ts.map files, shared by build and the language server.
  save_round.ts  runSaveRound: the removal of stale outputs and the write, with the removal rule of each caller.
src/lsp/       The language server. See "Language server".
  main.ts        The stdio entry: reads frames, writes frames, and ends the process.
  server.ts      LanguageServer: lifecycle, dispatch, and the flush schedule.
  projects.ts    Project discovery, the overlay's tagged update state, diagnostic flushes and disk-only save rounds.
  features.ts    The handlers: hover, definition, symbols, generated text, save, and stats.
  editor_features.ts References, validated versioned rename/actions, completion and full semantic tokens.
  jsonrpc.ts     Content-Length frames and the message shapes.
  protocol.ts    The subset of the protocol: types and the narrowing of incoming params.
  positions.ts   Positions, ranges, and the conversion between URIs and paths.
  methods.ts     The names of the custom methods, shared with the client.
editors/vscode/ The VS Code client. See "VS Code client". Plain JavaScript client; release packaging bundles the server.
playground/    The browser playground. See "Playground". The page is in src/, the build in build.ts.
scripts/       Scripts that the tasks run. golden_update.ts writes the golden files.
               validate_fixtures.ts writes the mutation fixtures.
               behavior_capture.ts records the hashed compiler behavior of a git revision.
               lex_snapshot.ts writes the lexer snapshot of the tracked .eff and .effi files in fixtures/lex.
               measure.ts counts branches and cyclomatic complexity of the files given.
               measure_functions.ts counts the same for each function.
               measure_kernel.ts holds the counting rules that both measure scripts share.
               package.ts builds deterministic local CLI/server bundles and a complete VSIX.
               package_vscode_smoke.ts tests the installed VSIX in isolated editor directories.
tests/         Deno tests and test helpers.
fixtures/      Input files for the tests.
  examples/      The five example programs, the host interface file, and users-live.ts.
  golden/        The expected emitted TypeScript of each example.
  emit/forms/    Extra programs for the emitter tests. They are not golden examples.
  host-boundary/ A wrong host module, captured deno check output, and manifest.json.
  ir/example/    The log example and its IR fixture.
  applications/  The four application witnesses: service-workflow, scheduled-worker, stream-processor, and order-lifecycle. The first three are the gate applications. order-lifecycle is a witness for nominal data types.
  host-adapter-files/ A project with a typed host adapter for effect/FileSystem.
  lex/           snapshot.json: hashes of the lexer output for a fixed corpus.
  validate/      Mutated copies of lowered IR and manifest.json, which names the expected code of each.
  parse/         Valid syntax forms (ok-*) and recovery inputs (recovery-*).
  errors/        One file or one project directory for each error case, with markers.
bench/         The measurement harnesses of parts A8 and L5. They are not part of the core.
  main.ts        The entry: arguments, profiles, and the report.
  profile.ts     The scale of --quick and --full.
  generate.ts    The synthetic module generator and the edit scripts.
  m1.ts          M1: edit latency through the language server.
  m3.ts          M3: work per edit, from the stats of the server.
  m4.ts          M4: three open documents, distinct edits, and RSS/heap/type-table growth.
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

The core reads files only through `SourceHost`. It calls no Deno API. Tests may
use Deno APIs.

## Using the parser

`parse(source, text, mode)` returns the syntax tree and the diagnostics. The
`source` value is the path that diagnostic spans carry. The `mode` value is
`"eff"` or `"effi"`. `fileModeOf(path)` picks the mode from the extension.

`printTree(tree)` prints the tree back to text. The result equals the input for
every input, including input with errors. Positions count UTF-16 code units, and
an end position is exclusive.

## Using the front end

`analyzeProject(host, root, entries)` loads a project, resolves every name, and
returns all diagnostics. The `host` value reads files. The `root` value is the
project directory. The `entries` value is a list of root-relative paths.

The function reads `effective.json` in the root. A missing or malformed file
gives an error value, not an exception. The function follows imports from the
entry files. Relative imports must end in `.eff`. The import `host:key` selects
a host interface file from `effective.json`.

The result holds the project, one resolution table for each module, and the
sorted diagnostics. The project holds the parse trees, the module graph, and the
topological order. A resolution table maps a syntax node id to its target. The
target is a declaration identity, a local identity, a prelude builtin, or a
builtin type.

A diagnostic span names its file by the root-relative path, for example
`users.eff`.

## Using the declaration checker

`checkModuleDeclarations(analysis, module, table, imported)` checks the
declarations of one module. The `analysis` value comes from `analyzeProject`.
The `table` value is the shared type table. The `imported` value maps each
reached module to its type graph. The project drivers `checkProject` and
`Program` call it for each module in topological order, through
`checkModuleStep` in `src/core/check_project.ts`.

The result holds the declarations, the signatures, and the sorted declaration
diagnostics of the module. `checkProject` returns one shared type table and one
entry for each module. Each entry holds the declarations, the interface, and the
sorted diagnostics of the module.

A function with a nonempty `fails` or `uses` set always has effect mode. A
function with empty sets needs an entry in the mode map, because its body
decides the mode. The body checker supplies the map. Without an entry,
`buildInterface` gives an error value. The declaration diagnostics do not depend
on the map.

Rule R1: a primitive type can occur only inside a type, data, or error
declaration. Each `string`, `int`, `number`, `boolean`, or literal type node
elsewhere gives `declaration/013`, in `.eff` and `.effi` files.

A module interface holds `exports`, `values`, `types`, `errors`, and `services`.
It also holds each declaration that an export reaches, private or from another
module. Part A3b builds interfaces with `buildInterface` after it knows the
modes. The hash covers the content without source spans.

## Using the body checker

`checkProject(host, root, entries)` loads and resolves a project, then checks
every module in topological order. It returns an error value only for a bad
project file. Every other problem is a diagnostic. `checkAnalysis(analysis)`
does the same for an analysis that exists already.

For each module, the result holds `declarations`, `functions`, `constants`,
`modes`, `initialization`, `interface`, `hash`, and `diagnostics`. A module sees
the finished interfaces of the modules that it imports. These interfaces carry
the computed execution modes. The `modes` map holds the invocation mode of every
function.

Each function and constant has a body table. The table maps a syntax node id to
`{ type, failures, requirements, mode }`. The failure and requirement sets are
sorted. The table maps each local identity to its type.

The table also maps a node id to a fact that lowering needs. A call node has a
fact such as `call`, `perform`, `error-construction`, `brand-construction`,
`data-construction`, `unbrand`, `some`, `fail`, `retry`, `provide`, or
`builtin`. The type `NodeFact` in `src/core/tables.ts` lists every kind. A
`builtin` fact carries the closed function type of a collection operation. A
bracket literal has a fact that selects array or tuple IR. A field read, an
arrow, a block binding, a pattern, and a catch handler have facts too.

A field read and a record update see through a data type, and an update keeps
the data type. A data type declares a nominal record with `data`. A brand cannot
have a record base (`declaration/014`). A data constructor pattern has a `data`
pattern fact, and a match over data and error types uses a nominal domain.

A module constant needs a pure initializer with empty sets. The `initialization`
value lists the constants in a safe order. It also lists the dependencies of
each constant and every dependency cycle.

`hoverAt(revision, path, offset)` returns text for the innermost checked node at
an offset. A function name gives its signature, for example
`getUser(id: UserId): User fails StoreUnavailable | UserMissing uses Users.find`.
Any other node gives its type and its sets. Sets print in sorted identity order.

A declaration with a syntax error is checked, but its body diagnostics are not
published. The parser has reported the syntax error already. This rule prevents
cascades from a half-parsed body.

## Using the lowering

`lowerModule(checked, module)` returns the typed IR of one module, as a
`Result`. The `checked` value comes from `checkProject`. The function returns an
error value that names the module in five cases. The cases are an unknown
module, a diagnostic, a missing imported interface, a form without IR, and an
internal fault. A `.effi` module lowers to its type, error, and service
declarations, and its IR exports each of them. Its providers are not lowered.

`lowerProject(checked)` does this for every `.eff` module. A `.effi` module has
no entry.

The IR holds the declarations in source order, the sorted export identities, and
one `Import` for each import declaration. The `module` of an `Import` is the
module name for a relative import. It is the import string, such as
`host:providers`, for a host import. A module that uses `map`, `filter`, `fold`,
`all`, or `traverse` has one more `Import` with the module `effective:prelude`.

Each distinct closed instance of a builtin gets the identity
`value:<module>#$builtin/<name>/<hash>`. The hash is the first 12 hex digits of
the SHA-256 of the canonical JSON of the closed function type. A pipeline lowers
to a block with the generated bindings `$p1`, `$p2`, and so on. A generated
binding and each reference to it carry the span of the left expression. Each
call carries the span of its stage.

`serializeModule(ir)` returns the canonical JSON text: sorted object keys,
two-space indentation, and a trailing newline. It returns an error value when an
effect set is not sorted and unique or when a number literal is not finite.

## Using the validator

`validateModule(ir, sources)` returns the validation diagnostics of one module.
The `sources` value maps each source identifier to its text. An empty list means
that the module is valid. The diagnostics are sorted and carry the IR path of
the node, for example `declarations[2].body.arguments[0]`.

`validateProject(project, lowered)` validates each module in the map that
`lowerProject` returns. It reads the source texts from the parse trees of the
project. A module that did not lower has no entry in the result. The command
`build --validate` calls this function.

The validator recomputes types, failure sets, requirement sets, and execution
modes from the children of each node, with the equations of the spec. It
compares the result with the recorded annotation. After a disagreement it
continues with the recomputed value, so one fault gives one diagnostic. It
reimplements type compatibility and does not call the checker. A test checks
that `src/core/validate/` imports only `ir.ts`, `source.ts`, and
`diagnostics.ts`.

Each code names a validation area. `validation/001` is Identity, `002` is Types,
`003` is Contracts, `004` is Execution, `005` is Recovery, `006` is Control,
`007` is Initialization, and `008` is Serialization. The registry in
`src/core/diagnostics.ts` describes each code.

A mutation fixture in `fixtures/validate/` is a lowered example IR with one
change. `manifest.json` names the expected code, the IR path, and the source
texts of each fixture. Run `deno task validate:update` to write them again. A
test compares the files on disk with the regenerated files.

## Using the emitter

`emitModule(ir, { config })` returns the TypeScript text of one module, as a
`Result`. The `config` value is the project configuration,
`checked.analysis.project.config`. It gives the paths of the host modules. The
function reads only the IR and the configuration. It writes no file.

The result holds `module`, `path`, `text`, `spans`, and `hostAssertions`. The
`path` is the generated file next to the source, for example `users.ts`. The
`spans` list holds the generated range of each printed declaration and
expression, with its source span. Part A6b builds the span table and the source
map from it.

`emitProject(lowered, { config })` emits every module of the map that
`lowerProject` returns. A module that did not lower gives a `lowering` error
value. Expected failures are error values with the tag `unsupported` or
`internal`.

An import of another module becomes a relative `.ts` specifier. An import of an
`.effi` declaration becomes a relative path to its companion module, such as
`host.effi.ts`. An opaque type and a provider come from the host module of
`effective.json`. The emitter checks provider imports against the registry:
`const UsersLive$host: Layer.Layer<Users> = UsersLive`. When a provided service
method returns a data value, the constant wraps the host Layer with run-time
checks ([host boundary checks](archive/plans/2026-10-23-host-boundary-checks.md)).
The wrapped constant keeps the same declared type.

The emitter also emits a companion module for each `.effi` file, such as
`host.effi.ts`. It holds the types, errors, data types, and services of the
interface, all exported, with the tags of the interface module. The TypeScript
host module imports these from the companion module. It supplies only the
opaque types and the providers
([companion module](archive/plans/2026-10-23-host-interface-companion.md)).

The emitter adds `export` to each declaration that the source exports and to
each declaration that an exported interface reaches. It never renames a source
name. It gives its own names, such as `$t0`, `$int`, and `Option$1`, only when
no source name is taken.

The printer has one fixed style, and `deno fmt` leaves its output unchanged for
the golden files and the emitter test programs (decision D12). Two slow tests
check this: one runs `deno fmt --check` on `fixtures/golden/`, and one runs it
on the emitted programs of `fixtures/emit/forms/`. The printer breaks a long
binary expression and an arrow chain with a broken head as `deno fmt` does.

The module `long-names.eff` in a deep directory of `fixtures/emit/forms/` has
long names and long strings. It covers seven forms that `deno fmt` rewrote: a
selector test of a `match` arm, a `Schema.Literal`, a brand, a type alias, and a
service header. Two more forms are a `Service.use` arrow and a `catchTags` key.
All seven reach the fixed point. The extreme-identifier regression also checks
the six formerly excluded forms: error type arguments, struct fields, function
names, member accesses, service bindings, and parameter annotations. It covers
273 generated modules at wrapping boundaries, including optional fields and
brand and Schema constructors. The checks verify formatting, strict TypeScript,
execution, evaluation once, and source mappings. The ledger in
`docs/language-rules.md` records the layout rules.

The module `conditional-chains.eff` in `fixtures/emit/forms/` has `match` and
`if` chains with a long test after the first. Then `deno fmt` joins the earlier
links on the first line when that line fits. The module also has the cases where
the join does not happen.

The slow tests copy a fixture project to a temporary directory and build there.
They check the emitted code with `deno check` under `effect@4.0.5` with strict
settings. They run the emitted code with `deno run`. They need the npm package
in the Deno cache, so the first run needs network access.

To change the output on purpose, edit the emitter and run
`deno task golden:update`. Then read the diff of `fixtures/golden/`.

## Using the span table and the source map

`buildSpanTable(emitted, importSpans)` returns the span table of one emitted
module. The table holds the generated ranges with their source spans, nested
from the outside in. `importSpans` maps the name that the `.eff` source binds in
a host import to the span of that name. Get it with
`hostImportSpans(project).get(emitted.module)`.

`mapGenerated(table, line, column)` returns the source span of a generated
position, or `undefined`. The line and the column are one-based, in UTF-16
units. `mapOffset(table, offset)` does the same for a zero-based offset. The
innermost record that contains the position wins. A position outside every
record has no span. The header, the imports, and the host assertions are outside
every record.

`buildSourceMap(table, sourceTexts, options)` returns a version 3 source map as
a `Result`. The `sourceTexts` value maps each source path to its text.
`serializeSourceMap(map)` returns the text of the `.ts.map` file. The emitted
`.ts` text ends with the line `//# sourceMappingURL=<file>.map`, so a written
`.ts.map` file takes effect. `decodeMappings` and `lookupMapping` read a map
back. `encodeVlq` and `decodeVlqList` are the base64 VLQ coding.

## Using the host-boundary mapping

`parseDenoCheck(text, root)` reads the text that `deno check` prints. It returns
the TypeScript diagnostics, each with a root-relative file, a one-based line and
column, the TypeScript code, and the message. Lines that belong to no diagnostic
go to `other`.

`mapTscDiagnostic(diagnostic, tables, hosts)` maps one diagnostic. The `tables`
value maps each generated path, such as `main.ts`, to its span table. The
`hosts` value comes from `hostModulePaths(config)` and maps each host module
path to its registry key. The result has one of four tags:

| Tag             | Meaning                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-boundary` | The position lies on a host assertion constant. The diagnostic has the code `host-boundary/001` and the span of the imported name in the `.eff` import. |
| `host-module`   | The position lies in a registered host module. The CLI prints it with the code `host-boundary/001` at that position.                                    |
| `source`        | The position lies inside a printed node. The result has the innermost source span. This probably means a defect of the emitter.                         |
| `generated`     | The file has no span table and is not a host module, or the position lies outside every record. The result keeps the generated position.                |

The fixture `fixtures/host-boundary/users-live-missing-method/` holds a wrong
`users-live.ts`. A slow test copies the examples to a temporary directory,
replaces `users-live.ts`, and runs `deno check`. It requires exactly one
diagnostic: `host-boundary/001` on `UsersLive` in the import of `main.eff`. The
directory also holds two captured outputs of `deno check` for the parser tests.

## Using the program

`new Program(root)` holds the state of one project across revisions.
`program.update({ set, remove })` applies file changes and starts a revision.
The `set` value maps root-relative paths to texts. The `remove` value lists
deleted paths.

The program reads its files only from these calls, so it needs no `SourceHost`.
Every `.eff` file in the set is an entry. The call returns a `Result`. A missing
or invalid `effective.json` is an error value, and no revision starts.

A `Revision` answers one query for each module name: `checkedModule`, `lowered`,
`emitted`, `spanTable`, and `sourceMap`. It also holds `diagnostics`,
`interfaceHash`, and `rechecked`. The `rechecked` list names the modules that
this revision checked again, in topological order. It includes the host
interface modules.

A `Revision` also answers read-only queries for the editor and the adapters, so
a caller needs no access to the project or the checker state. The getters
`root`, `config`, `types`, and `analysisDiagnostics` give the project root, the
project configuration, the read-only type table (`TypeReader`), and the
diagnostics of the analysis. `moduleInfos()` lists the module infos in discovery
order, and `moduleNames()` lists the names in topological order.
`moduleInfo(name)`, `moduleInfoAt(path)`, `checkedModuleAt(path)`,
`resolution(name)`, `imports(name)`, and `declEntry(id)` look up one item.
`validate(lowered)` runs `validateProject` with the project of the revision.

The IR, the emitted text, the span table, and the source map are computed on
first use. A module that is not checked again and not lowered again returns the
same objects as in the revision before.

The program has three memos. The parse memo keeps the syntax tree of a file
whose text is equal. The check memo keeps a checked module when its key is
equal. The lowering memo keeps the IR and the emitted values when the lowering
key is equal.

The check key holds five items: the text of the module, its path, the project
configuration, and the analysis diagnostics of its file. The fifth item is the
interface hash of each module that it reaches. The program calls the same
per-module steps as `checkAnalysis`, in the same order. A revision therefore
equals a run from scratch. The test `tests/db_test.ts` compares both after each
edit of a sequence.

The lowering key holds the hash of the full interface payload of each reached
module. The IR import of a module carries source spans of the imported
declarations. An edit that only moves such a declaration keeps the interface
hash, so the importer is not checked again. The program builds the interface of
the importer again and lowers the importer again.

One `TypeTable` lives as long as the program, so reused modules keep valid type
references. Its interned nodes only grow; redefining a type replaces its
previous alias, brand, opaque, and recursion metadata. Its memory growth in a
long watch session is measurement M4.

`src/core/mod.ts` re-exports the program and the pipeline functions. It also
re-exports the span table and source map builders, the `deno check` parser and
mapper, and the diagnostic types with `describeCode`. The IR types are in the
list too.

## Using the command line

Run `deno task effective <command> [root] [flags]` from the repository root. The
task runs in the repository directory, so pass an explicit root, for example
`fixtures/examples`. The default root is the current directory.

| Command                                       | What it does                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `deno task effective check [root]`            | Prints the diagnostics of the project.                                                                    |
| `deno task effective build [root]`            | Also writes `<module>.ts` and `<module>.ts.map` next to each source for each module that no error blocks, and `<name>.effi.ts` for each imported `.effi` file. |
| `deno task effective build [root] --validate` | Also runs the IR validator and prints its diagnostics.                                                    |
| `deno task effective build [root] --tsc`      | Also runs `deno check` over the written files and the host modules, and maps each error to the source.    |
| `deno task effective watch [root] [--tsc]`    | Builds once, then builds again after each change of a source file. It prints the modules that it checked. |

The root is the project directory with `effective.json`. The modules are the
`.eff` files under the root, found by a recursive walk. The walk skips
directories whose names start with `.` and directories named `node_modules`. The
`.effi` files come from `effective.json`. The walk reads a directory once. It
skips a link to a directory that it already visited, and a link to a directory
outside the root.

The `build` command writes a module only when the module has no error and every
module that it imports, directly or through other imports, is also written. A
companion module counts as an import. The generated file of a module with an
error is not written, so no written file imports a missing file. In an import
cycle, one error stops every module of the cycle. The `watch` command leaves the
last written file of a stopped module on disk. When a module leaves the project,
for example after a rename, `watch` removes its `<module>.ts` or
`<module>.effi.ts` and the map. It prints `removed: <path>` on stderr for each
file. It removes the `.ts` file only when
the first line is the header that the emitter writes for that module. It removes
the map only together with the `.ts` file. The `build` command never removes a
file.

A directory under the root that holds its own `effective.json` is a nested
project. The walk still reads its `.eff` files, so the outer project checks them
and prints their diagnostics. But `build` and `watch` of the outer project do
not write or remove the outputs of those modules, as the language server does.
Build the nested project from its own root.

A diagnostic prints as `path:line:column: error code: message`. The path is
relative to the root. The line and the column are one-based, and the column
counts UTF-16 code units. The tool sorts the lines by path, position, and code.

The message is one line. Stdout holds only diagnostics, except for `--help`,
which prints the usage on stdout. A summary line and all other messages go to
stderr.

The exit code is 0 when there is no diagnostic. It is 1 when there is at least
one diagnostic or a build step fails. It is 2 for a usage or configuration
error. It is 3 for an internal error, which is an unexpected throw. The tool
prints one `effective: internal error: <message>` line to stderr for it. A
failed build step is a failed write, or a `deno check` that cannot run or that
fails with no diagnostic. A usage error is a missing or unknown command, an
unknown flag, an extra argument, or a missing root directory. A configuration
error is a missing or invalid `effective.json`, or a read error in the root.

`build` writes a module only when it has no error. A module with an error keeps
its last good `.ts` and `.ts.map` files. The tool writes a file only when its
text changes. `--validate` runs `validateProject` on the lowered IR. A module
with a validation diagnostic is not written.

`--tsc` runs `deno check` with a generated configuration. The configuration sets
strict mode, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. It
maps `effect` and `@effect/platform-node` to their pinned 4.0.5 packages. The
tool writes the configuration to a temporary directory and removes it after the
run. It passes `--no-lock`, so the project directory gets no new file.

The `fixtures/host-adapter-files/` project shows a typed `host:` adapter for
`effect/FileSystem`. `files.eff` declares the `Files.read` operation and nominal
`FileReadError`. `files-live.ts` validates the path, maps package failures to
that error, and supplies the Node file system layer.
`deno task effective build fixtures/host-adapter-files --validate --tsc` checks
the boundary. The slow CLI test runs a successful read and both missing and
invalid paths. Other ecosystem packages still need adapters with their own
declared contracts.

The tool skips `deno check` when the build has an error. A `host-boundary`
result prints as a normal diagnostic. A host-module error prints as
`<hostfile>:<line>:<column>: error host-boundary/001: <message>`. A source error
prints at the `.eff` position. A generated error prints at the generated
position. Both use the code `TS<number>`.

A line that belongs to no diagnostic goes to stderr. Any `deno check` diagnostic
gives exit code 1.

`watch` reads the root again after each batch of file events and every second as
a fallback when the platform does not deliver events. It gives the program the
files that changed. When no file changed, it prints nothing. A batch joins the
events that arrive within 100 milliseconds of the previous event.

After each build, `watch` prints `rechecked: <modules>` to stderr, then the
diagnostics. A broken `effective.json` prints an error, and the loop goes on. At
start, a broken `effective.json` gives exit code 2. With `--tsc`, local
TypeScript and JavaScript dependencies and Deno, TypeScript, import-map and
package configuration files also trigger target checking. These inputs are
compared separately: a host-only change reuses the source revision and prints
`host inputs changed; rechecked: (none)`. Generated modules, dot directories and
`node_modules` are excluded. Additions, removals and polling scans follow the
same rule. Source or project-configuration errors continue to prevent target
checking. The loop takes its event source as a parameter, so a fast test drives
it with a fake source.

`main(args, io)` in `src/cli/main.ts` returns the exit code. The `io` value
gives the stdout and stderr writers, the file system, the `deno check` runner,
and the watch source. The fast tests in `tests/cli_test.ts` run `main` with
in-memory doubles from `tests/cli_helpers.ts`. The slow tests in
`tests/cli_slow_test.ts` run the real tool.

## Language server

The language server is in `src/lsp/`. It wraps `Program` from the core. Run
`deno task lsp` from the repository root to start it. The task runs
`deno run --allow-read --allow-write src/lsp/main.ts`.

The server talks to its client over standard input and output. A message is a
frame: a `Content-Length: <n>` header line, an empty line, and a JSON body of
`n` bytes. The server writes only frames to stdout. It writes log text to stderr
or sends `window/logMessage`.

The `exit` notification ends the process. End of input ends it too. The exit
code is 0 after `shutdown` and 1 without it.

### Capabilities

The server announces `positionEncoding: "utf-16"`. It supports these features.

- Incremental text sync. A change event without a range replaces the whole text.
- Diagnostics. The server publishes `textDocument/publishDiagnostics` after each
  compile. The `code` field holds the code of the diagnostic, for example
  `failure-contract/001`. The `source` field is `effective`.
- Hover. The text has the source contract of the node. On the name of a function
  or constant, it also has the backend type, which is the TypeScript signature
  that the emitter prints. When the module has errors, the backend line says
  that it is not available.
- Definition. The server resolves types, errors, services, values, providers,
  service methods, and local bindings. It also finds declarations in `.effi`
  files. A builtin, a builtin type, and a field have no definition.
- Document symbols. The result lists the declarations of the file in source
  order, with service methods as children. A file with syntax errors still has a
  symbol for each declaration whose name parsed.
- References. Declarations, imports and uses share resolver identities across
  the project, including local bindings and service-method capabilities. The
  request honors `context.includeDeclaration`.
- Rename. Prepare-rename identifies source-origin symbols. Rename returns
  versioned `documentChanges`, rejects invalid names, capture and conflicts, and
  re-resolves edits before returning them. Host-origin symbols and structural
  fields cannot be renamed. Generated TypeScript is rebuilt through save/build.
- Completion. Visible locals, module/imported names, applicable builtins/types,
  record fields and service methods respect scope, context, shadowing and
  partially typed names. There are no automatic imports.
- Full semantic tokens. A fixed legend includes declaration and readonly
  modifiers; lexical fallback covers broken regions. There are no delta tokens.
- Contract quick fixes. Missing `fails` and `uses` entries come from checked
  body effects. Reliable explicit inline contracts receive validated source
  edits that preserve existing entries. Diagnostic prose is not parsed.

Diagnostics follow a fixed order. The server publishes the open documents of the
project first, sorted by path. An open document gets a message when the compile
used a new version of it or when its list changed. The server then publishes
each closed file whose list changed. A file with an unchanged list and no new
version gets no message.

### Custom methods

The names are in `src/lsp/methods.ts`. Each request takes the params
`{ textDocument: { uri } }`. The URI selects the project, as for every other
request.

| Method                          | Kind         | Result                                                                                                                                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effective/generatedTypeScript` | Request      | `{ text, stale }` or `null`. The text is the emitted module. When the module has errors, the text is the last good output and `stale` is true. The result is `null` if it never emitted.                     |
| `effective/generatedChanged`    | Notification | The params are `{ uri }`, the URI of the `.eff` source. The first `effective/generatedTypeScript` request for a module subscribes it. The server sends this message when its text or its stale flag changes. |
| `effective/stats`               | Request      | `{ revision, rechecked, counts, delta, typeTableSize, memory }`, or `null` for a document with no project. The measurements M3 and M4 use it.                                                                |

In the `effective/stats` result, `rechecked` lists the modules that the last
compile checked again. The `counts` value holds the cumulative query counts
`parses`, `checks`, `lowerings`, and `emits`. The `delta` value holds
`interfaceChanged` and `modeChanged`, the modules whose interface hash or mode
map changed in the last compile. The `typeTableSize` value counts interned type
nodes. The `memory` value holds `rss` and `heapUsed` in bytes. Neither metric
establishes a memory bound.

### Options

The client passes `initializationOptions` with the `initialize` request. Both
options are optional.

| Option        | Default | Meaning                                                                                            |
| ------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `debounceMs`  | `0`     | A finite number of at least 0. The delay in milliseconds before the server compiles after an edit. |
| `writeOnSave` | `true`  | A boolean. When true, a save writes the `.ts` and `.ts.map` files that `build` would write.        |

A missing or invalid value takes the default. The server logs an invalid value.
A request on a project with unsaved changes compiles first, so an answer never
comes from an old revision.

### Projects, save, and configuration errors

A project is a directory with an `effective.json` file. When a document opens,
the server walks up from its directory to the nearest `effective.json`. It keeps
one `Program` for each project root. A document with no project gets no
diagnostics, and its requests return `null`.

An open document overrides the disk text of its path. When the document closes,
the server reads the disk text again. Out-of-order document changes are ignored.
Rename and code-action edits are withheld if the project configuration is
invalid or any loaded source text differs from the current overlay or disk. Open
documents receive their current version in each workspace edit; closed documents
use a null version. The client sends `workspace/didChangeWatchedFiles` for
changes on disk. The server ignores such an event for an open document, because
the editor owns that text.

A save round starts on `textDocument/didSave` of an `.eff` or `.effi` file, and
on a watched-file event for the `effective.json` of a project, because the
client sends no `didSave` for that file. The server does nothing when
`writeOnSave` is false. `writeOnSave` comes from the initialization options, so
a change takes effect after a restart of the server.

The round uses the disk texts only. Unsaved text of an open document never
reaches a generated file. The server reads the whole project from disk and
updates a second `Program`, the disk program, which it creates on the first
round. Then it writes the modules that `build` would write: each module without
an error whose imported `.eff` modules are also written. It writes a file only
when its text differs from the disk, so a deleted or partly written output is
repaired on the next round. The first round of a session therefore writes every
module whose generated files are missing or stale. A later round writes only the
files whose text changed, for example the saved module and the importers whose
generated code changed.

A module with an error keeps its last good `.ts` and `.ts.map` files, as `build`
does. When a module left the project since an earlier round of the session, the
round removes its files, as `watch` does. A project writes and removes only the
outputs of modules that have no nearer `effective.json`. The round logs each
written and removed path at type 4 and each module that it holds back, with the
reason, once at type 3. A read, write, or configuration error goes to
`window/logMessage` at type 1. A concurrent `effective watch` or `build` on the
same project can interleave its writes with the round.

When `effective.json` is missing or invalid, the server publishes one diagnostic
on `effective.json`, at line 0 and character 0. It keeps the last good revision
for hover, definition, symbols, and generated text. It keeps the published
diagnostics of the other files. The next good update clears the configuration
diagnostic. Before the first good revision, hover, definition, and generated
text return `null`. Document symbols parse the file on its own, and
`effective/stats` returns revision 0.

### Known limits

- The server has no cancellation inside the core. `Program.update` runs as one
  synchronous call, and the server handles one message at a time. The plan,
  section 3, explains the reason. Measurement M1 measures the stall.
- Nested projects are not supported. The disk walk of an outer project also
  reads the files of an inner project, so one file can belong to two programs. A
  save round of the outer project does not write or remove the outputs of the
  inner project. The `build` and `watch` commands follow the same rule.
- An `.effi` file that no `.eff` module imports is not in the module graph. For
  such a file, the server gives document symbols only. Hover and definition
  return `null`.
- A generated `.ts` file has no go-to-definition into the `.eff` source.
- Rename edits Effective source/interface references only; it does not rename
  TypeScript host code. Completion does not add imports, semantic tokens have no
  delta mode, and quick fixes target reliable explicit inline function contracts
  only. See [editor queries](editor.md).

## VS Code client

The client is in `editors/vscode/`. It is plain JavaScript. The packaged VSIX
includes the bundled language server and client runtime dependencies, and
requires Deno 2.9.8. It starts the bundled server by default, adds syntax
highlighting, and adds the command `Effective: Show Generated TypeScript`. See
[local installation](installation.md) for artifact builds and installation; its
README lists settings and development overrides.

For development, run `npm ci` once in `editors/vscode`, set
`effective.server.repository` to the checkout, and start VS Code with the
extension and example files. Replace `<repo>` with the path of this repository.

```sh
code --extensionDevelopmentPath=<repo>/editors/vscode <repo>/fixtures/examples
```

Fast client tests check settings, grammar, methods, and startup failures. The
portable installation slow test checks reproducible archives and offline startup
outside the checkout. `deno task test:vscode` separately installs the VSIX into
isolated VS Code directories and exercises editor providers, generated output,
save, recovery, and restart. Automated evidence and manual acceptance remain
separate.

## Playground

The playground is a static page in `playground/`. It runs the core in the
browser. The examples are editable tabs. The page shows the problems, the
generated TypeScript, and a hover with the contract and the backend type. It
does not run the generated code. A reload discards the edits.

Run `deno task playground:serve` and open `http://127.0.0.1:8790/`. The task
builds the page first. `deno task playground:build [outDir]` only writes the
files. The default output directory is `playground/dist/`, which git ignores.
The build removes the output directory first, so it refuses every directory of
the repository except `playground/dist/`.

The build uses `deno bundle` with the CodeMirror 6 packages that `deno.json`
pins. The highlighter uses the core lexer, so the page and the compiler agree on
each token. Below 720 pixels, the page shows one region at a time. The URL hash
holds the active file, for example `#host/providers.effi`.

Fast tests cover the compile facade, the highlighter, and the page model without
a browser. The slow test `tests/playground_build_slow_test.ts` runs the build.
No automated test covers the page in a browser. On 2026-10-16, a manual browser
review at 375 and 1280 pixels passed the checks in
`docs/archive/plans/2026-10-16-playground.md`, section 7. Three later commits
changed the page: the 720 pixel threshold, the hover feedback, and the wrap
indent. An automated browser review on 2026-10-21 passed at 375, 720, and 1280
pixels after them (`docs/playground-review-2026-10-21.md`). It does not replace
a manual review.

The [builtin-change checklist](builtin-changes.md) traces recognition, source
checking, facts, lowering, independent validation, emission and verification for
one builtin change.

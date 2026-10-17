# Effective transpiler: design for discussion

Status: design accepted, 2026-10-16. Phase A, the LSP phase, and the playground
are implemented. Phase B is not started. The D9 budget does not require it
now. The user settled all nineteen decisions and accepted the suggested
answers to the open spec questions. The decision record below lists each choice.

## Decision record

Decided by the user on 2026-10-16. Each entry took the recommended option.

| Decision | Choice |
|---|---|
| D1 Deliverable shape | (b) Shared core library. CLI first, LSP second. |
| D2 Real-time loop | (b) Diagnostics and hover per change. Generated files on save. `watch` and `build` modes. |
| D3 Host language | (a) TypeScript on Deno. Zig behind WASM only after a measured need. |
| D4 Incremental model | (b) Query-shaped core. Module-level cutoff in Phase A. Declaration-level tracking in Phase B after M2 and M3. |
| D5 Where `tsc` runs | (b) Emitter golden tests, `build --tsc`, and CI. Opt-in in `watch`. Never in the LSP. |
| D6 Output location (Q7) | (a) `users.ts` next to `users.eff`. Import specifiers become `./users.ts`. A `.js` switch can come later. |
| D7 Identity encoding | (b) Module-qualified strings such as `users#UserMissing`. The spec requires this: "A backend must encode resolved declaration identities in error tags, service keys, and brand tokens." |
| D8 Mode firewall hole (I1) | (a) Source purity assertions stay deferred. The incremental model invalidates dependents on a mode change. M3 informs a later review. |
| D9 Latency budget | (a) Set the budget after M1 and M6 give a baseline. Set on 2026-10-16: 100 ms at p90 from `didChange` to `publishDiagnostics` on the large synthetic size. Phase B is not needed while M1 meets this budget. Evidence below the table. |
| D10 Host registry format | (a) Effective-syntax declaration file with a `provider` form, plus a `host:` map in `effective.json`. |
| D11 IR validator | (a) Independent validator in the first version, used as a differential oracle for the checker. |
| D12 Output formatting | (a) Own printer with one fixed style. A test confirms that `deno fmt --check` accepts the output unchanged. |
| D13 Exported constants (Q4) | (a) Every exported constant requires a type annotation. This closes firewall hole I6. |
| D14 `int` arithmetic (Q6) | (a) The emitter wraps `int` operations in a runtime helper that raises a defect outside the safe integer range. The cost needs to be measured. |
| D15 Repository | (a) The transpiler lives in `effective-lang`, separate from the `effective` site and spec repository. |
| D16 Next phase (2026-10-16) | The LSP comes before Phase B. Phase B waits for the D9 budget, and D9 waits for M1, which needs the LSP (design 4.5 and D9). |
| D17 JSON-RPC transport (2026-10-16) | Hand-written Content-Length framing over stdio. No npm dependency in the server. |
| D18 Editor client (2026-10-16) | A thin VS Code client in `editors/vscode/`, plain JavaScript, with `vscode-languageclient`. npm is used only inside that directory. |
| D19 Measurements (2026-10-16) | This phase adds the M1, M3, and M4 harness. It replays an edit script against the real server process. |

Open: none.

Evidence for the D9 budget: one quick run of `deno task bench m1` on
2026-10-16. Each row had 60 samples from two server processes. On the large
synthetic size, a body edit had a p90 of 11.4 ms (floor 10.4%). A header, alias,
or mode-flip edit had a p90 of 47 to 49 ms (floors 4.9% to 9.0%). The maximum of
those rows was 66 to 80 ms. Measure again with `--full` when the core changes.

The user also accepted the suggested answers in section 9 for Q1, Q5, Q8, Q9,
and Q10. Q2, Q3, Q4, Q6, and Q7 follow from D7, D10, D13, D14, and D6.

| Question | Answer |
|---|---|
| Q1 Builtin `ValueId` scope | Per module, content hash of the closed type. |
| Q5 Unannotated module-level functions | Allowed, and never exported. |
| Q8 Diagnostic codes | Category prefix plus a number, for example `failure-contract/001`. |
| Q9 Optional and `Option` fields | `Schema.optionalKey` for `?` fields, as the book tab does. `Schema.Option` for `Option<T>` fields, after a `deno check` probe. Correction: an earlier answer named `Schema.optional`. |
| Q10 Providers in `provide` | Host-declared providers only. |

D8, D13, D14, and the answers above interpret or extend the language spec. The
spec in the `effective` repository does not record them yet.

## 0. Sources and conventions

I read these sources. They are the ground truth for this document.

| Source | Path |
| --- | --- |
| Language specification, draft 0.1 | `/Users/srdjans/Code/effective/public/effective-spec.html` |
| Mini book with eight Effect-TS targets | `/Users/srdjans/Code/effective/public/index.html` |
| Proposed typed IR | `/Users/srdjans/Code/effective/public/typed-ir.ts` |
| Manual IR fixture and its source | `/Users/srdjans/Code/effective/public/log.ir.json`, `log.lft` |
| Validation report | `/Users/srdjans/Code/effective/public/effective-validation.txt` |
| Five source examples | `/Users/srdjans/Code/effective/public/effective-examples/*.eff` |
| Repository README | `/Users/srdjans/Code/effective/README.md` |
| Compiler skill from goose | `/Users/srdjans/Code/_skills/skills/zig-compiler/SKILL.md` and `references/` |

Each claim in this document carries one of three labels. An **Observation**
restates what a source says and names its section. An **Inference** is my
reasoning from observations. A **Recommendation** is my preferred option. The
alternatives for each recommendation appear in section 12.

Spec section names in this document are the headings of the specification,
for example "Functions and blocks" or "Execution order and mode".

## 1. Direct answers to the user's questions

**Is the language server the proper deliverable?** No. The deliverable is a
compiler core library with a query-shaped API. The language server (LSP) is one
front end over that core. The command line (CLI) is another front end, and it
comes first. The CLI gives the fixture harness, continuous integration (CI), and
the `tsc` oracle. The LSP comes second, close behind, because hover with the
inferred contract is the feature that makes the language worth using.

Each front end adds only transport and scheduling. The pipeline is shared.

**An incremental compiler on every save?** Save is the wrong trigger for
diagnostics and hover, and the right trigger for file output. The user-visible
loop has four modes over one core.

Per change gives diagnostics and hover. Per
save writes the generated TypeScript to disk. Watch serves the terminal, and
build serves CI. Section 2 defines each mode.

**Incremental, or whole rebuild?** Build the core query-shaped from day one, so
that each analysis is a pure function of named inputs. Start with module-level
memoization and an interface cutoff, which the spec's explicit contracts make
cheap. Add declaration-level memoization only after a measurement shows that the
whole-module recheck misses the latency budget. Section 4 gives the model.

## 2. What "real time" means here

### 2.1 Four loops over one core

| Mode | Trigger | Work | Output | Runs in |
| --- | --- | --- | --- | --- |
| Per change | Editor `didChange` | Parse the changed file, recheck, no file writes | Diagnostics, hover, go-to-definition, in-memory generated TypeScript | LSP server |
| Per save | Editor `didSave` | Emit the module and its span table | `*.ts` and `*.ts.map` on disk | LSP server |
| Watch | File system event | Check and emit the changed module and its dependents; optional `tsc` | Files, terminal diagnostics | CLI `watch` |
| Build | One command | Check and emit everything; validate IR; optional `tsc` | Files, exit code | CLI `build`, CI |

Inference: the per-change loop must not write files. A write per keystroke
triggers every other watcher on the machine, such as `deno task dev --watch` and
the TypeScript server. The generated TypeScript stays visible per change through
an in-memory virtual document. The disk copy updates on save.

### 2.2 The user-visible loop

```
edit users.eff
  -> diagnostics on the edited span and on dependents (per change)
  -> hover on `rename`: "rename(id: string, name: string): User
       fails StoreUnavailable | UserMissing uses Users.find | Users.save"
       and the backend type "Effect.Effect<User, StoreUnavailable | UserMissing, Users>"
  -> "Show generated TypeScript" opens a virtual document (per change)
  -> save: users.ts and users.ts.map appear next to users.eff
  -> go-to-definition from users.ts line 12 lands on users.eff `rename`
  -> deno run main.ts runs the generated module
```

Correction, 2026-10-17: the sets print in sorted identity order, as the
Phase A plan (section 6.6) decided. Go-to-definition from a generated `.ts`
file is not implemented. The LSP plan puts it out of scope, and the README
lists it as a known limit. The source map exists, so a later phase can add it.

Hover must show two things, because the spec makes them differ. Observation
("Typed IR and backends"): the backend's `R` parameter groups requirements by
service, and the backend preserves method precision in checked IR or metadata.
So hover shows the method-precise source contract first and the coarser
TypeScript type second.

### 2.3 Position encoding

Observation ("Source and lexical rules"): source positions in IR count UTF-16
code units with an exclusive end offset. The LSP protocol also defaults to
UTF-16 positions. JavaScript strings index by UTF-16 code unit. Inference: a
TypeScript host needs no offset conversion between the IR, the LSP, and the
source text. A Zig host must convert UTF-8 byte offsets to UTF-16 units at every
boundary. Section 7 uses this fact.

### 2.4 Staleness and cancellation

An editor produces changes faster than a checker can finish on a large file.
Every result must carry the document version that produced it. The server must
discard a result for a stale version and must never publish it. The core must
expose a check loop that the driver can stop between declarations. A
synchronous core that checks one module in one call blocks the message loop
until it returns. Whether that matters needs to be measured (section 10, M1).

Recommendation: keep the core synchronous and pure. Give the LSP driver a
per-declaration loop with a cancellation token. Move the core into a worker
only if M1 shows that the main thread stalls.

Deviation, recorded in the LSP plan section 3: the server has no cancellation
and no per-declaration loop. It handles one message at a time and runs
`Program.update` as one call, so a result is never stale when the server
publishes it. The `version` field of `publishDiagnostics` names the document
version that the revision used. The D9 evidence shows no stall above the
budget.

## 3. Deliverable shape and order

### 3.1 Components

| Component | Role | Depends on | Effort class |
| --- | --- | --- | --- |
| Core library | Lexer, parser, resolver, checker, lowering, IR validator, emitter, query database | Nothing | Largest |
| CLI | `check`, `build`, `watch`; fixtures and CI run through it | Core | Small |
| LSP server | Document sync, diagnostics, hover, definition, document symbols, virtual generated document | Core | Medium |
| Editor client | VS Code extension: launch the server, TextMate grammar, virtual document scheme | LSP | Small |
| Playground | Browser page that runs the core and shows source, diagnostics, and generated TypeScript | Core | Small with a TypeScript host; medium with WASM |
| Bundler plugins | Vite or esbuild wrappers around `build` | Core | Small, later |
| TypeScript language-service plugin | Resolve `.eff` imports inside `tsserver` | Core, emitter | Large, deferred |

Observation (sibling repository `deno.json` and `main.ts`): the spec site is a
Deno static server with a build task. Inference: a playground page can live in
that site and load a bundled core.

### 3.2 Minimal first deliverable

Recommendation: the first deliverable is the core plus `effective check` and
`effective build`, proven by three fixture sets.

1. The five `.eff` examples check without diagnostics.
2. `log.eff` lowers to an IR equal to `log.ir.json`, apart from the source
   identifier and module name (section 9, Q2).
3. The eight book targets are golden outputs of `build`, and `tsc` accepts them
   under the sibling repository's strict settings against Effect 4.0.5.

Deviation, recorded 2026-10-17: Phase A made the five examples the golden
outputs (acceptance check 4 of the plan). The eight book targets are not
goldens and not inputs of M5. No document recorded this before.

The LSP follows at once. At that point the server is an adapter: JSON-RPC over
stdio, document sync, `publishDiagnostics`, `hover`, `definition`. Document
symbols and semantic tokens are cheap additions. Completion is later.

### 3.3 Order and reason

1. Core and CLI. Reason: the fixtures and the `tsc` oracle need a command.
2. LSP and a thin VS Code client. Reason: hover and per-change diagnostics are
   the product's promise.
3. Playground. Reason: a TypeScript core runs in the browser without a port.
4. Watch mode polish and bundler plugins. Reason: cheap wrappers.
5. TypeScript language-service plugin. Reason: large, and the emitted `.ts`
   files already give editor support for consumers.

## 4. The incremental model

### 4.1 Options

| Model | Work per edit | Complexity | Fit for Effective |
| --- | --- | --- | --- |
| Whole-program rebuild | Everything | Lowest | Correct by construction; latency unknown until measured |
| File-level rebuild | Changed module plus dependents; early cutoff on interface equality | Low | Good: modules form a DAG and exported contracts are explicit |
| Query-based with dynamic dependency tracking (salsa, rust-analyzer) | Only queries whose inputs changed; early cutoff on value equality at every query | Medium | Good at declaration granularity; needs hashable query results |

Observation (skill, `compiler-architecture.md`, "Deliberate simplicity"): goose
chose no incremental compilation and did not measure the cost of a full rebuild.
Inference: that choice fits a batch compiler with a closed world. It does not
fit an editor loop, where the closed world changes on every keystroke.

### 4.2 What the spec gives us: the interface firewall

Observation ("Functions and blocks"): exported functions require parameter and
result annotations. A result annotation creates a closed failure and
requirement contract.

Observation ("Services and contracts"): a declared set may be wider than the
body needs, and calls through that interface propagate the declared sets.

Observation ("Modules and boundaries"): the checker resolves declaration
identities before checking bodies, and the linker rejects module dependency
cycles.

Inference: for an exported function, the result type, failure set, and
requirement set depend only on two things. They depend on the declaration
header and on the declarations that the header names. A body edit cannot
change them. Callers in other modules
see only the interface. Modules form a DAG, so a topological order exists and
each module's interface is a value that can be hashed and compared.

That is the firewall. Section 4.3 lists every hole in it.

### 4.3 Where the spec infers across declarations

Each item names a fact that one declaration's body or definition changes in
another declaration's check. An item marked "firewall hole" lets a body edit
change an interface. An item marked "declaration edge" is a dependency between
declaration headers, which the firewall does not promise to hide.

| # | Inferred fact | Spec section | Kind |
| --- | --- | --- | --- |
| I1 | Execution mode of every function, including exported ones with explicit contracts. "Those omissions do not assert pure execution. The checker tracks execution mode separately." "Imported interfaces retain their resolved execution modes." | Functions and blocks; Execution order and mode | Firewall hole |
| I2 | Mode decides the generated type. "Pure exports return ordinary target values. Effectful exports return target computations, even when their error and requirement sets are both empty." | Typed IR and backends | Consequence of I1 |
| I3 | Mode decides callback admissibility. "An effectful function cannot satisfy a pure callback requirement." The prelude callbacks for `map`, `filter`, and `fold` require pure mode. | Execution order and mode; Pipelines and collections | Consequence of I1 |
| I4 | Mode of a recursive group is a fixed point. "Mode inference starts pure and propagates intrinsic effects and effectful calls until the recursive group reaches a fixed point." | Execution order and mode | Firewall hole, group-scoped |
| I5 | Result type and effect sets of a local function without a result annotation. "A local function without a result annotation infers its result and effect sets." `FunctionDecl.contract` is `"explicit" | "inferred"`. | Functions and blocks; `typed-ir.ts` | Firewall hole, module-local |
| I6 | Type of a constant without an annotation, including an exported one. The grammar makes the binding type optional, and only exported functions require annotations. | Surface grammar; Functions and blocks | Firewall hole unless the spec closes it (Q4) |
| I7 | Whole-service expansion. "A whole service name expands to all methods in that service." Adding a method to `Orders` changes every contract that says `uses Orders`. | Services and contracts | Declaration edge |
| I8 | Module interface carries private types. "Interfaces also carry the complete supporting type graph, without importing private names." A private type edit in `users.eff` changes the interface that `main.eff` sees. | Modules and boundaries | Declaration edge |
| I9 | Type alias structure. "Type aliases use structural compatibility." Every use site depends on the alias definition. Recursive aliases are rejected, so the alias graph is a DAG. | Data and types | Declaration edge |
| I10 | Provider types come from the host registry, which is not Effective source. | Retry and providers; Modules and boundaries | External input |
| I11 | Builtin specialization produces synthetic `ValueId`s, "unique" per distinct closed builtin type. The scope of uniqueness is not stated. | Pipelines and collections | Determinism question (Q1) |
| I12 | Module initialization requires pure initializers, which depends on the inferred mode of each constant's expression. | Modules and boundaries; Execution order and mode | Consequence of I1 |

Inference: I1 is the one hole that crosses module boundaries for annotated
functions. It is one bit per function. A body edit flips it rarely, because an
effectful body stays effectful under most edits. When it flips, every caller
that passes the function to a pure builtin, and every importer that emits its
type, must recheck. The incremental model must invalidate on mode change and
must not invalidate on an unchanged mode. Section 12, D8, offers the user the
language-level fix that the spec lists as deferred ("source purity assertions").

### 4.4 Query graph

```
sourceText(file) -> tokens(file) -> syntax(file) -> declIndex(file)
                                                         |
hostRegistry ----------------------> moduleGraph <-------+
                                          |
                      +-------------------+--------------------+
                      v                                        v
            interface(importedModule)                   resolve(module)
                      |                                        |
                      +------------> signature(decl) <---------+
                                     ^        |
                  mode and inferred  |        v
                  contracts feed back+-- checkBody(decl) --> modeGroup(scc)
                                              |
                                              v
                                        lower(decl)
                                              |
                                              v
          interface(module) <----------- moduleIR(module) --> emit(module) --> spanTable(module)
```

Each box is a query: a pure function from its key and its inputs to a value.
The driver memoizes a query result with the revision at which it last changed
and the list of queries it read. On a new revision, a memo is valid when every
query it read re-verifies to an unchanged value. This is the red-green
algorithm from salsa and rust-analyzer. It needs two properties from the core:
every query result is comparable for equality, and no query reads state outside
the database.

`signature(decl)` for an explicit contract reads only the header syntax and the
declarations that the header names (I7, I8, I9). It reads `checkBody(decl)`
only for the mode (I1) and for inferred contracts (I5, I6). The early cutoff
happens there: a body edit re-runs `checkBody`, then `signature` recomputes and
compares equal, and no caller re-runs.

`modeGroup(scc)` is one query per strongly connected component of the
module-local call graph. Observation ("Execution order and mode"): recursive
functions require explicit signatures, so only the mode needs the fixed point.
Observation ("Modules and boundaries"): modules have no cycles, so a component
never spans modules. The query starts every member at pure, iterates the mode
equations, and stops at a fixed point or at a round cap.

The cap and the "unknown bottom" come from the goose skill ("Bounded fixpoints with an unknown
bottom"). There, goose reports that cycles settle in two or three rounds on
goose's inputs. That count is not a prediction for Effective.

### 4.5 Granularity and phasing

Recommendation: ship the incremental model in two phases, gated by measurement.

Phase A: module granularity. Memoize `tokens`, `syntax`, `declIndex`,
`interface`, `moduleIR`, and `emit` per module. Recheck every declaration of an
edited module. Recheck a dependent module only when the imported interface
value changed. This phase needs the query shape but not dynamic dependency
tracking: the dependencies are the import graph.

Phase B: declaration granularity. Add dynamic dependency recording to
`signature`, `checkBody`, `modeGroup`, and `lower`, keyed by `(module, name)`.
Enter this phase only if measurement M1 shows that an edit misses the budget
from D9. M2 and M3 then show whether the whole-module recheck causes the miss
(D4).

Correction, 2026-10-17: the D9 budget is a time from `didChange` to
`publishDiagnostics`. Only M1 measures that time, so M1 is the gate, as D9
says. An earlier text named M2 as the gate. The synthetic sizes do not vary the
size of one module: every feature module has 60 declarations. The size of the
largest realistic module is still not measured (`docs/rejected.md`).

The program rechecks a dependent module when the interface hash of any module
that it reaches changes, not only of a direct import. The reason is that the
checker reads the type graphs of all reached modules (`src/core/db.ts`).

Inference: Phase A already captures the firewall across modules. Phase B
captures it inside a module. The size of the realistic module decides whether
Phase B pays. That size needs to be measured on the user's intended programs.

Declaration keys must be `(module, name)`, never positions. A position changes
on every edit above the declaration. A name changes only on rename.

### 4.6 Which goose techniques transfer

| Goose technique | Transfers | Reason |
| --- | --- | --- |
| Effect summaries replayed at call sites | Yes, directly | A contract is a summary. The spec's "ordinary call" equation replays it. |
| Bounded fixpoints with an unknown bottom | Yes | Mode inference over recursive groups (I4). Bottom is pure. |
| Hold warnings while a check may repeat | Yes | Diagnostics inside a mode fixed point must appear once, after the last round. |
| Hand-written lexer, recursive descent, whole-file token array, `line_starts` table | Yes | Front end shape is language-independent. |
| Flat scope stacks with base indices | Yes, inside `checkBody` | Block scopes nest; no closure capture analysis is needed. |
| Hash-consed types with integer ids | Yes | No recursive types in version 0, so every type is stable at creation. |
| Resource caps with named diagnostics | Yes | Fixpoint rounds, expression nesting depth, diagnostic count. Phase A has the first two (`execution-mode/004`, `syntax/009`). It has no cap on the diagnostic count. The type comparison has a cap without a diagnostic (audit item C7). |
| Measurement discipline: checksum gate, interleaved A/B, noise floor, rejected-ideas ledger | Yes | Golden outputs are the checksum. Latency is the metric. |
| Demand-driven checking with one specialization key | Partly | Checking on demand transfers. The key does not: version 0 has no user generics, and builtin specialization is local to a body. |
| Whole-program pass structure | Only for `build` | `build` is the degenerate case where every query runs. The editor needs the query shape. |
| First error stops the compile | No | An editor needs every diagnostic and partial results (section 6.4). |
| Append-only arena freed at the end | No | A long-lived server must release old revisions. A TypeScript host uses the garbage collector; memory growth needs measurement M4. |
| Lifetime roots, flow snapshots, clone per specialization, bounds-check elimination, C emission | No | The target is TypeScript with a garbage collector, immutable values, and no references. |

## 5. The two-checker problem

### 5.1 Who reports what

| Checker | Reports | When | Actionable by |
| --- | --- | --- | --- |
| Effective checker | Syntax, unknown-name, type-mismatch, failure-contract, requirement-contract, execution-mode, and pattern diagnostics on `.eff` spans | Per change, watch, build | The Effective author |
| IR validator | Disagreements between recomputed and recorded annotations in the IR | Tests, `build --validate`, CI | The transpiler maintainer |
| `tsc` on generated code | Type errors in generated TypeScript | Emitter golden tests, `build --tsc`, CI; opt-in in watch | The transpiler maintainer, or the host-module author |

Observation ("Diagnostics and conformance"): the suggested categories are
syntax, unknown-name, type-mismatch, failure-contract, requirement-contract,
and execution-mode. Observation ("Equations and validation"): a semantic
validator must recompute annotations and reject disagreements, and TypeScript
cannot prove the semantic equations.

Inference: if the transpiler is correct, `tsc` never reports an error on
generated code, with one exception. The exception is the host boundary. The
host registry declares that `UsersLive` provides `Users`, but the TypeScript
module that implements it can disagree. Only `tsc` sees that disagreement.

Recommendation: the emitter writes one explicit type assertion per host import,
for example a typed constant that re-exports the provider with the registered
`Layer` type. A host mismatch then lands on one generated line that maps to the
`.eff` import span. Report it with the category `host-boundary`.

### 5.2 Where `tsc` runs

Recommendation: `tsc` runs in the emitter's golden tests, in `build --tsc`, and
in CI. It does not run in the LSP. It is opt-in in `watch`.

The reason is actionability. A `tsc` error on generated code is a transpiler defect or a host
mismatch. The Effective author can fix only the second. The cost is
measurement M5, because Effect's type declarations are large and the cold cost
of a `tsc` run over them is unknown here.

Three ways to run `tsc` exist, and M5 compares them. The first is the
`typescript` npm package in process, through `ts.createProgram` or a persistent
`ts.LanguageService`. The second is the `tsc` binary as a subprocess. The third
is the Go port (`tsgo`) as a subprocess.

Observation (validation report): the sibling
repository checked with TypeScript 7.0.2. Observation (this machine): the `tsc`
on `PATH` is 6.0.3 and `deno` is 2.9.7. The oracle must pin one version.

### 5.3 Mapping TypeScript diagnostics back to Effective spans

The emitter knows the source span of every IR node, because the IR records it.
While it prints, the emitter records a table of `(generatedStart, generatedEnd,
sourceSpan)` triples in UTF-16 units. That table is the span table. A `tsc`
diagnostic arrives as `(file, start, length)` in UTF-16 units of the generated
file. The driver finds the innermost triple that contains `start` and reports
the diagnostic on `sourceSpan`.

The same table serializes to a source map (version 3) as `*.ts.map`. Source
map columns are UTF-16 units in JavaScript tooling, so no conversion is needed.
The source map also lets a Deno or Node stack trace point at the `.eff` line.

Recommendation: keep the span table as the primary artifact and derive the
source map from it. A span table is a plain array; a source map needs VLQ
encoding and is harder to test.

### 5.4 Output determinism and formatting

The generated file must be a pure function of the module IR, the emitter
version, and the configuration. The IR serialization rule helps. Observation
("Equations and validation", Serialization): sets are sorted and unique.

Three sources of nondeterminism need rules.

1. Union order in `Effect.Effect<A, E, R>`. Decision of the Phase A plan
   (section 6.6, commit 8da88fb): print `E` and `R` in sorted identity order
   for every contract. The emitter reads only the IR, and the IR stores sorted
   sets, so the source order is not available. An earlier recommendation used
   source order for explicit contracts, as the book targets do.
2. Synthetic builtin `ValueId`s (I11). Recommendation: derive each identifier
   from a hash of the closed builtin type, scoped to the module, so that an
   unrelated edit never renumbers them. The spec must confirm the scope (Q1).
3. Formatting. Recommendation: the emitter has its own printer with one fixed
   style that matches the book targets. A test checks that `deno fmt --check`
   accepts every golden output, so a consumer's format-on-save does not rewrite
   generated files. If the printer cannot reach that fixed point, the
   generated files are excluded from `deno fmt` in `deno.json`.

A post-pass formatter is rejected: it would move every span in the span table.

## 6. Pipeline stages and data structures

### 6.1 Stages

Observation ("Typed IR and backends", Transpiler design): the spec lists six
stages. The first three are parse with source positions, resolve declaration
identities, and check types, contracts, patterns, and execution modes. The last
three are specialize builtins and lower pipelines, validate typed IR, and emit
Effect-TS code. The table below keeps that order and names the granularity of
each stage.

| Stage | Input | Output | Granularity |
| --- | --- | --- | --- |
| Lex | Source text | Token array with trivia; newline tokens because the grammar is newline-sensitive | File |
| Parse | Tokens | Lossless syntax tree with error nodes and missing tokens | File |
| Index | Syntax tree | Declarations by name, export flags, header and body spans, header and body hashes | File |
| Link | Indexes, host registry | Module graph, topological order, cycle diagnostics | Program |
| Resolve | Module graph, imports | Name to `DeclarationId`; local scopes | Module |
| Type lowering | Type syntax | Interned structural types; nominal brands and errors by identity | Declaration |
| Signature | Header, named declarations, mode | `FunctionType` with contract and execution | Declaration |
| Check body | Body syntax, signatures, prelude | Side tables: type, effects, mode, resolved target per node; diagnostics | Declaration |
| Mode groups | Call edges, body modes | Fixed-point modes per component | Component |
| Interface | Exported signatures, transitive type graph | `ModuleInterface` value | Module |
| Lower | Syntax plus side tables | Typed IR declaration; pipelines lowered; builtins specialized | Declaration |
| Validate | Module IR, source texts | Disagreement diagnostics | Module, tests and CI |
| Emit | Module IR | TypeScript text, span table | Module |
| Oracle | Generated files | Mapped `tsc` diagnostics | Program, CI |

### 6.2 Data structures

Tokens: parallel arrays `kinds`, `starts`, `ends` as typed arrays. The
`lineStarts` table for offset to line conversion is computed on demand from the
text (`src/core/source.ts`). Observation (skill,
"Front end"): goose scans on demand and the skill recommends a whole-file token
array; the speed effect is not measured in goose. In a TypeScript host, typed
arrays are a cheap choice at the start and a costly retrofit later. Their
benefit here needs to be measured (M2 compares object arrays and typed arrays
on the parser alone).

Syntax tree: nodes with `kind`, `start`, `end`, `parent`, and a child range;
node ids are indices into the per-file node array. Comments and newlines stay
as trivia so that the tree round-trips to source. The tree has two extra node
kinds: `error` for an unparsable region and `missing` for an expected token.

Types: an intern table. Equal structural types share one integer id, so type
equality is integer equality and type sets sort numerically. Brands and errors
are nominal by `DeclarationId`. Serialization expands ids back to the
`typed-ir.ts` `Type` tree.

Effect sets: sorted arrays of `ErrorId` and `CapabilityId` strings. Union,
difference, and subset are merges over sorted arrays. Correction, 2026-10-17:
an earlier text said interned integers. Only types are interned. The spec's
equations ("Equations and validation") are all set operations over these.

Side tables per declaration body: one map from node id to `{ type, effects,
mode }`. A second map goes from each name node to its resolved target. Hover
and go-to-definition read these tables. They do not read the lowered IR.

Module interface: the `typed-ir.ts` `Import` payload without `module` and
`bindings`, that is `exports`, `values`, `types`, `errors`, and `services`.
`FunctionType.execution` already carries the mode, so the interface value
changes when the mode flips (I1), which is what the cutoff needs.

Diagnostics: the `typed-ir.ts` `Diagnostic` extended with `category`,
`severity`, and related spans. Sort by span and deduplicate before publishing.

### 6.3 Reuse of typed-ir.ts

Sound to reuse as is: the lowered output of a checked module, the emitter
input, the validator input, and the wire format. Observation ("Typed IR and
backends"): the format marker stays `light-functional-ir`, version 1. The
design keeps that contract and the `log.ir.json` fixture as a conformance test.

Not sound as the editor's working representation, for three reasons.

1. Pipelines have no IR node. Observation ("Typed IR and backends"): pipelines
   lower through fresh block bindings. Hover on a stage needs the syntax tree
   and side tables, not the IR.
2. The IR has no error node and no partial module. `Compile` returns
   `Result<ModuleIR, readonly Diagnostic[]>`, all or nothing. An editor needs
   per-declaration results.
3. Identities are strings such as `value:example/log#log`. Phase A keeps them
   as strings in the core too. Only types are interned to integers.

Two changes to the boundary are proposed. The `Compile` type becomes a
multi-module driver that takes a module graph and a host registry. The
single-source form remains as a convenience for the playground. The IR
exists only for a module whose declarations all check. The editor shows the
last good generated text with a stale marker while a module has errors.

As built, the driver is `Program` (`src/core/db.ts`). The playground also uses
`Program`, and no code uses the `Compile` type of `ir.ts`.

### 6.4 Error recovery and partial results

Observation (skill, "Diagnostics"): goose stops at the first error and the
skill notes that reporting several errors needs a plan for half-set facts.
This design needs that plan.

Parser recovery synchronizes at declaration keywords at the start of a line:
`import`, `export`, `type`, `error`, `service`, `provider`, `const`. Inside an
unclosed bracket, `const` counts only at column 0. Inside a block the parser
synchronizes at a newline, a `;`, or a closing brace. Inside a comma list it
synchronizes at a comma or a closing bracket. An unparsable region
becomes an `error` node with its span.

The lexical rules make this cheap.
Observation ("Source and lexical rules"): a newline separates declarations and
block items. Continuation happens only before `fails`, `uses`, an arrow, or
`|>`. The Phase A grammar addendum also continues before `else` and `catch`.

Checker recovery gives an `error` node the error type. The error type is
compatible with every type and contributes empty effect sets and pure mode. A
diagnostic whose cause is an error-typed operand is suppressed. Contract checks
still run on the partial body, so a failure that lives inside the broken region
may be under-reported until the syntax is repaired. That limit is acceptable
and must be documented.

Declarations check independently. One broken declaration never stops the
others. Hover on a broken declaration shows the error type as "unknown (error)"
rather than nothing.

## 7. Host language for the transpiler

| Criterion | TypeScript on Deno | Zig | Rust |
| --- | --- | --- | --- |
| Ecosystem match with the output | Same language; `typescript` API in process; Effect types available | Separate; `tsc` as subprocess only | Separate; `tsc` as subprocess only |
| UTF-16 spans (section 2.3) | Native | Convert at every boundary | Convert at every boundary |
| LSP | `npm:vscode-languageserver` or a short hand-written JSON-RPC layer | Hand-written JSON-RPC; `zls` shows it is possible | `tower-lsp` |
| Playground | Bundle the core; no port | WASM plus JavaScript glue | WASM plus glue |
| Incremental engine | Hand-written red-green driver, small | Hand-written | `salsa` exists |
| Raw speed and memory headroom | Unknown; needs measurement | Highest; goose evidence is for C++ and not measured for this design | High |
| House stack and skills | Yes: `typescript-expert`, `fullstack-expert`, Deno tooling | `zig-expert`, `zig-compiler` skills | None |
| Single binary | `deno compile` | Native | Native |
| Toolchains per product | One | Two (Zig plus TypeScript for the client and the oracle) | Two |

Inference: the only argument for Zig is speed headroom, and no measurement yet
shows a need for it. The programs in the examples are small. The cost of Zig is
concrete and immediate. It adds a second toolchain, manual UTF-16 conversion, a
subprocess oracle, a WASM build for the playground, and a hand-written LSP
transport. The goose skill's strongest techniques (lifetime roots, arenas,
bounds-check elimination) do not apply to this target (section 4.6).

Recommendation: TypeScript on Deno, with the data-oriented discipline where it
is cheap. That means typed arrays for tokens, integer ids for nodes and types,
and side tables instead of object graphs. Keep each stage boundary as plain
data, so that a hot stage can move to Zig behind WASM later if measurement M2
shows a need. That escape hatch is a design property, not a plan.

## 8. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Effect 4 API drift (`Context.Service`, `Schema.TaggedError`, `Schema.brand`) | Generated code stops type-checking | Pin `effect@4.0.5`; golden outputs under `tsc` in CI; a version matrix later |
| Identity encoding in tags and keys (Q2) | Renaming a file renames every persisted `_tag`; readability of `catchTag("...")` | Decide the encoding before the emitter exists (D7) |
| Mode flip invalidation (I1) | A body edit rechecks importers | Early cutoff on interface value; measure the flip rate (M3); D8 |
| Synchronous core blocks the LSP loop | Stale hover during a long check | M1 measures the stall against D9; a per-declaration loop or a worker only if M1 misses the budget (LSP plan section 3) |
| Memory growth in a long-lived server | Server slows or dies | Release old revisions; measure M4 |
| `tsc` cost | Slow CI, or a wrongly placed oracle | M5 decides the runner and whether `watch --tsc` can default on |
| Printer cannot reach a `deno fmt` fixed point | Format-on-save rewrites generated files | Exclude generated files from `deno fmt`, or accept the style difference (D12) |
| Host registry has no format yet (Q3) | `main.eff` cannot check; `provide` is untestable | Decide the format early (D10) |
| Partial-body under-reporting of contract errors (section 6.4) | A failure hides inside a syntax error until repaired | Document; suppress nothing once the syntax is repaired |
| `int` arithmetic defects (Q6) | Generated code either silently overflows or carries runtime checks | Spec decision before the emitter handles arithmetic |

## 9. Open spec questions that block the design

| # | Question | Section | Why it blocks | My suggested answer |
| --- | --- | --- | --- | --- |
| Q1 | What is the scope and derivation of synthetic builtin `ValueId`s: per module or per program, counter or content? | Pipelines and collections | Output determinism and incremental emission | Per module, content hash of the closed type |
| Q2 | How is the module name derived (`example/log` for `log.lft`), and what exact string goes into `_tag`, service keys, and brand tokens? | Typed IR and backends; fixture | Emitter, fixtures, and wire stability | Module path relative to a configured root; tag `users#UserMissing` |
| Q3 | What is the host registry format and location, and how is a provider type written? The grammar has no provider syntax. | Retry and providers; Modules and boundaries | `provide` and `main.eff` cannot check | A declaration file in Effective syntax with a `provider` form, next to a `host:` name map in `effective.json` |
| Q4 | Must an exported constant carry a type annotation? | Functions and blocks; Surface grammar | Closes firewall hole I6 | Yes |
| Q5 | Are unannotated functions allowed at module level (not exported), as `const job = () => log("ready")` suggests? | Functions and blocks | Confirms I5 is module-local only | Yes, and never exported |
| Q6 | Who inserts the safe-integer check for `int` arithmetic: the emitter, a runtime helper, or nobody? | Data and types; Surface grammar | Generated code shape and determinism | Emitter calls a small runtime helper for `int` operations |
| Q7 | What is the import specifier rewrite: `./users.eff` to `./users.ts` (Deno) or `./users.js` (Node)? The sibling repository's plan used `.js` for its harness. | Modules and boundaries | Runnable output | `.ts` by default, `.js` by option |
| Q8 | What are the diagnostic codes? The spec names categories only. | Diagnostics and conformance | Fixtures match on codes, not on message text | Category prefix plus a number, for example `failure-contract/001` |
| Q9 | How are optional fields and `Option` fields emitted so that the difference survives? | Data and types | Schema emission | `Schema.optional` for `?` fields, `Schema.Option` for `Option<T>` fields; needs a check against Effect 4.0.5 |
| Q10 | Does `provide` accept a provider whose acquisition fails or has dependencies in version 0 source, or only host-declared ones? | Retry and providers | Checker equation coverage | Host-declared only, as the spec implies |
| Q11 | Do record types allow width subtyping? | Data and types | Assignability of every record | Phase A: no. Equal field names, equal optional flags, compatible field types |
| Q12 | Which identifiers are reserved? | Source and lexical rules | Emitted names must be valid TypeScript | Phase A: reject JavaScript and TypeScript strict-mode reserved words; `void` stays a type name |
| Q13 | What grammar covers record expressions, patterns, arrow detection, brace meaning, and newline continuation? | Surface grammar | The parser cannot be written without it | Phase A plan, section 5.1; no unary operators in version 0 |
| Q14 | Can a provider supply single service methods? | Retry and providers | A `Layer` supplies whole services | Phase A: whole services only |
| Q15 | May a module constant refer to a later declaration, and what is the initialization order? | Modules and boundaries | Emitted code fails with TS2448 in source order | Phase A: yes; topological order over eager dependencies; a cycle is a diagnostic |

## 10. What must be measured before committing

No number in this document is a measurement. Each item below names the
measurement, the input, and the decision it informs.

| # | Measurement | Input | Decides |
| --- | --- | --- | --- |
| M1 | Wall time from `didChange` to `publishDiagnostics`, and hover round trip, with the core on the main thread | The five examples; a synthetic module at three sizes (small, medium, large) with an edit script: body edit, header edit, alias edit, mode-flip edit | Debounce setting; worker or main thread; the budget in D9 |
| M2 | Whole-module recheck time per stage (lex, parse, resolve, check, lower, emit), object arrays against typed arrays for tokens | Same synthetic sizes | Phase B need (section 4.5); typed arrays; any Zig port |
| M3 | Re-execution counts per query per edit, and the fraction of edits that flip a mode or change an interface | Replayed edit script over the examples and the synthetic module | Phase B need; D8 |
| M4 | Peak resident memory after N replayed edits in the LSP process | Edit script, three N values | Revision release policy |
| M5 | `tsc` wall time over the emitted fixtures against Effect 4.0.5: cold `tsc` subprocess, warm `ts.LanguageService` in process, `tsgo` subprocess | The eight book targets and the five examples. As built: the five examples and the three synthetic sizes, with `deno check` as the baseline and the three runners as optional variants | Oracle runner; whether `watch --tsc` can default on |
| M6 | Noise floor of M1 and M2 on the user's machine with the same binary on both sides | Same inputs | Which differences count |

Protocol: follow the goose skill's `measurement.md`. Time the whole process for
`build`. Discard warm-up runs. Report a distribution, not a best of N. State
the noise floor from M6 beside every number. Keep a rejected-ideas ledger in
`docs/rejected.md`.

## 11. Proposed repository layout

```
effective-lang/
  deno.json                 tasks: test, check, build, bench
  src/core/                 lex, parse, syntax, index, link, resolve, types,
                            check, modes, lower, ir (typed-ir.ts copied),
                            validate, emit, db
  src/cli/                  check, build, watch
  src/lsp/                  server, virtual documents
  fixtures/                 .eff sources, expected diagnostics, golden .ts,
                            golden .ir.json, host registry samples
  docs/                     this document, rejected.md
```

Fixture style: error fixtures declare `// error: <code>` markers, after the
goose skill's `measurement.md`, "Testing the analyses". Positive fixtures have
golden IR and golden TypeScript. A round-trip test parses, prints, and parses
again. A differential test runs the validator over every golden IR.

## 12. Decisions for the user

Each decision lists its options. One option is marked as recommended. The
decision record at the top of this document shows which ones the user settled.

**D15. Repository.**
(a) The transpiler lives in `effective-lang`. Recommended.
(b) The transpiler lives in the `effective` repository, beside the spec.

**D1. Deliverable shape.**
(a) The LSP server is the product.
(b) A shared core library; the CLI first, the LSP second. Recommended.
(c) A shared core library; the LSP first, the CLI later.

**D2. Real-time loop.**
(a) Everything on save.
(b) Diagnostics and hover per change; generated files on save; `watch` and
`build` modes. Recommended.
(c) Generated files written on every change.

**D3. Host language.**
(a) TypeScript on Deno, data-oriented stage boundaries, Zig behind WASM only
after a measured need. Recommended.
(b) Zig.
(c) Rust with `salsa`.

**D4. Incremental model.**
(a) Whole-program rebuild per change, no memoization.
(b) Query-shaped core; module-level memoization with interface cutoff in
Phase A; declaration-level dynamic tracking in Phase B after M2 and M3.
Recommended.
(c) Full query system with dynamic tracking from day one.

**D5. Where `tsc` runs.**
(a) In the LSP inner loop.
(b) In emitter golden tests, `build --tsc`, and CI; opt-in in `watch`; never in
the LSP. Recommended.
(c) In the background of the LSP, with results shown as information.

**D6. Generated file location and import rewrite (Q7).**
(a) Next to the source as `users.ts`, specifiers `./users.ts`. Recommended.
(b) An output directory with `.js` specifiers for Node.
(c) Option (a) by default with a `--specifier-extension js` switch.

**D7. Identity encoding in tags, keys, and brand tokens (Q2).**
(a) Short names as in the book targets.
(b) Module-qualified strings such as `users#UserMissing`, module path relative
to a configured root. Recommended, because the spec requires distinct
identities across modules.

(c) Short names, qualified only on collision. Rejected: adding a module can
rename an existing tag.

**D8. The execution-mode firewall hole (I1).**
(a) Keep "source purity assertions" deferred; the incremental model
invalidates on mode change. Recommended for the transpiler's first version.
(b) Promote a purity annotation into the language now, which also gives pure
callback parameters.

**D9. Latency budget.**
(a) Set the budget after M1 and M6 give a baseline. Recommended.
(b) Set a budget now from the user's tolerance.

**D10. Host registry format (Q3).**
(a) A declaration file in Effective syntax with a `provider` form, plus a
`host:` name map in `effective.json`. Recommended.
(b) A JSON registry.
(c) A TypeScript declaration file read through the `typescript` API.

**D11. IR validator.**
(a) Implement the independent validator in the first version as the
differential oracle for the checker. Recommended.
(b) Defer the validator.

**D12. Output formatting.**
(a) Own printer with one fixed style and a `deno fmt --check` fixed-point
test. Recommended.
(b) Run `deno fmt` as a post-pass and remap spans.
(c) No formatting guarantee; exclude generated files from `deno fmt`.

**D13. Exported constants (Q4).**
(a) Require a type annotation on every exported constant. Recommended.
(b) Allow inference and accept firewall hole I6.

**D14. `int` arithmetic (Q6).**
(a) The emitter wraps `int` operations in a small runtime helper that raises a
defect outside the safe range. Recommended.
(b) Plain JavaScript arithmetic; the host accepts silent overflow.
(c) A compile-time option.

The user settled D1 to D15 on 2026-10-16. The decision record at the top of
this document lists each choice.

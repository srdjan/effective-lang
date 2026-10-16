# Phase A rules where the spec is silent

Status: ledger, 2026-10-16. The spec owner can override each rule. Each rule
names the part that chose it. The plan sets the policy: when the spec is silent,
the implementer picks the stricter rule and records it here.

## Lexer and parser (A1)

| Rule | Choice |
| --- | --- |
| Raw control characters in strings | Rejected (`syntax/003`), because JSON rejects them |
| Leading zeros in numbers | `01` is rejected (`syntax/006`) |
| Union continuation | A newline before `\|` does not continue a type; a newline after `\|` does |
| `fails` and `uses` on a new line | Continue a clause only when an identifier follows |
| `Some(_)` | Accepted; `_` is the binding name |
| Nesting depth | 512 levels of expressions and types; deeper input is `syntax/009` |
| Parenthesized types | `(A \| B)[]` and the empty tuple type are accepted |

## Projects and names (A2)

| Rule | Choice |
| --- | --- |
| Namespace | One namespace per module for types, errors, services, providers, constants, and imports |
| Prelude names | Neither modules nor locals may declare them; modules also may not declare builtin type names |
| Shared scopes | A block after a parameter list, pattern, or handler shares its scope, so a redeclaration is `declaration/001` |
| Early outer use | A block that uses an outer name and later binds the same name is `declaration/004` |
| Own initializer | `const x = x` is `unknown-name/001` |
| Module paths | Only letters, digits, `_`, `.`, `-`, and `/` |

## Declarations and types (A3a)

| Rule | Choice |
| --- | --- |
| `Brand<T>` position | Only as the whole body of a `type` declaration |
| `unknown` | Not a top type: only `unknown`, `never`, and the error type fit it |
| Private parameters | A module function parameter needs an annotation when nothing supplies its type (`declaration/011`) |
| Function types in type syntax | Execution defaults to `effect` |
| Provider compatibility | Equal `provides`, compatible execution, acquisition sets as subsets |
| Interface hash | Ignores spans, so comments and body edits do not change it |
| Interface payload | Also carries the declarations of other modules that the exports reach, so the hash covers them |

## Expressions, modes, and contracts (A3b)

| Rule | Choice |
| --- | --- |
| Contract diagnostics | One diagnostic per function lists every extra error or capability |
| Literal widening | Unannotated bindings, branch joins, inferred results, and the `fold` accumulator widen literals to primitives |
| Branch joins | Without an expected type, one branch type must accept the other; no union is formed |
| Local recursion | A block-level function cannot call itself (`execution-mode/003`) |
| Mode fixed point | Round cap 32 (`execution-mode/004`) |
| Equality | Compares string, numeric, boolean, or one primitive brand; records and options are rejected |
| `retry` form | The second argument must be the literal record `{ times: N }` |
| Broken declarations | Checked for side tables; their body diagnostics are suppressed until the syntax is fixed |
| Effect type order | Sorted identity order everywhere, including `typeAt` |

## Lowering (A4)

| Rule | Choice |
| --- | --- |
| Error construction | The argument must be a record literal without a spread (`type-mismatch/010`), because the IR `error` node lists its fields |
| Pipeline stage sets | A stage call carries its arguments and its invocation only; the left value's sets sit on its `$p` binding |
| Known limit | A `retry` or `provide` stage whose left value is effectful keeps the checker's sets, so the validator may report it |
| Prelude value names | `$builtin/<name>/<hash>`, the text after `#` in the id |
| Declaration order in IR | Source order by span start |

## Emission (A6a)

| Rule | Choice |
| --- | --- |
| Pure-to-effect lift | A pure function fits an effect function type only directly in a value position; the emitter wraps it there. Nested in a record, array, option, tuple, union, result, or parameter, the execution must match |
| Hoisting | Trivial children (literals, references, `None`, closures) stay inline |
| Service method parameters | Named `a`, `b`, `c` in emitted service shapes, because the IR has no parameter names |
| Reached declarations | Declarations that an exported signature reaches are exported in TypeScript, even when the source keeps them private |
| Generated header | Each file starts with a comment that names its `.eff` source |

## Validation (A5)

| Rule | Choice |
| --- | --- |
| One fault, one diagnostic | After a disagreement the validator continues with the recomputed value; for an unknown identity it continues with the recorded value |
| Exact nodes | The recorded type equals the recomputed type for a reference, get, update, error, brand, unbrand, call, perform, fail, retry, provide, binary, and block |
| Contextual nodes | For a literal, `None`, `Some`, record, array, tuple, closure, `if`, `match`, and `catch`, the parts must fit the recorded type |
| Type equality | Mutual assignability, so aliases are transparent and union order does not matter |
| Record fields | Field order does not matter; the checker compares fields in order |
| Effect sets | Comparison ignores order and duplicates; an unsorted or duplicated set gives only `validation/008` |
| Closures | The type sets contain the body sets; the mode is effect when a set is nonempty or the body is effect |
| Function contracts | An inferred contract equals the body sets; an explicit contract contains them |
| Identities | `<kind>:<module>#<name>` for declarations and `cap:<module>#<Service>.<method>` for capabilities |
| Builtins | A builtin reference is valid only as a callee; the prelude import has a fixed shape |
| Area of a branch fault | A `catch` branch is Recovery; an `if` or `match` branch is Types |
| Not checked | Match exhaustiveness, unreachable arms, and constant initialization order stay with the checker |
| Payload spans | A span in an import payload is checked only when the caller supplies its source text |
| Unexpected shape | An exception inside a check gives `validation/008` and does not stop the run |

## Spans and formatting (A6b)

| Rule | Choice |
| --- | --- |
| Position outside every record | Not mapped. The header, the imports, the helpers, the host assertions, and the blank lines lie outside every record. A position inside a declaration maps to that declaration at worst |
| Nested records | The innermost record wins. Of two records with one range, the record that closed first (the inner one) wins. Empty records are dropped |
| Positions in the API | `mapGenerated` takes a one-based line and column in UTF-16 units, as `tsc` and the diagnostic format do. `mapOffset` takes a zero-based offset |
| Source map targets | A generated position maps to the start of the source span of its innermost record, not to a range |
| Source map segments | One segment at each record start, each record end, and each generated line start. Consecutive segments with one target merge. An unmapped part after a mapped part gets a one-field segment |
| Source map fields | `names` is empty. `sources` are paths relative to the map. `sourcesContent` is optional. A missing source text is an error value |
| Source map comment | The emitted text ends with the line `//# sourceMappingURL=<file>.map`, for example `users.ts.map`. Part A7 added it, so that the written `.ts.map` files take effect |
| Import span of a host assertion | The IR has no import span. The span is the imported name in the `.eff` import, for example `UsersLive`. `hostImportSpans(project)` reads it from the project index |
| Host assertion range | The emitter records the whole statement of each assertion constant. A `tsc` error anywhere in it is `host-boundary/001` |
| Other `tsc` errors | No code is registered. The mapper returns `source` (the innermost source span, probably an emitter defect) or `generated` (no span table and no host module, or outside every record). Part A7 prints both as `TS<number>` |
| Output of `deno check` | The parser keeps the first line of each message and the first location of each diagnostic. It drops notes about related declarations |
| Wrong host module | A host layer of the declared service tag that lacks a method fails inside the host module. The mapper returns `host-module`, and part A7 prints it as `host-boundary/001` at that position |
| Own service class in a host module | `tsc` accepts a layer of a host-defined service class with fewer methods, because `Layer` is contravariant in its service. The fixture therefore changes the type of `find` as well |
| Layout of an arrow chain | One line when it fits. Else the heads stay on the first line and the body moves down. Else the chain moves below `=` and the body moves down again |
| Layout of a selector call | When the body of the selector arrow moves down, the arguments of the call get one more indent level |
| Layout of a conditional chain | A match with several arms prints `a ? x : b ? y : z` with every `?` and `:` at one indent level |
| Function type parameters | A broken parameter list of a function type ends with a comma |
| Not at a fixed point | A binary expression that is longer than 80 columns, and an arrow chain whose first parameter list must break. The printer does not break them yet |

## Program and CLI (A7)

| Rule | Choice |
| --- | --- |
| Check memo key | The key holds the module text, its path, the project configuration, the analysis diagnostics of its file, and the signature of each reached module |
| Signature of a reached module | The hash of its full interface payload with spans, not the interface hash. IR imports carry the spans of foreign declarations, so a span change must recheck importers. A test shows that the interface hash alone breaks equality with a run from scratch |
| Signature without an interface | A module whose interface is an error value uses its own key as signature |
| Reached module not yet checked | In an import cycle, a reached module that comes later in the order counts as absent, as in `checkAnalysis` |
| Project configuration in the key | Every key holds the configuration, so a change of the host registry rechecks all modules |
| Intern table | One `TypeTable` for the life of the program. It only grows. The memory growth is measurement M4 |
| Rechecked list | It names every module that was checked again, in topological order, and it includes `.effi` modules |
| Lazy queries | IR, emitted text, span table, and source map are computed on first use and stored on the memo entry |
| Config error in the program | `update` returns the error value and starts no revision. The files stay changed, and a later fix returns to the old memo |
| Modules of a project | Every `.eff` file under the root. The walk skips directories that start with `.` and `node_modules`. `.effi` files come from `effective.json` |
| Exit codes | 0 without diagnostics, 1 with a diagnostic or a failed build step, 2 for a usage or configuration error. A missing `effective.json` is a configuration error |
| Help | `--help` prints the usage on stdout and exits 0 |
| Output line | `path:line:column: error code: message`. A message with several lines prints as one line. Related spans are not printed |
| Sort order | Path, then line, then column, then code, then message |
| Summary line | The tool prints `N modules, M diagnostics` to stderr. N counts `.eff` modules. A build adds the number of files that it wrote |
| Written files | The tool writes a file only when its text differs from the file on disk |
| Validation failure | A module with a `validation` diagnostic is not written |
| Lowering or emit failure | A failure that is not a diagnostic of the module prints `error: ...` on stderr and gives exit code 1 |
| `--tsc` after an error | The tool skips `deno check` when the build has a diagnostic or a failure, because the set of written files is incomplete |
| `--tsc` files | The files that this build produced, plus the host modules of `effective.json` |
| `--tsc` configuration | A temporary directory with `deno.json`, removed after the run. The command has `--no-lock`. The project directory gets no new file |
| `--tsc` without a parsed diagnostic | If `deno check` exits nonzero and prints no diagnostic, the tool prints a note and exits 1 |
| Permissions of the task | `--allow-read --allow-write --allow-run=deno`. The tool needs no environment access |
| Task directory | `deno task` runs in the repository root, so the default root `.` is the repository. Users pass a root |
| Watch events | The real source debounces events for 100 ms and keeps only `.eff`, `.effi`, and `effective.json` paths |
| Watch rebuild | Each batch rereads the root and gives the program the files that changed. A batch with no change prints nothing |
| Watch output | `rechecked: <modules>` and the summary go to stderr. Diagnostics go to stdout. Only a changed file starts a build |
| Watch errors | A broken project file at start gives exit code 2. A broken project file later prints an error and the loop goes on |
| Watch and `--tsc` | `watch --tsc` runs `deno check` after each build without errors |
| Public API | `mod.ts` re-exports the IR types with `export type *`. The explicit `Diagnostic` of the core wins over the one in `ir.ts` |
| Error path in messages | A malformed `effective.json` is named `effective.json`, as `parseConfig` reports it. A missing one is named with the root |

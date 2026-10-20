# Scout ARC: architecture and docs

Scope: cross-cutting structure of src/core, src/cli, src/lsp, playground/src, bench/, scripts/.
Scratch data and scripts: /tmp/rederive/scratch-ARC/ (mut.ts, graph.ts, api.ts, touch.sh, touch.txt,
graph-core.txt, mut.txt, ce_family.tsv, members_all.txt, throws.txt).
Coverage numbers are from the full suite: /tmp/rederive/covall/lcov.info and /tmp/rederive/covall.txt.

## 1. Baseline

Own-body cyclomatic numbers come from /tmp/rederive/fns.tsv (class methods included).

| File | LOC | Branches | Max cyclo | Top-3 functions by cyclomatic | Line % | Branch % |
|---|---|---|---|---|---|---|
| src/core/check_expr.ts | 7474 | 1972 | 142 | schemaCall:1608 (142), builtinCall:1008 (103), binary:6654 (41) | 88.3 | 89.6 |
| src/core/validate/expr.ts | 5517 | 1629 | 195 | schema:1716 (195), compute:421 (102), scopedReferences children switch:3047 (101) | 82.3 | 83.2 |
| src/core/emit/expr.ts | 3014 | 768 | 126 | structural:760 (126), leaf:2644 (64), schemaExpr:1452 (39) | 94.7 | 89.8 |
| src/core/lower.ts | 1839 | 388 | 108 | invoke:458 (108), stageEffects:1136 (27), expr:327 (19) | 89.5 | 89.7 |
| src/core/check.ts | 1883 | 439 | 40 | named:426 (40), deferredType:747 (28), referencedIds:1034 (27) | 93.9 | 92.1 |
| src/core/resolve.ts | 1537 | 342 | 39 | expr:1237 (39), resolveType:1092 (29), qualified:1051 (16) | 95.9 | 95.0 |
| src/core/db.ts | 534 | 73 | 18 | check:348 (18), update:317 (10), revisionDelta:513 (8) | 96.8 | 82.8 |
| src/core/check_project.ts | 591 | 99 | 20 | checkModuleBodies:215 (20), collectEntries:162 (13), values:252 (12) | 97.3 | 91.7 |
| src/core/emit/walk.ts | 259 | 196 | 101 | childrenOf:14 (101) | 99.6 | 99.6 |
| src/core/tables.ts | 281 | 5 | 6 | combine:51 (6) | 100 | 100 |
| src/cli/events.ts | 51 | 10 | 9 | debounceBatches:18 (9) | 100 | 100 |

The six largest cyclomatic values in the pipeline are dispatch switches over builtin or IR kinds:
builtinCall 103, compute 102, scopedReferences 101, childrenOf 101, invoke 108, structural 126.
Each of these switches is one "touch site" for each builtin (see section 1.4).

### 1.1 Hexagonal boundary (item 1)

Observation: src/core has 0 matches for `Deno.`, `Date.now`, `Math.random`, `performance.now`,
`console.`, `globalThis`, `setTimeout`, `setInterval`, `fetch(`, `new Date(`, `crypto.`, and
`import.meta`. src/core has 0 non-relative imports. The only `async`/`await` text in src/core is
emitted TypeScript inside string literals (emit/explicit_scope.ts:42, 46). `TextEncoder` at
sha256.ts:92 is a pure web-standard API.

Adapters: `Deno.*` in src/cli occurs only in deno_io.ts (16 lines) and main.ts:79 (the wiring line).
src/lsp/main.ts has 6 `Deno.*` lines and supplies `schedule`, `exit`, `memory`, `stderr`, and `send`
as ports to `LanguageServer`. src/cli/io.ts defines `CliIo` (fs, denoCheck, watch, stdout,
stderr), and every Deno-backed implementation is in deno_io.ts. playground/src/compile.ts takes
`now` and `program` as ports (compile.ts:36-38, 133). One clock is not injected: src/cli/events.ts:13
calls `setTimeout` directly (see ARC-9).

A test enforces the validator import rule (tests/validate_test.ts:1605). No test enforces the
"core does no I/O" rule (see ARC-8).

### 1.2 Capabilities and module state (item 2)

Module-level `let`: 1, at bench/m5.ts:105 (`runCounter`, a temp-name counter). Module-level mutated
Map: 1, at playground/src/editor.ts:80 (`indentMarks`, a memo of immutable CodeMirror decorations).
src/ has 0 of each. All 26 module-level Map/Set constants in src/ are typed `ReadonlyMap` or
`ReadonlySet`.

`Program` (db.ts:273) is the only memo that lives across calls. It owns `files`, `parses`,
`entries`, and one `TypeTable` (db.ts:281, append-only interning, reused across revisions). The CLI
builds it inside `Session` (src/cli/session.ts:38), the language server inside `ProjectState`
(src/lsp/projects.ts:76), and bench at m2.ts:545, 549 and m5_target.ts:66. The playground receives it
as a port (`ProgramPort`, compile.ts:133). The two other `TypeTable` constructions
(check_project.ts:442, interface.ts:361) are fresh per call. Other memos are function-local:
check.ts:1505, emit/doc.ts:239 (WeakMap), check_project.ts:231. Program is not injected into
Session or ProjectState. Program is pure, so this is not a hidden I/O dependency. I make no
finding on it.

### 1.3 Purity of the large stages (item 3)

The counts come from an AST pass (/tmp/rederive/scratch-ARC/mut.ts). The pass counts direct
mutators (push, set, add, delete, pop, splice, unshift, sort, reverse, clear), assignments, and
++/--, classified by the root binding of the target.

| File | Direct mutations | per 1000 LOC | local | this-field | captured | parameter |
|---|---|---|---|---|---|---|
| check_expr.ts | 107 | 14.3 | 80 | 16 | 7 | 4 |
| lower.ts | 39 | 21.2 | 34 | 4 | 0 | 0 |
| emit/expr.ts | 34 | 11.3 | 30 | 0 | 4 | 0 |
| validate/expr.ts | 31 | 5.6 | 14 | 4 | 12 | 1 |

(The raw validate/expr.ts count was 234. 203 of those were `this.add(` diagnostic-report calls that the
pass misread as `Set.add`, so I removed them.)

Writer-style effects through helper methods are more frequent than direct mutation:

| Stage | Diagnostic writes | Side-table writes | Shared intern-table writes |
|---|---|---|---|
| check_expr.ts | 205 `this.report(`/sink | 236 `this.finish(` (body.info), 90 `this.fact(`, 4 `body.locals.set` | 151 TypeTable constructor calls on the Program-wide table |
| validate/expr.ts | 203 `this.add(` | 0 | 0 (own env) |
| emit/expr.ts | 0 (throws instead) | 0 | 101 `scope.effect(` import registrations, 29 `scope.temp(` fresh names |
| lower.ts | 0 (throws instead) | reads facts only | 0 interning |

What leaks: (a) check_expr interns into the Program `TypeTable`. This is deliberate and
append-only, so references stay valid (db.ts:280 comment). (b) Parameter mutation in check_expr at
2941, 7166, 7210, 7366 writes into caller-owned pattern-coverage state. (c) The emitter's Scope
collects imports and fresh names in traversal order. Everything else is local accumulation in a
function or in a per-body instance (`BodyChecker`, `BodyLowerer`, `Scope`). No stage writes
module-level state.

### 1.4 Module graph (item 4)

Import graph of the 46 src/core files (value and type imports): 0 cycles (Tarjan SCC, graph.ts).
The highest fan-in is ir.ts 34, source.ts 17, diagnostics.ts 15, project.ts 13, syntax.ts 10, and
types.ts 8. The highest fan-out is mod.ts 15, check_project.ts 14, db.ts 14, editor.ts 14, lower.ts 12,
and check_expr.ts 11. The emitter imports from the front end only `lower.ts` (type `LowerError`) and
`project.ts` (type `ProjectConfig`), plus ids.ts. lower.ts imports 4 syntax helpers from
check_expr.ts (see ARC-3). Full table: /tmp/rederive/scratch-ARC/graph-core.txt.

Builtins: `PreludeName` has 103 names (resolve.ts:46). Families: stream 37, schema 24, collection 8,
scope 8, schedule 7, effect 6, ref 4, fiber 3, layer 3, option-brand 3.

Cost to touch one builtin. I list every code site for one sample per family. The full file:line
list is in /tmp/rederive/scratch-ARC/touch.txt. A "site" is one enclosing declaration that names
the builtin or its IR/fact kind.

| Sample (family) | Sites | Files | resolve | check_expr | tables | lower | ir.ts | validate | emit | grammar |
|---|---|---|---|---|---|---|---|---|---|---|
| takeStream (stream) | 14 | 9 | 3 (94, 199, 374) | 2 (1106, 4303) | 1 (160) | 1 (778) | 1 (164) | 3 (533, 3115, 4140) | 2 (expr 1028, walk 83) | 1 |
| scheduleSpaced (schedule) | 14 | 9 | 3 (78, 183, 334) | 2 (1155, 4685) | 1 (189) | 1 (909) | 1 (184) | 3 (563, 3143, 4710) | 2 (1171, walk 117) | 1 |
| schemaOptionalKey (schema) | 13 | 7 | 3 (116, 221, 343) | 4 (table 283, 1026, schemaCall 1801/1993, 2480) | 1 (210) | 0 | 1 (202) | 2 (schema 1723-1866, 2368) | 1 (schemaExpr 1531) | 1 |
| addScopeFinalizer (scope) | 19 | 10 | 3 (56, 161, 362) | 2 (1065, scopeCall 2812) | 1 (128) | 2 (invoke 631, stageEffects 1232) | 1 (143) | 3 (492, 2908, 3083) | 6 (structural 1433, isLeaf 2460, evaluatedChildren 2509, leaf 2775, scope.ts 398, walk 51) | 1 |
| race (effect) | 13 | 9 | 2 (104, 209) | 2 (1173, 5301) | 1 (198) | 1 (961) | 1 (192) | 3 (581, 3157, 5187) | 2 (1304, walk 131) | 1 |
| updateRef (ref) | 16 | 9 | 2 (108, 213) | 2 (1178, refCall 5336) | 1 (199) | 1 (969) | 1 (196) | 3 (586, 3165, 5221) | 5 (1446, 2474, 2532, 2859, walk 139) | 1 |
| joinFiber (fiber) | 18 | 9 | 2 (137, 242) | 3 (1050, 2598, 2637) | 1 (229) | 1 (609) | 1 (207) | 4 (609, 2541, 2568, 3188) | 5 (1422, 2449, 2536, 2913, walk 156) | 1 |
| partitionAll (collection) | 18 | 9 | 3 (146, 251, 325) | 3 (1190, 5668, 5816) | 1 (171) | 1 (848) | 1 (174) | 3 (475, 2647, 3072) | 5 (1426, 2453, 2500, 2714, walk 99) | 1 |
| mergeLayers (layer) | 13 | 9 | 2 (110, 215) | 2 (1182, 5532) | 1 (201) | 1 (976) | 1 (198) | 3 (590, 3169, 5351) | 2 (1297, walk 143) | 1 |

Range: 13 to 19 sites in 7 to 10 files for each builtin. Which sites the plan can remove:
- resolve.ts: 2 or 3 sites (the `PreludeName` union, `PRELUDE_NAMES`, and `SHADOWABLE_PRELUDE_NAMES`)
  can become 1 table (ARC-1). Saving: 1 to 2 sites for each builtin.
- tables.ts `NodeFact`: for the 44 payload-free tags, this site and the `this.fact` call carry no
  information beyond the builtin name (ARC-5). Saving: 1 site, which needs measurement.
- emit: the leaf scheme (isLeaf, evaluatedChildren, leaf) adds 3 sites for each leaf-scheme kind,
  and walk.childrenOf adds 1 more. That is emitter-internal and belongs to scout EMT.
- These sites are deliberate and must stay: validator 2 to 4 (independent oracle), ir.ts 1 (copied
  from the sibling repo, so each IR kind change starts in the sibling), and the grammar 1. The
  grammar is checked against `PRELUDE_NAMES` by tests/vscode_client_test.ts:115.
After ARC-1 and ARC-5, the measured floor is 11 to 17 sites. Most of the cost is the real
per-stage semantics, not duplication.

Is check_expr.ts a split candidate? Yes, along the builtin-family seam. The measurement is in ARC-4.

### 1.5 Error handling (item 5)

src/core has 91 `throw` text matches. 6 are not throws in core code: 2 are emitted code strings
(emit/decls.ts:487, emit/expr.ts:1333), 1 is the lexer keyword (lex.ts:129), and 3 are rethrows of
foreign errors (editor.ts:114, emit/emit.ts:208, lower.ts:1822). That leaves 84 real throws:
- 71 are internal invariant violations: 60 `throw internal(...)` in lower.ts and emit/, and 11
  `throw new Error` (source.ts 86, 110; parse.ts 248, 305; types.ts 325, 580, 1153;
  check_project.ts 167, 220; check.ts 1868; emit/sourcemap.ts 33). These are acceptable.
- 13 are `throw unsupported(...)`, an expected-failure class carried by exceptions: lower.ts 529,
  1305; emit/expr.ts 741, 1897, 2210, 2372, 2407; emit/decls.ts 227, 529; emit/scope.ts 281, 285;
  emit/types.ts 414, 517. The entry points convert them to `Result` with try/catch at lower.ts:1808
  and emit/emit.ts:187, and editor.ts:112 converts them to `unavailable`. See ARC-6.
src/core has 25 functions that return `Result`. It has one `Result` type (ir.ts:313, re-exported
through source.ts).

## 2. Findings ranked by leverage

### ARC-1 (TYPE-DRIVEN): one prelude table and an exhaustive builtin dispatch

Problem: resolve.ts states the prelude 3 times. The `PreludeName` union (46-149, 103 names) and
`PRELUDE_NAMES` (151-255, 103 names) contain the same set. `SHADOWABLE_PRELUDE_NAMES` (322-388, 71
names) is a subset. `asPrelude` casts `name as PreludeName` (resolve.ts:401). `builtinCall`
(check_expr.ts:1008) widens `target.name: PreludeName` to `name: string` at line 788. It then
switches over 102 cases, with a `default` (1201) that reports "is a value, not a function". Only
`None` reaches that default legitimately (I compared the case labels with the union). A new prelude
name with no checker handler therefore compiles, and the checker reports it as a type-mismatch.
Proposal: replace the three lists with one `as const` record:
`{ takeStream: { shadowable: true }, ... }`. Derive `PreludeName` as `keyof typeof`, and derive the
two sets from the record. Type `builtinCall(name: PreludeName)`. Add `case "None"` with the current
default body and an assert-never on the remaining value.
Contract: resolve.ts exports `PRELUDE_NAMES: ReadonlySet<string>`,
`SHADOWABLE_PRELUDE_NAMES: ReadonlySet<string>`, and `PreludeName`. playground/src/highlight.ts and
tests/vscode_client_test.ts read `PRELUDE_NAMES`. `isReservedPreludeName` gives `true` for the
prelude names that are not shadowable. Set membership and iteration order must stay the same,
because the playground and grammar tests iterate the set.
Judging tests: tests/resolve_test.ts (35 tests), tests/vscode_client_test.ts (grammar contains every
prelude name), tests/playground_highlight_test.ts (13), and `deno task behavior:capture`.
resolve.ts coverage is 95.9% lines and 95.0% branches. The tests are strong enough for a
data-only change.
Projected delta (counted): about -103 duplicated name lines (one of the two 103-entry lists),
-71 lines (the shadowable list becomes a flag), -1 cast, -1 `default` in builtinCall, and +1 explicit
case. Branch delta 0. The resolve.ts sites for each builtin drop from 3 to 1.
Risk: low. Order of names: the derived set must keep the current insertion order, or the tests must
not depend on that order.

### ARC-2 (MECHANICAL): one per-module check step for the two project drivers

Problem: `Program.check` (db.ts:348-483, 140 own LOC, cyclomatic 18) restates the body of
`checkAnalysis` (check_project.ts:441-497, 59 LOC, 7 branches). db.ts:347 says so: "The same steps
and order as `checkAnalysis`". Both copies contain the same code:
- the reach and visible loop (db.ts:365-373, check_project.ts:450-457, 8 lines);
- the stage sequence: `checkModuleDeclarations`, `buildTypeGraph`, `checkModuleBodies`,
  `buildInterface`, and `normalizeDiagnostics` (db.ts:388-408, check_project.ts:458-477);
- the 11-field `CheckedModule` literal (db.ts:422-434, check_project.ts:478-490).
A third copy of the loop, `checkDeclarations` (interface.ts:357-388), has no caller in src. Only tests/check_test.ts uses it (13 references, some with custom modes).
Proposal: extract `checkModuleStep(analysis, name, table, graphs, interfaces) -> { graph, built,
checked }`. Use the step in both drivers. Keep the memo fields (`rest`, `lowerKey`, `signature`, and
`payload`) in db.ts.
Contract: `checkAnalysis(analysis)` and `Program.update(changes)` give equal diagnostics, IR, text,
and maps for the same files. tests/db_test.ts asserts this with `fromScratch` against `fromProgram`
(16 tests).
Judging tests: db_test (differential, strong) and behavior:capture. Constraint:
scripts/behavior_capture.ts:54 hooks the exact text
`  return { ok: true, value: checkAnalysis(analysis.value) };` in check_project.ts. That line must
stay exactly once, or the oracle fails with "anchor missing". The capture records only the
`checkProject` path, not `Program`, so db_test is the only judge of the Program path.
db.ts branch coverage is 82.8%.
Projected delta: about -43 duplicated lines. -5 branches leave db.ts (1 for, 2 if, 1 `built.ok`,
1 `?:`), and the shared step holds them once.
Risk: low to medium. The memo cutoff must still skip the step on a cache hit.

### ARC-3 (MECHANICAL): remove the lower.ts -> check_expr.ts edge and the decodeString duplicate

Problem: lower.ts:13-18 imports `BinaryOperator`, `kidsOf`, `literalOf`, and `operatorOf` from the
7474-line body checker. These are syntax helpers (check_expr.ts:136, 174, 195, 215).
check_project.ts:33-34 also imports `kidsOf` and `shortName` from it. `decodeString` exists twice:
check.ts:1022 (exported, used by check.ts:412 and check_expr.ts:203) and index.ts:353 (private, with
an extra quote guard).
Proposal: move the 4 syntax helpers and `shortName` to syntax.ts, or to a new small syntax-helper
module next to it. Keep one `decodeString` in lex.ts with the quote guard.
Contract: the functions keep their signatures. `decodeString` returns `undefined` for a token that
is not a closed JSON string. The current guard version is a superset of the check.ts behavior,
because a token that does not start and end with `"` makes `JSON.parse` give a non-string or throw.
Judging tests: lex_test, parse_test, lower_test, and behavior:capture.
Projected delta: -1 import edge (lower -> check_expr), -1 duplicate function (about 10 lines). The
importers of check_expr.ts drop to check_project.ts only, which uses the body entry points. This is
a prerequisite for ARC-4.
Risk: low.

### ARC-4 (MECHANICAL, structural): split check_expr.ts along builtin families

Evidence (fns.tsv, own-body LOC):

| Family | Methods | Own LOC | Branches | Uncovered lines (full suite) |
|---|---|---|---|---|
| core (expressions, patterns, contracts, helpers) | 115 | 3046 | 1011 | 159 (5.2%) |
| stream | 37 | 1514 | 311 | 255 (16.8%) |
| schema | 6 | 916 | 228 | 26 (2.8%) |
| collection | 6 | 489 | 106 | 81 (16.6%) |
| scope | 8 | 392 | 45 | 37 (9.4%) |
| schedule | 6 | 316 | 70 | 69 (21.8%) |
| effect | 7 | 268 | 67 | 42 (15.7%) |
| layer | 3 | 180 | 46 | 53 (29.4%) |
| fiber | 2 | 108 | 21 | 32 (29.6%) |
| ref | 2 | 87 | 30 | 12 (13.8%) |

The family methods hold 4270 of the 7316 own-LOC (58%). The helper surface that 2 or more families
use has 29 `this.` members (members_all.txt). The top members are table, report, finish, fact, arity,
argInfo, tree, noPipeline, isError, callback, kids, functionOf, fits, body, widen, targets, dataOnly,
inlineStreamCallback, benv, jobFunction, and concurrencyBound. The stream family uses 26 distinct
members, and 8 of them are stream-private. No test imports check_expr.ts (0 of 190 test import
statements), and no bench or script file imports it either. The importers in src are lower.ts and
check_project.ts (1 after ARC-3).
Proposal: after ARC-1, define a `BuiltinContext` interface of about 22 members (the shared helpers
above, with `argInfo` as the callback into expression checking). Move each family into
`check_builtins/<family>.ts` as functions `(ctx, node, args, expected) => NodeInfo`. Replace the
`builtinCall` switch with a `Record<PreludeName, BuiltinHandler>` table, which the compiler checks
for completeness. The resulting check_expr.ts is about 3046 own-LOC, and the largest family module
is about 1514.
Contract: `checkFunctionBody` and `checkConstantBody` (check_expr.ts:7413, 7461) are unchanged. They
take `BodyEnv` and give `FunctionRun` or `ConstantRun` with a diagnostic sink, a `BodyTable` (info,
facts, locals), and interning into the shared `TypeTable`. Diagnostic order and text, and fact and
info contents for each node, stay byte-identical.
Judging tests: the full fast and slow suites, and behavior:capture. Weakness: the capture compares
diagnostics only for inputs that tests already run. 761 check_expr lines are uncovered, and most
of them are arity and type-mismatch report paths: stream 255, schedule 69, layer 53, and fiber 32.
`deno check` protects a pure move against name errors. It does not protect against a wrong
argument order in a moved report call.
Projected delta: branch delta 0. Largest file 7474 -> about 3100 lines. builtinCall cyclomatic
103 -> 1 (the table lookup).
Note: validate/expr.ts has the same seam: stream 34 methods / 1344 LOC, schema 850, scope 405, and
schedule 339. That split belongs to scout VAL. It must not reuse the checker's family modules,
because the validator is independent.
Risk: medium. `BodyChecker` private state (errorCount, pendingLocals, sink) must stay behind the
context interface, and `this` binding in callbacks must stay correct.

### ARC-5 (TYPE-DRIVEN): the check -> lower fact tags that only restate the builtin name

Problem: `NodeFact` (tables.ts:107) has 75 kinds. 66 of them have the same name as an IR `Expr` kind.
44 builtin facts carry no payload (`{ readonly kind: "take-stream" }`). check_expr writes them with 76
literal `this.fact(node, { kind })` calls. lower `invoke` (cyclomatic 108) reads the facts back. The
side table is a partial `Map<NodeId, NodeFact>`, so lower has 8 "no ... fact" or "no checker info"
invariant throws (lower.ts:226, 276, 360, 408, 1013, 1407, 1469, 1536). 30 `invoke` cases are only
positional, as `{ kind, a: arg(0), b: arg(1), ...annotation }`. The list is in section 1.4 data:
retry-with-schedule, provide, 20 stream kinds, and others.
Proposal (needs measurement first): confirm that each of the 44 payload-free facts maps 1:1 from the
resolved builtin name. Lower can read `Target { kind: "builtin", name }` from `ctx.targets`. If the
mapping is 1:1, lower can derive the IR kind from a `Record<PreludeName, ...>` table, and the 44
NodeFact variants and their 44 writes go away.
Projected delta: -44 NodeFact variants, -44 `this.fact` calls, and -1 site for each builtin in the
cost table.
Risk: medium to high. The fact also records that the checker reached the builtin call. Lowering
runs only on modules with no diagnostics, which should make that record redundant, but I did not
measure it. Rank this finding below ARC-1 to ARC-4.

### ARC-6 (TYPE-DRIVEN): the 13 `unsupported` throws

Problem: 13 throws carry an expected failure (section 1.5). The full suite runs 12 of the 13 zero
times. Only emit/scope.ts:281 has hits (1). Most of them guard IR shapes that the checker never
produces: a record spread that is not first (lower.ts:1305), an option pattern outside an option match
(emit/expr.ts:2372, 2407), a builtin not in callee position (1897), a schema of a function type
(emit/types.ts:414, 517), and a self-dependent constant (emit/decls.ts:227). The try/catch-to-Result
conversion is written twice (lower.ts:1808-1823, emit/emit.ts:185-209).
Proposal: for each site, find the validator or checker rule that excludes the shape. That check
needs measurement for each site. Where such a rule exists, change `unsupported` to `internal`. Where
a source program can reach the site, add an error fixture, and make the site a diagnostic or a
`Result`. Keep one conversion helper for each stage.
Judging tests: tests/emit_test.ts, tests/lower_test.ts, validate_mutation_test, and the fixtures in
fixtures/errors/.
Projected delta: up to -13 expected-failure throws; the counted count depends on the per-site
check. The internal class stays at 71 or more.
Risk: low for a reclassification, and medium where a site becomes a Result through deep recursion.

### ARC-7 (MECHANICAL, boundary): adapters bypass the public API in mod.ts

Problem: src/cli (24 import statements, 10 core files), src/lsp (13, 5), and playground/src (9, 7) have
0 imports through src/core/mod.ts. bench has 21 statements (13 files, 2 through mod.ts). scripts has 4
(4 files, 1 through mod.ts). The adapters import 36 names that mod.ts does not export, 24 of them
distinct. Examples are `joinPath` (5 importers), `lineStarts` (5), `CONFIG_FILE` (2), `positionOf`,
`lineIndexOf`, `Span`, `ModuleIR`, the lex exports, and `PRELUDE_NAMES`/`BUILTIN_TYPE_NAMES`. The list
is in api.ts output. Each file move in a core re-base (ARC-3, ARC-4, and the VAL and EMT splits)
therefore edits adapter imports.
Proposal: route src/cli, src/lsp, and playground/src through mod.ts. That adds about 14 names to
mod.ts. bench and scripts may keep stage-level imports, because they measure stages.
Tests: tests import core internals through 190 statements in 88 files, of which 52 go through mod.ts.
This conflicts with the user rule "test through public APIs". No test imports check_expr.ts,
emit/expr.ts, or validate/expr.ts, so the large splits break no test import.
Projected delta: -46 internal-path import statements in the 3 adapter directories. +about 14
re-exports.
Risk: low.

### ARC-8 (test weakness): no guard test for "src/core does no I/O"

Problem: 0 violations exist today (section 1.1), but no test fails on a regression. The
validator-import rule has a guard at tests/validate_test.ts:1605.
Proposal: add one fast test that scans src/core/**/*.ts for `Deno.`, `console.`, `Date.now`,
`Math.random`, `performance.now`, `setTimeout`, `setInterval`, `fetch(`, `globalThis`, and
non-relative import specifiers. The test must skip string literals of emitted code: the matches at
emit/explicit_scope.ts:42 and 46 are `.await`, not `await`.
Projected delta: removes the "silent boundary regression" failure class. +1 test that runs in under
1 second.

### ARC-9 (MECHANICAL, hidden clock): src/cli/events.ts uses the real timer

Problem: `timer` (events.ts:10-16) calls `setTimeout` and `clearTimeout` directly.
`debounceBatches joins events that arrive close together` runs for 90 ms of real time
(test_fast.clean). The language server already takes a `schedule` port (src/lsp/main.ts:32).
Proposal: give `debounceBatches` a `sleep(ms) => { promise, cancel }` parameter, with the current
timer as the default in deno_io.ts.
Projected delta: -1 hidden clock dependency. The test time needs measurement after the change.

## 3. Test gaps that block a rederive in this area

- check_expr.ts has 761 uncovered lines (full suite). They are concentrated in builtin error paths:
  stream 255, schedule 69, layer 53, and fiber 32. behavior:capture cannot detect a changed message
  or code on these paths. ARC-4 is a move, so the risk is limited. A family module that changes
  logic needs error fixtures first.
- `Program.check` is not hooked by behavior:capture (scripts/behavior_capture.ts:51-57 hooks only
  `checkProject`). ARC-2 depends on the db_test differential tests alone, and db.ts branch coverage
  is 82.8%.
- 12 of the 13 `unsupported` throw sites have 0 hits (ARC-6).
- `checkDeclarations` (interface.ts:357) exists only for tests/check_test.ts. If ARC-2 removes it,
  check_test needs a different entry for its custom-mode cases.

## 4. Docs that the proposals would make stale

- README "Layout" (README.md:141-248). The file list matches the tree today: every src/core,
  src/cli, src/lsp, and bench file is listed, and no listed file is missing. The proposals would
  change these lines: check_expr.ts (157, ARC-4), resolve.ts (154, ARC-1), tables.ts (159, ARC-5),
  lower.ts (170, ARC-5), db.ts (165, ARC-2), interface.ts "and the declaration driver" (162, ARC-2),
  mod.ts (166, ARC-7), and the src/cli line about Deno APIs (193, ARC-9 adds a port).
- docs/transpiler-design.md: section 6.1 (stages table: "Check body -> side tables" and "Lower:
  syntax plus side tables") changes only with ARC-5. Lines 379 and 586 name db.ts and `Program`,
  and they stay true. Section 11 "Proposed repository layout" (699-717) is a design-time proposal. It
  already differs from the tree (no `link`, `check` is split), so it is history.
- CONCEPTS.md (31 lines, 4 terms) has no file references. No proposal affects it.
- docs/solutions/ (2 files). Both have `module: src/core/check_expr.ts` frontmatter, which ARC-4
  would change. They contain 3 line references that have already drifted:
  checker-result-type-from-expected-hint.md:55 (`check_expr.ts:4726-4730`) and 59
  (`validate/expr.ts:4777`), and checker-expected-type-is-enforced-not-a-hint.md:30 ("about line
  6858"; `joinResults` is now at 6881).
- docs/plans: 103 files = 45 dated .md plans + 1 .patch + 57 probe files in 12 probe directories.
  All 45 plans are dated 2026-10-16 to 2026-10-19. Each has a status of validated, implemented,
  accepted, or done, or it is a dated contract. They are history, not live structure. Three of them
  describe file structure: 2026-10-16-phase-a.md:95-115 (initial layout, now differs: `check.ts`
  "expression checking"), 2026-10-17-effect4-gap-closure.md:111 (`lower.ts:691`, drifted), and
  2026-10-17-effect4-gap-closure.md:194-197. The last one lists 5 stages to change for a new
  builtin. The measured cost (section 1.4) is 13 to 19 sites in 7 to 10 files. That plan omits
  tables.ts, emit/walk.ts, the validator `scopedReferences` walk, ir.ts in the sibling repo, and
  the grammar. No live document holds the "add a builtin" recipe. I record this as an observation.
  I do not propose a new document.

## 5. What not to touch

- The core I/O boundary: 0 violations (section 1.1). Ports in src/cli/io.ts and the LanguageServer
  constructor are already at the edge.
- Module state: 0 mutable module-level bindings in src/. The 2 in bench and playground are a temp-name
  counter and a decoration memo. Removing them does not remove a failure class.
- Program as the single cross-call memo, with its append-only TypeTable (db.ts:279-281).
- The module graph: 0 cycles. The emitter depends on the front end only through 2 type imports.
- Validator independence: validate/ imports only ir.ts, source.ts, diagnostics.ts, and its own
  files, and tests/validate_test.ts:1605 guards it. The 2 to 4 validator sites for each builtin are
  the oracle, not duplication.
- The `Result` type: one definition (ir.ts:313).
- The 71 internal-invariant throws: they mark checker/lowerer contract violations, and the entry
  points turn them into an `internal` error value.
- ir.ts: copied from the sibling repo, as the brief requires.

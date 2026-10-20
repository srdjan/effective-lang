# Scout FE: front end and edges

Area: src/core/{lex,parse,syntax,index,project,interface,db,editor,analyze,diagnostics,source,hash,sha256,ids,mod}.ts, src/cli/, src/lsp/, playground/src/.
Base revision: 730977c (clean tree). The scout did not change the repository.

Evidence method. The baseline numbers come from /tmp/rederive/baseline.json, /tmp/rederive/fns.tsv, and /tmp/rederive/cov/lcov.info (fast suite). The scout converted /tmp/rederive/covall to lcov for the area files (/tmp/rederive/scratch-FE/covall_fe.lcov, full suite). /tmp/rederive/scratch-FE/ranges.ts counts the decisions of the brief inside a line range.

For the four top findings the scout wrote a working sketch in /tmp/rederive/scratch-FE/*sketch/. The import map /tmp/rederive/scratch-FE/swap.json replaces the repository module with the sketch. A deliberately broken sketch made lex_test fail, so the map takes effect. With all four sketches swapped in, the fast suite passes: 1241 passed, 0 failed. The slow suite result is in the section "Slow suite with the sketches". Each sketch also has a differential script (diff.ts) that compares the old and the new module on every .eff and .effi file of the repository (139 files) and on generated inputs.

## 1. Baseline

Own-body cyclomatic from fns.tsv. "measure max" is the per-file value of measure.ts, which includes nested closures. Coverage is fast suite (lines hit/found, branches hit/found).

| File | LOC | Branches | Max cyclo (own body) | Top 3 by cyclomatic | Line cov | Branch cov |
|---|---|---|---|---|---|---|
| src/core/lex.ts | 636 | 143 | 124 | lex:244=124, isIdentStart:218=6, describeChar:235=6 | 536/542 (98.9%) | 254/259 (98.1%) |
| src/core/parse.ts | 1449 | 332 | 31 | parsePrimaryTypeInner:990=31, parsePrimaryInner:1221=20, binaryPrecedence:93=13 | 1343/1364 (98.5%) | 625/636 (98.3%) |
| src/core/syntax.ts | 207 | 11 | 6 | printTree:216=6, walk:190=4, hasProblem:205=3 | 97/97 (100%) | 18/19 (94.7%) |
| src/core/index.ts | 373 | 70 | 7 | splitAtEquals:198=7, splitDecl:247=7, splitAfterToken:158=6 | 285/291 (97.9%) | 108/114 (94.7%) |
| src/core/project.ts | 559 | 125 | 17 | parseConfig:124=17, visit:522=12, linkImport:398=12 | 414/426 (97.2%) | 191/205 (93.2%) |
| src/core/interface.ts | 350 | 82 | 26 | foreignTypeGraph:174=26, buildInterface:246=12, buildTypeGraph:119=11 | 265/267 (99.3%) | 127/132 (96.2%) |
| src/core/db.ts | 452 | 73 | 18 | check:348=18, update:317=10, revisionDelta:513=8 | 331/342 (96.8%) | 82/99 (82.8%) |
| src/core/editor.ts | 336 | 92 | 20 | targetSpan:238=20, definitionAt:276=12, backendOf:91=10 | 243/256 (94.9%) | 115/126 (91.3%) |
| src/core/analyze.ts | 48 | 4 | 4 | analyzeProject:28=4 | 30/30 (100%) | 8/8 (100%) |
| src/core/diagnostics.ts | 423 | 12 | 6 | compareDiagnostics:405=6, makeDiagnostic:387=3 | 385/385 (100%) | 21/21 (100%) |
| src/core/source.ts | 106 | 20 | 6 | lineStarts:39=6, compareSpans:120=4 | 79/79 (100%) | 35/35 (100%) |
| src/core/hash.ts | 11 | 1 | 2 | fnv1a64:9=2 | 10/10 (100%) | 1/1 (100%) |
| src/core/sha256.ts | 136 | 4 | 5 | sha256Hex:91=5 | 133/133 (100%) | 4/4 (100%) |
| src/core/ids.ts | 24 | 8 | 3 | moduleOfId:9=3, nameOfId:17=3, methodOfCapability:26=2 | 16/19 (84.2%) | 4/8 (50.0%) |
| src/core/mod.ts | 66 | 0 | 0 | - | 34/34 (100%) | n/a |
| playground/src/app.ts | 500 | 81 | 8 (measure max 43) | <anon>:145=8, main:189=7, renderFileTabs:320=6 | no test loads it | no test loads it |
| playground/src/compile.ts | 175 | 22 | 10 | run:140=10, createPlayground:129 | 108/108 (100%) | 38/41 (92.7%) |
| playground/src/editor.ts | 331 | 11 | 3 | buildIndents:93=3 | no test loads it | no test loads it |
| playground/src/highlight.ts | 98 | 20 | 20 | highlightTokens:73=20 | 81/81 (100%) | 31/31 (100%) |
| playground/src/model.ts | 151 | 23 | 7 | problemItems:52=7, outputState:107=5 | 88/88 (100%) | 38/39 (97.4%) |
| src/cli/args.ts | 79 | 24 | 17 | parseArgs:36=17 | 67/67 (100%) | 35/35 (100%) |
| src/cli/build.ts | 104 | 14 | 12 | buildRevision:41=12 | 71/71 (100%) | 24/24 (100%) |
| src/cli/deno_io.ts | 152 | 21 | 6 | sourceEvents:118=6, denoCheck:81=4 | 8/134 (6.0%); full 85/134 | n/a; full 15/21 |
| src/cli/events.ts | 45 | 10 | 9 | debounceBatches:18=9 | 40/40 (100%) | 13/13 (100%) |
| src/cli/format.ts | 116 | 23 | 9 | compareLocated:45=9, formatTscMappings:83=5 | 91/94 (96.8%) | 10/14 (71.4%) |
| src/cli/io.ts | 45 | 0 | 0 | - | types only | - |
| src/cli/main.ts | 64 | 25 | 11 | main:34=11, optionsOf:22=5 | 58/61 (95.1%) | 36/38 (94.7%) |
| src/cli/outputs.ts | 101 | 25 | 16 | writeGenerated:46=16, describeLowerError:25=7 | 48/77 (62.3%) | 24/29 (82.8%) |
| src/cli/report.ts | 26 | 5 | 4 | printOutcome:16=4 | 20/20 (100%) | 12/12 (100%) |
| src/cli/session.ts | 64 | 10 | <=1 | - | 46/46 (100%) | 13/14 (92.9%) |
| src/cli/tsc.ts | 71 | 6 | 6 | runTsc:49=6 | 44/52 (84.6%) | 5/7 (71.4%) |
| src/cli/watch.ts | 59 | 10 | 8 | watchLoop:20=8 | 42/44 (95.5%) | 10/11 (90.9%) |
| src/cli/workspace.ts | 55 | 22 | 11 | visit:34=11, isSourcePath:14=5 | 37/45 (82.2%) | 27/32 (84.4%) |
| src/lsp/features.ts | 271 | 83 | 11 | hoverRequest:66=11, statsRequest:290=9, definitionRequest:93=8 | 200/210 (95.2%) | 85/97 (87.6%) |
| src/lsp/jsonrpc.ts | 299 | 66 | 16 | classifyMessage:280=16, push:165=9, parseHeader:120=7 | 235/237 (99.2%) | 126/128 (98.4%) |
| src/lsp/main.ts | 42 | 4 | 2 | writeAll:17=2 | stdio entry, not loaded | - |
| src/lsp/methods.ts | 8 | 0 | 0 | - | 4/4 (100%) | n/a |
| src/lsp/positions.ts | 88 | 12 | 5 | lineEnd:11=5 | 67/67 (100%) | 20/20 (100%) |
| src/lsp/projects.ts | 430 | 89 | 10 | <anon>:345=10, groupDiagnostics:137=8, lookup:202=8, flush:377=8 | 310/328 (94.5%) | 135/153 (88.2%) |
| src/lsp/protocol.ts | 395 | 88 | 11 | narrowDidChange:356=11, narrowOptions:270=10, narrowDidChangeWatchedFiles:435=9 | 221/223 (99.1%) | 128/130 (98.5%) |
| src/lsp/server.ts | 387 | 58 | 10 | <anon>:308=10 (#handleRequest), describeError:194=3 | 298/300 (99.3%) | 88/92 (95.7%) |

The full suite does not close the CLI gaps. Full-suite lines: outputs.ts 48/77, format.ts 91/94, tsc.ts 44/52, workspace.ts 37/45, ids.ts 16/19 (identical to the fast suite).

## 2. Findings, ranked by leverage

### FE-1 (MECHANICAL): split the lexer into scanners and a one-character table

Problem. `lex` (src/core/lex.ts:244) is one 431-line function with own-body cyclomatic 124. Measured decision counts by region: number scan 335-379 = 28, string scan 381-457 = 28, comment and two-character operators 462-590 = 32, thirteen one-character tokens 591-642 = 13 `case` clauses with the same three statements (`push(K, i, i + 1); i++; continue;`).

Proposed refactor (sketch: /tmp/rederive/scratch-FE/lexsketch/lex_new.ts). The sketch keeps the typed-array `Lexed` output (docs/rejected.md). It adds `SINGLE: Uint8Array(128)` (kind + 1 for the 13 one-character tokens), `scanNumber`, `scanEscape`, `scanString`, `scanBlockComment` (with `indexOf("*/")`), and a local `pair` helper for `<` `<=`, `>` `>=`, `=` `=>`, `|` `|>`. Each scanner takes `text`, a start index, and a `Report` callback, and returns the end index.

Measured delta (sketch against base). `lex` own-body cyclomatic 124 -> 50. Largest new function: scanNumber 28, scanEscape 20, scanString 8. File branches 143 -> 131. File LOC 636 -> 598.

Equivalence. diff.ts compares kinds, starts, ends, trivia, triviaEnd, and diagnostics on 139 repository files and 20,000 random strings over the lexer alphabet (quotes, escapes, CR, digits, exponents, operators, astral and non-ASCII characters): 0 mismatches. lex_test (18 tests) and the fast suite (1241) pass with the sketch.

Speed: needs measurement with `deno task bench`. A scratch microbenchmark (30 runs on 134,472 characters of the repository corpus, not the project harness) gave median 2.08 ms for the sketch and 2.33 ms for the base in the second round. That result is an indication only. A character-class table for `isIdentStart`/`isIdentPart` (cyclomatic 6 each, called once per identifier character) is a further option. Its speed effect needs measurement.

Contract (from lex_test and the `Lexed` doc comments). Input: source name and text. Output: parallel typed arrays of tokens that end with one Eof token, trivia arrays, and `triviaEnd`. Tokens and trivia tile the whole text. A BOM is trivia. CR, LF, and CRLF are one Newline token each. Offsets count UTF-16 code units. The lexer never throws. Every bad form gives one diagnostic (syntax/001 to 007) and a token: an unknown character is an Unknown token, an astral one has width two.

Judging tests: tests/lex_test.ts (18 tests), parse_test, fixtures_test, golden fixtures, and `deno task behavior:capture <base> <head>`. Strength: the tests check diagnostic codes but check spans in only 3 tests. Line 438 (an invalid escape of an astral character, for example `"\😀"`) has no test, 2 branch arms uncovered. Recommendation: commit diff.ts as a fixed-seed property test before the change.

Risk: low. A speed regression is the main risk, so run `deno task bench` on both builds and record the result in docs/rejected.md.

### FE-2 (MECHANICAL): replace hand-written LSP narrowing with a small schema kit

Problem. src/lsp/protocol.ts:198-459 has 55 decisions. Of these, 30 are in the six narrowers (313-459) and 11 in helpers (222-264). Each narrower repeats `isRecord`, `typeof`, and `return fail(...)` with the path text written by hand: 25 `if` statements in the narrowers.

Proposed refactor (sketch: /tmp/rederive/scratch-FE/protosketch/protocol_new.ts). The kit has `Check<T> = (value, where) => Narrowed<T>`, `primitive(test, text)`, `object(shape)`, `array(item)`, `optional(check)`, and `params(method, shape)`. A mapped type `Out<S>` gives the result type, and optional keys stay optional under `exactOptionalPropertyTypes`. The narrowers become data, for example `params("textDocument/didChange", { textDocument: object({ uri: uriText, version: integer }), contentChanges: array(object({ text: string, range: optional(range) })) })`. The lenient `narrowOptions` stays hand-written, because it gives defaults and warnings, not errors.

Measured delta. protocol.ts branches 88 -> 36, LOC 395 -> 343, and max cyclomatic 11 -> 10 (narrowOptions). The sketch type-checks under the repository config and passes `deno lint`. It has one `as Out<S>` cast inside `object`.

Equivalence. diff.ts compares `JSON.stringify` of the old and new results for 30,000 generated params over the six narrowers (7,248 accepted): 0 mismatches, so the -32602 message texts are identical.

Contract (protocol.ts header, lsp_protocol_test). Input: `unknown` params. Output: `Result<T, string>`. The first failing check in field order wins. The error text is `<path> must be <description>`, with paths like `contentChanges[0].range.start.line`. Params that are not an object give `<method>: params must be an object`. Unknown keys are ignored. An absent `range` key stays absent.

Judging tests: tests/lsp_protocol_test.ts (12 tests), lsp_server_test, and lsp_features_test. Strength: medium. `assertRejected` checks only a fragment of the message, so a changed text passes. Recommendation: commit the differential script, or assert exact messages for one case per primitive.

Risk: low.

### FE-3 (MECHANICAL): one reachability closure for both type graphs

Problem. src/core/interface.ts extracts the references of a declaration (alias/base, error fields, service methods) three times: lines 147-158, 196-207, and 213-226. The closure (seen set plus pending stack) appears twice: in buildTypeGraph and in foreignTypeGraph. foreignTypeGraph has own-body cyclomatic 26 (29 with its nested `visit`). Two of its branches cannot run. Line 211 `if (d === undefined) continue` is uncovered, because only ids in `foreign` are pushed. The partition at 234-236 uses three `d?.kind` checks on values that are never undefined.

Proposed refactor (sketch: /tmp/rederive/scratch-FE/ifacesketch/interface_new.ts). The sketch adds `declarationRefs(d)` (a switch over the three kinds), `reach(pool, seeds)` (the stack holds declarations, not ids), and `graphOf(decls)` (an exhaustive switch). Both graph functions call them.

Measured delta. interface.ts branches 82 -> 58, LOC 350 -> 328, and max cyclomatic 29 -> 13 (buildInterface, unchanged). foreignTypeGraph becomes 4 statements. The uncovered branch at 211 and the 3 `?.` checks disappear. The fast suite passes with the sketch: db_test (16), check_test, and the interface hash tests.

Contract (doc comments, check_test, db_test). buildTypeGraph gives every own type, error, and service that the exports and exported value types reach, sorted by id, independent of modes. foreignTypeGraph gives the declarations of imported graphs that the exported values and the own graph reach, transitively. Interface hashes stay byte-equal, because `buildInterface` sorts with `byId`.

Judging tests: check_test.ts, db_test.ts "differential: a sequence of edits equals a run from scratch", the slow emit golden tests, and behavior:capture. Strength: good for hashes. No test aims at a foreign declaration that only another foreign declaration reaches. The scout did not confirm that such a case exists in the fixtures: that needs a coverage probe.

Risk: low.

### FE-4 (TYPE-DRIVEN): give writeGenerated a narrow port with one tagged result

Problem. src/cli/outputs.ts:writeGenerated (cyclomatic 16) calls four lazy `Revision` queries: `lowered`, `emitted`, `spanTable`, `sourceMap`. Lines 58-86 have 10 decisions. Line 74 tests `emitted === undefined || table === undefined || map === undefined`. In src/core/db.ts:222-268, each of those is undefined exactly when `lowered` is undefined, so line 74 can never be true after line 60. The function takes the concrete `Revision` class, so no test can inject a lowering, emit, or source-map failure. In both the fast and the full suite, `describeLowerError` (lines 25-38) and lines 60-86 never run: 29 of 77 lines are uncovered.

Proposal. Add a port such as `generated(name): Result<{ path, text, table, map }, GenerateFailure> | undefined`, where `GenerateFailure` is a tagged union: `diagnostics`, `lower`, `emit`, `map`. writeGenerated then switches exhaustively on the tag. `Revision` implements the port. Tests use a small in-memory port.

Counted delta: -3 impossible `undefined` decisions (line 74). One exhaustive switch with 4 tags replaces 3 sequential `if (!x.ok)` blocks. The 29 uncovered lines become testable without a broken compiler.

Contract. For each name in order: skip an unknown or `.effi` module. A module with diagnostics is skipped silently. Any other failure gives one `error:` note and `failed = true`. With `write`, `<path>` and `<path>.map` are written only when the text changed. A write failure gives a note and `failed`.

Judging tests: cli_test "a file that cannot be written gives a note and exit 1", "build writes nothing for a module with an error", cli_slow_test, and lsp save tests. Strength: weak for failure paths (see section 3).

Risk: low to medium, because the LSP save path (src/lsp/features.ts) shares writeGenerated.

### FE-5 (TYPE-DRIVEN, data-driven grammar): type-word argument slots as a table

Problem. parsePrimaryTypeInner (src/core/parse.ts:990, cyclomatic 31) encodes the argument grammar of 13 type words in nested `if (name === "Sink") ... else if (name === "Schedule" && comma) ... isSchema && comma ... !isSchema && comma`. Lines 999-1053 hold 18 decisions.

Proposal (sketch: /tmp/rederive/scratch-FE/parsesketch/parse_new.ts). Each word gets a slot list: Effect/Stream `[type, fails, uses]`, Sink `[type, type!, fails, uses, type]`, Schedule `[type, type, fails, uses]`, Layer `[provides, fails, uses]`, Schema* `[type, type, uses, uses, type]`. One loop reads slots: a comma continues, a missing comma before a required slot reports "`,`", otherwise the loop stops. `parseSlot` switches exhaustively over `SlotKind`. In the real change the slots belong in `TYPE_WORDS` in syntax.ts.

Measured delta: parsePrimaryTypeInner 31 -> 21, parseSlot 5 (new), parse.ts branches 332 -> 328, LOC +4. Equivalence: `printTree` plus diagnostics are equal on 139 repository files and 20,000 generated `Word<...>` inputs (0 mismatches). The fast suite passes.

Judging tests: parse_test, fixtures_test, and the golden tests. Strength: lines 1010-1011 (Sink without its required comma) are uncovered.

Risk: low. The gain is mostly that a new type word becomes a table row.

### FE-6 (MECHANICAL): delete dead exports

These items have zero uses outside their definition: `isReservedWord` (lex.ts:149) and `tokenText` (lex.ts:207), with no uses in src, tests, scripts, bench, playground, or editors and no re-export from mod.ts. `Program.revisions` (db.ts:294) also has zero uses, and FNDA is 0 in the full suite. Delta: -9 lines, and lex.ts function coverage 11/13 -> 11/11. Risk: none for in-repo users. mod.ts does not export them, so the public API does not change.

### FE-7 (MECHANICAL): one copy of four tiny helpers

These counts are by grep at 730977c.
- `compareText` (`a < b ? -1 : a > b ? 1 : 0`) has 9 copies in src. FE-area copies: db.ts:140, interface.ts:61, project.ts:488, lsp/projects.ts:116. The others are in check.ts, lower.ts, serialize.ts, types.ts, and emit/scope.ts. validate/sets.ts has an inline copy that must stay local by the validator rule. One export from source.ts gives -2 decisions for each copy removed: -16 repository-wide, -8 in FE.
- `isRecord`: project.ts:102, jsonrpc.ts:270, protocol.ts:210 (validate/serialization.ts stays separate). That is 3 -> 1, -4 `&&`.
- `e instanceof Error ? e.message : String(e)` has 6 FE copies: project.ts:136, jsonrpc.ts:154, server.ts messageOf, deno_io.ts:20, playground compile.ts:122, app.ts:89. That is 6 -> 1, -5 `?:`.
- The per-source line-table cache (Map plus `lineStarts`) appears in cli/format.ts:19-34 (class Positions) and lsp/projects.ts:142-151, plus emit/sourcemap.ts:133 outside FE. This is the only real duplicate between CLI and LSP diagnostic output. The two outputs (`path:line:col: error code: msg` and the LSP `Diagnostic` with `relatedInformation`) differ otherwise.
Risk: none. Judging tests: the existing suites.

### FE-8 (MECHANICAL): editor.ts duplicate innermost search and declaration lookup

`innermost` (editor.ts:138-160) and the loop in `definitionAt` (289-301) are the same 7-decision search: smallest covering range, ties to the lower node id. One generic `innermostNode(tree, nodes, offset, afterEnd)` gives -7 decisions. `declarationSpan` (226-236) and the `cap` arm of `targetSpan` (250-258) both do `moduleOfId + nameOfId + modules.get + index.byName.get`. A shared `declEntryOf(revision, id)` gives -1 `if`, -1 `||`, and 2 `?.`. Lines 253 and 256 are uncovered. Path-to-module scans exist 5 times: editor.ts:46 and 356, features.ts:47, check_project.ts:546, and playground compile.ts:99. A `Revision` map by path would replace 4 linear scans. Judging tests: editor_test (25), lsp_features_test. Risk: low.

### FE-9 (TYPE-DRIVEN): ProjectState phase as a union

src/lsp/projects.ts:ProjectState has the independent mutable fields `started`, `lastGood`, `lastDelta`, and `configError`. src/lsp reads them 22 times (13 in features.ts, 9 in projects.ts), and tests read them 11 times. The fields can represent illegal states: `started === false` with `lastGood` set, `lastDelta` without `lastGood`, and `lastGood` without `lastDelta`. flush sets both at lines 409-410. A union `{ tag: "new" } | { tag: "good"; revision; delta } | { tag: "config-error"; error; last?: { revision; delta } }` makes these states unrepresentable and makes `#publish` switch exhaustively. Branch delta: needs measurement. TYPE-DRIVEN, so a branch count may rise. Judging tests: lsp_server_test (10 field reads), lsp_features_test, and lsp_slow_test. Risk: medium, because the change touches 22 read sites.

### FE-10 (MECHANICAL): small LSP and CLI duplicates

These are counted decisions.
- features.ts: hoverRequest 70-75 and definitionRequest 98-102 repeat a 4-decision prelude: project, lastGood, text, offset. A `cursorOf(params, ctx)` helper gives -4.
- projects.ts: `relativeTo(root, absolute)` followed by `path === undefined || !isSourcePath(path)` appears 3 times (209-210, 327-328, 355-356). A `sourcePathUnder` helper gives -4.
- cli/main.ts: `first.tag === "read-error" || first.tag === "config-error"` appears twice (58-62, 67-71). A helper gives -2.
- cli/args.ts plus main.ts: `optionsOf` handles `help`, which main returns before (main.ts:42-45). Splitting `Command` into `help | ProjectCommand` removes 1 unreachable case (TYPE-DRIVEN).
- cli/format.ts: formatTscMappings builds `Located` from a span 3 times (66-73 in formatDiagnostics, 91-98, 109-116). A `locate(span, code, message)` helper replaces about 16 duplicate lines.

### FE-11 (MECHANICAL, higher risk): three project drivers share one per-module input loop

`checkDeclarations` (interface.ts:357, tests only, but README.md:268 documents it), `checkAnalysis` (check_project.ts:441, outside FE), and `Program.check` (db.ts:348) each rebuild "reached modules -> imported graphs (+ visible interfaces)". The loops are interface.ts:366-370, check_project.ts:450-458, and db.ts:365-373. db.ts:24 states that its order and inputs equal those of checkAnalysis, and only one test enforces that ("differential: a sequence of edits equals a run from scratch"). A shared `moduleInputs(analysis, name, graphs, interfaces)` removes 2 of 3 copies, about -6 decisions. A full merge (checkAnalysis as Program.check with a no-op memo port) removes the drift class, but its delta needs measurement. Inside db.ts, the two `Entry` constructions (415-438, 450-461) repeat `built.ok ? built.value : undefined` and the payload `?:`: -2 decisions. db.ts:363 `if (info === undefined) continue` is uncovered. Gate: db_test, check_test, and `deno task behavior:capture`.

### FE-12 (MECHANICAL): parser delimited-list helper

The sequence `open("free"); parseCommaList(C, item); close(group, C, text)` occurs at 11 sites in parse.ts: 698, 931, 1059, 1081, 1116, 1209, 1262, 1352, 1423, 1454, 1534. Each site writes the closer token twice. A `delimitedList(closer, item)` helper, with the closer text from a table, removes 11 chances for a mismatch and about 22 lines. There is no branch change. Judging tests: parse_test and the golden fixtures.

### FE-13 (MECHANICAL): Loader queue holds loaded records

project.ts:461-482 looks up `this.loaded.get(path)` for paths that only `ensure` pushed after it set `loaded`. As a result `if (file === undefined) continue` (464, 472) and `?? []` (480) cannot run, and all three are uncovered. A queue of records gives -2 `if` and -1 `??`. The record also stores `tree` twice (`tree` and `parsed.tree`, line 347).

### FE-14 (MECHANICAL, low): playground app.ts

No test loads app.ts or editor.ts. `loadExamples` with `isTextRecord` (57-92) is pure decoding behind `fetch`. Moving the decoding into model.ts with an injected fetch makes 8 decisions testable. Two `throw new Error("no state for ...")` (281, 459) guard a state that cannot occur, because every path in `paths` gets a state at line 277. The render sequence in `applyResult` (438-442) repeats at start (558-564). `CompileResult` (line 49) re-declares the core `Result` type.

### Result versus exception (requested count)

The count covers code only, not comments or strings. There are 8 `throw` statements and 20 `try` blocks.

`throw` sites:
- parse.ts:248 and 305: internal invariants (end without begin, consumed Eof). These are defects.
- source.ts:86 (makeSpan) and 110 (coverSpans): precondition defects.
- editor.ts:114: a rethrow.
- app.ts:66, 281, and 459: defects (missing DOM element, impossible state).

`try` sites:
- Boundary conversions to Result or undefined (correct): project.ts:128 (JSON.parse), index.ts:357 (JSON.parse of a string token), jsonrpc.ts:151 (fatal UTF-8 plus JSON), positions.ts:89 and model.ts:18 (decodeURIComponent), and deno_io.ts (8, Deno APIs).
- Cleanup with try/finally: events.ts:23 and watch.ts:52.
- Defect containment: server.ts:344 and 400, compile.ts:145.
- Expected failure carried by an exception: editor.ts:103-115 (backendOf). It catches `EmitFailure` from emit/scope.ts for the expected "backend type unavailable" state. This is the only FE site of that kind. The fix belongs in the emit area (a Result from `Scope`/`functionHeader`). The catch branch is uncovered (editor.ts:110-115).

## 3. Test gaps that block a rederive

The fast and the full suite show the same gaps unless noted.
- cli/format.ts:47-49. In compareLocated, the same-path line, column, and code tie-breaks never run. The test "check sorts diagnostics by path, position, and code" (cli_test.ts:102) puts one diagnostic in each file and checks paths only, so it does not test what its name says. This blocks FE-7 and FE-10 (format).
- cli/outputs.ts:25-38 and 60-86. describeLowerError and the lowering, emit, and map failure notes never run. tests/cli_helpers.ts memoryIo cannot inject them. This blocks FE-4.
- cli/tsc.ts:62-67 (deno check cannot run) and 75-76 (non-zero exit with no diagnostic and no output). memoryIo.denoCheck always returns `ok`.
- cli/workspace.ts:35, 38-40 (list failure), and 51-54 (unreadable file). memoryIo has no unreadable or unlistable option. Three small options in memoryIo (`unreadable`, `unlistable`, `denoCheckFailure`) close the tsc and workspace gaps.
- cli/main.ts:72 (`unchanged`, exit 0) and watch.ts:33-34.
- ids.ts:12, 19, and 30. The malformed-identity branches are untested (branches 4/8). ir.ts template types do not include `#`, and the scout must not change ir.ts, so tests are the only fix.
- lex.ts:438: an invalid escape of an astral character (FE-1).
- parse.ts:1010-1011: Sink without the required comma (FE-5).
- project.ts:194-201 (a host entry whose module path leaves the root) and 136 (a non-Error throw from JSON.parse, which cannot occur).
- lsp/projects.ts:243-246 (didChange for an unknown document, not an orphan), 311-314 (re-read of an unreadable file), and 362-364 (readWorkspace failure at discovery). These block FE-9.
- editor.ts:110-115 (EmitFailure catch) and 253/256 (cap arm misses).
- playground/src/app.ts and editor.ts: no test loads them (FE-14).

## 4. Docs that the proposals make stale

- FE-1: docs/rejected.md. Add the `deno task bench` A/B result for the lexer split, whether a win or a null result. The "Token representation" gap stays, because FE-1 keeps typed arrays. README Layout "lex.ts Lexer: typed arrays of tokens plus trivia" stays true.
- FE-2: the README Layout line for protocol.ts and docs/plans/2026-10-16-lsp.md:67 ("types and narrowing of incoming params") stay true. The protocol.ts header comment ("narrowing functions ... for every incoming params shape") needs one sentence about the schema kit.
- FE-4: README.md:206 and docs/plans/2026-10-16-lsp.md:75, 309, and 369 give `writeGenerated(fs, root, revision, names, write)`. They are stale if the parameter becomes a port.
- FE-5: syntax.ts `TypeWord` doc ("Every type word that the parser reads as `Word<...>`") gains the slot list.
- FE-11: README.md:268 ("Using the declaration checker", `checkDeclarations`), the interface.ts header lines 12-14, and the db.ts header lines 22-24 ("the same steps and order as checkAnalysis").
- CONCEPTS.md and docs/solutions/logic-errors/* (2 checker notes) are not affected.

## 5. What not to touch, with the measured reason

- sha256.ts (4 branches, 100%/100%), hash.ts, source.ts (100%/100%), and diagnostics.ts (423 LOC, but 12 branches. The bulk is the code registry, at 100%/100%).
- syntax.ts (11 branches), analyze.ts (4), mod.ts (0), methods.ts, positions.ts (100%/100%), args.ts (100%/100%), events.ts (100%/100%), report.ts, build.ts (100%/100%), and highlight.ts (100%/100%).
- jsonrpc.ts classifyMessage (cyclomatic 16, 98.4% branches). Each decision is one JSON-RPC 2.0 rule that depends on key presence (`"id" in value`, exactly one of result and error). The FE-2 schema kit does not express key presence without new primitives, so the gain is small.
- server.ts. Own-body maximum is 10 (#handleRequest phase switch). The two `try` blocks are the documented exception boundary.
- index.ts (max 7, 94.7% branches).
- The lexer's typed arrays (docs/rejected.md). Do not propose object tokens.
- The diagnostic sort orders. Core sorts by (source, start, end, code, message), the CLI by (path, line, column, code, message), and the playground by (path, from, to). A merge changes the visible order when two diagnostics share a start, so the merge is a behavior change and out of scope.
- validate/ copies of `isRecord` and `compareText`. The independent validator rule keeps them local.

## Slow suite with the sketches

With swap.json (the lex, protocol, interface, and parse sketches) the slow suite passed: 129 passed, 0 failed, 1m36s. Limit: the slow tests that start a subprocess (`deno run src/cli/main.ts` and others) load the repository modules, not the sketches. For those tests the result covers only the in-process code.

Repository state. The differential scripts ran with the repository config, so Deno added `jsr:@std/fs@1` to deno.lock. The scout restored deno.lock with `git checkout -- deno.lock`. `git status` is clean again at 730977c. A later run of a scratch script must use `--no-lock` or a scratch config.

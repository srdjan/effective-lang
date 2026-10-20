# Scout report EMT: lower and emit

Scope: src/core/lower.ts, src/core/serialize.ts, src/core/emit/*.ts (11 files).
Coverage source: full suite at /tmp/rederive/covall/lcov.info (fast plus slow), present at the end of this scout. Fast-only numbers come from /tmp/rederive/cov/lcov.info and are marked "fast".
Scratch work: /tmp/rederive/scratch-EMT/ (case-label extractor cases.ts, clause sizer clauses.ts, field-order checker order.ts and evalcmp.ts, coverage scripts lcov.py and uncov.py, an instrumented copy of the repository in repo/ with probe tests). I did not change the repository.

## 1. Baseline

| File | LOC | Branches | Max cyclomatic | Top 3 by cyclomatic | Lines full (fast) | Branches full (fast) |
| --- | --- | --- | --- | --- | --- | --- |
| lower.ts | 1742 | 388 | 108 | invoke@458 (108), stageEffects@1136 (27), expr@327 (19) | 89.5% (89.4%) | 89.7% (89.5%) |
| serialize.ts | 86 | 40 | 13 | findProblem@43 (13), print@69 (7), isSortedUnique@28 (6) | 95.5% (95.5%) | 95.2% (95.2%) |
| emit/emit.ts | 213 | 22 | 11 | build@109 (11), emitModule@181 (5), emitProject@216 (3) | 95.9% (95.9%) | 88.4% (83.3%) |
| emit/spans.ts | 176 | 26 | 7 | offsetOfGenerated@155 (7), recordAtOffset@119 (6), hostImportSpans@95 (6) | 99.1% | 97.8% |
| emit/sourcemap.ts | 282 | 51 | 20 | buildSourceMap@116 (20), decodeMappings@245 (9), lookupMapping@308 (6) | 99.6% | 92.7% |
| emit/tsc.ts | 228 | 28 | 11 | parseDenoCheck@79 (11), mapTscDiagnostic@207 (7) | 97.7% | 94.6% |
| emit/doc.ts | 579 | 117 | 51 | render@302 (51), fits@316 (36), check@240 (22) | 98.9% | 97.5% |
| emit/scope.ts | 513 | 97 | 21 | containsFunction@458 (21), anon@231 (13), bindHost@271 (8) | 97.0% (90.7%) | 95.3% (91.0%) |
| emit/explicit_scope.ts | 48 | 0 | 1 | scopeRuntimeDeclaration@6 (1) | 100% (2.1%) | n/a |
| emit/types.ts | 495 | 168 | 36 | typeDoc@174 (36), schemaDoc@419 (30), encodedTypeDoc@345 (24) | 91.2% (84.5%) | 86.5% (74.8%) |
| emit/expr.ts | 2872 | 768 | 126 | structural@760 (126), leaf@2644 (64), schemaExpr@1452 (39) | 94.7% (72.0%) | 89.8% (83.5%) |
| emit/decls.ts | 504 | 122 | 22 | namedIn@45 (22), interfaceReferences@119 (9), typeDeclaration@275 (8) | 98.5% (93.6%) | 97.4% (94.0%) |
| emit/walk.ts | 249 | 196 | 101 | childrenOf@14 (101), patternBinding@182 (7), bindersOf@197 (5) | 99.6% (91.0%) | 99.6% (91.4%) |

LOC and branches come from /tmp/rederive/measure.ts. Cyclomatic comes from /tmp/rederive/fns.tsv (own body). The IR has 100 Expr kinds: childrenOf and structural each have exactly 100 case labels, and the two label sets are equal (cases.ts).

Lines that only the slow suite covers in emit/expr.ts: 589 lines. The large ranges are 892-929 (map-groups), 1095-1263 (take-sink, transduce, aggregate, schedules), 1459-1492 and 1504-1819 (schemaExpr), 2691-2711 (schema leaves), 2769-2784 (scope leaves), 2986-3006 (SchemaIssue catch). A refactor of these parts is judged only by the slow suite.

## 2. Findings, ranked by leverage

### EMT-1 (TYPE-DRIVEN): one shape table keyed by Expr kind for the IR walkers

Problem. Five hand-written switches encode the same per-kind facts: which fields are children, which are evaluated before a leaf runs, and which kinds are leaves. Three of them have a `default` that hides a missing kind.

Evidence (measured with cases.ts, evalcmp.ts, order.ts).
- walk.ts childrenOf@14: 100 labels, cyclomatic 101, 163 branches. 89 of 100 labels return a plain list of fields. Only 6 kinds need a nested accessor: record, error, update (fields[].value), block (steps[].value), match (arms[].body), catch (handlers[].body). The other arrays (elements, arguments) are plain `readonly Expr[]` fields.
- expr.ts isLeaf@2436: 35 labels plus `default: false`, cyclomatic 36.
- expr.ts structural@760 lines 1413-1447: a second copy of 34 leaf labels that throws `internal`. These 35 lines never execute (full suite).
- expr.ts leaf@2644: the same 35 labels plus `default: throw internal` (line 2930-2931, never executed).
- expr.ts evaluatedChildren@2482: 30 labels plus `default: return []`, cyclomatic 33. 27 of 30 labels return exactly the childrenOf fields. The 3 exceptions are call (drops the callee for a collection builtin), fold-effect-stream (drops update), and with-fiber (drops use). The `default` silently gives `[]` to 5 leaf kinds: catch, provide, retry, retry-with-schedule, with-resource. That is correct today (they are the "deferred positions" of plan section 6.1), but the code states it only by omission.
- tests/lower_test.ts walk@80 is a fourth copy over 22 kinds. Its switch returns void, so it silently skips the other 78 kinds.
- The order of child fields agrees between lower.ts invoke and childrenOf for all 73 kinds that both list (order.ts). So one ordered field list can serve both.

Proposal. Add one module, for example src/core/emit/shape.ts (not ir.ts), with a mapped table `{ readonly [K in Expr["kind"]]: { children: ...; deferred?: ...; leaf: boolean } }`. The mapped type makes a new Expr kind a compile error until it has a row. Derive childrenOf, isLeaf (a type guard to a `LeafExpr` union), and evaluatedChildren (children minus deferred fields) from the table. Narrow structural to the non-leaf union, so its 34-label throw list goes away and leaf needs no `default`. Replace the test walker in lower_test.ts with walkExpr. The validator must not import this module (validator independence).

Contract (from walk.ts doc comments, plan section 6.1, and tests). childrenOf(e) returns the direct sub-expressions of e in evaluation order, and it is total over all 100 kinds. evaluatedChildren(e) for a leaf returns the children that run before the leaf, in source order: for call the callee and the arguments, except that a collection builtin (all, traverse) evaluates only the arguments. Deferred positions (catch body and handlers, retry and provide jobs, with-resource closures, fold-effect-stream update, with-fiber use) are not evaluated children. isLeaf(e) is true for 34 kinds, and for call only when the callee type is an effectful function. No error cases: the functions are total. The leaf and structural paths throw `internal` only for an IR that breaks these rules.

Judging tests. walkExpr feeds emit/scope.ts collectBinderNames and emit/decls.ts valueReferences, so binder naming and constant order judge childrenOf. The emit hash of every test program in `deno task behavior:capture` judges the leaf and hoist rules byte for byte. Strength: good for emit text, because every structural and leaf clause executes in the full suite. Weak in the fast suite (expr.ts 72.0% lines).

Projected delta (counted). childrenOf: -100 case labels, cyclomatic 101 to about 3 plus 6 accessor rows. isLeaf: -35 labels, -1 default, cyclomatic 36 to about 3. structural: -34 labels (35 dead lines). leaf: -1 default. evaluatedChildren: -30 labels, -1 default, cyclomatic 33 to about 3, plus 3 explicit exception rows and 5 explicit deferred rows. Test walker: -22 labels. The table adds about 100 one-line rows. Three hidden `default` clauses become compile-time exhaustiveness.

Risk. Medium. The mapped type for "child field names of kind K" needs a helper type, and the table must not need a cast. That needs a compile check. A wrong deferred field changes the hoist order. behavior:capture over the fast and slow suites detects that.

### EMT-2 (MECHANICAL): typed builder table for the positional cases of lower.ts invoke

Problem. invoke@458 (531 lines, cyclomatic 108, 187 branches) maps a call fact to an IR node. Most clauses only move positional arguments to named fields.

Evidence (positional.ts over the switch at line 492). The switch has 80 clauses for 82 labels. 60 clauses (63 labels, 280 lines) are a single `return { kind, field: arg(i), ..., ...annotation }`. 13 clauses add fact fields. 5 of those 13 only add `concurrency: fact.concurrency` (map-effect, flat-map-streams, partition-all, validate-all, all-results). 7 clauses have real logic: builtin, error-construction, schema, with-fiber, with-resource, map-groups, and default.

Proposal. Replace the 63 positional labels with a table `{ [K in PositionalFact]: (arg: (i: number) => Expr) => Omit<Extract<Expr, { kind: K }>, keyof Annotation> }`, one line for each kind, and spread the annotation once. A typed builder function per kind keeps field checking without a cast. A field-name list shared with EMT-1 would need a cast, so I do not recommend that form here. Keep the 7 logic clauses in the switch.

Contract (from invoke's doc comment and lower_test.ts). Input: a call node, its callee node, its argument nodes, an optional pipeline left value `pre` (which becomes argument 1), and an optional `override` of the effect sets. Output: one Expr whose annotation comes from the checker tables, or from `override` for a moved pipeline stage. The lowering never infers a type. Error cases: `unsupported` for an error constructed from a non-record value; `internal` for a missing fact, argument, or inline closure.

Judging tests. tests/lower_test.ts (27 tests), validate_test.ts (the validator recomputes every annotation), and the emit hashes in behavior:capture. Strength: weak for the IR itself. behavior:capture hashes emit, check, and validate results, but it has no hook on the lowered IR, and only one IR golden exists (fixtures/ir/example/log.ir.json). IR fields that emit does not print would change unobserved, unless the validator reads them.

Projected delta (counted). invoke: -63 case labels, cyclomatic 108 to about 45. 280 lines become about 63 table lines. With the 5 concurrency kinds as table rows too: -5 more labels.

Risk. Low. Add a capture hook for `serializeModule(lowered)` to scripts/behavior_capture.ts before this refactor, so that the gate observes the IR.

### EMT-3 (TYPE-DRIVEN): the `default` clauses of invoke and stageEffects hide missing call facts

Problem. NodeFact (tables.ts) has 90 kinds: 83 call facts and 7 other facts (arrow, binding, field, handler, list, none, pattern). invoke handles 82 call facts by switch and `layer` before it. A new call fact without a lowering clause reaches `default: throw internal` (lines 983-985) at run time, not at compile time. stageEffects@1136 has 17 labels and `default: break`. Every other stage fact silently gets "arguments only" effect sets.

Evidence. The kind sets are measured with cases.ts against the NodeFact union. The stage-capable set exists only as the complement of 49 `this.noPipeline(...)` calls in check_expr.ts. Instrumented fast run (repo copy): stageEffects ran for 8 fact kinds (call 490, builtin 646, retry 4, and 1 each for fail, perform, close-scope, provide-scope, add-scope-finalizer). It never reached its default. In the full suite, 6 clause groups (9 labels, about 66 lines: retry-schedule, codec/schema/decode/encode, retry-with-schedule, defer, run, provide; lines 1204-1288) never execute. The stages `make() |> run` and `(() => ...) |> defer` are valid source: my probe checked, lowered, and validated both with zero validator diagnostics. So these arms are reachable and untested. `codec` is rejected as a stage by `noPipeline("codec")`, so its arm is probable dead code. A test that tries `x |> codec(...)` confirms it.

Proposal. In tables.ts, name `CallFact = Exclude<NodeFact, { kind: "arrow" | "binding" | ... }>`. Narrow once in invoke and end its switch with a `never` check. For stageEffects, either give the checker a typed "stage fact" subset, or list every call fact in stageEffects with an explicit "arguments only" group. This touches check_expr.ts or tables.ts, which belong to the checker area.

Contract (from the stageEffects doc comment). When the left value of a stage moved into a fresh binding, the stage's sets are the sets of its arguments plus its own invocation. Control stages (retry, provide, run, scope stages) add the deferred job's invocation and any provider acquisition, but not the left value.

Judging tests. validate_test.ts and the validator in every lowering test. Strength: weak for 9 of 17 arms, because no test executes them.

Projected delta. invoke: -1 default (runtime error becomes a compile error). stageEffects: -1 default. Branch count may rise if the arguments-only group becomes explicit. That is acceptable for this class.

Risk. Low for invoke, medium for stageEffects because the change crosses into the checker.

### EMT-4 (TYPE-DRIVEN, observed defect): namedIn skips 5 Type kinds, so the export rule fails through Ref and Fiber

Problem. decls.ts namedIn@45 returns void, so its switch is not checked for exhaustiveness. It has 15 of the 20 Type kinds. It skips ref, fiber, codec, retry-schedule, and closeable-scope. exportedIds and orderTypeLevel use it through interfaceReferences.

Evidence (probe tests in the repo copy). `type B = { n: int }` with `export type A = { b: B }` emits `export const B` and `export type B`. With `export type A = { r: Ref<B> }`, B is emitted without `export`. The same happens for `export const f = (): Ref<B> => ...` and for `Fiber<B, E>`, where neither B nor E is exported. README.md line 330 and docs/phase-a-rules.md line 92 state that every declaration an exported signature reaches is exported. codec and retry-schedule take the same path, so they are probable cases too. A probe with `Codec<B, ...>` can confirm them. I did not measure a downstream failure: `deno check` accepts a private name in an exported signature without declaration emit. The observed effect is a broken documented rule.

Proposal. Make namedIn exhaustive, either through a return value or a `never` default, and add the 5 kinds. Better: derive it from one `typeChildren(type)` function and one effect-set accessor for each kind. decls.ts containsNamed@350 has 5 labels and `default: false`. It omits tuple, but the checker rejects recursion through a tuple (declaration/007, measured by a probe), so containsNamed is correct today and only hides that dependency.

Contract. exportedIds(ir) is the set of source exports plus each declaration that the interface of an export reaches through any type position, including effect failures and service requirements. orderTypeLevel puts dependencies before their users and keeps source order otherwise.

Judging tests. emit_test.ts export tests. Strength: no test covers a Ref, Fiber, Codec, or RetrySchedule type in an exported signature that names a private declaration.

Projected delta. namedIn: +5 labels and one compiler-enforced exhaustiveness check. This is a behavior change, so behavior:capture shows it only if a test program has such a type. The fix needs a new test.

Risk. Low. It is a deliberate output change and needs a user decision.

### EMT-5 (MECHANICAL): the 12 deferred Type kinds are listed three times

Problem. encodedTypeDoc@345, schemaDoc@419, and scope.ts containsFunction@458 each list the same 12 kinds (function, effect, stream, sink, schedule, provider, ref, retry-schedule, codec, schema, closeable-scope, fiber). The two printers throw `unsupported` for them. Those throw lines (types.ts 402-414 and 505-517) never execute in the full suite.

Proposal. Add one `isDeferredType(t): t is DeferredType` guard backed by a `satisfies Record<DeferredKind, true>` table. Call it at the top of the two printers. Then each switch covers the 8 remaining kinds exhaustively. containsFunction uses the same guard.

Projected delta (counted). -24 case labels in types.ts, -11 in containsFunction, +1 guard. Exhaustiveness stays.

Risk. Low. The fast suite plus behavior:capture judge it.

### EMT-6 (MECHANICAL): simple method-call clauses in structural and leaf

Problem. Many clauses differ only in module, method, and the treatment of each argument (`kid`, `callback`, `effectCallback`).

Evidence (clauses.ts). In structural, 17 clauses (115 lines) have this shape: 7 are `Stream.m(kid(stream), callback(f))`, 3 are `Stream.m(kid(stream), kid(x))`, 6 are `X.m(kid(left), kid(right))`, and schedule-recurs. In leaf, 10 clauses (54 lines) do the same: collect, head, last, and drain-stream, run-stream, scoped, fail, and the 3 scope operations. `const stream = this.scope.effect("Stream")` occurs 30 times. The concurrency option snippet occurs 5 times (lines 884, 973, 2723, 2741, 2760): 4 copies are the same and 1 is a variant. Each copy has 2 ternaries. The stream-and-sink operand guard appears twice with the same code (lines 1104-1108 and 1121-1125).

Proposal. Add a table `{ [K in SimpleKind]: { module, method, args } }` with a type guard, checked before the switch, and a helper `concurrencyOption(c)`.

Projected delta (counted). -27 case labels plus 2 for the guard and lookup. The concurrency helper gives -6 net branches (-8 in 4 copies, +2 in the helper). Lines: 169 become about 30 table lines.

Risk. Low. Every clause is byte-judged by behavior:capture. Do this after EMT-1, because EMT-1 changes the shape of the leaf union.

### EMT-7 (MECHANICAL, small): armBinding duplicates patternBinding

expr.ts armBinding@2366 has 3 labels plus a default and repeats walk.ts patternBinding@182 (6 labels, exhaustive). The one difference is that armBinding throws for `some` outside an option match. Proposal: call patternBinding, and keep the `some` check. Delta: -1 default, -3 labels.

## 3. Test gaps that block a rederive in this area

- The lower failure path never runs. LowerFailure, internal, unsupported, and describe have 0 hits. 0 of the 30 throw sites in lower.ts execute. The Result conversion block (lines 1809-1823) and lowerImports "no-interface" and "internal" (lines 1590-1611) are not covered. In emit, 1 of 43 throw sites executes, and the conversion in emitModule (lines 200-203 and 208-209) is not covered. A rederive that moves these conversions has no test.
- stageEffects: 9 labels (6 clause groups) never execute, although `|> run` and `|> defer` are valid (EMT-3).
- tests/lower_test.ts "every expression kind and pattern kind lowers" asserts 21 of the 100 Expr kinds, through a walker that knows 22 kinds.
- The golden files (fixtures/golden, 6 files, 282 lines) reach 15 of the 100 Expr kinds (probe over the example inputs). The other 85 kinds are judged in emit_test.ts by substring checks (`assertStringIncludes`) and in the slow suite by compile and run checks. Only behavior:capture judges their exact text.
- behavior:capture has no hook on the lowered IR (EMT-2). Its emit hook anchors on the exact line `return { ok: true, value: build(ir, context) };` in emit/emit.ts. A rederive of emitModule must keep that line or update HOOKS in scripts/behavior_capture.ts.
- No test puts Ref, Fiber, Codec, or RetrySchedule in an exported signature that names a private declaration (EMT-4).
- Runtime: tests/sourcemap_test.ts "every position of the forms and of a module in a directory round-trips" takes 2000 ms in the fast log, which breaks the rule of under 1 s for a fast test. spans_test.ts takes 269 ms.

## 4. Docs that the proposals would make stale

- README.md Layout (line ~190): the line for walk.ts ("Traversals of the IR"). A new shape module needs its own line.
- docs/plans/2026-10-16-phase-a.md section 6.1 (line 345) lists 6 leaf kinds. The code has 34 leaf kinds plus effectful call. The plan is historical, but EMT-1's table becomes the actual statement of the leaf, evaluated, and deferred rules.
- README.md line 330 and docs/phase-a-rules.md line 92 (the export rule) stay correct. EMT-4 makes the code agree with them.
- CONCEPTS.md has no entry for "leaf effect" or "evaluated children". EMT-1 could add both terms.
- docs/plans/2026-10-17-effect4-gap-closure.md line 111 cites `src/core/lower.ts:691` for stage effects. That line number is already stale: stageEffects is at line 1136.

## 5. What not to touch

- emit/doc.ts: three exhaustive interpreters over 15 Doc kinds (check, fits, render), with no `default`. 98.9% lines and 97.5% branches. render's cyclomatic 51 is the layout state machine. A merge would share little, because fits and render treat group, fill, and alt differently.
- serialize.ts: 86 LOC, 95.5% lines. findProblem (13) is a plain recursive check.
- emit/sourcemap.ts (99.6% lines), spans.ts (99.1%), tsc.ts (97.7%), explicit_scope.ts (0 branches, 100% in the full suite).
- expr.ts schemaExpr@1452: an exhaustive switch over 18 Schema ops that ends in a `never` check, with 98% of its lines covered in the full suite. Its arguments are positional by op inside the IR (ir.ts), and I do not propose to change ir.ts.
- types.ts typeDoc@174: exhaustive over 20 Type kinds, 138 of 139 lines covered.
- The internal throw-then-convert design of lower.ts and emit/ is documented in both entry points, and it keeps 72 invariant guards out of the Result types. A conversion to Result would add branches to guards that never execute. Add tests for the conversion first (section 3).
- isTrivial@2569 `default: false` covers 86 kinds. It errs to the safe side, because a non-trivial child is hoisted. Leave it unless EMT-1 adds a "trivial" column for free.

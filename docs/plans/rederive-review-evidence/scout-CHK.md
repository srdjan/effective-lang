# Scout report: CHECKER (area tag CHK)

Scope: src/core/check_expr.ts, check.ts, check_project.ts, types.ts, tables.ts, patterns.ts,
modes.ts, resolve.ts, initialization.ts. The scout did not read or change src/core/validate/.

Measurement sources: /tmp/rederive/measure.ts, /tmp/rederive/fns.tsv (own-body cyclomatic),
full-suite lcov at /tmp/rederive/covall/lcov.info (91 files; the checker numbers are almost equal
to the fast suite). Scratch probes and ledgers are in /tmp/rederive/scratch-CHK/.

## 1. Baseline

| File | LOC (wc) | AST branches | Max own cyclomatic | Top 3 by own cyclomatic | Lines covered | Branches covered |
| --- | --- | --- | --- | --- | --- | --- |
| check_expr.ts | 7474 | 1972 | 142 | schemaCall:1608 (142), builtinCall:1008 (103), binary:6654 (41) | 88.3% (5745/6506) | 89.6% (2670/2981) |
| check.ts | 1883 | 439 | 40 | named:426 (40), deferredType:747 (28), referencedIds:1034 (27) | 93.9% (1396/1487) | 92.1% (637/692) |
| check_project.ts | 591 | 99 | 20 | checkModuleBodies:215 (20), collectEntries:162 (13), values:252 (12) | 97.3% (400/411) | 91.7% (155/169) |
| types.ts | 1481 | 558 | 116 | assignable:1178 (116), heightWithin:793 (56), show:1361 (46) | 92.8% (1090/1175) | 93.5% (694/742) |
| tables.ts | 281 | 5 | 6 | combine:51 (6), without:70 (1), newBodyTable:274 (1) | 100% (42/42) | 100% (7/7) |
| patterns.ts | 166 | 40 | 17 | domainOf:87 (17), literalValuesOf:57 (5), visit:44 (4) | 99.1% (108/109) | 94.7% (54/57) |
| modes.ts | 123 | 22 | 10 | visit:31 (10), solveModeGroup:96 (10), stronglyConnectedComponents:19 (3) | 100% (78/78) | 93.3% (42/45) |
| resolve.ts | 1537 | 342 | 39 | expr:1237 (39), resolveType:1092 (29), qualified:1051 (16) | 95.9% (1153/1202) | 95.0% (515/542) |
| initialization.ts | 103 | 15 | 10 | buildInitializationGraph:34 (10) | 100% (60/60) | 97.0% (32/33) |

Shape of check_expr.ts: one class `BodyChecker` with 192 functions (fns.tsv). It has 66 handler
methods whose name ends in `Call`: 3993 LOC and 974 branches. Of these, 34 are stream handlers
(1358 LOC, 270 branches).

`default` clauses in the area: 18 in total. 11 are over a closed union. 7 are over `SyntaxKind`,
an open enum that also holds non-expression kinds (these 7 are correct). See CHK-9.

## 2. Findings, ranked by leverage

### CHK-1 (TYPE-DRIVEN): one typed prelude registry replaces the 103-case `builtinCall` switch and four duplicate name lists

Problem. `builtinCall(node, name: string, ...)` at check_expr.ts:1008 dispatches on a string. The
caller passes `target.name`, which is already a `PreludeName` (resolve.ts:418). The compiler
therefore cannot check that each prelude name has a handler.

Evidence (counted).
- The switch has 102 case labels and 1 `default` (own cyclomatic 103). The `PreludeName` union has
  103 members. A set difference shows that the `default` catches exactly one name: `"None"`
  (scratch-CHK/prelude.txt, cases.txt). The `default` report site (check_expr.ts:1201) never runs
  in the full suite.
- resolve.ts holds the 103 names twice: the `PreludeName` union (lines 46-149) and
  `PRELUDE_NAMES` (lines 151-255).
- `SHADOWABLE_PRELUDE_NAMES` (resolve.ts:322, 71 names) is a `Set<string>`. A typo in that set
  compiles. tests/resolve_shadow_test.ts:40-41 checks at run time what the type could check.
- The 21 schema names occur in five lists: the union, `PRELUDE_NAMES`, `SHADOWABLE_PRELUDE_NAMES`,
  the 21 `case` labels at check_expr.ts:1024-1044, and the keys of `SCHEMA_BUILTINS`
  (check_expr.ts:264). `schemaCall` then needs the cast `name as keyof typeof SCHEMA_BUILTINS`
  (check_expr.ts:1615).
- 4 cases record their fact inline in the switch (check_expr.ts:1108-1131).
- Each handler repeats its own name as a string literal: 114 literal-name arguments to `arity`,
  `noPipeline`, `inlineStreamCallback`, and `callback`.

Proposal. Define `const PRELUDE = { fail: {...}, retry: {...}, ... } as const satisfies
Record<string, PreludeSpec>` once, and derive `PreludeName = keyof typeof PRELUDE`. Each spec
carries `shadowable: boolean` and, in the checker, a handler reference. Type the checker table as
`Record<Exclude<PreludeName, "None">, Handler>`. The compiler then rejects a missing or extra
handler. `builtinCall` becomes one lookup. `SCHEMA_BUILTINS` becomes the `schema` sub-record of the
same registry, so the cast goes. Keep resolve.ts free of checker imports: resolve.ts owns the name
record, and check_expr.ts owns a `satisfies Record<...>` handler table keyed by its type.

Contract. Input: a call node, a `PreludeName`, the argument list, an optional expected type.
Output: a `NodeInfo` that `finish` records, plus at most one `NodeFact` for the node. Effects:
diagnostics appended to `sink`. Invariant: each prelude name except `None` has exactly one handler;
`None` as a callee reports `type-mismatch/008`. Error cases: the per-handler diagnostics.

Judging tests. tests/check_body_test.ts (201 tests), tests/fixtures_test.ts (180),
tests/resolve_test.ts (35), tests/resolve_shadow_test.ts (3), playground highlight test (it imports
`PRELUDE_NAMES`). Gate: `deno task behavior:capture <base> <head>`. Strength: good for dispatch
of accepted programs; weak for the `default` path (never run; add a `None(1)` test first).

Projected delta (counted). builtinCall: -102 `case` branches (cyclomatic 103 to about 2). resolve.ts:
-103 lines for the second name list. 71 shadowable names gain a compile-time check. -1 cast. 4 inline
fact writes move into handler rows.

Risk. Low for behavior. The handler table needs `this` binding; use arrow properties or
`(c, ...) => c.foo(...)` rows. The playground and tests import `PRELUDE_NAMES`; keep that export as
a derived `Set`.

### CHK-2 (MECHANICAL): one prologue for fixed-arity prelude handlers

Problem. Most prelude handlers start with the same three steps: record the fact, bail on a wrong
argument count, and reject a pipeline left side. Many stream handlers then repeat the same
"first argument must be a Stream" guard.

Evidence (regex counts in scratch-CHK/clones2.ts and clones3.ts).
- 45 identical arity-bail blocks `if (!this.arity(node, "<name>", N, args)) { return
  this.finish(node, this.table.error, combine(args.map(...)) ); }`, 7 lines each. Lines: 1471,
  1549, 2497, 2533, 2606, 2690, 2710, 2747, 2777, 3014, 3211, 3312, 3496, 3533, 3587, 3662, 3719,
  3784, 3820, 3856, 3892, 3995, 4046, 4092, 4305, 4339, 4373, 4411, 4456, 4507, 4545, 4583, 4625,
  4693, 4720, 4805, 4860, 4914, 4983, 5086, 5204, 5243, 5273, 5303, 5534. 11 of the 45 add
  `EFFECT_ONLY`; 34 do not. That difference is the result mode of the bail and must stay data.
- 49 `this.noPipeline("<name>", args)` calls.
- 20 identical stream guards `if (s.kind !== "stream" && !this.isError(x.type)) { this.report(
  "type-mismatch/010", "`<name>` needs a Stream value", args[0].node); }` (lines 3270, 3330, 3507,
  3545, 3609, 3674, 3731, 3948, 4007, 4058, 4105, 4164, 4210, 4316, 4350, 4384, 4422, 4518, 4556,
  5143). 25 sites print "needs a Stream value" in total.
- 18 ternaries `source.kind === "stream" ? source.element : this.table.error`.
- 9 purity triples `x.mode !== "pure" || x.failures.length > 0 || x.requirements.length > 0`
  (lines 1532, 3553, 3617, 3682, 3739, 4133, 4325, 4359, 5643).

Proposal. Put `arity`, `bailMode` ("pure" or "effect"), `direct` (no pipeline), and `fact` into
the CHK-1 spec row. The dispatcher runs the prologue once. Add `streamArg(name, arg): { info,
stream: StreamNode | undefined, element: TypeRef }` and `isPureInfo(info): boolean`.

Contract. Same as CHK-1. Additional invariant: the diagnostic text and order stay equal; the fact
is recorded before argument checking (current order at each site).

Judging tests. As CHK-1. Weakness: 13 of the 25 "needs a Stream value" sites never run
(scratch-CHK/unhit_reports.txt). One table-driven test that calls each stream builtin with a
non-stream first argument closes this before the change.

Projected delta. -45 `if` and about -315 lines (45 x 7) for the bail blocks; -49 call lines for
`noPipeline`; -20 `if`, -20 `&&`, -18 `?:` for the stream guard; -18 `||` for the purity triples.

Risk. Medium. Diagnostic order is observable. Some handlers record the fact after the bail.
For example, layerCall records `service: undefined` at 5450 on a bail and the resolved service at 5464. Keep those handlers outside the prologue
or give the spec a `factAfterBail` field.

### CHK-3 (MECHANICAL): three clone families of stream handlers collapse to three parameterized handlers

Evidence. A normalized-text comparison (scratch-CHK/families.ts) finds exact clone families:
- collectStreamCall:3782, headStreamCall:3818, lastStreamCall:3854 (36 lines each), and
  drainStreamCall:3890 (36 lines; it differs only in the result type). Each has 5 branches.
- takeStreamCall:4303, dropStreamCall:4337 (33 lines, 7 branches each).
- dropWhileStreamCall:4371, filterStreamCall:4409, takeWhileStreamCall:4505,
  takeUntilStreamCall:4543 (37 lines, 5 branches each).
- transduceStreamCall:4677 and aggregateStreamCall:4681 are 3-line wrappers.

Proposal. `terminalStream(result: (element) => TypeRef)`, `countStream(label)`, and
`predicateStream()`, each called from a spec row.

Contract. Same inputs and outputs per builtin. The fact kind, the message text, and the result
type come from the row.

Judging tests. check_body_test.ts, temporal_stream_test.ts, emit/validate suites through
behavior:capture. Strength: accepted paths are covered; the non-stream error path of takeStream
and dropStream never runs.

Projected delta. 11 functions become 3: about -280 lines; -15 branches (terminals), -7 (take and
drop), -15 (predicates): -37 branches in total.

Risk. Low. Apply after CHK-2, because CHK-2 removes most of the duplicated text first.

### CHK-4 (TYPE-DRIVEN): split `schemaCall` into one handler per schema operation

Problem. `schemaCall` (check_expr.ts:1608, 666 lines, own cyclomatic 142) dispatches on `op` with
12 `if` heads that compare `op` 20 times. The last block (lines 2189-2279, the `transform` op) has
no test of `op`: it runs for each op that no earlier `if` took. A new op in `SCHEMA_BUILTINS` would
silently fall into the transform tail. Three closures (`changedMakeInput`, `asSchema`,
`asOptional`) capture `name`, `op`, and `builtin`.

Evidence. Block sizes in lines: invalid/at/both 25, identity/recursive 75, struct 60, union 50,
optional-transform and optional-from-required 29 (they call optionalBridge), constructor-default 42,
null-to-missing-key 29, optional-key 17, array 16, option-from-optional-key 14, the three default
keys 114, decode/encode/make 37, transform about 90. Inner sub-dispatch on `op` inside blocks: 14
more comparisons (for example lines 1686, 1693, 1731, 1747, 2046, 2056, 2157-2182).
guardedSchemaCallback (check_expr.ts:2373) compares builtin names as strings 11 times
(lines 2457-2477) to decide the recursion role of each schema builtin.

Proposal. Give `SCHEMA_BUILTINS` a handler per op typed as `Record<SchemaOp, SchemaHandler>`, so
`transform` becomes an explicit row. Pass a `SchemaContext { name, op, builtin }` record to the
shared `asSchema` and `asOptional` helpers instead of closures. Add a `recursionRole` field
("guard", "pass-first", "pass-two", "container", "reject") to each row, so
guardedSchemaCallback reads the role instead of 11 string tests.

Contract. Input: the schema builtin name, the arguments, the expected type. Output: a schema
`NodeInfo` with decoded, encoded, makeInput, presence flags, and requirements; an issue type for
`invalid`, `at`, `both`; an effect for `decode`, `encode`, `make`. Fact: `{ kind: "schema", op }`
before any argument check. Errors: type-mismatch/003, /004, /010 with the current texts.

Judging tests. 14 schema_*_test.ts files (3-7 tests each), check_body_test.ts, schema_slow_test.ts,
emit_slow_test.ts, validate suites. Strength: good. The schema code has fewer uncovered report
sites than the stream code (scratch-CHK/unhit_reports.txt lists none in schemaCall).

Projected delta. schemaCall own cyclomatic 142 becomes 21 handlers; the 20 dispatch comparisons
and 12 dispatch `if` heads go (-12 `if`, -8 `||`). 11 string tests in guardedSchemaCallback become
one role lookup. The total branch count inside handlers stays about equal.

Risk. Medium. The op blocks share `first` and `schema` (computed at lines 1920-1921, after the
first five blocks). The split must keep the argument-check order, because `argInfo` records types
in the side table.

### CHK-5 (MECHANICAL): one literal option-record parser for four option readers

Evidence. retryTimes:1312 (17 branches), streamThrottleOptions:4227 (27), streamBufferCapacity:5155
(15), concurrencyBound:5668 (16) parse the same shape: no pipeline left side, a `RecordExpr`, a field
count, `RecordField` kinds, a `Name` label, a `LiteralExpr` value. Each defines its own nested `bad`
closure (lines 1313, 4232, 5160, 5679). The shape tests are 8, 9, 8, and 8 decisions: 33 in total.
19 `return bad()` sites.

Proposal. `literalRecord(arg): Result<ReadonlyMap<string, { node; value }>, "shape">`. Each reader
then checks only its field names and value ranges.

Contract. Input: one argument. Output: the literal value(s) or a single diagnostic with the
reader's message. It records `int` or literal types on the value nodes and a record type on the
argument node only on success.

Judging tests. check_body_test.ts retry, throttle, buffer, and concurrency tests. Strength: the
messages run; each reader's distinct range checks (`>= 0` against `> 0`) need one boundary test each.

Projected delta. 33 shape decisions become about 9: -24 decisions; 4 `bad` closures become 1.

Risk. Low.

### CHK-6 (MECHANICAL): one walker for the four "use of a borrowed local" checks

Evidence. scopedFiberUses:2637, scopedUses:2892, scopedBorrowUses:3100, groupUses:3427 each define
a `visit(node, parent, grandparent, nested)` closure (own cyclomatic 25, 14, 29, 22). The four share
the recursion, the "nested under an ArrowExpr" flag (identical at lines 2681, 2922, 3153, 3487),
and the `target?.kind === "local" && target.id === id` test.

Proposal. `localUses(body, id): readonly { node; parent; grandparent; nested }[]`. Each check then
filters the list with its own predicate. groupUses also counts references; the count is the list
length.

Contract. Input: a body node and a local identity. Output: a diagnostic for each use that breaks the
borrow rule. No other effect.

Judging tests. check_body_test.ts fiber, scope, borrow, and mapGroups tests. checkBorrowedParameter
has 2 report sites that never run.

Projected delta. 4 traversals become 1: about -15 decisions and -40 lines.

Risk. Low. groupUses also matches a `Name` inside a `ShorthandField`; the shared walker must keep
that case.

### CHK-7 (TYPE-DRIVEN): `heightWithin` through a total `childRefs` function

Evidence. types.ts:793, 128 lines, 76 branches, own cyclomatic 56. It has 19 copies of
`if (h === Infinity) return Infinity` and 6 copies of `if (h > tallest) tallest = h`. The switch
has no `default` and does not list `closeable-scope`; it is not checked for exhaustiveness. 32 of
its lines never run (lines 828-900: the schema, codec, fiber, stream, schedule, and sink arms).

Proposal. A total `childRefs(node: TypeNode): readonly TypeRef[]` with an exhaustive switch (a
named node gives its alias target unless the alias is guarded or undefined). heightWithin then
folds over the children with one early exit.

Contract. `exceedsDepth(ref, limit, memo)` is true exactly when the height is above `limit`. Height
is 1 for a leaf and 1 plus the largest child height otherwise. A guarded alias is a leaf. The memo
holds only exact heights at or below the budget. The recursion depth stays at most `limit + 1`.

Judging tests. tests/types_test.ts (29 tests) and the declaration/012 tests in check_test.ts.
Strength: weak for the 6 untested arms; the rewrite sends all arms through one covered path.

Projected delta. heightWithin from cyclomatic 56 to about 6: -19 `if` (Infinity) and -6 `if`
(tallest). childRefs adds 21 case arms with no other branches. The `closeable-scope` gap becomes a
compile error until it is listed.

Risk. Low. In the codec, schedule, and schema arms, the current code evaluates two children before
it tests for Infinity. Only memo contents can differ; results stay equal.

### CHK-8 (TYPE-DRIVEN): one `presence` field replaces three exclusive schema flags in `TypeNode`

Evidence. TypeNode `schema` has `optionalKey?`, `encodedOptionalKey?`, `decodedOptionalKey?`
(types.ts:136-138). The comment at types.ts:139 calls them mutually exclusive. No code checks that
rule: 8 states are representable and 4 are legal. References in the area: 26 in types.ts, 16 in
check_expr.ts, 9 in check.ts. `table.schema(...)` takes 3 positional booleans plus
`constructorDefault`; it has 11 call sites (check.ts:784, check_expr.ts:1824, 1878, 1950, 1979,
1996, 2013, 2029, 2134, 2253, 2350; types.ts:956). show() uses 3 nested ternaries (types.ts:1403-1407);
assignable compares 3 flags (1270-1272); keyOf serializes 3 flags (367-369).

Proposal. In `TypeNode` only: `presence: "required" | "optional" | "encoded-optional" |
"decoded-optional"`. `toIr` and `fromIr` map it to and from the IR flags, so ir.ts does not change.
`table.schema` takes one options record.

Contract. toIr(fromIr(t)) keeps the IR flags. Two schema types are assignable only with equal
presence and equal constructorDefault (current rule).

Judging tests. schema_*_test.ts, types_test.ts, the IR round-trip tests in lower_test.ts.

Projected delta. -2 comparisons in assignable, -2 ternaries in show, -2 keys in keyOf, -22
positional boolean arguments. The illegal combinations become unrepresentable.

Risk. Medium: 12 sites to change. lower.ts and emit do not read these TypeNode flags (grep), so
the change stays in three checker files.

### CHK-9 (TYPE-DRIVEN): 11 `default` clauses swallow members of closed unions

Evidence. Of 18 `default` clauses in the area:
- check_expr.ts:735 (`Target`, 4 cases; 7 kinds fall to default), :803 (`Target`, 7 cases; 4 kinds),
  :1201 (`PreludeName`; only `None`, see CHK-1), :2972 dataOnly (`TypeNode`, 9 cases; 12 kinds),
  :6710 binary (`BinaryOperator`; the 4 arithmetic operators).
- check.ts:304 schemaData (`TypeNode`; 12 kinds), :1260 (`BuiltinTypeName`, 4 cases; 13 names).
- types.ts:57 and :102 guardedRecord (IR `Type` kinds; `tuple` and 14 more fall to default).
- resolve.ts:434 targetText and :889 (`Target`).
- The 7 others are over `SyntaxKind` (check_expr.ts:663, 5079, 7303; check.ts:386;
  resolve.ts:1146, 1319, 1499). They are correct.

Proposal. List each member explicitly and end with an `assertNever`-style check, so a new
TypeNode kind or Target kind is a compile error. resolve.ts:434 already narrows by the `id` field
and can stay.

Projected delta. Branch count rises by the listed arms; 10 silent fallbacks become
compiler-enforced.

Risk. Low.

### CHK-10 (TYPE-DRIVEN, contains a probable defect): `dataOnly` and `schemaData` are two versions of one rule

Evidence. check_expr.ts:2934 dataOnly (42 lines, 21 branches) and check.ts:262 schemaData (46 lines,
25 branches) recurse over the same 9 TypeNode kinds. They differ in 2 places: schemaData rejects
`unit` and the named ids `SchemaError` and `SchemaIssue`; dataOnly accepts them. Both are checker
code, so sharing is allowed. A probe (scratch-CHK/codec_probe.ts) observed:
`codec` over `void` and `codec` over `SchemaIssue` check with no diagnostic, but
`Schema<void, void, never, never>` gets "Schema decoded and encoded types must be data only".
codecCall (check_expr.ts:1594) uses dataOnly with the message "codec types need compiler-derived
schemas". A codec derives a schema, so the codec rule probably must match schemaData.

This is a probable defect, not a confirmed one. The check: emit the `codec` over `void` program,
run `deno check` on the output, and run the validator on its IR.

Proposal. One `dataOnly(ref, rule: "schema" | "value", acceptPoisoned)` in check.ts, with an
exhaustive switch (CHK-9). Decide the codec rule with the check above before the merge.

Projected delta. -1 function (about -40 lines, -21 branches). The rule difference becomes one named
parameter.

Risk. Medium if the codec rule changes: that is a behavior change and needs its own commit.

### CHK-11 (TYPE-DRIVEN): a type guard for `TypeId | ErrorId` removes prefix tests and casts

Evidence. TypeNode `named` has `id: TypeId | ErrorId`. Both are template literal types in ir.ts
(`type:${string}`, `error:${string}`). The area has 12 `startsWith("error:")` tests (check_expr.ts
7, check.ts 3, types.ts 1, patterns.ts 1) and 38 `as TypeId` or `as ErrorId` casts (check.ts 16,
check_expr.ts 12, types.ts 9, patterns.ts 1).

Proposal. `isErrorId(id): id is ErrorId` in types.ts. Type the alias, brand, and guard maps by the
union where the code only looks up. A per-site check must confirm how many casts go; the count of
casts that become unnecessary needs measurement.

Risk. Low.

### CHK-12 (MECHANICAL): a table for builtin type names in `TypeLowerer.named`

Evidence. check.ts:426 named (147 lines, own cyclomatic 40). It has 6 copies of `if (args.length !==
N) { this.arity(...); return this.errorLowered(); }` and 4 `noArguments` calls. resolve.ts holds
the 17 builtin type names twice (`BuiltinTypeName` and `BUILTIN_TYPE_NAMES`, lines 257-293).
32 lines of named never run (RetrySchedule and Fiber error paths, lines 445, 495-551).

Proposal. `BUILTIN_TYPES: Record<BuiltinTypeName, { arity; build }>` and a derived name set.

Projected delta. -6 `if`; -17 lines in resolve.ts.

Risk. Low. Lowered carries both a ref and an IR tree; see section 5 before you merge them.

### CHK-13 (TYPE-DRIVEN): correlate `Entry` and `Run` in `checkModuleBodies`

Evidence. check_project.ts:215 (219 lines). `commit` casts `entry.signature as FunctionSignature`
and `as ConstantSignature` (2 casts), because `Entry` does not tie its signature kind to the `Run`
kind. The function keeps 8 mutable collections (importedValues, methodTypes, modes, inferred,
constantTypes, functions, constants, diagnostics). The `values` closure reads `modes`; the
`solveModeGroup` callback writes `modes` (line 362). So the mode assumption of a round reaches the
body checker only through a shared mutable map. `collectEntries` and `checkModuleBodies` both throw
on the same missing-module invariant (lines 167, 220).

Proposal. `type Entry = { kind: "function"; signature: FunctionSignature; ... } | { kind:
"constant"; ... }` so `runEntry` and `commit` narrow without casts. Pass the round's assumed modes
into a per-round `BodyEnv` instead of writing them into the outer map.

Projected delta. -2 casts; -1 hidden dependency (the shared `modes` map between the solver and the
value lookup).

Judging tests. check_test.ts recursion and mode tests, tests for execution-mode/003 and /004.

Risk. Medium for the mode change: the final `modes` map also feeds `orderedModes`.

### CHK-14 (MECHANICAL): three hand-written copies of the capability-to-service parse

Evidence. check.ts:1124 `serviceOfCapability` uses `indexOf(".", hash)`. check_expr.ts:3127 uses
`lastIndexOf(".")` with `slice(4, ...)`. check_expr.ts:5555 and 5558 use `lastIndexOf(".")` with
`slice(0, ...)` and compare capability prefixes, not service ids. The three copies use two
different split rules.

Proposal. Use `serviceOfCapability` at all three sites (check_expr.ts already imports from check.ts).

Projected delta. -3 parse copies. A method name with a dot would give two different services
today; this needs measurement only if names can contain a dot.

Risk. Low.

## 3. Test gaps that block a rederive

- check_expr.ts: 72 of 205 `this.report(` sites never run in the full suite. The full list by
  handler is in /tmp/rederive/scratch-CHK/unhit_reports.txt. The largest groups: layerCall 6 (all
  of its diagnostics), retryScheduleCall 4, retryStreamCall 3, allCall 3, allResultsCall 3, and 2
  each in withFiberCall, checkBorrowedParameter, mapEffectCall, flatMapStreamsCall,
  scheduleFromStepCall, mergeStreamsCall, raceCall, mergeLayersCall, validateAllCall, recordUpdate.
- 13 of the 25 "needs a Stream value" sites never run. This blocks CHK-2 and CHK-3.
- The builtinCall `default` (`None` as a callee) never runs. This blocks CHK-1.
- behavior:capture records only what the tests run. The unexecuted sites above are therefore
  outside the refactor oracle too. Add the tests before each change, then capture.
- types.ts heightWithin: 32 lines uncovered (blocks the proof for CHK-7). show: 10 lines.
- check.ts named: 32 lines uncovered (blocks CHK-12).
- resolve.ts: describeKind 8 lines and 8 branches uncovered; serviceRef 15 lines.

## 4. Docs that the proposals would make stale

- README.md Layout, line 157 (`check_expr.ts  Body checker ...`), if CHK-1 to CHK-4 move handlers
  into new files.
- docs/solutions/logic-errors/checker-expected-type-is-enforced-not-a-hint.md (cites
  check_expr.ts "about line 6858" and the takeSink code) and
  docs/solutions/logic-errors/checker-result-type-from-expected-hint.md (cites check_expr.ts:4726-4730).
  Line numbers go stale after any move.
- docs/plans/2026-10-19-schema-*-contract.md files describe schema flags by their IR names. CHK-8
  keeps the IR, so these stay correct; check them for TypeNode wording.
- CONCEPTS.md has no prelude or registry entry. If CHK-1 adds a registry, add the term.

## 5. What not to touch

- types.ts assignable (own cyclomatic 116): an exhaustive switch over 21 kinds with no `default`.
  The branches are the subtyping rules. A helper for "both directions" removes only 7 `&&` pairs.
- types.ts keyOf (24) and the intern key rules: keyOf normalizes `borrows ?? []` and
  `makeInput ?? decoded`. A generic serializer would change type identity. Leave it.
- types.ts toIr (28), fromIr (23), show (46): exhaustive switches over the closed TypeNode union.
- `Lowered { ref, ir }` in check.ts: a probe (scratch-CHK/lowered_probe.ts and
  lowered_probe_sorted.ts) wrapped `TypeLowerer.lower` over all 123 fixture files. 70 of 3620 calls
  gave `ir` that differs from `table.toIr(ref)`: 65 differ only in member or field order (the IR
  keeps source order), and 5 keep a schema `makeInput` that the interned type drops. The two
  representations are therefore not redundant. Do not derive `ir` from `ref`.
- binary (41): one exhaustive switch over 12 operators. Only its `default` should list the 4
  arithmetic operators (CHK-9).
- tables.ts (cyclomatic at most 6, 100% covered), modes.ts (pure, 100% lines), initialization.ts
  (100% lines), patterns.ts (99.1% lines, domainOf 17 over a closed union).
- resolve.ts expr (39) and resolveType (29): switches over `SyntaxKind`, 95% covered. The one
  oddity is the `layer` special case at resolve.ts:1247-1272, which matches the callee by text.
  It is safe because `layer` is not shadowable.
- The `BodyChecker` class state (`sink`, `body`, `pendingLocals`, `errorCount`): `errorCount` has
  one reader (tryExpr:6952). A pure rewrite of the class has a low gain for its size.

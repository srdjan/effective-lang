# Scout report VAL (validator): src/core/validate/ and src/core/validate_project.ts

Scope: read-only review. All numbers come from /tmp/rederive/fns.tsv, /tmp/rederive/measure.ts,
the fast-suite lcov (/tmp/rederive/cov/lcov.info), grep or perl counts, and three scratch probes in
/tmp/rederive/scratch-VAL/ (sites.py, fncov.py, probe.ts, depth.ts). Full-suite coverage was not
available (/tmp/rederive/covall is empty). Coverage numbers are fast-suite only. 27 slow test files
also call the validator, mostly on accepted programs, so their effect on happy-path coverage needs
measurement.

## 1. Baseline

| File | LOC (measure) | AST branches | max cyclomatic | top-3 by cyclomatic | branch % | line % |
| --- | --- | --- | --- | --- | --- | --- |
| validate/expr.ts | 5372 (5517 raw) | 1629 | 195 | schema@1716 (195), compute@421 (102), anon children switch@3047 (101) | 83.0 | 81.9 |
| validate/world.ts | 1091 | 361 | 64 | checkBuiltinShape@834 (64), walk@164 (39), reaches@737 (22) | 86.1 | 79.3 |
| validate/typing.ts | 469 | 314 | 121 | assignable@93 (121), show@424 (44), comparisonClass@391 (16) | 96.1 | 94.5 |
| validate/serialization.ts | 150 | 49 | 16 | walk@108 (16), checkSpan@69 (10), isSortedUnique@17 (6) | 94.7 | 93.4 |
| validate/sets.ts | 56 | 8 | 6 | combine@47 (6), sameSet (2), sortedUnique (1) | 91.7 | 100 |
| validate/index.ts | 69 | 9 | 4 | validateModule@26 (4), unexpected (2), guard (2) | 75.0 | 100 |
| validate/report.ts | 20 | 0 | 1 | add (1) | 100 | 100 |
| validate_project.ts | 30 | 3 | 3 | validateProject (3), projectSources (2) | 100 | 100 |

Per-function coverage of the hot spots (fns.tsv ranges intersected with lcov DA/BRDA):

| Function | cyc | lines / uncovered | lcov branches / uncovered |
| --- | --- | --- | --- |
| expr schema@1716 | 195 | 538 / 24 | 334 / 41 |
| typing assignable@93 | 121 | 186 / 4 | 232 / 3 |
| expr compute@421 | 102 | 211 / 2 | 202 / 2 |
| expr children switch@3047 | 101 | 166 / 96 | 200 / 96 |
| world checkBuiltinShape@834 | 64 | 176 / 61 | 93 / 22 |
| expr call@1131 | 42 | 85 / 6 | 45 / 7 |
| world walk@164 (checkTypeIds) | 39 | 130 / 10 | 71 / 6 |
| expr binary@5441 | 37 | 74 / 0 | 66 / 1 |
| world reaches@737 | 22 | 63 / 19 | 40 / 7 |
| expr groupKeyClass@4576 | 17 | 29 / 13 | 10 / 7 |
| typing comparisonClass@391 | 16 | 30 / 10 | 23 / 4 |
| world recursiveDataOnly@661 | 16 | 39 / 13 | 20 / 3 |

Validator tests: tests/validate_test.ts (138 tests, timed sum 164 ms, max 12 ms),
tests/validate_mutation_test.ts (7 tests, timed sum 38 ms, max 23 ms), tests/validate_typing_test.ts
(18 tests), tests/schema_validator_forged_test.ts (7 tests). All run in the fast suite.

## 2. Findings ranked by leverage

### VAL-1 (MECHANICAL, removes a failure class): one Type traversal in world.ts, with one depth bound

Problem. world.ts has three Type walkers that list the same children: checkTypeIds.walk@164,
checkRecordFields.walk@331, and checkRecursion.reaches@737. Each has 20 recursive call sites (60
in total), and the case lists are 20, 15, and 16 labels. Two of them end in `default: return`
(world.ts:393, :796). Each stops silently at `depth > 200` (world.ts:165, :332, :738), while
typing.ts uses MAX_DEPTH = 1536 with a documented reason (typing.ts:37-41), and the parser permits
512 levels.

Evidence (observed, probe /tmp/rederive/scratch-VAL/depth.ts). A constant whose recorded type is an
array nested N levels around `type:m#Missing`: at N = 10 and 199 the validator reports
validation/001 "type:m#Missing is not declared". At N = 201 and 300 it reports no validation/001.
validation/002 still appears in this probe only because the value 1 does not fit the deep type. The
same silent cutoff in checkRecordFields (duplicate field names) and reaches (recursive cycles) is
probable from the identical code shape; a test like depth.ts with a duplicate field or a cycle below
depth 200 confirms it.

Proposal. Add one exhaustive `typeChildren(t: Type): readonly (readonly [Type, string])[]` (child and
path suffix) with no `default`, in validate/ (world.ts or a new validate/types_walk.ts). Rewrite the
three walkers as loops over it. Use one bound, and report an explicit diagnostic when a walk reaches
it, instead of a silent return.

Contract (target: the three walkers). Input: a Type, a path, a span. Output: diagnostics only
(validation/001 for unknown ids, sets, retry-schedule error kind, Schema flags; validation/002 for
duplicate fields and recursive types). Invariants: path strings stay byte-identical
(`.fields[i].type`, `.element`, `.decoded`, `.makeInput`, `.leftover`, `.members[i]`,
`.parameters[i]`, `.result`, `.input`, `.output`, `.error`, `.elements[i]`). checkTypeIds keeps its
non-structural checks (Schema flags, borrows length, provider provides) in its own switch.

Judging tests. validate_test.ts identity and recursion cases; the walk@164 has 10 of 130 lines
uncovered, reaches has 19 of 63 lines uncovered (lines 753-778: retry-schedule, codec, schema, fiber,
stream, schedule, sink children). Strength: medium. Add a depth test at the bound.

Projected delta. 60 recursive call sites become 20 (-40). checkRecordFields and reaches lose 15 + 16
case labels and 2 `default` clauses. One silent false-negative class removed (observed for
validation/001). Risk: low; message paths are the only output.

### VAL-2 (TYPE-DRIVEN): one Expr child enumeration for the five body walkers in expr.ts

Problem. expr.ts walks expression trees five times. scopedReferences@3027 uses a typed, exhaustive
switch of 100 case labels (the anonymous function @3047, cyclomatic 101). Four other walkers use
reflection over `unknown`: guardedSchemaBody.containsSelf@2283, fiberReferences.visit@2569,
borrowedReferences.visit@3325, groupReferences.visit@4608. Each reflective walker tests
`Array.isArray`, `null/object`, detects an Expr by `"kind" in && "type" in && "effects" in &&
"span" in` (3 walkers), and skips keys `type`, `effects`, `span`. They hold 7 casts (`as
Record<string, unknown>` 4, `as Expr` 3).

Evidence. Probe /tmp/rederive/scratch-VAL/probe.ts lowered 42 accepted modules from fixtures/
(3151 Expr nodes, 48 of the 100 Expr kinds) and compared the typed child list with the reflective
nearest-Expr descendants: 0 mismatches. The typed switch has 59 of 62 return lines uncovered in the
fast suite, because only scopedReferences calls it.

Proposal. Move the typed switch to module scope as `exprChildren(e: Expr): readonly Expr[]` and add
one `walkExprs(body, visit(e, parent, grandparent, nested))`. Rewrite the four reflective walkers
on it. The compiler then enforces that a new Expr kind is classified (today the reflective walkers
accept any shape, and the typed switch is enforced only by the Comp return type).

Contract. Input: a closure body and a binding id. Output: validation/006 diagnostics at the
reference span. Invariants: the walk visits the same nodes with the same parent and `nested`
(inside-closure) flag; containsSelf keeps its "any reference to self" meaning.

Judging tests. validate_test.ts borrow, fiber, group, scoped-resource, and recursive Schema cases;
visit@3325 and visit@4608 have 0 uncovered lines; visit@2569 has 9 of 34 lines uncovered. Strength:
medium. The probe covers 48 of 100 kinds only; a test that runs exprChildren against the reflective
form over every fixture IR closes the gap for the other kinds that fixtures reach.

Projected delta. -4 reflective traversals, -7 casts, about -6 decisions per reflective walker
(Array check, object check, 3 `&&` kind detection, skip-key `||`), so about -22 decisions in total;
the typed switch gets 5 callers instead of 1. Risk: medium; a missed field in exprChildren hides a
reference. The probe and the proposed equivalence test bound it.

### VAL-3 (MECHANICAL): stream operator methods that differ only by name or one result line

Evidence (normalized diffs, names replaced by NAME/KIND):
- dropWhileStream@4208, filterStream@4247, takeWhileStream@4345, takeUntilStream@4384: identical
  (38 LOC, cyclomatic 10 each). effectStreamPredicate@4286 already serves 4 kinds with one method.
- collectStream@3773, headStream@3799, lastStream@3825, drainStream@3851: identical except the
  result type line (25 LOC, cyclomatic 2 each).
- takeStream@4140 and dropStream@4174: identical (33 LOC, cyclomatic 6).
- flatMapStreams@3877 equals switchMapStreams@3940 plus the 11-line concurrency block (62 / 51 LOC,
  cyclomatic 16 / 12).
- scanStream@3537 and foldStream@3657 differ only in the result type and the active set (55 LOC
  each, cyclomatic 14); mapAccumStream and foldEffectStream share the same prefix.

Proposal. Group each family into one method keyed by kind, with a `Record<kind, name>` table for
messages and a result function per kind, as effectStreamPredicate does.

Contract (family method). Input: an Expr of the family kinds and a path. Output: Comp. Effects:
diagnostics with the same AREA codes, paths, and byte-identical messages (each message names the
operator, for example "filterStream requires an inline closure"). Invariants: child check order
does not matter for output, because normalizeDiagnostics sorts and deduplicates.

Judging tests. Weak for failure paths: in this region all 16 inline-closure guards, all 7 seed,
count, and policy purity checks, and all 7 stream-only guards are uncovered; 48 of 69 `return
this.poison()` lines in expr.ts are uncovered (list in section 3). Success paths are covered.
`deno task behavior:capture` judges only reached paths.

Projected delta (from fns.tsv). 3 x 38 + 3 x 25 + 33 + 51 = -273 LOC; 3 x 9 + 3 x 1 + 5 + 11 = -46
decisions. scan/fold grouping is extra and needs measurement. Risk: message drift on uncovered
paths; add the section 3 tests first.

### VAL-4 (MECHANICAL): repeated guards and set unions in expr.ts and world.ts

Counted sites:
- "pure with empty sets": `x.execution !== "pure" || x.(effects.)failures.length > 0 ||
  x.(effects.)requirements.length > 0` at 25 sites in expr.ts (337, 1106, 1604, 2202, 2725, 3515,
  3560, 3572, 3624, 3636, 3680, 3692, 3746, 3909, 3961, 4021, 4077, 4157, 4191, 4229, 4268, 4366,
  4405, 4545, 5269) and 1 in world.ts (855). 7 sites test an Out, 19 test a function type. One
  `isQuiet(active)` plus `invocationOf(fn)`: -52 `||`, +2 in the helper, net -50.
- Concurrency value: `e.concurrency !== undefined && e.concurrency !== "unbounded" &&
  !(Number.isSafeInteger(e.concurrency) && e.concurrency > 0)` at 5 sites (2666, 2738, 2828, 3440,
  3882), plus the literal form at 1181 and 1202, plus the option-record type check twice in
  world.ts (876-884, 946-956). One helper for the 5 IR-field sites: -15 `&&`, +3, net -12.
- Paired effect-set union `failures: sortedUnique([...]), requirements: sortedUnique([...])` at 17
  sites, 138 lines in total (8 lines each, 10 at 4954). One `unionEffects(...parts)`: -121 LOC.
- `unionOf(env, failures.map((id) => ({ kind: "named", id })))` at 4 sites (2678, 2711, 2799, 4014).

Judging tests. The 5 concurrency sites are covered; the purity sites are partly uncovered (7 of 7
Out-purity bodies). Risk: low; messages do not change.

### VAL-5 (MECHANICAL + TYPE-DRIVEN): schema@1716, 559 lines, cyclomatic 195

Problem. One method handles the 18 ops of the closed union in ir.ts:202 with an if-chain of 25
`e.op` comparisons and a final `return bad("unknown schema constructor")` (2273, uncovered). Repeats
inside it: 23 `args[i] === undefined ? undefined : f(args[i].type)` guards; 4 "only SchemaIssue
failure" variants (validSchemaCallback@96, 1805-1808, 1906-1910 with SchemaError, 2225-2233); the
source/target/callback requirement triple 3 ops x 2 = 6 sortedUnique calls; 5 inherit-target
spreads; 7 `e.arguments[i]?.kind !== "closure"` checks; 11 `match: "exact", active: combine(args)`
returns. schemaOf rebuilds a 7-element op list on each call (1722-1730). guardedSchemaBody.visit
classifies ops with 17 more string comparisons.

Proposal. A switch over `e.op` with no default dispatches to one function per op (or op group).
Helpers: argSchema(i), argFunction(i), failsOnlyWith(fn, allowed), mergedRequirements(source,
target, fn). Put the op classes used by schemaOf and guardedSchemaBody in one exhaustive
`Record<SchemaOp, ...>` table. Keep an explicit malformed-op report for forged IR, because the
validator reads IR that may not match the TypeScript type.

Contract. Input: a `schema` Expr and a path. Output: Comp; a Schema type with decoded, encoded,
makeInput, requirement sets, and the four flags, or a validation/002 report and poison. Error
cases: each op message stays byte-identical.

Judging tests. Strong: 24 of 538 lines and 41 of 334 lcov branches uncovered;
schema_validator_forged_test.ts (7 tests) and the Schema cases in validate_test.ts.

Projected delta. -22 ternaries (23 guards to 1 helper), -6 sortedUnique triples to 2 helper calls,
the 17 op comparisons in guardedSchemaBody to 1 table lookup; each op function well under 30
cyclomatic (needs measurement after a draft). Risk: medium; high fan-in of messages.

### VAL-6 (TYPE-DRIVEN): Comp encodes three states with optional fields

Problem. Comp (expr.ts:72-80) has `type: Type | undefined`, `match: "exact" | "fit"`, and
`poisoned?: boolean`. `type: undefined` means two things (the comment at 73 says "validated its
type itself, or it cannot be recomputed"). poison() (417) carries a dead `match` and a dead
`active: QUIET` that finish ignores (384). 16 returns carry a dead `match: "exact"` with
`type: undefined`; unbrand@950 returns `type: base` where base can be undefined.

Proposal. `type Comp = { tag: "derived"; type; match; active } | { tag: "checked"; active } |
{ tag: "poisoned" }`, and a switch in finish. Constructors `derived(type, active)`,
`checked(active)`, `poisoned()` keep the call sites short.

Judging tests. finish has full coverage through all validator tests; strength high for this change.
Projected delta: branch count about neutral; 17 dead fields and the poisoned flag become
unrepresentable; 69 poison, 16 checked, and about 99 derived sites change by a mechanical rename.
Risk: low; large but mechanical diff.

### VAL-7 (MECHANICAL): two data-only predicates and two primitive-class functions

Evidence. expr.ts dataOnly@2964 (32 LOC, cyclomatic 13) and world.ts recursiveDataOnly@661 (43 LOC,
cyclomatic 16) have the same cases and the same `seen` set. They differ in two rules:
recursiveDataOnly rejects `unit` and the two reserved Schema errors. typing.ts comparisonClass@391
(31 LOC, 16) and expr.ts groupKeyClass@4576 (29 LOC, 17) have the same union loop and the same
`brand:<id>` encoding; they differ in leaf rules and in the depth bound (MAX_DEPTH against 128).

Proposal. One `dataOnly(env, type, policy)` and one `primitiveClass(env, type, leaf)` in typing.ts.

Judging tests. Weak: recursiveDataOnly 13 of 39 lines uncovered, groupKeyClass 13 of 29,
comparisonClass 10 of 30 (the brand branch 408-416 is uncovered). Projected delta: -1 traversal
each, about -30 LOC and -12 decisions for dataOnly; the class merge needs measurement. Risk:
medium; the differing rules must become explicit parameters.

### VAL-8 (TYPE-DRIVEN): the builtin name is a string parsed twice

Evidence. world.ts parses the builtin name with BUILTIN_ID (831) and branches on it with `===` in
checkBuiltinShape (64 cyclomatic; 61 of 176 lines uncovered). expr.ts call@1151 parses the same name
again with `.split("/")[1]` and compares it with "traverse" and "all". World.builtins is
`Map<string, string>`. The "all" container shape logic (world 887-893, 910-921) repeats the
allResults logic (expr 2765-2771, 2838-2849).

Proposal. `type BuiltinName = "map" | "filter" | "fold" | "all" | "traverse"` parsed once in
buildWorld; checkBuiltinShape becomes a switch over it; one `containerEntries` and one
`rebuildContainer` helper.

Contract. Behavior change risk: today buildWorld records every prelude value as a builtin even
when its id fails BUILTIN_ID, and call() still applies the callback purity rule to it. A rederive
must keep that or decide it explicitly. Judging tests: weak (61 uncovered lines; no mutation
fixture changes a prelude payload). Projected delta: -1 parse, -6 ternaries in the two container
blocks, -1 duplicated 9-line options check. Risk: medium.

### VAL-9 (MECHANICAL): typing.ts small repeats

assignable has 7 invariant pairs `assignable(a, b) && assignable(b, a)` (ref, retry-schedule, codec
x2, schema x3) and 6 effect-subset pairs (effect, stream, schedule, sink, function, provider). show
has 11 `.join(" | ") || "never"`. Helpers: -6 `&&` (pairs), -5 `&&` and -1 `if` (subsets), -10 `||`
(show). Judging tests: strong (assignable 4 of 186 lines uncovered). Risk: low. Leverage is low,
because assignable is already an exhaustive switch.

### VAL-10 (MECHANICAL): checkFunction and closure repeat three blocks; manual scope pairing

checkFunction@171 and closure@998 repeat the parameter-type comparison (178-196 / 1017-1035), the
expected execution rule (308-320 / 1066-1079), and the set checks. Scope push and release is manual
at 5 sites (175/249, 1002/1006, 1267/1282, 1349/1337, 1488/1501). One `withLocals(params, run)`
makes a missed release unrepresentable. Messages differ, so the helper takes message text.
Projected delta: about -30 LOC and -4 decisions (needs measurement). Risk: low.

## 3. Test gaps that block a rederive in this area

- expr.ts failure paths: 48 of 69 `return this.poison()` lines uncovered (937, 1560, 1581, 1653,
  1676, 2409, 2461, 2554, 2631, 2663, 2782, 2795, 2866, 2887, 2935, 3241, 3410, 3426, 3473, 3524,
  3743, 3786, 3812, 3838, 3864, 3918, 3970, 4030, 4064, 4102, 4123, 4154, 4188, 4323, 4447, 4476,
  4818, 4876, 5031, 5058, 5086, 5128, 5165, 5194, 5240, 5302, 5315, 5361). All 16 inline-closure
  guards, 7 Out-purity checks, and 7 stream-only guards are uncovered. These block VAL-3 and VAL-4.
  Cheapest fix: one table-driven test in validate_mutation_test.ts per family that replaces the
  callback closure by a reference and the stream by a non-stream value, and asserts code, path, and
  message fragment.
- The typed children switch: 59 of 62 return lines uncovered (blocks VAL-2 without the equivalence
  test).
- world.ts: checkBuiltinShape 61 of 176 lines; checkServiceDecl error lines 433-480; checkTypeDecl
  opaque checks 488-506; checkImport prelude checks 1085-1119; reaches 19 of 63 lines. No test
  reaches the depth bound (VAL-1).
- typing.ts: comparisonClass brand path 408-416; assignable function-borrow lines 249-253.
- Mutation fixtures: 17 fixtures cover all 8 codes (001: 4, 002: 2, 003: 2, 004: 2, 005: 1, 006: 2,
  007: 1, 008: 3), and validate_test.ts:2168 asserts that every code has a fixture. But 12 of 17
  mutate log.eff, 2 pay.eff, 3 users/main. None touches streams, Schema, fibers, scopes, layers,
  refs, or prelude builtin payloads. So the fixtures can judge a rederive of the area-code plumbing
  and of finish, not of VAL-3, VAL-5, VAL-7, or VAL-8. validate_mutation_test.ts (7 tests) asserts
  only validation/002 (22 times) and validation/003 (2 times).

## 4. Docs that the proposals make stale

- README.md Layout lines 172-179 list the validator files; a new file (VAL-1 or VAL-2 walker module)
  needs a line.
- docs/solutions/logic-errors/checker-result-type-from-expected-hint.md:59 cites
  `src/core/validate/expr.ts:4777`; any change above that line moves it (scheduleFromStep now
  starts at 4733).
- docs/plans/2026-10-17-effect4-gap-closure.md, -r1-and-brand-operators.md, -r2-nominal-records.md
  name validate/expr.ts or world.ts; they are dated plans and need no edit unless they cite lines.
- expr.ts header comment (lines 2-9) calls the validator "the checker"; CONCEPTS.md lists "IR
  checker" under Avoid. A rewrite of that file should use "validator".
- CONCEPTS.md "Independent validator" stays correct.

## 5. What not to touch

- compute@421 (cyclomatic 102): 100 of its decisions are case labels of a pure dispatch; 2 of 211
  lines uncovered; the switch is already compiler-exhaustive through the Comp return type. A
  dispatch table needs a cast on the lookup.
- binary@5441 (37): exhaustive over the operator union, 0 uncovered lines.
- assignable@93 (121): an exhaustive switch over Type with no default, 4 of 186 lines uncovered;
  only VAL-9 helpers apply.
- serialization.ts (16 max, 94.7 / 93.4 %), sets.ts, report.ts, validate_project.ts (100 %).
- index.ts guard: the try/catch that turns a thrown error into validation/008 is a deliberate,
  tested boundary for malformed IR (validate_test.ts:2745 and :2751). It also hides a validator
  defect as a shape report; a typed IR decoder would remove that, but it is a large separate
  project and is not proposed here.
- The remaining `default` clauses at typing.ts:304, world.ts:609, :654, :700, expr.ts:2992 encode
  a deliberate conservative "other kinds are not guarded or not data" rule; VAL-7 removes two of
  them as a side effect, and the others are low leverage.

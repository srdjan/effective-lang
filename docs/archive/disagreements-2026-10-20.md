# Disagreement audit and corrections, 2026-10-20

Status: complete. The approved plan preserves the application
acceptance rule and validator independence. The user approved supporting
TypeScript exports and rejection of unsafe incomplete record matches.

Audit baseline: `730977c`; 1,241 fast and 129 slow tests passed on Deno 2.9.7.
Implementation starts at `9adc5cd`. Intervening commits already repair supporting
exports (`5da2bbf`) and most behavior capture coverage (`5d5c8fa`, `0844b30`).
Those changes are retained and verified rather than reimplemented.

## TODO

- [x] C1: replace stale alias, brand, opaque and guarded-recursion metadata during incremental checks.
- [x] C2: require complete record-match coverage and sound narrowing, preserving wildcard matches; N5 completes the runtime-overlap cases.
- [x] C3: select contextual record-union candidates using known literal field values.
- [x] C4: verify all supporting exports, including strict two-module regressions; implementation already present.
- [x] C5: resolve supported emitter alias chains without the silent 64-hop cutoff.
- [x] C6: reject unsorted or duplicated Schema decode and encode requirement sets.
- [x] C7: resend every playground file after an internal failure.
- [x] C8: enforce the complete LSP header limit independently of chunk boundaries.
- [x] C9: release application-test cleanup gates after failed handshakes or assertions.
- [x] C10: verify batch, incremental and child-process behavior capture, and expose recording failures.
- [x] D1: distinguish prospective measurement definitions from recorded D9 measurements.
- [x] D2: correct the small synthetic-module size in the design and evidence ledger.
- [x] N1: make the new fault-injection tests open their gates in the deadline harness's own finally block.
- [x] N2: format compound record-pattern guards correctly as first and later conditional tests; long-tag regression added.
- [x] N3: rejected expansion into extreme-identifier Schema member-chain formatting; README and the rules ledger explicitly retain this limitation.
- [x] N4: exclude generated local agent worktrees from root verification without changing those worktrees.
- [x] N5: retain branded and unknown discriminator members that can equal a literal at runtime; general type assignability stays unchanged.
- [x] N6: correct the core-boundary guard comment to describe capture's intentional record writes rather than removed environment reads.
- [x] V1: review the combined diff and pass `deno task check` on Deno 2.9.7.

Each correction is complete only when its focused checks pass. V1 records the
final combined verification. New tasks receive their own item and end as done,
rejected with a reason, or blocked on an explicit user decision.

## Evidence and boundaries

The original probes showed incremental acceptance of an unbranded literal after
an alias-to-brand edit; an accepted record match returning undefined as Int;
false rejection of a second tagged-union constructor; missing supporting exports
(TS2459); a missing Effect lift behind 70 aliases (TS2322); unchecked Schema
requirement ordering; lost playground edits; chunk-dependent header decoding;
blocked application-test finalizers; and missing behavior-capture paths.

All findings had high confidence from direct code inspection and reproductions.
The design's blanket denial of measurements conflicts with its recorded D9
results. The synthetic small preset has 30 feature declarations, not 60.

The application witnesses, accepted feature stopping rule, deferred package
interoperability, independent validator boundary, and disclosed release and
measurement limits remain sound. The internal comparison cap alone is rejected
as evidence of a new checker defect: the cap still exists, and no new failing
legal source was demonstrated.

Integration found a further narrowing case (N5): a discriminator of
`Brand<string>` can hold `Tag("a")`. Excluding that member lets a source match
return text from a function declared to return Int. An unknown discriminator
similarly remains possible at runtime, despite unknown not being a top type
for source assignability. Runtime tag compatibility must therefore follow
brand bases and unknown values separately from ordinary assignability.

### Findings at the audit baseline

| ID | Exact claim or decision and contrary evidence | Correction |
| --- | --- | --- |
| C1 | README: "A revision therefore equals a run from scratch." `types.ts` retained an alias after `defineBrand`; an incremental unbranded literal was accepted while a fresh check rejected it. | Replace metadata when a type identity is redefined. |
| C2 | `patterns.ts` classified all record unions as tagged; `check_expr.ts` counted only known tags. A valid missing-tag member reached an unchecked last arm and returned undefined as Int. | Require missing coverage and preserve every runtime-matching member. |
| C3 | `check_expr.ts` selected `fitting[0]` by labels alone. The valid second branch `{ kind: "b", value: "hello" }` was checked against the first branch's tag and Int payload. | Filter contextual candidates by known literal values. |
| C4 | Rules ledger: "Declarations that an exported signature reaches are exported in TypeScript, even when the source keeps them private." Missing traversal generated private supporting imports and TS2459. | Retain the upstream fix and verify every omitted type channel across modules. |
| C5 | The rules ledger permits depth 128; `Scope.resolve` stopped after 64 aliases. A 70-alias function target lost its Effect lift and gave TS2322. | Follow aliases with cycle detection. |
| C6 | Serializer: "sets are sorted and unique." Schema decode and encode requirements were omitted from both serializer and independent validator ordering checks. | Check both Schema set properties independently. |
| C7 | Playground facade: after an internal error "the next call sends every file again." The catch retained `sent`, losing an edit when another file changed next. | Reset `sent` in the internal-error catch. |
| C8 | Transport: "A header block larger than this is malformed." The same oversized bytes were accepted whole and rejected when split. | Apply the 8,192-byte bound to the complete header, including CRLFCRLF. |
| C9 | Service witness: "Gate-opening test cleanup must survive assertion failure." Worker assertions could leave release blocked even after an Effect timeout. | Install cleanup around each complete parent handshake. |
| C10 | Capture claimed "every checker diagnostic list," but bypassed direct `checkAnalysis`, incremental checking and permission-restricted children. | Verify the upstream hooks, fail recording errors visibly and name the actual capture boundary. |
| D1 | Design section 10: "No number in this document is a measurement." Its D9 record contains dated M1 samples, p90s and noise floors. | Distinguish measurement definitions from recorded results. |
| D2 | Evidence ledger: "Every synthetic feature module has 60 declarations." `bench/generate.ts` defines the small preset as 30. | Describe the 60-declaration cap and the 30-declaration small preset. |

All twelve assessments were high confidence. Contrary evidence that would have
changed them was, respectively: equivalent fresh and incremental results;
proof that missing-tag values could not inhabit the subject; an accepted ban
on same-shape tagged construction; a deliberately private supporting-export
contract; a source diagnostic rejecting the longer alias chains; an explicit
Schema set-order exemption; a requirement that ProgramPort commit before
throwing; permission for chunk-dependent framing; prompt injected-failure
termination under the original guards; actual records from the omitted capture
paths; a historical qualification on the measurement disclaimer; or a generator
that actually gave the small preset 60 declarations. None was present at the
audit baseline. The corrections now have direct regression evidence.

N3 is rejected because it reproduces the explicitly accepted exception in
README's emitter section and the rules ledger's "a struct field past 80 columns"
and "a member access that breaks at the dot" entries. It is unrelated to the
new compound guard, whose formatting is covered by N2.

## Verification

- `deno test --allow-read tests/db_test.ts tests/types_test.ts`: 47 passed.
  The new regressions failed before the metadata fix.
- `deno test --allow-read tests/emit_alias_resolution_test.ts tests/schema_set_serialization_test.ts`: 2 passed.
- `deno test --allow-all tests/emit_alias_resolution_slow_test.ts`: 1 passed.
  Strict checking and execution cover alias depths 63, 64, 70 and 125; depth
  126 exceeds the existing source limit.
- D1 and D2 checked against the current D9 record and `bench/generate.ts`.
- The initial full gate scanned three pre-existing `.claude/worktrees/` copies
  and failed their deliberately unformatted docs and IR. The shared Deno
  exclusion now omits only that local generated directory; no worktree was
  changed. Root formatting then passed on 303 files.
- First combined `deno task check` after excluding local worktrees: 1,682 fast
  and 151 slow tests passed.
- N5: 447 focused tests passed, followed by the emitted formatting, strict
  TypeScript and runtime regression. Direct and nested brands, brand unions,
  unknown fields and forged narrowed bindings are covered. General nominal
  typing and unknown-not-top assignability are unchanged.
- Final `deno task check` after N5: formatting (303 files), lint (245 files),
  type checking, 1,685 fast tests and 151 slow tests all passed on Deno 2.9.7.
  The slow suite passed in 2 minutes 36 seconds and includes all three compiled
  application gates, seven supporting-export target cases, alias lifting,
  record-match formatting and execution, and behavior-capture permission tests.
- `git diff --check`: passed. All correction and follow-up TODOs are complete;
  N3 has the explicit rejection reason above. No user decision remains blocked.

# Compiler boundaries, IR v4, and concise source forms

Completed implementation plan, grounded at `c248489`, Deno 2.9.8. Completed 2026-10-24.

## Decisions and scope

Separate source checking and queries from concrete TypeScript output. Keep the independent validator, builtin families, emitter role interfaces, and shared declaration printers. Use existing IR operations for all syntax. Public API cleanup and IR v4 are accepted breaks; retain existing source spellings and explicit, closed exported contracts.

## Sequential units

- [x] **MS0** Freeze baseline evidence and characterization cases. Hold source inputs fixed for behavior capture; supplement with CLI/LSP assertions and same-machine M1/M3/M4 samples.
- [x] **MS1** Add `frontend.ts` and `typescript.ts` package entry points; aggregate them in `mod.ts`. Remove output queries from Revision. `TypeScriptOutputs` owns lazy emitted text, span tables, maps, and emission counts in a WeakMap keyed by lowering results. Own one cache per CLI/playground/overlay/disk program, disk lazily. Keep query order, failure results, invalidation, old revisions, and external stats. Source hover must neither lower nor emit; combined hover explicitly takes outputs. Move project emission beside orchestration and SourceEdit into source data. Enforce boundaries in architecture tests.
- [x] **MS2** Export ClosureExpr and use it for resource acquisition/use/release, fiber use, and map-groups key/use. Remove useBinding, releaseBinding, and groupBinding duplicates; closure parameters own identities. Retain external-IR closure/arity/type/reference/borrow validation. Split schedule-kind and schema-operation union members without serialized changes. Wire version 4 rejects older versions without conversion. Normalize only version and removed fields in v3 parity tests; preserve generated text/maps/interfaces.
- [x] **MS3** Bare unannotated single-parameter arrows, same ArrowExpr and existing inference/body/newline rules. Annotations, multiple parameters, and result contracts retain parentheses. Integrate indexing, recursion, hover, rename, tokens, hints, recovery, and docs.
- [x] **MS4** Lazy Option `??`, a dedicated source node lowering to match. Evaluate subject once, fallback only for None; ordinary alias unfolding and match joins, including None/never/context/effects. Right associative, below logic and above pipeline; mixing logic requires parentheses. Checker records hygienic synthesized binding/annotations; hide generated names from editors.
- [x] **MS5** Nonempty flat block-local record destructuring, shorthand/aliases and optional whole-subject type. Reject duplicate fields/names, nesting/defaults/rest/tuples/module declarations. Evaluate once, read fields in written order via existing field rules, including nominal/sealed/union/optional/own fields and borrow restrictions. Lower to block bindings/fields. Integrate field labels, local names, shorthand rename expansion, completion exclusions, scopes, diagnostics, and recovery.
- [x] **MS6** Contextual `using (name = acquisition) { use } finally { release }`, mandatory explicit finalizer. Existing arrow-body acquisition grammar; name visible only in use/finalization, one source identity remapped to distinct IR closure parameters. Use result returned, finalizer void; retain all effects, failures, requirements, captures, data-only results and borrow restrictions. Share resource checking narrowly; analyze all three regions as implicit callbacks, including nested captures. Preserve ordinary calls named using. Integrate editor/highlighter/recovery/docs.
- [x] **MS7** Adopt useful forms in examples while retaining explicit syntax fixtures. Update rules/API/concepts/status and sibling website spec/IR/examples (separate commits). Compile changed examples, strict-check TypeScript panels, run site typecheck/test. Build all five witnesses with --validate --tsc and documented runtime checks. Include editor screenshot, measure source reduction with existing corpus method, and document API/IR migration examples.

## Verification and completion

Each complete implementation unit runs focused tests and `deno task check` before its commit. Compare syntax with explicit expansion through source checking, independent validation, strict generated TypeScript, and runtime tests where execution matters; ignore only spans and hygienic identities. No golden updates for MS1; MS2 normalization is limited to intentional wire changes. Run M3 after cache movement and compare M1/M4 with same-machine baseline; retain 100 ms large-input diagnostics p90 budget and make no memory-bound claim.

Required edge cases: output memo hits/unrelated edits/config/imported spans/old revisions/separate overlay-disk; source hover no emission and backend unavailable behavior; IR older-version rejection/malformed closures/arities/unbound references/scoped escapes; lambdas context/nesting/shadowing/recursion/export contracts; fallback evaluation/laziness/chaining/effects/precedence/joins; destructuring aliases/optional/union/sensitive names/order/rename/resource extraction; resources acquisition/use/release failures, defects, interruption, exactly-once finalization, scope/captures; references/rename/completion/hover/hints/tokens/recovery for each new form.

Out of scope: generic backends/artifacts, TypeTable lifetime redesign, broad splitting, macros, generics, early returns, extra syntax, runtime target or identifier policy changes.

## Evidence and constraints

The initial baseline passed formatting, lint, type checking and 2,073 fast tests;
its fresh-cache slow-test step could not download JSR metadata. Networking and
sibling-repository writes were available when the work resumed. The final full
gate passes, including fresh-cache slow tests. The website changes are local;
no deployment was requested.

### MS0 to MS2: boundary and wire parity

- The frontend import-graph test excludes the emitter, TypeScript entry point,
  and host adapters. Adapter imports are limited to public core entry points.
- Output characterization covers lazy queries, unrelated edits, imported spans,
  host config changes, failures, unknown modules, retained revisions and separate
  overlay/disk caches. Source hover leaves lowering and emission counts at zero.
- The fixed-input frontend-refactor capture retains all 4,750 distinct baseline
  behavior records (8,192 total records); the head adds seven distinct records.
  The capture held the existing input corpus fixed. It does not claim unchanged
  serialized IR after MS2 or identical source spans after MS7 example adoption.
- `fixtures/ir/v3-baseline.json` preserves the pre-change examples plus scoped
  callbacks, grouped streams, schedule compositions and schema runners.
  `tests/ir_v4_parity_test.ts` compares all IR fields, generated text, source maps,
  and interface hashes. Its only normalization changes version and removes the
  four duplicate scoped-identity fields. External-IR mutation tests retain
  closure shape, arity, type, reference and borrow validation.

### MS3 to MS6: syntax and execution

`tests/concise_source_test.ts` compares each form with its explicit expansion
through checking, lowering, independent validation and emission, ignoring only
spans and hygienic local identities. It covers contextual/nested arrows,
contract requirements, Option joins/precedence/effects, flat bindings and
unsupported shapes, resource scopes/captures, editor queries and recovery.

`tests/concise_source_slow_test.ts` strictly checks and runs generated TypeScript.
It proves lazy Option fallback and one subject evaluation; ordered record reads
and own optional fields; and resource cleanup across success, acquisition/use/
release failures, defects and interruption. Existing runtime gates continue to
exercise the explicit forms.

### MS7: adoption, documentation and checks

The 20 `.eff` files in `fixtures/examples/` and `fixtures/applications/*/` go
from 21,278 to 21,089 non-whitespace characters: 189 fewer (0.9%). This uses the
TE corpus method: remove whitespace and count characters, comparing `c248489`
with the finished tree. Exported contracts remain explicit. The largest changes
are portable storage 3,859 → 3,788, stream processor 1,192 → 1,154, payment
760 → 730, and portable feature 2,447 → 2,421.

Updated API migration examples, rules, concepts, development guide and status.
The sibling website has draft 0.63, the compiler IR model, version-4 manual
fixture, a checked concise-syntax figure, matching canonical panels and changed
downloadable examples. Website edits belong to their separate repository commit.

Verification on 2026-10-24:

- `deno task check`: formatting, lint, type checking, 2,098 fast tests and 207
  slow tests pass on Deno 2.9.8.
- The slow application harness independently validates, strictly checks and runs
  all five witnesses in temporary directories, including their documented
  failure/cancellation/cleanup cases. HTTP/SQLite and publisher parity integration
  suites pass too.
- Changed website sources and the new figure build with `--validate --tsc` in
  temporary directories. Worker and stream downloads also build independently.
- Website `deno task typecheck`: 55 strict units, zero missing Effect-TS panels.
  `deno task test`: 11 tests pass. Refreshed stale asset stamps with `deno task stamp`.
- A real isolated VS Code development host reports zero errors for all four new
  forms, supplies resource hover, and finds the declaration plus two references.
  [Editor screenshot](../../evidence/ms-concise-editor.png).

### Performance

Same machine, Deno 2.9.8, quick M1/M3/M4 profile. Raw samples:
[baseline](../../ms-baseline-bench.json) and [final](../../ms-final-bench.json).

| Large-input diagnostics p90 | Baseline ms | Final ms |
| --- | ---: | ---: |
| Body edit | 14.14 | 16.33 |
| Header edit | 63.80 | 81.71 |
| Alias edit | 58.71 | 68.11 |
| Mode flip | 55.00 | 60.61 |

Every large-input row remains below the 100 ms budget. These quick sequential
runs do not establish a speed improvement. M3 retains zero lowerings and emits
for diagnostics-only edits, with the same parse/check counts as baseline.

At 200 M4 edits, last sampled RSS in the two sessions is 194.8/194.6 MiB before
and 198.6/191.2 MiB after. With save output enabled it is 276.9/301.7 MiB before
and 274.8/237.8 MiB after. The type table ends at 176 nodes in both runs.
Finite samples and garbage collection do not establish bounded memory.

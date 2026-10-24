# Terse source

Date: 2026-10-24. Baseline: `7659f58`. TE identifies this plan's implementation units.

The user accepted a compiler or syntax change that makes source more terse and elegant without an application blocker.
Such a change must keep source easy to read, keep closed contracts on exports, and keep explicit exported contracts.
The user adopted decisions D1 (annotate exports, infer locals), D2 (named error sets), D3 (expected types into builtin callbacks), and D5 (union join of nominal records, and effect inference for recursive local functions).
The user also adopted D4 (inlay hints for inferred contracts), which TE7 implements.

## Evidence

The measurements use non-whitespace characters on temporary copies of the fixtures. The repository was not changed.

- The 20 `.eff` files of the examples and the five applications have 23,872 characters. `fails` clauses are 10.3%, `uses` clauses 5.4%, and import lines 8.5%.
- Second and later copies of identical `fails` lists total 1,002 characters (4.2%). Repeated `uses` lists add 373.
- All 24 non-exported helpers in the fixtures carry a contract, although the compiler infers them today.
- Without the inferred annotations, `fixtures/examples/pay.eff` goes from 871 to 760. `stream-processor/processor.eff` goes from 1753 to 1228 and passes its 13 runtime cases. `scheduled-worker/worker.eff` goes from 1261 to 1151 and passes its 10 runtime cases.
- A named error set saves 9.7% on the feature, publisher, and grants modules of the portable publisher, after the cost of the alias.

## TE1: named error sets (D2)

Accept a type alias in a `fails` clause when its unfolded body is an error or a union of errors.
Apply the rule in function contracts, function types, service methods, and `.effi` files. An exported alias works across modules.

```
type PayFailure = OrderNotFound | PaymentDeclined

export const pay = (id: OrderId): Order
  fails PayFailure
  uses Orders | Payments.charge => ...
```

Today this gives `unknown-name/004: PayFailure is a type, not an error`.
An alias with a member that is not an error gets a diagnostic that names the member.
The checker expands the alias to error identities. The failure sets in the IR stay sets of errors, so the IR and the independent validator do not change.
`errorRef` in `src/core/resolve.ts` has three callers: the `fails` clause, the `catch` handler, and `ctorRef` for patterns. Only the `fails` path accepts an alias. A `catch` arm and a pattern still name one error.
`failures()` in `src/core/check.ts` flattens an alias of aliases through the type table. It reports a mixed member with a new code in `src/core/diagnostics.ts`.
The emitter already writes `Schema.Union([...])` for such an alias, and the build passes `--validate --tsc`. Function types print the expanded identities. Hover, the contract quick fix, and the module interface read the expanded sets. None of them changes.

Files: `src/core/resolve.ts` (the `fails` path of `errorRef`), `src/core/check.ts` (`failures`), the function-type and service-method paths, diagnostics, and tests.
Verification: local and imported aliases, nested aliases, a mixed alias, an alias in a function type and a service method, hover text, and strict generated TypeScript.

## TE2: open contracts on local functions, and recursive effect inference (D5)

On every non-exported function, each omitted `fails` or `uses` clause is inferred. A written clause closes its own set. A result annotation alone no longer closes the effect sets.
The rule covers module-level local functions and inline arrows. `checkBody` in `src/core/check_expr.ts` serves both.
Exported functions do not change: an omitted clause means an empty set.
A function type in a binding annotation, such as `const f: (x: T) => U = ...`, stays closed. It is a type, and a type states its sets.
This changes the specification sentence "A result annotation creates a closed failure and requirement contract". TE6 updates it.
A recursive local function still needs parameter and result annotations. Its effect sets come from a fixed-point pass over its strongly connected component. Reuse the structure of the existing mode solver (`solveModeGroup` in `src/core/check_project.ts`).

```
const cycle = (policy: Policy, completed: Int, last: Option<Int>): Report =>
  ...
```

Today this gives `failure-contract/001` and `requirement-contract/001`, because the result annotation closes the contract.
Effect sets only grow, so the fixed point exists. The bound and its diagnostic reuse `execution-mode/004`, the round cap of the mode solver.

The solver must carry effect sets, not only modes. Today `values(view)` in `src/core/check_project.ts` returns `signatureType()` for an explicit contract, and that reads the static `signature.failures`. `environment(view)` takes only a `ModeLookup`. Replace that lookup with one that gives the mode and the solved failure and requirement sets of each open signature. Solve modes and sets together in one loop. A non-recursive open local publishes its solved sets, as an inferred local does today. Callers read the solved sets. `isPendingMode` and `executionOf` in `src/core/check.ts` use the same state.

Replace the `contract: "explicit" | "inferred"` field in `src/core/check.ts`, `src/core/tables.ts`, and `src/core/ir.ts` with one written flag for each part: `{ result: boolean, fails: boolean, uses: boolean }`. The serializer, the IR goldens (`fixtures/ir/`), and the validator follow. The validator checks a written set as a closed bound and an inferred set as equal to the body set.
`src/core/lower.ts` combines the written result IR (`signature.result.ir`) with the solved sets. `toIrFunction` loses source order and schema make inputs, so it is used only when the result is not written. `src/core/emit/decls.ts` writes the TypeScript return annotation whenever the result is written, with the sets from the function type.
`execution-mode/003` fires only when a recursive local has no written result or parameter types. Update the diagnostic descriptions that say "with a result annotation" in `src/core/diagnostics.ts`.

Existing error fixtures encode the old rule. `fixtures/errors/failure-contract-extra-failure.eff` (`broken`) and `requirement-contract-extra-requirement.eff` (`bad`) stop failing. Export those functions to keep their purpose. `execution-mode-round-cap.eff` becomes a chain of open sets; keep it as the bound test.

Files: `src/core/check.ts`, `src/core/check_project.ts`, `src/core/check_expr.ts`, `src/core/ir.ts`, `src/core/tables.ts`, `src/core/serialize.ts`, `src/core/lower.ts`, `src/core/emit/decls.ts`, `src/core/validate/`, diagnostics, fixtures, and tests.
Verification: a local with a result annotation and inferred effects, a local with one written clause, an inline arrow with a result annotation, a `catch` inside an open local (the inferred set shrinks), a short mutual recursion where the effect enters at the far end (assert both solved sets and the emitted header), recursion through a callback, the iteration bound, exports unchanged, validator mutations for a too-small inferred set and a too-large written set, and the three application gates.

## TE3: union join of nominal records (D5)

When branch results have no expected type, and every branch type is a nominal record or an error, join them to their union.
Keep the current rule for all other types: a structural record join still needs an annotation. Keep `type-mismatch/009` for them.

```
const toArticle = (stored: StoredArticle) =>
  if (stored.kind === "draft") { Draft({ ... }) } else { Published({ ... }) }
```

Today this gives `type-mismatch/009: this branch has type Published, which has no common type with Draft from the earlier branches`.
The joined type is the same union that `match` uses for its nominal domain. Use the predicate of `domainOf` in `src/core/patterns.ts` (`table.dataRecordOf(id) !== undefined || isErrorId(id)`), so that the join and `match` agree. Build the union with `table.union` in `src/core/types.ts`.
Do not confuse an Effektive error type with the poison type that `this.isError` tests. A poison branch keeps today's behavior.
`joinResults` serves `if`, `match`, and `try`. The rule covers all three. Hover shows the union. An export boundary still checks the declared result.

Files: `src/core/check_expr.ts` (`joinResults`) and tests.
Verification: two and three nominal records, a nominal record with an error, a structural record that still fails, a join that meets an expected type, `match` over the inferred union, and a type-checked emitted file with an inferred union result.

## TE4: expected types into builtin callbacks (D3)

Check builtin arguments from left to right, and give a later callback the expected type that an earlier argument determines.
Two cases are in scope:

- `runStream(stream, sinkForEach((batch) => ...))`: the sink callback gets the element type of the stream. Today this gives `type-mismatch/011`. The `sinkForEach` message says that it needs an annotated input, so this changes a chosen rule. A sink that is bound to a name before its use keeps the annotation.
- `layer(Service, () => ({ method: (value) => ... }))`: the final record of the acquire body gets the method shapes of the service. Today this gives `type-mismatch/011` five times in the portable publisher.

The mechanism exists. `runStreamCall` in `src/core/check_builtins/stream.ts` passes `takeSinkHint` as an expected type, and the `takeSink` row reads it. Give the `sinkForEach` row the expected type too. Define one hint shape: the input is the stream element, and the result follows each sink builtin. Add a guard like `resultsInTakeSink`.
`layerCall` in `src/core/check_builtins/layer.ts` calls `argInfo(args[1])` without an expected type. Pass a zero-parameter function type whose result is the method record of the service. It flows through `contextOf`, `block`, and `recordConstruction` to the field lambdas.
Keep the layer-specific message "`layer` method X does not fit its service contract" for a wrong shape if the change allows it. Otherwise accept the record-field code. Add an error fixture for a wrong-shape layer, because none exists today.

Files: `src/core/check_builtins/stream.ts`, `src/core/check_builtins/layer.ts`, the shared callback helpers, diagnostics, and tests.
Verification: inline and bound sinks, sink transforms, a layer with inferred method parameters, a wrong-shape layer fixture, and the annotated forms unchanged.

## TE5: annotate exports, infer locals (D1)

Remove annotations that the compiler infers from local helpers, record-field lambdas, callbacks, and local bindings. Keep every exported contract.
Use the TE1 to TE4 forms where they apply. Remove the imports that become unused.
Scope: `fixtures/examples/`, `fixtures/applications/*/`, the golden outputs (`deno task golden:update`), and examples in `docs/`.
Keep fixtures that test an annotation on purpose, such as error fixtures and contract tests.
After the change, rebuild each application with `--validate --tsc` and run its runtime tests.

The sibling website (`../effektive/public/`) gets the same cleanup in its examples and specification, in a separate commit in that repository.
The blog draft `../blogo/content/posts/effektive-intro.md` gets the new numbers and forms, in a separate commit in that repository.

## TE6: acceptance and documentation

Update `docs/language-rules.md`, `CONCEPTS.md` if a term changes, `docs/status.md`, and the specification.
Measure the corpus again with the same method as the evidence section, and record the before and after numbers in this plan.
Run focused tests before the full gate. Run `deno task check` before each implementation commit.

### TE6 results

Measured on 2026-10-24 with `cat fixtures/examples/*.eff fixtures/applications/*/*.eff | tr -d ' \n\t' | wc -c`.
The corpus of 20 `.eff` files went from 23,949 to 21,278 non-whitespace characters (11.2% less).
A regex count of `fails` and `uses` clauses (`grep -oE '(fails|uses) [A-Za-z.| ]+'`) went from 3,748 to 1,720 characters. The regex reads names only, so this count is approximate.
The largest file changes: `stream-processor/processor.eff` 1,753 to 1,192, `portable-publisher/feature.eff` 3,174 to 2,447, `portable-publisher/grants.eff` 1,065 to 747, `portable-publisher/publisher.eff` 1,451 to 1,083, `scheduled-worker/worker.eff` 1,261 to 1,061, and `examples/pay.eff` 871 to 760.
All five applications build with `--validate --tsc` and pass their runtime tests. `deno task check` passes: 2,073 fast and 203 slow tests.

## TE7: inlay hints for inferred contracts (D4)

Show the inferred `fails` and `uses` of an unannotated local function as an inlay hint in the language server and the VS Code client.
The hint text uses the same contract printer as hover. TE7 comes after TE2, because TE2 defines which local contracts are inferred.

## Order

TE2 comes first and alone, because it changes the IR shape, the serializer, and the IR goldens.
After TE2, TE1, TE3, and TE4 can run in parallel worktrees. They share `src/core/check.ts`, `src/core/check_expr.ts`, `src/core/diagnostics.ts`, and `fixtures/errors/`, but in different regions. Merge them one at a time with a rebase.
TE7 follows TE2. TE5 comes after TE1 to TE4 and after the TE2 application gates pass. TE6 comes last.
The plan was validated on 2026-10-24. The validation found two blocking items in TE2 (the scope of open contracts, and sets in the solver). This text resolves both.

## Limits

Inferred local contracts move information from the source to the tools. Hover and TE7 restore it in the editor, not in a plain text view.
A named error set moves the member list away from the use site.
A union join can widen an inferred local type when someone adds a branch. The export boundary still catches the change.

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
A `catch` arm still names one error. Hover shows the expanded members. Contract quick fixes keep adding single errors.
Check what the emitter writes for a union-of-errors alias today. The generated TypeScript must type-check.

Files: `src/core/resolve.ts` (`errorRef`), `src/core/check.ts` (`failures`), the function-type and service-method paths, diagnostics, editor hover, and tests.
Verification: local and imported aliases, nested aliases, a mixed alias, an alias in a function type and a service method, hover text, and strict generated TypeScript.

## TE2: open contracts on local functions, and recursive effect inference (D5)

On a non-exported function, each omitted `fails` or `uses` clause is inferred. A written clause closes its own set. A result annotation alone no longer closes the effect sets.
Exported functions do not change: an omitted clause means an empty set.
A recursive local function still needs parameter and result annotations. Its effect sets come from a fixed-point pass over its strongly connected component. Reuse the structure of the existing mode solver (`solveModeGroup` in `src/core/check_project.ts`).

```
const cycle = (policy: Policy, completed: Int, last: Option<Int>): Report =>
  ...
```

Today this gives `failure-contract/001` and `requirement-contract/001`, because the result annotation closes the contract.
Effect sets only grow, so the fixed point exists. Bound the iterations like the mode solver does, and report a diagnostic if the bound is reached.
Decide how the IR records a partly inferred contract. The `contract` field is `"explicit" | "inferred"` in `ir.ts` and `tables.ts`, and `lower.ts` and the validator read it. Prefer one recorded state for each set over a third contract kind, if the validator stays simple.

Files: `src/core/check.ts`, `src/core/check_project.ts`, `src/core/check_expr.ts`, `src/core/ir.ts`, `src/core/tables.ts`, `src/core/lower.ts`, the independent validator, diagnostics, and tests.
Verification: a local with a result annotation and inferred effects, a local with one written clause, mutual recursion, recursion through a callback, the iteration bound, exports unchanged, validator mutations, and the three application gates.

## TE3: union join of nominal records (D5)

When branch results have no expected type, and every branch type is a nominal record or an error, join them to their union.
Keep the current rule for all other types: a structural record join still needs an annotation. Keep `type-mismatch/009` for them.

```
const toArticle = (stored: StoredArticle) =>
  if (stored.kind === "draft") { Draft({ ... }) } else { Published({ ... }) }
```

Today this gives `type-mismatch/009: this branch has type Published, which has no common type with Draft from the earlier branches`.
The joined type is the same union that `match` uses for its nominal domain. Hover shows the union. An export boundary still checks the declared result.

Files: `src/core/check_expr.ts` (`joinResults`), the type table if a union constructor is needed, and tests.
Verification: two and three nominal records, a nominal record with an error, a structural record that still fails, a join that meets an expected type, and `match` over the inferred union.

## TE4: expected types into builtin callbacks (D3)

Check builtin arguments from left to right, and give a later callback the expected type that an earlier argument determines.
Two cases are in scope:

- `runStream(stream, sinkForEach((batch) => ...))`: the sink callback gets the element type of the stream. Today this gives `type-mismatch/011`. The `sinkForEach` message says that it needs an annotated input, so this changes a chosen rule. A sink that is bound to a name before its use keeps the annotation.
- `layer(Service, () => ({ method: (value) => ... }))`: the final record of the acquire body gets the method shapes of the service. Today this gives `type-mismatch/011` five times in the portable publisher.

Files: `src/core/check_builtins/stream.ts`, `src/core/check_builtins/layer.ts`, the shared callback helpers, diagnostics, and tests.
Verification: inline and bound sinks, sink transforms, a layer with inferred method parameters, a layer method with a wrong shape, and the annotated forms unchanged.

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

## TE7: inlay hints for inferred contracts (D4)

Show the inferred `fails` and `uses` of an unannotated local function as an inlay hint in the language server and the VS Code client.
The hint text uses the same contract printer as hover. TE7 comes after TE2, because TE2 defines which local contracts are inferred.

## Order

TE1 and TE4 are independent. TE2 comes before TE3, because both change the checker's function and branch paths.
TE5 comes after TE1 to TE4, so that the cleanup can use the new forms. TE6 comes last.

## Limits

Inferred local contracts move information from the source to the tools. Hover and TE7 restore it in the editor, not in a plain text view.
A named error set moves the member list away from the use site.
A union join can widen an inferred local type when someone adds a branch. The export boundary still catches the change.

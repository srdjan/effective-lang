---
title: Pipeline stage effect sets must come from the checker, not from a second copy in lowering
date: 2026-10-22
category: logic-errors
module: src/core/lower.ts and src/core/check_expr.ts
problem_type: logic_error
component: type_checker
symptoms:
  - "`x |> scoped` or `x |> forkScoped` with an effectful left value reports 0 checker diagnostics, but independent validation reports validation/003 and validation/004"
  - "The validator message shows a stage requirement set that is empty where the checker expects the Effect value's requirements, and execution pure where it expects effect"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [checker, lowering, validator, pipeline, effect-sets, scoped, fork-scoped, single-owner]
---

# Pipeline stage effect sets must come from the checker, not from a second copy in lowering

## Problem

Lowering rewrites `x |> s(a)` into a block that binds `x` first. Then the block calls `s` with a pure reference. So the IR call of the stage must carry the stage's own effect set, without the effects of `x`. Lowering computed that set with its own copy of the checker's rules, one switch arm for each stage kind. The copy had no arm for `scoped` and `forkScoped`. So a valid program lowered to IR that the independent validator rejected.

## Symptoms

The reproduction, on revision `98df0ef`:

```effective
export service Child { run(): void; wait(): void; alive(): Bool }
type Bool = boolean
const makeJob = (): Effect<Bool, never, Child.alive> uses Child.run => {
  Child.run()
  defer(() => Child.alive())
}
export const main = (): Bool uses Child.run | Child.alive => makeJob() |> scoped
export const direct = (): Bool uses Child.run | Child.alive => scoped(makeJob())
```

- The checker reported 0 diagnostics, and lowering succeeded.
- Validation reported three diagnostics on `main`, and none on `direct`:
  `validation/003 declarations[3].body.effects.requirements: expected [cap:main#Child.alive, cap:main#Child.run], recorded [cap:main#Child.run]`,
  `validation/003 declarations[3].body.result.effects.requirements: expected [cap:main#Child.alive], recorded []`, and
  `validation/004 declarations[3].body.result.execution: expected effect, recorded pure`.

## What Didn't Work

- The full gate passed. The existing stage test in `tests/builtin_stage_slow_test.ts` piped a `defer` result into `scoped`. That is a quiet left value, and lowering used the checker's set for a quiet left value. So no test reached the second copy for `scoped`.
- The copy ended in an exhaustive `switch` with a `never` default. That check made every fact kind appear as a case label. But 79 of those labels, `scoped` and `fork-scoped` among them, fell through to a generic "argument sets only" result. So exhaustiveness proved that each kind had a label, not that each kind had the right rule.
- Commit `6b1759f` (2026-10-20) replaced a silent `default: break` with that `never` check, and it added the two kinds to the fall-through list. An earlier audit had named that `default` as one of 14 silent fallbacks. The same audit asked for a pipeline test for each of six arm groups that no test ran. Neither step compared the arms with the checker handlers (session history).
- The defect was not found by a test. A plan check compared each arm of the lowering copy with the checker handler for the same kind. That comparison found the two missing arms. Then the coordinator reproduced the defect with the program above.

## Solution

The checker now computes the stage set, where the rule already lives. The checker's `pipe` method is in `src/core/check_expr.ts`. When the left value is not quiet, `pipe` calls the stage handler with a quiet left value of the same type. Then `pipe` records the returned set under the stage node:

```ts
const quiet = isQuiet(leftInfo);
const pre: NodeInfo = quiet ? leftInfo : { type: leftInfo.type, ...PURE_EFFECTS };
// ... invoke the stage handler with `pre` as its first argument ...
if (quiet) return this.finish(node, q.type, q);
this.body.stageSets.set(stage, { failures: q.failures, requirements: q.requirements, mode: q.mode });
const combined = combine([leftInfo, q]);
this.finish(stage, q.type, combined);
return this.finish(node, q.type, combined);
```

`BodyTable` (`src/core/tables.ts`) has the new field `stageSets`. Lowering's `invoke` (`src/core/lower.ts`) uses `stageSets.get(node)` for the call annotation when an entry exists. `stage()` requires an entry when the left value is not quiet. The function `stageEffects` (227 lines) and the `override` parameter of `invoke` were deleted. `isQuiet` moved to `tables.ts`, so the checker and lowering use one test for "quiet". The independent validator did not change, because it must share no code with the checker.

The change is on local `main`: `ee77782` moved the rule, and `67333cb` shared `isQuiet`.

## Why This Works

A stage handler builds its result as `combine` over the sets of its arguments and its own invocation set. `combine` (`src/core/tables.ts`) is a sorted union. So for a handler that includes its first argument, `handler(real left) = combine([left, handler(quiet left)])`. The quiet call gives exactly the set that the IR call needs. The combination of that set with the left value gives the same node info as before. Each stage rule now exists only in its checker handler, so no second copy can drift from it.

The method has one precondition: no stage handler may read the effect sets or the mode of its piped first argument. A handler that reads them would see a quiet value during the stage-set call. Before this change, a search of `src/core/check_expr.ts` and `src/core/check_builtins/` found no such read. Each `.pre` use was a presence test, and each `isPureInfo` call read the second argument.

`takeSink` and `layer` leave their first argument's set out of their result, and the `schema()` identity call probably does too. Each of the three rejects a pipeline left value with a diagnostic, so lowering never runs for them. For `schema()`, `tests/lower_stage_effects_test.ts` checks the rejection. Only the hover info of that rejected stage can change.

## Prevention

- Do not compute an effect set, a type, or a mode in lowering. Lowering reads the checker's tables. When lowering moves a value, the checker records the set that the moved form needs, as `stageSets` does.
- A new stage handler may need the effect sets or the mode of its first argument. Then keep the stage-set call correct. Compute that decision from the type, or record it as a fact before the quiet call.
- Test each stage kind with an effectful left value and with independent validation, as `tests/lower_stage_effects_test.ts` does. A quiet left value does not reach the stage-set path.
- An exhaustive switch shows that each kind has a case label. It does not show that the case holds the right rule. When two stages keep parallel rules, compare them arm by arm, or remove one copy.
- To verify a change like this with `deno task behavior:capture`, hold the test set constant on both sides. Some tests have an expected result that the fix changes, such as the `scoped` case that first pinned the wrong diagnostics. Remove each such test from both sides. Keep the other new tests on both sides. See [the capture guidance](../workflow-issues/behavior-capture-hold-tests-constant.md).

## Related Issues

- [The checker must not take a builtin result type from the expected hint](checker-result-type-from-expected-hint.md): the checker and the validator also disagreed there about a valid program.
- [Hold the test set constant to read behavior:capture](../workflow-issues/behavior-capture-hold-tests-constant.md): the comparison method used here.
- The plan and its evidence: `docs/plans/2026-10-22-decoupling-review.md`, items IC1a and IC1b.

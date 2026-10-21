# Changing a builtin

Select a builtin change only for a demonstrated application blocker or an
explicitly accepted target. First check existing source compositions against
the [application acceptance rule](plans/2026-10-19-application-acceptance-rule.md).
This checklist identifies the implementation seams; it selects no new features.

## Trace the contract before editing

Write down argument counts, direct and pipeline forms, contextual types, result
type, invocation mode, failures, requirements and resource lifetime. Distinguish
effects of evaluating an argument from effects deferred inside its callback.
Record diagnostic codes, text, spans and check order for rejected inputs.

Use an existing IR operation when it expresses the contract. `src/core/ir.ts`
is the canonical copy from the sibling repository; a new IR shape needs its own
accepted change. Payload-free checker facts are not automatically redundant:
confirm the resolver identity and specialization that lowering needs.

## Follow each affected stage

| Stage | Inspect | Preserve or verify |
| --- | --- | --- |
| Recognition | `src/core/resolve.ts`: `PRELUDE`, derived prelude sets and shadowing flag. Type syntax also involves `TYPE_WORDS` in `syntax.ts`, builtin type names in `resolve.ts` and `TypeLowerer` in `check.ts`. | Legal names, local shadowing and existing grammar. Ordinary builtin calls need no parser change. |
| Source checking | `src/core/check_expr.ts`: `PRELUDE_PROLOGUES`, `PRELUDE_HANDLERS` and the family handler. The general Schedule handlers live in `src/core/check_builtins/schedule.ts`, using the narrow `BuiltinContext` in `context.ts`. Schema operations also use `SCHEMA_BUILTINS` and `SCHEMA_HANDLERS`. | Arity and pipeline rejection order, expected types, sorted effects, callback invocation and lifetime rules. New table keys must remain exhaustive. |
| Checking facts | `src/core/tables.ts`: `NodeInfo`, `NodeFact` and callback/pattern facts. | The checked type, mode and sets, plus the facts lowering cannot recover from syntax alone. |
| Lowering | `src/core/lower.ts`: fact dispatch, structural builders and builtin specialization. | Operands, deferred callbacks, specialization identity, source spans and pipeline effects after moving the left value. |
| Independent validation | `src/core/validate/expr.ts`, `world.ts` and `typing.ts`. | Independently recompute types, effects and modes. Reject forged payloads with the existing diagnostic code, path and message. Never import checker policy or handler code. |
| Emission | `src/core/emit/shape.ts`, `calls.ts`, `expr.ts`, `types.ts` and `scope.ts`, as applicable. | Evaluated and deferred children, free variables, source maps, helper-name collisions, target imports and strict TypeScript types. |
| User-facing queries and docs | `docs/language-rules.md`, `docs/api.md`, editor queries and the sibling website/spec when source forms or status change. | Contracts and completion/classification derived from the current prelude and checked types. Update the owning reference rather than adding another feature list. |

For example, `getRef` is recognized in `resolve.ts`; its prologue records a
`get-ref` fact and effect mode, and its handler checks the Ref element type.
`tables.ts` declares that fact. `lower.ts` builds its operand, the independent
validator recomputes the element and effects, `emit/shape.ts` records its child,
and `emit/calls.ts` selects `Ref.get`. Arity and wrong-input regressions live in
`tests/builtin_arity_test.ts` and `tests/builtin_report_sites_test.ts`. This trace
is a worked example, not a fixed count of sites for every builtin.

## Verify the observable behavior

- Exercise valid calls and rejected arity/type/pipeline forms through public
  checking and lowering entries. Cover callback effects, services, errors,
  contextual types and lifetime cases that the contract uses.
- For new validation behavior, forge the relevant IR payload and assert the
  diagnostic code, path and message. Keep checker and validator implementations
  independent.
- For emitted behavior, compile with independent validation and strict target
  checking, then execute success, typed failure, cancellation and cleanup cases
  where relevant. Subprocess tests belong in `*_slow_test.ts`.
- Run `deno task check` before each commit. A behavior-preserving refactor also
  runs `deno task behavior:capture <base> <head>` with zero missing records.
  Hold the test inputs constant when judging parity; see the
  [capture guidance](solutions/workflow-issues/behavior-capture-hold-tests-constant.md).
- Inspect expected output manually. Do not run `golden:update` or
  `validate:update` to accept a refactor difference. For an intentional behavior
  change, explain the exact expected differences instead of claiming parity.

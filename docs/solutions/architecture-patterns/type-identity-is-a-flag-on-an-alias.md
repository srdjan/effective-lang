---
title: Type identity is a flag on an alias, and assignability must widen before it separates names
date: 2026-10-24
category: architecture-patterns
module: src/core/types.ts, src/core/check.ts, src/core/check_expr.ts, and src/core/validate/typing.ts
problem_type: architecture_pattern
component: type_checker
severity: high
applies_when:
  - "You change how a `type` declaration gets identity by name, or add a new kind of named type"
  - "You reorder or add a step in `TypeTable.assignable`"
  - "You add a rule that lets an unnamed value fit a named type"
  - "You compare two types for equality in the IR validator"
tags: [type-identity, transparent-alias, tagged-record, assignability, widening, type-table, validator, nominal]
---

# Type identity is a flag on an alias, and assignability must widen before it separates names

## Context

The TI plan (`docs/archive/plans/2026-10-24-type-identity.md`, commits ea9dce2 to b5c7b48) removed the `nominal` keyword. A plain `type` declaration now has identity by name, unless its body is a union with a non-literal member or a bare name. CONCEPTS.md defines the terms: type identity, transparent alias, tagged record, and sealed type.

Before this change, the checker kept a nominal type in separate tables (`brands` for primitives, `dataRecords` for records). Each structural query had to know about those kinds. The TI work found four rules that the final code does not explain by itself. If a later change breaks one of these rules, the checker accepts wrong programs or rejects correct ones. No test failure points to the cause.

## Guidance

**1. Store identity as a flag on an ordinary alias.** `TypeTable` keeps the body in `aliases` and marks the id in the `identities` set (`src/core/types.ts:353`). A tagged record is also in the `tagged` set (`src/core/types.ts:355`). `markIdentity` and `markTagged` (`src/core/types.ts:762`, `:767`) set the flags. `unfold` still follows every alias (`src/core/types.ts:1003`). `unfoldTransparent` stops at an identity (`src/core/types.ts:1016`). Use `unfold` for structural questions: field reads, array builtins, and pattern shapes. Use `unfoldTransparent` only where a name matters: operator classes, the tagged target in `recordTarget` (`src/core/check_expr.ts:1523`), and the tagged domain of a `match`. `assignable` inlines the same stop rule (`src/core/types.ts:1428`, `:1436`). With a separate kind, each structural query would need a new case for that kind.

**2. In assignability, widen an identity to its body before the "never mix" step.** The order in `TypeTable.assignable` (`src/core/types.ts:1426-1497`) is:

1. A transparent alias unfolds, on the source side and on the target side.
2. An identity source widens to its body. The recursive call passes `adopt=false` (`src/core/types.ts:1445-1451`).
3. Two different identities never mix (`src/core/types.ts:1452-1457`).
4. A value with `adopt=false` takes no name at that level (`src/core/types.ts:1458-1462`).
5. The old brand step runs (`src/core/types.ts:1463-1473`). The validator copy also reads `data` (`src/core/validate/typing.ts:287`).
6. An unnamed value fits an untagged identity whose body it fits, only with `adopt=true` (`src/core/types.ts:1474-1485`).
7. Unions come last.

Step 2 must run before step 3. A type such as `type UserId = Text` has a body that is itself an identity. If step 3 runs first, `UserId` cannot widen to `Text`, because two different identities never mix. Step 4 needs `adopt=false`. Without it, a widened value takes a second name. For example, a `Cents` value would widen to `int` and then fit `Score` as an unnamed `int`. The `ownsSealed` guard on steps 2 and 6 keeps a sealed type closed outside its module.

**3. Keep tagged records out of the unnamed-value rule.** Step 6 requires `!this.tagged.has(tn.id)` and `!this.opaque.has(tn.id)`. A tagged record value carries a runtime `_tag`. If an inline record literal fits a tagged record by assignability, the program gets a value with the tagged type and no `_tag` (NI24 in the ideation document). Implicit construction happens in `recordConstruction` instead (`src/core/check_expr.ts:1600`). A record literal at exactly the expected tagged type gets a `data-construction` fact (`src/core/check_expr.ts:1709`), and the emitter prints `Name.make(...)`. A computed record needs `Name(value)`.

**4. Give the validator equality a name signature.** The IR validator `same()` (`src/core/validate/typing.ts:522`) once meant two-way assignability. With type identity, `int` and an identity over `int` fit each other in both directions, but they are different types. `same()` now also compares `nameSignature` (`src/core/validate/typing.ts:497`). Without it, `unionOf` merges `Cents` and `int` into one member, and the validator accepts IR that the checker did not produce. Known limit, accepted: the signature is a sorted set, so `[Cents, int]` and `[int, Cents]` count as equal.

## Why This Matters

Each rule fails without a clear symptom. A wrong step order makes body chains such as `UserId = Text` fail with `type-mismatch/003` at correct call sites. A missing `adopt=false` lets a value change its name, which removes the main guarantee of the feature. A tagged record without `_tag` builds, type-checks, and then fails at runtime in a `match` or a decode. A weak `same()` makes the validator agree with a wrong checker, so the second check stops working.

The flag design also kept the change small: structural queries that call `unfold` needed no new case. The session history found one earlier constraint: a `try` whose `catch` arm returns a different tagged record joins to a union (TE3, merged as commit `8b98961`). The flag design kept that join (session history).

## When to Apply

- When you add a named-type kind, first check whether a flag on an alias is enough.
- When you edit `TypeTable.assignable`, keep the step order above, and run `tests/types_test.ts`. The tests at lines 465 and 491 cover most of these rules. No test asserts the two-step widening from `UserId` to `string`.
- When you add a coercion from an unnamed value, exclude tagged and opaque targets, and put construction in the checker, not in assignability.
- When the validator compares types, decide whether names matter. If they do, use `same()`, not two-way `assignable`.

## Examples

These are the cases that the order protects. `tests/types_test.ts:465` and `:491` test most of them with ids `A`, `B`, and `USER`. A probe on a real `TypeTable` gave the results below:

```
type Text = string
type UserId = Text        // identity; body is the identity Text
type Cents = int
type Score = int

UserId -> Text            fits: step 2 widens one step
UserId -> string          fits: step 2 widens twice
Cents  -> Score           rejected: step 3
Cents  -> int -> Score    rejected: step 4, adopt=false after widening
42     -> Cents           fits: step 6, unnamed value
{ x: 1 } -> Circle        not by assignability; recordConstruction builds Circle.make
```

## Related

- `docs/solutions/logic-errors/union-member-order-must-not-depend-on-intern-order.md`: the same table and `recordTarget`. Its "record brand" wording now means a tagged record.
- `docs/solutions/logic-errors/emitted-fields-must-use-own-presence.md`: emitter construction of tagged records. Its "nominal record" wording is older than this change.
- `docs/solutions/logic-errors/checker-result-type-from-expected-hint.md`: another case where the checker and the validator must agree on typing.
- `docs/archive/plans/2026-10-24-implicit-nominal-ideation.md` (NI) and `docs/archive/plans/2026-10-24-type-identity.md` (TI).

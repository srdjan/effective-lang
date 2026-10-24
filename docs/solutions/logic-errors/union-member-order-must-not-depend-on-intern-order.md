---
title: Union member order came from the intern index, so edit history changed what the checker accepted
date: 2026-10-21
category: logic-errors
module: src/core/types.ts and src/core/check_expr.ts
problem_type: logic_error
component: type_checker
symptoms:
  - "The same program gives type-mismatch/003 for one order of union members and 0 diagnostics for the swapped order"
  - "A Program that first checked an unrelated revision accepts a program that a fresh build rejects, so watch and the language server can disagree with build"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [union, type-table, typeref, intern-order, determinism, incremental, record-literal, toir, lowered-ir]
---

# Union member order came from the intern index, so edit history changed what the checker accepted

## Problem

`TypeTable.union()` in `src/core/types.ts` sorted union members by `TypeRef`, the intern index. `Program` in `src/core/db.ts` keeps one `TypeTable` across revisions (`src/core/db.ts:266`). So the member order of a union depended on which types earlier edits had interned. `recordTarget` in `src/core/check_expr.ts` took the first fitting member. The same source could pass or fail depending on edit history.

## Symptoms

This program gave type-mismatch/003, "the field `v` has type N, but S is expected":

```effektive
type N = int; type S = string
type U = { k: S[], v: S } | { k: N[], v: N }
export const f = (x: N): U => ({ k: [], v: x })
```

The swapped union `{ k: N[], v: N } | { k: S[], v: S }` gave 0 diagnostics.

A `Program` that first received `type Q = { k: N[], v: N }` accepted the program. A fresh build of the same final source rejected it.

A fuzz of 55,230 mutants found 27 differences between incremental and fresh builds. All 27 were in diagnostic text. Emitted code, source maps, and interface hashes were equal. `toIr` sorts union members by `canonicalJson`, so the IR did not show the intern order.

## What Didn't Work

- The rule already existed. The header of `src/core/types.ts` (line 7) says that ids depend on the order of interning, so no output may depend on a raw id. The serialization functions followed it, but `union()` did not. A reader took "output" to mean serialized IR, while member order also fed a checker choice and diagnostic text (session history).
- A stable sort alone fixed the N/S example above in both orders, but it broke a program that passed before: `type A = string`, `type Z = int`, `type U = { k: Z[], v: Z } | { k: A[], v: A }`, and `export const f = (x: Z): U => ({ k: [], v: x })` failed until the narrowing in `recordTarget` landed. The canonical order only moved the wrong first choice to another program. The two changes therefore went into one commit.
- Comparing emitted code, source maps, and interface hashes found nothing. Those outputs hide the defect. Only the diagnostic text showed it.

## Solution

Commit d3a1633 on local main has two parts.

First, `union()` sorts by the canonical JSON of the IR of each member. It uses the `TypeRef` number only as a tie-break (`src/core/types.ts:663-680`). `irKey` memoizes the key for each `TypeRef` (`src/core/types.ts:682-689`, map at line 319).

```ts
// before: the order of interning decided the member order
const sorted = [...flat].sort((a, b) => a - b);

// after
const sorted = [...flat].sort((a, b) =>
  compareText(this.irKey(a), this.irKey(b)) || a - b
);
```

Second, `recordTarget` narrows the fitting members by the known types of the name-reference field values (`recordTarget` in `src/core/check_expr.ts`). `knownNameType` reads settled locals, values, and providers. It records no fact and reports nothing. The old choice stays as the fallback when no member fits.

Six test messages changed, and only in the order of union members.

## Why This Works

The canonical JSON of the IR depends only on the structure of a type. It does not depend on when the table interned the type. The order now matches the order that `toIr` already emits, so the checker and the emitter agree. Edit history cannot change the order.

A fixed order is not enough. With a fixed order, `recordTarget` still picks the first fitting member. The field values `x: N` say which member the author meant. Narrowing by those types picks the member whose fields accept the values. This makes the choice depend on the program and not on the order.

## Prevention

- Read the header rule of `src/core/types.ts` as "no behavior may depend on a raw id": a checker choice and a diagnostic text count as outputs.
- Never let a `TypeRef` number decide user-visible behavior. A `TypeRef` is an intern index. It depends on edit history in a long-lived table. Use it only as a last tie-break.
- Prefer a canonical structural key for any order or choice that a user can see. Here the key is `canonicalJson(toIr(ref))`.
- Do not swap `Lowered.ir` for `toIr`. See the second lesson below.
- When a checker takes "the first fitting" candidate, narrow the candidates by every fact that the source gives. A stable order only hides the choice.
- Keep record brands out of `recordTarget`. A plain record literal must not fit a record brand, so a new narrowing rule must not see through a brand (session history).
- Compare incremental and fresh builds on diagnostic text, not only on emitted code and hashes. The fuzz found all 27 differences this way.

### Second lesson: `Lowered.ir` is not `toIr(ref)`

`Lowered.ir` keeps source order and schema `makeInput`. `toIr(ref)` does not. Commit 8a0abf2 (function-type alias on module constants) read the type of every function-typed binding, inline or alias, through `toIr`. A probe then showed the defect:

```effektive
export const g: (x: B | A) => A = (x) => 2
```

The emitted TypeScript said `x: A | B` and not the written `x: B | A`. Both forms pass `deno check`, but the change also put the schema `makeInput` of a written type at risk.

Commit ac9db59 fixed it. `functionOfBinding` uses `binding.ir` when it is a function type. It calls `toIr(ref)` only after it unfolds an alias. The fast test `tests/function_alias_binding_test.ts` pins the source order.

The rederive review, section 9 (`docs/plans/2026-10-20-rederive-review.md:426`), records that `Lowered.ir` differs from `toIr(ref)` in 70 of 3620 lowerings. 65 differ in source order. 5 keep a schema `makeInput`. The two forms are not redundant.

## Related Issues

- `docs/solutions/logic-errors/checker-expected-type-is-enforced-not-a-hint.md` also covers a checker choice that depends on how the expected type is used.
- `docs/solutions/logic-errors/checker-result-type-from-expected-hint.md` touches `TypeTable.union` for result types, not for member order.
- The rule row "Contextual record unions" in `docs/language-rules.md` states the selection order. The [completed audit fix plan](../../archive/plans/2026-10-21-audit-fixes.md) (items AU1, AU2, AU4) holds the probes and measurements.
- Commits d3a1633, 8a0abf2, and ac9db59 are on main.

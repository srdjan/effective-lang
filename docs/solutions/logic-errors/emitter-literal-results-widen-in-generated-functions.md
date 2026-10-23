---
title: TypeScript widens a literal that an emitter-generated function returns, so literal-union results failed deno check
date: 2026-10-23
category: logic-errors
module: src/core/emit/expr.ts
problem_type: logic_error
component: emitter
symptoms:
  - "A function with a literal-union result type, such as `type Kind = \"a\" | \"b\"`, reports 0 checker diagnostics, but `build --tsc` reports TS2322: Type 'string' is not assignable to type '\"a\" | \"b\"'"
  - "An effect function with a literal result reports TS2375: Type 'Effect<string, Bad, never>' is not assignable to type 'Effect<\"a\" | \"b\", Bad, never>'"
  - "The same failure occurs for number literal unions (1 | 2) and boolean literal types (true)"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [emitter, literal-types, literal-widening, as-const, contextual-typing, match, effect-gen, deno-check, tsc]
---

# TypeScript widens a literal that an emitter-generated function returns, so literal-union results failed deno check

## Problem

The Effective checker accepts a literal result for a literal-union result type. The emitter wraps many results in generated functions: match-arm wrappers, block wrappers, `Effect.succeed`, and `Effect.gen` bodies. TypeScript infers the return type of such a function without a contextual return type, and it widens a fresh literal such as `"a"` to `string`. The emitted module then fails `deno check`, although the source is correct.

## Symptoms

- `match v { A(x) => "a", B(y) => "b" }` with result `Kind` emits `((x) => "a")($t0)`, and `deno check` reports TS2322.
- A block arm emits `(() => { const m: Count = x.n; return "a"; })()`, with the same error.
- An effect function emits `Effect.succeed("a")` in an arm, or `return "a"` in `Effect.gen(function* () { ... })`, and `deno check` reports TS2375 on the Effect type. This includes `return k === "a" ? "b" : (yield* Effect.fail(...))`.
- In an effect arm, `Effect.succeed({ kind: "a" })` gives `Effect<{ kind: string }>`, so a literal record field fails too.

## What Didn't Work

- Annotating only the outer selector wrapper, `(($t0): Kind => ... ((x) => "a")($t0) ...)(v)`, still failed. The return annotation of the outer function does not reach the inner arm wrapper, because the inner wrapper is a callee, not a returned expression.
- Annotating each arm wrapper, `((x): Kind => "a")($t0)`, fixed pure arms. It cannot fix `Effect.gen` returns or `Effect.succeed` arguments, where the widening happens inside a generic call or a generator.
- A first plan from the plan review covered only the name-match arm. A probe over more positions found the block, `Effect.succeed`, and `Effect.gen` cases. Test every generated wrapper kind, not only the reported one.
- Dropping `as const` from record field values looked safe at first. A hand-written probe with a record returned from a pure arm passed without it, and so did a probe where both effect arms called `Effect.succeed`. The compiler output for an effect match with one `Effect.succeed({ kind: "a" })` arm and one `Effect.fail(...)` arm failed with TS2375. So record fields keep `as const`.

## Solution

`ExprEmitter.structural` emits a literal with `as const` when its slot type admits a literal (`src/core/emit/expr.ts:670-676`):

```ts
case "literal":
  // TypeScript widens a literal that a generated function returns, such
  // as a match arm or an `Effect.gen` body, unless it is `as const`.
  return expected !== undefined && e.value !== null &&
      this.admitsLiteral(expected)
    ? emitted([this.literal(e.value), " as const"], PREC.relational)
    : emitted(this.literal(e.value));
```

`admitsLiteral` (`src/core/emit/expr.ts:873`) resolves aliases and returns true for a literal type or a union with a literal member. The emitted forms become `((x) => "a" as const)($t0)`, `Effect.succeed("a" as const)`, `return "a" as const;`, and `Effect.succeed({ kind: "a" as const })`. A literal without a literal slot, such as the operand in `k === "a"`, stays plain.

## Why This Works

`as const` gives the expression its literal type at the leaf, so no later inference step can widen it. The fix does not depend on how the literal reaches the result: through a wrapper, a conditional, a block return, a generator return, or a generic argument. The expected type already flows to each leaf through `fit` and the slot type of blocks, branches, and arms, so one leaf rule covers every wrapper.

These positions did not fail before the fix: a literal match without a binding, where the arm is a plain conditional branch, and `Option.match` handlers. The probable reason for `Option.match` is that the declared result type of the function gives the generic call a contextual return type; this was observed, not traced in the TypeScript checker. The fix adds `as const` there too, which is harmless.

An earlier fix used a different tool for the same widening. The `some` case emits an explicit type argument, `Option.some<T>(...)` (`src/core/emit/expr.ts:733-740`), because inferring `some` can widen tuple payloads and record discriminants. A type argument fits a single generic call. It does not fit an arm wrapper, a block wrapper, or an `Effect.gen` body, which have no single type-argument slot, so EX3 puts the fix on the literal itself.

## Prevention

- `fixtures/emit/forms/literal-results.eff` holds one function for each wrapper kind, with string, number, and boolean literal results and the record field in an effect arm. `tests/emit_slow_test.ts` runs `deno check` on it in "the emitted forms and name-collision modules pass deno check".
- `tests/emit_test.ts` ("a literal result in a generated function is as const") checks the emitted text of each form.
- A change that removes "noisy" `as const` output, for example from record fields, must keep that slow test passing. The record field case exists to catch that change.
- When the emitter adds a new kind of generated function around a value, add a literal-union case for it to the fixture.

## Related Issues

- [The checker must not take a builtin result type from the expected hint](checker-result-type-from-expected-hint.md): the same failure class, where the checker accepts a program and a later stage rejects it.
- [An expected type passed to argInfo is enforced on branches](checker-expected-type-is-enforced-not-a-hint.md): expected types in `if` and `match` results on the checker side.
- Found during the nominal examples plan (`docs/archive/plans/2026-10-23-nominal-examples.md`, item EX3).

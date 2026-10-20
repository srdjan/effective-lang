---
title: An expected type passed to argInfo is enforced on branches, so a constructed hint can reject valid programs
date: 2026-10-19
category: logic-errors
module: src/core/check_expr.ts
problem_type: logic_error
component: type_checker
symptoms:
  - "A builtin argument that is an `if` or `match` over named values starts to report type-mismatch/003 after a contextual hint is added"
  - "The branch message names the constructed hint type, for example a Sink with an array result, and not any type in the source"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [checker, expected-type, contextual-typing, sink, takesink, runstream, joinresults]
---

# An expected type passed to argInfo is enforced on branches, so a constructed hint can reject valid programs

## Problem

`runStream(s, takeSink(2))` reported "`takeSink` needs an expected Sink type
to determine its input". `takeSink` reads its input type only from the
expected type. `runStreamCall` called `this.argInfo(args[1])` with no expected
type. The planned fix copied `sinkTransformStreamCall`: it built
`this.table.sink(element, element[], [], [], element)` from the stream element
and passed it as `argInfo(args[1], hint)`.

That fix would have rejected valid programs. The `expected` argument of
`BodyChecker.argInfo` is not an inference-only suggestion. For `if` and
`match`, `joinResults` (`src/core/check_expr.ts`, about line 6858) checks each
branch against `expected` with `fits` and returns `expected` as the result.

## Symptoms

The plan review (codex Astra) found this with a probe before implementation.
A program of this shape is accepted without the hint:

```effective
type Branch = Sink<Int, Text, Stop, Count.tick, Text>
const run = (s: Stream<Int>, flag: Bool, a: Branch, b: Branch): Text fails Stop uses Count.tick =>
  runStream(s, if (flag) { a } else { b })
```

With the constructed hint, the probe gave three diagnostics, because the hint
requires an `Int[]` result and empty failure and requirement channels. A
`match` with the same branches failed the same way.

## What Didn't Work

- The first plan passed the constructed Sink hint for every second argument.
- The plan's own regression test used one named sink with a different
  result type. A named reference ignores the hint, so that test would pass
  and would not show the defect. Only a branching expression shows it.

## Solution

Commit c1f07da (on local main, not pushed yet) passes the hint only when the argument is a direct call of
the `takeSink` builtin. `isTakeSinkCall` checks that the argument has no
pipeline value, is a `CallExpr`, and that its callee resolves through
`this.targets` to the builtin `takeSink`. A user-defined `takeSink` does not
match. Every other argument keeps `argInfo(args[1])` with no hint.

```ts
const hint = producer.kind === "stream" && this.isTakeSinkCall(args[1])
  ? this.table.sink(
    producer.element,
    this.table.array(producer.element),
    [],
    [],
    producer.element,
  )
  : undefined;
const sink = this.argInfo(args[1], hint);
```

Tests: `tests/run_stream_sink_hint_test.ts` covers the inline `takeSink`,
a named sink with nonempty channels, and `if` and `match` over named sinks
with a `Text` result. `tests/run_stream_sink_hint_slow_test.ts` runs the
emitted program under strict TypeScript.

## Why This Works

A direct `takeSink` call has a known result shape: its result is always an
array of its input, with no channels. The constructed hint therefore holds
exactly what the call produces. Any other expression can have a different
result type and different channels. A full expected type would then become a
constraint on that expression, not information for it.

## Prevention

- Treat the `expected` argument of `argInfo` as a constraint. Pass a type
  there only when every valid argument must have that complete type.
- When only part of a type is known, for example a Sink input, give it only
  to the constructors that need it. Gate the hint on the syntactic form of
  the argument.
- Test a new contextual hint with an `if` and a `match` whose branches have
  a different result and nonempty channels. A named-value test does not
  reach `joinResults`.
- `sinkTransformStreamCall` (transduceStream, aggregateStream) and
  `aggregateWithinStreamCall` still pass the full constructed hint for any
  sink argument. This is earlier behavior that was not changed. A branching
  sink argument there probably meets the same constraint; a probe can
  confirm it.

## Related Issues

- `docs/solutions/logic-errors/checker-result-type-from-expected-hint.md`
  covers the opposite direction: a builtin that copies the expected type
  into its result.
- Audit finding A7 (follow-up G3), from the audit of the Codex Effect 4
  feature commits. The plan and the Astra review were kept outside the
  repository.

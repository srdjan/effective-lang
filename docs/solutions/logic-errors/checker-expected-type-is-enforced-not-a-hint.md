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
`match`, `joinResults` in `src/core/check_expr.ts` checks each
branch against `expected` with `fits` and returns `expected` as the result.

## Symptoms

The plan review (codex Astra) found this with a probe before implementation.
A program of this shape is accepted without the hint:

```effektive
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
- The first fix (commit c1f07da) gave the hint only to a direct `takeSink`
  call. A probe then showed that `transduceStream`, `aggregateStream`, and
  `aggregateWithinStream` had the same defect, because they passed the full
  hint for any sink argument. Moving them to the direct-call rule broke a
  form that they accepted before:
  `transduceStream(s, if (flag) { takeSink(2) } else { takeSink(3) })`.
  A branch that is a `takeSink` call needs the hint as much as a direct call.

## Solution

The three handlers of the four stream builtins now call one helper, `takeSinkHint`, in
`src/core/check_expr.ts`. It returns the constructed Sink type only when the
first argument is a Stream and a direct `takeSink` call is one of the sink
argument's results. `resultsInTakeSink` walks the result positions as the
checker does: the expression itself, a parenthesized expression, the last
item of a block, each branch of an `if`, and each arm body of a `match`. The
callee must resolve through `this.targets` to the builtin `takeSink`, so a
user-defined `takeSink` does not match. Any other sink argument, such as a
branch between named sinks, gets no expected type.

```ts
const sink = this.argInfo(args[1], this.takeSinkHint(stream.type, args[1]));
```

Tests: `tests/run_stream_sink_hint_test.ts` covers the inline `takeSink`, a
named sink with nonempty channels, `if` and `match` over named sinks for all
four builtins, and `takeSink` calls inside `if` and `match` branches.
`tests/strict_target_slow_test.ts` runs the emitted program under
strict TypeScript.

## Why This Works

A `takeSink` call has a known result shape: its result is always an array of
its input, with no channels. When a `takeSink` call is a result of the
argument, the argument must have that shape, so the constructed type is exact.
When no result is a `takeSink` call, nothing reads the constructed type, and
leaving it out removes only a false constraint on the branches.

A mix of a `takeSink` branch and a named sink with another result type still
fails. This is earlier behavior: the constructed type is enforced on the named
branch.

## Prevention

- Treat the `expected` argument of `argInfo` as a constraint. Pass a type
  there only when every valid argument must have that complete type.
- When only part of a type is known, for example a Sink input, give it only
  to the result positions that need it. Gate it on the syntactic form of the
  argument, including branch results.
- Test a new contextual hint with an `if` and a `match` whose branches are
  named values with another result and nonempty channels. Also test branches
  that are the constructor that needs the hint. A named-value test alone does
  not reach `joinResults`.
- When a fix narrows when a hint is passed, probe every form that was
  accepted before at each site, not only the forms of the new defect.

## Related Issues

- `docs/solutions/logic-errors/checker-result-type-from-expected-hint.md`
  covers the opposite direction: a builtin that copies the expected type
  into its result.
- Audit finding A7 (follow-ups G3 and G10), from the audit of the Codex Effect 4
  feature commits. The plan and the Astra review were kept outside the
  repository.

Update 2026-10-24: TE4 of the terse source plan renamed `takeSinkHint` to `sinkHint` and
`resultsInTakeSink` to `resultsInSink`. The hint now also gives an inline `sinkForEach`
callback its input type.

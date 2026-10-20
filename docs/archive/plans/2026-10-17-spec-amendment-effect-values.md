# Proposed canonical spec amendment: first-class Effect values

Status: accepted and applied for Phase 4. The canonical file is
`/Users/srdjans/Code/effective/public/effective-spec.html`. The source form
and backend behavior pass the compiler and Effect 4 target tests.

## Data and types

Add `Effect<A, E, R>` as a value type. `A` is the successful result type. `E`
is `never` or a `|`-separated set of nominal error names. `R` is `never` or a
`|`-separated set of qualified service methods. When omitted, `E` and `R`
default to `never`. These are the *deferred* channels of the value; they do not
describe the effects of evaluating an expression that produces the value.
An Effect value is immutable and can be bound, passed, and returned.

Effect value compatibility checks `A` covariantly and allows the source's
failure and requirement sets to be subsets of the target's sets. Nominal
errors and method-level requirements retain their identities. A value with
more possible failures or requirements cannot fit a narrower declared type.
The generated TypeScript type is `Effect.Effect<A, E, Rservice>`, where
`Rservice` is the union of service classes containing the required methods;
checked IR retains the method-level set.

## Execution order and mode

Add two prelude operations:

> `defer(job)` requires a zero-argument function and constructs an Effect value
> representing the job's invocation. Its result type is `Effect<A, E, R>` from
> the job's result, failures, and requirements. The job body does not run at
> construction. Only evaluation of the job *expression* can contribute active
> effects at construction. `run(value)` requires an Effect value and evaluates
> the value anew on every call. Its result is `A`; its active failures and
> requirements include `E` and `R`, as well as those of evaluating `value`.
> Running an Effect with empty failure and requirement sets remains effectful.

The backend emits `Effect.suspend(() => job())` for a deferred effect-mode
callback. It lifts a pure callback into an Effect without running it during
construction. The backend emits the stored Effect value as the computation
for `run`; an enclosing effect context sequences it. Neither operation adds
an automatic provider. Repeated `run` calls repeat the deferred computation.

## Typed IR and validation

Add an `effect` Type variant with `result`, `failures`, and `requirements`.
Add explicit `defer` and `run` Expr variants. `defer` carries the job expression
and records only the active effects of evaluating that expression, with a
pure construction mode when that expression is pure. `run` carries the Effect
value expression and records the union of its active effects and deferred
channels, with effect mode. The independent validator checks that the job is
zero-argument, the Effect value type matches its invocation channels, and the
run result and active sets match the value type. It rejects swapped, missing,
or fabricated deferred channels.

## Surface grammar

Add these forms to the grammar. `failureSet` and `requirementSet` reuse the
existing union syntax; `never` denotes an empty set only in these positions.

```text
effectType = "Effect" "<" type ["," (failureSet | "never")
             ["," (requirementSet | "never")]] ">"
deferExpr = "defer" "(" expression ")"
runExpr = "run" "(" expression ")"
```

`defer` and `run` are closed prelude operations. Existing source bindings named
`run` shadow that operation. `Effect<...>` is a builtin type application; an
existing value binding named `Effect` remains valid.

The parser must distinguish an Effect type's two channel arguments from the
`fails` and `uses` clauses of an enclosing function type or declaration.

## Conformance and deferred work

The runtime fixture constructs an Effect with zero service calls, then runs
the stored value twice and observes two calls. Checker and validator tests
cover deferred channels, bindings, parameter transport, and mutation of both
recorded deferred sets. `build --validate --tsc` passes. The
[Effect 4 probe](phase4-probes/effect-values.ts) verifies the target's
construction and repeat behavior.

Resource scopes, concurrency, streams,
general Effect combinators, and arbitrary package imports remain separate
milestones. `.effi` cannot directly import an opaque Effect constant under
its current provider-only value grammar; a host method that returns an Effect
value has passed a generated TypeScript check for the nested service shape.

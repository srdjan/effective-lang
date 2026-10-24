# Proposed first-class Effect value slice

Status: accepted and implemented in Phase 4. The source program passes
`build --validate --tsc`; the generated code passes a runtime test that
constructs without service calls and runs twice.

## Source form

```effektive
error Stop = {}
service Counter { next(): int fails Stop }

const make = (): Effect<int, Stop, Counter.next> =>
  defer(() => Counter.next())

const stored: Effect<int, Stop, Counter.next> = make()

const twice = (): int fails Stop uses Counter.next => {
  const first = run(stored)
  const second = run(stored)
  first + second
}
```

`Effect<A, E, R>` is a value type. `A` is its successful result; `E` is a
union of nominal error names or `never`; `R` is a union of qualified service
methods or `never`. Omitted `E` and `R` mean `never`. Type syntax must parse
those channels in this position without consuming the enclosing function's
`fails` and `uses` clauses. Requirement identities remain method-level in the
IR even though generated TypeScript uses the containing service classes.

`defer(job)` accepts a zero-argument function whose invocation produces `A`
with failure set `E` and requirement set `R`. Constructing the closure and the
Effect value does not run the job, add active failures or requirements, or
acquire a provider. Each evaluation of `run(effectValue)` runs the stored
Effect anew; `run` adds `E` and `R` to the enclosing active contract. An
effectful expression used to *obtain* the Effect value contributes its own
active effects before `run`. The compiler rejects `run` on a non-Effect value.

Effect value compatibility requires compatible success types and subset
failure and requirement sets. Constructing a value with fewer possible
failures or requirements may fit a wider declared Effect contract. The value
must remain first class in arrays, records, parameters, returns, and local
bindings; this vertical slice needs at least binding, return, and execution.

The proposed IR adds an `effect` type with result and deferred sets, a `defer`
expression carrying a closure, and a `run` expression carrying the Effect
value. The `defer` annotation contains only child construction effects; the
`run` annotation contains its child's evaluation effects and the deferred
sets. The independent validator derives both from IR, without checker side
facts. Emission maps `defer` to `Effect.suspend(() => ...)` and `run` to the
Effect value in an effect context. The checked
[target probe](phase4-probes/effect-values.ts) demonstrates that a stored
`Effect.Effect<A,E,R>` can be reused twice with the same type channels. Its
`deno test --no-lock` check proves construction makes zero service calls and
two evaluations make two calls.

## Boundary and acceptance

The first slice does not add arbitrary package imports or general Effect
combinators. Today `.effi` has no imported constant declarations, so it cannot
directly expose an opaque host Effect value. A host service method returning an
Effect value is a nested value in that method's own Effect result. The target
probe typechecks the outer service call followed by execution of the nested
Effect, with distinct requirement channels. A generated TypeScript check of
that service shape passes. No automatic flattening is implied.

Acceptance cases: a constructed value never run makes zero service calls; two
`run` calls make two; a typed failure and a service requirement appear at each
`run` boundary but not at construction; passing or returning the value
preserves all three channels; mutation of either deferred set is rejected by
IR validation. Parser, checker, lowerer, validator, emitter, and
`build --validate --tsc` must agree before the phase is complete.

The canonical spec at `/Users/srdjans/Code/effektive/public/effektive-spec.html`
includes the accepted source and lifetime rules. The compiler permits an
existing binding named `run` to shadow the new prelude operation.

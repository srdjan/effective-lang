# Phase 5 scoped operation-record rule

Status: the narrow operation-record rule is accepted and implemented. The
Effect 4 target probe, compiler tests, runtime test, and
`build --validate --tsc` gate pass. General borrowed handles remain outside
this phase.

The [target probe](phase5-probes/scopes.ts) passes `deno test --no-lock`. It
checks that release follows a successful use, a typed use failure, and fiber
interruption. `Fiber.interrupt` waits until release completes. A separate case
typechecks and runs a release action whose typed failure and service
requirement remain in the result channels. The pinned `effect@4.0.5`
`Effect.acquireUseRelease` signature combines acquisition, use, and release
failure and requirement channels:

```text
acquire: Effect<Resource, E1, R1>
use:     Resource -> Effect<A, E2, R2>
release: (Resource, Exit<A, E2>) -> Effect<void, E3, R3>
result:  Effect<A, E1 | E2 | E3, R1 | R2 | R3>
```

The [Effect 4 resource guide](https://effect.website/docs/v4/resource-management/introduction)
documents `acquireUseRelease`; its
[fiber guide](https://effect.website/docs/v4/concurrency/fibers) states that
interruption waits for finalizers. The local probe establishes these behaviors
against the project's pinned target version.

## Required source rule

A candidate Effective form is `withResource(acquire, use, release)`, where the
three arguments are deferred callbacks. `acquire` produces a handle; `use`
receives that handle and produces the result; `release` receives the handle
and runs after use exits. The handle's lifetime is bounded by this expression.
All three callbacks may be effectful, and their invocation failures and
requirements must be checked and combined independently. The release callback
must execute after success, typed failure, defect, or interruption.

An ordinary handle type is insufficient. A callback could return the handle,
put it in a record, return a closure that captures it, or pass it to a host
method that stores it. A result-type check alone would miss closure capture
and host storage. Before accepting this source form, the language needs a
checked lifetime rule for the callback-bound handle and a host interface
contract for methods that may borrow it. The checker must reject escapes
through aliases, aggregates, closures, and forbidden host calls. The IR must
carry the scoped binding and its lifetime boundary so independent validation
can check the same rule. The emitter must not be the first component to impose
the restriction.

The current `.effi` method grammar has no borrow or consume qualifier, so it
cannot express a general handle borrowing contract. Phase 5 uses the narrower
operation-record form below.

## Accepted narrow source form

Use an operation record as the scoped handle. Each field is a function that
performs one operation on the underlying resource. The host adapter creates
the record, and Effective source decides when to acquire it, what to do with
it, and when to release it:

```effective
service Files {
  open(): { read: () => string, close: () => void }
}

const load = (): string uses Files.open =>
  withResource(
    () => Files.open(),
    (file) => file.read(),
    (file) => file.close(),
  )
```

`withResource` takes three inline callbacks. Acquisition takes no arguments
and returns a record whose fields are functions. Use and release each take the
same record. The use result and every operation result must be data only:
no function, Effect, provider, or nested operation record. The release result
must be `void`. Callback invocation failures and requirements combine into
the enclosing function contract. Release runs after success, typed failure,
defect, or interruption. A release failure keeps its own typed channel.

The scoped parameter may occur only as the direct receiver of a field call,
such as `file.read()`. It cannot be returned, assigned, put in a record or
array, captured by another closure, or passed as an argument. A field of the
record cannot be read as a value. These rules leave the host no source-level
path to store the operation record; the host adapter still owns the behavior
of the functions it creates. A host method that accepts the handle as an
argument remains outside this slice and needs a separate borrow contract.

For this rule, data only means a type whose unfolded structure contains no
function, Effect value, provider, or `unknown`, including inside records,
arrays, tuples, options, unions, errors, and brands. The operation record has
required function fields only; each field's parameters and result must be
data only. This keeps an operation from returning another handle or a closure
that could retain the resource. The host adapter's implementation is still a
trusted boundary, as it is for service methods today.

The checker enforces these rules on the source tree. The IR carries a distinct
`with-resource` expression with three closures and a scoped parameter identity;
the independent validator checks the same permitted reference shape and
recomputes the three invocation channels. Emission uses
`Effect.acquireUseRelease` with suspended acquisition and Effect-returning use
and release callbacks. Tests need a host operation record and must show
release on success, typed failure, and interruption, plus rejection of every
escape form above. The canonical spec records this source rule.

The IR equation is the union of acquisition, use, and release *invocation*
failures and requirements, with effect execution mode even when all sets are
empty. The three callback expressions are inline closures and have no active
construction effects. The backend maps them to
`Effect.acquireUseRelease(Effect.suspend(acquire), use, release)`, lifting a
pure use or release callback to an Effect callback. The validator checks both
the equation and scoped references from IR without checker side tables.

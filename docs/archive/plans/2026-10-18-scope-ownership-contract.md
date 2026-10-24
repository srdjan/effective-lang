# Explicit Scope ownership and transfer contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: implemented first source slice, accepted into design draft 0.34.
The canonical spec, typed IR, checker, independent validator, and emitter agree.

## Decision

Introduce a `CloseableScope` value with shared close authority. Returning or
passing it shares the same scope identity; it does not move or consume a
linear owner. Every successful `closeScope` completion waits for the original
close operation, and every later close observes its cached outcome.

Cleanup remains explicit. Creating a scope does not attach it to the creating
fiber or install an automatic close. Existing borrowed resources and Fiber
handles retain their current escape restrictions. This decision provides
manual lifetime control and a completion barrier; it does not promise static
leak prevention or extend the lifetime of a service provider.

The primary success measure is a source program that starts a child, returns
from its creating root execution, and closes the child from a later execution
through an alias, with cleanup complete before close returns. Guardrails are
unchanged borrow rules, checked failure/requirement channels, and one physical
close per identity. The target prototype passes eight tests. Compiled source
witnesses verify shared authority across roots and modules, provider lifetimes, close completion,
service capture, argument order, and host-boundary compatibility.

## Alternatives and accepted trade-offs

| Option | Meets the returned-live-scope witness? | Cost and disposition |
| --- | --- | --- |
| Another lexical borrow/bracket | No; its lifetime ends inside the creating execution. | Keep existing `scoped` and `withResource` for that contract. |
| Affine owner with moves and mandatory consumption | Potentially, with failure/interruption cleanup rules. | Would require ownership state through branches, closures, calls, and IR validation. Not selected for this slice. |
| Copyable raw `Scope.Closeable` with direct close | Yes. | A concurrent second close can return before cleanup finishes, and later closes do not replay an earlier cleanup defect. Insufficient for the selected close-completion rule. |
| Shared close authority with a cached completion | Yes. | Selected. Requires a small runtime wrapper; permits abandonment and retains runtime references until ordinary garbage collection. |

This is a bounded source abstraction over Effect Scope. In particular, the
first slice closes with `Exit.void`; arbitrary supplied Exits, success values,
and exit-aware finalizer callbacks remain deferred. It does not claim full
raw Scope parity.

## Source surface

The following are builtin contracts, not user-defined generic functions:

```text
makeScope(): CloseableScope
provideScope(owner: CloseableScope, job: Effect<A,E,R>): A
addScopeFinalizer(owner: CloseableScope, job: Effect<void,never,R>): void
closeScope(owner: CloseableScope): void
```

All four execute in effect mode. `provideScope` executes its Effect value;
`addScopeFinalizer` registers its Effect value for later execution. The finalizer
job must have result `void`, no typed failures, and no reserved Scope
requirement. Ordinary service requirements are permitted and captured at
registration. A typed finalizer failure must be handled before registration,
as required for jobs accepted by `forkScoped` today.

Builtin names obey existing shadowing rules. `CloseableScope` takes no type
arguments and is distinct from the reserved `cap:effect/Scope` requirement.
The slice does not expose a getter for the current lexical scope or permit a
cast from an ordinary/borrowed handle to a `CloseableScope`.

This program illustrates the ownership boundary:

```effektive
service Worker { run(): void; ready(): void }

export const open = (): CloseableScope uses Worker.run | Worker.ready => {
  const owner = makeScope()
  provideScope(owner, defer(() => forkScoped(defer(() => Worker.run()))))
  Worker.ready()
  owner
}

export const stop = (owner: CloseableScope): void => closeScope(owner)
```

The caller supplies Worker and waits for readiness before receiving the owner.
It may end that root execution and invoke `stop` in a later one. Any provider
needed by the child must remain alive for that lifetime, or be acquired inside
the child as described below. The [source fixture](../../../fixtures/emit/scopes/owner.eff) compiles this
pattern; its runtime test waits for child cleanup across separate root runs.

## Value and transfer rules

`CloseableScope` is an abstract runtime handle. It may be assigned, returned,
passed to ordinary helpers, captured by ordinary closures, or contained in
arrays, tuples, records, Options, Effects, and Refs. These operations share
identity; they do not clone the scope or reset its completion state. Passing
or returning an owner leaves earlier aliases usable. Close consumes no alias.

The source type exposes no fields or methods and supports no equality or
ordering operation. It has no derived Schema and is not data only, including
when nested inside another type. Existing Codec schema checks and data-only
resource/Fiber callback-result checks must reject it. A type alias may name it
without generating a Schema for it, as with other runtime-only source values.

Source borrow qualifiers continue to apply to opaque resource parameters.
`CloseableScope` does not become a borrowed opaque resource type: its ordinary
parameter contract explicitly permits retention. Existing `withResource`
handles and borrowed Fibers may not be captured in a registered finalizer,
stored through the owner, returned in an aggregate with it, or passed to a new
host method through an otherwise forbidden path. The owner does not make an
escaping borrowed reference legal.

The type can appear in `.effi` signatures with the same shared-authority
meaning. Strict host assertions must distinguish the wrapper from a raw target
`Scope.Closeable`. Host implementations remain a trusted boundary.

## Operational rules

### Creation and provision

`makeScope` creates an independent sequential Effect Scope and a fresh shared
close-completion cell. It neither needs nor joins an ambient Scope. Ending,
failing, or interrupting its creating fiber does not close it. Dropping every
alias is permitted and does not run finalizers; callers remain responsible for
explicit cleanup.

`provideScope` supplies only the selected scope capability to the job. It does
not close the owner when the job returns. It does not automatically interrupt
ordinary work when the owner closes. Existing `forkScoped` instead registers
child interruption with that scope; it keeps its no-typed-failures rule and
returns `void` in source. The slice adds no join handle or child-result channel.

Provision after close retains the pinned target behavior: ordinary work may
run, while a newly scoped child cannot remain live in that closed scope. The
handle is not an open/closed typestate proof.

### Finalizer registration and service lifetime

`addScopeFinalizer` evaluates owner and job once, from left to right. It
activates the job's service requirements at registration and captures the
current service bindings before storing a requirement-free finalizer. It does
not run an open scope's finalizer at registration. Close therefore needs no
service requirement from previously registered jobs.

The captured context retains service references, not ownership of their
provider resources. Registration does not extend a scoped Layer's lifetime.
For a child that must survive the creating root, acquire its resource-backed
Layer inside that child's Effect. The prototype confirms that the child-owned
provider survives root return and is released when explicit close interrupts
the child. Supplying a scoped provider around creation and assuming it survives
creation's return is not part of this contract.

Registering after the underlying scope has entered its closed state runs the
finalizer immediately and waits for that registration's cleanup. Such a late
registration is a separate execution: earlier or concurrent close calls do not
become barriers for it, and its defect does not rewrite the cached close
outcome. Finalizers registered before close begins run in reverse order.

### Close completion and interruption

The runtime wrapper has three logical states: open; closing with a shared
pending completion; and closed with a cached `Exit<void,never>`. The first
caller atomically claims close before any suspension, closes the underlying
scope with `Exit.void`, and completes the cell with its actual outcome.
All callers await that same cell. Calls do not duplicate finalizer execution.

Closing and waiting are uninterruptible. Interruption of the first caller or
an alias cannot leave the shared completion pending after cleanup finishes.
Pending caller interruption can be observed after the uninterruptible region;
it does not replace the cached physical close outcome. A finalizer that never
finishes keeps close pending. The slice adds no cleanup timeout.

A finalizer that waits for `closeScope` on its own owner creates a dependency
cycle: close waits for that finalizer, which waits for close. This also stays
pending. Shared authority does not provide static cycle detection; callers
must avoid cleanup dependencies that wait for their own completion.

Close has no typed failure channel. Defects remain defects: all pre-close
finalizers are attempted according to the target's sequential strategy, and
the close outcome, including a defect cause, is replayed to later callers.
This completion and replay behavior is an intentional strengthening of direct
`Scope.close`, verified separately by the prototype. It does not aggregate
new failure types into a nominal source error or claim to join a child's result.

## Checked channel equations

Let `active(x)` be the failures and requirements from evaluating argument `x`,
and `latent(job)` the channels of its Effect value. Ordinary unions retain the
compiler's existing set normalization. Each rule also forces effect mode.

| Form | Result | Active failures | Active requirements |
| --- | --- | --- | --- |
| `makeScope()` | `CloseableScope` | empty | empty |
| `provideScope(owner, job)` | job success type `A` | argument failures union latent job failures | argument requirements union `(latent job requirements minus cap:effect/Scope)` |
| `addScopeFinalizer(owner, job)` | `void` | argument failures | argument requirements union latent job requirements |
| `closeScope(owner)` | `void` | owner-expression failures | owner-expression requirements |

`provideScope` removes the reserved capability only from executing the supplied
job. It must not remove requirements incurred while evaluating owner or job
expressions before that execution. Registration requires empty latent job
failures and forbids its latent reserved Scope capability; active argument
construction may still fail normally. A finalizer's deferred execution becomes
part of the scope's runtime responsibility, with its requirements already
captured rather than erased without provision.

## IR, emission, and implementation boundary

The IR has a distinct `closeable-scope` type and explicit `make-scope`,
`provide-scope`, `add-scope-finalizer`, and `close-scope` nodes. The checker
and independent validator enforce operand/result types, finalizer restrictions,
data-only exclusions, and the equations above; the checker also enforces call
arity. An arbitrary record with similar target fields cannot become a source
scope. Emission reads only validated IR and project configuration.

Emission uses a private source-level representation containing a raw Scope,
a completion Deferred, and the close-started state. Helpers emitted in
different modules use a compatible structural target representation and
operate on the passed identity without copying its state. The class
in the executable prototype is a single-module encapsulation of the semantics,
not a requirement for generated representation.

The [prototype](scope-probes/ownership.ts) implements creation, provision,
context-capturing registration, and cached close with actual Effect 4 APIs.
Its eight tests establish raw concurrent-close behavior; alias completion;
registration-time context; late registration; interruption during close;
post-close provision; defect replay and remaining cleanup; and a child-owned
provider surviving root return. Together with the original audit probes, they
provide an executable reference for the chosen runtime contract.

## Acceptance evidence

The [source fixtures](../../../fixtures/emit/scopes),
[checker tests](../../../tests/check_body_test.ts),
[validator mutations](../../../tests/validate_test.ts), and
[strict target/runtime tests](../../../tests/emit_slow_test.ts) cover:

1. Creation and closure across separate roots and separate source modules;
   aliases in a record or Ref share one identity and one physical cleanup.
2. Concurrent close calls both finish after cleanup, sequential repeated calls
   do not repeat it, and cleanup defects are replayed to later aliases.
3. Registration is deferred while open, uses registration-time services,
   activates their requirements, and executes immediately after close.
4. Scope provision discharges only the latent reserved capability and preserves
   construction failures, other requirements, and the job's success type.
5. Child lifetime and provider release match the root-return witness; ordinary
   provided work is not silently converted into supervised work.
6. Borrowed handles/Fibers, data-only callback results, and schema-derived Codec
   restrictions remain enforced. Wrong IR operands or mutated channels fail
   independent validation.

Verification uses strict Effect target checks and runtime witnesses, followed
by `deno task check`. The canonical spec records this bounded contract and the
canonical typed IR matches the compiler payload. General raw Scope parity
remains outside the implemented slice.

The implementation passes 1,080 fast tests and 89 slow tests under Deno 2.9.7,
plus all 17 Scope audit probes. The canonical spec site passes its 11 tests
and 30 strict illustrative units.

Review this decision when a counterexample breaks one of the lifetime/channel rules. Supersede it if exclusive ownership becomes
a language-wide requirement or a later Exit design changes close semantics.
General Exits, exit-aware finalizer callbacks, parallel strategies, scope trees,
and mandatory cleanup remain separate work.

## Reproduce and references

```sh
deno test --no-lock docs/plans/scope-probes/ownership.ts
deno test --no-lock docs/plans/scope-probes/scopes.ts
deno test --no-lock --allow-all docs/plans/scope-probes/source_slow_test.ts
deno test --allow-all --filter '/explicit scopes|explicit close|scope registration|host providers preserve/' tests/emit_slow_test.ts
deno task check
```

The versioned oracle is the pinned package and these executable probes.
Background: [original lifetime audit](2026-10-18-explicit-scope-design.md),
[borrowed resources](2026-10-17-scoped-resource-design.md), and the
[Effect scope guide](https://effect.website/docs/v4/resource-management/scope).

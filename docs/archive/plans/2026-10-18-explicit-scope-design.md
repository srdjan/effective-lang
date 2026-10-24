# Explicit Scope lifetime audit and source-rule prerequisite

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: investigation complete; the bounded shared-scope extension is
implemented in design draft 0.34. General raw Scope parity remains deferred.

The follow-up [ownership/transfer contract](2026-10-18-scope-ownership-contract.md)
specifies shared close authority, a cached close-completion barrier, and
registration-time service capture for a bounded first source slice. Its
success-only close deliberately leaves general supplied Exits outside that
slice. Source and runtime acceptance tests now pass for this slice.

## Decision and evidence

Keep full raw Scope composition classified as a native gap. The implemented
shared-scope slice below meets the returned-live-scope witness with success-only
close. A straight-line manual
close is expressible by ending a `scoped` block at that point. The missing
contract is a caller-owned scope whose live work survives the creating root
execution and is closed by a later execution. Adding another lexical bracket
would not supply that contract.

The primary acceptance measure is preservation of the observable lifetime:
the worker starts before creation returns, remains live after that root run
returns, and finishes its finalizer before a later close returns. Guardrails
are preservation of service and failure channels, existing borrow restrictions,
and the distinction between finalizer ownership and fiber supervision. These
are semantic criteria, not a performance target or user-research claim.

The [target probe](scope-probes/scopes.ts) has seven passing tests. The
[compiler probe](scope-probes/source_slow_test.ts) has two passing tests: one
records four rejected source attempts; the other checks, independently validates,
strictly target-checks, and executes an existing lexical composition. The
experiments use Deferred handshakes and yielding finalizers, with no timing-based
ordering assertions. Five-second timeouts only bound failed experiments.

## Start with the minimal close

The smallest target operation is:

```ts
import { Effect, Exit, Scope } from "npm:effect@4.0.5";

const program = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Scope.addFinalizer(scope, Effect.void);
  yield* Scope.close(scope, Exit.void);
});
```

An empty finalizer makes the lifetime unobservable. The executable probe adds
two finalizers and records `body, second, first, closed`. The second finalizer
yields before completing. Closing the scope twice still runs each finalizer
once. Thus close waits for cleanup, and the default sequential strategy releases
in reverse registration order.

For a child whose lifetime ends at one lexical boundary, the existing source
[lexical.eff](scope-probes/lexical.eff) suffices:

```effektive
export service Child { run(): void; wait(): void }
export service Trace { record(value: Text): void }
type Text = string

export const main = (): void uses Child.run | Child.wait | Trace.record => {
  scoped(defer(() => {
    forkScoped(defer(() => Child.run()))
    Child.wait()
    Trace.record("body")
  }))
  Trace.record("closed")
}
```

The test provider makes `Child.run` wait indefinitely after signaling startup.
Its release yields before recording completion. The emitted program records
`start, body, release, closed`. Emission uses `Effect.scoped` and
`Effect.forkScoped`; the latter's Fiber result is discarded. This is an
equivalent-program argument for the lexical case, not evidence that every
explicit Scope close needs a new builtin.

`withResource` similarly expresses a single acquisition/use/release bracket.
It can determine the release point through the end of its use callback. A host
adapter can acquire and close a raw scope inside that bracket, but its scope
implementation then resides in TypeScript.

## Strengthen the witness: return a live scope

The target helper `open` in the probe has this checked contract:

```text
open: (name, events) -> Effect<Scope.Closeable, never, never>
```

It makes a scope, provides it to `Effect.forkScoped(worker)`, waits for the
worker to start, and returns the scope without closing it. The worker uses
`Effect.acquireUseRelease`, so its interruption has observable cleanup.

The decisive test runs creation and closure as separate root executions:

```ts
const scope = await Effect.runPromise(open("root", events));
// The worker has started and has not released after this root returns.
await Effect.runPromise(Scope.close(scope, Exit.void));
// The worker's yielding release has completed.
```

Its trace is `start:root, root-returned, release:root`. Another test lets the
creating child fiber finish and opens a second scope before closing the first:

```text
start:a, creator-returned, start:b, release:a,
a-closed-b-live, release:b, b-closed
```

The first root-return test is stronger than crossing lifetimes alone. Fixed
crossing traces can sometimes be reorganized using a longer-lived supervisor
and a custom signaling protocol. Such a reorganization changes the exported
contract if `open` needs a caller-supplied Scope or an enclosing execution that
must stay alive. Here `open` requires neither, and the first root really ends.

## Observed source boundaries

The original compiler probe recorded these diagnostics before lowering.
`Scope` remains unknown; `makeScope` now constructs the distinct
`CloseableScope` type. Borrowed resource and Fiber escape remains rejected:

| Attempt | Phase and diagnostic | Consequence |
| --- | --- | --- |
| `export const open = (): Scope => makeScope()` | Resolution: `unknown-name/001`, `unknown type Scope` and `unknown name makeScope` (names quoted in the actual output). | There is no native raw Scope type or constructor. This spelling is illustrative, not proposed syntax. |
| Run `forkScoped` in an exported requirement-free function | Contract checking: `requirement-contract/001`, body requires `cap:effect/Scope`. | Removing the surrounding scope does not create an independently owned child. |
| Return `() => file.close()` from `withResource` | Body checking: `type-mismatch/010`, use result must be data only; scoped record use restriction. | The operation record cannot export later close authority through a captured closure. |
| Return `() => interruptFiber(fiber)` from `withFiber` | Body checking: `type-mismatch/010`, fiber use result must be data only; borrowed fiber may only be joined or interrupted directly. | A borrowed Fiber cannot become a transferable cancellation handle. |

Wrapping creation in `scoped` discharges its reserved requirement, but closes
that scope before returning. `forkScoped` returns `void` in source, so it also
cannot export its child handle. `withFiber` supervises its child within its
inline callback. These lexical forms alone cannot implement the requirement-free live return
contract. The shared-scope extension now supplies that contract directly.

## Required operational rule before implementation

An extension claiming this raw Scope contract must specify all of the following:

1. **Identity and ownership.** Creation produces a distinct closeable scope.
   It does not require an ambient Scope and does not automatically bind its
   lifetime to the creating fiber. Successful return may transfer close
   authority to the caller, including across root executions. Closing one
   identity leaves another open identity's work alive.
2. **Provision is separate from close.** Running an Effect with a selected
   scope removes only its reserved Scope requirement. Its success, typed
   failures, and other requirements are retained. Returning from that run does
   not close the selected scope. Ordinary work provided with a scope is not
   automatically interrupted when that scope closes: the probe records
   `finalizer, closed, continued` for such a job.
3. **Fork ownership is explicit.** A child forked into the selected scope may
   outlive its creator. Closing that scope interrupts the registered child and
   waits for its cleanup. Providing a scope and registering a scoped fork
   must remain distinct operations, even if source can compose them.
4. **Close has an exit.** Explicit close supplies an Exit independently of the
   caller's eventual result. A failing supplied Exit can reach finalizers while
   the surrounding program succeeds. With the default sequential strategy,
   finalizers run in reverse registration order. Repeated sequential close
   does not repeat cleanup or replace the stored Exit; late registration runs
   immediately with the stored Exit. The probe closes with failure, closes
   again with success, then registers a finalizer: both observations are failure.
5. **Abandonment is deliberate.** Raw creation alone installs no automatic
   cleanup on creator failure or interruption. The probe interrupts the creator
   and observes its scoped child still live until explicit close. A bracketed
   owner instead closes with its actual Exit on every path; a separate test
   confirms interruption reaches its exit-aware finalizer before interrupt
   returns. Any safer source wrapper must name this behavioral difference.
6. **Channels and borrow rules remain checked.** The pinned target's raw
   finalizer registration accepts an Effect without typed failures or service
   requirements; close has no typed failure channel. This differs from
   `withResource`, whose release can add typed failures and requirements.
   Defects and interruption must not be converted silently to typed success.
   Making scope authority transferable does not by itself authorize an
   underlying borrowed resource or Fiber to escape. The checker and independent
   IR validator need the same lifetime rule and channel equations before emission.

These requirements describe full raw Scope parity. The implemented follow-up
contract specifies source syntax, shared authority, success-only close, and
concurrent close completion. General close Exits, parallel finalizer
strategies, and full defect aggregation remain outside that first slice.

## Options and disposition

| Option | Value and effort | Risk and accepted trade-off |
| --- | --- | --- |
| Keep current lexical forms and document the raw gap | No compiler maintenance; sufficient for the lexical witness immediately. | Cannot satisfy the returned live-scope contract. Retained lexical behavior. |
| Add a borrowed, explicitly closeable lexical scope | Smaller ownership surface than transferable scopes; implementation effort unmeasured. | Can add early close, but cannot claim parity with a scope returned beyond its owner. Requires its own bounded witness. |
| Add transferable close authority | Meets the stronger witness; implementation effort unmeasured and spans types, checking, IR, validation, and emission. | Raw behavior permits abandonment. The follow-up implements shared authority with preserved borrow restrictions and a close-completion barrier. |

The ownership boundary is specified in the follow-up contract above, with
eight additional target tests. It shares close authority without affine moves,
preserves borrow restrictions, and strengthens concurrent close completion.
The original full raw-Scope requirements remain a comparison point; arbitrary
close Exits are not included in the implemented first slice. Checked source
now meets the selected returned-live-scope contract with strict target and runtime checks.

The Stream/Schedule and Schema/ecosystem investigations are complete. This
scope witness does not establish full concurrency parity (queues,
synchronization, and arbitrary fiber APIs included).

## Reproduce and references

```sh
deno test --no-lock docs/plans/scope-probes/scopes.ts
deno test --no-lock --allow-all docs/plans/scope-probes/source_slow_test.ts
```

The probes use the pinned package source and declarations as the versioned
oracle. The [Effect scope guide](https://effect.website/docs/v4/resource-management/scope)
also distinguishes provision from closure; the
[fiber guide](https://effect.website/docs/v4/concurrency/fibers) describes
scope-bound forks. Related local decisions are the
[operation-record rule](2026-10-17-scoped-resource-design.md) and the current
[audit queue](../effect-4-gap-audit.md#follow-up-queue).

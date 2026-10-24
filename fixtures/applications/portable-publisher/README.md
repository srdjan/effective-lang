# Portable publisher application

This fixture publishes stored drafts through a source-owned workflow. Memory and
file-backed SQLite implement the same textual key-value contract.

Run these commands from the repository root:

```sh
deno task effektive build fixtures/applications/portable-publisher --validate --tsc
deno run --config fixtures/applications/portable-publisher/deno.json fixtures/applications/portable-publisher/main.ts
deno test --config fixtures/applications/portable-publisher/deno.json fixtures/applications/portable-publisher/runtime_test.ts fixtures/applications/portable-publisher/lifecycle_test.ts
deno test --allow-all tests/application_publisher_integration_slow_test.ts
```

The repository harness emits into a temporary directory. The SQLite child can
read and write only that directory. It receives no network permission.

The memory entry point performs no network or filesystem operations. Its clock
is fixed for repeatable output. The runner accepts a different clock function.

`domain.eff` contains pure assessment and planning. `ports.eff` owns feature
services. `feature.eff` imports only those two modules.

`platform.eff` defines generic storage, time, and lexical primitives. The
`storage.eff` adapter owns keys, decoding policy, and conditional publication.
`publisher.eff` supplies the feature services through source Layers.

The typed JSON bridge performs serialization and shape parsing. Source checks
article identity, revisions, and published content. The host reports trim-based
blankness and Unicode validity; source decides validity and keeps the original
text.

Storage uses nonempty, well-formed Unicode keys and well-formed textual
payloads. Key equality is exact, without normalization. Versions differ from
article revisions and never repeat within a store. SQLite persists its bigint
sequence as text to preserve versions after reopening.

Publication compares the token from its original read. A competing edit fails
that comparison, even when the edit incorrectly reuses the domain revision. The
workflow rereads one conflict and never retries a write. A failed reread
preserves the storage cause. An uncertain result can contain a committed write.

The memory factory exposes `control` for seeding and inspection. Source receives
only a scoped lease. Closing that lease invalidates its captured operations.

The batch completes commands in order. A terminal failure starts no later
command. Interruption awaits cleanup. Simultaneous execution and release
failures both remain in the runtime Cause.

`grants.eff` binds an authorized identifier to an already provided publication
operation. The issuer retains revocation. Revocation refuses later executions,
including deferred values created earlier. It does not cancel active work.

The automated checks include fourteen memory workflow cases and six lifecycle
and grant cases. One suite runs ten KV cases on each platform. Five additional
SQLite cases cover backend parity, cross-lease invalidation, opening failure,
persistence, and simulated acknowledgement loss after an actual commit.

Types with identity mark domain intent. Handwritten TypeScript can still construct
values of them, so the host boundary remains trusted.

These checks cover one process and local storage. They establish no HTTP
admission protocol, distributed transaction, crash recovery, or exactly-once
delivery. Synchronous SQLite calls finish before interruption can take effect.
The acknowledgement-loss case is a simulation, not a real storage outage.

The [gap assessment](../../../docs/plans/portable-applications-gaps.md) records
the original extension proposals. The user approved their separate
[implementation plan](../../../docs/plans/2026-10-23-portable-extensions.md).
This witness continues to use its existing language forms.

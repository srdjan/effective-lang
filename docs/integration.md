# HTTP and SQLite integration acceptance

The service-workflow fixture runs the existing `workflow.eff` orchestration
against a real loopback HTTP catalog and a temporary, file-backed SQLite
database. It uses Deno 2.9.8 and Effect 4.0.5. There are no new source forms or
changes to the host interface: the driver supplies `Catalog.price` and
`Runtime.database`, and the existing `StoreLive` adapter owns transactions and
receipt validation.

## Run the acceptance check

From the repository root:

```sh
deno test --allow-all tests/application_integration_slow_test.ts
```

The outer slow test checks, lowers, and independently validates the Effektive
project, emits its modules into a fresh temporary directory, copies the host
files there, and runs strict TypeScript checking and seven runtime integration
tests. The runtime subprocess receives read/write access to that directory and
network access to `127.0.0.1` only. It does not receive unrestricted subprocess,
filesystem, or network access. Dependencies use the fixture's pinned imports;
there is no remote database or catalog dependency.

The fixture's deterministic recording-driver checks run separately:

```sh
deno test --allow-all tests/application_slow_test.ts tests/application_service_workflow_test.ts
```

## What the integration establishes

| Case | Observed behavior |
| --- | --- |
| Successful submission | A loopback HTTP request supplies the price. Parameterized SQL persists the receipt. A newly opened SQLite connection reads the committed row, including a SKU containing quote and URL punctuation. |
| Schema and domain input rejection | Invalid input performs no catalog request and acquires no database connection. |
| Catalog failure | Malformed JSON, HTTP 503, wrong-type or fractional prices become `CatalogFailure`; out-of-range integer prices become `InvalidOrder`. No storage lease is acquired. |
| Permanent database failure | An actual SQLite CHECK constraint rejects the insert. The workflow rolls back and closes the connection without retry. |
| Invalid receipt after a real insert | A SQLite TEXT column returns the numeric total as text. `StoreLive` rejects that returned row, rolls back the already executed insert, and closes the connection. A reopened connection reads no rows. |
| HTTP cancellation | The test waits until the server has received a request before interrupting. Fetch receives its abort signal, no database connection is acquired, and the pending handler is released before server shutdown. |
| Transaction cancellation | The test waits until SQLite has executed the insert, then interrupts before row validation and commit. Interruption waits for real rollback and connection close. A second connection sees no committed row before or after cancellation. |

Each integration case owns a fresh database file and server. Connection leases
use Effect finalizers. The cancellation tests synchronize with promises and
Deferred values rather than timing sleeps. Deno's test resource and operation
sanitizers remain enabled. Tests reopen the actual database file to inspect
persisted state; event records supplement these observations.

## Driver boundary and limitations

The fixture driver binds SQL parameters through Deno's built-in
[`node:sqlite`](https://docs.deno.com/api/node/sqlite/) `DatabaseSync` API.
Synchronous SQLite calls complete before Effect can process interruption. The
post-insert synchronization point deliberately exercises cancellation while a
transaction remains open, rather than claiming that SQLite execution itself is
interruptible. Database errors in this integration driver are conservatively
permanent. Deterministic tests continue to cover transient retries and cleanup
defects.

These checks establish one process, one local SQLite transaction per storage
attempt, and a loopback catalog request before storage. They do not establish
distributed transactions, ambiguous-commit recovery, exactly-once submission,
source transaction callbacks, or manual release acceptance. Cancellation after
commit begins can still leave a committed row, as documented by the existing
workflow lifecycle tests.

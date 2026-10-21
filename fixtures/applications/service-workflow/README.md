# Service workflow application

This application uses existing Effective forms. Source code validates input,
checks business rules, obtains a catalog price and selects transient storage
retries. The registered StoreLive adapter supplies one atomic save operation.
The adapter uses the pinned native SqlClient transaction wrapper and validates
receipt rows before commit.

From the effective-lang repository root:

```sh
deno task effective build fixtures/applications/service-workflow --validate --tsc
deno run --config fixtures/applications/service-workflow/deno.json fixtures/applications/service-workflow/main.ts
deno test --config fixtures/applications/service-workflow/deno.json fixtures/applications/service-workflow/runtime_test.ts
```

Build writes generated TypeScript beside the source files. The repository test
runs compilation, strict host checks and application checks in a temporary
directory.

```sh
deno test --allow-all tests/application_service_workflow_test.ts tests/application_slow_test.ts
```

submit retains SchemaError, InvalidOrder, CatalogFailure and StoreFailure
channels. Its service requirements are Catalog.price and Runtime.database. The
registered provider discharges Store.save while retaining its database
requirement.

Invalid input causes no service calls. Quantity must be between 1 and 100. The
catalog driver validates safe integer prices; source requires prices between 0
and 100000. Each storage attempt acquires a connection, begins a transaction and
executes a parameterized insert. Failed writes or invalid receipt rows roll back
before release.

Only retryable statement failures become Transient StoreFailure values. Source
allows two additional attempts, after five and ten milliseconds. Retries
preserve the catalog result and wait for transaction cleanup. Provider, lease,
BEGIN and COMMIT failures remain Permanent. Mixed causes retain cleanup defects,
which prevent retry. Replaying one returned Effect starts a fresh workflow and
retry budget.

The runtime entry point may interrupt submit. Body interruption rolls back and
awaits connection release. Interruption after COMMIT starts waits for commit and
release; the committed row can remain. The application does not promise rollback
for every cancellation or exactly-once submission.

runtime_test.ts runs fifteen compiled application checks. The driver records one
statement shape in memory and performs no database or network I/O. The checks
establish the service workflow gate with a typed transaction adapter. The
simulated COMMIT error precedes committed-state mutation and proves no retry. It
does not establish actual ambiguous-commit behavior. See
[docs/status.md](../../../docs/status.md) for the project status.

The separate integration driver uses loopback HTTP and a temporary file-backed
SQLite database through Deno 2.9.7's `node:sqlite`. It supplies the same Catalog
and Runtime services to the unchanged `workflow.eff` and `StoreLive` adapter.
The recording driver and its deterministic tests remain in place.

```sh
deno test --allow-all tests/application_integration_slow_test.ts
```

This command compiles and independently validates the Effective program, checks
the emitted TypeScript and adapter, then runs seven integration cases outside
the checkout. The child process can read and write only its temporary directory
and use the loopback network. No external service or database installation is
required.

The cases verify persistence through a reopened SQLite connection, invalid
schema and business input, malformed and non-success HTTP responses, invalid
catalog prices, permanent SQL constraint failure, real rollback after receipt
validation fails, and cancellation during HTTP or after an actual SQL insert.
Pending requests and inserts have explicit synchronization points. Interruption
joins rollback and connection close; server handlers are released before
shutdown. SQLite failures are conservatively permanent in this driver. The
checks do not establish source transaction callbacks, distributed transactions,
ambiguous commit handling, or exactly-once submission.

See [integration acceptance](../../../docs/integration.md) for the boundaries
and verification commands.

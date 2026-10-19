# Schema and ecosystem adapter audit

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7.
Status: representative investigation complete; no new compiler form or package
import rule is implemented by this audit.

The follow-up [Schema/recursion contract](2026-10-18-schema-composition-recursion-contract.md)
implements a bounded source rule after two additional target composition probes.
The selected Schema composition and guarded recursive type forms now compile;
ecosystem package builders remain outside this adapter audit.

## Decision and acceptance measure

Use current typed adapters for concrete package operations. The selected HTTP,
SQL, RPC, AI, metric, and recursive-decoder operations all run through checked
Effective source. At the time of this adapter probe, first-class Schema values
and recursive source types were gaps; the follow-up contract now implements a
bounded form of each. Direct ecosystem builders remain a gap. A pure validation step followed by an
effectful source service call already expresses a useful concrete decoder;
that case does not require an effectful Codec builtin.

The acceptance measure is preservation of the selected operation's observable
result, declared failure and requirement channels, and resource lifetime.
The probes check source typing, independent IR validation, emitted target types,
runtime error translation, and cleanup after success, failure, and interruption.
They do not establish parity with an entire package from one adapter method.

The [Schema target probes](schema-adapter-probes/schema.ts) have three passing
tests. The [compiler/adapter probes](schema-adapter-probes/source_slow_test.ts)
have two passing tests covering source diagnostics and an emitted project using
the [host implementation](schema-adapter-probes/adapter.ts). All integrations
run locally: HTTP uses an in-memory Web Response, SQL a recording connection,
RPC local descriptors and serialization, AI a deterministic provider, and
metrics a local registry. No external server, database, model, or telemetry
exporter is contacted.

## Schema: preserve the two service directions

The target witness has this checked type:

```text
Schema.Codec<number, string, DecodeIndex, EncodeIndex>
             decoded encoded decoding R   encoding R
```

`Schema.decodeTo` and `SchemaTransformation.transformEffect` connect a string
schema to an integer schema. Decoding uses a lookup service; encoding uses a
different reverse-lookup service. Constructing the schema performs neither
operation. The target types of the two runners are checked separately:

```text
decode: Effect<number, SchemaError, DecodeIndex>
encode: Effect<string, SchemaError, EncodeIndex>
```

Providing only the corresponding service is sufficient for each direction.
The test observes `read:seven`, then `write:7`. An invalid input shape fails
before lookup. A lookup issue becomes `SchemaError`, while a defect remains
a defect. The pinned transformation callback's typed error is
`SchemaIssue.Issue`; the public parser wraps it in `SchemaError`. This witness
does not imply arbitrary application errors become a second Schema failure
parameter.

Current source `Codec<Decoded,Encoded>` instead contains pure decode/encode
functions, validates both sides with derived schemas, and returns `Option`.
An effectful callback is rejected with `execution-mode/001`, `codec
transformations must be pure`. A first-class `Schema<Int>` spelling fails
resolution with `unknown-name/001`.

### Equivalent concrete decoder in existing source

The [source fixture](schema-adapter-probes/main.eff) first runs `decode` with an
identity `Codec<Int,Int>`, then matches the Option and calls `Operations.lookup`
for a valid value. Invalid input raises the source nominal `AdapterError`.
Its emitted program returns `17` for input `7`, rejects a string without
calling lookup, and retains lookup's typed failure for a negative integer.
Only the two valid integer inputs call lookup.

This composition preserves the chosen validation/lookup behavior with explicit
nominal error translation. It does not construct a reusable Schema object,
retain Schema issue trees, or carry independent decoding and encoding service
sets. Those richer contracts remain uncovered; the concrete behavior alone
does not justify a new Codec operation.

### Rule needed before a general Schema form

A design must preserve decoded and encoded types and separate decoding and
encoding requirements. It must specify construction versus execution, schema
issue representation, validation on both sides, and translation into source
nominal errors without swallowing defects or interruption. It must also state
which schema values can feed HTTP, RPC, or AI builders. An opaque host Schema
handle would permit adapter use but would not provide source-authored schema
composition. Keep the current pure Codec contract unchanged unless a separate
compatibility decision explicitly replaces it.

## Recursive schemas: target support and a concrete host boundary

The target uses `Schema.suspend` to define a tree with a value and an array of
child trees. A depth-three value decodes and encodes successfully; a bad value
in a descendant fails with `SchemaError`. This tests finite recursive data,
not cyclic JavaScript object graphs or unbounded recursion depth.

The source declaration `type Tree = { value: int, children: Tree[] }` fails
with `declaration/007`, `the type Tree is defined in terms of itself`. Renaming
one record or encoding a tree as a flat table does not preserve that recursive
source type contract, though a flat representation may serve an application.

A host adapter can retain the richer type. The fixture's `Operations.tree`
parses a JSON string using a recursive Schema and returns the validated node
count as an Int. Effective source obtains count `2` for the selected nested
tree and a nominal `AdapterError` for a bad descendant. It does not receive a
native recursively typed tree or author its Schema.

The follow-up contract now supplies the array-guarded recursion rule, lazy
schema emission, and independent IR validation. This adapter witness does not
require user generics, mutual recursion, cyclic runtime
values, or a particular stack-safety guarantee; those need separate designs.

## Ecosystem operations through the existing host boundary

The fixture has three parts: [contracts.eff](schema-adapter-probes/contracts.eff)
declares concrete data, nominal errors, and services;
[host.effi](schema-adapter-probes/host.effi) declares providers and an opaque
borrowed session; and [main.eff](schema-adapter-probes/main.eff) authors the
calls, validation, provider composition, and resource brackets.

The strict target check includes host-provider and host-service assertions.
The adapter uses actual package constructors and operations, with the following
bounded outcomes:

| Family | Package API exercised locally | Source-visible outcome | What this does not establish |
| --- | --- | --- | --- |
| HTTP | `HttpApi`, group and endpoint builders; `HttpClientResponse.fromWeb` and `schemaJson` | Valid JSON body returns `7`; wrong body type becomes `AdapterError("http")`. | Server routing, a client request, middleware, streaming bodies, and connection cancellation. |
| SQL | `SqlClient.make`, tagged statements, and `withTransaction` over a recording scoped connection | Parameter `[7]` stays separate from SQL text; result `7`; success commits; failure and interruption roll back; all paths release the connection. | A real database dialect/driver, nested transactions, commit failure, transaction callbacks authored in source, and row streaming. |
| RPC | `Rpc.make`, payload/success schemas, NDJSON parser | A valid framed payload becomes `8`; invalid payload type becomes `AdapterError("rpc")`; a borrowed parser retains an incomplete frame across two pushes. | A client/server transport, middleware, cancellation protocol, request multiplexing, or streaming RPCs. |
| AI | `LanguageModel.make` and `generateText` with a deterministic provider | Effective passes a prompt and gets `"local model"`. | A real model, tool execution, structured output, token streaming, retries, and provider failure behavior. |
| Observability | `Metric.counter`, `Metric.update`, and `Metric.value` | Two source calls observe counts `1,2`. | Exporters, tracing, attribute cardinality, aggregation across processes, or a telemetry backend. |

These are concrete adapter successes. The HTTP API and RPC descriptors are
authored and retained in TypeScript; returning their identifiers does not make
the descriptors source-authored. SQL statement construction, AI provider
configuration, and Metric objects likewise stay on the host side.

### Failure and requirement contracts

The host provider has this checked target type:

```text
Layer<Operations, AdapterError, Policy>
```

Its `.effi` declaration says `fails AdapterError uses Policy.allow`. Source
wrappers discharge the Operations service through `provide` while retaining
`Policy.allow`. Removing those `uses` clauses produces
`requirement-contract/001`. A denying Policy fails acquisition with the same
nominal error before the selected HTTP operation runs.

The adapter deliberately maps typed package errors to `AdapterError`, retaining
an operation name rather than each package's detailed error object. This is an
explicit loss of detail in the chosen interface, not evidence of lossless error
parity. The HTTP, SQL, RPC, tree, and lookup failure cases check the nominal
error identity at runtime. Defects and interruption are not mapped to success.

### SQL lifetime witness

The recording driver observes these complete traces before the source call
returns or `Fiber.interrupt` completes:

```text
success:      lease, BEGIN, select ? as n, COMMIT, release
typed failure: lease, BEGIN, select ? as n, ROLLBACK, release
interruption:  lease, BEGIN, select ? as n, ROLLBACK, release
```

The connection finalizer yields before recording release. The database operation
is atomic from Effective's perspective; the adapter owns the transaction scope.
An acquisition/use/release bracket with a release callback that receives no
Exit should not be advertised as a general commit/rollback transaction API
without a separate rule.

### Borrowed stateful parser witness

The host interface exposes an opaque `Session`, `open`, borrow-qualified `push`
and `close`, and a provider. Source uses `withResource` and passes the session
through a checked borrow-qualified source helper. The session retains a split
NDJSON frame: its first push emits no message and the second emits one.

The pinned parser silently skips a malformed JSON line. The fixture records
zero messages for that case. A 65-character incomplete frame exceeds the
configured 64-character bound and becomes a nominal cursor error. The adapter
does not invent a malformed-frame error that the underlying parser did not
produce.

Across split-frame success, malformed-line success, buffer-limit failure, and
interruption, the source bracket runs close exactly once per session. Close
yields before completion; the final observed count is four. Attempting to
return a closure that captures the session is rejected with
`type-mismatch/010`: the use result must be data only and the borrowed handle
may only pass to a borrow-qualified method.

This verifies source enforcement and cooperative adapter behavior. TypeScript
adapters remain trusted: the host assertions cannot prove that a host method
obeys its borrow promise or that a fake driver models a production driver.

## Direct ecosystem composition: source rules still needed

Importing `effect/http-api/HttpApi` in `.eff` fails during project linking with
`module/001`: imports must be relative or use the registered `host:` prefix.
A `.effi` `const` declaration is rejected with `syntax/012`. A service method or
opaque handle can expose selected operations, but these rules do not import
arbitrary package constructors or values.

Before adding a native ecosystem form, specify its required object and effect
contract rather than selecting a package name alone:

- HTTP/RPC builders need schema-valued inputs, typed success/error contracts,
  middleware requirements, and transport ownership.
- SQL needs statement parameterization and transaction context/lifetime rules;
  result errors, commit errors, and interruption must remain distinguishable.
- AI needs concrete prompt/response/tool types, schema-valued structured output,
  tool failures and requirements, and streaming cancellation where selected.
- Metrics/tracing need a rule for object identity, attribute data, and which
  runtime or resource owns observation/export. A service method remains enough
  for the selected local counter operation.

These adapter probes do not test generic package imports or builder interfaces.
The later source fixture tests guarded recursive types and effectful Schema
composition directly.

## Options, next steps, and review

| Option | Value and trade-off | Disposition |
| --- | --- | --- |
| Typed adapters with concrete data and borrowed handles | Works now for the tested operations. Host implementation and nominal error translation remain explicit. | Selected current route. |
| Native Schema and recursive source data | Enables reusable decode and encode contracts for array-guarded records. | Implemented in the follow-up contract. |
| Arbitrary package imports and builder values | Broad surface but no established type/lifetime rule for the selected objects. | Not selected from this audit. |

The representative gap-investigation queue is complete. The inline tuple
emission defect from the
[Stream/Schedule audit](2026-10-18-general-stream-schedule-design.md) is repaired
and covered by strict target and runtime regressions. The next decision is
[Scope ownership](2026-10-18-explicit-scope-design.md). Stream/Sink/Schedule,
Schema, and ecosystem source extensions still require their individual design
decisions. Review a proposed extension against these witnesses; change the
native-support classification only when checked source, independent validation,
strict target typing, and runtime behavior preserve its selected contract.

## Reproduce and references

```sh
deno test --no-lock docs/plans/schema-adapter-probes/schema.ts
deno test --no-lock --allow-all docs/plans/schema-adapter-probes/source_slow_test.ts
```

The fixture host module is copied next to emitted `contracts.ts` by the compiler
probe; use the probe to build and run it. The pinned package source/declarations
and executable tests are the versioned oracle. Effect references:
[Schema transformations](https://effect.website/docs/v4/schema/transformations),
[HTTP API](https://effect.website/docs/v4/api/effect/http-api/HttpApi),
[SQL client](https://effect.website/docs/v4/api/effect/sql/SqlClient),
[language model](https://effect.website/docs/v4/api/effect/ai/LanguageModel).
Related local evidence: the earlier
[FileSystem adapter](../../fixtures/host-adapter-files/) and
[gap audit](../effect-4-gap-audit.md).

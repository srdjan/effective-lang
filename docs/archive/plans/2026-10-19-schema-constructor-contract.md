# Type-side Schema construction and explicit defaults

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded runner
implemented; the [nonrecursive constructor metadata extension](2026-10-19-schema-constructor-metadata-contract.md) now adds separate make-input types. The
[target probe](schema-adapter-probes/constructor-default.ts) has six passing
tests. The [source fixture](../../../fixtures/emit/schema-constructor.eff),
[compiled runtime witness](../../../tests/strict_target_slow_test.ts), and
[source and IR boundaries](../../../tests/schema_constructor_test.ts) cover the
selected rule. Effect's
[default constructor documentation](https://effect.website/docs/v4/schema/default-constructors)
and
[constructor default distinction](https://effect.website/docs/v4/schema/advanced-usage#default-values)
separate making decoded data from decoding wire input.

## Selected source rule

```text
schemaMake(Schema<D,E,RD,RE>, D) : D fails SchemaIssue
```

This shadowable, call-only builtin accepts an ordinary Schema and a checked
decoded value. Field descriptors, unknown inputs, encoded values that do not fit
D, incomplete records, and extra options are rejected. Schema.makeEffect
validates the type side and returns structured SchemaIssue directly. It neither
runs the wire decoder nor the encoder, and requires neither RD nor RE. Active
failures and services needed to evaluate either argument still propagate. The
Schema expression and input evaluate once each, in source order. Defects remain
defects; schemaMake does not turn them into SchemaIssue.

The existing Schema<D,E,RD,RE> type and wire optionality stay unchanged. Version
2 IR adds a schema-make runner expression with schema and input children.
Checking and independent validation recompute D input/output, the SchemaIssue
failure, and the arguments' active channels. The emitter calls makeEffect on the
evaluated Schema value.

## Defaults through factories

A factory supplies its own make-input type and fills defaults before calling
schemaMake. For example:

```effektive
type Int = int
type MakeInput = { score?: Int }
type Record = { score: Int }
const integer: Schema<Int> = schema()
const record: Schema<Record> = schemaStruct({ score: integer })
export const makeRecord = (input: MakeInput): Record fails SchemaIssue => {
  const score = match input.score { Some(value) => value, None => 4 }
  schemaMake(record, { score: score })
}
```

The factory accepts an absent score while the decoded record and its wire
representation still require it. Present values skip the default. Exact source
input types reject explicit undefined, matching Effect's exact make-input type;
the raw target and emitted factory both default it when supplied by host code.
Null remains present and is validated against D. Source optional reads preserve
null while mapping undefined to None.

Nested factories can materialize nested defaults and then validate the complete
outer D. A child factory's failure must receive its parent path explicitly:
catch SchemaIssue and rethrow schemaAt("settings", issue). Native nested
constructor metadata adds that path automatically. SchemaIssue catches and error
matches use SchemaIssue.isIssue because the target issue family has multiple
runtime tags. Mixed catch handlers dispatch only the original failure; errors
raised by a handler are not caught by another handler in that clause.

## Equivalent-program evidence and remaining gap

An ordinary source factory can express the selected missing/present/default
policy. The missing primitive was type-side validation with a structured issue
and no wire services. schemaDecode runs the wire decoder and returns
SchemaError. A second identity Schema plus schemaDecode can validate the data,
but its wrapped error does not expose the original issue tree in source. The new
runner preserves the constructor failure contract without adding default
metadata to every Schema.

The probes compare values observed at each execution, validation messages,
presence rules, and independent wire behavior. Native raw makeEffect replay with
constructor defaults can reuse its output object and overwrite a result retained
from an earlier execution. The explicit factory does not promise that aliasing
behavior. The probe records it separately, rather than claiming full constructor
equivalence from equal value snapshots.

Native constructor metadata is a further gap: it carries a make-input type M
distinct from both decoded D and encoded E, including defaults that return
nested make input rather than fully constructed D. A future rule must specify M
propagation through structs, arrays, unions, optional fields, recursive Schemas,
and host boundaries; whether a field already has a default; and replay identity.
The original four-parameter source Schema did not preserve that metadata. The
[metadata extension](2026-10-19-schema-constructor-metadata-contract.md) now
covers nonrecursive composition. This baseline addition does not expose native
constructor metadata, make options, skipped
validation, or the synchronous throwing and Option constructor methods.

## Verification

Six target probes cover constructor-only defaults, fresh callbacks, separate D,
E and make-input shapes, exact input typing versus raw undefined behavior,
validation issues, default failures and defects, nested defaults, and raw replay
identity. Three fast tests cover source contracts and independent IR mutations.
The strict compiled witness compares ordinary and nested factories with native
constructor values and issue paths, verifies that construction needs no wire
services, preserves argument services and order, distinguishes SchemaIssue from
SchemaError, and exercises predicate-based mixed error matching and catches.

The [metadata extension](2026-10-19-schema-constructor-metadata-contract.md)
now supplies nonrecursive constructor-default fields and propagates M through
selected composition forms. The optional-adapter and
[recursive extensions](2026-10-19-schema-constructor-recursive-contract.md) now
propagate M through those forms. The
[wire extension](2026-10-19-schema-recursive-wire-contract.md) also permits distinct
recursive D/E. The [field-default extension](2026-10-19-schema-constructor-fields-contract.md)
now attaches constructor defaults to field descriptors. The
[adapter-order extension](2026-10-19-schema-constructor-order-contract.md) also
specifies retained, target and reset defaults. Guarded recursive self use through
field adapters remains open. Broader package interoperability, item 9, stays deferred
by user instruction.

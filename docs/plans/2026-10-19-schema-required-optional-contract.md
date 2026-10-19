# Required encoded to optional decoded Schema fields

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded source
slice implemented. The [pinned target probe](schema-adapter-probes/required-optional.ts)
has three passing tests. The
[source boundary probe](schema-adapter-probes/required-optional-source_slow_test.ts)
and [compiled runtime witness](../../tests/schema_required_optional_slow_test.ts)
exercise the selected source rule.

## Boundary and decision

The target permits `Schema.String.pipe(Schema.decodeTo(Schema.optionalKey(...),
...))`. Its inferred encoded record type requires the key, but decoding `{}`
still invokes the optional getter with `None` and can succeed. The source must
not present that unguarded builder as a required encoded field. An existing
`schemaOptionalTransform(schemaOptionalKey(source), target, ...)` can express
the permissive runtime behavior with an exact optional encoded type.

`schemaOptionalFromRequired` instead supplies a guarded, required encoded
contract:

```text
schemaOptionalFromRequired(
  Schema<S,E,RSD,RSE>, SchemaOptional<T,U,RTD,RTE>,
  (S) -> Option<U> [fails SchemaIssue] [uses RDec],
  (Option<U>) -> S [fails SchemaIssue] [uses REnc])
  : SchemaDecodedOptional<T,E,RSD | RTD | RDec,RSE | RTE | REnc>
```

The brackets describe optional callback clauses. `SchemaDecodedOptional` is a
struct-field descriptor, not a runnable Schema. It produces an exact optional
decoded key and a required encoded key. It cannot be used as an array element,
Schema runner, or ordinary Schema value. This adds the `decodedOptionalKey`
flag to the version 2 IR Schema type and the `optional-from-required` Schema
operation. The checker and independent validator derive decoded and encoded
record optionality separately and reject conflicting descriptor flags.

The decode getter first requires an actual encoded key. If it is absent, the
emitted getter fails with `SchemaIssue.InvalidValue`; the target wraps that as
`SchemaError` at the field path. It does not invoke the source callback or its
services. A present key is validated by the source Schema before the callback
receives decoded `S`. The callback returns `Some(U)` to emit the decoded field
or `None` to omit it. A present `undefined` remains invalid when the source
Schema rejects it. The callback may be pure or effectful, with no typed failure
or exactly `SchemaIssue`; authored issues retain their paths. Defects and
interruption retain their causes.

On encode, the callback receives `None` for a missing decoded key and `Some(U)`
for a present validated key. It must return a required `S`; the emitter wraps
that value in `Some` before the target's required source Schema encodes it.
Thus encoding always emits the key on success. Decode and encode callback
services join only their own direction. Both callbacks must be inline. The
source constructors are shadowable and do no decoding or service work during
construction.

The target probe records the raw mismatch, the missing-key guard, required
static encoded type, omission of a present decoded value, restoration on
encoding, exact `undefined` rejection, and separate services. The compiled
witness checks pure and effectful callbacks, paths and authored issues,
directional services, defects, interruption, and strict TypeScript. Source
probes reject wrong field descriptors, callback types, unrelated failures,
and direct runner use. Independent IR mutations reject lost optionality,
callback-channel forgery, and conflicting flags.

The [general-union extension](2026-10-19-schema-general-union-contract.md)
now covers branch backtracking. Nullable optional keys and arbitrary Schema
AST construction remain separate work. Broader package interoperability stays
deferred by user instruction.

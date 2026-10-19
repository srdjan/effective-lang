# Optional Schema fields, defaults, and Option conversion

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded source
slice implemented. The
[pinned target probe](schema-adapter-probes/optional-transform-defaults.ts) has
seven passing tests. The
[source boundary probe](schema-adapter-probes/optional-transform-source_slow_test.ts)
now checks accepted forms and rejection boundaries. The
[compiled fixture](../../fixtures/emit/schema-optional-transform.eff) and
[runtime test](../../tests/schema_optional_transform_slow_test.ts) cover strict
emission, behavior, and independent validation.
This contract pins the pure baseline. The
[effectful callback extension](2026-10-19-schema-effectful-optional-contract.md)
adds directional callback services and bounded authored failures to the same
source constructors.
The [required-to-optional extension](2026-10-19-schema-required-optional-contract.md)
adds a guarded decoded-only optional field descriptor with a required encoded
key.

## Decision

Extend the
[exact optional-field rule](2026-10-18-schema-optional-union-issues-contract.md)
with three bounded source forms:

```text
schemaOptionFromOptionalKey(Schema<D,E,RD,RE>)
  : SchemaEncodedOptional<Option<D>,E,RD,RE>

schemaDefaultKey(Schema<D,E,RD,RE>, () -> D)
  : SchemaEncodedOptional<D,E,RD,RE>

schemaOptionalTransform(
  SchemaOptional<S,E,RSD,RSE>, SchemaOptional<T,U,RTD,RTE>,
  (Option<S>) -> Option<U>, (Option<U>) -> Option<S>)
  : SchemaOptional<T,E,RSD | RTD,RSE | RTE>
```

`SchemaEncodedOptional` is a field descriptor, usable only within
`schemaStruct`, with a required decoded field and an exact optional encoded key.
`SchemaOptional` remains optional on both sides. Neither descriptor is a
runnable Schema value or valid Schema data. The checker and independent IR
validator must track decoded and encoded key optionality separately; a single
`optionalKey` flag cannot express the new shape. `schemaStruct` must derive both
record types and direction-specific service unions from those flags. The emitted
TypeScript field type must retain the same side-specific optionality, including
exact optional property types.

All three forms are source-level, call-only, shadowable constructors.
`schemaOptionFromOptionalKey` maps a missing encoded key to a present decoded
`None`, and a present valid value to `Some(decodedValue)`. Encoding `None` omits
the key; `Some` invokes the field's encoding Schema. A present `undefined` must
fail unless the wrapped Schema itself accepts it. Missing and `None` skip the
wrapped field transformation and its services. The field's decode and encode
requirements stay in the static type even though they may be skipped
dynamically. Emit the pinned `Schema.OptionFromOptionalKey` builder.

`schemaDefaultKey` calls its pure, zero-argument default callback for each
decode where the key is absent, after execution begins. A present value,
including an invalid `undefined`, never invokes the callback. The callback
returns a decoded `D`; it must have no typed failures or service requirements.
Encoding always includes the supplied decoded value and runs the wrapped field
Schema, matching the target's default `"passthrough"` encoding strategy.
Construct the target with `Schema.withDecodingDefaultTypeKey` and a deferred
`Effect` that invokes the source callback. The target also offers an `"omit"`
encoding strategy; it would discard every field value, not merely the default,
so this source form does not expose it.

`schemaOptionalTransform` accepts only exact optional descriptors on both sides
in this slice. Its callbacks are pure, inline, and have no typed failures or
requirements. The decode callback receives `None` when the encoded key is absent
and `Some(S)` after the source field Schema decodes a present value. It returns
`None` to omit the decoded key or `Some(U)` to validate and emit the target
field. Encoding applies the inverse callback from decoded `Option<U>` to source
`Option<S>`. The source and target field Schemas contribute their existing
direction-specific requirements. A present `undefined` fails before the callback
if the source field rejects it. Emit `Schema.decodeTo` with
`SchemaGetter.transformOptional` in both directions. The checker and validator
must reject a forged descriptor, callback type, effect, or failure channel.

The source spelling to accept after implementation has this shape:

```text
type Int = int
const integer: Schema<Int> = schema()
const option = schemaStruct({
  score: schemaOptionFromOptionalKey(integer)
})
const defaulted = schemaStruct({
  score: schemaDefaultKey(integer, (): Int => 1)
})
const normalized = schemaStruct({
  score: schemaOptionalTransform(
    schemaOptionalKey(integer), schemaOptionalKey(integer),
    (value: Option<Int>): Option<Int> => value,
    (value: Option<Int>): Option<Int> => value)
})
```

## Target evidence and boundary

The target probe establishes exact missing-key `Option` conversion, directional
service propagation and dynamic skipping, a per-execution default, passthrough
and omit encoding strategies, optional-to-optional omission, and
optional-to-required defaults. It also records two limits that affect source
design. An optional-to-required getter returning `None` fails because the
decoded key is required. A required-to-optional getter in the pinned target
accepts a missing encoded key despite its required encoded field type. The
source must not promise an exact required encoded key through that builder
without a separate guard and regression rule. The first slice therefore does not
include required-to-optional transformation or general field optionality
changes. General nullable and undefined-tolerant optional fields remain separate
from exact optional keys.

Effectful optional getters, authored `SchemaIssue` failures from those getters,
defaults that require services or fail, alternate encoding strategies, and
constructor defaults need their own rule. General union backtracking and
external package builders remain outside this slice; package interoperability is
deferred by user instruction.

## Acceptance gate

Resolution, parser/type support for `SchemaEncodedOptional`, checking, IR
serialization, independent validation, and typed emission now cover the three
forms. The compiled fixture tests missing, present, and present-`undefined`
fields; omission by optional-to-optional callbacks; Option `None` and `Some`;
default passthrough; repeated execution; and separate decode and encode
services. The target probe separately verifies per-decode default invocation
counts. Negative source cases reject descriptor use as a runner, bad callbacks,
and effects in default/optional callbacks. Independent validator mutations
reject forged encoded-only optionality and callback failure. The canonical spec
and IR rule record the selected slice. The full compiler gate passed, as did the
canonical site's 11 tests and 30 strict illustrative units.

```sh
deno test --no-lock docs/plans/schema-adapter-probes/optional-transform-defaults.ts
deno test --no-lock --allow-all docs/plans/schema-adapter-probes/optional-transform-source_slow_test.ts
deno test --no-lock --allow-all tests/schema_optional_transform_slow_test.ts
deno task check
```

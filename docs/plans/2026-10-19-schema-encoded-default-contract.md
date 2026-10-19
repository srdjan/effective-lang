# Encoded-value Schema defaults

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented. The
[target probe](schema-adapter-probes/encoded-default.ts) has six passing tests.
The [source fixture](../../fixtures/emit/schema-encoded-default.eff),
[compiled runtime witness](../../tests/schema_encoded_default_slow_test.ts), and
[source and independent IR checks](../../tests/schema_encoded_default_test.ts)
cover the selected contract. The pinned Schema.withDecodingDefaultKey
implementation specifies defaults in Encoded rather than Type. The official
[default documentation](https://effect.website/docs/v4/schema/advanced-usage#default-for-a-missing-key)
describes decoded defaults through withDecodingDefaultTypeKey; the pinned API
additionally exposes encoded defaults.

## Source rule

```text
schemaDefaultEncodedKey(Schema<D,E,RD,RE>,
                        () -> E [fails SchemaIssue | SchemaError] [uses RDefault],
                        { encodingStrategy: "passthrough" | "omit" }?)
  : SchemaEncodedOptional<D,E,RD | RDefault,RE>
```

The callback is inline and takes no arguments. It returns encoded E, may be pure
or effectful, and may declare no typed failure, exactly SchemaIssue, or exactly
SchemaError. A callback declaring both failure types is rejected. Options use
the existing literal default encoding rule. The two-argument form selects
passthrough. The constructor is shadowable and call-only, accepts an ordinary
Schema, and returns a struct-only field descriptor.

The decoded field remains required and the encoded field becomes exact optional.
Construction evaluates the Schema argument once without running the default. A
missing-key decode runs a fresh callback, validates its encoded result, and runs
the wrapped decoder to produce D. A present valid E skips the default and runs
the same decoder. Present invalid E and explicit undefined fail without calling
the default. Present null skips the default and decodes normally if E admits
null; otherwise it fails.

Default services join RD, alongside wrapped decoder services. Default and
decoder issues become SchemaError at the field path; defects retain their
channel, and cancellation waits for cleanup in either stage. Encoding requires
only RE and never evaluates the default.

| Strategy               | Encoding a valid D                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Omitted or passthrough | Run the wrapped encoder, validate its E, and write the field.                           |
| omit                   | Run the wrapped encoder and validate its E, then discard the result and omit the field. |

Unlike schemaDefaultKey and schemaDefaultNullKey, encoded-default omission
retains runtime encoder calls, services, typed failures, defects, and
interruption. It drops every successful value without comparing it with a
default. Present invalid D still fails validation. Source schemaEncode requires
the full decoded record.

## Equivalent-program investigation

For passthrough, the existing decoded default can explicitly decode a generated
E inside its callback:

```text
schemaDefaultKey(source, () -> schemaDecode(source, makeEncoded()))
```

With a SchemaError-failing generator, this composition has the same directional
requirements, results, service trace, observable error messages, and cleanup in
the selected tests. It is useful source composition, but does not reproduce the
target's omit behavior. Under omit, the outer decoded-default operation skips
the wrapped encoder. The native encoded-default operation runs that encoder
before omission. A failing encoder makes the native program fail while the
decoded-default composition succeeds with an absent field.

Existing optional transformations can omit an encoded key after work, but retain
optional decoded fields. Option-from-optional-key requires an Option decoded
value. Neither has this reusable required-D field contract. A whole-record
transformation can implement a particular application, but does not provide the
selected reusable field descriptor. This behavior selects the new constructor.

## Lowering and evidence

Version 2 IR adds the default-encoded-key Schema operation with two or three
arguments. No new descriptor type is needed. Checking and independent validation
select E for the callback result, retain required decoded and optional encoded
fields, enforce literal options and bounded callback failures, and recompute
directional services.

The emitter defers the callback through Effect.sync or Effect.suspend, converts
authored SchemaIssue failures to SchemaError, and applies
Schema.withDecodingDefaultKey. The TypeScript representation of the existing
encoded-only optional descriptor now leaves the intermediate decoded Schema's
Encoded type unknown. That intermediate type differs between the encoded and
decoded default builders; the public decoded D, encoded E, presence metadata,
and service channels remain precise.

Six target tests compare the composition with the native builder, including the
omit distinction, fresh defaults, exact presence, invalid generated values,
error messages and paths, refined encoded-value validation, encoder failures and
defects, and cancellation during generation, decoding, and omitted encoding. The
compiled witness covers both callback failure forms, pure and nullable defaults,
source runners, the same omit distinction, and all three cleanup stages.
Independent mutations reject swapped decoded/encoded operations, forged field
presence, and invalid policies.

The [type-side construction slice](2026-10-19-schema-constructor-contract.md)
now adds schemaMake and explicit source factories for selected construction
defaults. General constructor metadata and make-input propagation remain open. Equality-based
omission and arbitrary Schema AST construction remain separate work. Broader
package interoperability, item 9, remains deferred by user instruction.

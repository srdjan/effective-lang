# Nullable exact optional Schema fields

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented within
the selected source data and Schema subset. The
[pinned target probe](schema-adapter-probes/nullable-optional.ts) has four
passing tests. The
[source fixture](../../../fixtures/emit/schema-nullable-optional.eff) and
[compiled runtime witness](../../../tests/strict_target_slow_test.ts)
check both directions, strict TypeScript, and independent IR validation. The
[source boundary tests](../../../tests/null_test.ts) cover inference, finite
matches, equality, and rejected operations.

## Data rule

Add the singleton data literal and type `null`. It fits itself and unions
containing itself, and remains a singleton during inference. It does not fit
strings, numbers, booleans, or `void`. The existing primitive-position rule
applies: write `type Nil = null`, then use `Nil` in annotations outside type or
error declarations. A nullable declaration such as
`type NullableName = string | null` needs no new type constructor.

Source `null` emits JavaScript `null`. The version 2 IR permits `null` in
literal types and literal patterns and adds a leaf expression
`{ kind: "null" }`. The existing `{ kind: "literal", value: null }` remains the
unit marker, which emits `undefined`. Independent validation derives a null
expression's singleton type from its kind; it never trusts its annotation to
distinguish null from unit. Mutations that forge numeric or unit annotations
fail.

Finite literal matches may include `null`. Equality with a singleton null
operand accepts a nullable opposite operand in either order. This does not add
flow narrowing or change the existing match domains for open unions. Null does
not become numeric during stream-state or Ref inference and is not a valid
grouping key. Source `undefined` values and undefined-tolerant field types
remain outside this slice.

## Schema rule

Existing builders express nullable exact optional keys:

```text
type Text = string
type Nil = null
type Nullable = Text | Nil
type Input = { name?: Nullable }
const text: Schema<Text> = schema()
const nil: Schema<Nil> = schema()
const nullable: Schema<Nullable> = schemaUnion([text, nil])
const record: Schema<Input> = schemaStruct({ name: schemaOptionalKey(nullable) })
```

The backend emits `Schema.Null` for the null singleton and a Schema union for
null combined with other literals. `Schema.Literal` and `Schema.Literals` do not
accept null in the pinned target.

| Encoded field       | Decoded exact optional field    | Wrapped text transformation |
| ------------------- | ------------------------------- | --------------------------- |
| Missing             | Missing                         | Skipped                     |
| Present `null`      | Present `null`                  | Skipped                     |
| Present valid text  | Present decoded text            | Runs                        |
| Present `undefined` | `SchemaError` at the field path | Skipped                     |

For the separate null-as-missing policy, add the call-only, shadowable
constructor:

```text
schemaNullToMissingKey(Schema<D,E,RD,RE>)
  : SchemaOptional<D,E | null,RD,RE>
```

Both D and E must exclude null. A missing or null encoded field decodes to an
absent key, and a present E decodes through the wrapped Schema. Encoding an
absent key omits it; encoding a present D runs the wrapped encoder. It never
writes null. Explicit undefined still fails. The result is a struct-only field
descriptor and cannot be run directly. The version 2 Schema operation union adds
`null-to-missing-key`. The checker and independent validator reject nullable
wrapped sides, other field descriptors, and forged annotations. The emitter
evaluates its Schema argument once and composes `optionalKey(NullOr(schema))`,
`toType(schema)`, and a null-filtering optional getter. Its decode and encode
services remain directional.

Encoding preserves the same presence distinction. Decode and encode service
requirements remain separate and include the wrapped text branch even when a
missing or null value skips it. A defect in a text transformation remains a
defect; a null value can bypass that transformation.

`schemaOptionFromOptionalKey(nullable)` maps a missing encoded key to a required
`None`, while a present null becomes `Some(null)`. Encoding reverses that
distinction. `schemaDefaultKey(nullable, callback)` calls its default only for a
missing key. A present null bypasses the callback, and encoding null includes
the key under passthrough. This follows the existing default rule and the
target's
[optional-field distinction](https://effect.website/docs/v4/schema/advanced-usage#default-for-a-missing-key).
The missing-key default does not treat null as missing; null-as-missing fields
require the explicit constructor above.

The [default encoding extension](2026-10-19-schema-default-encoding-contract.md)
now adds explicit passthrough and unconditional omission, including omission of
nullable values. The [missing-or-null default extension](2026-10-19-schema-null-default-contract.md)
now adds an explicit required-field default constructor. Arbitrary Schema AST
construction and source-side schema annotations remain separate work. Broader
package interoperability stays deferred by user instruction.

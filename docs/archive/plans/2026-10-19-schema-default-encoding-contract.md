# Schema default encoding strategies

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented. The
[pinned target probe](schema-adapter-probes/default-encoding.ts) has four
passing tests. The
[source fixture](../../../fixtures/emit/schema-default-encoding.eff),
[compiled runtime witness](../../../tests/strict_target_slow_test.ts),
and [source boundary tests](../../../tests/schema_default_encoding_test.ts) cover
the selected rule. The target API's `DecodingDefaultOptions` and
`withDecodingDefaultTypeKey` implementation are pinned to Effect 4.0.5; the
[default documentation](https://effect.website/docs/v4/schema/advanced-usage#default-for-a-missing-key)
describes the missing-key decoding boundary.

## Source rule

Extend the existing shadowable, call-only constructor with an optional third
argument:

```text
schemaDefaultKey(Schema<D,E,RD,RE>, () -> D [fails SchemaIssue | SchemaError] [uses RDefault],
                 { encodingStrategy: "passthrough" | "omit" }?)
  : SchemaEncodedOptional<D,E,RD | RDefault,RE>
```

The failure notation permits no failure, exactly SchemaIssue, or exactly
SchemaError; it does not permit a callback to declare both failure types.
Callbacks remain inline. Options must be an inline record with exactly one
ordinary field, `encodingStrategy`, and its value must be a literal `"omit"` or
`"passthrough"`. Named records, dynamic values, spreads, shorthand fields,
duplicate keys, and extra fields are rejected. Omitting the third argument
retains the original passthrough behavior.

The decoded field stays required, and the encoded field stays exact optional
under both strategies. Source `schemaEncode` still requires the decoded record.
Decoding does not depend on the strategy: each missing-key decode runs a fresh
default, present values skip the default, and explicit undefined fails. Defaults
return decoded D and bypass the wrapped decoding transform. Default services
join only RD; callback issues retain the existing SchemaError conversion, paths,
defects, and interruption behavior.

| Strategy                   | Encoding a present, valid decoded value                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Omitted or `"passthrough"` | Run the wrapped encoder and include its E value.                                                       |
| `"omit"`                   | Omit every value, including non-default values and null where D admits null; skip the wrapped encoder. |

Omission is unconditional. It neither evaluates the default callback nor
compares the value with a default. Present invalid decoded values still fail
validation at the field path before omission. Encoder issues and defects are
observable under passthrough; omission skips that encoder and its services. The
static RE requirement is retained under omission, matching the pinned target
type, just as other optional fields retain services that may be skipped.

The target's unknown-input host encoder can accept an absent decoded key for
this defaulted descriptor, despite its required Type. The source encoder accepts
only the checked decoded record, so the source boundary rejects that input. The
probe records the host behavior without expanding the source API.

## Implementation and boundaries

The existing version 2 `default-key` Schema operation carries either two or
three argument expressions. No new type or field descriptor is needed. The
checker and independent validator recompute the same directional requirements
for both strategies and validate the exact options shape. The emitter passes the
options to `Schema.withDecodingDefaultTypeKey`; it retains the deferred default
callback and existing issue conversion.

The runtime witness covers pure and effectful defaults, repeated missing-key
decodes, explicit and implicit passthrough, omission of unequal and nullable
values, skipped encoder calls, retained validation, and failure channels.
Independent IR mutations reject unknown strategies and erased static encoder
requirements. The
[original default contract](2026-10-19-schema-optional-transform-defaults-contract.md)
records the two-argument baseline; this extension adds the target's omission
strategy.

The [missing-or-null default extension](2026-10-19-schema-null-default-contract.md)
now reuses these encoding options with an explicit null trigger. The
[encoded-value default extension](2026-10-19-schema-encoded-default-contract.md)
retains wrapped encoder work before omission, matching its distinct target
ordering. Equality-based omission, constructor defaults, and arbitrary Schema
AST construction remain separate work. Broader package interoperability stays deferred by user
instruction.

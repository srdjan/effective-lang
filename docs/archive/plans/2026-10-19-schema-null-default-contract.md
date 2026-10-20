# Schema defaults for missing or null keys

Note, 2026-10-20: the names `schemaDefaultNullKey` and `schemaDefaultEncodedKey` no longer exist in the language. Write `schemaDefaultKey(schema, callback, { on: "null" })` and `schemaDefaultKey(schema, callback, { on: "encoded" })`. The option `on` is `"missing"` by default, so a call without `on` keeps its earlier meaning. The IR operations `default-null-key` and `default-encoded-key` are unchanged, and the rules below hold for the matching `on` value. Read each old name below as that `on` value.

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented. The
[target probe](schema-adapter-probes/null-default.ts) has five passing tests.
The [source fixture](../../../fixtures/emit/schema-null-default.eff),
[compiled runtime witness](../../../tests/strict_target_slow_test.ts), and
[source and IR boundaries](../../../tests/schema_null_default_test.ts) cover the
selected rule. The target composition follows the official
[missing-or-null default example](https://effect.website/docs/v4/schema/advanced-usage#default-for-a-missing-or-null-key),
extended with effectful decoded defaults and explicit encoding strategies.

## Source rule

```text
schemaDefaultNullKey(Schema<D,E,RD,RE>,
                     () -> D [fails SchemaIssue | SchemaError] [uses RDefault],
                     { encodingStrategy: "passthrough" | "omit" }?)
  : SchemaEncodedOptional<D,E | null,RD | RDefault,RE>
```

Both D and E must exclude null. The callback must be inline, take no arguments,
and return decoded D. It may be pure or effectful and declare no typed failure,
exactly SchemaIssue, or exactly SchemaError. Declaring both failure types is
rejected. Options follow the existing default encoding rule: exactly one
ordinary inline record field containing a literal encodingStrategy. The
two-argument form selects passthrough.

The constructor is shadowable and call-only. It accepts an ordinary Schema and
produces a struct-only field descriptor. Construction evaluates the Schema
argument once and does not run the default. The decoded field is required and
excludes null; the encoded field is exact optional and admits null.

| Input key on decode            | Result                                     |
| ------------------------------ | ------------------------------------------ |
| Absent                         | Run a fresh default callback.              |
| Present null                   | Run a fresh default callback.              |
| Present valid E                | Run the wrapped decoder; skip the default. |
| Present undefined or invalid E | Fail with SchemaError; skip the default.   |

The default is a decoded value, so it bypasses the wrapped transformation and
validates against D. It runs once per missing-or-null decode, including repeated
executions of the same effect. Default services join only RD. Missing and null
keys skip runtime wrapped-decoder calls while retaining their static RD.
SchemaIssue and SchemaError callbacks retain the field path in the runner's
SchemaError. Defects keep their channel; interruption waits for callback
finalizers.

Passthrough encoding runs the wrapped encoder and writes E. Omit encoding drops
every valid decoded value and skips the wrapped encoder, retaining static RE.
Neither strategy runs the default. Present invalid decoded values still fail
before omission. Encoding never synthesizes null. Source schemaEncode requires
the decoded record, including its required nonnullable field.

## Why a constructor is needed

The existing schemaDefaultKey only defaults absent keys. Wrapping a nullable
Schema preserves present null instead of calling the default.
schemaNullToMissingKey removes null, but returns SchemaOptional, which cannot be
passed to the ordinary-Schema default constructor. schemaOptionalTransform also
returns an optional decoded field, rather than the required field this rule
promises. None expresses this exact source contract.

The explicit constructor leaves the existing missing-key behavior intact.
Requiring nonnullable channels prevents conflating a wrapped transformation's
valid null result with a request to run the default.

## Lowering and evidence

Version 2 IR adds the Schema operation default-null-key with two or three
arguments. Its output uses the existing encoded-only optional descriptor; no new
type is needed. The checker and independent validator enforce nullable
boundaries, callback failures, literal options, and directional services.

The emitter binds the source Schema once. It wraps it with
Schema.optionalKey(Schema.NullOr(source)), then decodes to
Schema.toType(source). The effectful decode getter removes null from its
presence Option and runs the default only for None. A present decoded value
passes through unchanged. SchemaError callbacks supply their issue to the
getter; SchemaIssue callbacks already supply its error type. The encode getter
is passthrough or omit. This direct composition preserves the target's exact
optional-key metadata and the existing source descriptor's target type.

Five target tests cover fresh defaults, transformed values, exact presence,
directional services, omission, authored errors, defects, and interruption. The
strict compiled witness repeats these behaviors through source constructors and
both runners, including pure, SchemaIssue, and SchemaError defaults. Source and
independent IR tests reject invalid callbacks, wrapped nullable channels,
descriptor runners, malformed strategies, and forged channel types. The target
probe also preserves present undefined when a raw Schema.Void accepts it,
including a transformation that produces unit; source Schema data already
excludes unit. The getter tests presence alone, avoiding the generic withDefault
getter's additional undefined trigger.

The [encoded-value default extension](2026-10-19-schema-encoded-default-contract.md)
now adds defaults that run through the wrapped decoder, with encoder work
retained before omission. Constructor defaults and arbitrary Schema AST
construction remain separate work. Broader
package interoperability, item 9, stays deferred by user instruction.

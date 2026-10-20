# Effectful optional Schema getters and defaults

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded source
slice implemented. The
[target probe](schema-adapter-probes/effectful-optional.ts) has five passing
tests; the
[compiled runtime witness](../../../tests/strict_target_slow_test.ts)
checks strict emission and independent validation. This extends the
[optional-field contract](2026-10-19-schema-optional-transform-defaults-contract.md)
without adding a new source constructor or IR operation.

## Selected rule

Keep the existing `schemaOptionalTransform` and `schemaDefaultKey` syntax and
allow effectful inline callbacks with bounded failure channels:

```text
schemaOptionalTransform(
  SchemaOptional<S,E,RSD,RSE>, SchemaOptional<T,U,RTD,RTE>,
  (Option<S>) -> Option<U> [fails SchemaIssue] [uses RDec],
  (Option<U>) -> Option<S> [fails SchemaIssue] [uses REnc])
  : SchemaOptional<T,E,RSD | RTD | RDec,RSE | RTE | REnc>

schemaDefaultKey(Schema<D,E,RD,RE>,
  () -> D [fails SchemaIssue | SchemaError] [uses RDefault])
  : SchemaEncodedOptional<D,E,RD | RDefault,RE>
```

The brackets describe optional clauses, not source punctuation. Each optional
getter callback still receives and returns a directional `Option` value, even
when it can fail. `None` means a missing key. A callback runs on both missing
and present keys; the wrapped field Schema checks a present key before the
decode callback. Decode and encode callbacks contribute requirements only to
their own direction. An authored `SchemaIssue` failure reaches the target getter
unchanged and is wrapped by the runner as `SchemaError`, with the field path.
Defects and interruption retain their causes. Emit pure callbacks through
`SchemaGetter.transformOptional` and effectful callbacks through
`SchemaGetter.transformOptionalEffect`. No other typed callback failure is
implicitly translated.

The default callback runs once for each missing-key decode, after execution
begins; a present key does not run it. Its requirements join decode requirements
only. It returns decoded `D`, with no `Option` wrapper. A callback failure of
`SchemaIssue` is converted to `new Schema.SchemaError(issue)` at the emitted
boundary, retaining the issue tree and target-added field path. An existing
`SchemaError`, such as one from `schemaDecode`, passes through unchanged.
Defects and interruption stay outside that typed error. Emit pure callbacks in
`Effect.sync`; invoke effectful callbacks within `Effect.suspend` so each decode
gets a fresh invocation. The target builder remains
`Schema.withDecodingDefaultTypeKey` with passthrough encoding.

The source checker and independent validator must require inline callbacks,
directional input/output types, and a failure set of either empty or the one
selected type. They must reject mixed, unrelated, or forged failures and
incorrect requirement unions. The old pure forms remain accepted. The
`SchemaEncodedOptional` and `SchemaOptional` type and IR shapes remain the same;
their direction-specific requirement sets now include callback services.

Target tests establish missing and present getter calls, separate decode and
encode services, issue paths, defects, interruption, per-decode default calls,
and decode-only default requirements. General required-to-optional field
transformations, alternate default encoding strategies, and constructor defaults
stay outside this slice. Broader package interoperability remains deferred by
user instruction.

## Verification

The [source probe](schema-adapter-probes/optional-transform-source_slow_test.ts)
accepts effectful callbacks with allowed failures and rejects unrelated failures
and mismatched directional values. The strict compiled witness uses different
getter services by direction and a decode-only default service. It checks
missing and present calls, repeated default execution, authored issue paths, and
defects. Independent IR mutations reject a wrong getter failure, a wrong default
failure, and a missing callback service in the resulting type. The target probe
separately checks interruption.

# Separate recursive decoded and encoded Schema types

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends [recursive constructor inputs](2026-10-19-schema-constructor-recursive-contract.md).
The [target documentation](https://effect.website/docs/v4/schema/advanced-usage#recursive-types-with-different-encoded-and-type)
requires explicitly annotating both recursive sides. The
[three pinned probes](schema-adapter-probes/recursive-wire.ts) confirm the
selected array, optional-key, and tagged forms, including nested construction,
wire failure paths and interruption cleanup.

## Source rule

```text
schemaRecursive(
  (self: Schema<D,E,RD,RE,M>): Schema<D,E,RD,RE,M> => body
) : Schema<D,E,RD,RE,M>
```

D and E may now be distinct data aliases. Each recursive alias independently
obeys the existing array, optional-key, or tagged terminal guard. M retains its
own data-only shape and defaults to D. Every self reference carries the same
full Schema signature, including encoded E, make input M, and directional
services. The pure inline builder's body must fit the expected Schema on all
axes. A four-argument or abbreviated annotation cannot silently replace E or M.

For example, an array-recursive decoded tree has integer score fields, its wire
tree has text scores, and its make input permits missing scores and children.
A text-to-integer field transformation runs when decoding; its reverse runs when
encoding. Constructors consume partial numeric M without running either wire
transformation. Wire decoding still requires the complete E shape unless a wire
adapter explicitly supplies a default. Wire encoding consumes D and returns E.

Exact optional wire presence may differ from decoded presence. An optional-key
recursive chain can use schemaDefaultKey for a required decoded score and an
optional encoded text score. That wire default does not make score optional in
the constructor input. The existing tagged recursion guard still requires the
same distinct literal discriminator on decoded and encoded branches, plus a
self-free terminal branch. Transformed or renamed discriminator rules are not
added by this extension.

All existing self-use restrictions remain: the body root is a struct or tagged
union; self-bearing paths use structural builders and constructor-default
wrappers; defaults cannot capture self; and constructor wrappers do not create
a guard. Self-free leaf transformations remain allowed. This does not add
arbitrary self-bearing transformations or field adapters.

schemaDecode returns D with SchemaError and requires RD only. schemaEncode
returns E with SchemaError and requires RE only. schemaMake consumes M, returns
D with SchemaIssue, and needs neither wire service direction. Nested wire issues
retain field and array-index paths in both directions. Defects stay defects;
interruption waits for cleanup of the nested decoder or encoder. Repeated
executions reuse the Schema and rerun their own directional callbacks.

## Representation and verification

The existing version 2 Schema type already represents separate D/E/M. Named
recursive aliases retain finite references. The existing typed Schema.suspend
self preserves every axis without new IR fields, operations, casts, or emitter
helpers. The checker and independent validator remove only the previous D=E
condition for schemaRecursive. Identity schema() still requires D=E and no
services. Callback compatibility, data-only checks, and guards remain enforced.

The [source fixture](../../fixtures/emit/schema-recursive-wire.eff),
[source and IR checks](../../tests/schema_recursive_wire_test.ts), and
[compiled witness](../../tests/strict_target_slow_test.ts) cover all
three guards, separate recursive aliases, optional wire fields, constructor
defaults, imported arrays, directional services, repeated roundtrips, wire and
make type separation, nested failures, defects, and awaited cleanup in both wire
directions. Boundaries reject erased or forged encoded types, incorrect self
signatures, wrong nested wire or make data, forged service directions, and
attempts to use identity derivation for distinct D/E.

The [field-default extension](2026-10-19-schema-constructor-fields-contract.md)
now decorates existing descriptors. The
[adapter-order extension](2026-10-19-schema-constructor-order-contract.md)
specifies retained, target and reset defaults. Guarded recursive self use
through field adapters is next. Mutual recursion, transformed recursive discriminators,
arbitrary self-bearing adapters, constructor options, and arbitrary AST access
remain outside this slice. Broader package interoperability, item 9, stays
deferred by user instruction.

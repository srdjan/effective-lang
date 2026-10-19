# Schema constructor metadata and make-input propagation

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: nonrecursive
composition implemented. The
[target probe](schema-adapter-probes/constructor-metadata.ts) has four passing
tests. The
[source fixture](../../fixtures/emit/schema-constructor-metadata.eff),
[compiled runtime witness](../../tests/schema_constructor_metadata_slow_test.ts),
and [source and IR boundaries](../../tests/schema_constructor_metadata_test.ts)
cover the rule. This extends the
[type-side constructor](2026-10-19-schema-constructor-contract.md). The official
[constructor documentation](https://effect.website/docs/v4/schema/default-constructors)
describes type-side construction; the pinned withConstructorDefault API accepts
a nested make-input value and SchemaIssue failure, with no service channel.

## Source contract

```text
Schema<D,E=D,RD=never,RE=never,M=D>
SchemaConstructorDefault<D,E=D,RD=never,RE=never,M=D>

schemaConstructorDefault(Schema<D,E,RD,RE,M>, () -> M [fails SchemaIssue])
  : SchemaConstructorDefault<D,E,RD,RE,M>

schemaMake(Schema<D,E,RD,RE,M>, M) : D fails SchemaIssue
```

M is the constructor's input, distinct from decoded D and encoded E. It must be
data-only, like D and E. Existing four-argument Schemas retain M=D. Make-input
compatibility is invariant, so a changed M cannot be discarded by assigning to a
four-argument Schema annotation. Equivalent aliases for M and D remain
compatible. The constructor-default descriptor flag is also invariant.

The new constructor is shadowable and call-only. It takes an ordinary Schema and
an inline zero-argument callback returning M. The callback may be pure or
effectful, with no services and either no failure or exactly SchemaIssue.
SchemaError and other failures are rejected. A nested default can return an
incomplete make-input record such as {}, rather than a fully constructed D.

The returned descriptor serves only struct fields. It leaves D, E and both wire
service directions unchanged, while allowing the struct's make input to omit
that field. Its missing or raw undefined input runs a fresh callback, then
constructs and validates the callback's M. Present values skip the default; null
remains present. Exact source M types reject explicit undefined unless the
underlying source data permits it. Defaults run only during construction, never
during wire decoding or encoding. Nested validation attaches full field paths.
Defects and interruption retain their channels; interruption waits for cleanup.

## Composition

| Form                        | Result make input                                                              |
| --------------------------- | ------------------------------------------------------------------------------ |
| schemaStruct                | Each field's M; constructor-default and decoded-optional fields may be absent. |
| schemaArray                 | Array of the element Schema's M.                                               |
| schemaUnion                 | Union of branch M types, preserving native branch order.                       |
| schemaOptionalKey           | The wrapped M; the containing struct makes the field optional.                 |
| schemaTransform             | The target Schema's M; source wire transformations do not run during make.     |
| schemaDecode / schemaEncode | Keep D/E and their original service requirements.                              |

Ordinary fields remain required in M even if their nested M contains defaults.
Wrapping the whole nested Schema with schemaConstructorDefault makes the outer
field optional too. Decoded and encoded field presence are unchanged. A default
descriptor cannot be run, used as a union/array member, wrapped twice, or
combined directly with another field descriptor.

The callback is deferred when the descriptor is built. The Schema argument is
evaluated once at construction; each default use runs the deferred callback.
Effectful callbacks can capture a Ref or an Effect with no service requirements.
schemaMake consumes M without wire services while preserving active effects from
evaluating its arguments.

## Representation and runtime

Version 2 Schema types add optional makeInput and constructorDefault properties.
Absent makeInput means D; absent constructorDefault means an ordinary Schema or
an existing field descriptor. Existing payloads keep their meaning. The
constructor-default Schema operation stores its two argument expressions. Types,
aliases, imports, depth checks, diagnostics, and independent validation include
the new make-input axis and field flag.

The pinned generic Codec view erases make-input precision. Emission restores the
checker-derived view through public Schema.make and applies native
withConstructorDefault. Composite Schemas whose M differs from D restore their
checked make-input view from the composed AST. The target type includes
~type.make.in and, for a default field, ~type.constructor.default. This uses
neither casts nor private target APIs. The source descriptor check prevents
known duplicate root defaults before the native no-default view is restored.

The native AST retains nested defaults and their error paths. Host calls to the
emitted Schema's makeEffect preserve native replay identity: repeating one raw
constructor effect may update its previously returned result object. Source
functions retain their existing evaluation rules; the metadata does not replace
those rules with a new object-identity guarantee.

## Boundaries and verification

Changed make-input metadata is rejected by schema(). The
[recursive constructor extension](2026-10-19-schema-constructor-recursive-contract.md)
now carries a separate M through guarded recursive Schemas; the
[wire extension](2026-10-19-schema-recursive-wire-contract.md) also separates D/E.
The [optional adapter extension](2026-10-19-schema-constructor-optional-contract.md)
now specifies propagation through nullable, decoding-default, and optional
transformation fields. The Option adapter explicitly requires complete Option<D>
constructor input. Constructor defaults attached directly to optional
descriptors, constructor options, and
arbitrary Schema AST access remain outside this slice.

Four target tests cover nested M, arrays, unions, optional fields,
transformation targets, restoring erased codec views, and nested errors. The
compiled witness adds cross-module default composition, static D/E/M separation,
captured Ref defaults, native replay identity, constructor-only effects, full
issue paths, and awaited cleanup. Independent mutations reject erased M and
forged default flags. Source boundaries reject metadata erasure, duplicate
defaults, invalid callbacks, services, descriptor runners, and unsupported
metadata derivation.

Constructor metadata through optional adapters and guarded recursion is implemented.
Constructor defaults on field descriptors are next. Broader package interoperability, item 9, stays deferred
by user instruction.

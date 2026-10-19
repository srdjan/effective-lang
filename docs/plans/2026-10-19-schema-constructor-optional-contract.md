# Constructor inputs through optional Schema adapters

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends the [constructor metadata contract](2026-10-19-schema-constructor-metadata-contract.md).
The [pinned target probe](schema-adapter-probes/constructor-optional.ts) has three
passing tests. The target's [optional field documentation](https://effect.website/docs/v4/schema/advanced-usage)
distinguishes decoding defaults from constructor defaults; this contract makes
that distinction explicit for Effective's existing adapters.

## Propagation rule

All existing optional adapters accept ordinary Schemas with a distinct make input
M. All three field descriptor types accept the fifth M argument. Their decoded
and encoded types, presence flags, directional services, callback contracts, and
encoding strategies retain their existing meanings.

| Adapter | Field make input | Presence in containing struct's M |
| --- | --- | --- |
| schemaNullToMissingKey | Wrapped M | Optional |
| schemaDefaultKey | Wrapped M | Required |
| schemaDefaultNullKey | Wrapped M | Required |
| schemaDefaultEncodedKey | Wrapped M | Required |
| schemaOptionalTransform | Target M | Optional |
| schemaOptionalFromRequired | Target M | Optional |
| schemaOptionFromOptionalKey | Option<D> | Required |

A wire default never supplies a missing constructor field. A present partial
nested M still runs its nested constructor defaults. The decoded-default
callbacks continue to return complete D; the encoded-default callback continues
to return complete E. Neither accepts partial M merely because construction does.
No wire default or optional transformation getter runs during schemaMake, and
construction requires neither decode nor encode services. Null-as-missing is a
wire policy: null is rejected as a make input when the wrapped M excludes null.

Optional transformations inherit make input from their decoded target. Their
source may itself have distinct M; that source M does not enter the result's M.
The callback bridge remains between source D and target E, including its existing
Option presence handling. A required encoded field can therefore remain optional
during construction when the decoded target is optional.

The Option adapter uses the target's declared Option schema. Its constructor
requires None or Some containing complete D, rather than Option<M>. It validates
that contents without running nested constructor defaults. Encoded optionality
does not allow the containing constructor input to omit the Option field. This
is an explicit M=D result, rather than propagation through Option's element.

## Representation and verification

No new source forms or IR operations are needed. The checker and independent
validator recompute M for each adapter. Changed M and descriptor flags remain
invariant across annotations and imports. Emission restores the checked make
view with public Schema.make over the composed AST, as for other composites;
it uses no casts or private APIs.

The [source fixture](../../fixtures/emit/schema-constructor-optional.eff) and
[compiled witness](../../tests/schema_constructor_optional_slow_test.ts) cover
all adapters, complete D/E versus partial M, imported field descriptors, target
selection, nested validation paths, and wire-effect traces. The
[source and IR tests](../../tests/schema_constructor_optional_test.ts) reject
erased M, missing required fields, partial Option contents, partial wire defaults,
and forged adapter make inputs. The target probe also checks both encoding
strategies and confirms Option's complete-data constructor behavior.

The [recursive extension](2026-10-19-schema-constructor-recursive-contract.md)
now adds guarded make-input propagation; the
[wire extension](2026-10-19-schema-recursive-wire-contract.md) permits distinct
recursive D/E. Constructor defaults on field descriptors are next. Attaching a constructor default
directly to an optional descriptor, constructor options, and arbitrary Schema AST
access remain outside this slice. Broader package interoperability, item 9,
stays deferred by user instruction.

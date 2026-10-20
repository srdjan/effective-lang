# Constructor defaults on Schema field descriptors

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends [constructor metadata](2026-10-19-schema-constructor-metadata-contract.md)
and [optional-adapter make inputs](2026-10-19-schema-constructor-optional-contract.md).
The [target documentation](https://effect.website/docs/v4/schema/advanced-usage#default-values)
distinguishes decoding defaults from constructor defaults. The pinned
[four target probes](schema-adapter-probes/constructor-fields.ts) cover their
composition, all selected adapters, Option contents, failures and cleanup.

## Source rule

schemaConstructorDefault now accepts an ordinary Schema or any one existing
field descriptor that does not already carry a constructor default. It retains
the decoded and encoded presence flags, D/E/M, and directional service channels.
The result retains its field-descriptor type.

| Input | Result |
| --- | --- |
| Schema | SchemaConstructorDefault |
| SchemaOptional | SchemaOptionalConstructorDefault |
| SchemaEncodedOptional | SchemaEncodedOptionalConstructorDefault |
| SchemaDecodedOptional | SchemaDecodedOptionalConstructorDefault |

All four result forms have the same arguments:
`<D,E=D,RD=never,RE=never,M=D>`. The three new names retain both field presence
and constructor metadata in annotations, aliases, imports and diagnostics.
All flags and D/E/M remain invariant. A constructor-default flag cannot be
discarded even when the field was already optional during construction.

The default callback retains the existing contract: inline, zero arguments,
returning the wrapped M, no services, and either no failure or SchemaIssue.
It may be pure or effectful and can capture other values or effects. Nested
defaults may return partial M. The Option adapter still requires complete
Option<D> contents; adding a default does not turn that into Option<M>.

The containing struct makes this field optional in its M. D and E keep their
original field presence. Optional decoded fields therefore remain optional in
D even though a successful missing-input constructor default supplies a value.
A required decoded field with a decoding default remains required in D, while
its encoded key and constructor input key can both be optional.

```effective
type Int = int
const integer: Schema<Int> = schema()
const field: SchemaEncodedOptionalConstructorDefault<Int> =
  schemaConstructorDefault(schemaDefaultKey(integer, (): Int => 8), (): Int => 4)
```

In a struct, construction from a missing field produces 4, while decoding a
missing wire field produces 8. Construction skips decoding defaults and wire
getters; decoding and encoding skip constructor defaults. Present make input
skips the outer default and constructs its M. A missing or raw undefined input
runs a fresh callback; exact source types still reject explicit undefined.
Null remains present during make, even when a wire adapter treats null as
missing. Encoding strategies and wire service requirements retain their
existing behavior. Constructor failure paths, defects, interruption and awaited
cleanup also retain the existing rule.

The [adapter-order extension](2026-10-19-schema-constructor-order-contract.md)
now permits supported adapters after constructor defaults, retaining unary
defaults, selecting bridge target defaults, and resetting Option defaults.
Incompatible input presence, descriptor runners and duplicate retained defaults
remain errors.
The selected recursive guard can traverse the constructor wrapper and its
structural argument, but default callbacks still cannot capture self.

## Representation and verification

No new IR fields or operations are needed. The existing constructorDefault flag
may coexist with one of optionalKey, encodedOptionalKey or decodedOptionalKey.
The three presence flags remain mutually exclusive. The checker and independent
validator recompute the combined flags and parent make shape; old payloads keep
their meaning. The adapter-order extension now emits structural Codec metadata
views, avoiding assumptions about adapter helper properties in either order.
Runtime emission continues to use public Schema.make and native
withConstructorDefault, without casts or private APIs.

The [fixture](../../fixtures/emit/schema-constructor-fields.eff),
[source and IR boundaries](../../tests/schema_constructor_fields_test.ts), and
[compiled witness](../../tests/strict_target_slow_test.ts) cover
all three presence forms and every selected field adapter, imported descriptors,
nested partial M, unchanged D/E, fresh callbacks, separate wire defaults and
services, encoder omission, Option contents, failures, defects, and awaited
cleanup. Boundaries reject erased flags, forged presence combinations, duplicate
defaults, descriptor runners, incompatible subsequent adapters, callback services and partial
Option defaults.

Guarded recursive self use through field adapters is next.
Constructor options and arbitrary AST access remain outside this slice.
Broader package interoperability, item 9, stays deferred by user instruction.

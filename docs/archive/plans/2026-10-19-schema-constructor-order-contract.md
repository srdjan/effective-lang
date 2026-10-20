# Field adapters after Schema constructor defaults

Note, 2026-10-20: the names `schemaDefaultNullKey` and `schemaDefaultEncodedKey` no longer exist in the language. Write `schemaDefaultKey(schema, callback, { on: "null" })` and `schemaDefaultKey(schema, callback, { on: "encoded" })`. The option `on` is `"missing"` by default, so a call without `on` keeps its earlier meaning. The IR operations `default-null-key` and `default-encoded-key` are unchanged, and the rules below hold for the matching `on` value. Read each old name below as that `on` value.

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends [constructor defaults on fields](2026-10-19-schema-constructor-fields-contract.md).
The [target documentation](https://effect.website/docs/v4/schema/advanced-usage#default-values)
separates decoding and constructor defaults. The
[three pinned probes](schema-adapter-probes/constructor-order.ts) establish
which adapters retain, select or reset constructor metadata.

## Propagation rule

The existing unary field builders accept SchemaConstructorDefault as well as
ordinary Schemas. Their existing input-presence restrictions remain: a unary
builder does not accept a descriptor that already has an optionality flag.
Optional bridges also accept SchemaOptionalConstructorDefault in either existing
optional position; the required source of schemaOptionalFromRequired may be a
SchemaConstructorDefault. Every result retains its existing D/E, field presence,
service and make-input rules, with constructor metadata determined below.

| Adapter | Constructor default on the result |
| --- | --- |
| schemaOptionalKey | Retained from the input. |
| schemaNullToMissingKey | Retained from the input. |
| schemaDefaultKey | Retained from the input. |
| schemaDefaultNullKey | Retained from the input. |
| schemaDefaultEncodedKey | Retained from the input. |
| schemaOptionalTransform | Taken only from the target. |
| schemaOptionalFromRequired | Taken only from the target. |
| schemaOptionFromOptionalKey | Reset; result has no root default. |

The existing combined descriptor names express retained defaults. No source
forms, type names, IR properties or operations are added. Assignment remains
invariant in all flags and D/E/M. An adapter may explicitly reset or select a
default according to this table; an annotation cannot silently discard it.

```effective
type Int = int
const integer: Schema<Int> = schema()
const source: SchemaConstructorDefault<Int> =
  schemaConstructorDefault(integer, (): Int => 4)
const field: SchemaEncodedOptionalConstructorDefault<Int> =
  schemaDefaultKey(source, (): Int => 8)
```

In a struct, construction from a missing field returns 4 and wire decoding from
a missing field returns 8. Both orders produce the same selected wire-default
behavior. Wire callbacks and constructor defaults remain independent; encoding
strategies retain their existing encoder behavior. Defaults execute freshly
when needed. Present make input skips the outer default and constructs M.

Optional bridges construct their decoded target and skip both wire getters.
Their source's root default does not become a default for the result. If only
the source has a default, missing make input stays absent when the target is
optional. If the target has a default, its M is supplied and constructed. Wire
decode and encode never execute either constructor default. In particular, a
required encoded key cannot be supplied by a source constructor default.

The Option adapter produces required Option<D> constructor input and no root
default. A missing field therefore fails construction, even if the source had
a default. Some must contain complete D and does not run nested constructor
defaults. A new constructor default may be attached after this explicit reset,
using None or Some of complete D. A second default remains an error whenever
the preceding adapter retains the original default.

Construction still requires neither wire service direction. Authored issues
retain field paths; defects stay defects; interruption awaits cleanup of retained
defaults. Existing restrictions on descriptor runners, arrays, unions, arbitrary
self-bearing adapter paths and duplicate defaults remain.

## Representation and verification

The checker and independent validator recompute retained, target-selected and
reset flags. Schema field types now emit a structural Schema.Codec view with
checked make input, decoded/encoded optionality, and constructor-default metadata.
Public Schema.make restores that view from each composed AST. This supports
both composition orders without requiring any particular adapter's helper
properties. It uses no casts, private APIs or additional runtime helpers and
evaluates each Schema argument once. The AST retains native callback timing.

The [fixture](../../../fixtures/emit/schema-constructor-order.eff),
[source and linked IR checks](../../../tests/schema_constructor_order_test.ts),
and [compiled witness](../../../tests/strict_target_slow_test.ts) cover
every selected adapter, an imported target default, nested partial M, precise
public flags, independent wire services and callbacks, omission, Option reset
and reattachment, source-only defaults, fresh callbacks, failures, defects and
awaited cleanup. Boundaries reject false flags, lost retained defaults, duplicate
defaults, incompatible input presence, descriptor runners and incomplete Option
contents.

The [recursive field-adapter extension](2026-10-19-schema-recursive-adapters-contract.md)
now admits the selected guarded self paths. Further descriptor
presence rewrites, constructor options and arbitrary AST access remain outside
this slice. Broader package interoperability, item 9, stays deferred.

# Recursive Schema constructor inputs

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends the [constructor metadata](2026-10-19-schema-constructor-metadata-contract.md)
and [guarded recursion](2026-10-18-schema-composition-recursion-contract.md) rules.
The [target documentation](https://effect.website/docs/v4/schema/advanced-usage#recursive-schemas)
uses explicitly annotated Schema.suspend for recursive data. The pinned target's
suspend retains the annotated make input; the
[three target probes](schema-adapter-probes/constructor-recursive.ts) establish
default propagation, validation paths, and interruption cleanup.

## Source rule

```text
schemaRecursive(
  (self: Schema<D,D,RD,RE,M>): Schema<D,D,RD,RE,M> => body
) : Schema<D,D,RD,RE,M>
```

The expected Schema and callback signature carry the same M at every self
reference. M defaults to D for existing code. A separate recursive M is an
ordinary data alias with its own existing array, optional-key, or tagged terminal
guard. D and M need not have identical field presence: a required children array
in D may be optional in M when the body supplies a constructor default of [].
The Schema axes stay invariant, including M. Omitting M from a self parameter
cannot erase a changed input shape. The body must fit the full expected Schema,
so a claimed make input requires actual matching field metadata.

The builder callback remains pure and inline. Its root is schemaStruct or
schemaUnion. Self-bearing paths use schemaStruct, schemaUnion, schemaArray,
schemaOptionalKey, and schemaConstructorDefault. Arrays and optional keys guard
self references; a distinctly tagged union with a self-free terminal branch
also guards them. Constructor-default wrappers preserve a guard but do not
create one. Their callbacks may return finite partial M and capture other
values or effects, but cannot capture or invoke self. Expressions without self
remain ordinary checked Schema leaves, including inline transformations.
Capture checks use binding identities, so a separate local named self is valid.

```effective
type Int = int
type Tree = { score: Int, children: Tree[] }
type TreeInput = { score?: Int, children?: TreeInput[] }
const integer: Schema<Int> = schema()
const tree: Schema<Tree,Tree,never,never,TreeInput> = schemaRecursive(
  (self: Schema<Tree,Tree,never,never,TreeInput>): Schema<Tree,Tree,never,never,TreeInput> =>
    schemaStruct({
      score: schemaConstructorDefault(integer, (): Int => 4),
      children: schemaConstructorDefault(schemaArray(self), (): TreeInput[] => [])
    })
)
```

schemaMake(tree, { children: [{}] }) constructs complete records at both levels.
Defaults run freshly at each absent field and do not run for present values.
Wire decoding and encoding still require complete D and retain their directional
services. Make requires neither wire service direction. Nested validation and
default failures retain SchemaIssue paths through field names and array indices;
defects stay defects, and interruption awaits nested default cleanup. A finite
data guard does not prove termination of user default effects or defaults that
keep generating further constructor input. Cyclic runtime objects are outside
the contract.

## Representation and verification

No new IR properties, operations, or emitter helpers are needed. Named recursive
aliases keep finite serialized references. The existing typed Schema.suspend
self and restored composite Schema.make views preserve M without casts. The
independent validator recomputes the full callback signature and checks guards
and default callback captures, including references hidden inside a block.

The [fixture](../../fixtures/emit/schema-constructor-recursive.eff),
[source and IR tests](../../tests/schema_constructor_recursive_test.ts), and
[compiled witness](../../tests/schema_constructor_recursive_slow_test.ts) cover
all three guards, partial inputs at nested levels, imported recursive Schemas,
outer defaults, separate wire services, fresh callbacks, complete wire data,
nested failures, defects, and awaited cleanup. Boundaries reject M erasure,
wrong self types, missing metadata, unguarded recursion, invalid nested data,
and self captured inside a default callback.

The [recursive wire extension](2026-10-19-schema-recursive-wire-contract.md)
now allows distinct decoded and encoded recursive aliases while retaining M and
directional services. The [field-default extension](2026-10-19-schema-constructor-fields-contract.md)
now attaches defaults to descriptors. The
[adapter-order extension](2026-10-19-schema-constructor-order-contract.md)
specifies retained, target and reset defaults. Guarded self use through field
adapters is next. Mutual recursion, constructor options, and arbitrary AST access remain
outside this slice. Broader package interoperability, item 9, stays deferred.

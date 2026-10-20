# Guarded recursive Schema field adapters

Note, 2026-10-20: the names `schemaDefaultNullKey` and `schemaDefaultEncodedKey` no longer exist in the language. Write `schemaDefaultKey(schema, callback, { on: "null" })` and `schemaDefaultKey(schema, callback, { on: "encoded" })`. The option `on` is `"missing"` by default, so a call without `on` keeps its earlier meaning. The IR operations `default-null-key` and `default-encoded-key` are unchanged, and the rules below hold for the matching `on` value. Read each old name below as that `on` value.

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented.
This extends the [recursive wire rule](2026-10-19-schema-recursive-wire-contract.md)
and [field adapter order](2026-10-19-schema-constructor-order-contract.md).
The [target documentation](https://effect.website/docs/v4/schema/advanced-usage)
and [three pinned runtime probes](schema-adapter-probes/recursive-adapters.ts)
establish native suspension, optional getters and default behavior.

## Recursive paths

schemaRecursive still requires an expected Schema<D,E,RD,RE,M>, a pure inline
callback with exactly that self type, and a struct or union body. Self occurs
only in supported structural Schema arguments. The following paths are now
accepted in addition to the existing array, optional-key, struct, union and
constructor-default paths:

| Builder | Self-bearing arguments | Supplies a guard |
| --- | --- | --- |
| schemaNullToMissingKey | Wrapped Schema | Yes: optional key on both sides. |
| schemaDefaultKey | Wrapped Schema | No. |
| schemaDefaultNullKey | Wrapped Schema | No. |
| schemaDefaultEncodedKey | Wrapped Schema | No. |
| schemaOptionalTransform | Source and target Schema | No. |
| schemaOptionalFromRequired | Source and target Schema | No. |

Defaults, getters and options cannot capture self, even in a discarded local or
nested closure. Their result types alone do not establish a safe path. Binding
identity determines captures, so an unrelated local named self is allowed. Source
calls must resolve to the actual builtin; a shadowed function name supplies no
structural proof. Constructor-default wrappers remain transparent and their
callbacks remain self-free. Ordinary self-bearing schemaTransform is excluded.

Each D/E/M recursive data alias independently retains the finite guard rule.
Unions beneath an existing array, optional key, or terminal-tagged guard carry
that guard through every member. This permits an exact optional wire field such
as next?: WireNode | null. An unguarded nested union remains invalid, and a root
union still needs the existing distinct literal tags and a self-free terminal
branch. The change does not admit bare nullable recursive aliases, mutual
recursion, recursive Option data, or callbacks as recursive guards.

```effective
type Int = int
type Tree = { score: Int, children: Tree[] }
type Wire = { score: Int, children?: Wire[] }
type Input = { score?: Int, children?: Input[] }
const integer: Schema<Int> = schema()
const tree: Schema<Tree,Wire,never,never,Input> = schemaRecursive(
  (self: Schema<Tree,Wire,never,never,Input>): Schema<Tree,Wire,never,never,Input> =>
    schemaStruct({
      score: schemaConstructorDefault(integer, (): Int => 4),
      children: schemaDefaultKey(
        schemaConstructorDefault(schemaArray(self), (): Input[] => []),
        (): Tree[] => [])
    })
)
```

The array supplies the guard. Construction from nested partial Input uses
constructor defaults and no wire services. Wire decoding may omit children,
uses wire defaults and still requires score. Encoding preserves each adapter's
existing strategy. Encoded-value defaults still execute the wrapped encoder
before omission; decoded defaults retain their existing skip behavior. Optional
bridges construct the target M and skip their wire getters during make.

## Representation and evidence

No syntax, public type names, IR properties, runtime helpers or emission paths
are added. The checker and independent validator traverse the selected Schema
positions separately. Imported data aliases use the same union guard rule.
Independent type comparison preserves a recursive alias's identity when it is
an explicit union member, avoiding infinite unfolding when comparing nullable
recursive fields. Distinct recursive aliases remain distinct.

The [fixture](../../fixtures/emit/schema-recursive-adapters.eff),
[source and IR boundaries](../../tests/schema_recursive_adapters_test.ts), and
[strict compiled witness](../../tests/schema_recursive_adapters_slow_test.ts)
cover every new adapter, independent D/E/M, nested constructor input, nullable
links, imports, wire-default services, target-only bridge construction, retained
encoder work under encoded omission, missing required wire keys, repeated wire
defaults, nested failures, defects and awaited cleanup on interruption. Source
and IR checks reject self capture in default and both directional getter
callbacks. Existing service, presence, constructor-default and issue rules stay
in force.

The accepted [application acceptance rule](2026-10-19-application-acceptance-rule.md)
now sets the queue. Recursive Option data remains open without blocking that
target by default. Broader package interoperability, item 9, stays deferred
by user instruction.

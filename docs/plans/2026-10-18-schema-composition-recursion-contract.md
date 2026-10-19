# Schema composition and recursive source data contract

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded source
slice implemented. The compiler and independent validator enforce this contract;
the [source fixture](../../fixtures/emit/schema-composition.eff) and
[strict runtime test](../../tests/schema_slow_test.ts) cover it.

## Decision and evidence

Add first-class Schema values with separate decode and encode requirements, and
accept one guarded self-recursive source record type. Keep the existing pure
`Codec<Decoded,Encoded>` and its Option-returning operations unchanged. The
[existing target probes](schema-adapter-probes/schema.ts) establish the
four-channel target Codec, separate service provision, issue-versus-defect
behavior, and finite recursive decoding. Two new
[composition probes](schema-adapter-probes/composition.ts) show a transformed
field nested in a recursive `Schema.Struct`: decoding and encoding need
different services, nested invalid data and a transformation issue become
`SchemaError` with a descendant path, and a defect remains a defect.

Before implementation, source reported `unknown-name/001` for `Schema<Int>`,
`declaration/007` for `type Tree = { value: int, children: Tree[] }`, and
`execution-mode/001` for an effectful `codec` callback. The
[source probe](schema-adapter-probes/source_slow_test.ts) now checks accepted
Schema and guarded recursion alongside the still-rejected pure-Codec and
unguarded forms. The concrete host decoder in the earlier
[adapter audit](2026-10-18-schema-ecosystem-design.md) remains useful but does
not create a source Schema value or return a recursively typed tree.

## Source type and constructors

`Schema<D, E = D, RD = never, RE = never>` is a reusable, deferred Schema value.
`D` is its decoded data type, `E` its encoded data type, `RD` the services
required for decoding, and `RE` those required for encoding. Neither direction
has an arbitrary typed failure parameter: parsing fails with the reserved
nominal `SchemaError`. Source code can catch that error and read its message;
the runtime object remains the target `Schema.SchemaError`, including its
structured `issue` tree for host consumers. Source cannot construct a
`SchemaError`. Defects and interruption are not translated to it.

The first constructor and composition set is:

```text
schema(): Schema<T,T>                     // requires an expected Schema<T,T>
schemaArray(Schema<A,B,RD,RE>): Schema<A[],B[],RD,RE>
schemaStruct({ field: Schema<A,B,RD,RE>, ... }):
  Schema<{ field: A, ... },{ field: B, ... },union RD,union RE>
schemaTransform(source, target, decode, encode)
schemaRecursive((self: Schema<T,T,RD,RE>) => Schema<T,T,RD,RE>)
```

`schema()` derives an identity Schema from a data-only expected type. It does
not infer a type from an empty call. `schemaStruct` initially accepts required
record fields only, evaluates field expressions once in source order, and unions
each direction's requirements independently. `schemaArray` preserves both
directions and their requirements.

The implemented source witness has this shape:

```text
type Int = int
type Tree = { value: Int, children: Tree[] }
service Read { next(value: Int): Option<Int> }
service Write { previous(value: Int): Option<Int> }

const integer: Schema<Int> = schema()
const shifted: Schema<Int,Int,Read.next,Write.previous> = schemaTransform(
  integer, integer,
  (value: Int): Option<Int> uses Read.next => Read.next(value),
  (value: Int): Option<Int> uses Write.previous => Write.previous(value)
)
const tree: Schema<Tree,Tree,Read.next,Write.previous> = schemaRecursive(
  (self: Schema<Tree,Tree,Read.next,Write.previous>): Schema<Tree,Tree,Read.next,Write.previous> =>
    schemaStruct({ value: shifted, children: schemaArray(self) })
)
export const readTree = (input: unknown): Tree fails SchemaError uses Read.next =>
  schemaDecode(tree, input)
```

The complete compiled fixture also encodes a tree and catches `SchemaError`.

For `schemaTransform`, the source Schema has type `Schema<A,E,RD1,RE1>` and the
target has type `Schema<B,C,RD2,RE2>`. The inline decode callback receives `A`
and returns `Option<C>`; the inline encode callback receives `C` and returns
`Option<A>`. Both may run effects and use services, but must have no typed
failure channel in this first slice. If their requirement sets are `RD3` and
`RE3`, the result is `Schema<B,E,RD1 | RD2 | RD3,RE1 | RE2 | RE3>`. The target
validates the intermediate result against `C` on decode and against `A` on
encode. `None` becomes `SchemaIssue.InvalidValue` with a fixed
transformation-rejection message; `Some` proceeds. The target wraps that issue
as `SchemaError` when a runner executes. This gives source callbacks a rejection
path without silently converting arbitrary nominal application failures into
Schema issues. Detailed source-authored issue trees remain a separate design
boundary.

The two runners are:

```text
schemaDecode(schema: Schema<D,E,RD,RE>, input: unknown): D
  fails SchemaError uses RD
schemaEncode(schema: Schema<D,E,RD,RE>, value: D): E
  fails SchemaError uses RE
```

`schemaEncode` checks that the source value fits `D`. Both calls retain active
construction effects of their arguments and execute parsing only when their
resulting Effect runs. The backend uses typed `Schema.decodeUnknownEffect` and
`Schema.encodeEffect`; it does not erase either requirement channel.

All five constructors are call-only, shadowable prelude forms. Schema values
cannot contain functions, providers, scopes, or other deferred source values as
decoded or encoded data. `schemaRecursive` takes a pure inline callback; its
self parameter is a lazy schema reference, not a schema execution. A self
reference must appear beneath `schemaArray` or a later selected finite-choice
constructor, never as the immediate result or a required direct field. The first
implementation can use the array-guarded form needed by the target tree probe;
Option-guarded recursion requires its own constructor rule.

## Guarded recursive type declarations

Accept `type Tree = { value: Int, children: Tree[] }` when a single local alias
refers to itself only beneath an array inside a data-only record. An empty array
supplies a finite base case. Reject direct aliases such as `type Loop = Loop`,
required direct fields such as `type Loop = { next: Loop }`, mutually recursive
aliases, recursive brands or errors, and recursive aliases through functions or
deferred types. These continue to report `declaration/007` with the cycle
location. Cyclic JavaScript object graphs and an unbounded stack guarantee are
outside this rule; the witness covers finite nested values.

A recursive alias is compared by its declared identity once a comparison returns
to that alias. This prevents unbounded structural unfolding; ordinary
nonrecursive aliases retain their current compatibility. The checker skips the
finite-depth expansion test only for accepted guarded aliases. The independent
validator rechecks the guard and rejects forged recursive IR that crosses no
array. Serialization keeps named self references rather than expanding the
record indefinitely.

For an accepted alias, the backend emits a TypeScript recursive type and a typed
`Schema.Codec<Tree>` constant. Each self reference in the Schema initializer is
wrapped with `Schema.suspend(() => Tree)` so construction does not read an
uninitialized value. Nonrecursive type declarations keep their current emission.
A `schema()` for `Tree` refers to this lazy identity Schema. `schemaRecursive`
emits a lazy self Schema and constructs its body once; each parse follows the
self reference only when it reaches an array element.

The [recursive constructor extension](2026-10-19-schema-constructor-recursive-contract.md)
now retains a separate, guarded make-input M in the self Schema. It adds
constructor defaults to these recursive bodies without changing their decoded
or encoded shapes or their directional wire services. The
[recursive wire extension](2026-10-19-schema-recursive-wire-contract.md) now
permits distinct recursive D/E with the same guarded body rules.

## Execution and acceptance gate

Constructing any Schema value runs no decode or encode callback and resolves no
parsing service. A runner walks finite data under its direction's service
provider. Validation failures, `None` from a transformation, and target
transformation issues remain typed `SchemaError` failures with the target issue
object intact. A defect stays a defect; interruption stays interruption.
Repeated runner executions reuse the Schema value without sharing mutable parse
state. No new scope, background fiber, or external adapter is involved.

The source fixture has an array-guarded `Tree`, a transformed value field, and a
`schemaRecursive` composition. The checker and independent validator reject
unguarded cycles, wrong callback direction, typed callback failures, forged
requirement channels, immediate self use, and a wrong encode input. Strict
emitted TypeScript preserves distinct decode and encode services. Runtime tests
cover finite nested decode/encode, nested rejection and issue path, service
provision in each direction, construction deferral, repeated runs, defect
propagation, and interruption. The pinned target probes establish the behavior
to compare; they do not by themselves establish source support.

User generics, mutual recursion, arbitrary SchemaIssue construction, optional
and union schema builders, arbitrary package imports, and ecosystem object
builders stay outside this implemented slice. A separate
[optional/union/issue contract](2026-10-18-schema-optional-union-issues-contract.md)
now implements a bounded source rule for the first three remaining Schema forms.
Package interoperability remains deferred by user instruction.

## Reproduce

```sh
deno test --no-lock docs/plans/schema-adapter-probes/schema.ts
deno test --no-lock docs/plans/schema-adapter-probes/composition.ts
deno test --no-lock --allow-all docs/plans/schema-adapter-probes/source_slow_test.ts
deno test --no-lock --allow-all tests/schema_slow_test.ts
```

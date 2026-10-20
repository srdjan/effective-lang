# Optional fields, tagged unions, and authored Schema issues

Date: 2026-10-18. Target: `effect@4.0.5`, Deno 2.9.7. Status: bounded source
slice implemented. The
[pinned target probe](schema-adapter-probes/optional-union-issues.ts) has seven
passing tests. The
[source boundary probe](schema-adapter-probes/optional-union-source_slow_test.ts)
checks accepted forms and rejection boundaries. The
[compiled fixture](../../../fixtures/emit/schema-optional-union.eff) and
[runtime tests](../../../tests/strict_target_slow_test.ts) establish source
support, strict emission, and independent validation.

## Decision and evidence

Extend the
[first-class Schema contract](2026-10-18-schema-composition-recursion-contract.md)
with exact optional record keys, tagged record unions, and a small authored
issue tree. Keep `Schema<D,E,RD,RE>`, the two runners, `SchemaError` wrapping,
and pure `Codec` unchanged. The first union builder accepts branches whose
decoded and encoded records share one discriminant key and have distinct literal
values for that key. This avoids observable branch-order selection when records
overlap. Retain source branch order in the emitted target union and in any
combined target diagnostic.

The target probe establishes these boundaries:

| Form                                    | Pinned behavior                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema.optionalKey` in `Schema.Struct` | Missing key stays absent in both directions; a present `undefined` fails; the absent field does not run its transformation. Its service remains in the static requirement type.                                             |
| `Schema.Union` of tagged records        | The selected branch runs its own decode or encode transformation and requirement; a selected branch's issue survives as `SchemaError`. An unselected branch's effectful field is skipped even when declared before its tag. |
| Overlapping union members               | The first matching member wins and can discard fields, so a general order-independent source rule would be false.                                                                                                           |
| Optional and tagged recursion           | A missing optional link or a terminal tagged branch ends finite decoding and encoding.                                                                                                                                      |
| Authored issue tree                     | `InvalidValue`, `Pointer`, and `Composite` nodes survive the transformation, struct path, and public `SchemaError` wrapper. A defect still stays a defect.                                                                  |

Before implementation, the source boundary probe reported `unknown-name/001` for
the constructors and `SchemaIssue`, and `declaration/007` for optional and
tagged self-recursive aliases. It now checks accepted forms and rejects
malformed unions, direct construction of reserved errors, misuse of an optional
descriptor, and unguarded recursion.

## Exact optional fields

Add a deferred `SchemaOptional<D,E,RD,RE>` field descriptor and the call-only,
shadowable prelude constructor:

```text
schemaOptionalKey(Schema<D,E,RD,RE>): SchemaOptional<D,E,RD,RE>
schemaStruct({ required: Schema<A,B,...>, optional: SchemaOptional<D,E,...> })
  : Schema<{ required: A, optional?: D },
           { required: B, optional?: E }, union decode R, union encode R>
```

`SchemaOptional` is usable only as a `schemaStruct` field. It is neither a
runnable Schema nor decoded or encoded data. A missing property stays missing;
it is not `None`, `null`, or `undefined`. A present property runs the field
Schema and must validate, including when its value is explicitly `undefined`.
Both directions preserve exact optionality. The field expression is evaluated
once, in source order; parsing and services remain deferred. A required
`Option<T>` field keeps its existing meaning and is distinct from an optional
key. The checker, independent validator, and emitted TypeScript must preserve
the field's optional flag and separate direction requirements.

## Tagged union builder

This section records the initial tagged-only rule. The later
[general-union extension](2026-10-19-schema-general-union-contract.md)
supersedes the shared-tag restriction and admits untagged and overlapping
branches while retaining the tagged behavior below.

Add `schemaUnion([branch1, branch2, ...])`, with at least two branches. Each
branch is a `Schema<D_i,E_i,RD_i,RE_i>` whose decoded and encoded types are
records with the same required discriminant key, such as `kind`. The value at
that key is the same single string literal in `D_i` and `E_i`; each branch's
literal differs from every other branch's. Other fields may be required or
optional, and may carry effectful Schema values. The result is
`Schema<D_1 | ... | D_n,E_1 | ... | E_n,union RD_i,union RE_i>`.

The runtime dispatches by the discriminant before executing a branch's field
transformations. A missing or unknown tag fails with `SchemaError`. Failure
inside the selected branch remains that failure; it does not run another branch
to look for a success. Construction evaluates branch expressions once in source
order without decoding or resolving a service. The validator must reject forged
unions with duplicate or mismatched tags, fewer than two branches, or nonrecord
members. General `Schema.Union` over overlapping records and untagged members
stays outside this first builder. Identity schemas for existing data-only unions
remain available through `schema()`.

## Source-authored issues

Reserve `SchemaIssue` as an opaque, nominal source failure type that maps to the
target `SchemaIssue.Issue`. It is distinct from `SchemaError`: a transformation
callback may fail with `SchemaIssue`, while a Schema runner fails with
`SchemaError`. Add three call-only, shadowable pure constructors:

```text
schemaInvalid(message: string): SchemaIssue
schemaAt(key: string | int, issue: SchemaIssue): SchemaIssue
schemaBoth(subject: Schema<D,E,RD,RE>, left: SchemaIssue,
           right: SchemaIssue): SchemaIssue
```

`schemaInvalid` maps to `InvalidValue` with a message and no reported input.
`schemaAt` maps to a one-step `Pointer`; nested calls form longer paths.
`schemaBoth` maps to a two-child `Composite` with the supplied Schema's AST;
nested calls form larger trees. Supplying a Schema is construction-only and does
not require its decoding or encoding services. These constructors do not expose
arbitrary target AST nodes or input-reporting options. `SchemaIssue` cannot be a
Schema data type, a host declaration, or a catchable runner error.

For each direction independently, `schemaTransform` accepts either its existing
`Option<T>` callback with no typed failure, or an effectful callback returning
`T fails SchemaIssue`. In the latter form a successful value still passes the
target-side intermediate validation; `fail(issue)` passes that exact issue tree
to the target transformation. No other typed callback error is implicitly
converted. A `None` in the existing form keeps the fixed `InvalidValue` message.
`Schema.decodeUnknownEffect` and `Schema.encodeEffect` wrap either kind of issue
in `SchemaError`, retaining the target issue tree for host consumers. Defects
and interruption remain outside that wrapper.

The source spelling to accept after implementation has this shape:

```text
type Int = int
type Left = { kind: "left", value: Int }
type Right = { kind: "right", value: Int }
type LeftTag = "left"
type RightTag = "right"
const integer: Schema<Int> = schema()
const leftTag: Schema<LeftTag> = schema()
const rightTag: Schema<RightTag> = schema()
const left: Schema<Left> = schemaStruct({ kind: leftTag, value: integer })
const right: Schema<Right> = schemaStruct({ kind: rightTag, value: integer })
const choice = schemaUnion([left, right])
const issue = schemaAt("payload", schemaBoth(integer,
  schemaInvalid("missing"), schemaInvalid("out of range")))
```

## Finite recursive aliases and Schema construction

Extend the existing one-alias array guard to two more finite guards:

- A self-reference beneath an optional record field may terminate when the key
  is missing, as in `type Node = { next?: Node }`.
- A self-reference beneath one tagged union variant may terminate when another
  variant has no self-reference, as in
  `type Node = { kind: "end" } | { kind: "more", next: Node }`.

The rule still rejects `type Loop = Loop`, required direct record cycles, mutual
recursion, and unions with no terminal variant. In a recursive Schema
initializer, use `Schema.suspend` for self references. Extend `schemaRecursive`
to accept a body that is either a `schemaStruct` with an optional self field or
a `schemaUnion` with a terminal tagged branch. The checker and independent
validator must prove the same finite guard and reject an immediate or unguarded
self result. This is a finite-data rule, not a promise to decode cyclic
JavaScript objects or to use bounded stack space.

## Acceptance gate and result

Resolution, type checking, IR validation, lowering, and typed emission now cover
the three builders and issue constructors. The compiled fixture checks missing,
present, and explicit `undefined` optional fields; both tagged branches with
separate services; authored decode and encode issues; and finite optional and
tagged recursion. Negative source probes reject duplicate tags,
direction-changing tags, nonrecord members, descriptor use as a runner, reserved
error construction, and unguarded cycles. The existing Schema tests reject wrong
callback failure channels. Independent validator mutations reject duplicate
tags, forged optionality, and immediate self use.

Strict emitted TypeScript uses exact optional property types and preserves the
direction-specific service types. Runtime assertions inspect
`SchemaError.issue`, effects skipped for missing fields and unused branches,
repeated executions, defects, and interruption. The final full gate is listed
below.

This contract does not select general union backtracking, optional-field
transformations or defaults, Option-from-optional-key conversion, arbitrary
Schema AST construction, or package builder interoperability. The latter remains
deferred by user instruction.

## Reproduce

```sh
deno test --no-lock docs/plans/schema-adapter-probes/optional-union-issues.ts
deno test --no-lock --allow-all docs/plans/schema-adapter-probes/optional-union-source_slow_test.ts
deno test --no-lock --allow-all tests/strict_target_slow_test.ts
deno task check
```

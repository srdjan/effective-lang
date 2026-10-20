# General Schema union branch selection

Date: 2026-10-19. Target: `effect@4.0.5`, Deno 2.9.7. Status: implemented within
the selected source Schema subset. The
[pinned target probe](schema-adapter-probes/general-union.ts) has four passing
tests. The
[compiled source witness](../../../tests/strict_target_slow_test.ts) uses
the [fixture](../../../fixtures/emit/schema-general-union.eff) and checks strict
TypeScript, runtime behavior, and independent IR validation. Effect's
[union documentation](https://effect.website/docs/v4/schema/basic-usage#unions)
describes declaration-order selection and overlapping records.

## Source rule

`schemaUnion([branch1, branch2, ...])` accepts an inline list of at least two
ordinary `Schema<D_i,E_i,RD_i,RE_i>` values. Branches may have unlike data
types, overlapping record shapes, duplicate types, or transformed data. Each
branch must be a runnable Schema; struct-only field descriptors are rejected.
The result is `Schema<D_1 | ... | D_n,E_1 | ... | E_n,union RD_i,union RE_i>`.
The constructors remain call-only and shadowable. Branch expressions evaluate
once in source order; construction does not decode, encode, or resolve a
service. The existing tagged-record union is a special case of this rule.

The emitter uses `Schema.Union` with the source branch order unchanged. For
untagged eligible branches, the target tries candidates in order and returns the
first successful decode or encode. A typed `SchemaIssue` from a candidate can
permit a later candidate to succeed. If no candidate succeeds, the runner fails
with `SchemaError`. Overlapping records make order observable: a shorter record
Schema may drop fields before a later, longer record can run. Tagged branches
may use target discriminant dispatch; an issue inside its selected branch
remains a failure rather than running an unrelated tag. Defects and interruption
do not become candidate failures and are never recovered by another branch.
Static decode and encode requirements include every branch's requirements even
when a run stops early.

The checker and independent validator derive the union data types and
direction-specific requirements from the inline branch tuple. They reject fewer
than two branches, a non-list argument, non-Schema branches, field descriptors,
and forged union annotations. The earlier
[tagged-union contract](2026-10-18-schema-optional-union-issues-contract.md)
recorded the first bounded rule; this contract supersedes its shared-tag
restriction while preserving tagged behavior and finite recursive guards. Only a
tagged union with a terminal branch can itself guard recursive self references.
Untagged unions do not supply that guard: trying the self Schema as an immediate
member would recurse without consuming input. Source and IR regressions reject
this case.

The
[nullable optional extension](2026-10-19-schema-nullable-optional-contract.md)
now adds the null singleton and explicit field-presence policies. Arbitrary
Schema AST construction and source-side schema annotations remain separate
design work. Broader package interoperability stays deferred by user
instruction.

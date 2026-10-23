# Nominal keyword plan

Date: 2026-10-23. Base: `317d018` on local `main`. Status: complete on 2026-10-23. The user approved the plan. Section 8 records the validation findings.

Compiler commits: d59b5bf (NM9), 9da2ebd and bd52a86 (NM10), 95c72b7 and 5cc0e63 (NM11), 76dc088 (NM12), 2db2c5a (NM13). Website commits: 4fdb6a2 and d97dacb (NM14).

This plan uses the ID prefix NM. NM1 to NM4 are the user's decisions. NM5 to NM8 are design rules that follow from them, and the user approves them with the plan. NM9 and later are work items.

## 1. Goal

Effective has two kinds of declared types. A `type` declaration is structural: two types with equal structure are interchangeable. A `nominal` declaration has identity by name: two nominal types with equal bodies are different types. The word `nominal` replaces `data`, and it also replaces `Brand<T>`. The source has no brand concept. Brands, tags, and schemas are details of the TypeScript lowering, which the compiler emits.

Before and after:

```
type UserId = Brand<string>        ->  nominal UserId = string
type Cents = Brand<int>            ->  nominal Cents = int
data Account = { id: UserId }      ->  nominal Account = { id: UserId }
unbrand(account)                   ->  account (it fits its base record)
```

The user's design rule for this work: Effective syntax stays minimal and succinct, and the compiler hides the verbose Effect-TS forms.

## 2. Decisions of the user

- NM1 (a). A `nominal` body can be any type that has a schema. The rules `declaration/015` (no function or deferred type) and `declaration/016` (no opaque type) apply to every body. A body that is a record after aliases are unfolded gets a runtime `_tag`, as `data` does today. Any other body lowers to an Effect brand with no runtime marker.
- NM2 (a). A nominal value fits its base type in one direction. `unbrand` is removed. A `UserId` fits where `string` is expected. A `string` still needs `UserId(s)`.
- NM3 (a). The IR has one definition kind `{ kind: "nominal", base }` and one construction node. The IR version goes from 2 to 3. The emitter selects `Schema.TaggedStruct` or `Schema.brand` from the base.
- NM4 (a). `Brand`, `data` as a declaration word, and `unbrand` get no dedicated diagnostics. `Brand` and `unbrand` become unknown names. The term "data type" becomes "nominal type" in diagnostics, docs, `CONCEPTS.md`, the spec, and the book. The spec goes from draft 0.59 to draft 0.60.

## 3. Design rules (approve with the plan)

NM5 (record bodies). A body is a record body when it is a record type after aliases are unfolded. So `nominal Account = Fields`, with `type Fields = { ... }`, is a tagged nominal type, and its fields are written once. The emitter prints the fields of the unfolded record in the `TaggedStruct`.

A body can be a record nominal type, as in `nominal B = A`, or a union with a record member or a record nominal member. Such a body gives `declaration/014`. Its new message is "a nominal body cannot hold a nominal record or a union with a record; declare each record alone". This keeps the old reason of `declaration/014`: a field read through a nominal union of records cannot occur. NM4 retires the old `Brand` meaning of `declaration/014`, not the code.

The record status of a body is known only after every declaration of the module is defined, because `nominal Account = Fields` can come before `type Fields`. So the type table keeps one map from a nominal id to its base ref. `recordBaseOf(id)` unfolds the base at query time with a seen set. The checker classifies each declaration after the definition loop and before `checkCycles`.

The rules `declaration/009` (reserved `_tag`), `declaration/015`, and `declaration/016` run on the unfolded record of a record body, not only on a literal record. Without this, `type Fields = { _tag: "x" }` and `nominal A = Fields` would emit a `TaggedStruct` with a duplicate `_tag` key.

A non-record body gets the same checks. Today `type R = Brand<Ref<int>>` gives no diagnostic, and the build then fails with "unsupported" (measured on `d0631c4`). After this plan, a non-record body that contains a function or deferred type gives `declaration/015`.

NM6 (widening). `TypeTable.assignable` gets one rule: a named nominal type that is not opaque fits a target when its base fits that target. Insert the rule after both alias steps (`types.ts:1252-1263`) and before the union steps. Guard it with `!isErrorId(sn.id)` and `!this.opaque.has(sn.id)`. It applies inside arrays, options, records, tuples, and unions, as `int` to `number` does.

The rule does not change the variance that the table enforces. `Ref`, `RetrySchedule`, `Codec`, and `Schema` stay invariant, and function parameters stay contravariant. An opaque type does not widen. An error does not widen to its record. The validator mirrors the rule at `src/core/validate/typing.ts:236-238`.

NM7 (operators). The operators use the comparison class of each operand (`comparisonClass` in `check_binary.ts`). The class is a primitive name or `brand:X` for a non-record nominal type `X`. Two classes are compatible when they are equal, or when one is `brand:X` and the other is the class of the base of `X`. A union that mixes a nominal type with its base has no class, as today. These rules replace the brand operator rules:

- `+` and `-` with two operands of one numeric nominal type give that type, as today.
- Other arithmetic with compatible classes widens the nominal operand to its base. `total * 2` gives `int`, `total + 5` gives `int`, and `total / 2` gives `number`.
- Arithmetic with two different nominal classes is an error, as a comparison is. So `cents + meters` is an error.
- A string nominal operand of `+` widens to `string`, when the other operand is compatible.
- A comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`) needs compatible classes. So `id == "u1"` and `total > 0` are legal, and `userId == email` and `cents < meters` are errors. This keeps the main protection of nominal primitives. The ordering operators also need a numeric class. They do not use `isNumeric` on a nominal operand, because `isNumeric` uses `isAssignable`, which NM6 widens.
- The key class rules of `mapGroups` and of key unions do not change.
- Measured on 2026-10-23: `x === "u1"` with `x` of an Effect brand type over `string` passes `deno check`.

NM8 (runtime form of a widened record). A widened record nominal value keeps its `_tag` at run time, because widening emits no code.

Measured with Effect 4.0.5 on 2026-10-23: `Schema.encodeUnknownSync` and `Schema.decodeUnknownSync` of the base struct drop the `_tag`, and `Schema.is` of the base struct accepts the value. `B.make(a)`, where `a` has the `_tag` of `A`, throws "Schema validation failed".

So nominal record construction copies its argument without `_tag` (the existing `$untagged` helper) unless the IR argument node has the kind `record`. An update node (`{ ...o, id: x }`) is not a `record` node, so it gets the copy.

A nested widened value needs no copy. In this measurement, `inner` has a structural record type, and `a` has a foreign `_tag`. Measured on 2026-10-23: `B.make({ inner: a })` gives `{ _tag: "m#B", inner: { name: "x" } }`, because the nested `Struct` drops the extra key. A widened value cannot reach a record type with a `_tag` field, because a record fits only a record with the same field names. The validator must accept the construction node with any argument that fits the base.

## 4. Scope

In scope:

- The parser, resolver, checker, lowering, IR, validator, emitter, editor tokens, completion, TextMate grammar, and playground highlighter.
- Every `.eff` and `.effi` fixture, the tests, the golden files, the validation fixtures, and the lex snapshot.
- `docs/language-rules.md`, `docs/api.md`, `docs/status.md`, `CONCEPTS.md`, and `README.md`.
- The website: the spec, the book, `effective-examples/`, `typed-ir.ts`, `log.ir.json`, and a validation entry.

Out of scope:

- `error` declarations and `opaque type` keep their syntax.
- Internal identifiers that name a lowering form (`brandBaseOf`, `dataRecordOf`, `$untagged`) can keep their names. A brand and a tagged record are TypeScript lowering forms, so these names are correct inside the compiler. User-visible text must say "nominal type".
- Archived plans keep their text.

Measured reach on `317d018`: `Brand<` occurs 32 times in 18 `.eff` and `.effi` files, and 53 times in `tests/*.ts`. There are 72 `data` declarations in `.eff` and `.effi` files and 49 in tests. `unbrand(` occurs 6 times in `.eff` files. The website has 3 `Brand<` uses in examples, 10 in pages, 14 `unbrand` uses in pages, and 8 `data` declarations in examples. "data type" occurs 66 times in the docs and 37 times on the website.

## 5. Work items

Each item is one commit after `deno task check` passes. Run `git add -N` and `deno task lex:update` for each new `.eff` or `.effi` file.

NM9 (IR version 3, no syntax change). Base: `317d018`.

- `src/core/ir.ts`: replace the `brand` and `data` definition kinds with `{ kind: "nominal"; base: Type }`. A record body is a `record` Type. Keep `opaque?: boolean` on the declaration. Replace the expression nodes `brand` and `data` with `Node<{ kind: "nominal"; nominal: TypeId; value: Expr }>`.
- `src/core/ir.ts`, continued: rename the pattern binding kind `data` to `nominal`. Keep `unbrand` in this item. Set `version: 3`.
- Lowering, the validator (`world.ts`, `typing.ts`, `expr.ts`, `expr_walk.ts`), the emitter (`decls.ts`, `expr.ts`, `fields.ts`, `walk.ts`, `shape.ts`, `scope.ts`), `interface.ts`, and `serialize.ts` follow. The emitter selects `TaggedStruct` when the unfolded base is a record, and `brand` otherwise.
- Run `deno task golden:update` and `deno task validate:update`. Review the regenerated files: the only differences are the version and the new kinds.
- Update `fixtures/ir/example/log.ir.json`, which `tests/check_test.ts:155`, `tests/lower_test.ts:119`, and `tests/validate_test.ts:2159` read. Update the hand-built IR in `tests/check_test.ts`, `tests/emit_alias_resolution_test.ts:37`, `tests/validate_expr_children_test.ts`, and `tests/validate_test.ts`, and the version assertion at `tests/lower_test.ts:692`.
- The emitted TypeScript of every fixture stays byte for byte the same. The golden files cover only the examples. So build every project directory under `fixtures/emit`, `fixtures/examples`, and `fixtures/applications` into `/tmp/nm-before` on `d0631c4` and into `/tmp/nm-after` after NM9. Then run `diff -r /tmp/nm-before /tmp/nm-after`. The diff must be empty. Record the command and the result in the commit body.

NM10 (the word `nominal` and the removal of `Brand`). Base: NM9.

- Parser: the declaration word `nominal` replaces `data`. It is a declaration word only at the start of a declaration, so `nominal` stays a legal name. `data` becomes an ordinary name. The body is any type (NM1).
- Resolver: remove `Brand` from the builtin type names.
- Checker: one `checkNominal` replaces `checkData` and the brand path of `checkTypeDecl`. It defines the base, and the record classification runs after the definition loop (NM5). It runs 009, 015, and 016 on the unfolded record, and 015 on a non-record body. Add the fixture `fixtures/errors/declaration-nominal-deferred-base.eff`.
- Emitter: one helper `nominalRecordFields(scope, decl)` resolves the base to its record fields. Use it in `typeDeclaration` and `recursiveData` (`decls.ts:388-391`, `507-530`), `checkKind` (`decls.ts:835-840`), `definitionType` (`emit/fields.ts:21-29`), and `recordFieldsOf` and the construction case (`emit/expr.ts:716-736`, `937-946`). The validator (`world.ts:524-540`) also checks deferred types in a non-record body.
- Checker messages and codes: retire `declaration/008` (Brand position). Retarget `declaration/014` (NM5). Update the messages and descriptions of `declaration/009`, `declaration/013` (also the message at `check.ts:1352-1354`), `declaration/015`, `declaration/016`, and the pattern messages to say "nominal type". Remove `Brand` from the exhaustive switches at `check.ts:611` and `check.ts:1379`.
- Cycle rules: a cycle needs a record nominal type and a base case, as a `data` cycle does today. A cycle through a non-record nominal type gives the code that a brand cycle gives today.
- Migrate every `.eff`, `.effi`, and test source: `data X =` becomes `nominal X =`, and `type X = Brand<T>` becomes `nominal X = T`. `bench/generate.ts:91`, `302`, and `315` generate `Brand<string>` and `unbrand`, and `tests/bench_generate_test.ts` checks the output. Migrate the `Brand` part here and the `unbrand` part in NM11. Rename the error fixtures whose names contain `data` or `brand`. Remove `declaration-brand-position.eff`. Change `declaration-brand-record-base.eff` to the NM5 union case.
- Delete `declaration/008` from `diagnostics.ts`. The registry has no convention for retired codes, and `tests/fixtures_test.ts` requires an error fixture for each registered code. Do not reuse the number. `syntax/008` stays, because `error` bodies still report it.

NM11 (widening, operators, and the removal of `unbrand`). Base: NM10.

- `types.ts` and `validate/typing.ts`: NM6.
- `check_binary.ts` and its validator mirror: NM7.
- Remove the builtin `unbrand` from the prelude, the resolver, `check_expr.ts`, `tables.ts`, and `check_builtins/registry.ts:19-22` (`CORE_ROW_NAMES`).
- Also remove `unbrand` from lowering, the IR, the validator, the emitter, and the description of `type-mismatch/004` (`diagnostics.ts:158`). Keep `$untagged` for NM8.
- Emitter: NM8 at nominal record construction.
- Migrate the 6 `unbrand(` uses in `.eff` files and the uses in tests. Some tests assert a `type-mismatch` for a nominal value in a base position. Change each such assertion to success. Add one test for each NM7 rule.
- Runtime tests in `tests/emit_slow_test.ts` cover four cases. A widened record value passed to another nominal constructor gives a valid value. An update argument (`B({ ...a, x })`) gets the copy. A nested widened value (`B({ inner: a })`) gives a valid value. A widened value encodes without `_tag`.
- An emit fixture with `id == "u1"`, `total > 0`, and `total * 2`, built with `--tsc` in a slow test.

NM12 (editor, grammar, playground). Base: NM11.

- `editors/vscode/syntaxes/effective.tmLanguage.json`: `nominal` replaces `data`. Remove `Brand` and `unbrand`.
- `playground/src/highlight.ts`, `src/core/editor_tokens.ts`, and `src/core/editor_completion.ts`: `nominal` replaces `data`.

NM13 (docs). `docs/language-rules.md`, `docs/api.md`, `docs/status.md`, `CONCEPTS.md`, and `README.md`. Each rule row for brands and data types becomes a row for nominal types. Run the STE check on the changed text.

NM14 (website, in `../effective`, separate commits). The spec moves to draft 0.60. It changes the declaration paragraphs, the brand operator paragraph (NM7), the widening rule (NM6), and the removal of `unbrand`.

The book: every figure with `Brand`, `data`, or `unbrand`, and the chapter "Nominal data", which becomes "Nominal types". `effective-examples/`: copy the migrated files from the fixtures. `typed-ir.ts` and `log.ir.json`: IR version 3. Run `deno task test` and `deno task typecheck`. Add a dated validation entry.

NM15 (archive). Move this plan to `docs/archive/plans/`, and fix the links.

## 6. Verification

- `deno task check` before each commit.
- Before and after NM9: the `diff -r` of all fixture builds is empty.
- After NM9: the emit golden files show no change in TypeScript text.
- After NM11: build each application fixture with `--validate --tsc`, and run its runtime cases.
- After NM14: the website tests and the strict check pass.

## 7. Risks

- NM6 changes a core relation. A wrong rule can accept a program that the emitted TypeScript rejects. The `--tsc` runs of the application fixtures and the emit slow tests are the check.
- NM7 makes `total + 5` legal with the result `int`. A function that returns `Cents` still rejects that `int`, so a lost unit shows up at the next contract.
- NM8 adds a copy at some constructions. The cost is not measured.

## 8. Validation findings

Fable validated the plan on 2026-10-23 and reported four major and six minor findings. The planner checked findings 1, 2, and 3 in the code, and measured the claims of findings 5 and 7. Each finding is resolved in the sections above.

1. Major: ordering comparisons used `isNumeric`, which NM6 widens, so `Cents < Meters` would pass. Resolved in NM7 with class compatibility.
2. Major: a non-record body had no deferred check (`Brand<Ref<int>>` gives 0 diagnostics). Resolved in NM5 and NM10 with a new fixture.
3. Major: alias bodies need classification after the definition loop, and 009, 015, and 016 must run on the unfolded record. Resolved in NM5 and NM10.
4. Major: the golden files cover only the examples. Resolved in NM9 with a full `diff -r` of fixture builds.
5. Minor: state the NM8 rule in IR terms, and cover the nested case. Resolved in NM8 and NM11. The nested case is measured.
6. Minor: `cents + meters` gave `int` while `cents == meters` was an error. Resolved in NM7: both are errors.
7. Minor: TypeScript comparability of a brand with a literal was not measured. Measured and recorded in NM7. NM11 adds a `--tsc` fixture.
8. Minor: `nominal B = A` must stay rejected. Resolved in the NM5 message.
9. Minor: missing files. Added to NM9, NM10, and NM11. `src/core/index.ts:242` and `editor.ts:299` keep the internal kind name `data`.
10. Minor: the placement of the NM6 rule. Resolved in NM6.


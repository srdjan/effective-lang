# Nominal keyword plan

Date: 2026-10-23. Base: `317d018` on local `main`. Status: draft for validation.

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

A body can be a union with a record member, or with a record nominal member. Such a body gives `declaration/014` with a new message: "a nominal union cannot contain a record; declare each record as its own nominal type". This keeps the old reason of `declaration/014`: a field read through a nominal union of records cannot occur. NM4 retires the old `Brand` meaning of `declaration/014`, not the code.

NM6 (widening). `TypeTable.assignable` gets one rule: a named nominal type that is not opaque fits a target when its base fits that target. The rule applies after the alias steps and after a direct match. It applies inside arrays, options, records, tuples, and unions, as `int` to `number` does.

The rule does not change the variance that the table enforces. `Ref`, `RetrySchedule`, `Codec`, and `Schema` stay invariant, and function parameters stay contravariant. An opaque type does not widen. An error does not widen to its record. The validator in `src/core/validate/typing.ts` mirrors the rule.

NM7 (operators). These rules replace the brand operator rules:

- `+` and `-` with two operands of one numeric nominal type give that type, as today.
- Any other arithmetic with a numeric nominal operand widens that operand to its base. `total * 2` gives `int`, `total + 5` gives `int`, and `total / 2` gives `number`.
- A string nominal operand of `+` widens to `string`.
- A comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`) accepts a nominal type with itself, with its base, and with a literal of its base. So `id == "u1"` is legal. Two different nominal types do not compare, even when their bases are equal: `userId == email` stays an error. This keeps the main protection of nominal primitives.
- The key class rules of `mapGroups` and of key unions do not change.

NM8 (runtime form of a widened record). A widened record nominal value keeps its `_tag` at run time, because widening emits no code.

Measured with Effect 4.0.5 on 2026-10-23: `Schema.encodeUnknownSync` and `Schema.decodeUnknownSync` of the base struct drop the `_tag`, and `Schema.is` of the base struct accepts the value. `B.make(a)`, where `a` has the `_tag` of `A`, throws "Schema validation failed".

So nominal record construction copies its argument without `_tag` (the existing `$untagged` helper) unless the argument is a record literal without a spread. A widened value cannot reach a record type with a `_tag` field, because a record fits only a record with the same field names. The validator must accept the construction node with any argument that fits the base.

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
- The emitted TypeScript of every fixture stays byte for byte the same. Check this with the emit golden files.

NM10 (the word `nominal` and the removal of `Brand`). Base: NM9.

- Parser: the declaration word `nominal` replaces `data`. It is a declaration word only at the start of a declaration, so `nominal` stays a legal name. `data` becomes an ordinary name. The body is any type (NM1).
- Resolver: remove `Brand` from the builtin type names.
- Checker: one `checkNominal` replaces `checkData` and the brand path of `checkTypeDecl`. Retire `declaration/008` (Brand position). Retarget `declaration/014` (NM5). Update the messages of `declaration/015` and `declaration/016` and the pattern messages to say "nominal type". Cycle rules: a cycle needs a record nominal type and a base case, as a `data` cycle does today. A cycle through a non-record nominal type gives the code that a brand cycle gives today.
- Migrate every `.eff`, `.effi`, and test source: `data X =` becomes `nominal X =`, and `type X = Brand<T>` becomes `nominal X = T`. Rename the error fixtures whose names contain `data` or `brand`. Remove `declaration-brand-position.eff`. Change `declaration-brand-record-base.eff` to the NM5 union case.
- Delete `declaration/008` from `diagnostics.ts`. The registry has no convention for retired codes, and `tests/fixtures_test.ts` requires an error fixture for each registered code. Do not reuse the number. `syntax/008` stays, because `error` bodies still report it.

NM11 (widening, operators, and the removal of `unbrand`). Base: NM10.

- `types.ts` and `validate/typing.ts`: NM6.
- `check_binary.ts` and its validator mirror: NM7.
- Remove the builtin `unbrand` from the prelude, the resolver, `check_expr.ts`, `tables.ts`, lowering, the IR, the validator, and the emitter. Keep `$untagged` for NM8.
- Emitter: NM8 at nominal record construction.
- Migrate the 6 `unbrand(` uses in `.eff` files and the uses in tests. Some tests assert a `type-mismatch` for a nominal value in a base position. Change each such assertion to success. Add one test for each NM7 rule.
- Runtime tests in `tests/emit_slow_test.ts`: a widened record value passed to another nominal constructor gives a valid value, and a widened value encodes without `_tag`.

NM12 (editor, grammar, playground). Base: NM11.

- `editors/vscode/syntaxes/effective.tmLanguage.json`: `nominal` replaces `data`. Remove `Brand` and `unbrand`.
- `playground/src/highlight.ts`, `src/core/editor_tokens.ts`, and `src/core/editor_completion.ts`: `nominal` replaces `data`.

NM13 (docs). `docs/language-rules.md`, `docs/api.md`, `docs/status.md`, `CONCEPTS.md`, and `README.md`. Each rule row for brands and data types becomes a row for nominal types. Run the STE check on the changed text.

NM14 (website, in `../effective`, separate commits). The spec moves to draft 0.60. It changes the declaration paragraphs, the brand operator paragraph (NM7), the widening rule (NM6), and the removal of `unbrand`.

The book: every figure with `Brand`, `data`, or `unbrand`, and the chapter "Nominal data", which becomes "Nominal types". `effective-examples/`: copy the migrated files from the fixtures. `typed-ir.ts` and `log.ir.json`: IR version 3. Run `deno task test` and `deno task typecheck`. Add a dated validation entry.

NM15 (archive). Move this plan to `docs/archive/plans/`, and fix the links.

## 6. Verification

- `deno task check` before each commit.
- After NM9: the emit golden files show no change in TypeScript text.
- After NM11: build each application fixture with `--validate --tsc`, and run its runtime cases.
- After NM14: the website tests and the strict check pass.

## 7. Risks

- NM6 changes a core relation. A wrong rule can accept a program that the emitted TypeScript rejects. The `--tsc` runs of the application fixtures and the emit slow tests are the check.
- NM7 makes `total + 5` legal with the result `int`. A function that returns `Cents` still rejects that `int`, so a lost unit shows up at the next contract.
- NM8 adds a copy at some constructions. The cost is not measured.

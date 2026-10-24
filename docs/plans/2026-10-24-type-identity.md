# Type identity: nominal qualities on `type` declarations

Date: 2026-10-24. Base: `8fc5fc6` on local `main`. Status: plan, not started. This document uses the ID prefix TI. It refers to the NI items of [the ideation document](2026-10-24-implicit-nominal-ideation.md) by their IDs.

## 1. Goal and decisions

The `nominal` keyword goes away. A plain `type` declaration gets identity by name from the compiler, with no new syntax. The user chose design NI4 on 2026-10-24, and decisions NI22 (a) and NI25 (a).

The plan takes the recommended option of each other NI decision. The user saw these recommendations and chose NI4 as the direction. The validation of NI4 checked NI4 with these options.

| Decision | Option taken |
| --- | --- |
| NI8 alias bodies | A union body with a non-literal member and a bare-name body give a transparent alias. Every other body gives identity. |
| NI9 literal-only unions | Identity. |
| NI10 TypeScript form | An untagged identity emits as a `type` alias emits today. Identity is erased in TypeScript. |
| NI11 literal at a union of variants | Error. The author writes `Fixed({ amount: 50 })`. |
| NI12 computed record into a tagged record | Needs `Name(value)`. |
| NI13 keywords | Delete `nominal` with no deprecation. Keep `sealed` as `sealed type Name = T`. |
| NI14 tagged standalone record | No form. A record outside a union has no tag. |
| NI22 primitive names | Identity. Each project declares its primitive names in one shared module. |
| NI25 arithmetic | A literal or unnamed operand adopts the class of the named operand for `+`, `-`, and `*`. |

TI0 (plan decision, NI18). A string `+` keeps the NM7 rule: the result is the unnamed `string`. So `"article:" + id` fits any string identity, such as `Key`. The cost: `(u: UserId): Email => u + ""` checks. The rule text in the language rules names this gap. The reason: a concatenation usually builds a different kind of string, and NI17 found 0 bugs that a stricter rule catches.

## 2. The rule

This is the amended NI4 rule of the validation, with TI0. Section 6 of the language rules gets this text.

Every `type` whose body is not a union with a non-literal member and not a bare name has identity by name. A union body with a non-literal member, and a bare-name body, give a transparent alias. A literal-only union body gives identity. Bodies `void`, `never`, `unknown`, and `null` give identity too (NI32).

Two different identities never mix: in any position, with equal bodies, and across modules. A named value fits its own body. After it widens to its body, it adopts no other name at that level. A named `int` does not fit a different named `number` (NI26).

An unnamed value is a literal, an operator result, or an inline record, array, or tuple literal. A builtin result that is typed by a primitive is also unnamed. A spread update keeps the name of its base. A field read, a call result, and a branch join keep their declared or joined names. An unnamed value fits an untagged identity whose body it fits.

An unnamed record fits a tagged record only as a record literal that is written at exactly that expected type. The checker records a construction there, and the emitter prints `Name.make(...)`. At a union target, and for every computed value, a tagged record needs `Name(value)`. The message says so.

A record identity is tagged when a union alias of its own module lists it, through transparent aliases. Every member of that union must be a tagged record, a record identity of the same module, or an error. A tagged record from another module counts as tagged. An inline union, such as a field type `Left | Right`, does not tag. A union in module B does not tag a record of module A (NI19).

A binary `+`, `-`, or `*` with one named numeric operand and one literal or unnamed operand gives the named class. This holds when the unnamed operand fits the base of the named operand. Otherwise the result widens: `cents * 1.5` gives `number`. `/` gives `number`. Two operands of one named class follow NM7: `+` and `-` give the name, and `*` gives the base. Two different named classes are an error, as today (`type-mismatch/007`). A string `+` follows TI0.

`sealed type Name = T` keeps the authority rules of `sealed nominal`. `sealed` on a transparent alias body gives the new code `declaration/017`.

## 3. Architecture

The probe of the validation showed the smallest working form (`/tmp/ni4-probe.patch`, temporary, 193 lines). TI follows it. Identity is a flag on an alias in the type table, and it is not a separate kind of definition.

In `src/core/types.ts`, `TypeTable` keeps every `type` body in `aliases`. It adds the set `identities` for the aliases with identity and the set `tagged` for the tagged record identities. `unfold` still follows every alias, so each structural query keeps working: field reads, array and option builtins, function calls, and tuple patterns. A new `unfoldTransparent` stops at an identity. Each place where identity has a meaning uses it: assignability, comparison classes, numeric classes, group key classes, pattern domains, and branch joins.

`brandBaseOf(id)` returns the body of an untagged identity. `dataRecordOf(id)` returns the body of a tagged identity. So construction, match by name, TE3 joins, host checks, and the `$untagged` copy keep their call sites. After the switch, `nominal` declarations do not exist. `defineBrand` and `defineData` stay only where another producer still needs them, such as opaque types. The implementer deletes each one that loses its last caller.

The IR version becomes 5. An identity lowers to `{ kind: "nominal", base, tagged?: true, sealed?: true }`. A transparent alias lowers to `{ kind: "alias", type }`. An opaque type keeps the `nominal` kind with an `unknown` base. The validator in `src/core/validate/` uses the same model: every `nominal` base goes into its alias map with an identity flag, and `tagged` decides the data set. Interface hashes include the flag, because they hash the IR.

The emitter prints `Schema.TaggedStruct` only when `tagged` is set. It prints an untagged `nominal` exactly as it prints an `alias` with the same body, including the type-only form for a body with a function. Construction of an untagged identity prints the argument expression. An operator with an untagged identity result prints as the same operator on its base.

## 4. Units

Each unit is one commit on local `main`. Each unit ends with `deno task check` green. The order is fixed, because each unit depends on the one before it.

### TI1: IR version 5 and the `tagged` flag (no change in behavior)

The checker sets `tagged: true` on the IR definition of each nominal record. The emitter (`emit/decls.ts`, `emit/fields.ts`, host checks) and the validator (`validate/world.ts`, `validate/expr.ts`, `validate/typing.ts`) test `tagged === true` where they test `base.kind === "record"` today. The validator reports `tagged` on a base that is not a record. `ir.ts` and `lower.ts` change the version to 5. Tests that assert version 4 of the IR change (`tests/lower_test.ts:691`, `tests/emit_alias_resolution_test.ts:37`). The LSP document versions in `tests/lsp_protocol_test.ts` are not IR versions and do not change.

Run `deno task validate:update` and `deno task golden:update`. The only expected diffs are the version and the flag in IR fixtures. Emitted TypeScript must not change.

### TI2: erase primitive identity in TypeScript (NI10 a)

A `nominal` declaration whose body is not a record emits as an alias emits today. It emits no `Schema.brand`. Construction prints the argument. An operator with a brand result prints the plain operator, with no `Name.make($int(...))`. The checker does not change in this unit.

Host TypeScript keeps compiling, because every schema has `make` (`Schema.d.ts:177`). Run `deno task golden:update`. Then build each application and `fixtures/host-adapter-files` with `--validate --tsc`. A host test that expects a `--tsc` error from a brand mismatch changes its expectation, and the commit body names it.

### TI3: identity on `type`, and removal of `nominal`

This unit is the semantic switch. It is large, because the checker, the validator, and the corpus must agree in one commit. The parts:

1. Parser (`parse.ts`): delete the declaration word `nominal`, so `nominal` becomes an ordinary name, as `data` did. `sealed` is followed by `type`. Delete `SyntaxKind.DataDecl` when nothing else needs it.
2. Checker classification (`check.ts`): `checkType` marks identity by the rule of section 2. Delete `checkNominal` and `classifyNominal`. Tag inference runs after every declaration of the module is defined, before `checkCycles`. A tagged record takes the cycle rules of a nominal record. An untagged record identity takes the alias rules. The record checks `declaration/009`, `declaration/015`, and `declaration/016` apply to tagged records. They report at the record field, as today. So a union alias over a record with a function field gives `declaration/015`. Delete `declaration/014` and its fixture. Its number is not reused.
3. Assignability (`types.ts`): the order of the probe. Transparent aliases unfold first. Two different identities never mix. A widened value does not adopt a name. An identity widens to its body. An unnamed value fits an untagged identity whose body it fits. The tagged-record exception follows section 2 (NI24). `Ref`, `Codec`, and `Schema` stay invariant by two-way assignability, so `Ref<int>` and `Ref<Cents>` mix and `Ref<Cents>` and `Ref<Meters>` do not.
4. Implicit construction (`check_expr.ts`): a record literal whose expected type is exactly a tagged record records the `data-construction` fact, and lowering gives the existing IR expression node `nominal`. `recordTarget` and the other `unfold(expected)` sites must reach the record body of an identity (NI32). A record literal at an expected union of variants reports `type-mismatch/003` and names the constructors that the author can write.
5. Operators (`check_binary.ts`): NI25 (a) and TI0 as section 2 states them. `comparisonClass`, `numericBrand`, and `groupKeyClass` use `unfoldTransparent`, so an identity has a class.
6. Patterns (`patterns.ts`, `check_patterns.ts`): the domain stops at identities. Match by name needs tagged members. A named record member without a tag gives `pattern/004` with the message "`X` has no runtime tag; no union alias of its module lists it".
7. Branch joins (`check_expr.ts`, TE3): they join tagged records and errors.
8. Sealed (`types.ts` `ownsSealed`, `foreignSealedOf`, `sealedRootOf`, and the validator): they read the identity set. `sealed` on a transparent alias gives `declaration/017` with a fixture (`tests/fixtures_test.ts:128` needs one fixture for each code).
9. Diagnostics (NI29): a type shows as `module#Name` when another type with the same short name occurs in the same message, or when the type comes from another module. `show()` in `types.ts` and its callers in `check_expr.ts` change.
10. Validator parity (NI20, NI28): `validate/typing.ts` and `validate/world.ts` apply items 3 to 8. Each new rule gets a mutation fixture in `fixtures/validate/` through `deno task validate:update`.
11. Emitter: section 3. The companion module of an `.effi` file follows the same forms. Host provider checks wrap a result that contains a tagged record.
12. Editor tables: delete `nominal` from `editor_tokens.ts`, `editor_completion.ts`, `playground/src/highlight.ts`, and `editors/vscode/syntaxes/effektive.tmLanguage.json`. Hover text changes from "nominal" to the form of the type.

The corpus migration in the same unit:

- Each `nominal` declaration becomes `type`, and `sealed nominal` becomes `sealed type`. The validation counted 126 declarations in 40 files, 179 test occurrences in 30 files, and 27 test occurrences of `sealed nominal`.
- A bare-name `nominal` body that needs identity gets its primitive body, for example `sealed type Positive = int` in `fixtures/errors/sealed-authority/lib.eff`. The 10 bare-name bodies are in 6 error fixtures.
- NI22: each multi-module application declares its primitive names once and imports them. `portable-publisher` declares `Text` in `domain.eff:1` and `platform.eff:1`. The implementer counts the other duplicates with `grep -rnE "type (Text|Int|Bool|Count) = " fixtures`.
- NI23: a value of one identity into another needs the constructor, for example `Text(key)` in `storage.eff` (13 sites). The validation counted 23 sites of class C2.
- NI27: `base * Cents(t.factor)` at `orders.eff:67` and `ArticleId(id) !== expectedId` at `storage.eff:48`.
- NI26: the error fixture `type-mismatch-binding-arrow.eff:12`, `schedules/composition.eff:35`, and the unit tests that the probe listed.
- NI30: the fixtures with same-module unions of plain records (`schema-general-union.eff`, `schema-optional-union.eff`, `forms/optional-fields.eff`, `pattern-nominal-subject.eff`). A record pattern over such a union becomes a match by name. JSON inputs of those unions get `_tag`.
- Recursive fixtures that use mutual recursion through untagged records get a union alias, or move to the error fixtures of `declaration/007`.
- `bench/generate.ts` declares primitive names once.
- Constructors that become removable stay in the source. Removal is TI6.

The implementer records each changed test expectation in the commit body by class: rule change, emitted text, or IR text. A test that fails for another reason is a defect and stops the unit.

### TI4: documentation

`docs/language-rules.md` replaces the nominal rows with the rule of section 2, and states the NI15 hazard and the NI33 trade: the wire form of a record depends on a union line of its module. `CONCEPTS.md` replaces "Nominal type" with "Type identity" and "Tagged record", and keeps "Sealed type". `docs/transpiler-design.md` adds a decision row for TI. `docs/tutorial.md`, `docs/status.md`, `docs/api.md`, `docs/editor.md`, and `docs/development.md` change each occurrence of `nominal`. `AGENTS.md` adds the prefix TI. Move the ideation document and this plan to `docs/archive/plans/` when TI5 is done, and update the prefix paths.

### TI5: website

In `../effektive/public/`, the spec and `index.html` replace `nominal` (63 occurrences in the spec) with the rule of section 2. The 12 `nominal` declarations in `effektive-examples/` become `type`. Check each changed example with the compiler, and run the strict checks of the site for TypeScript panels. Commit in that repository.

### TI6: terse source (optional, after TI5)

Remove each constructor that the new rule makes redundant in the applications and the examples, for example `Cents(50)` to `50` and `Revision(ready.revision + 1)` to `ready.revision + 1`. Measure the character count with the TE6 method.

## 5. Verification

For each unit, Opus runs these commands and reads the output:

1. `deno task check`.
2. `deno task effektive build fixtures/applications/<app> --validate --tsc` for each of the five applications, and for `fixtures/host-adapter-files`.
3. `git status --short` after the builds, to confirm that no unexpected file changed.

TI3 also needs these checks, each with a fixture or a unit test:

- `const r: Rule = { amount: 50 }` is an error, and `const f: Fixed = { amount: 50 }` emits `Fixed.make`.
- `(c: Cents): Count => c * 2` is an error, `c * 2` has type `Cents`, and `c * 1.5` has type `number`.
- `Text` of module A does not fit `Text` of module B, and the message prints both with module names.
- A match by name over a union of untagged records gives `pattern/004`.
- `sealed type X = A | B` gives `declaration/017`.
- The validator rejects a mutated IR for each new rule.

## 6. Risks and skipped work

These items are skipped on purpose. A hover text "variant of X" on a tagged record (the NI15 mitigation) is skipped: the language rules state the hazard, and a hover can come later. A warning when a union tags a record that a `Schema` also decodes is skipped. TS branding of exported identities (NI10 c, which NI31 needs to make the `Order` and `Receipt` protection reach host code) is skipped. The `Order` and `Receipt` protection holds in `.eff` code only.

TI3 is one large commit. The risk is a long red period during the unit. The implementer works in order 1 to 12, then migrates the corpus, then fixes the tests. The probe gives the expected size: 85 fast test failures before the corpus migration.

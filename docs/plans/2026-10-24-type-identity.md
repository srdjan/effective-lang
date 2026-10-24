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

## Validation of the plan (2026-10-24)

Base: `51468ef` on local `main`. Validator: Fable 5.1, adversarial. No compiler code, test, fixture, or website file changed. The findings continue the TI prefix at TI7. Each finding gives a severity, the defect, the evidence, and the correction to the plan text. The validator read every file that sections 3 and 4 name. The validator also read the probe at `/tmp/ni4-probe.patch`.

### Architecture check (question 2)

The flag-on-alias model is sound. `unfold` keeps every structural query working: `recordTarget` (`check_expr.ts:1503`), `recordFields` (`check_expr.ts:1321`), `readField`, the builtin checkers, `dataOnly` (`types.ts:1680`), `exceedsDepth`, `literalTag` (`check.ts:1841`), `containsDeferredType` and `containsOpaqueType` (`types.ts:1764`, `:1807`). The probe switches `numericBrand`, `comparisonClass`, and `groupKeyClass` to the identity walk. Four more sites erase identity through `unfold`, and the plan does not name them. They are `domainOf` (`patterns.ts:91`), `isNominalJoin` (`check_expr.ts:2058-2066`), and the union candidates of `recordTarget` (`check_expr.ts:1508`). The fourth is the validator `members` (`validate/typing.ts:158-168`), which the name pattern check uses (`validate/expr.ts:1396-1410`). TI9, TI10, and TI18 give the corrections. The emitter resolves through `scope.resolve` (`emit/scope.ts:643-657`), which stops at a `nominal` definition. TI12 gives the correction. Host checks (`emit/decls.ts:863-870`) and the `$untagged` copy (`emit/expr.ts:725-735`) read `dataFields`. Semantic tokens (`editor_tokens.ts:51`) and completion (`editor_completion.ts:57`) read `dataRecordOf`. So the `tagged` flag is enough for these four.

### Findings

TI7 (blocker). The probe drops the sealed authority in two places, and `sealed type` is never sealed. Observation: the probe block "an identity alias widens to its body" and the block "an unnamed value fits an identity" have no `ownsSealed(module, id)` test. The block that they replace has one (`types.ts:1386-1394`). `defineAlias` deletes the `sealed` flag (`types.ts:752`), and the probe keeps `defineAlias` for an identity. Effect: in a foreign module, `(): Positive => 1` and `(p: Positive): Int => p` check and emit. The row "Sealed nominal authority" forbids both (`docs/language-rules.md:32`). Correction to item 3: both blocks test `module === undefined || this.ownsSealed(module, id)`, and the "unnamed fits identity" block also tests `!this.opaque.has(tn.id)`. Correction to item 8: add `markSealed(id)` to `TypeTable`, and `checkType` calls it after `defineAlias` when `entry.sealed` holds and the body has identity. The validator `assignable` (`validate/typing.ts:224-233`) gets the same two blocks with `ownsSealed`. Section 5 adds the check "`(): Positive => 1` in a foreign module is an error" as a marker in `fixtures/errors/sealed-authority/main.eff`.

TI8 (must-fix). Item 4 does not say where the NI24 exception lives, so an implementer may add a flag to `assignable`. Observation: `recordConstruction` returns `type = target.ref`, and `recordTarget` returns `ref: expected` for a direct record target (`check_expr.ts:1505`). So a record literal at an expected tagged identity already gets the identity as its node type. No `fits` call sees a record source against a tagged target. Correction: `assignable` has no exception. An unnamed source never fits a tagged identity, in the checker and in the validator. `recordConstruction` records `data-construction` when `unfoldTransparent(expected)` is a named tagged identity. Lowering then gives the `nominal` expression node (`lower.ts:899-905`). "Exactly that expected type" means the `expected` argument of `recordConstruction`, after transparent aliases, is that identity and not a union. The hint flow already reaches `Some` arguments (`check_expr.ts:979-981`), array and tuple elements (`:1397-1409`), closure bodies (`:355`), field values (`fieldValue`), and branches with an expected type. State this in section 2.

TI9 (must-fix). `recordTarget` loses the identity of a union member. Observation: `flattenMembers` unfolds each tagged member to its record body (`check_expr.ts:1508-1511`), so the candidate list holds bodies without ids. Effect: `const r: Rule = { amount: 50 }` picks the body of `Fixed` and returns a structural record. The later `fits` reports a generic `type-mismatch/003`. The NI11 message cannot name the constructors. Correction to item 4: `recordTarget` uses `flattenIdentityMembers` and keeps `{ id, body }` for each named member. It unfolds an untagged record identity to its body for candidate selection. When the chosen candidate is tagged and the expected type is a union, the checker reports `type-mismatch/003`. The text is "a record literal does not pick a variant; write `Fixed({ ... })` or `Times({ ... })`". The node gets the error type.

TI10 (must-fix). Match by name and TE3 joins never see a tagged identity. Observation: `domainOf` (`patterns.ts:90-110`) and `isNominalJoin` (`check_expr.ts:2058-2066`) call `flattenMembers`, which unfolds a tagged identity to its record body. `dataRecordOf` then never matches. The validation of NI4 states that the probe did not measure match by name for this reason. Effect: every `match` over `Article` becomes a record domain, and `if` branches of two tagged records report `type-mismatch/009`. Correction to items 6 and 7: both functions call `flattenIdentityMembers` first. In `domainOf`, when every member is a tagged identity or an error, the domain is `nominal`. When some members are, the domain is `mixed`. Otherwise `domainOf` continues with `flattenMembers`. So a literal-set identity keeps the literal domain, and an untagged record identity keeps the record domain. A foreign union of untagged records keeps record patterns. `isNominalJoin` uses `flattenIdentityMembers` only.

TI11 (must-fix). Section 2 defines "unnamed" by the form of the value, but the operator code sees types only. Observation: `operatorResult` takes `left: TypeRef` and `right: TypeRef` (`check_binary.ts:132-138`), and the validator sees the recorded operand types (`validate/expr.ts:1598-1645`). Correction to section 2 and item 5: an operand is named when `unfoldTransparent` of its type is a numeric identity, as `numericBrand` reports. Every other operand is unnamed. Take exactly one named numeric operand, compatible classes, and an unnamed operand that fits the body of the named one. Then `+`, `-`, and `*` give the named type, in either operand order. `/` gives `number`. Two operands of one identity follow NM7. Two different identities give `type-mismatch/007`. The validator `numericBrandOf` (`validate/typing.ts:512-520`) reads `env.brands` only and must also read an untagged identity body. The `binary` node is exact (`docs/language-rules.md:781`), so item 10 adds the mutation "the recorded type of `c * 2` is `int`".

TI12 (must-fix). The emitter has more `nominal` sites than `decls.ts`. Observation: `scope.resolve` stops at a `nominal` definition (`emit/scope.ts:643-657`). `isTypeOnly` accepts `alias` only (`:626-640`). `recordFieldsOf` (`emit/expr.ts:924-930`), `numericBrand` (`:1086-1102`), the recursive alias form (`emit/decls.ts:393-430`), `recursiveGroups` (`:217-238`), and `encodedTypeDoc` (`emit/types.ts:336`) all branch on the definition kind. `isIntType(e.type)` reads the node kind without `resolve` (`emit/expr.ts:389-391`, `:1075`). Effect: after TI2, `a + b` with the type `Cents` emits without `$int`, which changes runtime behavior. An untagged recursive record identity loses the recursive alias form. Correction to section 3, TI2, and item 11: normalize the IR at the emitter entry (`emit/emit.ts`). Map every `type` declaration with `definition.kind === "nominal"`, `tagged !== true`, and `opaque !== true` to `{ kind: "alias", type: base }`. Apply the map to local and foreign declarations. TI2 applies the same map with the extra test `base.kind !== "record"`. In the `nominal` expression case (`emit/expr.ts:717-745`), print `kid(e.value)` when the declaration is not tagged. In the `binary` case, call `scope.resolve(e.type)` before `isIntType`.

TI13 (must-fix). TI1 misses one version site and two version texts. Observation: `validate/serialization.ts:48-54` rejects every IR whose version is not 4 with `validation/008`. `docs/api.md:289` and `:887` state version 4. The website copy `../effektive/public/log.ir.json` records `"version": 4`. Effect: after TI1, `--validate` rejects every module. Correction: TI1 changes `serialization.ts` and the two lines of `docs/api.md`. TI5 regenerates `log.ir.json`.

TI14 (must-fix). `TypeTable.load` keeps the old mapping for imported modules. Observation: `load` maps a `nominal` record base to `defineData` and every other base to `defineBrand` (`types.ts:951-965`). The plan does not name `load`. Effect: an imported identity becomes a brand or a data record. So the tag, the identity flag, and the guarded-alias mark of an imported module differ from the local module. Correction to item 3: `load` maps `nominal` with `opaque` to `defineBrand(unknown)` and `markOpaque`. It maps `nominal` with `tagged` to `defineAlias`, `markIdentity`, and `markTagged`. It maps every other `nominal` to `defineAlias`, `markIdentity`, and `markGuardedAlias` when `guardedRecord` holds. It calls `markSealed` when `sealed` holds.

TI15 (must-fix). The code registry and its tests are not in the plan. Observation: `src/core/diagnostics.ts:303-307` registers `declaration/014`. The test "every registered code has at least one error fixture" (`tests/fixtures_test.ts:128-141`) fails when the fixture goes and the entry stays. `declaration/017` has no entry (grep of `src` finds none). `tests/check_body_test.ts:3695` expects three `declaration/014`. The descriptions of `declaration/013`, `015`, and `016`, and the messages at `check.ts:1462`, `:1889`, and `:1928`, say "nominal". The fixture `declaration-nominal-deferred-base.eff` tests a non-record body, which becomes legal. Correction to item 2: delete the `014` entry, add the `017` entry, and change the texts. Keep `015` covered by `declaration-function-field.eff`. Move `declaration-nominal-tag-field.eff` to a tagged record.

TI16 (must-fix). Item 1 misses the declaration index and the parser fixtures. Observation: `src/core/index.ts:284-286` sets `sealed` only when `kind === "data"`. `index.ts:244` maps `DataDecl` to the kind `"data"`. `check.ts:1402` and `:1425-1427` branch on `"data"`. `parse.ts:827-844` expects `nominal` after `sealed` and reports `syntax/008` with the text "sealed nominal". `tests/parse_test.ts:515-526`, `tests/fixtures_test.ts:218-219`, `fixtures/parse/recovery-after-broken-declaration.eff:12-13`, `fixtures/parse/ok-forms.eff:7,25-27`, and `fixtures/parse/ok-forms.effi:7` use `nominal`. Effect: without the `index.ts` change, no `sealed type` is sealed. Correction: list these sites in item 1.

TI17 (must-fix). Tag inference needs the IR rewrite and the field spans. Observation: `checkType` lowers the body with `lower(body)` and pushes the IR definition at once (`check.ts:1528-1541`). `inferTags` in the probe marks the table and flips `infos[i].kind` only. `guardedDataGroup` reads the IR definitions in `this.types` (`check.ts:1813-1819`). `fields(body, true)` reports `declaration/009` during lowering (`check.ts:709-716`). Correction to item 2: `checkType` lowers a record body with `fields(body, false)` and keeps the field name spans. After tag inference and before `checkCycles`, the checker rewrites `this.types[i].definition`. A tagged record gets `{ kind: "nominal", base, tagged: true, sealed? }`. Every other identity gets `{ kind: "nominal", base, sealed? }`. It reports `009` and pushes `nominalFields` for tagged records only. The `TypeNodeInfo.kind` of an untagged identity stays `"alias"`, so `checkDepths` (`check.ts:1865`) keeps checking it.

TI18 (must-fix). Item 10 says "apply items 3 to 8" and names no validator function. Correction: list them. `world.ts:121-137` builds the env: `tagged` goes to `data`, every other `nominal` base goes to `aliases` with an identity set, `sealed` and `opaque` as today. `world.ts:573` tests `tagged` (TI1). `world.ts:584-596` is the parity rule of `declaration/014`. TI3 deletes it. After the TI1 change at line 573, every untagged record identity would fall through to it. It would then get "a nominal body cannot hold a nominal record". `typing.ts:62-71` gets `unfoldTransparent`. `typing.ts:158-168` gets an identity variant of `members`. `typing.ts:215-260` gets the identity blocks of TI7. `typing.ts:436-449` `fieldsOf` keeps `unfold`. `typing.ts:512-566` reads identity bodies. `expr.ts:1396-1410` uses the identity variant of `members`. `expr.ts:1585-1650` follows TI11. The mutation fixtures live as code. `MUTATIONS` in `scripts/validate_fixtures.ts:177` holds 17 entries, and the manifest holds 17 fixtures. "Through `deno task validate:update`" is not enough. Item 10 adds one `MUTATIONS` entry for each new rule.

TI19 (must-fix). Two documents are tested or misnamed. Observation: `tests/tutorial_test.ts:10-17` keeps `docs/tutorial.md` equal to `fixtures/tutorial/`. The plan migrates the fixture in TI3 and the document in TI4, so TI3 ends red. `docs/language-rules.md` has no "section 6": the rows are under "Declarations and types" (`:24-50`) and "Expressions, modes, and contracts" (`:51-82`). The hover text is `sealed nominal X` at `src/core/editor.ts:147`, not the word "nominal" alone. Correction: TI3 edits `docs/tutorial.md` with the fixture. Section 2 names the two heading rows. Item 12 names `editor.ts:147` and the new text `sealed type X`.

TI20 (minor). TI2 names only the host `--tsc` tests. Observation: no test asserts `Schema.brand` text. `tests/emit_test.ts`, `tests/emit_slow_test.ts`, and `tests/check_body_test.ts` contain `.make(`. `tests/emit_alias_resolution_test.ts:30-40` builds a brand IR by hand. Correction: TI2 names these four files as the expected test changes.

TI21 (minor, answer to question 3). TI1 holds: `dataFields` (`emit/fields.ts:22`) and `decls.ts:439` select `TaggedStruct` by the record base, and in TI1 every nominal record is tagged. The IR fixture, the 17 validate fixtures, and the interface hashes (`src/core/interface.ts:78-295`) change, and emitted text does not. TI2 holds with TI12. TI3 can split into three green commits with one meaning per keyword. TI3a adds the infrastructure with no behavior change. It adds the sets, `unfoldTransparent`, `flattenIdentityMembers`, and `markSealed`. It also adds the `load` mapping, the validator identity set, and the emitter normalization of TI12. TI3b gives identity to every `type` whose body is not a record, not a union with a non-literal member, and not a bare name. It adds NI25, NI29, the validator parity, and the corpus classes C1 to C4. `nominal` still parses with its brand and data meaning. TI3c adds record identity, tag inference, patterns, joins, the removal of `nominal` and `sealed nominal`, `declaration/014` to `017`, NI30, and the `.effi` tag loss. The plan may keep one commit; the split is a recommendation.

TI22 (minor). The lexer snapshot has a count rule. Observation: `tests/lex_snapshot_test.ts:50-70` requires that more than half of the snapshot files stay unchanged. Measured: 170 snapshot files, 181 source files in the repository, 40 files with `nominal`. Effect: when the corpus migration edits more than 84 files, the test fails without a lexer change. Correction: section 5 adds "run `deno task lex:update` when the count rule fails".

TI23 (minor, answer to question 4). Section 2 leaves these points open. State them. (a) `Schema<T>` and `Codec` decode of a tagged identity needs `_tag`. Decode of an untagged identity has no `_tag` and gives the identity type. (b) An `error` declaration is not a `type` and does not change. (c) A `type` in an `.effi` file follows the same rule. A host record gets a tag only from a union in the same `.effi`. `opaque type` keeps `nominal` with `unknown` and is never constructible. (d) `declaration/009`, `015`, and `016` for a record that a union tags report at the record field. The union line gets no diagnostic. (e) An untagged record identity in a cycle follows the alias rules. So two untagged records in mutual recursion give `declaration/007` unless a union tags one. (f) `status === "a"` is legal through the class chain. Two literal-set identities give `type-mismatch/007`. (g) A group key of an identity over `string`, `int`, or `boolean` is one key class. (h) An identity whose body is `never` fits everything. An identity whose body is `unknown` accepts every unnamed value. State that `unknown` bodies are legal.

TI24 (minor). Messages that name "nominal" or "type alias". Observation: `check_expr.ts:796-804` says "is a type alias, not a nominal type" for a constructor call on a transparent alias. `check_patterns.ts:257-275` has three messages with "nominal". Seven `shortName` calls in `check_patterns.ts` print short names, which NI29 covers for `show()` only. Correction to item 9: the constructor message becomes "`X` has no identity; only a type with identity is a constructor". The pattern messages name a tagged record. The NI29 rule applies to `shortName` in messages too.

TI25 (minor, answer to question 7). The commands are right: `deno task check` (`docs/development.md`) and `deno task effektive build <root> --validate --tsc` (`docs/api.md:535`). Section 5 adds these TI3 checks. `const f: Fixed = computed` with an unnamed record binding is an error (the second half of NI24). `n + cents` with an unnamed `n` has type `Cents`. `{ ...fixed, amount: 1 }` keeps `Fixed` and emits no `make`. `Ref<int>` and `Ref<Cents>` mix. One validate mutation each covers the binary result (TI11), a record into a tagged type, and an untagged member in a name pattern. One runtime run of `order-lifecycle` covers `match` by name with its nine cases (`docs/status.md:62`).

### Verdict

Executable after the listed corrections. TI7 is a blocker with a known fix. TI8 to TI19 are plan text that the implementer needs, because the probe does not show them. TI20 to TI25 are small text changes. The split of TI21 is optional.

## Resolution of the validation (2026-10-24)

Opus accepts TI7 to TI25. The correction text of each finding is part of the plan. It is binding for the implementer, as section 4 is. Where a correction and section 4 disagree, the correction wins. TI3 splits into three commits, as TI21 proposes. Each one ends with `deno task check` green.

The units and their findings:

| Unit | Content | Findings |
| --- | --- | --- |
| TI1 | IR version 5 and the `tagged` flag, no change in emitted text. Also `validate/serialization.ts:48` and `docs/api.md:289`, `:887`. | TI13, TI21 |
| TI2 | Erase non-record `nominal` in the emitter. The emitter entry maps an untagged non-record `nominal` to `alias`. The `nominal` expression prints its value for such a declaration. The `binary` case calls `scope.resolve` before `isIntType`, so `$int` stays. | TI12 (the part with `base.kind !== "record"`), TI20 |
| TI3a | Infrastructure, no change in behavior: the `identities`, `tagged`, and `sealed` sets on aliases, `markIdentity`, `markTagged`, `markSealed`, `unfoldTransparent`, `flattenIdentityMembers`, the `TypeTable.load` mapping, the validator identity set and its walk helpers, and the full emitter normalization. Nothing marks an identity yet. | TI12, TI14, TI18 (env and helpers) |
| TI3b | Identity for every `type` whose body is not a record, not a union with a non-literal member, and not a bare name. NI25 with the TI11 definition, NI29 with TI24, the sealed guards of TI7, validator parity, and `MUTATIONS` entries. Corpus classes C1 to C4 (NI22, NI23, NI26, NI27). `docs/tutorial.md` changes with `fixtures/tutorial`. | TI7, TI11, TI18, TI19 (tutorial), TI22, TI24 |
| TI3c | Record identity, tag inference with the IR rewrite, implicit construction, `recordTarget`, pattern domains, TE3 joins, removal of `nominal` and `sealed nominal`, `declaration/014` deleted, `declaration/017` added, NI30, and the `.effi` tag loss. | TI8, TI9, TI10, TI15, TI16, TI17, TI19 (hover), TI23, TI25 |
| TI4 | Documentation. The language rules get the rule text under "Declarations and types" and "Expressions, modes, and contracts", with the TI23 statements. | TI19, TI23 |
| TI5 | Website, including `log.ir.json` at version 5. | TI13 |

TI26 (plan decision for TI3b). The IR of TI3b cannot tell an untagged `nominal` declaration from a `type` identity, because both lower to `nominal` without `tagged`. So in TI3b they have one meaning: an untagged `nominal` declaration also accepts an unnamed value whose shape fits. This relaxes the old brand rule one unit before `nominal` goes away. Tests that expect a literal to need the constructor of a `nominal` type change in TI3b. A bare-name `nominal` body keeps identity until TI3c. A `nominal` record keeps its tag until TI3c.

Section 2 gets these statements. "Exactly that expected type" is the `expected` argument of `recordConstruction`, after transparent aliases, when it is a tagged identity and not a union (TI8). `assignable` has no tagged-record exception: an unnamed source never fits a tagged identity. An operand is named when `unfoldTransparent` of its type is a numeric identity (TI11). The rule holds in either operand order. The statements (a) to (h) of TI23 hold as written.

Section 5 gets the checks of TI7 and TI25. When the lexer count rule fails (TI22), run `deno task lex:update` and say so in the commit body.

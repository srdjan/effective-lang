# Plan: nominal data types (`data` declarations)

Status: validated, 2026-10-23. Fable reported 5 major and 8 minor findings. Opus accepted 12. Finding 1 needs the user's decision NT13. Section 8 maps each finding to its resolution.

This plan uses the ID prefix NT. NT1 to NT4 are the user's decisions. NT5 and later are work items.

## 1. Decisions

The user accepted these decisions on 2026-10-23. They replace the R2 form `type User = Brand<{ ... }>` from 2026-10-17 ([R2 plan](../archive/plans/2026-10-17-r2-nominal-records.md)). They also remove the two R2 exclusions: no `match` on a record brand, and no record brand as a `withResource` operation record.

- NT1 (declaration form). A new contextual declaration word `data` declares a nominal record: `data User = { id: UserId, name: Name }`. It has the same form as `error NotFound = { id: Id }`. `type` always declares an alias. `Brand<T>` stays only for a base that is not a record.
- NT2 (runtime identity). Each `data` value carries a runtime `_tag` field, as an error value does. A `match` selects by name, as in `Circle(c) => ...`. Its coverage check works by name.
- NT3 (encoded form). The encoded form includes `_tag`. External JSON without a tag decodes into a structural `type`, and then the program calls the constructor.
- NT4 (unions). A union of `data` types is an open union alias, `type Shape = Circle | Square`, like `fails NotFound | Other`.

The user also said that the best design has priority over the size of the change.

## 2. Language rules

These rules define the target behavior. Section 6 lists the diagnostics.

1. Declaration. `[export] data Name = { fields }`. The body is a record type literal. A field can be optional (`nick?: Nick`). An empty body `{}` is legal, and it gives a variant with no fields. The field name `_tag` is reserved, as it is for errors. `data` is a declaration word only at the start of a declaration, like `type`, so `data` stays legal as a variable name. `.eff` and `.effi` files can both declare `data`.
2. Identity. The id of a `data` type uses the prefix `type:` (`type:<module>#<Name>`), so the existing `named` type node carries it. A `data` type fits only itself. A structural record does not fit a `data` type. A `data` type does not fit a structural record, an alias of one, or another `data` type with the same fields.
3. Construction. `User(value)` takes one argument, which can be any expression that fits the base record of `User`. A record literal is the common case. A piped value is legal, as it is for a brand call today. The result type is `User`. `User(circle)` with `circle: Circle` fails, because a `data` value does not fit a structural record. The program writes `User(unbrand(circle))`.
4. Field read and update. `user.name` reads the field of the base record. Optional fields read as `Option`, as they do today. `{ ...user, name: n }` keeps the type `User`.
5. `unbrand(user)` gives the base record type. At runtime it gives a copy without `_tag` (see section 4, item 3).
6. Equality. `===` and `!==` reject `data` values, as they reject records (`type-mismatch/007`).
7. Match. A `match` on a subject whose members, after aliases are unfolded, are all `data` or `error` types uses name patterns `Name(binding)` and `_`. This generalizes the current `errors` domain to a nominal domain. Coverage needs one arm for each member, or `_`. The binding has the member type, for example `Circle`. Record patterns such as `{ kind: "c" }` do not apply to a nominal domain, and they give `pattern/004`. A subject that mixes nominal and structural members gives `pattern/004`.
8. `catch` handlers. These stay errors only. `catch { User(u) => ... }` keeps its current diagnostic, which says that the name is a type, not an error.
9. Data-only. A `data` type is data-only when every field type is data-only, like an error. So `data` values can occur in Codecs, Schemas, `mapGroups` results, and `withResource` operation results.
10. `withResource`. This rule depends on decision NT13 (section 8, finding 1). With NT13 (a), a `data` or `error` body cannot contain a function type, and `withResource` keeps structural operation records. With NT13 (b), the acquisition result can be a `data` type whose base is a nonempty record of required operations.
11. Recursion. A `data` type can refer to itself, and two or more `data` types can refer to each other. An alias can be part of such a cycle, for example `data Cons = { head: Item, tail: List }`, `data Nil = {}`, `type List = Cons | Nil`. Every cycle must contain at least one `data` type. Every cycle must also pass through an `Option`, an array, or a union that has a member outside the cycle. A cycle through required fields only, such as `data Loop = { next: Loop }`, gives `declaration/007`. A cycle of aliases only, and any cycle through an error, keep their current rules.
12. `Brand<T>`. The base must not be a record, a `data` type, or a union with such a member, after aliases are unfolded. A violation gives the new `declaration/014`, whose message tells the author to use `data`. Brands over primitives, literals, arrays, tuples, and options stay as they are. G2 (a field read on a brand of a union) therefore cannot occur.
13. Unions. `type Shape = Circle | Square` is an ordinary alias of a union. Union assignability is unchanged. A value of type `Circle` fits `Shape`.

## 3. Representation (Opus calls)

The validator must check these calls before the implementation starts.

- IR. `TypeDecl.definition` gains `{ readonly kind: "data"; readonly fields: readonly Field[] }` (`src/core/ir.ts`). A new expression node `Node<{ kind: "data"; data: TypeId; value: Expr }>` constructs a value. A new pattern kind `{ kind: "data"; data: TypeId; binding: Parameter; span: Span }` matches one. The IR keeps `brand` for erased brands only. A separate node keeps the meaning of each IR kind clear and lets the validator check each one separately.
- Type table. `TypeTable` gains `defineData(id, recordRef)` and `dataRecordOf(id)` beside `defineBrand` and `errorRecordOf` (`src/core/types.ts`). `TypeReader` exposes `dataRecordOf`. `DefinitionSource.types[].definition` gains the `data` kind, and `load` defines it. A `data` type is not a brand. After NT12 removes record brands, `brandBaseOf` never gives a record.
- Validator. `TypeEnv` in `src/core/validate/typing.ts` gains `data: Map<TypeId, RecordType>`, beside `brands` and `errors`. Each validator rule for `data` mirrors the checker rule.
- Type table writers. `defineData` deletes the id from `aliases`, `brands`, `opaque`, and `guardedAliases`. `defineAlias` and `defineBrand` delete the id from `data`, as the sibling writers do now (`types.ts:738-755`).
- Syntax. `SyntaxKind.DataDecl` has the same children as `ErrorDecl`. `DeclKind` in `src/core/index.ts` gains `"data"`. The resolver binds a `data` declaration with `declarationId("type", module, name)`. The resolver `Target` stays `{ kind: "type"; id }`. The checker tells a `data` type from an alias or a brand with `table.dataRecordOf(id)`. The checker maps the `data` declaration kind to the `type` prefix in `TypeNodeInfo` (`check.ts:1159`) and in the export ids (`check.ts:1217-1221`).
- `unbrand`. The IR keeps one `unbrand` node. The emitter selects the form from the argument type: when `scope.resolve(e.value.type)` names a declaration with `definition.kind === "data"`, it emits the copy without `_tag`. Otherwise it emits the bare value.
- Emitted form. `export const User = Schema.TaggedStruct("<token>", { ...fields })` and `export type User = typeof User.Type`, where `<token>` is `tokenOfId(id)` (`src/core/emit/scope.ts`), the same token form that errors use. Optional fields use `Schema.optionalKey`. Construction emits `User.make(value)`. `make` validates its input at runtime, as it does for a brand today, and `isTrivial` keeps `data` in the same row as `brand`.
- Recursive emitted form. Every declaration in a recursive group, `data` or alias, gets an explicit type. A `data` type emits an interface for the type and an interface for the encoded form. An alias emits `type List = Cons | Nil`, `type List$Encoded = Cons$Encoded | typeof Nil.Encoded`, and `const List: Schema.Codec<List, List$Encoded> = Schema.Union([Cons, Nil])`. `schemaDoc` and `encodedTypeDoc` take the set of ids in the group instead of one `recursiveId` (`src/core/emit/types.ts:343,407`). Each reference to an id of the group gets `Schema.suspend((): Schema.Codec<T, T$Encoded> => T)`. Section 4 has the probes.

## 4. Evidence

The probes ran on commit `323a4b8` in `/tmp/nominal-probe/`.

1. A `match` on `type Shape = Circle | Square` with `Circle = Brand<{ kind: "circle", ... }>` gives `pattern/004` today. `p.kind` on `type Pair = Brand<Circle | Square>` gives `type-mismatch/006`.
2. Effect 4.0.5 `Schema.TaggedStruct("m/Circle", {...})`: `make` adds `_tag` and drops unknown keys, the encoded form keeps `_tag`, a decode without `_tag` fails with "Missing key", and `Schema.Union([Circle, Square])` decodes by tag. `make` validates its input at runtime.
3. `Twin.make(plain)` throws "Schema validation failed" when `plain` is a `Circle` value that the program typed as the structural record. The stray `_tag: "m/Circle"` causes the failure. So `unbrand` on a `data` value must emit a copy without `_tag`, through an emitter helper in the style of `scope.fieldHelper`. `Schema.encodeSync(Struct)` of a value with a stray `_tag` drops the key.
4. `Opt.make({})` with an optional key gives `{"_tag":"m/Opt"}`.
5. Recursion (`/tmp/nominal-probe/fx/r.ts`): `deno check` accepts a self-recursive `Tree` and a mutually recursive `Forest`/`Node` pair through `Option`. It uses the interface and `Schema.suspend` form from section 3. Both `make` functions stay available, and encode followed by decode gives back the same value.
6. Fable probes (`/tmp/nt-validate/`): an alias inside a cycle that uses `typeof List.Type` fails `deno check` with TS7022 and TS2456 (`union.ts`). The explicit form in section 3 passes and round-trips (`union_b.ts`). The emitter's `Schema.Option(Schema.suspend(...))` with `Option.Option<Node$Encoded>` in the encoded interface passes and round-trips (`probe.ts`).
7. A function type in an error or a record brand checks clean today, and then `build` fails with "cannot emit main: unsupported" (`/tmp/nt-validate/fn-err/`, `fn-brand/`). The emitter has no schema for a function type (`src/core/emit/types.ts:345,410`).
8. A host value with a wrong or missing `_tag` does not throw in a `match`. The emitted chain does not test the last arm (`emit/expr.ts:1356-1362`), so the value takes the last arm.
9. The R2 code paths already give a record brand a field read, an update that keeps the type, construction through `brandConstruction`, `unbrand`, data-only checks, and editor completion of fields. NT6 moves each of these paths from "brand with a record base" to `data`.

## 5. Work items

Each commit must pass `deno task check`. Do the items in this order, because each item depends on the one before it. An item that adds or edits a `.eff` or `.effi` file must also run `deno task lex:update` and commit the new `fixtures/lex/snapshot.json`, because the lex snapshot test hashes every tracked source file (`scripts/lex_snapshot.ts:155-168`).

### NT5. Declare, construct, read, update, and emit `data` (one commit)

- Parser (`src/core/parse.ts`): add `data` to `DECL_WORDS`. Dispatch it to a `DataDecl` node that reuses `parseErrorBody`. Add `SyntaxKind.DataDecl` (`src/core/syntax.ts`).
- Index (`src/core/index.ts`): add `DeclKind` `"data"`, the `DECL_KINDS` row, and `splitDecl` handling, like `error`.
- Resolver (`src/core/resolve.ts`): bind `data` in `bindingFor`, `targetText`, `describeKind`, and `resolveDecl`, using the `type:` prefix and the `type` target kind. In callee position, a `data` target routes like a brand target.
- Checker (`src/core/check.ts`): add `checkData` beside `checkError`. It lowers the fields with the `_tag` reservation (`declaration/009`), calls `table.defineData`, and pushes a `TypeDecl` with the `data` definition. Map the `data` kind to `type` in `TypeNodeInfo` (`check.ts:1159`) and in the export ids (`check.ts:1217-1221`). `checkPrimitivePositions` (`check.ts:1246-1250`) must skip `DataDecl` as it skips `TypeDecl` and `ErrorDecl`. Change the `declaration/013` message to "a type, data, or error declaration". Apply the NT13 rule for function types in a `data` or `error` body (section 8, finding 1).
- Type table (`src/core/types.ts`): add `defineData`, `dataRecordOf`, `isDefined`, the `load` case, `show`, and `dataOnly` (it follows the fields, like an error). Assignability needs no change, because `named` is already nominal.
- Expressions (`src/core/check_expr.ts`): the callee route `case "type"` (`check_expr.ts:586`) tests `dataRecordOf` before `brandBaseOf`, and routes a `data` type to a `dataConstruction` check. That check has the same argument rule as `brandConstruction`, records a new fact `data-construction` (`src/core/tables.ts`), and gives `named(id)`. `recordFields`, `readField`, and `recordUpdate` accept `data`. `unbrandCall` accepts `data` and gives the base record type. `comparisonClass` gives no class for `data`.
- Lowering (`src/core/lower.ts`): `data-construction` lowers to the IR `data` node. Extend `targetId` and `lowerDeclarations`.
- Interface (`src/core/interface.ts`): `declarationRefs` and `graphOf` read `data` fields, so a module that exports a `data` type also carries the field types.
- Validator (`src/core/validate/`): add the `data` branch in `buildWorld` (`world.ts:120-124`, which now puts every non-alias into `brands`) and in `checkTypeDecl` (`world.ts:425-448`). Fill `env.data`. Add the `_tag` rule in `checkFieldNames` for both `data` and errors. `KIND_PREFIX` and `checkTypeIds` need no change, because the IR declaration kind stays `type` and a `type:` id already resolves through `world.types`. Do not add a `data:` prefix. In `compute`, add the `data` node. Make `get`, `update`, `unbrand`, `fieldsOf`, `dataOnly`, and `show` accept `data`. Add `exprChildren` for the node. The `brand()` message at `validate/expr.ts:969-975` says "not a brand" instead of "a type alias".
- Emitter (`src/core/emit/`): emit the `TaggedStruct` declaration in `decls.ts`, and read `data` fields in `interfaceReferences`. The IR `data` node emits `X.make(kid(value))`. `unbrand` of a `data` value emits the helper copy without `_tag`. Extend `recordFieldsOf`, `isOptionalField`, `recordMemberLacksField`, `needsFieldAdapter`, and `adapterBody`. Check that an adapter keeps `_tag`. Extend `scope.isTypeOnly`, `scope.resolve`, `shape.ts` ROWS, `walk.ts`, `isTrivial`, and `expectedChildren`. Field names that need `safeRecord` or `__proto__` handling must work, as they do for a record brand today.
- Tests: add a new emit form `fixtures/emit/forms/data-types.eff` that covers declaration, construction (literal, piped, `User(unbrand(other))`), field reads (required and optional), update, `unbrand`, a `data` field inside an error, and a Codec round trip of a `data` type. Add `data-types.eff` to `buildForms` in `tests/emit_slow_test.ts` (lines 126-139), which lists the forms that the slow test builds and type-checks. Add a `data` case to `tests/data_only_rule_test.ts` and to the leaf-row count in `tests/emit_shape_test.ts` (line 251). Add checker tests for the nominal rejections in rule 2, and validator tests for each new validator rule. Run `deno task lex:update`.

### NT6. Match by name (one commit)

- Resolver: `ctorRef` (`resolve.ts:785-794`) accepts a `type` target. The checker then decides with `table.dataRecordOf(id)`, and it reports `pattern/004` with "is a type alias, not a data type" for any other type. `handler` keeps `errorRef`, which gives the rule 8 message.
- Checker (`src/core/patterns.ts`, `src/core/check_patterns.ts`): `domainOf` gives a nominal domain when every flattened member is an error or a `data` type. The coverage key is the declaration id. A `data` constructor pattern gives the binding `named(id)`. `missingOf`, `checkCoverage`, `reach`, and `describeDomain` follow the domain. Replace the silent `invalid` at the constructor-pattern fallback with an explicit diagnostic. New pattern facts go in `src/core/tables.ts`.
- Lowering: a `data` pattern lowers to the IR `data` pattern.
- Validator: the existing `error` case (`validate/expr.ts:1404-1411`) accepts only subjects whose members are all errors, so it rejects the `NotFound(e)` arm of a `match` over `User | NotFound`. Both the `error` case and the new `data` case require every subject member to be a `data` or error id, and the matched id to be a member.
- Emitter: `armTest` emits `sel._tag === "<token>"` for a `data` pattern, and `patternBinding` binds it.
- Tests: error fixtures for missing coverage (`pattern/001`), an unreachable arm (`pattern/002`), a record pattern on a nominal domain, and a mixed subject (`pattern/004`). The emit form covers a match over `type Shape = Circle | Square`, a `_` arm, a subject that mixes a `data` type and an error, and an empty-body variant. Run `deno task lex:update`.

### NT7. `withResource` with a `data` operation record (one commit)

- `operationRecord` (`src/core/check_builtins/scope.ts`) and `checkOperationRecord` (`src/core/validate/families/scope.ts`) accept a `data` type and read its base record. Check that the emitted use and release calls work on a value that carries `_tag`.
- Tests: one checker test, one validator test, and one case in the emit form.

### NT8. Recursive `data` types (one commit)

- `checkRecursion` (`src/core/validate/world.ts:636-711`) and the checker recursion rule (`check.ts:1418-1465`, `declaration/007`) allow the cycles of rule 11. `fixtures/errors/declaration-recursive-type.eff` (`Ping`/`Pong` aliases through `Option`) must still fail.
- Emitter: `orderTypeLevel` must not depend on a cycle cut. Compute the recursive groups once. Each declaration of a group emits the explicit form from section 3, with the set of group ids passed to `schemaDoc` and `encodedTypeDoc`.
- Tests: `Tree` (array), mutual `Forest`/`Node` (`Option`), and `List = Cons | Nil` (an alias in the cycle). Add an error fixture for an unguarded cycle. Each emitted form must pass `deno check` in the slow test. Run `deno task lex:update`.

### NT9. Remove record brands and migrate (one commit)

- `checkType` reports `declaration/014` for a `Brand` base under rule 12. Mirror it in `checkTypeDecl`.
- Delete the record-brand branches that NT5 moved to `data`: field reads, updates, and record handling in `unbrand` through `brandBaseOf`, in the checker, validator, emitter, and editor completion.
- Migrate each `Brand<{` use: `fixtures/emit/forms/nominal-records.eff`, `fixtures/emit/forms/optional-fields.eff`, `fixtures/errors/type-mismatch-nominal-record.eff`, `tests/check_body_test.ts` (near line 3421), and `tests/validate_test.ts` (near line 2956). Update the expectations in `tests/emit_test.ts` (near lines 635-664).
- Examples (Opus call): in `fixtures/examples/` (structural records at `users.eff:4`, `pay.eff:5`, `collections.eff:4`), declare a domain entity record as `data` only when no host layer and no JSON input supplies it. Keep structural `type` records for other shapes. Regenerate the goldens (`deno task golden:update`), which the tests compare byte for byte and build with `--tsc --validate`, and the validate fixtures (`deno task validate:update`).
- Add an error fixture for `declaration/014`. Run `deno task lex:update`.

### NT10. Editor and tools (one commit)

- `src/core/editor_tokens.ts`: add `data` to `contextualKeywords`. In `resolvedKind`, give a `data` type the `class` kind, like an error. Extend the fallback for a recovered declaration.
- `src/core/editor.ts`: `targetSpan` and `symbolOf`. `src/lsp/features.ts` `SYMBOL_KINDS`: `data` maps to Struct.
- `src/core/editor_completion.ts`: a type context offers `data` types. A `fails` context does not. Field completion reads `dataRecordOf`.
- `editors/vscode/syntaxes/effective.tmLanguage.json`: add `data` to `declaration-words`. `playground/src/highlight.ts`: add `data` to `DECLARATION_WORDS`. Rebuild the playground output if the repository tracks it.
- Tests: token, completion, and rename tests for a `data` type and its constructor calls.

### NT11. Documentation (one commit in this repository)

- `docs/language-rules.md`: replace the "Record brand" row (line 51) with `data` rows. Update lines 28, 47, 52, 524, 794, and 827-828.
- `docs/api.md` (lines 182, 194, 196, 242) and `docs/transpiler-design.md` (lines 20, 516, 543, 655, 770): describe `data`, the `data-construction` fact, and `TaggedStruct`.
- `CONCEPTS.md`: add the term "data type". `docs/status.md`: add the change. Neither file mentions brands or R2 today. `docs/api.md:182` (rule R1) says "type, data, or error declaration". The `.effi` rules say that host code must build `data` values with `make`, and that a value with a wrong `_tag` takes the last `match` arm (section 4, item 8).
- Archive this plan to `docs/archive/plans/` when every item is done.

### NT12. Spec site (one commit in `../effective/public/`)

- `effective-spec.html`: grammar (`dataDecl = "data" Name "=" recordType`, lines 498-503), the nominal records section (lines 88-105, with the `spec-account` example), lines 10, 46, 156, 456, and 533.
- `index.html` (lines 71-74), and `typed-ir.ts` (the `data` node near line 201, the `Pattern` type near line 140, and the `TypeDecl` definition near lines 417-430).
- Add a dated entry to `effective-validation.txt`.

## 6. Diagnostics

- New: `declaration/014`, "a brand base cannot be a record; declare a nominal record with `data`".
- New with NT13 (a): `declaration/015`, "a function type cannot occur in a data or error declaration".
- Reused: `declaration/009` (the `_tag` field in `data`), `declaration/007` (an unguarded recursive `data` cycle), `type-mismatch/003` (nominal mismatch), `type-mismatch/007` (equality), `pattern/001`, `pattern/002`, and `pattern/004`.
- NT6 adds a message for a constructor pattern whose name is a `data` type outside a nominal domain. It reuses `pattern/004` with a precise message.

## 7. Risks and checks

- Encoded form. Every nominal record now encodes `_tag`. Any stored JSON of a current `Brand<{...}>` value has no `_tag` and fails to decode. No fixture or example stores one. Host TypeScript code must build `data` values with `User.make(...)`.
- Stray tags. A host value that carries a wrong `_tag` and reaches `make` throws at runtime (section 4, item 3). In a `match`, such a value takes the last arm without an error (section 4, item 8). The language paths cannot produce one, because `unbrand` strips the tag.
- Validator parity. Each checker rule has a validator mirror (section 3). `build --validate` must pass on every new fixture.
- Behavior capture. Run `deno task behavior:capture` between the base and the head of each item. Only the files that the item names may change. Run the captures one at a time.
- Interface hash. A module that adds a `data` declaration changes its interface hash. This is expected.

## 8. Validation findings

Fable validated the draft on 2026-10-23 and reported 13 findings. Probes are in `/tmp/nt-validate/`.

1. Major: a `withResource` operation record has function fields, and the emitter has no schema for a function type. A `data` type with a function field cannot be a `TaggedStruct`, and today an error or record brand with a function field crashes `build` (section 4, item 7). Open: decision NT13. (a) A `data` or `error` body cannot contain a function type, with a new `declaration/015`, and `withResource` keeps structural records (recommended). (b) A second emitted form without a schema for a `data` type with function fields, which `dataOnly`, Codec, and Schema reject. NT7 depends on the answer.
2. Major: an alias inside a recursive group fails today's alias rule and `deno check`. Accepted. Rule 11 and the recursive emitted form in section 3 now cover aliases in a group, and NT8 passes the set of group ids.
3. Major: an item that adds a fixture fails the lex snapshot test. Accepted. Every such item runs `deno task lex:update`.
4. Major: `checkPrimitivePositions` would reject primitives in a `data` body. Accepted in NT5, with the `declaration/013` message and `docs/api.md:182`.
5. Major: the validator `error` pattern case rejects a mixed subject. Accepted in NT6.
6. Minor: `KIND_PREFIX` and `checkTypeIds` need no change. Accepted in NT5.
7. Minor: the resolver has no carrier for the `data` kind. Accepted: `Target` stays unchanged, and the checker decides with `dataRecordOf` (section 3, NT5, NT6).
8. Minor: type table writers must clear sibling maps, and `unbrand` stays one IR node. Accepted in section 3 and NT5.
9. Minor: `make` validates for brands today too. Accepted in section 3.
10. Minor: a wrong host `_tag` takes the last `match` arm. Accepted in section 4, section 7, and NT11.
11. Minor: the selection rule for the examples, and the goldens. Accepted in NT9.
12. Minor: wrong line claims and missing tests. Accepted in NT5, NT11, and NT12.
13. Minor: the order works, and NT5 must be one commit. No change.

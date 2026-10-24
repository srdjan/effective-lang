# Implicit nominal types: research and ideation

Date: 2026-10-24. Base: `67e8838` on local `main`. Status: ideation only. No compiler code, test, fixture, or website file changed for this document.

This document uses the ID prefix NI. NI1 to NI6 are designs. NI7 to NI14 are decisions for the user. NI15 to NI21 are risks. No other document uses NI.

## 1. The request

The user wrote: "I want the 'nominal' type to be attribute of the regular 'type' declaration, not exposed through the syntax, but implemented by the compiler: we want to have a hybrid of structural typescript typing and the best qualities from the 'nominal' typing without exposing special syntax to the user".

The AGENTS.md acceptance exception of 2026-10-24 applies. A compiler or syntax change that makes source more terse and elegant is welcome without an application blocker. It must keep source easy to read, keep closed contracts, and keep explicit exported contracts.

## 2. Current state

These are observations. Each one names its evidence.

A `type` declaration is a structural alias, and a `nominal` declaration has identity by name (`CONCEPTS.md:66-70`). The parser accepts the declaration words `type`, `opaque`, `nominal`, `sealed`, `error`, and `service` (`src/core/parse.ts:71-76`, `742-756`). `nominal` and `sealed` both produce `SyntaxKind.DataDecl`.

The checker lowers a nominal body first as a brand and classifies it after every declaration of the module is defined (`src/core/check.ts:1397-1413`, `1561-1596`, `1603-1666`). A body that is a record after aliases unfold becomes a nominal record (`defineData`). Any other body stays a brand (`defineBrand`). The two kinds share the IR definition kind `nominal` (`check.ts:1580-1584`).

Assignability unfolds aliases on both sides (`src/core/types.ts:1372-1383`). Then a named nominal type fits its base when the type is open or the module owns it (`types.ts:1384-1394`). A named target accepts only the same id (`types.ts:1421-1423`). So a literal, a `string`, or a record literal never fits a nominal type without the constructor. The validator mirrors the rule (`src/core/validate/typing.ts:224`, `258`).

Construction routes a `type` target by `dataRecordOf` to `brandConstruction` or `dataConstruction`, and both share `constructFrom` (`src/core/check_expr.ts:604-608`, `782-864`). A record literal already receives an expected type (`check_expr.ts:1378`, `1552`). Branch joins form a union when every branch is a nominal record or an error (`check_expr.ts:2018`, TE3 in `docs/plans/2026-10-24-terse-source.md:71-87`).

The pattern domain is nominal when every member is an error or has `dataRecordOf` (`src/core/patterns.ts:90-110`). Comparison classes come from `brandBaseOf` (`src/core/check_binary.ts:20-34`, `58-85`).

The emitter prints `Schema.TaggedStruct` for a nominal record and `<schema>.pipe(Schema.brand("<module>#<Name>"))` for any other nominal body (`src/core/emit/decls.ts:436-448`). A type-only alias prints as a TypeScript `type` (`decls.ts:426-434`). The validator checks the `sealed` flag and the record rule (`src/core/validate/world.ts:124-128`, `532-548`, `573-593`).

The Primitive positions rule R1 (`declaration/013`) rejects `string`, `int`, `number`, `boolean`, and literal types outside a `type`, `nominal`, or `error` body (`check.ts:1448-1466`, `docs/language-rules.md:48`). The user chose this on 2026-10-17 (D26 to D31 in `docs/transpiler-design.md:39-44`).

The earlier assessment offered "only a brand, in every position" as option D26 (b) and "a brand in exported signatures" as D26 (c). The user took D26 (a) because (b) and (c) made arithmetic verbose, and a literal operand needed `count + Count(1)` (`docs/archive/raw-types-and-nominal-records.md:117-123`, `158`). That reason has weakened. Plan NM removed `unbrand`, made a nominal value fit its base, and let `total * 2` give `int` (`docs/archive/plans/2026-10-23-nominal-keyword.md:26-29`, `43-53`). A literal operand still needs the constructor today.

`docs/rejected.md` holds only measured performance ideas. It has no entry about implicit nominality (`docs/rejected.md:28-30`). The spec is draft 0.63 and describes `nominal` in its declaration and operator sections (`../effektive/public/effektive-spec.html`, lines 12-13, 94-98, 108-120, 155-160, 182-186).

Effect 4.0.5 gives every schema a `make` method (`Schema.d.ts:177` in the Deno npm cache), `brand` (`Schema.d.ts:4381`), and `TaggedStruct` (`Schema.d.ts:5092`). Plan NT measured that `TaggedStruct.make` adds `_tag`, that a decode without `_tag` fails, and that `make` throws on a foreign `_tag` (`docs/archive/plans/2026-10-23-nominal-data-types.md:56-58`).

## 3. Measurements

All counts come from `grep` and `perl` over the repository on 2026-10-24. The patterns match declaration lines, so a declaration inside a comment counts too.

| Measure | Count | Method |
| --- | --- | --- |
| `.eff` and `.effi` files | 181 (173 under `fixtures/`) | `find` |
| `nominal` declarations | 126 in 40 files | `^\s*(export\s+)?(sealed\s+)?nominal\s+[A-Z]` |
| `sealed nominal` declarations | 2 in 1 file (`fixtures/errors/sealed-authority/lib.eff`) | same |
| `type` declarations | 513 in 134 files | `^\s*(export\s+)?type\s+[A-Z]` |
| `error` declarations | 83 | same form |
| `type` bodies: record | 235 | perl classifier on the body text |
| `type` bodies: one primitive | 172 | same |
| `type` bodies: union of names | 35 | same |
| `type` bodies: literal or literal union | 24 | same |
| `type` bodies: function | 10 | same |
| `type` bodies: array, tuple, option | 6, 5, 5 | same |
| `type` bodies: one other name | 4 | same |
| `type` bodies: other forms | 17 | `void`, `never`, `unknown`, `null`, deferred, opaque, broken fixtures |
| Application corpus (`fixtures/applications`, 16 files): `type` | 42 | 14 primitive aliases, 20 records, 5 unions of names |
| Application corpus: `nominal` | 24 | 9 primitive bodies, 15 record bodies |
| `fixtures/examples` and `fixtures/tutorial`: `type` and `nominal` | 15 and 2 | 11 of the 15 are primitive aliases |
| `.effi` declarations | 6 `type`, 5 `nominal`, 2 `error`, 5 `service` | all 5 `nominal` bodies are records |
| Structural records with function fields in the application corpus | 5 | `ArticleCodec`, `LexicalOps`, `TimeOps`, `PublishGrant`, `KeyValue` |
| `Schema<T>` decodes into a structural record | 4 | `StoredArticle`, `Policy`, `OrderInput`, `Request` |
| `Schema<T>` decodes into a union of nominal records | 1 | `Order` in `order-lifecycle/orders.eff:4` |
| Service results that are structural records | 6 types | `Receipt`, `Item`, `ObservedArticle`, `User`, `Order` (pay), `Book` |
| Explicit `Name(literal)` constructions in the application corpus | 3 | all `Cents(...)` |
| Explicit nominal primitive constructions with a computed argument | 17 | `Revision(ready.revision + 1)` and others |
| `Name({ ... })` record constructions in the application corpus | 55 | `\b[A-Z]\w*\(\{` |
| `match` arms by name on nominal records | 29 in 2 files | `feature.eff`, `orders.eff` |
| Hand-written host TypeScript files with `.make(` | 15 | files without a `.ts.map` sibling |
| Host `.make(` calls on primitive brands | 77 | `Payload` 39, `Key` 25, `Cents` 5, `Version` 4, `BookId` 4 |
| Host `.make(` calls on nominal records | 19 | `Row` 8, `Sum` 3, `Fixed` 3, `Gap` 2, `Token` 1, `Times` 1, `Capped` 1 |
| Test files with `nominal X` in source text | 29 files, 173 occurrences | `tests/*.ts` |
| Test occurrences of `sealed nominal` | 18 | `tests/*.ts` |
| Website: the word `nominal` in the spec and index | 173 | `effektive-spec.html`, `index.html` |
| Website examples: `nominal` and `type` declarations | 12 and 90 | `effektive-examples/` |

Two facts from the corpus shape every design. First, 172 of 513 `type` declarations name one primitive, such as `type Int = int` or `type Text = string`. R1 forces these names. In the application corpus, 14 of 42 `type` declarations are such names. Second, `service-workflow/contracts.eff:4-5` declares `Order` and `Receipt` with identical fields. The host adapter returns the inserted row as the `Receipt` (`adapter.ts:40-45`). Today the two types are interchangeable.

Five unions of names exist in the application corpus. Each one sits in the same module as its members (`domain.eff:23`, `35`, `feature.eff:8`, `contracts.eff:16`, `24`). Four unions have nominal record members, and one has error members. `PublishPlan` (`domain.eff:36`) is the only application nominal record outside a union.

## 4. Prior art

The table gives the rule of each system and what Effektive can take from it. Entries marked "from memory" were not fetched today.

| System | Rule | Lesson |
| --- | --- | --- |
| Go defined types ([spec](https://go.dev/ref/spec)) | A defined type "is different from any other type, including the type it is created from". A value is assignable when "V and T have identical underlying types ... and at least one of V or T is not a named type". "x is an untyped constant representable by a value of type T" also assigns. | The hybrid the user asks for exists as one rule. Two names never mix. A name and a shape mix. A literal adopts the name. No keyword marks the nominal type. |
| Unison ([unique](https://unison-lang.org/docs/language-reference/unique-types), [structural](https://unison-lang.org/docs/language-reference/structural-types)) | A type without a modifier has identity by name. `structural` opts into identity by shape. | Name identity can be the default. The opt-out is the rare word. |
| Hack `newtype` ([docs](https://docs.hhvm.com/hack/types/type-aliases), [modules](https://docs.hhvm.com/hack/modules/type-aliases/)) | The alias is transparent in its file or module and opaque elsewhere. | Export-boundary nominality is a known design. It ties assignability to the module. |
| Flow opaque types ([docs](https://flow.org/en/docs/types/opaque-types/)) | Same as Hack, with an optional supertype that stays visible outside. | The visible supertype matches Effektive widening to the base. |
| Scala 3 opaque types ([book](https://docs.scala-lang.org/scala3/book/types-opaque-types.html), [details](https://www.scala-lang.org/api/docs/other-new-features/opaques-details.html)) | Transparent in the defining scope, abstract outside, no runtime cost. | Erasure at run time is normal for primitive identity. |
| OCaml private types ([manual](https://ocaml.org/manual/privatetypes.html)) | `type t = private int` is distinct from `int`, and coercion back to `int` stays legal. | One-way widening to the base is a known pattern. |
| Modula-3 `BRANDED` ([notes](https://www2.cs.arizona.edu/~collberg/Teaching/520/2008/Notes/Notes-15.pdf)) | Structural equivalence by default. A brand gives name equivalence. | This is the current Effektive model. The brand word is the opt-in. |
| Zig literals ([0.14 note](https://www.openmymind.net/Zig-Removes-Anonymous-Structs/), [thread](https://ziggit.dev/t/surprising-zig-0-14-0-incompatibility-when-initializing-arrays-of-structs/8917)) | An untyped `.{ ... }` literal takes the type of its result location. Named struct types are distinct. | A record literal at a known expected type can construct a nominal record with no call. A computed value cannot. |
| Elm ([opaque by export](https://exercism.org/tracks/elm/concepts/opaque-types)) | A record alias is structural. A custom type with variants has tagged identity. A module hides variants by its export list. | The tag belongs to a variant of a sum, not to a standalone record. |
| Gleam ([tour](https://tour.gleam.run/advanced-features/opaque-types/)), Roc (`:=`, older docs) | Opaque types keep constructors in the module. | Owner-only construction is today's `sealed`. |
| Kotlin value classes ([docs](https://kotlinlang.org/docs/inline-classes.html)) | One-property wrapper, erased when possible. | Erasure is the normal case for a primitive wrapper. |
| TypeScript brands ([overview](https://dev.to/jsmanifest/typescript-branded-types-vs-nominal-types-which-pattern-should-you-use-in-2026-13d1)) | `string & { readonly [brand]: ... }` with a `unique symbol`. A class with a private member is nominal (from memory). | This is the target form of the emitter today. |
| Effect Schema ([advanced usage](https://effect.website/docs/schema/advanced-usage/), local `Schema.d.ts`) | `Schema.brand` attaches a brand. `TaggedStruct` adds `_tag`. Every schema has `make`. | Both emitted forms exist. A plain `Schema.String` also has `make`, so host `Key.make("k")` can stay valid without a brand. This needs a `--tsc` build to confirm. |
| Rust and Haskell newtypes, Swift structs, ReScript records (from memory) | Every declared type is nominal. A literal needs the constructor or an expected type. | Nominal by default is common. Literal flow-in is the convenience that keeps it terse. |

## 5. Qualities to keep and to gain

The user wants a hybrid. This section separates the two sides. Each line names the Effektive rule it maps to.

| Side | Quality | Effektive rule today |
| --- | --- | --- |
| Nominal, to gain for `type` | Identity between names: `UserId` and `Email` do not mix | `type-mismatch/003` |
| Nominal, to gain | Operator classes: `cents + meters` is an error | Row "Nominal operators" |
| Nominal, to gain | Match by name with coverage | Row "Match by name" |
| Nominal, to gain | Union joins of variants | TE3 |
| Nominal, to gain | A runtime tag for discrimination and host checks | Rows "Nominal record values at run time", "Host provider checks" |
| Nominal, to gain | Owner-only construction | `sealed` |
| Nominal, to gain | Recursion through variants | Row "Nominal record recursion" |
| Structural, to keep | A record literal fits a record type with no call | Record assignability |
| Structural, to keep | A literal fits a primitive name | `literalFitsPrimitive` |
| Structural, to keep | A named value widens to its base | Row "Nominal widening" |
| Structural, to keep | A host adapter returns a plain object for a record result | `adapter.ts:40-45` |
| Structural, to keep | JSON decodes into a record without `_tag` | 4 decodes in the corpus |
| Structural, to keep | A record with function fields stays a plain record | 5 in the corpus |
| Structural, to keep | Generated TypeScript stays readable | Emitter forms |

The two sides conflict in one place: the runtime `_tag`. A record either carries a tag, which gives match by name and host checks and breaks plain JSON, or it does not. No syntax-free design removes this conflict. Each design below chooses a signal that decides the tag.

## 6. How far R1 already goes

R1 makes every primitive position carry a declared name. So every value in a signature already has a name. The unnamed values are literals, operator results, inline record and array literals, field reads of inline record types, and builtin results. This is an inference from `declaration/013` and from the body classes in section 3.

So "every named type has identity" is a small step from today. The name already exists. What changes is that two names stop being interchangeable. The cost falls on the 172 primitive naming aliases and on the records that cross a wire or a host boundary. A design must make a literal and a fresh unnamed value flow into a name with no call, or the 2026-10-17 verbosity problem returns.

## 7. Designs

Each design gives the user-visible rule, source before and after, and what the compiler infers and emits. It then gives the effect on each language aspect, what breaks, the diagnostics impact, the measured migration, and the fit with the acceptance exception. The before and after examples use lines from the fixtures.

### NI1: every named type is nominal, every named record is tagged

Rule: every `type Name = body` has identity by name. A literal or an unnamed value fits a name when its shape fits the body. A record body gets a runtime `_tag`.

Before (`order-lifecycle/contracts.eff:1-13`):

```
export nominal OrderId = string
export nominal Cents = int
export type Count = int
export type Receipt = { number: Text }
export nominal Pending = { id: OrderId, total: Cents }
```

After:

```
export type OrderId = string
export type Cents = int
export type Count = int
export type Receipt = { number: Text }
export type Pending = { id: OrderId, total: Cents }
```

The compiler emits a brand for `OrderId`, `Cents`, and `Count`, and a `TaggedStruct` for `Receipt` and `Pending`. A union body stays an alias, because a union is a set of types and not a shape. Construction is implicit at a literal with an expected type and explicit with `Name(value)` for a computed value. Widening to the base stays as today. Operator classes stay as today, and a literal operand adopts the class of the other operand. Match by name, branch joins, recursion, and `sealed` stay as today, because every named record is a nominal record. The `.effi` companion module emits the same forms. A host provider that returns any named record is wrapped and checked with `Schema.is`.

What breaks: the 4 `Schema<T>` decodes into `Request`, `Policy`, `OrderInput`, and `StoredArticle` need `_tag` in the JSON. The 6 structural service results need `Name.make` in host code, which `--tsc` reports. `Receipt` and `Order` in the service workflow stop being interchangeable, which is the protection the user wants, and the host adapter changes. The 5 function-field records cannot be `TaggedStruct` values, so they need a shape exception. Under that exception, a record with a function or deferred field stays structural and untagged. This exception reintroduces an inferred split that the reader cannot see from the declaration line. The 14 primitive naming aliases in the applications become brands. `completed + 1` (`worker.eff:29`) keeps the class `Int` only with the literal rule, and `unitPrice * request.quantity` (`workflow.eff:21`) widens to `int` and then needs `Int(...)` or an emitter cast.

Diagnostics: `type-mismatch/010` ("is a type alias, not a nominal type") shrinks to unions and bare-name bodies. `declaration/014` loses its case. `declaration/015` and `016` apply to every record body without function fields. `declaration/013` changes its message to "type or error declaration". `tests/fixtures_test.ts:128` requires an error fixture for each registered code, so a deleted code needs its fixture removed.

Migration: 126 `nominal` declarations in 40 files, 173 test occurrences in 29 files, 12 website example declarations, and the spec text. Plus every host adapter that returns one of the 6 structural result records, and every stored JSON of the 4 decoded records. A full count of named-to-named record assignments that stop checking needs a run of the checker with the rule.

Fit: the source loses one keyword and keeps explicit shapes, so it is more terse. It is not more elegant for wire types, because every named record now carries a module-qualified tag on the wire.

### NI2: nominality by body shape, with structural field bags

Rule: a body that gives a shape makes a nominal type. A body that only names other types, or a record with a function or deferred field, makes a structural alias.

This is NI1 with two shape exceptions. `type Order = Pending | Paid` and `type Alias = Record` are aliases. `type KeyValue = { get: (key: Key) => ... }` (`platform.eff:16`) is a structural record. Everything else follows NI1, including the tag on every other named record.

Before and after are the same as NI1. The compiler emits a TypeScript `type` only for the function-field records, as it does today for a type-only alias (`decls.ts:426`).

What breaks: the same wire and host positions as NI1. The reader cannot see from `type Receipt = { number: Text }` that `Receipt` has a tag, and cannot see from `type TimeOps = { nowMillis: () => Int }` that it has none. The rule "a function field removes the tag" is sound, because such a record has no schema, but it is a surprise.

Diagnostics and migration: as NI1. Fit: as NI1.

### NI3: identity between names, shapes flow, nothing tagged

Rule: the Go rule. Two different names never mix. A name and an unnamed shape mix in both directions. No named record carries a runtime tag.

Before (`order-lifecycle/orders.eff:76`):

```
rule: Sum({ parts: [Fixed({ amount: Cents(50) }), Times({ factor: 3 })] }),
```

After, with no tags, `match` by name has no runtime test. The variant records `Fixed`, `Times`, `Capped`, and `Sum` cannot be told apart at run time, except by their shapes. So the 29 `match` arms by name in the corpus have no implementation, and the order lifecycle witness fails its purpose (`docs/status.md:62`).

The compiler emits plain aliases or brands and no `TaggedStruct`. Identity lives in the checker and the validator. This design keeps every wire and host contract unchanged and removes the tag concept from the language. It rejects match by name, branch joins of variants, host checks of record results, and recursion through tagged variants. It is listed for completeness and is not viable.

### NI4: identity between names, shapes flow, tags from same-module unions (recommended)

Rule: every `type` whose body gives a shape has identity by name. A literal or an unnamed value fits a name when its shape fits. A named record gets a runtime `_tag` when a union in the same module lists it. Every member of that union must be a named record or an error.

Before (`portable-publisher/domain.eff:1-36`):

```
export type Text = string
export nominal ArticleId = string
export nominal Revision = int
export nominal Draft = { id: ArticleId, revision: Revision, ... }
export nominal Published = { ... }
export type Article = Draft | Published
export nominal PublishPlan = { expectedRevision: Revision, next: Published }
```

After:

```
export type Text = string
export type ArticleId = string
export type Revision = int
export type Draft = { id: ArticleId, revision: Revision, ... }
export type Published = { ... }
export type Article = Draft | Published
export type PublishPlan = { expectedRevision: Revision, next: Published }
```

The compiler reads the module. `Article` lists `Draft` and `Published`, and both are named records, so both get `_tag` and emit as `TaggedStruct`. `PublishPlan` is in no union, so it has identity but no tag. It emits as `Schema.Struct` with a TypeScript type, as a `type` record does today. `Text`, `ArticleId`, and `Revision` have identity and emit as today's `type` aliases, so their identity is erased in TypeScript (decision NI10 offers the brand form). `Article` is an alias of a union, as today.

Before (`domain.eff:68`, `orders.eff:76`, `workflow.eff:21`):

```
revision: Revision(ready.revision + 1),
rule: Sum({ parts: [Fixed({ amount: Cents(50) }), Times({ factor: 3 })] }),
const order = { sku: request.sku, quantity: request.quantity, total: unitPrice * request.quantity }
```

After:

```
revision: ready.revision + 1,
rule: Sum({ parts: [Fixed({ amount: 50 }), Times({ factor: 3 })] }),
const order = { sku: request.sku, quantity: request.quantity, total: unitPrice * request.quantity }
```

`ready.revision + 1` has the unnamed type `int`, which fits `Revision`. `50` fits `Cents`. `Fixed({ ... })` keeps its constructor, because the expected type `Rule` is a union, and a literal does not pick a variant (NI11). The `order` literal keeps its form and fits `Order`, and `Order` no longer fits `Receipt`.

Each aspect under NI4:

| Aspect | Rule under NI4 |
| --- | --- |
| Identity | A shape body gives identity. A union body or a bare-name body gives an alias (NI8). A literal-only union gives identity, so `StateName` and `Status` differ. |
| Construction | A literal at an expected shape type constructs with no call. A record literal at an expected tagged record emits `Name.make(...)`. A computed unnamed value fits an untagged name with no code. A computed value into a tagged record needs `Name(value)`, as today. |
| Widening | A named value fits its base, as today. An unnamed value fits a name whose body it fits, at any depth for untagged names. |
| Equality and arithmetic | Classes as today. A literal operand adopts the class of the named operand (`completed + 1` is `Int`). `Int * Int` keeps NM7 and gives `int`, which fits `Int` again because `int` is unnamed. |
| Match by name | A subject whose members are all tagged records or errors uses name patterns, as today. A member without a tag gives `pattern/004` with the message "has no runtime tag; it is not a member of a union in its module". |
| Branch joins | TE3 applies to tagged records and errors. Two untagged named records do not join, as structural records do not today. |
| Recursion | A tagged record follows "Nominal record recursion". An untagged record follows the alias rules. |
| `sealed` | `sealed type Name = T` keeps today's authority rules (NI13). |
| `.effi` | Same rules. A host interface record gets a tag only when the interface declares a union over it. The companion module emits the same forms. |
| Schema and JSON | An untagged record decodes without `_tag`, as today's `type`. A tagged record needs `_tag`, as today's `nominal`. The 4 corpus decodes are untagged and keep working. |
| `_tag` runtime contract | Unchanged for the 13 application variant records, which are all union members today. `PublishPlan` loses its tag. |
| Host provider checks | Wrap when a result contains a tagged record, as today. |

What breaks: `PublishPlan` and the 5 `.effi` nominal records in the fixtures (`Row`, `Token`, `Tok`, `Holder`, `Plain`) lose their tags, because no union lists them. The host-checks fixture (`fixtures/emit/host-checks/host.effi:7`) tests a tagged result and must add a union or change its assertion. `Order` and `Receipt` in the service workflow stop mixing, and the host adapter needs no change because `Receipt` stays untagged. A program that wants a tagged standalone record has no syntax for it (NI16). Adding a union over existing records later adds `_tag` to their wire form (NI15). A full count of named-to-named assignments that stop checking needs a run of the checker.

Diagnostics: as NI1, plus the new `pattern/004` message. `declaration/015` and `016` apply to tagged records only. `declaration/014` disappears, because a bare-name body is an alias and a union body is an alias.

Migration: 126 `nominal` declarations in 40 files become `type`. 2 `sealed nominal` become `sealed type`. 173 test occurrences in 29 files, 18 `sealed nominal` test occurrences, 12 website example declarations, and 173 spec and index words change. The 3 `Cents(literal)` calls and some of the 17 computed constructions can drop their constructor. The 55 `Name({ ... })` constructions stay legal. Host `.make` calls (77 on primitives, 19 on records) stay valid in TypeScript, because every schema has `make`; a `--tsc` build must confirm it. The compiler work is in `types.ts` (unnamed-to-named rule), `check_expr.ts` (implicit construction at literals), `check.ts` (tag inference from unions), `lower.ts` and the validator (coercion nodes and the tag flag), `emit/decls.ts` (form selection), `parse.ts`, and the editor tables (`editor_tokens.ts:32-33`, `highlight.ts:39`, `135-154`, `editor_completion.ts:267`).

Fit: the source loses the `nominal` word, keeps every shape explicit, and gains identity on every name. Exported contracts stay explicit and closed. A reader sees the tag rule in the same module, because the union sits next to its members. Hover and inlay hints (TE7) can show "variant of Article" on a tagged record.

### NI5: export-boundary nominality

Rule: a `type` is transparent inside its declaring module and nominal outside it. This is Hack `newtype` and Flow `opaque type`.

Before and after look like NI4. Inside `contracts.eff`, `Order` and `Receipt` mix. In `workflow.eff`, they do not. Construction outside the module needs `Name(value)` for a computed value, and a literal still flows in.

What breaks: assignability depends on the module, so a cut and paste between modules changes meaning. The protection is lost in the module that owns the types, which is where the domain conversions live. The runtime tag question is the same as in NI4. `sealed` partly duplicates this rule. The design serves hiding, which `sealed` already covers, more than identity.

Migration: as NI4 plus a module-aware `assignable`, which exists for `sealed` (`types.ts:1341-1343`). Fit: it adds a hidden rule, so the source is not easier to read.

### NI6: sum-type syntax for variants

Rule: NI4, and a union declaration can define its variants inline: `type Order = Pending { id: OrderId, total: Cents } | Paid { ... } | ...`. Each variant name becomes a named record type with a tag. A standalone named record never gets a tag.

This design removes the fragility of NI4 (NI15), because the tag is visible at the declaration. It conflicts with the request, because it adds syntax. It is the escape hatch if the user judges NI15 unacceptable. The Elm and Gleam models work this way.

Migration: as NI4 plus a parser form, and the 13 application variant records move into their union lines. Fit: the source becomes shorter for variants and the tag rule becomes explicit.

## 8. Recommendation

NI4 is the recommended design. It gives the Go rule for identity, so `Order` and `Receipt` stop mixing and `UserId` and `Email` stay apart. It keeps literals and fresh values free, so the 172 primitive naming aliases cost nothing and the 2026-10-17 verbosity problem does not return. It keeps the tag on exactly the records that `match` needs, because a union of named records is already how source declares a variant set. Every one of the 13 application variant records is a union member today, so their wire form does not change. The 4 JSON decodes and the 6 host result records stay untagged, so host adapters and stored JSON keep working.

NI1 and NI2 are simpler to state but tag every named record, and the corpus shows 10 positions that break. NI3 is not viable. NI5 ties meaning to the module. NI6 adds syntax and is the fallback for NI15.

A prototype should come before a plan. Implement the unnamed-to-named rule and the tag inference behind a flag, run `deno task check`, and build the five applications with `--validate --tsc`. The result gives the count of named-to-named assignments that stop checking, which no grep can give.

## 9. Decisions for the user

Each decision gives its options. One option is marked as the recommendation.

- NI7 (design). (a) NI4 (recommended). (b) NI1 or NI2, every named record tagged. (c) NI6, sum-type syntax now. (d) Keep `nominal`.
- NI8 (alias bodies). Which bodies make an alias rather than an identity? (a) A union body and a bare-name body such as `type Alias = Record` make an alias; every other body makes an identity (recommended, 35 and 4 declarations). (b) Only a union body makes an alias, and `type Positive = Int` makes a new identity over `Int`. (c) Every body makes an identity, which breaks unions.
- NI9 (literal-only unions). (a) `type Status = "pending" | "paid"` has identity, so two enums with equal members differ (recommended). (b) It is an alias.
- NI10 (TypeScript form of primitive identity). (a) Emit the base schema and a plain TypeScript alias, as `type` emits today, so identity is erased in TypeScript and host code is unchanged (recommended). (b) Emit `Schema.brand` and insert `make` at each literal site, so a computed `int` into `Cents` still needs `Cents(...)`. (c) Emit `Schema.brand` and an `as` cast at each coercion, which keeps branded host types with no runtime cost.
- NI11 (literal at a union of variants). (a) `{ amount: 50 }` at an expected `Rule` is an error, and the author writes `Fixed({ amount: 50 })` (recommended). (b) The checker picks the one variant whose fields match, and reports an ambiguity when two match.
- NI12 (computed unnamed record into a tagged record). (a) Needs `Name(value)`, as today (recommended). (b) Implicit, with an emitted `Name.make(value)` and a `$untagged` copy.
- NI13 (keywords). (a) Delete `nominal` with no deprecation, and keep `sealed` as `sealed type Name = T` (recommended; the memory file records no external consumers). (b) Keep `nominal` as a no-op synonym for one release. (c) Delete both and infer `sealed` from export, which is NI5.
- NI14 (tag for a standalone record). (a) No syntax; a standalone record has no tag, as a record alias in Elm has none (recommended). (b) Adopt NI6 later for this case. (c) Treat `error` as the tagged standalone form, and document it.

## 10. Keywords

`nominal` is deleted under NI7 (a) and NI13 (a). The parser (`parse.ts:71-76`, `748-750`), the editor token tables, the TextMate grammar, and the playground highlighter drop the word. `nominal` becomes an ordinary name, as `data` did (`nominal-keyword.md:97`). `sealed` stays, because it declares ownership and not identity, and its form becomes `sealed type Name = T`. The validator rule "sealed belongs only to a nominal definition" (`world.ts:532-540`) changes to "sealed belongs only to a type with identity". The IR definition kinds `alias` and `nominal` can stay, with a new `tagged` flag on a record identity, or the IR version moves to 5. That is a plan decision, not a user decision.

## 11. Risks

- NI15 (wire change by a later union). Adding `type Choice = A | B` over two existing untagged records adds `_tag` to both. Stored JSON of `A` stops decoding. `--tsc` catches host code in the project, because the TypeScript type gains `_tag`. External data is not caught. The same hazard exists today when an author changes `type` to `nominal`. Mitigation: a note in the language rules, and a hover text "variant of Choice" on the member.
- NI16 (no tagged standalone record). A program that needs a self-describing JSON record outside a union has no form for it. The order lifecycle and the publisher do not need one, and `PublishPlan` is a parameter only. Mitigation: NI14.
- NI17 (unmeasured breakage). The number of named-to-named assignments that stop checking is unknown. The grep cannot see them. Mitigation: the flagged prototype in section 8.
- NI18 (literal class adoption). `completed + 1` becomes `Int`, and `UserId + "x"` becomes `UserId` under the same rule. NM7 made a string operand of `+` widen to `string`. The plan must decide whether a string literal adopts the class or keeps the widening; the recommendation is to keep the NM7 widening for strings and adopt the class for numbers only.
- NI19 (cross-module unions). A union in module B over records of module A cannot tag them, because A's emitted form must not depend on B. The checker must report a `match` by name over such a union with the new `pattern/004` message. The corpus has no such union.
- NI20 (validator parity). Each new checker rule needs a mirror in `src/core/validate/`. The unnamed-to-named rule, the implicit construction node, and the tag flag each need one. The mutation fixtures in `fixtures/validate/` must cover each.
- NI21 (performance). Implicit `make` at record literals adds no call that today's explicit construction does not add. Erased primitive identity removes the `make` call at literal sites. The cost is not measured.

## 12. Open measurements

The prototype run in section 8 gives the breakage count. A `--tsc` build after NI10 (a) confirms that host `Key.make("k")` stays valid on a plain `Schema.String`. A rewrite of the application corpus under NI4 gives the character count, with the method of TE6 (`terse-source.md:123`). The runtime cost of the host checks does not change, because the wrapped set does not change in the corpus.

## Sources

- Go specification: <https://go.dev/ref/spec>
- Unison unique and structural types: <https://unison-lang.org/docs/language-reference/unique-types>, <https://unison-lang.org/docs/language-reference/structural-types>
- Hack type aliases: <https://docs.hhvm.com/hack/types/type-aliases>, <https://docs.hhvm.com/hack/modules/type-aliases/>
- Flow opaque types: <https://flow.org/en/docs/types/opaque-types/>
- Scala 3 opaque types: <https://docs.scala-lang.org/scala3/book/types-opaque-types.html>, <https://www.scala-lang.org/api/docs/other-new-features/opaques-details.html>
- OCaml private types: <https://ocaml.org/manual/privatetypes.html>
- Modula-3 branded types: <https://www2.cs.arizona.edu/~collberg/Teaching/520/2008/Notes/Notes-15.pdf>
- Zig anonymous struct literals: <https://www.openmymind.net/Zig-Removes-Anonymous-Structs/>, <https://ziggit.dev/t/surprising-zig-0-14-0-incompatibility-when-initializing-arrays-of-structs/8917>
- Elm opaque types: <https://exercism.org/tracks/elm/concepts/opaque-types>
- Gleam opaque types: <https://tour.gleam.run/advanced-features/opaque-types/>
- Kotlin inline value classes: <https://kotlinlang.org/docs/inline-classes.html>
- TypeScript brands overview: <https://dev.to/jsmanifest/typescript-branded-types-vs-nominal-types-which-pattern-should-you-use-in-2026-13d1>
- Effect Schema advanced usage: <https://effect.website/docs/schema/advanced-usage/>
- Effect 4.0.5 typings: `~/Library/Caches/deno/npm/registry.npmjs.org/effect/4.0.5/dist/Schema.d.ts` lines 177, 4381, 5092

## Validation of NI4 (2026-10-24)

Base: `43a0bf7` on local `main`. Validator: Fable 5.1, adversarial. No compiler code, test, fixture, or website file changed on `main`. The findings continue the NI prefix at NI22. Each finding separates observations (what the code or the probe shows) from inferences (what follows). A finding marked "blocker" needs a decision before a plan. A finding marked "must-fix in plan" needs a plan item. A finding marked "minor" needs a text change.

### Method

The validator read every cited file and line and re-ran the counts of section 3. The validator then built a throwaway worktree (`git worktree add --detach /tmp/ni4-probe main`) and changed the checker there. The probe (193 inserted lines in five files, patch kept at `/tmp/ni4-probe.patch`, temporary) does this:

- `types.ts`: a `type` whose body is a shape is an identity. Two different identities never mix. A widened value adopts no other name at the same level. An unnamed value fits an identity whose body it fits. A union body with a non-literal member and a bare-name body stay transparent.
- `check.ts`: a record identity gets a tag when a transparent union alias of the same module lists it. Every member of that union must be a record identity or an error.
- `check_binary.ts` and `check_builtins/stream.ts`: an identity alias has a comparison class and a group key class, as a brand has.

The probe keeps every identity alias in the alias table, so `unfold` still reaches the shape. This has two limits. The pattern domain of a union of identity records stays "tagged record union", so the probe did not measure match-by-name effects. The emitter was not changed, so emitted text differs where a `+` result is now a named type. The validator in `src/core/validate/` was not changed; `--validate` reported nothing, because the probe only rejects more.

Probe runs: `effektive check` on `fixtures/examples`, `fixtures/tutorial`, `fixtures/host-adapter-files`, and the five applications. Then `effektive build --validate --tsc` on the three gate applications. Then `deno task test`. Then `effektive check` on each file and each project under `fixtures/emit`.

### Claims checked

Observations. Every file and line citation in sections 2 to 7 points at the code it describes, with four small errors. `workflow.eff:21` holds the `provide` call; the multiplication `unitPrice * request.quantity` is on line 20. `highlight.ts` is `playground/src/highlight.ts`, not a `src/core` file. `parse.ts:71-79` also lists `provider` as a declaration word. The claim "`Order` and `Receipt` stop mixing, which is the protection the user wants" is addressed in NI31.

These counts of section 3 reproduce exactly with the stated patterns: 181 and 173 files, 126 `nominal` declarations in 40 files, and 2 `sealed nominal`. So do 513 `type` declarations in 134 files, 83 `error` declarations, and 42 and 24 application declarations. So do 5 `.effi` nominal records, 15 host files with `.make(`, and 77 primitive and 19 record `.make(` calls. Five counts differ, and section 3 does not record their patterns:

- test occurrences: 179 in 30 files with `nominal [A-Z]`, against 173 in 29
- `sealed nominal` in tests: 27, against 18
- `Name({` in the applications: 51, against 55
- the word `nominal` on the website: 175, against 173
- website `type` declarations: 88, against 90

The count "29 match arms by name in 2 files" is not reproducible. `storage.eff` also has name arms, such as `InvalidKey(error)`.

`Schema.d.ts:177` declares `make` on `BottomWithoutNew`, which every schema extends, so the `make` claim holds. A type-only alias emits no schema (`emit/scope.ts:625-640`), and only an alias that contains a function is type-only. So `Key.make("k")` on an erased `type Key = string` compiles, because `Key` emits as `Schema.String`.

### NI17 measurement

Observations from the probe. The three gate applications check and build with `--validate --tsc` and 0 diagnostics. `fixtures/examples` and `fixtures/host-adapter-files` give 0 diagnostics. `order-lifecycle` gives 1 diagnostic, `portable-publisher` 26, and `fixtures/tutorial` 1. The `fixtures/emit` corpus gives 3 diagnostics in `.eff` files plus 1 in `schedules/composition.eff` through a unit test. Four error fixtures change (5 new diagnostics). `deno task test` gives 85 failures among 1,933 fast tests; most of them assert the current rule or compare emitted text.

The 37 source sites in the corpus fall into five classes. Table columns: class, count, example.

| Class | Sites | Example |
| --- | --- | --- |
| C1: one primitive name declared in two modules | 8 in the applications, 1 error fixture, the bench generator, 4 unit tests | `domain.eff:1` and `platform.eff:1` both declare `export type Text = string`; `publisher.eff:15` passes one `Text` where the other is expected |
| C2: a nominal value into a naming alias | 17 in the applications, 3 in `fixtures/emit`, 2 in error fixtures, 1 in the tutorial | `Corrupt({ key, ... })` with `key: Key` into `key: Text` (13 sites in `storage.eff`); `UserId` into `Text`; `Title` into `Line` (`loans.eff:16`) |
| C3: an operator between two names | 2 in the applications, 1 unit test | `base * t.factor` is `Cents * Count` (`orders.eff:67`); `id !== expectedId` is `Text` against `ArticleId` (`storage.eff:48`) |
| C4: a named `int` into a named `number` | 0 in the applications, 1 error fixture, 1 emit fixture, 2 unit tests | `(n: Int): Num => n` (`type-mismatch-binding-arrow.eff:12`); `Schedule<Int, Int>` with `Schedule<Int, Millis>` (`composition.eff:35`) |
| C5: a nominal record into a named record of equal shape | 0 in the applications, 1 emit fixture, 1 error fixture | `User` into `Dog` (`nominal-records.eff:31`) |

Inference. Real bugs caught: 0. Every site is a deliberate widening or a deliberate comparison that the author wrote on purpose. The protection that the corpus gains is the one the error fixtures already test with `nominal`.

### Findings

NI22 (blocker). R1 and NI4 collide on primitive names. Observation: R1 forces a name for every primitive position, and the corpus declares that name in each module. `Text` is declared in 5 modules, `Int` in 4, `Bool` in 4, and `Count` in 2 (applications, examples, tutorial). Under NI4 each declaration is a distinct identity, so a `Text` of `domain.eff` does not fit a `Text` of `platform.eff` (class C1). Section 8 claims that "the 172 primitive naming aliases cost nothing". The probe shows that they cost cross-module compatibility and widening (C1 and C2). Inference: the request has no syntax to tell a naming alias from a domain identity. So NI4 must choose one meaning for `type Text = string`. Options:

- (a) Keep NI4. Each project moves its primitive names into one shared contracts module. The cost is one import line per module and the `Text(value)` calls of NI23. Recommended.
- (b) Amend NI4 so that a bare primitive body stays a transparent alias. Only a record, literal set, array, tuple, option, or function body has identity. `UserId` and `Email` then get no protection, which contradicts the request.
- (c) Keep `nominal` for primitive bodies only.

The user must decide, because the option changes the migration shape of every project.

NI23 (must-fix in plan). Nominal values stop fitting naming aliases. Observation: today a `Key` widens to `string`, and `string` fits the alias `Text`, so `Corrupt({ key, reason })` with `key: Key` checks (`storage.eff:36-113`, 13 sites). Under NI4 `Key` and `Text` are two identities, so each site needs `Text(key)`. The same holds for `ArticleId`, `NonBlankText`, `UserId`, `Id`, and `Title` (class C2, 23 sites). Inference: this is the Go rule working as the request asks. The plan must count and migrate these sites. Section 7 of this document must list this cost next to the 4 decodes and 6 host results.

NI24 (blocker, soundness). The assignability rule lets an untagged value take a tagged type. Observation: the probe accepts `const r: Rule = { amount: 50 }` and `const f: Fixed = computed`. Here `computed` is an unnamed record binding and `Fixed` is a tagged record. The rule "an unnamed value fits a name whose body it fits" has no exception for tagged records. No construction fact exists at those sites, so the emitter would print no `Fixed.make`. Inference: the value has type `Fixed` and no `_tag` at run time. A `match` by name sends it to `$unmatched` or to the last arm, and a host check with `Schema.is` fails. This contradicts NI11 (a) and NI12 (a). Resolution, no syntax: an unnamed value fits a tagged record only as a record literal written at exactly that expected type. The checker records a `data-construction` fact there, and the emitter prints `Name.make(...)`. At a union target, and for every computed value, a tagged record needs `Name(value)`, and the message says so.

NI25 (must-fix in plan). Arithmetic erases identity and the result adopts any name. Observation: the probe accepts `(c: Cents): Count => c * 2` and `(c: Cents): Count => c + 1`. Under NM7, `*`, `/`, and a mixed `+` give the base `int`, which is unnamed, so it fits `Count`. The table row "Equality and arithmetic" in section 7 states this for `Int * Int` but presents it as harmless. Inference: the numeric protection of NI4 holds for direct assignment and comparison only. Any arithmetic step launders a `Cents` into a `Meters`. Resolution options, no syntax:

- (a) A binary operator with one named numeric operand and one literal or unnamed operand gives the class of the named operand. This holds for `+`, `-`, and `*`. `/` gives `number`. `Named * Named` keeps NM7 and gives `int`. Recommended, because it matches the row "A literal operand adopts the class of the named operand".
- (b) Keep NM7 and document the hole.

The plan must decide the string case of NI18 at the same time.

NI26 (must-fix in plan). A named `int` stops fitting a named `number`. Observation: `(n: Int): Num => n` fails in the probe (`type-mismatch-binding-arrow.eff:12`, `check_body_test.ts:2180`, the 300-level record test, and `composition.eff:35`). `Int + Num` becomes `type-mismatch/007`. Inference: the `int` to `number` subtyping survives only between unnamed values and between a name and its own base. This follows from "two different names never mix" and is correct under the Go rule, but section 7 does not list it. The plan must add a fixture and update the tests; the applications have no such site.

NI27 (must-fix in plan). Two names in one operator stop checking in the applications. Observation: `Cents * Count` (`orders.eff:67`) and `Text !== ArticleId` (`storage.eff:48`) fail in the probe, because `Count` and `Text` gain comparison classes. Section 7 rewrites `orders.eff:76` but keeps `price` unchanged. Inference: the author writes `base * Cents(t.factor)` and `ArticleId(id) !== expectedId`, or converts the other operand. The plan must count these sites with the probe and migrate them. No new rule is needed; NM7 already rejects two classes.

NI28 (must-fix in plan). The IR must carry identity and the tag, and the emitter must stop printing `make` for erased identities. Observation: the validator builds its `aliases`, `brands`, and `data` maps from the IR definition kind (`world.ts:130-139`), and treats every `nominal` record base as tagged. The opaque rule needs the `nominal` kind with an `unknown` base (`world.ts:558-567`). Section 10 leaves the IR shape open. The probe golden diff shows a `$int` helper in `collections.ts`. A `+` on two `Amount` values now has a named result, and the emitter prints `Amount.make($int(...))` for a brand result. Inference: parity (NI20) needs an IR that says "identity" and "tagged" for each `type`. The smallest form: every identity lowers to `{ kind: "nominal", base, tagged?: true, sealed?: true }`. A union or bare-name body lowers to `alias`. The IR version becomes 5. The emitter selects `TaggedStruct` only when `tagged` is set. It prints `Schema.Struct` with a type for an untagged record. It prints the base schema with a plain type for an untagged primitive (NI10 a). It prints plain arithmetic for an erased identity. The sealed rules (`ownsSealed`, `foreignSealedOf`, `sealedRootOf`) must read the identity set, not only the brand map.

NI29 (must-fix in plan). Diagnostics print short names. Observation: the probe prints "the field `title` has type Text, but Text is expected" (`storage.eff:59`). It also prints "the function body has type Int, but Int is expected" (`unknown-name-import-export/main.eff:5`). `show()` uses `shortName` (`check_expr.ts:234`, `types.ts:1545`). Inference: under NI4 two identities with one short name are common (NI22). The message must print `module#Name` when the two names collide, or always for a name from another module.

NI30 (must-fix in plan). Same-module unions over plain `type` records exist and change under NI4. Observation: these fixtures list plain records in a same-module union:

- `schema-general-union.eff`: `Shape = Short | Long`
- `schema-optional-union.eff`: `Choice = Left | Right`
- `forms/optional-fields.eff`: `AB = A | B` and `ABC = AB | C`
- `pattern-nominal-subject.eff`: `Mixed = Circle | Record`
- `schema-constructor-metadata.eff`: three unions with a `Text` member, so no tag

The applications and the website examples have none. Inference: under NI4 `Short`, `Long`, `Left`, `Right`, `A`, `B`, `C`, and `Record` gain `_tag`. The two schema fixtures decode JSON of these unions, so their inputs need `_tag` (NI15 at migration time). A record pattern over such a union gives `pattern/004`. The plan must list these fixtures and state the rule: a union of named records in one module is a variant set and takes name patterns.

NI31 (minor). The `Order` and `Receipt` claim catches nothing in the corpus. Observation: the probe reports 0 diagnostics in `service-workflow`. The only site that returns an `Order` row as a `Receipt` is the host adapter (`adapter.ts:40-45`). Under NI10 (a) the TypeScript type of `Receipt` stays structural, so `--tsc` accepts the adapter. Inference: the protection in section 7 holds for `.eff` code only. Section 7 must say so, or NI10 (c) must brand exported identities in TypeScript.

NI32 (minor). The rule text has open points. Observations and proposed answers, no syntax:

- Bodies `void`, `never`, `unknown`, and `null` (17 declarations) are not in the shape list. Proposal: every body except a union with a non-literal member and a bare name gives identity. A `never` body fits everything through `never`. An `unknown` body then behaves like an opaque type without a host.
- A spread update keeps the name of its base (`recordUpdate` returns `base.type`, `check_expr.ts:1654-1714`), so `{ ...order, total }` is not an unnamed value. State it.
- A field read, a call result, and a branch join keep their declared or joined names. "Unnamed" means a literal, an operator result, an inline record, array, or tuple literal without an expected type, and a builtin result typed by a primitive. State it.
- A record literal at an expected tagged record must still get field-by-field checks. `recordTarget` returns no target when the expected type unfolds to a `named` node (`check_expr.ts:1489-1532`). The plan must unfold an identity to its body there, and in the six other `unfold(expected)` sites of the builtin checkers.
- `Ref`, `Codec`, and `Schema` invariance is two-way assignability (`types.ts:1443-1475`). Under the unnamed-to-named rule `Ref<int>` and `Ref<Cents>` become interchangeable, and `Ref<Cents>` and `Ref<Meters>` stay apart. Acceptable; state it.
- A nested union (`type All = Order | Rule`) must flatten through transparent aliases before the tag test. A foreign member counts as tagged only when its own module tagged it (NI19).
- `sealed type X = A | B` and `sealed type X = Y` have alias bodies and no identity. The validator rule at `world.ts:531-541` becomes "sealed needs identity", and the checker needs a diagnostic with a fixture (`fixtures_test.ts:128`).
- The parser form `sealed nominal` (`parse.ts:839`) becomes `sealed type`; `fixtures/errors/sealed-authority/lib.eff` has the 2 sites.
- Two literal-set names (NI9 a) have different classes, so `status === otherStatus` across them is `type-mismatch/007`. `status === "pending"` stays legal through the class chain. State it.

NI33 (minor). Fit with AGENTS.md and `docs/rejected.md`. Observation: `docs/rejected.md` holds performance entries only, so nothing there conflicts. The acceptance exception asks for source that is easy to read, closed contracts, and explicit exported contracts. Inference: NI4 removes 126 words and keeps contracts closed. The wire form of an exported record now depends on a union line elsewhere in the module, so the declaration line alone does not show it. Hover text (section 7) mitigates this in an editor, not in a diff. The user accepted this trade in NI14 (a); the plan should name it in the language rules.

### Verdict

NI4 does not hold as written. It holds with the amendments NI24, NI25, and NI28 after the user decides NI22. NI23, NI26, NI27, NI29, and NI30 are costs and plan items, not rule defects. The NI17 measurement on this corpus gives 37 friction sites and 0 bugs caught, with 27 of the 37 in `portable-publisher`.

Amended rule text for NI4:

Every `type` whose body is not a union with a non-literal member and not a bare name has identity by name. A union body with a non-literal member and a bare-name body give a transparent alias. A literal-only union body gives identity. Two different identities never mix, in any position, with equal bodies, and across modules. A named value fits its own body and nothing named beyond it: after it widens to its body, it adopts no other name at that level. An unnamed value is a literal, an operator result, or an inline record, array, or tuple literal with no expected type. A builtin result typed by a primitive is also unnamed. An unnamed value fits an untagged identity whose body it fits. An unnamed record fits a tagged record only as a record literal written at exactly that expected type. The checker records a construction there, and the emitter prints `Name.make(...)`. At a union target, and for every computed value, a tagged record needs `Name(value)`. A spread update keeps the name of its base. A field read, a call result, and a branch join keep their declared or joined names. A named record is tagged when a union alias of its own module lists it, through transparent aliases. Every member of that union must be a tagged record, an identity record of the same module, or an error. A binary operator with one named numeric operand and one literal or unnamed operand gives the class of the named operand for `+`, `-`, and `*`. `/` gives `number`. Two named operands follow NM7 (decision NI25). The IR lowers an identity to `nominal` with a `tagged` flag and lowers a transparent alias to `alias` (NI28).

Next action: the user decides NI22 (a, b, or c) and NI25 (a or b). Then Opus writes the plan with the items NI23 to NI30 and NI32.

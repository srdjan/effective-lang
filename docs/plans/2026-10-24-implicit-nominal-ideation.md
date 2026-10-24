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

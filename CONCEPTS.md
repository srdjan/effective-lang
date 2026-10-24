# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Checking pipeline

### Typed IR

The versioned, serializable intermediate form of a checked module, in which every expression node carries an annotation.

The emitter reads only the typed IR, and the independent validator checks it, so the typed IR is the contract between the checker and every later stage.

### Annotation

The type, execution mode, and active failure and requirement sets that the checker records on each expression node of the typed IR.

The independent validator recomputes each annotation from the node's children. An annotation that copies an outside hint, such as the expected type of a binding, can differ from the recomputed value even when the program is valid.

### Expected type

The type that the checker gives to an expression from its context, such as a binding annotation or the parameter of a builtin, before the checker checks that expression.

An expected type is a constraint as well as information: the branches of a conditional or match must each fit it, and the conditional then takes it as its type. Some builtins also read their own type from it. A type built only to supply information must therefore go only to the forms that need it.
_Avoid: hint, when the type is also enforced_

### Independent validator

The second checker that recomputes every annotation of the typed IR without shared code with the source checker, and reports each disagreement.

It acts as a differential oracle: a program that the checker accepts and the validator rejects shows a defect in one of the two. A disagreement is repaired so that both derive the same annotation, not by weakening the validator.
_Avoid: IR checker, second pass_

### TypeScript outputs

The per-program `TypeScriptOutputs` cache of emitted text, span tables, and source maps.

The frontend owns checking and lazy lowering. Output queries take a revision explicitly and reuse its lowering-result object as a weak cache key. Source hover needs neither lowering nor output; combined hover takes this cache to add the backend declaration.

### Type table

The project-wide store in which the checker interns each type once and refers to it by a reference number.

A reference number depends on the order in which types were first interned, and the incremental program keeps one table across all edits. So a reference number must never decide an order, a choice, or a message that a user can see; a canonical structural key decides those, and the number only breaks ties.

### Disk program

The second `Program` of a language-server project that sees only the disk texts and never the open-document overlay. Each save round updates it and writes the generated files from it.

It exists so that a generated file always comes from saved source: the overlay program serves diagnostics and hover, and the disk program serves file output.
_Avoid: mirror, shadow program_

### Prelude table

The one table that lists every prelude operation, with a flag that tells whether a source binding may shadow it.

The prelude name type and the name sets all derive from this table. The checker keeps two tables keyed by the same names. One table has a handler for each prelude name except `None`. The other table has a prologue row for each of those names. A name without a handler or a prologue row is a compile error. A prologue row may state that the handler tests its own argument count.

### Stage set

The effect set that one pipeline stage adds by itself, without the effects of its left value.

A quiet value is pure and has no failure and no requirement. When the left value is not quiet, the checker checks the stage with a quiet value of the same type in its place. Lowering moves the left value into its own binding and copies the stage set onto the stage call. Lowering never derives a stage set, so each stage rule has one owner. So a stage handler must not read the effect sets or the mode of its left value.

## Type identity

### Type identity

A `type` declaration has identity by name. It has none when its body is a union with a non-literal member or a bare name.

Examples are `type UserId = string`, `type Cents = int`, `type Status = "pending" | "paid"`, and `type User = { id: UserId, name: Name }`. A literal-only union gives identity. The bodies `void`, `never`, `unknown`, and `null` give identity too.

Two different types with identity never mix. This holds when their bodies are equal and when they come from different modules. A value of a type with identity fits its own body. An unnamed value fits a type with identity when the value fits its body. An unnamed value is a literal, an operator result, or an inline record, array, or tuple literal. A value of another type with identity needs the constructor, as in `Text(key)`.

The identity exists in the checker. The emitted TypeScript of an untagged type is the schema and the type of its body.
_Avoid: nominal type, brand type, data type_

### Transparent alias

A `type` declaration whose body is a union with a non-literal member, or a bare name. Examples are `type Article = Draft | Published` and `type Alias = User`.

A transparent alias is interchangeable with its body. It has no constructor and no identity.

### Tagged record

A record type with identity that a union alias of its own module lists. Every member of that union must be a record type with identity of the module, a tagged record of another module, or an error.

A tagged record value carries a runtime `_tag` of the form `<module>#<Name>`. The emitter prints `Schema.TaggedStruct`. A record literal written at exactly the expected tagged type constructs the value with no call. A computed value needs `Name(value)`.

A union in another module does not tag a record. When a later edit adds a record to such a union, the wire form of the record gains `_tag`. A union of records with a literal discriminator field is a different concept: it needs no runtime tag.
_Avoid: nominal record, data record_

### Tagged domain

The pattern domain of a `match` subject whose members are all tagged records or errors, after transparent aliases unfold.

Arms name the members, as in `Circle(c)`. Coverage needs one arm for each member or `_`. A record pattern does not apply to a tagged domain. A subject that mixes tagged members with other members has no domain, and the checker reports it.

### Sealed type

A type with identity whose declaring module owns construction and the operations that can invalidate its rules.

The declaration uses `sealed type Name = T`. Other modules can pass, compare, and read values. The owner exports conversions and decoders when needed. `sealed` on a transparent alias gives `declaration/017`.
The source restriction does not isolate generated TypeScript from unsound host code.
_Avoid: sealed nominal type_

### Pure function type

A function type that requires pure execution and empty failure and requirement sets.

The form is `pure (value: T) => U`. Empty effect sets alone do not establish purity. An unmarked function type retains effect execution.

### Companion module

The generated TypeScript module of a host interface file: `host.effi` gives `host.effi.ts`.

It holds the types, types with identity, errors, and services of the interface, so the compiler owns each tag string. Source modules and the host module import those values from it. The host module supplies only the opaque types and the providers.
_Avoid: interface module, host types module_

## Verification

### Behavior capture

The refactor oracle that records a hash of each checker, program, lowering, emission, and validation result that the test suites produce on two revisions, and compares the two record sets.

A base record that is missing from the head means a behavior change, and a new head record usually comes from an added test. The checker, program, and validation records also hash their input, so a change that moves or rewrites tests changes the record set without any change in behavior. To judge such a change, compare revisions that run the same tests. Two runs of one revision can differ by one clean program record, so one such record alone is not a behavior change. The capture records only results of the core library, so it does not cover command-line or language server output.
_Avoid: snapshot, golden run_

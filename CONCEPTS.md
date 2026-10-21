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

### Prelude table

The one table in `resolve.ts` that lists every prelude operation, with a flag that tells whether a source binding may shadow it.

The type `PreludeName`, the set `PRELUDE_NAMES`, and the set `SHADOWABLE_PRELUDE_NAMES` all derive from this table. The checker keeps a handler table that has one row for each prelude name except `None`, so a name without a handler is a compile error.

## Verification

### Behavior capture

The refactor oracle that records a hash of each checker, program, lowering, emission, and validation result that the test suites produce on two revisions, and compares the two record sets.

A base record that is missing from the head means a behavior change, and a new head record usually comes from an added test. The checker, program, and validation records also hash their input, so a change that moves or rewrites tests changes the record set without any change in behavior. To judge such a change, compare revisions that run the same tests.
_Avoid: snapshot, golden run_

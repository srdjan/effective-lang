# Language rules

The canonical specification governs the language: `../effective/public/effective-spec.html` in the sibling repository. This file records the implemented subset and the choices that the implementation made where the specification is silent. The spec owner can override each rule. When the specification and this file disagree, the specification wins, and this file needs a correction.

Each row gives one rule and one evidence link. The link goes to the plan or contract that chose the rule. The plan files are history, and their line references point at old revisions. The policy for a silent specification: the implementer picks the stricter rule and records it here.

The sections follow the language topics: core forms, modules and exports, effects and contracts, collections, scopes and resources, streams and sinks, schedules, Schema, diagnostics, and the rules of the lowering, emission, and tooling stages.


## Core forms

### Lexer and parser

| Rule | Choice | Evidence |
| --- | --- | --- |
| Raw control characters in strings | Rejected (`syntax/003`), because JSON rejects them | [lex.ts](../src/core/lex.ts) |
| Leading zeros in numbers | `01` is rejected (`syntax/006`) | [lex.ts](../src/core/lex.ts) |
| Union continuation | A newline before `\|` does not continue a type; a newline after `\|` does. Inside parentheses a newline is not significant, so `(int` newline `\| string)` continues | [parse.ts](../src/core/parse.ts) |
| `fails` and `uses` on a new line | Continue a clause only when an identifier follows | [parse.ts](../src/core/parse.ts) |
| `Some(_)` | Accepted; `_` is the binding name | [parse.ts](../src/core/parse.ts) |
| Nesting depth | 512 levels of expressions and types. An expression parenthesis counts two levels; a type parenthesis counts one. Deeper input is `syntax/009`, and the parser skips only the one group at the limit | [parse.ts](../src/core/parse.ts) |
| Parenthesized types | `(A \| B)[]` and the empty tuple type are accepted | [parse.ts](../src/core/parse.ts) |

### Declarations and types

| Rule | Choice | Evidence |
| --- | --- | --- |
| `Brand<T>` position | Only as the whole body of a `type` declaration | [check.ts](../src/core/check.ts) |
| `Brand<T>` base | The base cannot be a record, a data type, or a union with such a member, after aliases are unfolded. A violation gives `declaration/014`, and the message tells the author to declare a nominal record with `data`. A base of a primitive, a literal, a literal union, an array, a tuple, an option, or another brand stays legal. A base that contains an opaque type gives `declaration/016`. A brand is erased at run time: its value is the base value | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [check.ts](../src/core/check.ts) |
| `data` declaration | `[export] data Name = { fields }`. The body is a record type. A field can be optional, as in `nick?: Nick`. An empty body `{}` is legal. `data` is a declaration word only at the start of a declaration, so `data` stays legal as a variable name. `.eff` and `.effi` files can both declare it | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [parse.ts](../src/core/parse.ts) |
| `data` field names | The field name `_tag` is reserved (`declaration/009`), as it is in an `error` body. Primitive and literal types are legal in the body (see "Primitive positions") | [check.ts](../src/core/check.ts) |
| Data type identity | A data type has the id `type:<module>#<Name>` and its own entry in the type table. It is not a brand. It fits only itself. A structural record, an alias of one, and another data type with equal fields do not fit it, and it does not fit them (`type-mismatch/003`) | [types.ts](../src/core/types.ts) |
| Data type fields | A field type must have an encoded form. A function type or a deferred type in a data or error field gives `declaration/015`. This holds at any depth and after aliases are unfolded. Deferred types are Effect, Fiber, Stream, Sink, Schedule, RetrySchedule, Ref, Codec, Schema, provider, and scope types. An opaque type in a data or error field gives `declaration/016`, at any depth and after aliases are unfolded, because an opaque type has no schema. `unknown` stays legal. A `withResource` operation record has function fields, so it stays a structural record (plan decision NT13) | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [types.ts](../src/core/types.ts) |
| Data type recursion | A data type can refer to itself, and data types can refer to each other. An alias can be part of the cycle. A cycle needs a data type and a base case. The base case is a path through an `Option`, an array, an optional field, or a union with a member outside the cycle. A cycle of required fields only, or of aliases only, gives `declaration/007`. A cycle through an error or a brand also gives `declaration/007`. The checker and the validator apply the rule independently | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [check.ts](../src/core/check.ts), [world.ts](../src/core/validate/world.ts) |
| `unknown` | Not a top type: only `unknown`, `never`, and the error type fit it | [types.ts](../src/core/types.ts) |
| Private parameters | A parameter of a module function, a service method, or a function type needs an annotation when nothing supplies its type (`declaration/011`) | [check.ts](../src/core/check.ts) |
| Function types in type syntax | Execution defaults to `effect` | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Provider compatibility | Equal `provides`, compatible execution, acquisition sets as subsets | [types.ts](../src/core/types.ts) |
| Effect value compatibility | `Effect<A, E, R>` checks `A` covariantly and requires the source's deferred failure and requirement sets to be subsets of the target's sets. Omitted sets and `never` mean empty sets | [2026-10-17-effect-value-design.md](archive/plans/2026-10-17-effect-value-design.md) |
| Interface hash | Ignores spans, so comments do not change it. A body edit changes it only when it flips the mode of an exported function, because the payload holds each exported function type with its mode | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Interface payload | Also carries the declarations of other modules that the exports reach, so the hash covers them | [transpiler-design.md](transpiler-design.md), [interface.ts](../src/core/interface.ts) |
| Primitive positions | R1, `declaration/013`, decisions D26 to D31: a type node that resolves to `string`, `int`, `number`, or `boolean`, and every literal type node, can occur only inside the body of a `type`, `data`, or `error` declaration. The rule covers parameters, results, service methods, constant annotations, local annotations, function types, and type arguments, in `.eff` and `.effi` files. `void`, `never`, `unknown`, and other type forms are legal. The pass skips parser error regions, because the parser reported them, and it checks a broken declaration, because its annotations parsed | [transpiler-design.md](transpiler-design.md) |
| Type depth | A type declaration deeper than 128 levels, counting aliases, is `declaration/012`, and the alias becomes the error type. The comparison caps are 1536 | [2026-10-17-d21-d23.md](archive/plans/2026-10-17-d21-d23.md) |

### Expressions, modes, and contracts

| Rule | Choice | Evidence |
| --- | --- | --- |
| Contract diagnostics | One diagnostic for each contract kind of a function: `failure-contract/001` lists every extra error, and `requirement-contract/001` lists every extra capability | [check_expr.ts](../src/core/check_expr.ts) |
| Literal widening | Unannotated bindings, branch joins, inferred results, and the `fold` accumulator widen literals to primitives | [check_expr.ts](../src/core/check_expr.ts) |
| Branch joins | Without an expected type, one branch type must accept the other; no union is formed | [check_expr.ts](../src/core/check_expr.ts) |
| Contextual record unions | Known literal field values select among shape-compatible record members first. The types of name references to settled locals, values, and providers select next. Remaining candidates keep the canonical member order, which is the order of the member IR text and does not depend on the history of the type table. The checker applies contextual field types after the choice | [check_expr.ts](../src/core/check_expr.ts) |
| Tagged record coverage | A record match needs a wildcard when a member lacks the chosen field or has an optional or open discriminator. A tagged binding retains every member whose field can equal the literal at runtime, including optional fields, erased brand bases and unknown values. A subject with a data or error member does not use tagged records (see "Match by name"). Generated tests guard property access when another member lacks the field | [patterns.ts](../src/core/patterns.ts), [check_expr.ts](../src/core/check_expr.ts) |
| Local recursion | A block-level function cannot call itself (`execution-mode/003`). The specification states this limit with its rule for recursive functions | [check_expr.ts](../src/core/check_expr.ts) |
| Mode fixed point | Round cap 32 (`execution-mode/004`) | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Equality | Both operands must share one comparison class: string, numeric, boolean, a union of literals of one class, or one brand with a primitive base. A singleton `null` operand accepts a nullable opposite operand (see "null in matches and equality"). Records, options, data types, and errors are rejected (`type-mismatch/007`) | [check_expr.ts](../src/core/check_expr.ts) |
| Data construction | `User(value)` takes one argument. The argument can be any expression that fits the base record: a record literal, a piped value, or `User(unbrand(other))`. The result type is `User`. A data value does not fit the base record, so `User(circle)` needs `unbrand` (`type-mismatch/003`). A wrong argument count is `type-mismatch/004`. The checker records the fact `data-construction`, and lowering gives the IR node `data` | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [check_expr.ts](../src/core/check_expr.ts) |
| Data field read and update | `user.name` reads a field of the base record. An optional field reads as `Option`. The update `{ ...user, name: n }` keeps the type `User`. The update rejects a field that the base record lacks | [check_expr.ts](../src/core/check_expr.ts) |
| Data `unbrand` | `unbrand(user)` gives the base record type. At run time it gives a copy without `_tag` (see "Data values at run time"). `unbrand` of a brand still gives the base value | [check_expr.ts](../src/core/check_expr.ts), [expr.ts](../src/core/emit/expr.ts) |
| Match by name | A `match` on a subject whose members are all data types or errors, after aliases are unfolded, uses name patterns `Name(binding)` and `_`. Coverage needs one arm for each member, or `_`. The binding has the member type. A name that is not a member gives `pattern/003`. A missing member gives `pattern/001`, and a repeated member gives `pattern/002` | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [patterns.ts](../src/core/patterns.ts), [check_patterns.ts](../src/core/check_patterns.ts) |
| Match by name limits | A record pattern on such a subject gives `pattern/004`. A subject that mixes data or error types with other types gives `pattern/004` once, at the subject. A constructor pattern that names a type alias or a brand gives `pattern/004`. A name without a binding gives `pattern/004` | [check_patterns.ts](../src/core/check_patterns.ts), [check_expr.ts](../src/core/check_expr.ts) |
| Catch handlers | A `catch` handler names an error only. `catch { User(u) => ... }` gives `unknown-name/004`, which says that the name is a type, not an error | [resolve.ts](../src/core/resolve.ts) |
| Data-only data types | A data type is data only when each of its fields is data only. So data values can occur in Codecs, Schemas, `mapGroups` results, and `withResource` results | [types.ts](../src/core/types.ts) |
| Brand operators | D32: `<`, `<=`, `>`, `>=`, `+`, and `-` accept two values of one numeric brand. `+` and `-` give the brand. The emitter prints `<Brand>.make(...)`, with `$int` inside for a brand of `int`. The operator table of the spec states the same rule. A data type takes no operator | [transpiler-design.md](transpiler-design.md) |
| `retry` form | The second argument must be a literal record with one field: `{ times: N }` with a finite nonnegative safe integer literal, or `{ schedule: policy }` with a `RetrySchedule` (see "Retry schedules") | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md), [check_expr.ts](../src/core/check_expr.ts) |
| Scoped fibers | `withFiber(effect, use)` starts a supervised child. The inline use callback may pass its borrowed handle only to `joinFiber` or `interruptFiber`. Child requirements activate on start; typed failures enter the caller when joined. The child is interrupted when use exits | [effect-4-gap-audit.md, 2026-10-17 update on `withFiber`](archive/effect-4-gap-audit.md) |
| References and races | `Ref<A>` is invariant; `updateRef` requires a pure callback. `race` combines deferred channels of two compatible Effect values and waits for loser cleanup | [effect-4-gap-audit.md, coverage map](archive/effect-4-gap-audit.md#coverage-map), [check_expr.ts](../src/core/check_expr.ts) |
| Retry schedules | `RetrySchedule<E>` uses a pure callback from nominal error and one-based attempt to `Option<int>` milliseconds. `retry(job, { schedule: policy })` preserves job channels; negative delays are runtime defects | [effect-4-gap-audit.md, 2026-10-17 update on `RetrySchedule`](archive/effect-4-gap-audit.md) |
| Pure codecs | `Codec<Decoded,Encoded>` holds two pure transformations over schema-capable data. `decode` and `encode` return `Option` after validating input and output with derived schemas. The Schema constructors do not change `Codec` or its Option-returning operations | [effect-4-gap-audit.md, 2026-10-17 update on `Codec`](archive/effect-4-gap-audit.md) |
| Source Layers | `layer(Service, acquire)` checks exact method shape and acquisition channels. `mergeLayers` requires disjoint services; `provide` accepts source Layer expressions | [effect-4-gap-audit.md, 2026-10-17 update on `Layer`](archive/effect-4-gap-audit.md) |
| Broken declarations | Checked for side tables; their body diagnostics are suppressed until the syntax is fixed | [check_project.ts](../src/core/check_project.ts) |
| Effect type order | Sorted identity order everywhere, including the hover text of `hoverAt` in `src/core/editor.ts` | [types.ts](../src/core/types.ts) |

## Modules and exports

### Projects and names

| Rule | Choice | Evidence |
| --- | --- | --- |
| Namespace | One namespace per module for types, errors, services, providers, constants, and imports | [resolve.ts](../src/core/resolve.ts) |
| Prelude names | Neither modules nor locals may declare them, except the names that the `PRELUDE` table in `src/core/resolve.ts` marks `shadowable`. An existing binding with such a name shadows the builtin. `run` is one of them. Modules also may not declare builtin type names. `Effect<...>` is parsed as a type application without reserving `Effect` as a value name | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Call-only builtins | A call-only builtin takes ordinary call syntax and has no pipeline stage. A pipeline stage gives `type-mismatch/010`. The `PRELUDE` table in `src/core/resolve.ts` marks each builtin `shadowable` or not. A source binding can shadow a shadowable builtin. The builtins `takeSink`, `transduceStream`, `aggregateStream`, `mapGroups`, `scheduleMax`, `scheduleMin`, `scheduleConcat`, the Schema constructors, and the SchemaIssue constructors are call-only and shadowable. The shadowable set also holds `run`, the scope operations, the stream accumulators and combinators, `all`, `partitionAll`, `validateAll`, and `allResults`; the `PRELUDE` table is the complete list. A builtin is call-only when the checker calls `noPipeline` for it in `src/core/check_expr.ts`; `all` and `traverse` accept a pipeline stage. `runStream` is call-only but not shadowable: a binding named `runStream` gives `declaration/002` | [resolve.ts](../src/core/resolve.ts), [check_expr.ts](../src/core/check_expr.ts) |
| Target names | Neither modules nor locals may declare `undefined`, `Number`, `RangeError`, `ReadonlyArray`, `SchemaError`, `SchemaIssue`, `any`, `bigint`, `object`, or `symbol` (`declaration/002`), because the generated TypeScript needs them. Fields and service methods may use them. Decision D20 of 2026-10-17 lists all of them except `SchemaError` and `SchemaIssue`; `src/core/resolve.ts` holds the current list | [transpiler-design.md](transpiler-design.md), [resolve.ts](../src/core/resolve.ts) |
| Shared scopes | A block after a parameter list, pattern, or handler shares its scope, so a redeclaration is `declaration/001` | [resolve.ts](../src/core/resolve.ts) |
| Early outer use | A block that uses an outer name and later binds the same name is `declaration/004` | [resolve.ts](../src/core/resolve.ts) |
| Own initializer | A local `const x = x` is `unknown-name/001`. A module-level `const x = x` is an initialization cycle, `module/004` | [resolve.ts](../src/core/resolve.ts), [check_project.ts](../src/core/check_project.ts) |
| Module paths | Only letters, digits, `_`, `.`, `-`, and `/` | [project.ts](../src/core/project.ts) |

## Effects and contracts

### Collections and traversal

| Rule | Choice | Evidence |
| --- | --- | --- |
| Collection literals | Brackets write a list. `[1, 2]` infers an array. An expected tuple type checks each position and the length. `[]` needs an expected array or tuple type. A heterogeneous list without context gives `type-mismatch/012`. The parser accepts trailing commas | [2026-10-17-spec-amendment-collections.md](archive/plans/2026-10-17-spec-amendment-collections.md) |
| `traverse` | `traverse(items, callback)` maps an array with a pure or effectful callback. The operation is effectful even when the callback is pure. Without options, it runs the callbacks one after another and returns the results in input order. Callback failures and service requirements enter the enclosing contract | [2026-10-17-bounded-traversal-design.md](archive/plans/2026-10-17-bounded-traversal-design.md), [2026-10-17-spec-amendment-collections.md](archive/plans/2026-10-17-spec-amendment-collections.md) |
| `traverse` concurrency | A literal `{ concurrency: N }` runs at most N callbacks at the same time. N is a positive safe integer. `{ concurrency: "unbounded" }` starts the callbacks without a limit. Both forms keep input order. After a typed failure, the runtime interrupts the active siblings. Both forms wait for scoped finalizers after a failure or an interruption | [2026-10-17-bounded-traversal-design.md](archive/plans/2026-10-17-bounded-traversal-design.md), [effect-4-gap-audit.md, draft 0.4](archive/effect-4-gap-audit.md) |
| Pure callbacks | `map`, `filter`, and `fold` require a pure callback with empty failure and requirement sets (`execution-mode/001`). The same code reports an impure callback of `updateRef`, `retrySchedule`, `codec`, and the pure stream accumulators and predicates | [2026-10-17-spec-amendment-collections.md](archive/plans/2026-10-17-spec-amendment-collections.md), [check_expr.ts](../src/core/check_expr.ts) |

### Effect values

| Rule | Choice | Evidence |
| --- | --- | --- |
| `Effect<A, E, R>` | An Effect value stores a computation. `A` is the result type, `E` the typed failures, and `R` the service method requirements. An empty channel may be omitted or written as `never` | [2026-10-17-effect-value-design.md](archive/plans/2026-10-17-effect-value-design.md) |
| `defer` | `defer(() => job())` builds an Effect value without running the job. Constructing the value carries only the effects of evaluating the job expression | [2026-10-17-effect-value-design.md](archive/plans/2026-10-17-effect-value-design.md) |
| `run` | `run(value)` executes an Effect value. It adds the failures and requirements of the value to the caller's contract. The call has effect mode, even when both sets are empty. A source binding named `run` shadows the prelude operation | [2026-10-17-effect-value-design.md](archive/plans/2026-10-17-effect-value-design.md) |
| `all` | `all(effects, options?)` runs a tuple, a record, or an array of Effect values. The result keeps the shape of the input. The failures and requirements of the Effect values join the contract. The optional literal concurrency record accepts a positive safe integer or `"unbounded"`. A heterogeneous bracket literal needs a contextual tuple type, such as a typed binding | [effect-4-gap-audit.md, draft 0.5](archive/effect-4-gap-audit.md) |
| `partitionAll` | `partitionAll(jobs, options?)` runs a homogeneous array of Effect values. It returns `[successes, failures]` and keeps input order inside each array. Typed failures become values, so these jobs add no failure channel to the enclosing contract. Service requirements still enter the contract. It takes the same concurrency options as `all` | [effect-4-gap-audit.md, draft 0.10](archive/effect-4-gap-audit.md) |
| `validateAll` | `validateAll(jobs, onErrors, options?)` runs every job. It returns all successes when no job fails. Otherwise a pure callback wraps the collected typed errors in a nominal error for the enclosing `fails` contract. The callback receives a nonempty array at runtime. Its type is an ordinary array in core 1. It takes the same concurrency options as `all` | [effect-4-gap-audit.md, draft 0.11](archive/effect-4-gap-audit.md) |
| `allResults` | `allResults(effects, options?)` runs every Effect value in a tuple, a record, or a homogeneous array and keeps the input shape. Each position is a tagged record. A success is `{ _tag: "Success", success }`. A failure is `{ _tag: "Failure", failure }`. Typed job failures become values. The combined service requirements still enter the contract. It takes the same concurrency options as `all` | [effect-4-gap-audit.md, draft 0.12](archive/effect-4-gap-audit.md) |
| Core 1 value forms | Core 1 also has `Ref<A>` state, `race` of Effect values, supervised `withFiber` with direct `joinFiber` and `interruptFiber`, pure `Codec<Decoded,Encoded>` transformations, `Schema<D,E,RD,RE,M>` values, `RetrySchedule<E>`, general `Schedule<O,I,E,R>` policies, and source-defined `Layer<Services,E,R>` values. General Effect operators, general stream operators, and ecosystem packages still need host adapters | [effect-4-gap-audit.md, coverage map](archive/effect-4-gap-audit.md#coverage-map) |

## Collections

The rules for collection literals, `traverse`, and the pure callbacks of `map`, `filter`, and `fold` are in the section on effects and contracts, under "Collections and traversal".

## Scopes and resources

### Scoped child fibers

| Rule | Choice | Evidence |
| --- | --- | --- |
| forkScoped | `forkScoped(job)` starts an Effect value in the current scope and discards its Fiber handle. It returns `void` in source. The runtime registers child interruption with that scope. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| forkScoped job channels | The job of `forkScoped` must have no typed failures. The checker rejects a job with typed failures. `forkScoped` returns no join handle and no child-result channel. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| scoped | `scoped(job)` provides a local scope. The runtime closes that scope after the job completes. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Child lifetime | A child that `forkScoped` starts can outlive its spawning fiber. It lives until its scope closes. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Reserved Scope requirement | A job can have the reserved requirement `cap:effect/Scope`. The program discharges it through `scoped`, `provideScope`, or a builtin that runs its callback in a scope, such as the `mapGroups` use callback. `CloseableScope` is a different type from this requirement. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### CloseableScope value

| Rule | Choice | Evidence |
| --- | --- | --- |
| CloseableScope type | `CloseableScope` takes no type arguments. It is an abstract runtime handle with shared close authority. It exposes no fields or methods. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Builtin signatures | These are builtin contracts, not user-defined generic functions: `makeScope(): CloseableScope`, `provideScope(owner: CloseableScope, job: Effect<A,E,R>): A`, `addScopeFinalizer(owner: CloseableScope, job: Effect<void,never,R>): void`, `closeScope(owner: CloseableScope): void`. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Effect mode and shadowing | All four builtins force effect mode. Builtin names follow the existing shadowing rules. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Value transfer | A program may assign, return, pass, or capture a `CloseableScope`. It may also store it in arrays, tuples, records, Options, Effects, and Refs. These operations share one identity. They do not clone the scope or reset its state. Earlier aliases stay usable. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| No equality or Schema | `CloseableScope` supports no equality and no ordering. It has no derived Schema and is not data only, also when nested in another type. A type alias can name it without a Schema. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Codec and callback-result checks | The checker rejects `CloseableScope` in Codec schema checks and in the data-only callback-result checks for resources and Fibers. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Not supported | The language has no getter for the current lexical scope. It has no cast from an ordinary or borrowed handle to `CloseableScope`. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Host signatures | `CloseableScope` can appear in `.effi` signatures with the same shared-authority meaning. Strict host assertions distinguish the wrapper from a raw target `Scope.Closeable`. The host implementation is a trusted boundary. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### Creation and provision

| Rule | Choice | Evidence |
| --- | --- | --- |
| makeScope | `makeScope()` creates an independent sequential scope with a fresh shared close state. It needs no ambient Scope and joins none. It has result `CloseableScope`, no failures, and no requirements. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Explicit cleanup | The runtime does not close a scope when its creating fiber ends, fails, or is interrupted. Dropping every alias does not run finalizers. The caller must close the scope explicitly. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Returned live scope | The owner can survive its creating root execution. A later root execution can close it through an alias. Cleanup completes before `closeScope` returns. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md), [owner.eff](../fixtures/emit/scopes/owner.eff), [emit_slow_test.ts](../tests/emit_slow_test.ts) |
| provideScope | `provideScope(owner, job)` runs the job with only the selected scope capability. It returns the job success type `A`. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| provideScope does not close | `provideScope` does not close the owner when the job returns. It does not interrupt ordinary work when the owner closes. Only a child that `forkScoped` starts gets interrupted. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Provision after close | After close, `provideScope` still runs ordinary work. A newly scoped child cannot stay live in the closed scope. The handle does not prove open or closed state. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Provider lifetime | A scope does not extend the lifetime of a service provider. A child that must outlive the creating root must acquire its resource-backed Layer inside the child Effect. The provider then lives until close interrupts the child. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### Finalizer registration

| Rule | Choice | Evidence |
| --- | --- | --- |
| addScopeFinalizer job type | The job of `addScopeFinalizer` must have result `void` and no typed failures. It must not require the reserved Scope capability. The caller handles a typed failure before registration. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Service capture | `addScopeFinalizer` evaluates owner and job once, from left to right. It captures the current service bindings at registration. Ordinary service requirements are allowed. Close needs no service requirement from earlier jobs. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Captured services | The captured context keeps service references. It does not own their provider resources. Registration does not extend the lifetime of a scoped Layer. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Registration on open scope | Registration on an open scope does not run the finalizer. The runtime stores it. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Late registration | If the scope is already closed, registration runs the finalizer at once and waits for its cleanup. Earlier or concurrent closes are not barriers for it. Its defect does not change the cached close outcome. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Finalizer order | Finalizers registered before close begins run in reverse order of registration. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### Close completion and interruption

| Rule | Choice | Evidence |
| --- | --- | --- |
| closeScope result | `closeScope(owner)` returns `void`. The first slice closes with `Exit.void`. It accepts no supplied Exit, no success value, and no exit-aware finalizer callback. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| One physical close | The first caller claims close atomically and runs the finalizers once. Every later or concurrent call waits for the same completion. A successful `closeScope` always waits for the original close to finish. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Cached outcome | The runtime caches the close outcome as `Exit<void,never>`. Every later `closeScope` on any alias observes that outcome. Close consumes no alias. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Uninterruptible close | Closing and waiting are uninterruptible. Interrupting the first caller or an alias cannot leave the shared completion pending. The runtime reports caller interruption after the uninterruptible region. It does not replace the cached outcome. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Defects | `closeScope` has no typed failure channel. The runtime attempts all earlier finalizers in sequence. A defect stays a defect, and the cached outcome replays it to later callers. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Pending close | A finalizer that never finishes keeps close pending. There is no cleanup timeout. A finalizer that waits for `closeScope` on its own owner also stays pending. The language has no static cycle detection. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| Not supported | The slice does not support arbitrary Exits, exit-aware finalizer callbacks, parallel finalizer strategies, scope trees, mandatory cleanup, or static leak prevention. It is not full raw Scope parity. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### Scope channel equations

| Rule | Choice | Evidence |
| --- | --- | --- |
| provideScope channels | Active failures are the argument failures plus the latent job failures. Active requirements are the argument requirements plus the latent job requirements minus `cap:effect/Scope`. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| addScopeFinalizer channels | The result is `void`. Active failures are the argument failures. Active requirements are the argument requirements plus the latent job requirements. Active argument construction may still fail. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| closeScope channels | The result is `void`. Active failures and requirements are those of the owner expression. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### Borrowed resources and Fibers

| Rule | Choice | Evidence |
| --- | --- | --- |
| Borrow rules unchanged | Borrow qualifiers still apply to opaque resource parameters. `CloseableScope` is not a borrowed opaque resource type. Its parameter contract permits retention. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |
| No borrowed escape through a scope | A registered finalizer cannot capture a `withResource` handle or a borrowed Fiber. A program cannot store them through the owner or return them in an aggregate with it. A new host method cannot receive them through a forbidden path. | [2026-10-18-scope-ownership-contract.md](archive/plans/2026-10-18-scope-ownership-contract.md) |

### withResource

| Rule | Choice | Evidence |
| --- | --- | --- |
| Signature | `withResource(acquire, use, release)` composes a scoped resource through three inline callbacks. Acquisition takes no arguments. Use and release each take the acquired handle. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md) |
| Handle kinds | Acquisition returns an operation record or an opaque host handle. An operation record has only required function fields. Each field has data-only parameters and a data-only result. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md), [effect-4-gap-audit.md, 2026-10-17 update](archive/effect-4-gap-audit.md) |
| Operation record use | The program may use an operation record only as the direct receiver of a field call, such as `file.read()`. It cannot read a field as a value. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md) |
| Opaque handle use | An opaque handle may pass directly to a borrow-qualified host method or to a checked source helper. A borrowed source parameter cannot escape its function body. | [effect-4-gap-audit.md, 2026-10-17 update](archive/effect-4-gap-audit.md) |
| Handle escape | The checker rejects a handle that is returned, assigned, put in a record or array, captured by another closure, or passed as an argument outside the permitted forms. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md) |
| Data-only results | The use result and every operation result must be data only. Data only means no function, Effect, provider, `unknown`, nested operation record, opaque handle, Stream, Sink, Schedule, RetrySchedule, Ref, Fiber, Codec, Schema, or scope, also inside records, arrays, tuples, options, unions, errors, data types, and brands. The release result must be `void`. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md), [types.ts](../src/core/types.ts) |
| Release timing | The generated Effect runs release after success, typed failure, defect, or interruption. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md) |
| withResource channels | The result forces effect mode. Failures and requirements are the union of the acquire, use, and release invocation failures and requirements. A release failure keeps its own typed channel. The backend uses `Effect.acquireUseRelease`. | [2026-10-17-scoped-resource-design.md](archive/plans/2026-10-17-scoped-resource-design.md) |

## Streams and sinks

### Stream construction and demand

| Rule | Choice | Evidence |
| --- | --- | --- |
| Stream type | `Stream<A, E, R>` holds a deferred producer. Omitted `E` and `R` default to `never`. | [2026-10-17-stream-design.md](archive/plans/2026-10-17-stream-design.md), [check.ts](../src/core/check.ts) |
| Deferred production | Construction of a Stream does not run production. Production starts at consumption. | [2026-10-17-stream-design.md](archive/plans/2026-10-17-stream-design.md) |
| unfold | `unfold(seed, callback)` creates a pull stream. The inline callback returns an Option of a pair of element and next state. | [2026-10-17-stream-design.md](archive/plans/2026-10-17-stream-design.md) |
| mapEffect without options | A pure callback with empty failure and requirement sets, and no options record, compiles to the pure `Stream.map`. The result element type may differ from the source element type. `mapEffect` combines the source and callback deferred channels. | [effect-4-gap-audit.md, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| mapEffect concurrency | `mapEffect(stream, callback, options?)` accepts `{ concurrency: N }` with a positive safe integer literal `N`, or `{ concurrency: "unbounded" }`. A dynamic bound gives `type-mismatch/010`. Any `concurrency` option keeps `Stream.mapEffect`. Output order stays the input order. | [effect-4-gap-audit.md, draft 0.28](archive/effect-4-gap-audit.md) |
| bufferStream | `bufferStream(stream, { capacity: N })` adds suspending backpressure. The emitter passes `strategy: "suspend"`. N is a positive safe integer literal; a dynamic capacity gives `type-mismatch/010`. | [effect-4-gap-audit.md, 2026-10-17 update on `bufferStream` and `mergeStreams`](archive/effect-4-gap-audit.md), [emit/expr.ts](../src/core/emit/expr.ts) |
| mergeStreams | `mergeStreams(left, right)` combines two producers. One element type must be assignable to the other, or the call gives `type-mismatch/010`; the result element is the wider type. It combines their deferred channels and preserves the order of each producer. | [effect-4-gap-audit.md, 2026-10-17 update on `bufferStream` and `mergeStreams`](archive/effect-4-gap-audit.md), [check_expr.ts](../src/core/check_expr.ts) |

### Per-element operators

| Rule | Choice | Evidence |
| --- | --- | --- |
| takeStream | `takeStream(stream, count)` keeps up to the first `count` elements. The count is an `int`, for example through an alias such as `Int`. It must be pure and may be dynamic. | [effect-4-gap-audit.md, draft 0.13](archive/effect-4-gap-audit.md) |
| takeStream empty and channels | A zero or negative count gives an empty stream without a source pull. The stream keeps its deferred failures and requirements. | [effect-4-gap-audit.md, draft 0.13](archive/effect-4-gap-audit.md) |
| dropStream | `dropStream(stream, count)` consumes and discards the first `count` elements, then emits the rest. The count is an `int`, for example through an alias such as `Int`. It must be pure and may be dynamic. | [effect-4-gap-audit.md, draft 0.16](archive/effect-4-gap-audit.md) |
| dropStream edge cases | A zero or negative count leaves the stream unchanged. Failures in discarded elements still propagate. Deferred channels stay in the stream type. | [effect-4-gap-audit.md, draft 0.16](archive/effect-4-gap-audit.md) |
| Effectful predicates | `filterEffectStream`, `takeWhileEffectStream`, `takeUntilEffectStream`, and `dropWhileEffectStream` take an inline boolean predicate. The predicate may be pure, may fail, or may call services. | [effect-4-gap-audit.md, draft 0.29 and 2026-10-20 update](archive/effect-4-gap-audit.md) |
| filterEffectStream | `filterEffectStream` tests every element and emits accepted elements in source order. The runtime still pulls rejected elements, so upstream failures propagate. | [effect-4-gap-audit.md, drafts 0.18 and 0.29, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| takeWhileEffectStream | `takeWhileEffectStream` keeps the longest accepted prefix. It consumes but omits the first rejected element, then stops pulling. The runtime closes upstream work when the prefix ends. | [effect-4-gap-audit.md, drafts 0.14 and 0.29, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| takeUntilEffectStream | `takeUntilEffectStream` emits through the first accepted element, including that element, then stops pulling. With no match it emits the whole stream. | [effect-4-gap-audit.md, drafts 0.15 and 0.29, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| dropWhileEffectStream | `dropWhileEffectStream` discards the initial accepted elements. It then emits the first rejected element and every later element without testing the predicate again. | [effect-4-gap-audit.md, drafts 0.17 and 0.29, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| Pure predicate lowering | A pure predicate with empty failure and requirement sets compiles to `Stream.filter`, `Stream.takeWhile`, `Stream.takeUntil`, or `Stream.dropWhile`. The stream type stays unchanged, so a stream alias survives. | [effect-4-gap-audit.md, 2026-10-20 update](archive/effect-4-gap-audit.md) |
| Effectful predicate channels | Otherwise the stream type combines source and predicate channels. The operation tests elements sequentially at consumption. | [effect-4-gap-audit.md, draft 0.29](archive/effect-4-gap-audit.md) |
| scanStream | `scanStream(stream, seed, update)` emits the pure seed before it pulls. It then emits each state from an inline pure `(state, element)` callback. | [effect-4-gap-audit.md, draft 0.20](archive/effect-4-gap-audit.md) |
| scanStream state and channels | Each consumption starts with fresh state. Source failures and requirements stay deferred in the stream type. | [effect-4-gap-audit.md, draft 0.20](archive/effect-4-gap-audit.md) |
| mapAccumStream | `mapAccumStream(stream, seed, update)` threads a pure state through the source. The inline pure callback declares a `[State, Output[]]` result and emits zero or more outputs per input. | [effect-4-gap-audit.md, draft 0.21](archive/effect-4-gap-audit.md) |
| mapAccumStream seed and state | The runtime does not emit the seed. Each consumption starts with fresh state and keeps the source's deferred channels. | [effect-4-gap-audit.md, draft 0.21](archive/effect-4-gap-audit.md) |

### Combining streams

| Rule | Choice | Evidence |
| --- | --- | --- |
| zipStreams | `zipStreams(left, right)` pairs two streams in source order. The element types may differ. The result ends with the shorter input. | [effect-4-gap-audit.md, draft 0.7](archive/effect-4-gap-audit.md) |
| zipStreams channels and shadowing | `zipStreams` combines the deferred failure and service channels of both streams. A source binding named `zipStreams` shadows the prelude operation. | [effect-4-gap-audit.md, draft 0.7](archive/effect-4-gap-audit.md), [resolve.ts](../src/core/resolve.ts) |
| concatStreams | `concatStreams(left, right)` emits the whole left stream before it starts the right stream. The result element type is the union of both element types. | [effect-4-gap-audit.md, draft 0.8](archive/effect-4-gap-audit.md) |
| concatStreams failure | `concatStreams` combines deferred channels. If the left stream fails, the runtime skips the right stream. | [effect-4-gap-audit.md, draft 0.8](archive/effect-4-gap-audit.md) |
| flatMapStreams callback | `flatMapStreams(source, callback, options?)` takes an inline pure callback. The callback returns a Stream for each source element. | [effect-4-gap-audit.md, draft 0.9](archive/effect-4-gap-audit.md) |
| flatMapStreams order and concurrency | Without options, the runtime exhausts each inner stream in source order. `{ concurrency: N }` with a positive safe integer literal `N`, or `{ concurrency: "unbounded" }`, runs inner streams together. A dynamic bound gives `type-mismatch/010`. It merges their outputs as they arrive. | [effect-4-gap-audit.md, draft 0.9](archive/effect-4-gap-audit.md), [effect-4-gap-audit.md, draft 0.28](archive/effect-4-gap-audit.md) |
| flatMapStreams channels and cleanup | The result combines the outer and inner deferred channels. Failure and interruption close active inner streams. | [effect-4-gap-audit.md, draft 0.9](archive/effect-4-gap-audit.md) |
| switchMapStreams | `switchMapStreams(source, callback)` takes an inline pure callback that returns an inner Stream for each source element. A new source element interrupts the previous inner stream and starts the latest one. | [effect-4-gap-audit.md, draft 0.30](archive/effect-4-gap-audit.md) |
| switchMapStreams output and channels | Values already emitted remain. Source and inner failures and requirements stay deferred until consumption. | [effect-4-gap-audit.md, draft 0.30](archive/effect-4-gap-audit.md) |

### Error handling and retry

| Rule | Choice | Evidence |
| --- | --- | --- |
| catchStream | `catchStream(source, recover)` takes an inline pure callback. The callback maps a typed source error to a replacement Stream. | [effect-4-gap-audit.md, draft 0.31](archive/effect-4-gap-audit.md) |
| catchStream semantics | Earlier source values remain. The operation handles the source typed failures. The result is `Stream<A \| B, E2, R \| R2>`: only the replacement's failures stay deferred, and both service sets stay deferred. Defects and interruption pass through. | [effect-4-gap-audit.md, draft 0.31](archive/effect-4-gap-audit.md) |
| retryStream | `retryStream(source, policy)` retries a Stream under a compatible `RetrySchedule<E>`. Every source failure must be assignable to `E` (`type-mismatch/003`). The policy expression must be pure (`execution-mode/001`). | [effect-4-gap-audit.md, draft 0.32](archive/effect-4-gap-audit.md) |
| retryStream restart | After a typed failure, the runtime restarts the entire source. Values emitted before the failure can appear again. | [effect-4-gap-audit.md, draft 0.32](archive/effect-4-gap-audit.md) |
| retryStream channels and reset | The failure and service channels stay deferred. The schedule resets after the first element of a new attempt. | [effect-4-gap-audit.md, draft 0.32](archive/effect-4-gap-audit.md) |

### Time operators

| Rule | Choice | Evidence |
| --- | --- | --- |
| debounceStream | `debounceStream(source, delayMs)` keeps the latest element after a quiet interval. The delay is a nonnegative safe integer literal in milliseconds. | [effect-4-gap-audit.md, draft 0.33](archive/effect-4-gap-audit.md) |
| throttleStream | `throttleStream(source, { units, durationMs, strategy })` applies a per-element token bucket. The record has exactly these three fields. `units` and `durationMs` are positive safe integer literals; the emitter rechunks the source to one element so units count elements. | [effect-4-gap-audit.md, draft 0.33](archive/effect-4-gap-audit.md) |
| throttleStream strategy | Strategy `"shape"` waits for capacity. Strategy `"enforce"` drops excess elements. | [effect-4-gap-audit.md, draft 0.33](archive/effect-4-gap-audit.md) |
| Time operator channels | `debounceStream` and `throttleStream` keep the source channels deferred. | [effect-4-gap-audit.md, draft 0.33](archive/effect-4-gap-audit.md) |

### Terminal consumers

| Rule | Choice | Evidence |
| --- | --- | --- |
| foldStream | `foldStream(stream, seed, update)` consumes a stream into one final state. The update callback is inline and pure. | [effect-4-gap-audit.md, draft 0.22](archive/effect-4-gap-audit.md) |
| foldStream seed and channels | The runtime evaluates the pure seed when the effect runs. An empty stream returns the seed. Source failures and requirements enter the active effect contract. | [effect-4-gap-audit.md, draft 0.22](archive/effect-4-gap-audit.md) |
| foldEffectStream | `foldEffectStream(stream, seed, update)` returns one final state. The inline update callback may fail or use services. | [effect-4-gap-audit.md, draft 0.23](archive/effect-4-gap-audit.md) |
| foldEffectStream failure | Source and callback failures and requirements combine in the active effect contract. A callback failure stops later pulls and closes started upstream work. | [effect-4-gap-audit.md, draft 0.23](archive/effect-4-gap-audit.md) |
| collectStream | `collectStream(stream)` consumes a finite stream into an array in source order. An empty source returns `[]`. The result is a new array on each execution. | [effect-4-gap-audit.md, draft 0.24](archive/effect-4-gap-audit.md) |
| collectStream channels | Source failures and requirements move into the active effect contract. | [effect-4-gap-audit.md, draft 0.24](archive/effect-4-gap-audit.md) |
| headStream | `headStream(stream)` consumes only the first element and returns `Option<A>`. An empty source returns `None`. | [effect-4-gap-audit.md, draft 0.25](archive/effect-4-gap-audit.md) |
| headStream cleanup | The runtime closes started upstream work after the first element. Each execution starts a fresh consumption. Source failures and requirements become active. | [effect-4-gap-audit.md, draft 0.25](archive/effect-4-gap-audit.md) |
| lastStream | `lastStream(stream)` consumes the stream to completion and returns its final element as `Option<A>`. An empty source returns `None`. | [effect-4-gap-audit.md, draft 0.26](archive/effect-4-gap-audit.md) |
| lastStream failure | A source failure propagates without a partial result. Source failures and requirements become active. | [effect-4-gap-audit.md, draft 0.26](archive/effect-4-gap-audit.md) |
| drainStream | `drainStream(stream)` runs a stream to completion and discards its values. It returns `void`. | [effect-4-gap-audit.md, draft 0.27](archive/effect-4-gap-audit.md) |
| drainStream effects | `drainStream` still executes source effects, propagates failures, and closes started upstream work. Source failures and requirements become active. | [effect-4-gap-audit.md, draft 0.27](archive/effect-4-gap-audit.md) |
| sinkForEach | `sinkForEach(callback)` takes an inline one-parameter arrow. A callback that is not an inline arrow gives `type-mismatch/010`. An input without a type annotation gives `type-mismatch/011`. The callback result must be `void`. The result is `Sink<I, void, E, R>` with the callback channels and no leftover. Direct calls to `unfold` and `mapEffect` also use inline arrows. Default sequential pull demand has no prefetch; each sink completion permits the next pull. | [2026-10-17-stream-design.md](archive/plans/2026-10-17-stream-design.md) |
| runStream signature | `runStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>): O`. The checker requires `A` assignable to `I`. It imposes no leftover and input compatibility constraint. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| runStream execution | `runStream` performs one sink run, discards leftover values, and closes the producer without running its remaining continuation. It exposes no resumable stream or continuation handle. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| runStream channels | `runStream` activates both deferred channel sets together with the construction effects. It always runs in effect mode. Leftovers add a value type, not a failure or requirement. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |

### Sinks and leftovers

| Rule | Choice | Evidence |
| --- | --- | --- |
| Sink type | `Sink<Input, Output, Errors = never, Requirements = never, Leftover = never>`. The leftover type is the fifth argument. All existing argument positions and defaults keep their meaning. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink annotation | `Sink<Int, Int[]>` means no leftovers and cannot annotate a constructor that produces leftovers. To write a fifth argument, write both channel placeholders explicitly. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink aliases | Sink aliases are runtime-only and have no derived Schema. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink variance | Sink compatibility is contravariant in input. It is covariant in output, failures, requirements, and leftovers. A no-leftover sink fits a type that permits leftovers. The reverse is invalid. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink target mapping | Source `Sink<I,O,E,R,L>` maps to target `Sink.Sink<O,I,L,E,R>`. Host assertions must preserve all five positions. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink value restrictions | Sink values keep the existing value transport and borrow restrictions. Returning or storing a Sink does not authorize capture of a borrowed resource or Fiber. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| takeSink signature | `takeSink(count): Sink<I, I[], never, never, I>`. It is a builtin rule, not a user-defined generic function. It collects `count` elements per run. It is pure with empty active channels. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| takeSink count | `count` must be a positive safe integer literal. The checker rejects zero, negative, fractional, dynamic, and non-finite counts. The source adds no runtime count error. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| takeSink input type | The input type `I` comes from an expected Sink type: a binding annotation, a function result, or a parameter position. An inline `transduceStream`, `aggregateStream`, `aggregateWithinStream`, or `runStream` call also supplies its source element type as an input hint. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md), [check_expr.ts](../src/core/check_expr.ts) |
| takeSink without context | An uncontextualized `const pairs = takeSink(2)` needs a type annotation. The source has no explicit generic call syntax. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| takeSink independent sink | The input hint does not force an independently typed sink to have exactly that input or an array output. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| takeSink run state | `takeSink` allocates a fresh array for each sink invocation. Runs do not share a partially filled array. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Leftover replay | A sink can read a chunk beyond its stopping point. The leftovers it returns become the first input to the next sink invocation, before a new upstream pull. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Zero-progress host sinks | A typed host sink can finish without consuming input or can return all input as leftovers. Types do not guarantee progress or termination. The compiler adds no progress check, typed error, or output dropping. The host sink and its caller bound the consumption. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |

### Synchronous transduction

| Rule | Choice | Evidence |
| --- | --- | --- |
| transduceStream signature | `transduceStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>): Stream<O,E1\|E2,R1\|R2>`. The output `O` can differ from both input types. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream typing | The checker requires `A` assignable to `I`. It also requires `L` assignable to `I`, because each leftover is an input to another sink run. `L` need not be assignable to `A`. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream construction | Construction evaluates the source and sink expressions once, left to right. It does not pull the source, run a sink transform, or acquire required services. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream demand | Each terminal consumption creates fresh upstream state. Each requested output invokes the reusable sink transform anew. The same sink value works across separate consumptions. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream concurrency | Synchronous transduction adds no producer fiber, queue, or read-ahead task. It imposes no new chunking on the source. Upstream operations can still buffer or run concurrently. It adds no memory bound. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream completion with takeSink(2) | Source `[1,2,3,4,5]` gives `[[1,2],[3,4],[5]]`. Source `[1,2,3,4]` gives `[[1,2],[3,4],[]]`. Source `[]` gives `[[]]`. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream final empty result | Exact-sized input can need a fresh sink run to find upstream completion. That run emits an empty result. The consumer does not filter it. An arbitrary sink decides its own completion result. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream channels | `transduceStream` keeps construction effects active. The resulting Stream stores the source and sink failure and requirement unions as deferred. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream services | Service requirements stay deferred until consumption. They use the bindings of that execution. The runtime does not capture them when it constructs the Sink or Stream. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream failure | Results already emitted stay observable before a later typed failure. After a typed source failure, the sink finishes, and the runtime then exposes the pending failure on the next demand. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream failure example | With `takeSink(2)`, a source that yields `1,2,3` and then fails emits `[1,2]`, then `[3]`, then the source failure. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream sink failure and defects | A sink failure emits no invented result for its incomplete run. A defect emits no incomplete batch. Defects and interruption stay distinct from typed failures. Interruption does not force a final partial batch. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream sink finish failure | A sink can fail while it finishes. The runtime keeps the target behavior and does not combine every cause. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream resource scope | The runtime passes its enclosing consumption scope into each sink transform. Finalizers registered there stay until the whole consumption ends. A sink that needs release before its own result must bracket that resource inside its transform. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| transduceStream resource limits | Repeated scope registrations can retain resources through a long-lived stream. The source type does not promise bounded retention. Downstream failure and interruption wait for yielding sink finalizers and for cleanup of an active upstream pull. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |

### Aggregation

| Rule | Choice | Evidence |
| --- | --- | --- |
| aggregateStream signature | `aggregateStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>): Stream<O, E1 \| E2, R1 \| R2>`. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream typing | The checker requires both `A` and `L` assignable to `I`. The result element type is the Sink output type. The checker reports an incompatible input or leftover with `type-mismatch/003` from `fits` in `src/core/check_expr.ts`. It reports a non-Stream or non-Sink operand with `type-mismatch/010`. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream operands | `aggregateStream` needs exactly two arguments: a Stream, then a Sink. It has no capacity parameter and no pipeline spelling. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream channels | Failures and requirements are the union of the source and Sink channels. They stay deferred, without eager provider capture. Construction stays deferred. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream lowering | The emitter lowers to typed `Stream.aggregate(source, sink)` and does not cast away Sink channels. It does not change `runStream` or the default `Sink<I,O>` meaning. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream construction | Construction evaluates the two source expressions once, left to right. No source pull or Sink transform runs at construction. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream fresh state | Each terminal consumption allocates fresh producer, queue, Sink-run, and scope state. The same Stream can run again under different providers. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream demand | The target hands non-empty upstream chunks through a capacity-zero queue. When the Sink asks for a chunk, a latch permits one producer pull and one queue offer. The runtime replays Sink leftovers before another upstream pull. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream read-ahead | With `takeSink(1)`, a consumer blocked on its first result leaves one source pull. A positive-capacity buffered transduction pulls more. The rule does not limit the work of an arbitrary upstream operator. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream completion with takeSink(2) | For one `Stream.fromArray` chunk: `[1,2,3,4,5]` gives `[[1,2],[3,4],[5]]`. `[1,2,3,4]` gives `[[1,2],[3,4]]`. `[]` gives `[]`. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream chunk boundaries | The `Schedule.forever` handoff of the target can flush a partial sink between chunks. Rechunking the input can change aggregation boundaries. Repeated consumption still starts fresh state. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream end of input | After upstream completion with no leftovers, aggregation suppresses a new Sink run. After a source failure, it still emits a partial Sink result where the Sink can finish. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream failure example | A source that yields `[1,2,3]` and then fails with `source-stop` gives `[1,2]`, then `[3]`, then the failure. The failure does not become a successful stream end. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream sink failure and services | A Sink failure emits no invented batch for its incomplete run. The runtime looks up Sink services on each consumption. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream zero-progress sinks | An arbitrary host Sink can complete without consuming input. The target then emits that result repeatedly: `aggregate(Stream.never, Sink.succeed(7))` gives `[7,7,7]` under `take(3)`. The compiler adds no progress check and drops no output. Callers bound their own consumption. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream producer lifetime | The producer fiber belongs to the terminal consumption scope. A Sink failure closes a scoped source resource, including yielding cleanup, before the terminal failure returns. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream interruption and early stop | Interruption during a pending upstream pull runs and awaits the release of that pull. With `takeSink(1)`, taking the first result stops before the next source pull. The runtime does not create a partial result on interruption. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream causes | Typed failure, defects, and interruption stay separate causes. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| aggregateStream memory | The operation gives no general bounded-memory guarantee for arbitrary upstream chunks or Sinks. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |

### Keyed groups

| Rule | Choice | Evidence |
| --- | --- | --- |
| mapGroups signature | `mapGroups(source: Stream<A,E1,R1>, key: (A) => K, use: (K, Stream<A>) => B fails E2 uses R2, { bufferSize: N }): Stream<B, E1\|E2, R1\|(R2 minus Scope)>`. It is a builtin, not a user-defined generic function. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups callbacks | `key` and `use` must be inline callbacks. Their parameter types come from the source and classifier. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups classifier | The classifier is pure. It adds no typed failure or requirement. The `use` callback may fail, require services, and perform effects. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups result type | The `use` result must satisfy the recursive data-only predicate under the `value` rule. Primitives, literals, `void`, records, arrays, tuples, Options, unions, brands, data types, and error records with data-only contents are allowed. `unknown`, Streams, Effects, Refs, Fibers, scopes, Schedules, retry policies, Sinks, Codecs, Schemas, providers, functions, and opaque handles are rejected. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups options | The final argument is a required literal record that contains only `bufferSize`. `N` must be a positive safe integer literal. The checker rejects dynamic, zero, negative, fractional, and non-finite capacities. There is no default capacity. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups routing | One producer routes the source to live keyed groups. It runs one `use` callback per key concurrently and emits each result when ready. The runtime never restarts the producer per key. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Key classes | Allowed keys are `string`, `boolean`, and `int`, their aliases, homogeneous literal unions, and one primitive brand with such a base. Numeric literals must be safe integers. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Key union checking | The checker flattens unions and aliases first. Every member must have the same primitive class or the same brand identity. It rejects `never`, mixed classes, unions of different brands, and unions of a brand with its unbranded base. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Rejected key types | The checker rejects general `number`, records, tuples, arrays, Options, opaque values, and user-defined equality or hash. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Key equality | Keys use primitive value equality. String comparison is exact and case sensitive. `0` and `-0` share a group. Brands keep nominal checking and use their primitive at runtime. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group count | Each execution runs one callback per distinct key. Empty input starts none. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group ordering | Classification observes source element order. Each group receives its values in that order. Callback start, effect interleaving, and result order have no ordering guarantee. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Result merging | The runtime merges results as they are ready. An earlier live group cannot hold back a later completed group. There is no cross-group fairness guarantee. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Borrowed group binding | The second `use` parameter is a special borrowed local of type `Stream<A>`. Its deferred failure and requirement channels are empty. Source and producer failures stay on the outer stream. An ordinary Stream annotation does not remove its restrictions. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group reference count | The callback may contain zero or one syntactic reference to the group binding. Two references in mutually exclusive branches are rejected. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group terminal use | A reference must be the direct first operand of one terminal builtin: `collectStream`, `runStream`, `foldStream`, `foldEffectStream`, `headStream`, `lastStream`, or `drainStream`. The checker resolves the actual builtin. A shadowing function with the same spelling does not qualify. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group escape | The checker rejects aliases, assignments, aggregates, Refs, returned group values, host arguments, ordinary helper calls, stream transformations, and captures in nested closures, deferred effects, or fibers. A sink or fold callback can process values under the existing capture rules. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group non-escape enforcement | The checker and the validator both enforce the reference rule and the data-only result rule. Ordinary captures of borrowed resources and Fibers keep their current restrictions. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group pull scope | Before it calls `use`, the runtime acquires a group pull in a fresh callback-owned Scope. Acquiring the pull installs queue shutdown, even if the callback never references the group. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Group scope close | The scope closes when the callback succeeds, fails, or is interrupted, including after an early terminal result. A successful result becomes available only after its callback cleanup. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| Closed group keys | A finished callback closes its key for the execution. The runtime discards later values for that key. The key does not reopen or start another callback. Closing an unused or partly consumed group lets later keys proceed. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups construction | Construction evaluates the source and options once, in source order. It does no pulls, classification, callback work, or service acquisition. Each terminal execution creates fresh routing, queues, callbacks, and scopes. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups concurrency and capacity | Group callbacks run with unbounded concurrency. `bufferSize` bounds the stored elements of each live key queue. It does not bound the number of groups. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups backpressure | If a live callback pauses and its queue fills, the next producer offer waits. This delays other keys behind that offer. Completion or shutdown of that group releases the offer. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups memory limits | There is no total memory bound. There is no maximum key count, idle timeout, eviction, reopening policy, or bound on active resources. The merged result queue has capacity one. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups completion | Normal source completion ends live group inputs and waits for all callbacks. A callback that stays live can keep the result stream live. The API does not infer termination from a finite capacity. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups failure | A source or callback failure fails the outer stream and interrupts peers and the producer. It does not wait for a callback to finish normally. Downstream early stop, downstream failure, and external interruption also close the routing lifetime. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups cleanup and causes | Terminal completion waits for yielding callback and source finalizers. Uninterruptible user work can delay cleanup. Delivered results stay observable. The runtime creates no results for interrupted callbacks. Defects and interruption stay distinct from typed failures. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups channels | Active construction channels come from the evaluated arguments and stay active. Only deferred source and `use` channels enter the Stream. The error channel is `E1 \| E2`. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups Scope requirement | The requirements are `R1 \| (R2 minus Scope)`. The owned callback scope supplies the callback-local Scope. The checker does not discharge a Scope requirement of the source or of active construction. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups services | Other callback services stay deferred and resolve under the bindings of each terminal execution. A derived Stream reused under different providers invokes the matching services each time. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups lowering | The emitter lowers to `Stream.groupByKey` with `{ bufferSize: N }`, then `Stream.flatMap` with concurrency `"unbounded"` and bufferSize 1. Each group runs in `Effect.scoped`. The lowering through `Stream.mapEffect` is rejected. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups IR | The `map-groups` IR node holds the source, inline key and use closures, the positive capacity, and the borrowed group `LocalId`. The group identifier must be the second `use` parameter and unique in the closure's bindings. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups validation | The independent validator rederives parameter, key class, data-only, reference, capture, capacity, execution mode, and channel checks. It does not trust checker side tables or a forged group identifier. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |
| mapGroups out of scope | The slice has no general ownership type, keyed eviction, effectful classifier, total memory bound, custom equality, unrestricted `Stream<[K, Stream<A>]>`, or bounded callback count. | [2026-10-18-keyed-group-contract.md](archive/plans/2026-10-18-keyed-group-contract.md) |

### Sink and aggregation IR

| Rule | Choice | Evidence |
| --- | --- | --- |
| Sink IR leftover field | The IR Sink type has an optional `leftover: Type` field. Absence means `never`. Default no-leftover payloads omit it. The IR wire version stays 2. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink IR normalization | Interning, compatibility, independent validation, and emission treat an absent leftover field the same as `never`. Input, output, and leftover types all take part in graph walks, depth checks, serialization, and printing. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| take-sink and transduce-stream nodes | The `take-sink` node carries the checked positive literal count. The `transduce-stream` node has explicit stream and sink operands. Closed annotations give the constructor input type. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink validator | The independent validator checks count, result and leftover shape, input and replay compatibility, execution mode, and channel equations. It rejects omitted or forged leftover annotations on a producing constructor. `sink-for-each` keeps leftover `never`. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| Sink emission | The emitter uses `Sink.take<I>(count)` and explicit `Stream.transduce` type arguments that keep the sink's wider input `I`. Construction keeps argument order. `runStream` accepts any leftover channel and does not erase its operand's target type. | [2026-10-18-sink-leftover-contract.md](archive/plans/2026-10-18-sink-leftover-contract.md) |
| aggregate-stream IR | The `aggregate-stream` IR node stores both operands and its output and channel result. The independent validator rederives compatibility and effects. | [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |

## Schedules

### Schedule value and typing

| Rule | Choice | Evidence |
| --- | --- | --- |
| Schedule type | `Schedule<O, I = unknown, E = never, R = never>` is a deferred, reusable policy with output, input, typed failure, and service channels. The omitted `I`, `E`, and `R` default to `unknown`, `never`, and `never`. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule variance | `O`, `E`, and `R` are covariant. `I` is contravariant. The output channel includes the value that normal completion carries. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule and RetrySchedule | `RetrySchedule<E>` stays the small pure retry policy. The compiler does not convert it to or from a general Schedule. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule input of unknown | A Schedule input of `unknown` accepts any supplied input. This exception applies only to the contravariant Schedule input slot. Ordinary source `unknown` assignment does not change. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule construction | Construction does not run a state factory, a service, or a step. The runtime allocates a fresh Schedule execution for each consumption. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule state | Schedule state is private to one execution. Two consumers of one Schedule value do not share a counter. A policy reused under another provider resolves its services during that consumption. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |

### Schedule constructors

| Rule | Choice | Evidence |
| --- | --- | --- |
| scheduleFromStep signature | `scheduleFromStep(initial, decide)` is the general constructor. `initial` is an inline nullary callback that creates state `S` for each execution. `decide` is an inline callback from `(S, ScheduleInput<I>)` to `ScheduleDecision<S,O>`. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| ScheduleDecision shape | The decision is a structural tagged value: `{ kind: "Continue", state: S, output: O, delayMillis: number }` or `{ kind: "Done", output: O }`. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| ScheduleInput shape | `ScheduleInput<I>` is `{ input: I, attempt: int, start: number, now: number, elapsed: number, elapsedSincePrevious: number }`. In `scheduleFromStep`, `attempt` starts at one for each execution. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Continue and Done steps | A `Continue` step updates private state, emits `output`, and waits `delayMillis` before the next recurrence. A `Done` step ends normally with `output`. It emits no recurrence and does not wait. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| scheduleFromStep channels | Both callbacks may declare typed failures and service requirements. The resulting Schedule unions their failure and requirement channels. A callback failure or defect keeps its original cause. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| scheduleFromStep isolation | Source callbacks cannot see or mutate the target step function. The target Cause does not appear in source types. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| scheduleRecurs and scheduleSpaced | `scheduleRecurs(times: int)` and `scheduleSpaced(delayMillis: number)` return `Schedule<int>`. They emit zero-based attempt numbers and accept `unknown` input. Their numeric arguments follow the target `recurs` and `spaced(Duration.millis(...))` semantics, with no added rounding or clamping. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |

### Schedule map

| Rule | Choice | Evidence |
| --- | --- | --- |
| scheduleMap signature | `scheduleMap(schedule, callback)` transforms outputs with an inline callback that may be pure or effectful. The callback receives `ScheduleMetadata<O,I>`, which adds `output` and `durationMillis` to the input metadata. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| scheduleMap channels | `scheduleMap` keeps the input channel and the delay. It changes the output channel. It unions the callback failure and requirements into the Schedule channels. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| scheduleMap timing | The callback runs on each continuing step and on normal completion. On normal completion, `durationMillis` is zero. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |

### Schedule composition

| Rule | Choice | Evidence |
| --- | --- | --- |
| Composition operands | The three composition forms combine two Schedule values. Each operand must be a four-channel Schedule. `RetrySchedule` is not an operand. The checker rejects non-Schedules and wrong arity. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition input rule | For inputs `I1` and `I2`, the checker chooses `I1` if every `I1` value fits `I2`. Otherwise it chooses `I2` if every `I2` value fits `I1`. Otherwise it rejects the call. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition input limit | Composition requires comparable input types. The source language has no general intersection type. Incomparable inputs are rejected, for example distinct record field sets. Source `int` fits `number`. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| scheduleConcat type | `scheduleConcat` returns `Schedule<O1 \| O2, I, E1 \| E2, R1 \| R2>`. It unions the outputs of both policies. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| scheduleMax and scheduleMin type | `scheduleMax` and `scheduleMin` return `Schedule<number, I, E1 \| E2, R1 \| R2>`. The output is the selected delay in milliseconds. It is zero on normal completion. It differs from the operand outputs. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition evaluation | The runtime evaluates all arguments once, left to right. Their construction effects stay active. Stepping, failures, and services stay deferred. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |

### Schedule composition runtime

| Rule | Choice | Evidence |
| --- | --- | --- |
| scheduleMax semantics | `scheduleMax` steps both policies for an input. It recurs only if both recur. It uses the longer delay. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| scheduleMin semantics | `scheduleMin` recurs while either policy recurs. It uses the shorter delay among the active policies. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| scheduleConcat semantics | `scheduleConcat` finishes the left policy before it starts the right policy. The input that completes the left policy goes to the first right step. Recurrence outputs come from either phase. It completes with the Done output of the right policy. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition state and failure | Each execution creates fresh child Schedule state. A typed failure from either child fails the composed Schedule. Defects and interruption keep their target causes. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition scope | The composition forms add no separate scope or fiber. A consumer owns the execution. It awaits upstream cleanup on failure or interruption. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition nesting | The binary forms can nest for more policies. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md) |
| Composition out of scope | The language does not support general intersections, heterogeneous arrays of policies, `concatResult`, manual stepping, or other Schedule consumers. The first slice does not expose `Schedule.toStep`. It does not drive `Effect.repeat` or `Effect.retry` with a general Schedule. `retry` with a `RetrySchedule` stays. | [2026-10-18-schedule-composition-contract.md](archive/plans/2026-10-18-schedule-composition-contract.md), [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |

### Timed aggregation

| Rule | Choice | Evidence |
| --- | --- | --- |
| aggregateWithinStream signature | `aggregateWithinStream(source: Stream<A,E1,R1>, sink: Sink<I,O,E2,R2,L>, schedule: Schedule<C,J,E3,R3>)` returns `Stream<O, E1 \| E2 \| E3, R1 \| R2 \| R3>`. It is a call-only prelude builtin and shadowable, like `aggregateStream`. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| aggregateWithinStream input rules | The checker requires `A` and `L` assignable to `I`, and `Option<O>` assignable to `J`. The target supplies the previous Sink result, which starts as `None`. A string-input Schedule is invalid for a Sink that produces `number[]`. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| aggregateWithinStream output | The Schedule output `C` is not a Stream element. The Sink output `O` is the Stream element. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| aggregateWithinStream use of the policy | The policy flushes partial Sink results or stops upstream. Failures and services of the Schedule stay deferred until the Stream runs. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| aggregateWithinStream evaluation | The runtime evaluates source, Sink, and Schedule expressions once, in source order, when it constructs the Stream. It does not run their deferred work then. Each terminal consumption allocates a fresh Schedule execution, producer, queue, Sink runs, and scope. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule stepping in aggregation | The runtime steps the Schedule at most once per aggregation, after the first element arrives, with the preceding `Option<O>` result. An immediate Sink completion from leftovers may skip a step. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Timed flush | A successful Schedule step races with Sink completion. The step delay can flush a partial Sink. Time between aggregations is excluded from the policy clock, so `scheduleSpaced` acts as a flush timer. The target's `Schedule.fixed` and `Schedule.upTo` do not serve as idle flush timers. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md), [2026-10-18-async-aggregation-contract.md](archive/plans/2026-10-18-async-aggregation-contract.md) |
| Schedule end in aggregation | On normal Schedule end, the runtime emits the current result and leftovers. Then the Stream stops with no further upstream pull. The end is not a typed failure. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Schedule failure in aggregation | A typed Schedule failure fails the Stream. A defect stays a defect. The terminal scope owns and awaits source, Sink, and Schedule cleanup on failure or interruption. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |
| Aggregation emission | The emitter uses a typed `Stream.aggregateWithin(source, sink, schedule)` call. No cast erases the Schedule channels. A fixed-duration shortcut is not part of the rule. | [2026-10-18-general-schedule-contract.md](archive/plans/2026-10-18-general-schedule-contract.md) |

## Schema

### Schema type and runners

| Rule | Choice | Evidence |
| --- | --- | --- |
| Schema type | `Schema<D, E = D, RD = never, RE = never, M = D>` is a reusable, deferred Schema value. D is the decoded type, E the encoded type, RD the decode services, RE the encode services, and M the make input. Existing four-argument Schemas keep M = D. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| No typed parse failure | Neither direction has a typed failure parameter. Parsing fails with the reserved nominal `SchemaError`. Source code can catch it and read its message. Source cannot construct a `SchemaError`. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Data-only Schema | A Schema value cannot hold functions, providers, scopes, or other deferred source values as decoded or encoded data. M must also be data-only. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Runner signatures | `schemaDecode(schema: Schema<D,E,RD,RE>, input: unknown): D fails SchemaError uses RD` and `schemaEncode(schema: Schema<D,E,RD,RE>, value: D): E fails SchemaError uses RE`. `schemaEncode` checks that the value fits D. Each runner keeps its own service channel. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Deferred execution | A runner parses only when its Effect runs. Constructing a Schema runs no callback and resolves no service. A runner keeps the effects of its arguments. Repeated runs reuse the Schema value and share no mutable parse state. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Failure and defects | Validation failures, `None` from a transformation, and transformation issues are typed `SchemaError` failures with the issue tree intact. A defect stays a defect. Interruption stays interruption. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |

### Schema composition

| Rule | Choice | Evidence |
| --- | --- | --- |
| schema() | `schema(): Schema<T,T>` needs an expected `Schema<T,T>` type and derives an identity Schema from a data-only type. It requires D equal to E and no services. The checker rejects an empty call without an expected type. `schema()` also rejects a changed make input. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaArray | `schemaArray(Schema<A,B,RD,RE>): Schema<A[],B[],RD,RE>` keeps both directions and their requirements. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaStruct | `schemaStruct({ field: Schema<A,B,RD,RE>, ... })` builds a record Schema. It evaluates each field expression once, in source order. It unions the requirements of each direction separately. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaTransform types | `schemaTransform(source, target, decode, encode)` takes `Schema<A,E,RD1,RE1>` and `Schema<B,C,RD2,RE2>`. The result is `Schema<B,E,RD1 \| RD2 \| RD3,RE1 \| RE2 \| RE3>`. RD3 and RE3 are the requirements of the callbacks. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaTransform callbacks | The decode callback is inline, takes `A`, and returns `Option<C>`. The encode callback is inline, takes `C`, and returns `Option<A>`. Callbacks can run effects and use services. The target validates the intermediate value against `C` on decode. The source validates the callback result against `A` on encode. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaTransform rejection | `None` becomes `SchemaIssue.InvalidValue` with a fixed message. `Some` proceeds. Per direction, a callback can instead return `T fails SchemaIssue`. The runner then passes that exact issue tree to the target. No other typed callback failure converts to a Schema issue. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Out of scope | The first slice excludes user generics, mutual recursion, arbitrary `SchemaIssue` construction, arbitrary package imports, and ecosystem object builders. It also excludes arbitrary Schema AST construction and package builder interoperability. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |

### Optional keys and field descriptors

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaOptionalKey | `schemaOptionalKey(Schema<D,E,RD,RE>): SchemaOptional<D,E,RD,RE>`. In `schemaStruct` it gives `{ optional?: D }` decoded and `{ optional?: E }` encoded. The field expression runs once, in source order. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Exact optionality | A missing property stays missing in both directions. It is not `None`, `null`, or `undefined`. A present property runs the field Schema and must validate, also when its value is explicit `undefined`. A required `Option<T>` field stays distinct from an optional key. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Descriptor use | `SchemaOptional` works only as a `schemaStruct` field. It is not a runnable Schema and not decoded or encoded data. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Descriptor meanings | `SchemaOptional` describes a field optional in both directions. `SchemaEncodedOptional` describes a required decoded field with an exact optional encoded key. `SchemaDecodedOptional` describes an exact optional decoded field with a required encoded key. All three descriptor types work only as `schemaStruct` fields. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |

### Tagged unions

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaUnion tagged form | `schemaUnion([branch1, branch2, ...])` takes at least two ordinary Schema branches. The tagged form is a special case of the general union. In the tagged form, every branch has the same required discriminant key with one string literal, equal in D and E and different from every other branch. Only the tagged form guards recursion. The result is the union of D, E, RD, and RE. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md), [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Tag dispatch | The runtime selects the branch by the tag before it runs any field transformation. A missing or unknown tag fails with `SchemaError`. A failure inside the selected branch stays that failure, and no other branch runs. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |

### Authored Schema issues

| Rule | Choice | Evidence |
| --- | --- | --- |
| SchemaIssue type | `SchemaIssue` is an opaque, nominal source failure type that maps to the target `SchemaIssue.Issue`. It differs from `SchemaError`. A callback may fail with `SchemaIssue`. A runner fails with `SchemaError`. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| schemaInvalid | `schemaInvalid(message: string): SchemaIssue` builds an `InvalidValue` node with a message and no reported input. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| schemaAt | `schemaAt(key: string \| int, issue: SchemaIssue): SchemaIssue` builds a one-step `Pointer`. Nested calls build longer paths. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| schemaBoth | `schemaBoth(subject: Schema<D,E,RD,RE>, left: SchemaIssue, right: SchemaIssue): SchemaIssue` builds a two-child `Composite` with the AST of the Schema. The Schema argument needs no decode or encode service. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Issue restrictions | The three issue constructors are pure. They expose no arbitrary AST nodes and no input-reporting options. `SchemaIssue` cannot be a Schema data type, a host declaration, or a catchable runner error. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| SchemaIssue matching | A catch or match on `SchemaIssue` uses `SchemaIssue.isIssue`, because the target issue family has several runtime tags. A mixed catch handler dispatches only the original failure. Errors raised by a handler are not caught by another handler in that clause. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |

### Self-recursive data aliases and schemaRecursive

| Rule | Choice | Evidence |
| --- | --- | --- |
| Array guard | The checker accepts a single local alias that refers to itself only beneath an array inside a data-only record, such as `type Tree = { value: Int, children: Tree[] }`. The empty array is the finite base case. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Optional and tagged guards | A self reference beneath an optional record field is also accepted, as in `type Node = { next?: Node }`. A self reference beneath one tagged union variant is accepted when another variant has no self reference. Unions beneath an established guard keep it. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |
| Rejected cycles | The checker rejects `type Loop = Loop`, required direct fields such as `type Loop = { next: Loop }`, mutually recursive aliases, recursive brands or errors, aliases through functions or deferred types, and unions with no terminal variant. It reports `declaration/007`. A cycle that has a data type follows the rule "Data type recursion". | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| Recursive comparison | The checker compares a recursive alias by its declared identity. Nonrecursive aliases keep their compatibility rules. The guard covers finite data only. It does not cover cyclic JavaScript object graphs or give a stack bound. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md) |
| schemaRecursive | `schemaRecursive((self: Schema<D,E,RD,RE,M>) => Schema<D,E,RD,RE,M>)` takes a pure inline callback. E and M default to D. The `self` parameter is a lazy reference, not an execution. The body runs once. Each parse follows `self` only where it reaches a guard. | [2026-10-18-schema-composition-recursion-contract.md](archive/plans/2026-10-18-schema-composition-recursion-contract.md), [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| schemaRecursive body | The body root is a `schemaStruct` or a `schemaUnion` call. A self reference sits beneath an array, an optional key, or a tagged union with a self-free terminal branch inside that root. The checker rejects a self reference as the immediate result or as a required direct field. | [2026-10-18-schema-optional-union-issues-contract.md](archive/plans/2026-10-18-schema-optional-union-issues-contract.md) |

### Type-side constructor schemaMake

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaMake signature | `schemaMake(Schema<D,E,RD,RE,M>, M) : D fails SchemaIssue` is a shadowable, call-only builtin. It validates the type side and returns the structured `SchemaIssue` directly. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |
| schemaMake inputs | The checker rejects field descriptors, unknown inputs, encoded values that do not fit D, incomplete records, and extra options. Make options, skipped validation, and the synchronous throwing and Option constructor methods are not exposed. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |
| schemaMake services | `schemaMake` runs neither the wire decoder nor the encoder. It needs neither RD nor RE. Active failures and services of its two arguments still propagate. The Schema and the input evaluate once each, in source order. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |
| schemaMake defects | A defect stays a defect. `schemaMake` does not turn it into `SchemaIssue`. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |
| Source factory defaults | An ordinary source factory supplies explicit defaults and then calls `schemaMake`. Present values skip the default. Exact source input types reject explicit undefined. Null stays present and is validated against D. Source optional reads keep null and map undefined to `None`. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |
| Nested factory path | A child factory failure gets its parent path only when source code catches `SchemaIssue` and rethrows `schemaAt("settings", issue)`. Native nested constructor metadata adds the path automatically. | [2026-10-19-schema-constructor-contract.md](archive/plans/2026-10-19-schema-constructor-contract.md) |

### Constructor defaults and make input M

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaConstructorDefault | `schemaConstructorDefault(Schema<D,E,RD,RE,M>, () -> M [fails SchemaIssue]) : SchemaConstructorDefault<D,E,RD,RE,M>` is shadowable and call-only. The callback is inline with zero arguments. It may be pure or effectful, uses no services, and fails with nothing or exactly `SchemaIssue`. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| M type | M is the make input, distinct from D and E. M compatibility is invariant, so assignment to a four-argument Schema annotation cannot discard a changed M. Equivalent aliases for M and D stay compatible. The constructor-default flag is also invariant. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| Default callback result | A nested default can return an incomplete make-input record such as `{}`. The callback can capture a `Ref` or an Effect with no service requirements. It runs fresh at each use. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| Default runtime | A missing or raw undefined input runs the callback, then constructs and validates its M. A present value skips the default. Null stays present, also when a wire adapter treats null as missing. Defaults run only during construction, never during wire decoding or encoding. Nested validation attaches full field paths. The constructor rejects null when the wrapped M excludes null. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| Default descriptor use | The default descriptor works as a struct field, as the input of a unary field adapter, or as the required source of `schemaOptionalFromRequired`. It leaves D, E, and both service directions unchanged. It lets the struct make input omit the field. It cannot run as a Schema, be a union or array member, or be wrapped twice. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md), [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Failure and cleanup | Defects and interruption keep their channels. Interruption waits for cleanup of running defaults. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| Argument evaluation | The Schema argument of `schemaConstructorDefault` evaluates once at construction. Each default use runs the deferred callback. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| Host replay | Host calls to `makeEffect` of an emitted Schema keep native replay identity: repeating one raw constructor effect may update its earlier result object. Source functions get no new object-identity guarantee. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |

### Make input propagation through composition

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaStruct M | The struct M holds each field M. Constructor-default fields and decoded-optional fields may be absent. An ordinary field stays required in M even if its nested M has defaults. Wrapping the whole nested Schema with `schemaConstructorDefault` makes the outer field optional. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| schemaArray and schemaUnion M | `schemaArray` gives an array of the element M. `schemaUnion` gives the union of the branch M types in native branch order. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| schemaOptionalKey M | `schemaOptionalKey` keeps the wrapped M. The containing struct makes the field optional. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |
| schemaTransform M | `schemaTransform` takes the M of the target Schema. Source wire transformations do not run during make. | [2026-10-19-schema-constructor-metadata-contract.md](archive/plans/2026-10-19-schema-constructor-metadata-contract.md) |

### Optional adapter extension

| Rule | Choice | Evidence |
| --- | --- | --- |
| Adapter inputs | The optional adapters accept ordinary Schemas with a distinct M. The three field descriptor types accept M as a fifth argument. D, E, presence flags, directional services, callback contracts, and encoding strategies keep their meanings. | [2026-10-19-schema-constructor-optional-contract.md](archive/plans/2026-10-19-schema-constructor-optional-contract.md) |
| Wrapped M adapters | `schemaNullToMissingKey` keeps the wrapped M and is optional in the struct M. `schemaDefaultKey` with any `on` value keeps the wrapped M and is required in the struct M, unless the wrapped Schema carries a constructor default. A constructor default makes the field optional in the struct M. | [2026-10-19-schema-constructor-optional-contract.md](archive/plans/2026-10-19-schema-constructor-optional-contract.md) |
| Transformation adapters M | `schemaOptionalTransform` and `schemaOptionalFromRequired` take the M of the decoded target and are optional in the struct M. The M of the source does not enter the result. A required encoded field can stay optional during construction when the decoded target is optional. | [2026-10-19-schema-constructor-optional-contract.md](archive/plans/2026-10-19-schema-constructor-optional-contract.md) |
| Wire defaults in make | A wire default never supplies a missing constructor field. A present partial nested M still runs its nested defaults. No wire default or optional getter runs during `schemaMake`. Make needs neither decode nor encode services. | [2026-10-19-schema-constructor-optional-contract.md](archive/plans/2026-10-19-schema-constructor-optional-contract.md) |
| Default callback types | A decoding-default callback returns complete D. An encoded-default callback returns complete E. Neither accepts a partial M. | [2026-10-19-schema-constructor-optional-contract.md](archive/plans/2026-10-19-schema-constructor-optional-contract.md) |

### Recursive constructor rule

| Rule | Choice | Evidence |
| --- | --- | --- |
| Recursive M alias | A separate recursive M is an ordinary data alias with its own array, optional-key, or tagged terminal guard. D and M may differ in field presence. A required `children` array in D may be optional in M when the body supplies a default of `[]`. | [2026-10-19-schema-constructor-recursive-contract.md](archive/plans/2026-10-19-schema-constructor-recursive-contract.md) |
| Recursive runtime | `schemaMake` fills defaults freshly at each absent field and skips them for present values. Wire decode needs the complete E shape and wire encode needs the complete D shape, unless a wire adapter supplies a default. Both keep their directional services. Make needs no wire service. Failures keep `SchemaIssue` paths of field names and array indices. | [2026-10-19-schema-constructor-recursive-contract.md](archive/plans/2026-10-19-schema-constructor-recursive-contract.md), [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Recursive limits | A finite data guard does not prove that user default effects end. It also does not cover defaults that keep generating constructor input. Cyclic runtime objects, mutual recursion, constructor options, and arbitrary AST access are outside the contract. | [2026-10-19-schema-constructor-recursive-contract.md](archive/plans/2026-10-19-schema-constructor-recursive-contract.md) |

### Field-default extension

| Rule | Choice | Evidence |
| --- | --- | --- |
| Accepted inputs | `schemaConstructorDefault` accepts an ordinary Schema or one existing field descriptor that has no constructor default. It keeps the decoded and encoded presence flags, D, E, M, and directional services. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |
| Result types | Schema gives `SchemaConstructorDefault`. `SchemaOptional` gives `SchemaOptionalConstructorDefault`. `SchemaEncodedOptional` gives `SchemaEncodedOptionalConstructorDefault`. `SchemaDecodedOptional` gives `SchemaDecodedOptionalConstructorDefault`. All four take `<D,E=D,RD=never,RE=never,M=D>`. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |
| Invariance | All flags and D, E, and M are invariant. A constructor-default flag cannot be discarded, even when the field was already optional during construction. The three presence flags stay mutually exclusive. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |
| Struct presence | The containing struct makes the field optional in its M. D and E keep their field presence. An optional decoded field stays optional in D. A required decoded field with a decoding default stays required in D, while its encoded key and make key can both be optional. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |
| Separate defaults | Construction skips decoding defaults and wire getters. Decoding and encoding skip constructor defaults. For a field with both, a missing make input gives the constructor default and a missing wire field gives the decoding default. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |
| Field-default limits | The Option adapter still needs complete `Option<D>` contents, and a default does not make it `Option<M>`. Descriptor runners and duplicate defaults are errors. The recursive guard can pass through the wrapper and its argument, but default callbacks cannot capture `self`. Constructor options and arbitrary AST access are outside this slice. | [2026-10-19-schema-constructor-fields-contract.md](archive/plans/2026-10-19-schema-constructor-fields-contract.md) |

### Adapter-order rule

| Rule | Choice | Evidence |
| --- | --- | --- |
| Unary adapters after defaults | The unary field builders accept `SchemaConstructorDefault` as well as ordinary Schemas. They still reject a descriptor that already has an optionality flag. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Bridge inputs | The optional bridges also accept `SchemaOptionalConstructorDefault` in either existing optional position. The required source of `schemaOptionalFromRequired` may be a `SchemaConstructorDefault`. Every result keeps its D, E, presence, service, and make-input rules. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Retained defaults | `schemaOptionalKey`, `schemaNullToMissingKey`, and `schemaDefaultKey` with any `on` value keep the constructor default of the input. The combined descriptor names express it. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Bridge target defaults | `schemaOptionalTransform` and `schemaOptionalFromRequired` take the constructor default only from the target. The root default of the source does not become a default of the result. If only the source has a default, a missing make input stays absent when the target is optional. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Option adapter reset | `schemaOptionFromOptionalKey` gives required `Option<D>` make input and no root default. A missing field fails construction, even if the source had a default. `Some` must hold complete D. A new default may be attached after this reset. It validates the contents without running nested constructor defaults. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Order independence | With a constructor default and a wire default, both orders give the same wire-default behavior. A missing make input gives the constructor default, and a missing wire field gives the wire default. Wire and constructor defaults stay independent. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |
| Adapter-order errors | Assignment stays invariant in all flags and D, E, and M. An annotation cannot silently discard a default. The checker rejects a second default when the preceding adapter retains the original, and rejects incompatible input presence and descriptor runners. Further descriptor presence rewrites are outside this slice. | [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |

### Schema defaults: missing key (schemaDefaultKey)

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaDefaultKey signature | `schemaDefaultKey(Schema<D,E,RD,RE>, () -> D [fails SchemaIssue \| SchemaError] [uses RDefault], { on?, encodingStrategy? }?) : SchemaEncodedOptional<D,E,RD \| RDefault,RE>`. The brackets show optional clauses, not source syntax. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md), [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Constructor form | The callback is inline and takes no arguments. The result is a struct-only field descriptor, not a runnable Schema. The checker tracks decoded and encoded optionality separately. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Default `on` value | The option `on` is `"missing"` by default. A call without `on` defaults only an absent key. The values `"null"` and `"encoded"` select the variants below. The old names `schemaDefaultNullKey` and `schemaDefaultEncodedKey` no longer exist. Write `schemaDefaultKey(schema, callback, { on: "null" })` or `{ on: "encoded" }` instead. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Missing-key decode | The runtime calls the default callback once for each decode where the key is absent. A present value never calls it. Present `undefined` fails. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Default value type | The callback returns the decoded type D and bypasses the wrapped decoding transform. Default services join only RD. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Failure channel of a default | The callback may be pure or effectful. It declares no typed failure, exactly `SchemaIssue`, or exactly `SchemaError`. The checker rejects a callback that declares both. The runner converts `SchemaIssue` to `SchemaError` with the field path. An existing `SchemaError` passes unchanged. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Fresh default per decode | The runtime defers the callback with `Effect.sync` or `Effect.suspend`. Each decode gets a fresh invocation, also when the same effect runs again. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Defects and interruption in defaults | Defects keep their channel. Interruption waits for the cleanup of the callback. Neither becomes a typed `SchemaError`. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Old pure forms | A pure callback with no failure and no services stays valid. The two-argument form stays valid. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |

### Default options and encoding strategy

| Rule | Choice | Evidence |
| --- | --- | --- |
| Options record | The options argument is an inline record with one or two fields. Allowed fields are `on` and `encodingStrategy`. Each value is a string literal. The checker rejects an empty record, named records, dynamic values, spreads, shorthand fields, duplicate keys, and extra fields. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md), [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| `encodingStrategy` values | `encodingStrategy` is `"passthrough"` or `"omit"`. A call without `encodingStrategy` selects passthrough, with or without an options record. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Passthrough encoding | The encoder runs the wrapped encoder and writes its E value. This includes values equal to the default and `null` where D admits `null`. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Omit encoding | The encoder omits every valid decoded value, not only the default. It does not evaluate the default and does not compare values. It skips the wrapped encoder and its services. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Static RE under omit | The static RE requirement stays in the type under omit, although the runtime skips the encoder. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Validation before omit | A present invalid decoded value fails validation at the field path before omission. Source `schemaEncode` always requires the full decoded record. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |
| Decoding is strategy-independent | The encoding strategy does not change decoding. The default never runs during encoding. | [2026-10-19-schema-default-encoding-contract.md](archive/plans/2026-10-19-schema-default-encoding-contract.md) |

### Defaults for a missing or null key (on: "null")

| Rule | Choice | Evidence |
| --- | --- | --- |
| Signature | `schemaDefaultKey(Schema<D,E,RD,RE>, () -> D [fails ...] [uses RDefault], { on: "null", encodingStrategy? }) : SchemaEncodedOptional<D,E \| null,RD \| RDefault,RE>`. The encoded type gains `null`. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |
| Nonnullable types | Both D and E must exclude `null`. The checker rejects a wrapped Schema with a nullable channel. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |
| Field presence | The decoded field is required and excludes `null`. The encoded field is exact optional and admits `null`. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |
| Decode cases | An absent key or a present `null` runs a fresh default. A present valid E runs the wrapped decoder and skips the default. Present `undefined` or invalid E fails with `SchemaError` and skips the default. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |
| Default value and services | The default is a decoded value. It bypasses the wrapped transformation and validates against D. Default services join only RD. A missing or null key skips the wrapped decoder at runtime but keeps its static RD. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |
| Encoding | Passthrough encoding runs the wrapped encoder and writes E. Omit encoding drops every valid decoded value and skips the wrapped encoder. Encoding never writes `null`. | [2026-10-19-schema-null-default-contract.md](archive/plans/2026-10-19-schema-null-default-contract.md) |

### Defaults for an encoded value (on: "encoded")

| Rule | Choice | Evidence |
| --- | --- | --- |
| Signature | `schemaDefaultKey(Schema<D,E,RD,RE>, () -> E [fails SchemaIssue \| SchemaError] [uses RDefault], { on: "encoded", encodingStrategy? }) : SchemaEncodedOptional<D,E,RD \| RDefault,RE>`. The callback returns the encoded type E. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Decode | A missing key runs a fresh callback, validates the E result, and runs the wrapped decoder to produce D. A present valid E skips the default and runs the same decoder. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Present invalid input | Present invalid E and explicit `undefined` fail without calling the default. Present `null` skips the default. It decodes if E admits `null` and fails otherwise. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Services and failures | Default services join RD with the wrapped decoder services. Default and decoder issues become `SchemaError` at the field path. Defects keep their channel. Cancellation waits for cleanup in either stage. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Encoding | Encoding requires only RE and never evaluates the default. Passthrough runs the wrapped encoder, validates E, and writes the field. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |
| Omit keeps encoder work | Omit runs the wrapped encoder and validates its E, then discards the result and omits the field. Encoder calls, services, typed failures, defects, and interruption stay observable. This differs from `on: "missing"` and `on: "null"`. | [2026-10-19-schema-encoded-default-contract.md](archive/plans/2026-10-19-schema-encoded-default-contract.md) |

### Optional field bridges

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaOptionFromOptionalKey | `schemaOptionFromOptionalKey(Schema<D,E,RD,RE>) : SchemaEncodedOptional<Option<D>,E,RD,RE>`. A missing encoded key becomes a present `None`. A present valid value becomes `Some(decoded)`. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Option encoding | Encoding `None` omits the key. Encoding `Some` runs the field encoding Schema. Present `undefined` fails unless the wrapped Schema accepts it. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Skipped transformation | A missing key and `None` skip the wrapped transformation and its services. The static type keeps the decode and encode requirements. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Nullable with Option | `schemaOptionFromOptionalKey(nullable)` maps a missing key to a required `None`. A present `null` becomes `Some(null)`. Encoding reverses this distinction. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| Constructor form | `schemaOptionFromOptionalKey`, `schemaOptionalTransform`, and `schemaOptionalFromRequired` are call-only and shadowable. A descriptor cannot be used as a Schema runner. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md), [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |

### Optional transformations and effectful getters

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaOptionalTransform signature | `schemaOptionalTransform(SchemaOptional<S,E,RSD,RSE>, SchemaOptional<T,U,RTD,RTE>, (Option<S>) -> Option<U> [fails SchemaIssue] [uses RDec], (Option<U>) -> Option<S> [fails SchemaIssue] [uses REnc]) : SchemaOptional<T,E,RSD \| RTD \| RDec,RSE \| RTE \| REnc>`. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Operand rules | Both Schema operands are exact optional descriptors. Both callbacks are inline. The checker rejects forged descriptors, callback types, and failure channels. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Getter calls | `None` means a missing key. A callback runs for both missing and present keys. The source field Schema checks a present key before the decode callback. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Getter results | The decode callback returns `None` to omit the decoded key or `Some(U)` to validate and emit the target field. Encoding applies the inverse callback from `Option<U>` to `Option<S>`. | [2026-10-19-schema-optional-transform-defaults-contract.md](archive/plans/2026-10-19-schema-optional-transform-defaults-contract.md) |
| Directional services | Getter callbacks may be effectful. Decode and encode callbacks add requirements only to their own direction. Source and target field Schemas add their own directional requirements. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Getter failures | A getter declares no typed failure or exactly `SchemaIssue`. The checker rejects mixed, unrelated, or forged failures. The runner wraps an authored issue as `SchemaError` with the field path. Defects and interruption keep their causes. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md) |
| Outside this slice | Other typed callback failures are not supported. The runner does not translate them. Constructor defaults for these builders follow the adapter-order rule. | [2026-10-19-schema-effectful-optional-contract.md](archive/plans/2026-10-19-schema-effectful-optional-contract.md), [2026-10-19-schema-constructor-order-contract.md](archive/plans/2026-10-19-schema-constructor-order-contract.md) |

### Required encoded to optional decoded (schemaOptionalFromRequired)

| Rule | Choice | Evidence |
| --- | --- | --- |
| Signature | `schemaOptionalFromRequired(Schema<S,E,RSD,RSE>, SchemaOptional<T,U,RTD,RTE>, (S) -> Option<U> [fails SchemaIssue] [uses RDec], (Option<U>) -> S [fails SchemaIssue] [uses REnc]) : SchemaDecodedOptional<T,E,RSD \| RTD \| RDec,RSE \| RTE \| REnc>`. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Descriptor | The result is a struct-field descriptor with an exact optional decoded key and a required encoded key. It is not valid as an array element, Schema runner, or Schema value. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Missing encoded key | Decoding fails with `SchemaIssue.InvalidValue` if the encoded key is absent. The runner reports `SchemaError` at the field path. The callback and its services do not run. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Decode | The source Schema validates a present key first. The callback gets decoded S. It returns `Some(U)` to emit the decoded field or `None` to omit it. Present `undefined` stays invalid when the source Schema rejects it. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Encode | The callback gets `None` for a missing decoded key and `Some(U)` for a present key. It returns a required S. Encoding always writes the key on success. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Callbacks | Callbacks are inline, pure or effectful, with no typed failure or exactly `SchemaIssue`. Authored issues keep their paths. Defects and interruption keep their causes. Services join only their own direction. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Construction | Constructing the descriptor does no decoding and no service work. A guarded builder is required: the checker does not accept an unguarded required-to-optional builder with a required encoded type. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |
| Permissive form | `schemaOptionalTransform(schemaOptionalKey(source), target, ...)` expresses the form that accepts a missing key, with an exact optional encoded type. | [2026-10-19-schema-required-optional-contract.md](archive/plans/2026-10-19-schema-required-optional-contract.md) |

### The null singleton and nullable fields

| Rule | Choice | Evidence |
| --- | --- | --- |
| null singleton | `null` is a data literal and a singleton type. It fits itself and unions that contain itself. It does not fit strings, numbers, booleans, or `void`. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| null stays distinct | Source `null` emits JavaScript `null`. It stays distinct from unit and from explicit `undefined`. Source `undefined` values and undefined-tolerant field types are not supported. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| null in annotations | Write `type Nil = null`, then use `Nil` in annotations outside type or error declarations. A declaration such as `type NullableName = string \| null` needs no new type constructor. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| null in matches and equality | Finite literal matches may include `null`. Equality with a singleton `null` operand accepts a nullable opposite operand in either order. There is no flow narrowing. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| null inference limits | `null` does not become numeric in stream-state or Ref inference. `null` is not a valid grouping key. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| Exact optional nullable field | `schemaStruct({ name: schemaOptionalKey(schemaUnion([text, nil])) })` retains `null`. A missing key stays missing. A present `null` stays `null` and skips the wrapped transformation. Present valid text decodes. Present `undefined` fails with `SchemaError` at the field path. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| schemaNullToMissingKey | `schemaNullToMissingKey(Schema<D,E,RD,RE>) : SchemaOptional<D,E \| null,RD,RE>`. Both D and E must exclude `null`. The result is a struct-only descriptor. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| Null-to-missing behavior | A missing or null encoded key decodes to an absent key. A present E decodes through the wrapped Schema. Encoding an absent key omits it. Encoding a present D runs the wrapped encoder and never writes `null`. Explicit `undefined` fails. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |
| Services under null | Decode and encode services stay separate. They include the wrapped branch even when a missing or null value skips it. | [2026-10-19-schema-nullable-optional-contract.md](archive/plans/2026-10-19-schema-nullable-optional-contract.md) |

### General unions

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaUnion form | `schemaUnion([branch1, branch2, ...])` accepts an inline list of at least two ordinary Schema values. The constructor is call-only and shadowable. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Branch types | Branches may have unlike data types, overlapping record shapes, duplicate types, or transformed data. A struct-only field descriptor is not a valid branch. The tagged-record union is a special case. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Result type | The result is `Schema<D_1 \| ... \| D_n,E_1 \| ... \| E_n,union RD_i,union RE_i>`. The static requirements include every branch, even if a run stops early. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Rejected forms | The checker rejects fewer than two branches, a non-list argument, non-Schema branches, field descriptors, and forged union annotations. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Evaluation order | Branch expressions evaluate once, in source order. Construction does not decode, encode, or resolve a service. The emitted union keeps the source branch order. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Ordered backtracking | For untagged branches, the runtime tries candidates in source order. It returns the first successful decode or encode. A typed `SchemaIssue` from one candidate lets a later candidate succeed. If none succeeds, the runner fails with `SchemaError`. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Overlapping records | Branch order is observable. A shorter record Schema can drop fields before a later, longer record Schema runs. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Defects and interruption | Defects and interruption are not candidate failures. No other branch recovers them. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |

### Recursive Schema with separate wire types

| Rule | Choice | Evidence |
| --- | --- | --- |
| schemaRecursive signature | `schemaRecursive((self: Schema<D,E,RD,RE,M>): Schema<D,E,RD,RE,M> => body) : Schema<D,E,RD,RE,M>`. The builder is pure and inline. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Separate D, E, and M | D and E may be distinct data aliases. M keeps its own data-only shape and defaults to D. The body must fit the expected Schema on all axes. A four-argument or abbreviated annotation cannot replace E or M. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Self reference | Every self reference carries the same full signature: D, E, M, and directional services. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Finite guard | A self-recursive data alias needs an array, an optional key, or a tagged union with a terminal branch. Each of D, E, and M obeys the guard independently. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Tagged guard | The tagged guard needs the same distinct literal discriminator on decoded and encoded branches, plus a self-free terminal branch. Transformed or renamed discriminators are not supported. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |
| Untagged union guard | An untagged union does not supply a guard. Trying the self Schema as an immediate member would recurse without consuming input. The checker rejects it. | [2026-10-19-schema-general-union-contract.md](archive/plans/2026-10-19-schema-general-union-contract.md) |
| Self-use restrictions | The body root is `schemaStruct` or `schemaUnion`. A tagged root union with a self-free terminal branch guards the self references inside its other branches. An untagged root union supplies no guard, so each self reference beneath it needs an array, optional-key, or null-to-missing-key guard. Self-bearing paths use the structural builders, constructor-default wrappers, and the adapters listed under Recursive field adapters. Defaults cannot capture self. Constructor wrappers do not create a guard. Self-free leaf transformations stay allowed. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md), [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| Wire behavior | Wire decoding needs the complete E shape unless a wire adapter supplies a default. Constructors consume M and run no wire transformation. Nested issues keep field and array-index paths. Defects stay defects. Interruption waits for nested cleanup. | [2026-10-19-schema-recursive-wire-contract.md](archive/plans/2026-10-19-schema-recursive-wire-contract.md) |

### Recursive field adapters

| Rule | Choice | Evidence |
| --- | --- | --- |
| Adapter paths | Self may occur in these wrapped Schema arguments: `schemaNullToMissingKey`, `schemaDefaultKey` (all `on` values), `schemaOptionalTransform` (source and target), and `schemaOptionalFromRequired` (source and target). These add to the array, optional-key, struct, union, and constructor-default paths. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| Guards from adapters | Only `schemaNullToMissingKey` supplies a guard (an optional key on both sides). The other adapters supply none. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| No self capture | Default, getter, and option callbacks cannot capture self, also in a discarded local or nested closure. Binding identity decides a capture, so an unrelated local named `self` is allowed. A default callback may return a finite partial M and capture other values or effects. Expressions without `self` stay ordinary checked leaves. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| Builtin calls only | Source calls must resolve to the builtin. A shadowed function name gives no structural proof. Constructor-default wrappers stay transparent and their callbacks stay self-free. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| Unions beneath a guard | A union beneath an existing array, optional-key, or terminal-tagged guard carries that guard through every member. An exact optional wire field such as `next?: WireNode \| null` is valid. An unguarded nested union is invalid. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |
| Outside the subset | Not supported: recursive Option data, bare nullable recursive aliases, mutual recursion, callbacks as recursive guards, and arbitrary self-bearing transformations. These limits are for aliases. A data type follows the rule "Data type recursion". Ordinary self-bearing `schemaTransform` is excluded. | [2026-10-19-schema-recursive-adapters-contract.md](archive/plans/2026-10-19-schema-recursive-adapters-contract.md) |

## Diagnostics

### Diagnostic codes by phase

The registry in `src/core/diagnostics.ts` describes every code. This table lists which part of the implementation added each group of codes.

| Rule | Choice | Evidence |
| --- | --- | --- |
| Parser codes | The lexer and the parser report the `syntax` codes. The parser reads `.eff` source files and `.effi` host interface files | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Name and module codes | The project loader and module graph in `src/core/project.ts` report `module/001` to `module/003`. The name resolver in `src/core/resolve.ts` reports `unknown-name/001` to `/004` and `declaration/001` to `/004`. The declaration index reports nothing; it marks a declaration broken | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Declaration checker codes | The declaration checker reports `type-mismatch/001`, `type-mismatch/002`, `type-mismatch/003`, `type-mismatch/010`, and `declaration/005` to `declaration/016`. Decision D21 added `declaration/012` on 2026-10-17. Decision D26 added `declaration/013` on 2026-10-17. The data type plan added `declaration/014` and `declaration/015` on 2026-10-23. Item CM6 of the companion plan added `declaration/016` on 2026-10-23 | [2026-10-17-d21-d23.md](archive/plans/2026-10-17-d21-d23.md), [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [transpiler-design.md](transpiler-design.md) |
| Body checker codes | The body checker reports `type-mismatch/003` to `type-mismatch/012`, `failure-contract/001` to `/003`, `requirement-contract/001`, `execution-mode/001` to `/003`, and `pattern/001` to `/004` | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Project checker codes | The project checker in `src/core/check_project.ts` reports `module/004`, `execution-mode/003` for a recursive module-level function without explicit annotations, and `execution-mode/004`. The body checker reports `execution-mode/003` for a local function that refers to itself | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Host boundary code | The `deno check` mapping reports `host-boundary/001` | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Validator codes | The independent IR validator reports the category `validation` with the codes `validation/001` to `validation/008`. See the next section for the area of each code | [report.ts](../src/core/validate/report.ts) |
| Validation areas | `validation/001` is Identity, `002` Types, `003` Contracts, `004` Execution, `005` Recovery, `006` Control, `007` Initialization, and `008` Serialization | [report.ts](../src/core/validate/report.ts) |

### Independent validator

| Rule | Choice | Evidence |
| --- | --- | --- |
| One fault, one diagnostic | After a disagreement the validator continues with the recomputed value; for an unknown identity it continues with the recorded value | [validate/expr.ts](../src/core/validate/expr.ts) |
| Exact nodes | The recorded type equals the recomputed type for every node that is not listed as contextual below, including reference, get, update, error, brand, unbrand, call, perform, fail, retry, provide, binary, block, `defer`, `run`, `race`, and the scope, stream, sink, schedule, `Ref`, `Layer`, `Schema`, and fiber nodes | [validate/expr.ts](../src/core/validate/expr.ts) |
| Contextual nodes | For a literal, `None`, `Some`, `codec`, record, array, tuple, closure, `if`, `match`, and `catch`, the parts must fit the recorded type | [validate/expr.ts](../src/core/validate/expr.ts) |
| Type equality | Mutual assignability, so aliases are transparent and union order does not matter | [validate/typing.ts](../src/core/validate/typing.ts) |
| Record fields | Field order does not matter. The checker compares fields in order, which is safe because the type table interns every record with its fields sorted by name | [validate/typing.ts](../src/core/validate/typing.ts), [types.ts](../src/core/types.ts) |
| Effect sets | Comparison ignores order and duplicates; an unsorted or duplicated set gives only `validation/008`. This includes Schema decode and encode requirement sets | [validate/sets.ts](../src/core/validate/sets.ts), [validate/world.ts](../src/core/validate/world.ts) |
| Closures | The type sets contain the body sets; the mode is effect when a set is nonempty or the body is effect | [validate/expr.ts](../src/core/validate/expr.ts) |
| Function contracts | An inferred contract equals the body sets; an explicit contract contains them | [validate/expr.ts](../src/core/validate/expr.ts) |
| Identities | `<kind>:<module>#<name>` for declarations and `cap:<module>#<Service>.<method>` for capabilities | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Builtins | A builtin reference is valid only as a callee; the prelude import has a fixed shape | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Area of a branch fault | A `catch` branch is Recovery; an `if` or `match` branch is Types | [validate/expr.ts](../src/core/validate/expr.ts) |
| Not checked | Match exhaustiveness, unreachable arms, and constant initialization order stay with the checker | [validate/expr.ts](../src/core/validate/expr.ts) |
| Payload spans | A span in an import payload is checked only when the caller supplies its source text | [validate/serialization.ts](../src/core/validate/serialization.ts) |
| Unexpected shape | An exception inside a check gives `validation/008` and the next check runs. An exception while the validator builds its world ends the run with that one diagnostic | [validate/index.ts](../src/core/validate/index.ts) |

## Lowering, emission, and tooling

These rules concern the stages after checking. They do not change what a program means.

### Lowering

| Rule | Choice | Evidence |
| --- | --- | --- |
| Error construction | The argument must be a record literal without a spread (`type-mismatch/010`), because the IR `error` node lists its fields. A piped value is never a literal, so `x |> E` is also `type-mismatch/010` | [check_expr.ts](../src/core/check_expr.ts) |
| Pipeline stage sets | A stage call carries its arguments and its invocation only; the left value's sets sit on its `$p` binding | [lower_stage_effects_test.ts](../tests/lower_stage_effects_test.ts) |
| Control pipeline stages | `retry` with or without a schedule, `retrySchedule`, `provide`, `provideScope`, `addScopeFinalizer`, `closeScope`, `defer`, and `run` record their own active effects locally; the left value's evaluation stays on its binding | [lower_stage_effects_test.ts](../tests/lower_stage_effects_test.ts) |
| Pipeline binding names | `$p<n>` skips every `<n>` whose name an identifier of the module uses, so a source local `$p1` is not captured | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Prelude value names | `$builtin/<name>/<hash>`, the text after `#` in the id | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Declaration order in IR | Source order by span start | [api.md, Using the lowering](api.md#using-the-lowering) |

### Emission

| Rule | Choice | Evidence |
| --- | --- | --- |
| Pure-to-effect lift | A pure function fits an effect function type only directly in a value position; the emitter wraps it there. Nested in a record, array, option, tuple, union, Effect value, result, or parameter, the execution must match | [emit_lift_slot_test.ts](../tests/emit_lift_slot_test.ts) |
| Pure job of `retry`, `provide`, or `defer` | The emitter lifts it as in a value position: `Effect.suspend(() => Effect.succeed(x))` | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Hoisting | Trivial pure children stay inline: `null`, literals, references, `None`, closures, and a record, array, tuple, error, update, field read, brand, data construction, unbrand, or `Some` whose parts are trivial | [expr.ts](../src/core/emit/expr.ts) |
| Service method parameters | Named `a`, `b`, `c`, and `a26` onward past `z`, in emitted service shapes, because the IR has no parameter names | [types.ts](../src/core/emit/types.ts) |
| Reached declarations | Declarations that an exported signature reaches are exported in TypeScript, even when the source keeps them private | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Data type output | A data type prints as `export const User = Schema.TaggedStruct("<module>#<Name>", { fields })` and `export type User = typeof User.Type`. The tag has the same form as an error tag. An optional field uses `Schema.optionalKey`. Construction prints `User.make(value)`. `make` validates its input at run time | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [decls.ts](../src/core/emit/decls.ts) |
| Data value copy | `unbrand` of a data value prints `$untagged<T>(value)`. The helper copies the own fields, except `_tag`, into an object with no prototype. Another data type can then take the copy through `make`. A value that still has the `_tag` of another data type makes `make` throw | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [fields.ts](../src/core/emit/fields.ts), [expr.ts](../src/core/emit/expr.ts) |
| Recursive data output | Every declaration of a recursive group prints in an explicit form. A data type gives `interface T`, `interface TEncoded`, and a `TaggedStruct`. Each reference to the group in a schema is `Schema.suspend((): Schema.Codec<T, TEncoded> => T)`. An alias of the group gives `type L`, `type LEncoded`, and `const L: Schema.Codec<L, LEncoded>`. The order of the members does not matter | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md), [decls.ts](../src/core/emit/decls.ts), [types.ts](../src/core/emit/types.ts) |
| Data values at run time | Each data value carries `_tag`, and so does its encoded form. JSON without the tag fails to decode. To read such JSON, decode into a structural `type`, then call the constructor. Host TypeScript builds data values with `X.make` | [archive/plans/2026-10-23-nominal-data-types.md](archive/plans/2026-10-23-nominal-data-types.md) |
| Companion module | Each `.effi` file that a module imports gives a generated companion module next to it: `host.effi` gives `host.effi.ts` and its map. It holds the emitted form of each type, brand, data, error, and service declaration of the interface, and exports each one, also one without `export`. Each tag keeps the module name of the interface, as in `host#Token`. An opaque type has no code there, and the companion imports it as a type from the host module. An interface with only providers gives the header and `export {};` | [archive/plans/2026-10-23-host-interface-companion.md](archive/plans/2026-10-23-host-interface-companion.md), [emit.ts](../src/core/emit/emit.ts) |
| Host interface declarations | A source module imports each type, brand, data, error, and service of an `.effi` file from its companion module. So `.eff` code can construct an `.effi` data type or error. An opaque type is a type import from the host module, and a provider is a host alias. The host module imports its data types, errors, and services from the companion module and does not declare them. A host module that keeps its own copy of a service class still runs, because Effect keys a service by its tag string. `--tsc` reports the copy at the `$host` alias only when its shape differs from the companion class | [archive/plans/2026-10-23-host-interface-companion.md](archive/plans/2026-10-23-host-interface-companion.md), [scope.ts](../src/core/emit/scope.ts) |
| Value outside its type in a match | When the last arm of a `match` is not `_`, the emitted chain tests that arm too. A value outside the type, which only unsound host code can supply, calls `$unmatched`. It throws `TypeError: a match received a value outside its type`, which is a defect inside Effect code. A match whose last arm is `_` sends such a value to that arm | [archive/plans/2026-10-23-host-boundary-checks.md](archive/plans/2026-10-23-host-boundary-checks.md), [expr.ts](../src/core/emit/expr.ts) |
| Host provider checks | A host provider whose service methods return data values is wrapped once in each module. Each method result that contains a data type, and each element of a result `Stream` of such values, goes through `Schema.is` of its type. A failure throws `TypeError: host value of S.m does not match its type: <issue>`, which is a defect. These positions stay trusted: `Sink`, Effect values, functions, `Ref`, Fibers, opaque types, results without a data type, typed errors, and arguments that host code passes to source callbacks. An `Option` result must be a real `Option` value, and an optional field that is present with the value `undefined` fails. A provider without data results keeps the plain alias | [archive/plans/2026-10-23-host-boundary-checks.md](archive/plans/2026-10-23-host-boundary-checks.md), [decls.ts](../src/core/emit/decls.ts) |
| Generated header | Each file starts with `// Generated from <path>.eff by the Effective compiler. Do not edit.`, where the path is the root-relative source | [emit.ts](../src/core/emit/emit.ts) |

### Spans and formatting

| Rule | Choice | Evidence |
| --- | --- | --- |
| Position outside every record | Not mapped. The header, the imports, the helpers (including `$unmatched` and `$hostCheck`), the host check constants, the host assertions, and the blank lines lie outside every record. A position inside a declaration maps to that declaration at worst | [api.md, Using the span table and the source map](api.md#using-the-span-table-and-the-source-map) |
| Nested records | The innermost record wins. Of two records with one range, the record that closed first (the inner one) wins. Empty records are dropped | [spans.ts](../src/core/emit/spans.ts) |
| Positions in the API | `mapGenerated` takes a one-based line and column in UTF-16 units, as `tsc` and the diagnostic format do. `mapOffset` takes a zero-based offset | [api.md, Using the span table and the source map](api.md#using-the-span-table-and-the-source-map) |
| Source map targets | A generated position maps to the start of the source span of its innermost record, not to a range | [sourcemap.ts](../src/core/emit/sourcemap.ts) |
| Source map segments | One segment at each record start, each record end, and each generated line start. Consecutive segments with one target merge. An unmapped part after a mapped part gets a one-field segment | [sourcemap.ts](../src/core/emit/sourcemap.ts) |
| Source map fields | `names` is empty. `sources` are paths relative to the map. `sourcesContent` is optional. A missing source text is an error value | [sourcemap.ts](../src/core/emit/sourcemap.ts) |
| Source map comment | The emitted text ends with the line `//# sourceMappingURL=<file>.map`, for example `users.ts.map`, so that the written `.ts.map` file takes effect | [api.md, Using the span table and the source map](api.md#using-the-span-table-and-the-source-map) |
| Import span of a host assertion | The IR has no import span. The span is the imported name in the `.eff` import, for example `UsersLive`. `hostImportSpans(project)` reads it from the project index | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Host assertion range | The emitter records the whole statement of each assertion constant, including the wrapper of a checked provider. A `tsc` error anywhere in it is `host-boundary/001`. The check constants before it are outside the range | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Other `tsc` errors | No code is registered. The mapper returns `source` (the innermost source span, probably an emitter defect) or `generated` (no span table and no host module, or outside every record). The tool prints both as `TS<number>` | [api.md, Using the host-boundary mapping](api.md#using-the-host-boundary-mapping) |
| Output of `deno check` | The parser keeps the first line of each message and the first location of each diagnostic. Lines after the location, such as notes about related declarations, are dropped | [tsc.ts](../src/core/emit/tsc.ts) |
| Wrong host module | A host layer of the declared service tag that lacks a method fails inside the host module. The mapper returns `host-module`, and the tool prints it as `host-boundary/001` at that position | [api.md, Using the host-boundary mapping](api.md#using-the-host-boundary-mapping) |
| Own service class in a host module | `tsc` accepts a layer of a host-defined service class with fewer methods, because `Layer` is contravariant in its service. The fixture therefore changes the type of `find` as well | [users-live.ts](../fixtures/host-boundary/users-live-missing-method/users-live.ts) |
| Layout of an arrow chain | One line when it fits. Else the heads stay on the first line and the body moves down. Else the chain moves below `=` and the body moves down again. When the heads do not fit below the `=` either, each head gets a line of its own | [emit_test.ts](../tests/emit_test.ts) |
| Layout of a selector call | When the body of the selector arrow moves down, the arguments of the call get one more indent level | [conditional-chains.eff](../fixtures/emit/forms/conditional-chains.eff) |
| Function type parameters | A broken parameter list of a function type ends with a comma | [users.ts](../fixtures/golden/users.ts) |
| Layout of a binary run | A chain of one precedence level, such as `a && b && c` or `a + b + c`, is one unit. The operator ends the line. A break comes only where the next operand with its operator does not fit | [emit_test.ts](../tests/emit_test.ts) |
| Indent of a binary run | The lines after the first sit one level deeper. The body of an arrow and an element of an array add no level. A parenthesized operand breaks one level deeper than the line where it starts | [forms.eff](../fixtures/emit/forms/forms.eff) |
| Binary run in a conditional test | The lines of a broken first test sit two levels deeper than the line of the test, so one level deeper than `?`. As the body of an arrow they sit one level deeper. A later link of a chain follows the else-if rule below | [conditional-chains.eff](../fixtures/emit/forms/conditional-chains.eff) |
| Int arithmetic | Each `$int` call has one argument. The argument list breaks first. The operation inside the argument breaks after that | [forms.eff](../fixtures/emit/forms/forms.eff) |
| Layout of an else-if chain | A match with several arms prints `a ? x : b ? y : z`. A conditional in the else branch joins the chain. Every `?` and `:` of the chain sits at one indent level. The test of a later link sits two levels deeper than its `:` line | [emit_test.ts](../tests/emit_test.ts) |
| Last arrow argument with a moved body | When the body of the last argument arrow moves down, the closing parenthesis moves down with it | [api.md, Using the emitter](api.md#using-the-emitter) |
| Head with a broken parameter list | When a head cannot fit on a line, each head after the first starts a line at the indent of the chain. The first head stays after the `=`. The body stays on the last head line when it fits, else it moves down one level | [emit_test.ts](../tests/emit_test.ts) |
| Chain as a call argument | The call hugs a chain only when the heads fit on the line of the call. Else the arguments break, and the heads align as in a declaration | [forms.eff](../fixtures/emit/forms/forms.eff) |
| Long names and strings | Seven forms reach the fixed point when a name, a module path, or a string is long. A selector test of a match arm that is longer than 80 columns breaks after `===`, and the string sits two levels deeper than the test. When a test after the first does not fit on its own line, `deno fmt` joins the earlier links and the left side of the test on the first line. It does so only when that line fits in 80 columns. The printer joins at most one test, and not after a link with a hard line. An `if` chain follows the same rule for a comparison of two operands. A `&&` run does not join. When the first test of a flush `if` breaks, a comparison puts its right side two levels deeper, and a `&&` run one level. `Schema.Literal(` and `Schema.brand(` put a long string on a line of its own. A schema type alias moves `typeof X.Type` one level down. `Schema.TaggedStruct(` puts the tag and the field object on lines of their own when the call does not fit. A service class breaks before `extends` as an error class does, and its tag string breaks like an argument. The body of a `Service.use` arrow moves down with the closing parenthesis. A `catchTags` handler moves below its key when the head `"key": (e) =>` does not fit | [api.md, Using the emitter](api.md#using-the-emitter) |
| Extreme identifiers | `TaggedError` and service type arguments wrap when their heads do not fit. Initializers and arrows move below `=` when their openings do not fit. A broken field or parameter list can move a value below its label. Member calls break before a dot when their heads do not fit; qualified Schema calls can also break at the earlier dot. Optional reads use the ordinary call-argument layout. The regression checks 273 generated modules at wrapping boundaries, strict target types, runtime results, evaluation once and mapped source tokens. Identifier lengths alone do not determine the breaks; indentation, export prefixes and surrounding expressions also count | [2026-10-20-extreme-identifier-formatting.md](archive/plans/2026-10-20-extreme-identifier-formatting.md) |

### Program and CLI

| Rule | Choice | Evidence |
| --- | --- | --- |
| Check memo key | The key holds the module text, its path, the project configuration, the analysis diagnostics of its file, and the interface hash of each reached module. Every key holds the configuration, so a change of the host registry rechecks all modules | [api.md, Using the program](api.md#using-the-program) |
| Lowering key | The hash of the full interface payload of each reached module, spans included. IR imports carry the spans of foreign declarations | [api.md, Using the program](api.md#using-the-program) |
| Span-only change | When only the lowering key changes, the module is not checked again. The program builds its interface again from the reused declarations, and it lowers the module again | [api.md, Using the program](api.md#using-the-program) |
| Signature without an interface | A module whose interface is an error value uses a hash of its own key as signature | [db.ts](../src/core/db.ts) |
| Reached module not yet checked | In an import cycle, a reached module that comes later in the order counts as absent, as in `checkAnalysis` | [db.ts](../src/core/db.ts) |
| Intern table | One `TypeTable` for the life of the program. It only grows. The memory growth is measurement M4 | [api.md, Using the program](api.md#using-the-program) |
| Rechecked list | It names every module that was checked again, in topological order, and it includes `.effi` modules | [api.md, Using the program](api.md#using-the-program) |
| Lazy queries | IR, emitted text, span table, and source map are computed on first use and stored on the memo entry | [api.md, Using the program](api.md#using-the-program) |
| Config error in the program | `update` returns the error value and starts no revision. The files stay changed, and a later fix returns to the old memo | [db.ts](../src/core/db.ts) |
| Modules of a project | Every `.eff` file under the root. The walk skips directories that start with `.` and `node_modules`. `.effi` files come from `effective.json` | [api.md, Using the command line](api.md#using-the-command-line) |
| Exit codes | 0 without diagnostics, 1 with a diagnostic or a failed build step, 2 for a usage or configuration error, 3 for an internal error. A missing `effective.json` is a configuration error | [api.md, Using the command line](api.md#using-the-command-line) |
| Help | `--help`, `-h`, or `help` prints the usage on stdout and exits 0 | [api.md, Using the command line](api.md#using-the-command-line) |
| Output line | `path:line:column: error code: message`. A message with several lines prints as one line. Related spans are not printed | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Sort order | Path, then line, then column, then code, then message. With `--tsc`, the `deno check` lines follow these lines as a separate group | [format.ts](../src/cli/format.ts) |
| Summary line | The tool prints `N modules, M diagnostics` to stderr, with singular nouns for 1. N counts `.eff` modules. A build that changed files on disk adds `, wrote K files` | [report.ts](../src/cli/report.ts) |
| Written files | The tool writes a file only when its text differs from the file on disk | [api.md, Using the command line](api.md#using-the-command-line) |
| Validation failure | A module with a `validation` diagnostic is not written | [api.md, Using the command line](api.md#using-the-command-line) |
| Lowering or emit failure | A failure that is not a diagnostic of the module prints `error: ...` on stderr and gives exit code 1 | [outputs.ts](../src/host/outputs.ts) |
| `--tsc` after an error | The tool skips `deno check` when the build has a diagnostic or a failure, because the set of written files is incomplete | [api.md, Using the command line](api.md#using-the-command-line) |
| `--tsc` files | The files that this build produced, written or unchanged, plus the host modules of `effective.json` | [api.md, Using the command line](api.md#using-the-command-line) |
| `--tsc` configuration | A temporary directory with `deno.json`, removed after the run. The command has `--no-lock`. The project directory gets no new file | [api.md, Using the command line](api.md#using-the-command-line) |
| `--tsc` without a parsed diagnostic | If `deno check` exits nonzero and prints no diagnostic, the tool prints a note and exits 1 | [api.md, Using the command line](api.md#using-the-command-line) |
| Permissions of the task | `--allow-read --allow-write --allow-run=deno`. The tool needs no environment access | [deno.json](../deno.json) |
| Task directory | `deno task` runs in the repository root, so the default root `.` is the repository. Users pass a root | [api.md, Using the command line](api.md#using-the-command-line) |
| Watch events | The real source debounces events for 100 ms. It keeps `.eff`, `.effi`, and `effective.json` paths, and also the local target-check inputs: JavaScript, TypeScript, and JSON files, and files such as `deno.json` and `deno.lock`. It also yields an empty batch every second, so a missed event is caught by a rescan | [api.md, Using the command line](api.md#using-the-command-line) |
| Watch rebuild | Each batch rereads the root and gives the program the files that changed. A batch with no change prints nothing | [api.md, Using the command line](api.md#using-the-command-line) |
| Watch output | `rechecked: <modules>` and the summary go to stderr. With `--tsc`, a change to a target-check input alone prints `host inputs changed; rechecked: (none)` and the summary. Diagnostics go to stdout. Only a changed file starts a build | [2026-10-16-phase-a.md](archive/plans/2026-10-16-phase-a.md) |
| Internal error | An unexpected throw prints `effective: internal error: <message>` on stderr and gives exit code 3 | [api.md, Using the command line](api.md#using-the-command-line) |
| Watch errors | A broken project file at start gives exit code 2. A broken project file later prints an error and the loop goes on | [api.md, Using the command line](api.md#using-the-command-line) |
| Watch and `--tsc` | `watch --tsc` runs `deno check` after each build without errors | [cli_test.ts](../tests/cli_test.ts) |
| Public API | `src/core/mod.ts` re-exports the IR types with `export type *`. The explicit `Diagnostic` of the core wins over the one in `ir.ts` | [mod.ts](../src/core/mod.ts) |
| Error path in messages | A malformed `effective.json` is named `effective.json`, as `parseConfig` reports it. A missing or unreadable one is named with the root | [project.ts](../src/core/project.ts) |

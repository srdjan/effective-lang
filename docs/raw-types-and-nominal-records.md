# Assessment: primitives only inside type definitions (R1), and nominal records (R2)

Status: done, 2026-10-17. R1 and R2 are in release `v0.2.0` of this repository. Spec draft 0.2 describes both rules (commit `c93e2d3` in `/Users/srdjans/Code/effective`). The assessment below used this repository at commit `f755b3f`.

A Fable subagent reviewed the first draft. Opus accepted all 13 findings.

## 1. R2: nominal records (done)

R2 makes a record type nominal when its author writes it as a brand of a record:

```
type User = Brand<{ id: UserId, name: string, active: boolean }>
```

A program constructs a value with `User({ ... })`. A plain record literal does not fit `User`. A field read `user.name` reads the field of the base record. A record update `{ ...user, active: true }` keeps the type `User`. Two record types with identical fields stay distinct when one of them is a brand.

The user chose these points on 2026-10-17. The plan is `docs/plans/2026-10-17-r2-nominal-records.md`. Commit `0a3722c` implements it. Before that commit, the construction, `unbrand`, and the nominal mismatch worked already. The checker rejected only field reads and record updates through the brand.

Commit `f755b3f` fixed an older emitter fault that the R2 review found. A read of an optional field through a union, such as `(a: A | B).nickname`, printed a plain read. `deno check` rejected the result. A read of an optional error field had the same fault.

These items stay open after R2:

- The spec text in `/Users/srdjans/Code/effective` did not describe a field read or an update through a brand of a record. Spec draft 0.2 added this text.
- A `match` with a record pattern on a record brand gives `pattern/004`. A record brand as the operation record of `withResource` is rejected. The ledger `docs/phase-a-rules.md` names both as unsupported.

## 2. R1: the rule

The user chose these points on 2026-10-17:

1. A primitive type is `string`, `int`, `number`, `boolean`, or a literal type such as `"paid"` or `1`.
2. A primitive type can occur only inside the body of a `type` or an `error` declaration.
3. `void`, `never`, and `unknown` are exempt.
4. `Option<T>`, `T[]`, tuples, and function types stay allowed outside type definitions when their parts are named types.

So these forms are accepted:

```
type UserId = Brand<string>
type Name = string
type Amount = int
type Status = "pending" | "paid"
type User = Brand<{ id: UserId, name: Name, status: Status }>
error UserMissing = { id: string }

export const rename = (id: UserId, name: Name): User fails UserMissing => ...
service Payments { charge(amount: Amount): Receipt fails Declined }
const log = (message: Message): void => ...
```

These forms are rejected:

```
export const rename = (id: string, name: string): User => ...      // two parameters
export const total = (amounts: int[]): int => ...                  // int[] and int
service Users { find(id: string): Option<User> }                   // a service parameter
export const findNick = (user: User): Option<string> => ...        // Option<string>
export const limit: int = 10                                       // a constant annotation
export const apply = (f: (n: int) => Amount): Amount => ...        // inside a function type
```

R1 only rejects programs. It adds no new form and changes no meaning of an accepted program.

Point 4 does not name every type form. The parser and the checker also accept `Effect<T, ...>`, `Stream<T>`, `Sink<A, In>`, inline record types such as `(p: { name: Name })`, and inline unions in signatures. Decision D31 asks whether these forms stay legal when their parts are named types.

## 3. Measured migration size

A script parses every `.eff` and `.effi` file with `parse` from `src/core/parse.ts`. It counts the primitive type nodes outside type and error bodies, by position. A primitive inside a type argument, for example `Option<string>` or `Effect<int>`, counts under the position of the enclosing type. The script is `/tmp/rules-probe/count/count.ts`. A hand count of the five examples gives the same numbers as the script.

Correction, 2026-10-17: an earlier version of the script counted a primitive in a function type inside a type declaration as a use outside. It gave 33 uses in function types and a total of 609. The fixed script gives 19 and 595.

| Position | `fixtures/examples/` (6 files) | All of `fixtures/` (84 files) |
| --- | --- | --- |
| Module function parameter | 6 | 252 |
| Module function result | 5 | 259 |
| Service method parameter or result | 4 | 34 |
| Inside a function type | 0 | 19 |
| Module constant annotation | 0 | 11 |
| Local function parameter | 0 | 10 |
| Local constant annotation | 0 | 7 |
| Local function result | 0 | 3 |
| Literal type, any position | 0 | 0 |
| Total outside type definitions | 15 (5 files) | 595 (64 files) |
| For comparison: inside type and error bodies | 13 | 155 |

R1 rejects 5 of the 6 example files and 64 of the 84 fixture files. Of the 64 files, 45 are in `fixtures/errors/`, 7 in `fixtures/emit/`, 6 in `fixtures/parse/`, 5 in `fixtures/examples/`, and 1 in `fixtures/ir/`. The files in `fixtures/errors/` exist to cause other diagnostics. So the fixture count is not a measure of real user code. No real user code exists to measure.

Test programs in TypeScript strings are not in the table. The pattern `:\s*(string|int|number|boolean)\b` matches 836 lines in 36 files in `tests/`. This number is an estimate, because the pattern also matches TypeScript lines. The largest files are `tests/check_body_test.ts` and `tests/validate_test.ts`.

## 4. Effect on each stage

| Stage | Effect of R1 |
| --- | --- |
| Lexer, parser | None |
| Resolver | None. A primitive name resolves to a builtin type, as it does now |
| Declaration and body checker | One new check. It reports each primitive type node outside a type or error body. It can use the syntax tree and the resolution table only, because it needs no type information. A new code is needed (decision D30) |
| Interface and hash | None. An accepted program has the same interface as before |
| Lowering, IR, validator | None. The IR keeps alias names, and the validator does not check source rules |
| Emitter | None. Each new alias of a primitive emits two more lines, for example `export const Name = Schema.String;` and `export type Name = typeof Name.Type;` |
| Golden files | All six change: the five examples and `traverse.ts`, which comes from `fixtures/emit/traverse/traverse.eff` |
| LSP and VS Code client | None. The new diagnostic flows through `publishDiagnostics` |
| Playground | `playground/build.ts` reads the example tabs from `fixtures/examples/`, so they change with the examples |
| Bench | `bench/generate.ts` writes primitives in signatures of every generated module, for example `calc<n> = (x: int, y: int)`, `charge(amount: int): string`, and `export const extra: int = 1`. The `header` edit toggles `extra` between `int` and `number`, so it must toggle between two named types. Probably no bench row then stays comparable with the D9 evidence of 2026-10-16. A new baseline run can confirm this |
| Spec | Every spec section with a signature changes, and the `type` production of "Surface grammar" too. Examples are "A first example", "Functions and blocks", "Services and contracts", "Pipelines and collections", "Pattern matching", "Failure and recovery", and "Modules and boundaries" |

`.effi` files accept `type` and `error` declarations (`fixtures/parse/ok-forms.effi`). So a host author can declare the names that R1 needs in the host file itself.

## 5. Risks

The user said on 2026-10-17: "it is important that we support nominal types". R1 gives names, but a name is not identity. `type Name = string` and `type Email = string` are aliases, and the spec says that aliases use structural compatibility. So a `Name` fits where an `Email` is expected. Only a brand gives identity, as R2 shows for records.

A brand of a primitive needs more code in each body. A probe (`/tmp/rules-probe/plus`) shows that `+` rejects a brand: `Name + Name` and `Count + 1` give `type-mismatch/007`. Equality `===` accepts two values of one primitive brand. So a program with branded numbers or strings needs an `unbrand` call and a brand call around each arithmetic or string operation.

R1 makes small programs longer. The `log.eff` example has two uses of `string` in signatures, `print(message: string)` and `log = (message: string)`. Both need a declaration such as `type Message = string`. The growth on real programs needs to be measured.

## 6. Decisions for R1

D26. What satisfies R1 for a primitive?

- (a) Any type declaration: an alias such as `type Name = string`, or a brand. Recommended. R1 is then a naming rule. Identity stays an explicit choice with `Brand<T>`, as for records in R2. This option does not by itself serve the nominal priority, because an alias has no identity. It costs no `unbrand` calls.
- (b) Only a brand, in every position. Every primitive outside a type definition then has identity. The cost is an `unbrand` call and a brand call around each arithmetic and string operation (section 5).
- (c) A brand in exported signatures and in service methods, and an alias elsewhere. Identity then holds across module boundaries, where a mix-up is hardest to find. The examples show the cost: `total(amounts: Amount[]): Amount` in `collections.eff` sums with `+`, so its body needs `unbrand`.

I recommend (a) because (b) and (c) make arithmetic and concatenation on branded values verbose, and D32 can remove that cost later. If you choose D32 (b) or (c), then D26 (c) becomes the stronger choice for the nominal priority.

D27. Which positions does R1 cover?

- (a) Every position outside type and error bodies, local annotations included. Recommended. The rule text stays one sentence, and the local positions add only 20 of the 595 uses.
- (b) Only module-level declarations and service methods, which form the module interface. Local function parameters, local results, and local constants stay free.

D28. Does R1 apply to `.effi` host interface files?

- (a) Yes, with the same rule. Recommended. A service method has the same syntax in both file kinds, and `.effi` files can declare the needed types (section 4).
- (b) No. Host files keep primitives, so host authors write less.

D29. How does R1 reach the code?

- (a) Always on. One plan migrates the examples, the fixtures, the tests, the bench generator, and the golden files. Recommended, because a language rule must not depend on a project setting.
- (b) A project setting in `effective.json`, off by default. Old projects keep working, but the language then has two dialects.

D30. Which diagnostic code does R1 use?

- (a) `declaration/013`, with the message "the primitive type `string` can occur only inside a type or error declaration". Recommended. R1 is a rule about where a type is declared, like `declaration/008` for `Brand<T>`.
- (b) A new category, `raw-type/001`.

D31. Do other type forms stay legal in signatures when their parts are named types?

- (a) Yes. R1 checks only primitive leaves. So `Effect<Amount>`, `Stream<Amount>`, `(p: { name: Name })`, and `(s: Status | Code)` stay legal. Recommended. The count script uses this reading, and the rule stays about primitives only.
- (b) No. R1 also rejects an inline record type and an inline union in a signature. The author must declare them as named types.

D32. Do operators accept a primitive brand?

- (a) No change. `+`, `-`, `*`, `/`, `<`, `<=`, `>`, and `>=` reject a brand, as they do now. Recommended for R1 alone, because D26 (a) needs no change.
- (b) The comparisons `<`, `<=`, `>`, and `>=` accept two values of one numeric brand, as `===` does now. Arithmetic still needs `unbrand`.
- (c) The comparisons, and `+` and `-` on two values of one brand. The result has the same brand. `*` and `/` still need `unbrand`, because the product of two amounts is not an amount.

## 7. Decisions taken

The user answered on 2026-10-17. D26 to D31 take option (a). D32 takes a revised option (c2): the comparisons, and `+` and `-` on two values of one numeric brand. A numeric brand has the base `int` or `number`. String brands still need `unbrand` for concatenation. A literal operand still needs the brand call, as in `count + Count(1)`.

The user first preferred D32 (c) for every brand. Opus showed that (c) gives a wrong type with no diagnostic for `UserId + UserId` and `OrderNumber + OrderNumber`. Option (c2) removes the string case and needs no new syntax. `Timestamp - Timestamp` stays a `Timestamp`, which is no worse than a plain `int`.

## 8. Next action

None. The R1 plan is `docs/plans/2026-10-17-r1-and-brand-operators.md`, and release `v0.2.0` contains its implementation. Spec draft 0.2 describes R1, R2, and the numeric brand operators. The spec also states the two unsupported cases of section 1 as exclusions of version 0. A change to either exclusion is a new language decision for the user. On 2026-10-17 the user chose to keep both exclusions.

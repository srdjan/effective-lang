# Plan: brand operators (D32) and primitives only inside type definitions (R1)

Status: validated, 2026-10-17. Fable validated the first draft and reported 4 major and 4 minor findings. Opus accepted all 8. Section "Validation findings" maps each finding to its resolution. Source: `docs/raw-types-and-nominal-records.md` and decisions D26 to D32 in `docs/transpiler-design.md`.

The work has two parts. Part 1 (D32) is small and comes first. Part 2 (R1) is a small check and a large migration. Each part ends in its own commits. `deno task check` must pass at each commit.

## Part 1: operators on numeric brands (D32, option c2)

### Rule

A numeric brand is a brand declaration whose base, after aliases, is the primitive `int` or `number`. A brand of a literal union or of another brand is not numeric.

1. `<`, `<=`, `>`, and `>=` accept two operands of one numeric brand. The result is `boolean`.
2. `+` and `-` accept two operands of one numeric brand. The result has that brand type.
3. `*` and `/` reject a brand, as now.
4. A brand and a plain number, two different brands, and a string brand are rejected with `type-mismatch/007`, as now. So `count + 1` stays an error, and the program writes `count + Count(1)`.
5. `===` and `!==` do not change. They accept one primitive brand already.

An operand counts as a brand only when its type, after aliases, is the named brand itself. A union is not a brand operand.

### Changes

P1-C1. Checker, `binary` in `src/core/check_expr.ts`. Add a private helper `numericBrand(ref: TypeRef): TypeId | undefined`. It calls `this.table.unfold(ref)`, then `this.table.node(...)`. When the node is `named`, and `this.table.brandBaseOf(id)` gives a base whose unfolded node is the primitive `int` or `number`, it returns the id. `isNumeric` is false for a brand, so the brand test can come before or after it. In the comparison cases, accept when `isNumeric` holds for both operands, or when both operands give one equal `numericBrand`. In the `default` case, before the numeric test, when the operator is `+` or `-` and both operands give one equal `numericBrand`, finish with `this.table.named(id)`. Use the existing constructor of a named type; read how `brandConstruction` builds its result type.

P1-C2. Validator, `binary` in `src/core/validate/expr.ts`. Add the same rule with `env.brands` in `src/core/validate/typing.ts`, as a new exported function `numericBrandOf(env, type)`. The result type of `+` and `-` is `{ kind: "named", id }`. It uses `unfold`, `env.brands.get(id)`, and `unfold` of the base. In `binary`, the brand test must come before the `isNumeric` test and the mismatch, else a valid program gets `validation/002`. Keep the validator independent: no import from the checker.

P1-C3. Emitter, `binary` in `src/core/emit/expr.ts`. When the operator is `+` or `-` and `e.type` resolves to a named brand with a numeric base, print `<Brand>.make(<sum>)`. Find the brand with `this.scope.resolve(e.type)`, then `this.scope.typeLevelDeclaration(id)` with `definition.kind === "brand"`, then `this.scope.resolve(definition.base)` and `isIntType` (`src/core/emit/scope.ts`). Get the brand name with `this.scope.nameOf(id)`, as the `brand` case does. When the base is `int`, the sum inside is `$int(a + b)`, as `isIntType` arithmetic prints it now (decision D14). So the result is `Count.make($int(a + b))`. When the base is `number`, the result is `Amount.make(a + b)`. Comparisons need no change, because TypeScript compares branded numbers.

P1-C4. Docs. Add one row to the A3b table of `docs/phase-a-rules.md`, after the "Record brand" row: "Brand operators | D32: `<`, `<=`, `>`, `>=`, `+`, and `-` accept two values of one numeric brand. `+` and `-` give the brand. The emitter prints `<Brand>.make(...)`, with `$int` inside for a brand of `int`. The spec gives `+` and `-` numeric operands only and names brands only for equality, so this row extends the spec." Change the "Equality" row only if its text conflicts.

### Tests

Write every new test program in R1 form already: no primitive outside a type or error body. Declare aliases such as `type Int = int` at the end of the program.

P1-T1. `tests/check_body_test.ts`: `type Count = Brand<int>`, `type Price = Brand<number>`, `type Name = Brand<string>`. Accepted: `a + b`, `a - b`, `a < b`, `a >= b` on two `Count` values, and on two `Price` values. The body table gives the type `Count` for `a + b`. Rejected with `type-mismatch/007`: `a * b`, `a / b`, `a + 1`, `count + price`, and `name + name`.

P1-T2. `tests/validate_test.ts`: the accepted program lowers and validates with no diagnostic. One mutation: change the recorded type of `a + b` to `int`, and expect `validation/002`.

P1-T3. New forms module `fixtures/emit/forms/brand-operators.eff` with an `int` brand and a `number` brand. Add it to `buildForms` and to the sorted list of the fmt fixed-point test in `tests/emit_slow_test.ts`, and change `Checked 6 files` to `Checked 7 files`. A fast test in `tests/emit_test.ts` asserts on the exact substrings `Count.make($int(` and `Price.make(`. Read the real output first.

P1-T4. A runtime test in `tests/emit_slow_test.ts`, in the style of the existing runtime tests. A function adds two `Count` values near `Number.MAX_SAFE_INTEGER` and must end in a defect, as plain `int` arithmetic does. A second call adds two small values and prints the sum.

### Commit

"Accept comparisons and addition on two values of one numeric brand".

## Part 2: primitives only inside type definitions (R1)

### Rule

These decisions come from the user (D26 to D31):

1. A primitive type node is a named type that resolves to the builtin type `string`, `int`, `number`, or `boolean`, or a literal type node.
2. Each primitive type node outside the body of a `type` or an `error` declaration gives `declaration/013` on its span. The message is "the primitive type `<text>` can occur only inside a type or error declaration", where `<text>` is the source text of the node.
3. The rule covers every position: parameters, results, service methods, constant annotations, local annotations, function types, and type arguments.
4. The rule covers `.eff` and `.effi` files.
5. `void`, `never`, `unknown`, and every other type form are not primitive type nodes. So `Effect<Amount>`, `(p: { name: Name })`, and `Status | Code` stay legal.

### Changes

P2-C1. Register `declaration/013` in `src/core/diagnostics.ts`, with a description in the style of the other codes.

P2-C2. In `ModuleChecker.run` (`src/core/check.ts`), add a pass `checkPrimitivePositions()`. It walks every node of the module tree. For a `NamedType` node, it reads the resolution target of its name node from `this.env.targets`. It reports when the target is `{ kind: "builtin-type" }` with a name in the four primitives. For a `LiteralType` node, it reports. It skips a node with a `TypeDecl` or `ErrorDecl` ancestor. It also skips a node inside a `SyntaxKind.Error` region, because the parser reported that region already. It reports inside a declaration with the `broken` flag, because the annotation parsed. The ledger row states this. Read how `NamedType` keeps its name child, and how the resolver records the target (`src/core/resolve.ts`, the `builtin-type` case). The pass needs no type information.

P2-C3. Decide the place of the diagnostic by reading the code: the declaration diagnostics of the module, in the sorted list that `checkModuleDeclarations` returns. The program memo, the LSP, and the CLI then show it with no change.

### Migration

The migration makes every program valid under R1. An alias is valid before R1 too, so the migration commits pass under the current compiler.

Convention for test programs and fixtures that are not examples: declare the needed aliases at the end of the program, so earlier lines keep their numbers. Use the names `Int = int`, `Num = number`, `Text = string`, `Bool = boolean`. Use a literal alias, such as `type Paid = "paid"`, for a literal type. When a program already declares one of these names, pick another name. Replace each primitive outside a type or error body with its alias. Do not change anything else in the program.

Convention for the examples: use domain names. The examples are the language showcase and the playground tabs.

| File | Declarations |
| --- | --- |
| `fixtures/examples/users.eff` | `export type UserId = string`, `export type Name = string`. `find(id: UserId)`, `getUser(id: UserId)`, `rename(id: UserId, name: Name)`, `displayName(id: UserId): Name`, `activeNames(): Name[]` |
| `fixtures/examples/main.eff` | Import `Name` from `./users.eff`. `main = (): Name` |
| `fixtures/examples/log.eff` | `type Message = string`. `print(message: Message)`, `log = (message: Message)` |
| `fixtures/examples/pay.eff` | `type Cents = int`, `type ChargeId = string`. `charge(amount: Cents): ChargeId` |
| `fixtures/examples/collections.eff` | `type Name = string`, `type Amount = int`. `activeNames(users: User[]): Name[]`, `total(amounts: Amount[]): Amount` |
| `fixtures/emit/traverse/traverse.eff` | `type Count = int`. `next(n: Count): Count`, `sequence(xs: Count[]): Count[]`, `raised(xs: Count[]): Count[]` |

Field types inside the record declarations stay primitive, because they are inside type bodies. Place the new declarations at the top of each example, before the first use, for the reader. The golden files and the expected positions of example tests change with this.

Migration scope:

- Every `.eff` and `.effi` file that the checker sees: `fixtures/examples/`, `fixtures/ir/`, `fixtures/emit/`, `fixtures/host-boundary/`, and `fixtures/errors/` except single files whose names start with `syntax-`. Do not change `fixtures/parse/` and the `syntax-` error files, because only the parser reads them (`tests/fixtures_test.ts`). In `recovery-*` inputs an appended alias would land inside an unclosed construct.
- `fixtures/ir/example/log.eff` is a copy of `fixtures/examples/log.eff`. Migrate it identically. `tests/lower_test.ts` compares its lowering with `fixtures/ir/example/log.ir.json`, and no script writes that file. Write it again with a one-off run of `lowerModule` and `serializeModule`, with the source identifier replaced by `log.lft` as `tests/lower_test.ts` does it. Then run `deno task validate:update`, because `scripts/validate_fixtures.ts` derives the mutation fixtures from `examples/log.eff`.
- Every Effective program in a string in `tests/`. With P2-C2 in place, a failing test with `declaration/013` marks each program that needs the change.
- `bench/generate.ts`. The generator must write R1-valid modules: the base module (`charge(amount: int): string`), `link<n>`, `calc<n>`, `rec<n>`, `bump`, `flip`, and `extra`. The `header` edit toggles `export const extra: int = 1` and `number`. Change it to toggle between two aliases, `Int` and `Num`, declared in the generated module. Three edit functions match source text with a regular expression: the `header` edit, `applyBodyEdit`, and `applyModeFlipEdit` (both match `(n: int): int`). Change all three. Update the literal assertions in `tests/bench_generate_test.ts` and `tests/db_test.ts`, and the `header` row of the README table "The edit script". The interface hash still changes on each `header` edit, because the constant type is a different named type. `tests/bench_generate_test.ts` checks that the importer is checked again.
- The playground examples come from `fixtures/examples/`, so they need no separate change. Its tests must pass.

A test can assert text or structure that names a type. After the migration it names an alias where it named a primitive. This holds for diagnostic messages (`argument 1 has type Text`), hover and backend strings (`tests/editor_test.ts`, `tests/lsp_features_test.ts`), emitted TypeScript substrings (`tests/emit_test.ts`), and IR shapes (`{ kind: "primitive" }` becomes `{ kind: "named", id: "type:m#Int" }` in `tests/check_test.ts` and `tests/lower_test.ts`). Update an expected value only when the only change is the alias in place of the primitive. Report each other change to Opus. When a test exists to check a primitive itself, for example `int` to `number` subtyping or the `$int` placement, the alias keeps the meaning, because an alias is transparent.

### Tests for the rule

P2-T1. `fixtures/errors/declaration-primitive-position.eff`: one marker for each position kind (a module parameter, a module result, a service method parameter, a constant annotation, a local parameter annotation, a function type parameter, `Option<string>`, and a literal type in a signature). The same file has a valid part: aliases, a brand, an error with primitive fields, and `void`, `never`, `unknown` in signatures.

P2-T2. `fixtures/errors/declaration-primitive-position.effi` or a project directory with an `.effi` host file whose service method has a primitive parameter. Read the README convention for host interface error fixtures first.

P2-T3. A new file, `tests/check_primitive_position_test.ts`: one test through the public entry that checks the exact message text of `declaration/013` for `string`, and that a node inside a type body gives no diagnostic.

### Order and commits

1. Implement P2-C1 to P2-C3 and P2-T1 to P2-T3. Do not commit yet. Run `deno task test` to get the list of failing tests.
2. Migrate the fixtures, the examples, the test programs, and the bench generator. Run `deno task golden:update`.
3. Commit the migration without the rule files. The rule files are `src/core/diagnostics.ts`, `src/core/check.ts`, the new fixtures of P2-T1 and P2-T2, `tests/check_primitive_position_test.ts`, `README.md`, and `docs/phase-a-rules.md`. No migration edit may go into these files. Before the commit, set the rule files aside with `git stash push -u -- <paths>`, so that untracked files go too. Run `deno task check` to prove that the migration passes under the old compiler. Commit the migration: "Name every primitive in a signature for R1". Then restore the rule files with `git stash pop`.
4. Commit the rule: "Reject a primitive type outside a type or error declaration". Include the README and the ledger updates.

### Docs

P2-D1. README, "Using the declaration checker": one sentence for R1 and the new code. The status paragraph of part A3a lists codes `declaration/005` to `declaration/012`; add `declaration/013` with "Decision D26 added `declaration/013` on 2026-10-17".

P2-D2. `docs/phase-a-rules.md`, A3a table: one row "Primitive positions" with the rule details: the four primitives and literal types, every position, both file kinds, the skip inside parser error regions.

## Out of scope

- The spec text in `/Users/srdjans/Code/effective`. The user owns it.
- Brand operators for string brands, `*`, `/`, and a literal operand that takes the brand of the other operand. D32 rejects them.
- Re-running the bench baseline for D9. The report names it as a user step.

## Verification

Opus runs these commands after each part, from the repository root:

1. `deno task check`.
2. `deno task golden:update`, then `git diff --stat fixtures/golden` (Part 2 changes all six golden files; Opus reads the diff).
3. Part 2 only: `deno run -q --allow-read /tmp/rules-probe/count/count.ts "$PWD/fixtures"` prints a `FILE` line for each file with a use outside type definitions. Each listed file must be in `fixtures/parse/`, a `syntax-` error file, or the new fixtures of P2-T1 and P2-T2.
5. Part 2 only: `deno task test` passes `tests/lower_test.ts` with the new `log.ir.json`, and `deno task validate:update` gives no further diff.
4. Part 2 only: `deno task effective build fixtures/examples --validate --tsc` in a copy of the examples in `/tmp`, so that no generated file lands in the repository. It must give 0 diagnostics.

## Validation findings

| Finding | Severity | Resolution |
| --- | --- | --- |
| F1: `fixtures/ir/example/log.eff`, `log.ir.json`, and `fixtures/validate/` are not in the migration | Major | Accepted. The migration names them, and Verification step 5 checks them |
| F2: bench edits and literal assertions beyond the `header` edit | Major | Accepted. The bench item names all three regular expressions, the generated declarations, the assertions, and the README row |
| F3: expected text changes in hover, backend, emitted TypeScript, and IR shapes | Major | Accepted. The update rule covers all four kinds |
| F4: `git stash` leaves untracked files, and P2-T3 shared a file with migration edits | Major | Accepted. `git stash push -u`, and P2-T3 has its own file |
| F5: parse-only fixtures need no change | Minor | Accepted. They are excluded, and Verification step 3 allows them |
| F6: API details for the implementer | Minor | Accepted. P1-C1 to P1-C3 name the functions |
| F7: R1 inside a `broken` declaration | Minor | Accepted. R1 reports there |
| F8: the spec names brands only for equality | Minor | Accepted. The P1-C4 row says that D32 extends the spec |

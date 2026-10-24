# Plan: R2, nominal records through `Brand<{ ... }>`

Status: validated, 2026-10-17. Fable validated the first draft and reported 2 major and 4 minor findings. Opus accepted all 6. Section 9 maps each finding to its resolution.

## 1. Rule

The user decided these points on 2026-10-17:

1. A record type is nominal when its author writes it as a brand of a record, for example `type User = Brand<{ id: UserId, name: string }>`. A field named `id` has no special meaning.
2. A program constructs a value with a call, `User({ id, name, active })`, as it does for errors and for brands of primitives. A plain record literal does not fit `User`.
3. A field read `user.name` reads the field of the base record.
4. A record update `{ ...user, active: true }` keeps the identity of the base. The result type is `User`.

Two record types with identical fields stay distinct when one of them is a brand. `activate(dog)` with `dog: Dog` and `activate(user: User)` gives `type-mismatch/003`.

## 2. Evidence: what works today

Probes ran on commit `3307c4d` in `/tmp/rules-probe/`.

These forms already work, and `build --validate --tsc` gives 0 diagnostics:

- `type User = Brand<{ ... }>`. The emitter prints `Schema.Struct({...}).pipe(Schema.brand("main#User"))`.
- `User({ ... })`. The emitter prints `User.make({ ... })`.
- `unbrand(user)` to a structural record type with equal fields, and `User(unbrand(user))`.
- A record brand as the type of an error field.
- The nominal rejection: `activate(dog)` gives `type-mismatch/003`. A plain record literal as the result of a function with the result `User` gives `type-mismatch/003`.

These forms fail:

- G1 (field read): `user.name` gives `type-mismatch/006: a value of type User has no fields`. So `match user.nickname { ... }` fails too.
- G2 (record update): `({ ...user, active: true })` gives `type-mismatch/005: a record update needs a record, but the base has type User`.

The Effect 4.0.5 probe: `deno check` with strict settings accepts `user.name`, `Option.fromUndefinedOr(user.nickname)`, and the plain spread `({ ...user, active: true })` as a `User`. The spread keeps the brand in the TypeScript type. `deno check` rejects a `Dog` where a `User` is expected. So the emitted update needs no `User.make` call.

## 3. Cause

Four lookups find the fields of a record type. Each lookup stops at a brand:

| Stage | Function | File |
| --- | --- | --- |
| Checker | `recordFields` (used by `readField` and `recordUpdate`) | `src/core/check_expr.ts` |
| Validator | `fieldsOf` (used by `get` and `update`) | `src/core/validate/typing.ts` |
| Emitter | `fieldType` (expected type of a replaced field) | `src/core/emit/expr.ts` |
| Emitter | `isOptionalField` (`Option.fromUndefinedOr` on an optional field read) | `src/core/emit/expr.ts` |

The emitter faults are not visible yet, because the checker rejects the forms first. When the checker accepts them, an optional field read through a brand prints `user.nickname` without `Option.fromUndefinedOr`, and `tsc` rejects it.

## 4. Changes

C1. Checker. In `recordFields`, after the record and error cases, add a brand case. When the unfolded node is `named`, and `this.table.brandBaseOf(node.id as TypeId)` returns a base, return `this.recordFields(base)`. The recursion ends, because the checker rejects recursive type declarations, and `declaration/012` caps the depth. Do not change `recordTarget`. It must not see through a brand, because a plain record literal must not fit a record brand.

`recordUpdate` already returns `base.type`, so an update of a `User` has the type `User` after C1. `readField` already flattens unions of the read value, so `(a: User | Dog).name` works when each member has the field.

C2. Validator. Give `fieldsOf` a third parameter, `depth = 0`. Return `undefined` when `depth > MAX_DEPTH` (`src/core/validate/typing.ts`, the constant that `comparisonClass` uses). When the unfolded type is `named`, return `env.errors.get(id)` if it exists. Else, when `env.brands.get(id)` gives a base, return `fieldsOf(env, base, depth + 1)`. The bound matters, because the validator reads IR directly, and a mutated IR can have two brands whose bases name each other. The validator keeps its own code and imports nothing new (the import test in `tests/validate_test.ts` checks this). `update` in `src/core/validate/expr.ts` already returns `base.type`.

C3. Emitter. Add one private method in `src/core/emit/expr.ts`, `recordFieldsOf(type)`. It calls `this.scope.resolve(type)`. A record gives its fields. A `named` type whose declaration (`this.scope.typeLevelDeclaration(id)`) is a type with `definition.kind === "brand"` gives `recordFieldsOf(definition.base)`. Anything else gives `undefined`. Use it in `fieldType` and in `isOptionalField`. Keep the depth bound of 64 that `resolve` uses, as a counter parameter.

C4. Rules where the spec is silent. Add one row to the table "Expressions, modes, and contracts (A3b)" of `docs/phase-a-rules.md`:

| Record brand | A field read and a record update see through a brand whose base is a record, after aliases. The update keeps the brand type. A record literal does not fit a record brand; the program calls the brand. A brand whose base is a union has no fields. A match with a record pattern on a record brand, and a record brand as a `withResource` operation record, stay unsupported |

C5. README. In "Using the body checker", add one sentence after the paragraph about facts: "A field read and a record update see through a brand of a record type, and an update keeps the brand."

## 5. Tests

T1. `tests/check_body_test.ts`, one test through `checkText`. The program declares `UserId = Brand<string>`, `User = Brand<{ id: UserId, name: string, active: boolean, nickname?: string }>`, and a structural `Dog` with the same fields. It checks:

- `nameOf = (user: User): string => user.name` gives no diagnostic.
- `nick = (user: User): string => match user.nickname { Some(n) => n, None => "none" }` gives no diagnostic.
- `activate = (user: User): User => ({ ...user, active: true })` gives no diagnostic, and the update node has the type `User`. Read the type from the body table through `fn(project, "m", "activate")`, as the other tests in the file do. Do not assert on a `typeAt` string without reading the real output first.
- A second program with `activate(dog)` gives exactly `["type-mismatch/003"]`.
- A third program with `({ ...user, owner: "x" })` gives `type-mismatch/005` (no such field).

T2. Error fixture `fixtures/errors/type-mismatch-nominal-record.eff`. It has the `Dog` and `User` types with identical fields, `User` as a brand, and the call `activate(dog)` with a `// error: type-mismatch/003` marker. It also has a plain record literal returned as `User`, with a second marker. The fixture test (`tests/fixtures_test.ts`) picks it up by name.

T3. `tests/validate_test.ts`, one test through `lowerText`. The T1 program, without the faulty functions, lowers and gives `codesOf(...) = []`. Then one mutation: set the `field` of the `get` node in `nameOf` to `"missing"`, and expect `validation/002`.

T4. New emitter forms module `fixtures/emit/forms/nominal-records.eff`, with `nameOf`, `nick`, `activate`, `make` (constructor call), and `plain` (unbrand). Add it to `buildForms` in `tests/emit_slow_test.ts`, so the slow tests run `deno check` and `deno fmt --check` on its output. The test "the emitted forms are a fixed point of deno fmt" asserts the exact sorted list of generated files, so add `"nominal-records.ts"` after `"names.ts"`. The same test asserts `run.stderr.includes("Checked 4 files")`. Change it to `"Checked 5 files"`, and change the message that names the four files.

T5. `tests/emit_test.ts`, one fast test on the T4 module. The emitted text contains `Option.fromUndefinedOr(user.nickname)`, `({ ...user, active: true })` or the printer's equal layout, and `.pipe(Schema.brand("nominal-records#User"))`. Read the real output first and assert on exact substrings.

T6. Dropped (finding m3). `Schema.brand` has no runtime effect, and T4 covers `User.make` and the spread under `deno check`.

## 6. Out of scope

- The spec text in `/Users/srdjans/Code/effektive`. The user owns the spec. The report names the needed amendment: a field read and an update through a brand of a record.
- R1 (primitives only inside type definitions). The assessment comes after R2.
- Equality of record brands. The checker rejects it now, as the spec requires ("Comparing records requires a named comparison function").
- A pre-existing emitter gap (finding m4): `isOptionalField` returns false for a union base, but `readField` marks a read through a union optional. So `(a: A | B).nickname` prints without `Option.fromUndefinedOr`. This plan does not change it. The report names it for a later fix.
- The golden files. No example uses a record brand, so `deno task golden:update` must give no diff.

## 7. Verification

The implementer and then Opus run these commands from the repository root:

1. `deno task test` (fast tests).
2. `deno task check` (format, lint, type check, fast and slow tests).
3. `deno task golden:update`, then `git status --short fixtures/golden` must print nothing.
4. `deno task effektive build /tmp/rules-probe/r2 --validate --tsc`: the two expected `type-mismatch/003` lines remain (`wrong` and `literal`). The three G1 and G2 diagnostics are gone.

## 8. Commit

One commit: "Read fields and update records through a record brand". The body gives the reason: R2 makes records nominal through `Brand<{ ... }>`, and field reads and updates did not see through the brand.

## 9. Validation findings

| Finding | Severity | Resolution |
| --- | --- | --- |
| M1: `fieldsOf` recursion through a brand base has no depth bound, and a mutated IR can loop | Major | Accepted. C2 adds the `depth` parameter and `MAX_DEPTH` |
| M2: the fmt fixed-point test also asserts `Checked 4 files` | Major | Accepted. T4 changes the count to 5 |
| m1: record patterns and `withResource` operation records still stop at a brand | Minor | Accepted. The C4 row names both as unsupported |
| m2: `typeAt` prints type and sets, so a string assertion is fragile | Minor | Accepted. T1 reads the body table |
| m3: the runtime test adds little | Minor | Accepted. T6 is dropped |
| m4: optional read through a union base emits without `Option.fromUndefinedOr` | Minor | Accepted as out of scope. Section 6 names it |

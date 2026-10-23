# Plan: examples with nominal data types

Status: validated, 2026-10-23. Fable reported 2 major and 10 minor findings. Opus accepted all 12. Section 5 maps each finding to its resolution.

This plan uses the ID prefix EX. EX1 and EX2 are the user's decisions. EX3 and later are work items.

## 1. Decisions

On 2026-10-23 the user asked for a few examples with nominal types, in this repository and on the website. The user accepted these options ("as recommended"):

- EX1 (a). The compiled example is a new application fixture, `fixtures/applications/order-lifecycle/`. `tests/application_slow_test.ts` checks, lowers, validates, emits, type-checks, tests, and runs it, as it does for the three other applications.
- EX2 (a). The website gets a new mini-book chapter, "Nominal data", with three checked figures. The full application goes to `effective-examples/order-lifecycle/` and is linked from the chapter and from the specification.

The existing examples in `fixtures/examples/` stay structural, because their host code builds those records as plain objects (NT9 in [the nominal data types plan](../archive/plans/2026-10-23-nominal-data-types.md)).

## 2. The application (Opus calls)

The application models an order and its pricing. It uses only the forms of the [language rules](../language-rules.md). Fable built a sketch of it in `/tmp/ex-validate/app/`: it passes `build --tsc --validate` and runs, with the changes that section 5 lists.

- Modules. `contracts.eff` holds the declarations. `orders.eff` holds the functions and imports the declarations, so data types cross a module boundary.
- Identity. `type OrderId = Brand<string>` and `type Cents = Brand<int>`. The numeric brand operators `+` and `<` apply to `Cents`.
- Aliases. Rule R1 allows primitives only in declarations, so `contracts.eff` declares aliases such as `type Text = string`, `type Count = int`, `type Bool = boolean`, and the literal union `type StateName = "pending" | "paid" | "shipped" | "cancelled"`.
- States. `data Pending = { id: OrderId, total: Cents }`, `data Paid = { id: OrderId, total: Cents, receipt: Receipt }`, `data Shipped = { id: OrderId, receipt: Receipt, tracking: Tracking }`, `data Cancelled = { id: OrderId, reason: Reason }`, and `type Order = Pending | Paid | Shipped | Cancelled`.
- Transitions. `pay(order: Pending, ...)`, `ship(order: Paid, ...)`, and `cancel(order: Pending | Paid, ...)` take only the states that they accept. `stateOf(order: Order): StateName`, `describe(order: Order): Text`, and `isOpen(order: Order): Bool` use `match` with one name arm for each state and no `_`, so a forgotten state gives `pattern/001`. `stateOf` depends on EX3.
- Failure. `error InvalidTransition = { id: OrderId, state: StateName }` comes from `cancelAny(order: Order)`, which matches by name and fails for `Shipped` and `Cancelled`.
- Pricing rules. A recursive data tree: `data Fixed = { amount: Cents }`, `data Times = { factor: Count }` (the base times the factor), `data Capped = { rule: Rule, cap: Cents }`, `data Sum = { parts: Rule[] }`, and `type Rule = Fixed | Times | Capped | Sum`. `price(rule: Rule, base: Cents): Cents` evaluates it by recursive match, and `Sum` folds its parts with `+`. Each cycle passes through the array `parts` or through the union `Rule`, whose members `Fixed` and `Times` are outside the cycle. A percent rule is not possible, because `/` always gives `number` and the prelude has no rounding function.
- Construction. `orders.eff` exports one sample rule constant, built in source with the data constructors. The runtime test also builds one rule tree in TypeScript with `Sum.make(...)` and `Cents.make(...)`, to show host construction.
- Decoding. `type OrderInput = { id: Text, total: Count }` is structural. A `schema()` decodes it from unknown JSON, and a function converts it into `Pending` with the data constructor. So JSON without `_tag` enters through a structural type (NT3).
- Host. No service and no driver. The host imports the emitted modules. Pure functions return values. A `fails` function returns an Effect, which the test runs with `Effect.runSync` and `Effect.runSyncExit`. The `_tag` values are module-qualified, for example `"contracts#Pending"`.
- `main.ts` prints a JSON report. `runtime_test.ts` holds the compiled runtime cases: each transition, each `stateOf` and `describe` result, the `InvalidTransition` failure, the price of the sample rule and of the host-built rule, the decode path with valid and invalid input, the encoded form that keeps `_tag`, and a rejected decode of JSON with a wrong `_tag`.

## 3. Work items

Each commit must pass `deno task check` in this repository. An item that adds or edits a `.eff` or `.effi` file must also run `deno task lex:update` and commit the snapshot.

### EX3. Fix literal results of match arms (one commit in this repository)

A `match` whose arms return string literals, with a literal-union result type, checks clean. The emitted arm, for example `((p) => "pending")($t0)`, widens the literal to `string`, and `deno check` reports TS2322. An `if` with the same type passes. Repro: `/tmp/ex-validate/lit/m.eff`.

- Find the root cause in the match emission (`selectorMatch` and the arm functions in `src/core/emit/expr.ts`), and fix it once in the shared code, for example with the checked arm type as the expected type of the arm body or as the result annotation of the arm function. Check the same path for the error and tagged-record arms, and for numeric and boolean literal results.
- Tests: an emit test and a slow `deno check` case for a literal-union result from a name match, a literal match, and an option match.
- Result: the defect was wider. A literal also widens in a block wrapper, in `Effect.succeed`, and in an `Effect.gen` return, for string, number, and boolean literals. The emitter now writes `as const` on a literal whose slot type is a literal type or a union with a literal member. The fixture is `fixtures/emit/forms/literal-results.eff`. One golden line changes in `fixtures/golden/pay.ts`.

### EX4. The application fixture (one commit in this repository)

- Add `fixtures/applications/order-lifecycle/` with `effective.json`, `deno.json` (the same imports and compiler options as `stream-processor/deno.json`), `.gitignore` (as `stream-processor/.gitignore`, for the emitted `contracts.ts`, `orders.ts`, maps, and `deno.lock`), `contracts.eff`, `orders.eff`, `main.ts`, `runtime_test.ts`, and `README.md` in the style of the other application READMEs.
- `tests/application_slow_test.ts`: add the `APPLICATIONS` row with `hostFiles: ["runtime_test.ts", "main.ts"]`, add the new report fields to the `Report` interface, and change the header comment that says "three application fixtures".
- Add a row to the application table in `docs/status.md` in its format, with the plan link `plans/2026-10-23-nominal-examples.md`. Update each count of the applications: `docs/development.md:60`, `docs/api.md:132`, `README.md:78`, and `docs/status.md` lines 3, 7, 9, and 66. The new application is a witness for nominal data types, beside the three gate applications. Write this distinction where a count changes.
- Run `deno task lex:update`.

### EX5. The website (one commit in `../effective/`)

- Copy the application to `public/effective-examples/order-lifecycle/` by the rules of the other copies: rename `runtime_test.ts` to `checks.ts`, rewrite the README as a download page (the file list, `deno run --config deno.json main.ts`, and `deno test --config deno.json checks.ts`), and do not copy `.gitignore` or `deno.lock`. No sync script exists.
- Add the chapter "Nominal data" to `public/index.html` after the chapter "A payment pipeline" (`id="payment"`). Headings have no numbers. Update the `aria-label="Navigation for section N"` of each later `nav.section-nav`, the "Previous" and "Next" links on both sides, and the three menus: `nav.chapter-index` in `section#book`, the mobile `details.contents-menu > nav.contents.mobile-contents > ol`, and the desktop `nav.contents[aria-label="Contents"]`.
- The chapter has three figures with an Effective panel and an Effect-TS panel each: (1) declare the states and construct and update a value, with the nominal mismatch in prose; (2) a match by name over `Order`; (3) the recursive pricing rules. The Effect-TS panel of figure 1 carries a `data-check-id`. Figures 2 and 3 use `data-check-requires` with that id (`typecheck/check.ts:330-353`). Take each Effect-TS panel from the real compiler output, simplified as the other panels are. The panel of figure 3 must keep the explicit interface and `Schema.suspend` form, because `typeof X.Type` inside a cycle fails `deno check`. The prose says that the panels use short tags and that the compiler uses module-qualified tags.
- Add a fourth "runnable ..." paragraph for the application in the modules chapter of `index.html` (near line 1094) and in `effective-spec.html` (near line 1064).
- Add a dated entry to `public/effective-validation.txt`. Run `deno task test` and `deno task typecheck`. `deno task stamp` is not needed, because `deno.json` does not change.

### EX6. Close (one commit in this repository)

- Archive this plan to `docs/archive/plans/` with the commit ids. Fix the links in `AGENTS.md` and in the `docs/status.md` application row.

## 4. Risks

- The website panels simplify the compiler output. Later emitter changes can make them drift. The typecheck harness checks only that each panel compiles.

## 5. Validation findings

1. Major: percent pricing on `Brand<int>` cannot type-check, because `/` gives `number`. Accepted: `Times = { factor: Count }` replaces `Percent`.
2. Major: string-literal arms of a `match` widen to `string` in the emitted code, and `deno check` fails. Accepted as a compiler defect: EX3 fixes it before the application uses it.
3. Minor: `boolean` in a signature breaks rule R1. Accepted: `type Bool = boolean`.
4. Minor: a nested rule tree needs construction. Accepted: a sample rule in source, and one host-built rule through `make`.
5. Minor: the test `Report` interface, the header comment, and the docs that count three applications. Accepted in EX4.
6. Minor: the fixture needs a `.gitignore`. Accepted in EX4.
7. Minor: the status row links the live plan, and EX6 must repoint it. Accepted in EX4 and EX6.
8. Minor: the typecheck harness resolves `data-check-requires` against `data-check-id`. Accepted in EX5.
9. Minor: chapter insertion touches navigation labels, links, three menus, and the runnable-application paragraphs. Accepted in EX5.
10. Minor: the website copies follow hand-made rules. Accepted in EX5.
11. Minor: the recursive figure must keep the explicit form. Accepted in EX5.
12. Minor: `deno task stamp` is needed only after a version change. No change.

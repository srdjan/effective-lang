# Plan: runtime checks of data values at the host boundary

Status: validated, 2026-10-23. Fable reported 3 major and 11 minor findings. Opus accepted all 14. Section 6 maps each finding to its resolution.

This plan uses the ID prefix HB. HB1 and HB2 are the user's decisions. HB3 and later are work items.

## 1. Decisions

On 2026-10-23 the user asked for an assessment of two follow-ups to the nominal data types work: (d) runtime checks of data values at the host boundary, and (c) a compiler-owned companion module for the type-level declarations of `.effi` files. The user accepted these options ("as recommended"):

- HB1 (a). Add (d) at the provider boundary for method results and stream elements. Add a tag test for the last arm of each match without a wildcard, so that a value outside its type fails at every other crossing too. The other higher-order positions stay trusted and documented.
- HB2 (a). Plan (c) as a separate follow-up after HB3 to HB6 (item HB7).

## 2. Evidence (Opus, 2026-10-23, checked by Fable)

- `deno check` already rejects a host Layer whose method returns a wrong `_tag`: the probe in `/tmp/hb-tag` gives `host-boundary/001`. So a wrong tag reaches source code only through unsound host TypeScript: `any`, a cast, an unchecked `JSON.parse` result, or a build without `--tsc`.
- With `as never` on the host value, the probe builds clean, and the wrong tag takes the last match arm at run time.
- Each host provider is bound once in each module, in a typed alias: `const RowsLive$host: Layer.Layer<Rows> = RowsLive;` (`hostAssertions` in `src/core/emit/decls.ts`). Every use of the provider reads that alias.
- A hand-written wrapper of that alias works with Effect 4.0.5 and passes `deno check` (`/tmp/hb-tag/main_wrapped.ts`, `/tmp/hb-validate/p3_wrapper.ts`). It keeps the declared `Layer.Layer<S, E, R>` type for a provider with `fails` and `uses`, for a provider of two services, and for a scoped host provider.
- Every service method has effect execution (`functionOf("effect", ...)` in `src/core/check.ts`), so every method returns an Effect. A method that returns a stream returns `Effect<Stream<A>>`.
- `Schema.is(schema)` validates a value of the decoded type and keeps the value. It rejects a wrong tag, a missing tag, and a non-integer brand. It also rejects a plain `{ _tag: "Some", value }` in an `Option` position, and an optional field that is present with the value `undefined`. Extra fields and null-prototype copies pass.
- A throw is a `TypeError` for a pure TypeScript caller, and a defect inside `Effect.gen`, `Effect.map`, and `Stream.map` (`/tmp/hb-validate/p2_throw.ts`).
- Measured cost of a check with `Schema.is` (Deno 2.9.8, Apple M4 Pro, Effect 4.0.5, an in-memory service called through `Effect.gen`, `deno bench --no-check`, reproduced by Fable): one data result goes from 349 ns to 726 ns. A result array of 100 data values goes from 355 ns to 20.1 µs. For a stream of 1000 elements, a synchronous `Stream.map` check costs 92 µs and a `Stream.mapEffect` check 214 µs, against 6.4 µs without a check. `Stream.mapEffect` also splits one chunk of 1000 elements into 1000 chunks. The cost in a real application is not measured.
- Wrapping does not change Layer sharing (`/tmp/hb-validate/p3_wrapper.ts`): over two `provide` calls, the host Layer is built twice with the plain alias and twice with the wrapper. Two wrappers around one host Layer in one `provide` build it once.
- TypeScript that calls exported source functions, for example a `main.ts`, does not pass through a provider. The last-arm test covers that crossing for matches only.

## 3. Design

### 3.1 Last-arm tag test (HB3)

Today `selectorMatch` (`src/core/emit/expr.ts`) does not test the last arm, so any value takes it. A checked program has no binding-only pattern (`pattern/004`) and no `_` before the last arm (`pattern/002`). So the condition is: when the last arm is not `_`, it also gets its test, and the else branch calls a module helper that throws.

```ts
const $unmatched = (_value: unknown): never => {
  throw new TypeError("a match received a value outside its type");
};
```

- The helper name goes through `scope.fresh`, because source names such as `$int` are legal. The helper is emitted once in each module that uses it, in the way that `$int` is emitted, outside every span record.
- The message does not print the value. A null-prototype data copy has no `toString`, and printing it would throw a different error.
- A throw in a pure function is a `TypeError` for the TypeScript caller. A throw inside `Effect.gen` or a stream callback is a defect.
- A match whose last arm is `_` and an option match (`optionMatch`) do not change.
- The test applies to data, error (including `SchemaIssue`), literal (including `null`), and tag-field arms (including the `in` guard), because a value outside a literal union takes the last arm in the same way. TypeScript accepts `$unmatched($t0)` in each shape (`/tmp/hb-validate/p1_types.ts`).
- The golden files hold no selector match, so they do not change. The output of `fixtures/emit/forms` changes, and `deno fmt` must keep it a fixed point.

### 3.2 Provider boundary checks (HB4)

`hostAssertions` keeps the plain alias for a provider when no method of its provided services needs a check. Otherwise it emits a wrapped Layer.

- A method needs a check when its result type has a checkable schema and contains a data type. A type has a checkable schema when it has no function, deferred, or opaque part and names no declaration of a host interface module. A declaration is in a host interface module when `moduleOfId(id)` is the module of the `interface` file of an entry of `config.host`. This rule also excludes an `.effi` alias that reaches an `.eff` data type, because such types are imported type-only (`bindHost` in `src/core/emit/scope.ts`) and have no schema value in the module. The traversal of aliases is cycle-safe.
- The check is a synchronous function that returns its value or throws. A result check is `Effect.map(s.m(a, b), RowsLive$get)`. A stream check is `Effect.map(s.m(), (stream) => Stream.map(stream, RowsLive$source))`. `Stream.map` keeps the chunks.
- Every other result is not checked: `Sink`, Effect values, functions, `Ref`, Fibers, opaque types, results without a data type, results that name `.effi` declarations, typed errors, and the arguments that host code passes to source callbacks.
- The wrapper rebuilds each provided service with every method named explicitly: `{ m1: (a, b) => s.m1(a, b), m2: ... }`, inside `Effect.gen`. A spread is not safe, because a host implementation can be a class instance whose methods are on the prototype.
- A provider of several services gets one `Layer.effect` for each service, merged with `Layer.mergeAll`, then `Layer.provide(host)`. A provided service without checks gets a pass-through rebuild in the same form, because `Layer.provide` hides every service that the merged wrapper does not output.
- Each check is a module constant built once, `const RowsLive$get = $hostCheck(schema, "Rows.get");`. Each constant name and the helper name go through `scope.fresh`. `schema` comes from `schemaDoc` of the result type, or of the stream element type.
- `$hostCheck` is a module helper emitted once. On each value it calls `Schema.is(schema)`. On a failure only, it runs `Schema.decodeUnknownExit(Schema.toType(schema))`, takes the message of `Cause.squash` of the failure with newlines collapsed, and throws `new TypeError("host value of Rows.get does not match its type: <issue>")`. The exact text must be a `deno fmt` fixed point.
- `build` in `src/core/emit/emit.ts` must call `hostAssertions()` before it reads the helper flags (`usesIntSchema`, `usesIntFunction`, and the new flag), because `schemaDoc` registers `$Int` during `hostAssertions()`. The helpers stay before the host assertions in the output.
- The declared type of the wrapped constant stays the provider type, so `host-boundary/001` still reports a wrong host module statically.

## 4. Work items

Each commit must pass `deno task check`. An item that adds or edits a `.eff` or `.effi` file must also run `deno task lex:update`, after `git add -N` on new files.

### HB3. Last-arm tag test (one commit)

- Change `selectorMatch` as section 3.1 says. Add the `$unmatched` helper through the import ledger, like `usesIntFunction`.
- Rewrite `tests/emit_test.ts` "a match over data and error types tests the tag of each arm but the last", which asserts that the last arm has no test.
- Tests: an emit test for the tested last arm and the helper, and one for a match whose last arm is `_`. A slow test that builds a data match, a literal match, and a tag-field match, in pure mode, in effect mode, and inside a stream callback. It calls each with a value outside its type from TypeScript through a cast. A pure call must throw the `TypeError`. An effect or stream call must die with it (`Cause.hasDies`). A match whose last arm is `_` must still take that arm.
- Measure the cost of the extra test with a throwaway Deno bench outside the repository, and record the method and the result in the commit body.

### HB4. Provider boundary checks (one commit)

- Change `hostAssertions` and `build` as section 3.2 says. Add the `$hostCheck` helper through the import ledger.
- Add the fixture `fixtures/emit/host-checks/` with these parts:
  - a contracts module with data types
  - a service with methods that return a data value, `Option` of a data value, an array of data values, a `Stream` of data values, an inline record with an `int` field and a data field, and an `int`
  - a second service without data results
  - a `.effi` file with one provider that provides both services and has `fails` and `uses`, and a second provider whose method returns a data type that the `.effi` file declares
  - a host module
- Slow tests, built with `--tsc` in a temporary directory:
  - Correct values pass, and the stream keeps its chunks.
  - A wrong tag through a cast on each checked method dies with the message, which names the method and the issue path.
  - The `int` method and the second service work unchanged.
  - The `.effi`-data provider keeps the plain alias.
  - The emitted fixture is a `deno fmt` fixed point.
- A host-boundary mapping test: a host module with its own service class of the same tag and a missing method gives one `host-boundary/001` on the wrapped constant.
- The existing host provider tests must pass unchanged, especially "host providers preserve shared scope handles and reject raw target scopes" in `tests/emit_slow_test.ts`. The golden files must not change, because no example provider returns a data type.

### HB5. Measurement and documentation (one commit)

- Measure with a throwaway bench outside the repository, built from the HB4 fixture. Compare `Effect.provide(job, HostLive)` on the raw host import with the same job through the emitted wrapped provider, for one data value, an array of 100, and a stream of 1000. Fix the type errors of `/tmp/hb-bench/bench2_test.ts` first if it is reused. Record the method, the machine, and the results in `docs/status.md`.
- `docs/language-rules.md`: change the rows "Wrong tag in a match" and "Host interface data types", and add a row for the provider boundary checks with the checked and the trusted positions and the two `Schema.is` limits of section 2. Update the rows "Host assertion range" and "Position outside every record" for the check constants and the helpers.
- `docs/api.md` (near line 339): describe the wrapped form of the assertion constant.
- `docs/status.md`: describe the new checks under "Nominal data types". Keep the TS1361 limit, which HB7 addresses.

### HB6. Website (one commit in `../effective/`)

- Update the specification paragraphs near lines 352 and 415 (coverage), and near 497 and 767 (host modules, and adapters that validate data boundaries) of `public/effective-spec.html`, for the provider boundary checks and the last-arm test. The website copy of order-lifecycle holds no generated code, so it does not change. Add a dated entry to `public/effective-validation.txt`. Run `deno task test` and `deno task typecheck`.

### HB7. Close, and plan the companion module (one commit)

- Archive this plan with the commit ids, and fix its links.
- Write a separate plan with a new prefix for the companion module: the compiler lowers, validates, and emits the type, data, and error declarations of each `.effi` file into a generated module. Source code imports their values from it, and host modules import constructors from it. Facts for that plan: lowering now refuses `.effi` modules (`host-interface` in `src/core/lower.ts`). An `.effi` file that imports the module that imports it gives `module/003`, so a direct cycle is already rejected; other import orders still need a probe. No current application fixture declares a data type in an `.effi` file. After that plan lands, HB4 can check results that name `.effi` declarations.

## 5. Risks

- The checks protect against unsound host code only for the checked positions. Section 3.2 lists the trusted positions, and the docs must state them.
- A stream check adds about 92 ns for each element in the measured case. A stream-heavy host must measure its own cost.

## 6. Validation findings

1. Major: `Stream.mapEffect` splits chunks and costs twice a synchronous check. Accepted: the check is synchronous and throws; results use `Effect.map`, streams use `Stream.map`.
2. Major: `build` reads the helper flags before `hostAssertions()` registers `$Int`. Accepted in section 3.2 and HB4, with the inline-record fixture method.
3. Major: types declared in an `.effi` file have no schema value in the module. Accepted: such results are not checked, with a fixture provider.
4. Minor: the condition of section 3.1. Accepted: "the last arm is not `_`".
5. Minor: the golden files hold no selector match, and HB3 breaks one emit test. Accepted in section 3.1 and HB3.
6. Minor: the first line of `Cause.pretty` loses the issue path. Accepted: `Cause.squash` message with newlines collapsed.
7. Minor: the helper text must be a `deno fmt` fixed point, and names must go through `scope.fresh`. Accepted in sections 3.1 and 3.2 and HB4.
8. Minor: an `m8` harness does not fit a one-off measurement. Accepted: throwaway benches, with the comparison defined in HB5.
9. Minor: the first bench ran with `--no-check` and has type errors. Accepted: section 2 says so, and HB5 fixes the bench before reuse.
10. Minor: HB3 tested only pure throws. Accepted: effect and stream contexts with `Cause.hasDies`.
11. Minor: no mapping test for a wrapped provider. Accepted in HB4.
12. Minor: missing docs. Accepted in HB5 and HB6. The playground, the language server, and the validator need no change.
13. Minor: the sharing risk is verified. Accepted: section 2 states the evidence.
14. Minor: two `Schema.is` behaviors. Accepted as documented limits in section 2 and HB5.

# Plan: runtime checks of data values at the host boundary

Status: draft, 2026-10-23. Fable validation is pending.

This plan uses the ID prefix HB. HB1 and HB2 are the user's decisions. HB3 and later are work items.

## 1. Decisions

On 2026-10-23 the user asked for an assessment of two follow-ups to the nominal data types work: (d) runtime checks of data values at the host boundary, and (c) a compiler-owned companion module for the type-level declarations of `.effi` files. The user accepted these options ("as recommended"):

- HB1 (a). Add (d) at the provider boundary for method results and stream elements. Add a tag test for the last arm of each match without a wildcard, so that a value outside its type fails at every other crossing too. The other higher-order positions stay trusted and documented.
- HB2 (a). Plan (c) as a separate follow-up after HB3 to HB6 (item HB7).

## 2. Evidence (Opus, 2026-10-23)

- `deno check` already rejects a host Layer whose method returns a wrong `_tag`: the probe in `/tmp/hb-tag` gives `host-boundary/001`. So a wrong tag reaches source code only through unsound host TypeScript: `any`, a cast, an unchecked `JSON.parse` result, or a build without `--tsc`.
- With `as never` on the host value, the probe builds clean, and the wrong tag takes the last match arm at run time.
- Each host provider is bound once in each module, in a typed alias: `const RowsLive$host: Layer.Layer<Rows> = RowsLive;` (`hostAssertions` in `src/core/emit/decls.ts`). Every use of the provider reads that alias.
- A hand-written wrapper of that alias works with Effect 4.0.5 and passes `deno check`: `Layer.effect(Rows)(Effect.gen(function* () { const s = yield* Rows; return { ...s, get: () => Effect.flatMap(s.get(), check) }; })).pipe(Layer.provide(RowsLive))`. A correct value passes. A wrong tag stops the program with a defect.
- `Schema.is(schema)` validates a value of the decoded type. It keeps the value, and it rejects a wrong tag, a missing tag, and a non-integer brand. `Schema.decodeUnknownSync(Schema.toType(schema))` rejects the same values and returns a copy.
- Measured cost (Deno 2.9.8, Apple M4 Pro, Effect 4.0.5, an in-memory service called through `Effect.gen`): one data result goes from 349 ns to 726 ns. A result array of 100 data values goes from 355 ns to 20.1 µs, about 197 ns for each element. The cost in a real application is not measured.
- A host method can return `Stream`, `Sink`, Effect values, functions, `Ref`, Fibers, and opaque types (for example `fixtures/emit/sinks/contracts.eff`). A method that returns a stream returns `Effect<Stream<A>>` in the emitted service type.
- TypeScript that calls exported source functions, for example a `main.ts`, does not pass through a provider. The last-arm test covers that crossing for matches only.

## 3. Design

### 3.1 Last-arm tag test (HB3)

Today `selectorMatch` (`src/core/emit/expr.ts`) does not test the last arm, so any value takes it. After HB3, when every arm of a selector match has a test (no wildcard and no binding-only pattern), the last arm also gets its test, and the else branch calls a module helper that throws:

```ts
const $unmatched = (_value: unknown): never => {
  throw new TypeError("a match received a value outside its type");
};
```

- The helper is emitted once in each module that uses it, in the way that `$int` is emitted.
- The message does not print the value. A null-prototype data copy has no `toString`, and printing it would throw a different error.
- A throw in a pure function is an exception for the TypeScript caller. A throw inside `Effect.gen` is a defect.
- A match with a wildcard arm and an option match (`optionMatch`) do not change.
- The test applies to data, error, literal, and tag-field arms alike, because a value outside a literal union takes the last arm in the same way.
- Golden files and emitter layout tests change for each such match. `deno fmt` must keep the output a fixed point.

### 3.2 Provider boundary checks (HB4)

`hostAssertions` keeps the plain alias for a provider when no method of its provided services needs a check. Otherwise it emits a wrapped Layer.

- A method needs a check when its result type, through aliases, contains a data type and has a schema: no function, deferred, or opaque part. The check is `Effect.flatMap(s.m(...), check)`.
- A method whose result is `Stream<A>`, where `A` meets the same condition, gets `Effect.map(s.m(...), (stream) => Stream.mapEffect(stream, check))`.
- Every other result is not checked. This includes `Sink`, Effect values, functions, `Ref`, Fibers, opaque types, results without a data type, and typed errors.
- The wrapper rebuilds each provided service with every method named explicitly: `{ m1: (a, b) => s.m1(a, b), m2: ... }`. A spread is not safe, because a host implementation can be a class instance whose methods are on the prototype.
- A provider that provides several services gets one `Layer.effect` for each service, merged with `Layer.mergeAll`, then `Layer.provide(host)`. A provided service without checks gets a pass-through rebuild in the same form, because `Layer.provide` hides every service that the merged wrapper does not output.
- Each check is a module constant built once: `const RowsLive$get = $hostCheck(schema, "Rows.get");`. `schema` comes from `schemaDoc` of the result type, or of the stream element type.
- `$hostCheck` is a module helper emitted once. It calls `Schema.is(schema)` on each value. On a failure only, it runs `Schema.decodeUnknownExit(Schema.toType(schema))` to get the issue text. It then stops the program with `Effect.die(new TypeError("host value of Rows.get does not match its type: <issue>"))`.
- The declared type of the wrapped constant stays the provider type, so `host-boundary/001` still reports a wrong host module statically.

## 4. Work items

Each commit must pass `deno task check`. An item that adds or edits a `.eff` or `.effi` file must also run `deno task lex:update`, after `git add -N` on new files.

### HB3. Last-arm tag test (one commit)

- Change `selectorMatch` as section 3.1 says. Add the `$unmatched` helper through the import ledger, like `usesIntFunction`.
- Update the golden files with `deno task golden:update`, and review each changed line.
- Tests: an emit test for the tested last arm and the helper. A slow test that builds a data match, a literal match, and a tag-field match, then calls each with a value outside its type from TypeScript (through a cast). Each call must throw the `TypeError`. A wildcard match must still take its `_` arm.
- Measure the cost of the extra test with a Deno bench, and record the method and the result in the commit body.

### HB4. Provider boundary checks (one commit)

- Change `hostAssertions` as section 3.2 says. Add the `$hostCheck` helper through the import ledger.
- Add the fixture `fixtures/emit/host-checks/`: a contracts module with data types, a service with methods that return a data value, `Option` of a data value, an array of data values, a `Stream` of data values, and an `int`; a second service without data results; a `.effi` file with one provider that provides both services; and a host module.
- Slow test: build with `--tsc`, then run in a temporary directory: correct values pass; a wrong tag (through a cast) on each checked method stops the program with the defect message; the `int` method and the second service work unchanged.
- The existing host provider tests must pass unchanged, especially "host providers preserve shared scope handles and reject raw target scopes" in `tests/emit_slow_test.ts`. Verify that a fixture whose providers need no check emits the same text as before.

### HB5. Measurement and documentation (one commit)

- Add a bench to `bench/` that runs the HB4 fixture with and without the check, for one data value and for an array of 100. Record the results and the machine in `docs/status.md`.
- `docs/language-rules.md`: replace the rows "Wrong tag in a match" and "Host interface data types" where they change, and add a row for the provider boundary checks with the checked and the trusted positions.
- `docs/status.md`: describe the new checks under "Nominal data types". Keep the TS1361 limit, which HB7 addresses.

### HB6. Website (one commit in `../effective/`)

- Update the specification text about the host boundary and about match exhaustiveness at run time. Add a dated entry to `public/effective-validation.txt`. Run `deno task test` and `deno task typecheck`.

### HB7. Close, and plan the companion module (one commit)

- Archive this plan with the commit ids, and fix its links.
- Write a separate plan with a new prefix for the companion module: the compiler lowers, validates, and emits the type, data, and error declarations of each `.effi` file into a generated module. Source code imports their values from it, and host modules import constructors from it. Facts for that plan: lowering now refuses `.effi` modules (`host-interface` in `src/core/lower.ts`). An import cycle between the companion module and the `.eff` modules it imports is a probable risk and needs a probe. No current application fixture declares a data type in an `.effi` file.

## 5. Risks

- HB4 wraps each provider once in each module. A program that provides the same host provider from two modules gets two wrappers around one host Layer. Probably Effect builds the host Layer once for each `provide` call in both cases, so sharing does not change. This is not verified. The scope sharing test and a probe in HB4 must confirm it.
- The checks protect against unsound host code only for the checked positions. Section 3.2 lists the trusted positions, and the docs must state them.

## 6. Validation findings

None yet.

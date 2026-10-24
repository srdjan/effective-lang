# Plan: a generated companion module for each host interface

Status: done, 2026-10-23. CM6 to CM12 landed in commits d7f0691 (CM6), decf945 (CM7), c2428bd (CM8), c877fc3 (CM9), e6ec178 (CM10), and the commit that archives this plan (CM12). CM11 landed as fc5acd9 in the sibling repository `../effektive/`. The user accepted CM1 to CM5 as recommended. Fable reported 4 major and 9 minor findings on the draft. Opus accepted all 13. Section 6 maps each finding to its resolution.

This plan uses the ID prefix CM. CM1 to CM5 are decisions for the user. CM6 and later are work items. The plan is the follow-up that HB2 (a) asked for in [the host boundary plan](2026-10-23-host-boundary-checks.md).

## 1. Decisions

The compiler will emit one TypeScript module for each `.effi` file, the companion module. The companion module holds the values that the compiler derives from the declarations of the interface. Source modules and the host module import those values from it, so the compiler is the only owner of each tag string.

- CM1. Which declarations go into the companion module.
  - (a) Recommended. Every declaration that has a value or a tag: type aliases (as types), brands, data types, errors, and services. Opaque types and providers stay in the host module.
  - (b) Only data types and brands. Errors and services stay in the host module, so the host author still writes their tag strings by hand. This option is not cheaper than it looks: the error import path of section 2 must change anyway.
- CM2. The path of the companion module.
  - (a) Recommended. `<name>.effi.ts` next to the interface file, for example `host.effi` gives `host.effi.ts`. The name cannot collide with a host module such as `host.ts`. It matches neither `fmt.exclude` `**/*.effi` nor the VS Code watcher pattern `**/*.effi`.
  - (b) `<name>.interface.ts` next to the interface file.
- CM3. An opaque type in a `data` or `error` field. The checker accepts it now, and the emitted schema names a type as a value, so `--tsc` reports TS2693. This bug also occurs in `.eff` modules.
  - (a) Recommended. The checker rejects an opaque type in a `data` or `error` field, also through an alias, with a new `declaration` code. A data value has an encoded form, and an opaque type has none.
  - (b) The emitter gives an opaque field a `Schema.declare` schema that accepts every value. A data value with that field then has no real check and no real encoded form.
- CM4. A host interface with only providers. Six of the ten tracked `.effi` files have no other declaration.
  - (a) Recommended. Always emit a companion module. Each `.effi` file then has exactly one generated file, so stale removal, golden fixtures, and `--tsc` follow one rule.
  - (b) Emit a companion module only for an interface with at least one declaration.
- CM5. The generated text of an `.effi` file in the playground and the editor.
  - (a) Recommended. Keep the current refusal. The playground and the request `generatedTypeScript` of the language server show generated text only for `.eff` files.
  - (b) Show the companion module for an `.effi` file in both places.

The work items assume CM1 (a), CM2 (a), CM3 (a), CM4 (a), and CM5 (a). There is no transition period: after CM9, a host module imports these values and does not declare them.

## 2. Evidence (Opus and Fable, 2026-10-23)

- Lowering refuses every `.effi` module with the error `host-interface` (`src/core/lower.ts:1648`). So no `.effi` declaration has a generated value now. `tests/lower_test.ts:148` and `tests/outputs_generation_test.ts:140` assert that error.
- `bindHost` in `src/core/emit/scope.ts` imports `type:` and `service:` bindings from the host module, and `value:` bindings (providers) as host aliases. A `type:` binding is type-only, so a data type or a brand of an `.effi` file cannot be constructed in source code. `docs/status.md:116-117` states this limit.
- Confirmed bug: `bindHost` skips `error:` bindings. `nameOf` (`scope.ts:643-650`) then allocates a fresh name and imports the error from `<module>.ts` (`moduleImports`, `scope.ts:677`), not from the host module path. Probe `/tmp/hb-err-effi` with the host module `hh.ts` gives `import { Boom as Boom$1 } from "./h.ts"`, and no file `h.ts` exists. So source code that names an `.effi` error has a dangling import whenever the host module is not `<interface>.ts`. The fixture `fixtures/applications/service-workflow/` uses `adapter.ts`.
- Confirmed bug: `data Box = { c: Conn }` with an opaque `Conn` emits `Schema.TaggedStruct("main#Box", { c: Conn })` next to `import { type Conn }`, and `--tsc` reports TS2693 (probe `/tmp/cm-probe-opaque`).
- The emitted tag of a data type is `<module>#<Name>`, for example `host#Token` in `fixtures/emit/host-checks/host.ts`. The host author writes that string by hand now. `fixtures/applications/service-workflow/adapter.ts:13` and its website copy tag `Runtime` as `"service-workflow#Runtime"`, but the compiler tag is `host#Runtime`. Nothing checks the string today, because Effect 4 keys a service by its string and the host module provides its own class.
- `--tsc` checks the generated modules and the host modules (`src/cli/tsc.ts:57`). A companion module that the build reports as generated joins that set.
- Five `.effi` files have a declaration that is not a provider:
  - `fixtures/emit/host-checks/host.effi` (data `Token`, service `Auth`)
  - `fixtures/applications/service-workflow/host.effi` (opaque `Backend`, service `Runtime`)
  - `fixtures/emit/scopes/host.effi` (alias `ScopeAlias`, which its `host.ts` does not declare)
  - `fixtures/parse/ok-forms.effi` (parse only)
  - `fixtures/errors/declaration-primitive-position-host/host.effi` (error fixture)
- The website copy `../effektive/public/effektive-examples/service-workflow/` has the same `Runtime` service.
- Probe `/tmp/cm-probe-cycle`: a companion module imports `type Backend` from `host.ts`, and `host.ts` imports `Runtime`, `StoreFailure`, and `Token` from `host.effi.ts`. It passes `deno check`, runs, and passes `deno fmt --check` with Effect 4.0.5. A companion module imports only `.eff` outputs and types of its host module, so it adds no runtime import cycle.
- `lowerDeclarations` (`lower.ts:1532`) already yields only types, errors, and services. The `exports` list of an `.effi` module holds provider ids (`lower.ts:1688`), and the validator rejects an export that is not declared (`validate/world.ts:624-633`). The opaque declaration is a brand of `unknown` in the IR, and the emitter has no branch for it.
- The program database knows only `.eff` outputs. `Revision.lowered` (`src/core/db.ts:293`) returns undefined for an `.effi` module, and `effModuleNames` (`db.ts:183`) excludes `.effi`. Its users are `writableModules` (`src/host/outputs.ts:55`), `runSaveRound` (`src/host/save_round.ts:76`), `src/cli/build.ts:68`, `src/cli/main.ts:66,85,165`, `src/lsp/projects.ts:461`, and `effModulesOf` in `playground/src/compile.ts:98`. `Scope.path` (`scope.ts:366`) is `<module>.ts`. `removeStaleOutputs` (`outputs.ts:153-181`) removes `<name>.ts` with the header `Generated from <name>.eff`.

## 3. Design

### 3.1 Content of the companion module

The companion module of `host.effi` is `host.effi.ts`. It starts with the generated header `Generated from host.effi`.

For each declaration, in declaration order, it contains the form that a `.eff` module emits. An alias gives `export type`, and a brand gives its schema and type. A data type gives its `TaggedStruct` constant and type. An error gives its `TaggedError` class, and a service gives its `Context.Service` class. Every tag keeps the module name of the `.effi` file, so `host#Token` does not change.

The companion module exports every declaration, also one without `export` in the `.effi` file. A host module needs an error that a provider `fails`, even when the error is not exported (`ok-forms.effi:14`). Source modules still see only the exported names, because the checker resolves imports.

A declaration that names an opaque type imports that type from the host module with `import type`. The emitter skips the opaque declaration itself. A declaration that names an `.eff` declaration imports it from the generated `.ts` module, as a source module does. Providers are not in the companion module. An interface with only providers gives a companion module with the header and `export {};`.

### 3.2 Binding in source modules

`bindHost` imports every `.effi` declaration except opaque types from the companion module, with the same type-only rule as an import from a `.eff` module. So a data type and an error are value imports, and an alias is a type import. Opaque types stay type-only imports from the host module. Providers keep their host aliases and the HB4 wrappers. `moduleImports` resolves an interface module to its companion path, from the interface paths in `config.host`, as `hostInterfaceModules()` in `src/core/emit/decls.ts` does. This removes the dangling error import.

### 3.3 Host modules

A host module imports its data types, errors, and services from the companion module. The tag strings leave the host module. The documentation of the host contract in `docs/api.md` states this rule. A host module that keeps its own copy of a service class with the same tag still runs. `--tsc` detects it, because the `$host` alias `Layer.Layer<S>` names the companion class.

### 3.4 Host boundary checks

`checkKind` in `src/core/emit/decls.ts` now excludes results that name `.effi` declarations, because no schema value exists for them. With the companion module, the schema exists, so the exclusion goes. The HB4 fixture gains a result of the `.effi` data type `Token` that is checked.

## 4. Work items

### CM6. Reject an opaque type in a data or error field (one commit)

- Implements CM3 (a) in the checker, with the new code `declaration/016` and the error fixture `fixtures/errors/declaration-opaque-field/`, for `.eff` and `.effi` files. This item fixes a bug that exists without the companion module, so it lands first.
- A probe showed the same bug in a brand: `Brand<Conn>` emits `Conn.pipe(Schema.brand(...))`. So `declaration/016` also covers a brand base that contains an opaque type.
- The rule rows in `docs/language-rules.md` and the status sentence change in this item, not in CM10.

### CM7. Lower and validate the declarations of an `.effi` file (one commit)

- Lowering accepts an `.effi` module and produces a module IR with its declarations and no functions. The `exports` list keeps only declarations and drops provider ids. The `host-interface` lower error goes, with its cases in `src/host/outputs.ts` and the tests at `tests/lower_test.ts:148` and `tests/outputs_generation_test.ts:140`.
- The validator accepts that IR. A test lowers and validates `fixtures/emit/host-checks/host.effi`.

### CM8. Emit and write the companion module (one commit)

- The emitter emits the companion module from the CM7 IR (section 3.1). The output path derives from the IR: `sources[0]` ends in `.effi`, as the validator already uses at `validate/world.ts:478,504`. `Scope.path` follows.
- The program database: `lowered`, `emitted`, `spanTable`, and `sourceMap` accept `.effi` modules. A query of generated module names replaces or joins `effModuleNames` for every user listed in section 2, except the playground (CM5 (a)).
- `writableModules` blocks a module whose `.effi` import failed, as it does for a `.eff` import.
- `removeStaleOutputs` also removes `<name>.effi.ts` with the header `Generated from <name>.effi`.
- `--tsc` maps a diagnostic in the companion module to the `.effi` span.
- Tests: golden companion modules through `emitExamples` (`tests/helpers.ts:550`), `deno fmt --check` byte for byte, and the captured output of `fixtures/host-boundary`.

### CM9. Bind source and host modules to the companion module (one commit)

- `bindHost` and `moduleImports` follow section 3.2.
- Migrate the host modules of the fixtures in section 2. Remove their copies of the declarations, and import them from the companion module. The `Runtime` tag changes from `service-workflow#Runtime` to `host#Runtime`. Update the comment in `fixtures/emit/host-checks/host.effi:5-6`.
- Remove the `.effi` exclusion of `checkKind` (section 3.4), and add the `Token` case to the HB4 tests.
- Tests: source code constructs an `.effi` data type and an `.effi` error, builds with `--tsc`, and runs. One test uses a host module whose name differs from the interface name.

### CM10. Documentation (one commit)

- `docs/language-rules.md`: rewrite the row "Host interface data types", and update "Host provider checks".
- `docs/api.md`: the host contract and the companion module.
- `docs/status.md`: remove the limit at lines 116-117.

### CM11. Website (one commit in `../effektive/`)

- Update the specification for the companion module and the CM6 rule. Update the `service-workflow` example host module and its `Runtime` tag. Add a dated entry to `public/effektive-validation.txt`. Run `deno task test` and `deno task typecheck`.

### CM12. Close (one commit)

- Archive this plan with the commit ids, and fix its links.

## 5. Risks

- Breaking change: every host module that declares a data type, an error, or a service of its interface must change. Section 2 lists the tracked cases. Projects outside the repository change in the same way. `--tsc` reports a host module that keeps a stale copy.
- Generated file in the source tree: `host.effi.ts` sits next to hand-written host code. The generated header and the `.effi.ts` suffix mark it. Projects that ignore generated `.ts` files by pattern need the new suffix too.
- Editor features: go-to-definition from a host module into the companion module is not in scope. CM5 (a) keeps the editor and the playground as they are.

## 6. Validation findings

| Finding | Severity | Resolution |
| --- | --- | --- |
| 1. The `.effi` error import uses `<module>.ts`, not the host module path | major | Confirmed by an Opus probe. Section 2 states it. Section 3.2 and CM9 fix it, with a test for a host module with a different name |
| 2. An opaque field in a data type has no schema | major | Confirmed by an Opus probe. New decision CM3 and work item CM6 |
| 3. The program database and the output paths are missing | major | CM8 lists each user, the fixpoint, the path rule, and stale removal |
| 4. No decision for an interface with only providers | major | New decision CM4, and section 3.1 gives the content |
| 5. The count of `.effi` files with declarations was four | minor | Section 2 lists five, with `ScopeAlias` |
| 6. `exports` holds provider ids, and non-exported errors are needed | minor | CM7 filters `exports`. Section 3.1 exports every declaration |
| 7. No emitter branch for an opaque declaration | minor | Section 3.1 skips it and imports its type. The cycle probe passes |
| 8. The playground claim was wrong | minor | New decision CM5 |
| 9. Tests and a fixture comment were not listed | minor | CM7 and CM9 list them |
| 10. The `Runtime` tag string differs from the compiler tag | minor | Section 2 and CM9 note the change, and CM11 updates the website copy |
| 11. No document contains `TS1361` | minor | CM10 points to `docs/status.md:116-117` |
| 12. A stale host class still runs | minor | Sections 3.3 and 5 name `--tsc` as the detection path |
| 13. CM1 (b) is not cheaper, and CM2 (a) matches no exclude pattern | minor | Both notes are in section 1 |

# Decoupling review: coupling that remains after the rederive work

Date: 2026-10-22. Base revision: `3e7a84a`. Status: accepted on 2026-10-22. The user chose the recommended option for Decisions 1 to 4: 1 (a), 2 (a), 3 (a), and 4 (a). So Phases 1 and 2 are in scope. Decisions 2 and 3 apply to ED2 step 2 and ED3, which are outside that scope, and they wait until those items start.

This document is a plan, not a change. It lists the places where a change to one unit still forces edits in other units, or changes their behavior with no compile error. For each place, it gives a decoupling design and a parity check. Section 9 ("What not to touch") of `2026-10-20-rederive-review.md` applies to every item.

ID prefixes. CK is the source checker. IC is the stages that read the typed IR: lowering, emission, and independent validation. ED is the incremental program, the editor queries, and the adapters. "M" marks a measured count, and "I" marks an inference. A reviewer measured each count, and the coordinating agent checked the counts that the notes call "checked".

## 1. Summary

The module boundaries hold. The adapters import the core only through `mod.ts`. The emitter imports only `ir.ts`, `ids.ts`, `project.ts`, `util.ts`, and `source.ts`. The validator imports only `ir.ts`, `diagnostics.ts`, and `source.ts` (M). The R15b family split and the compile-checked tables (prelude handlers, lowering builders, emitter shape and call rows) already stop most edit omissions.

The remaining coupling has two forms:

- Silent drift. Two units hold the same rule, and no compile check links them. A change to one unit compiles, and the other unit keeps the old rule. IC1, ED2, ED4, IC5, ED6, CK8, and part of CK1 have this form. These items are fragile, so they come first.
- Edit spread. One change needs edits at many sites, but the compiler finds each omission. CK1, CK2, CK3, IC2, IC3, IC4, and ED3 have this form. These items cost time, but they seldom break behavior.

Co-change evidence (M, last 250 commits that touch `src/`). The eight files `check_expr.ts`, `resolve.ts`, `tables.ts`, `ir.ts`, `lower.ts`, `emit/expr.ts`, `emit/walk.ts`, and `validate/expr.ts` changed together in 31 to 47 commits for each pair. Most of these commits added builtins. Commits that touch 5 or more source files fell from 8 of 58 (commits 250 to 150 back) to 5 of 37 (the last 60). Part of this cluster is inherent: the validator must repeat each rule, by design.

## 2. Silent-drift findings (fragile)

### IC1. Lowering repeats the checker's effect rules for pipeline stages (high)

Evidence. `stageEffects` (`lower.ts:1146-1372`) has 227 lines, 105 branches, and cyclomatic 100 (M). 79 of its case labels exist only for exhaustiveness. 10 arms recompute a checker rule. For example, `lower.ts:1275` computes `without(fn.requirements, provider.provides)`, the same rule as `check_builtins/layer.ts:70` (M, checked). The `provide-scope` and `run` arms copy `scope.ts:71,153` and `effect.ts:236-240`.

Cause. The checker stores one combined effect set for each node, and the piped value is part of that set. A union cannot remove the moved left value, so lowering derives the stage set again for each kind.

Failure scenario. A change of the `provide` requirement rule in `layer.ts` changes the direct call. The pipeline form keeps the old set until someone edits `lower.ts`. The validator reports the difference only when a test uses the pipeline form.

Design. The checker computes the stage set where the rule lives. In `pipe` (`check_expr.ts:1626`), the checker calls the handler with a pure left value, `{ type: leftInfo.type, ...PURE_EFFECTS }`. It records the result in a new table field, and then finishes the stage node with `combine([leftInfo, stage])` as now. The node info stays byte-identical, so hover does not change.

```ts
// tables.ts
export interface BodyTable {
  // existing fields
  readonly stageSets: Map<NodeId, EffectSet>;
}
```

Lowering reads `stageSets.get(stage)`. `stageEffects` and the `override` parameter of `invoke` (`lower.ts:771,795-797`) go. Precondition (M, grep only): no handler reads the effect sets of its piped argument. The reviewer found three argument set reads (`stream.ts:459,552,898`), and all three read `args[1]`. Run this audit again before the change. Fallback: keep `stageEffects`, put the 10 rule arms in a table, and remove the 79 labels.

Parity. `deno task check`. `deno task behavior:capture <base> <head>` with zero missing records for lowering, validation, and checking. `fixtures/ir/example/log.ir.json` and the goldens stay byte-identical. Time to stable: days.

### ED2. Rename and contract actions rebuild the project from a copy of the config schema (high)

Evidence. `revisionInputs` (`editor_rename.ts:178-194`) writes `effective.json` again with the keys `host`, `interface`, and `module` (M, checked). `parseConfig` holds the same key list in `TOP_KEYS` and `HOST_KEYS` (`project.ts:113-114`). Rename detects a conflict when the diagnostic count grows (`editor_rename.ts:142`, M, checked). Contract actions use `>=` on the same counts (`editor_actions.ts:145`). Each rename builds a new `Program` from no memo (`editor_rename.ts:132`): 168 to 232 ms on a generated project with 55 files and 2472 functions, against 14 ms for an incremental update (M).

Failure scenarios. A new config key passes `parseConfig`, but `revisionInputs` drops it, so rename checks a different project. A new checker diagnostic in an unrelated healthy module can change the count result.

Design, in three steps:

1. `Revision.inputs(): ReadonlyMap<string, string>` returns the source texts and the config text that `Program` already holds. `revisionInputs` goes. Behavior stays the same.
2. `diagnosticDelta(before, after, edits)` compares diagnostics by code, source, and moved span. It replaces both count tests. This step can change visible results (Decision 2).
3. Optional: `Program.speculate(edits): Result<Revision, ConfigError>` makes a child program with copies of the memo maps, so a rename checks only the edited modules and their importers. The shared append-only `TypeTable` then grows with rejected edits. Measure that growth with bench M4 before acceptance.

Parity. `tests/editor_queries_test.ts`, `tests/lsp_editor_test.ts`, and `deno task check`. Time to stable: days for steps 1 and 2. Step 3 needs measurement.

### ED4. Hover copies the emitter's declaration header (medium)

Evidence. `editor.ts:11-13` imports `bracketed`, `render`, `EmitFailure`, `Scope`, `effectTypeDoc`, and `typeDoc` from the emitter. `functionHeader` (`editor.ts:123-135`) copies `functionDeclaration` (`emit/decls.ts:505-523`). The copy already differs: the emitter prints a return type only for an explicit contract, and hover prints one for every function (M, checked). The difference can be intended, because hover shows the inferred type. The test `tests/editor_test.ts:148` compares the two only for explicit contracts.

Failure scenario. A change to parameter printing in `decls.ts` changes generated files, and hover keeps the old text. No test fails.

Design. `emit/decls.ts` exports one header function with an explicit option for the inferred-result rule:

```ts
export function declarationHeader(
  names: TypeNames, // see IC2
  d: FunctionDecl,
  result: "contract" | "always",
): Doc;
```

The emitter passes `"contract"`, and hover passes `"always"`. Hover then imports one function and no emitter state. Parity: extend `tests/editor_test.ts:148` to every function, with the expected inferred-result difference stated. Goldens stay byte-identical. Time to stable: days (with IC2).

### IC5. The builtin instance id is a string contract (medium-low)

Evidence. `lower.ts:1009` builds `value:<module>#$builtin/<name>/<hash>` (M, checked). `emit/expr.ts:542-555` parses it with `indexOf("#")` and `split("/")[1]`, and it selects `Effect.all` or `forEach` from the name. `evaluatedChildren` and `expectedChildren` also test the id (`emit/expr.ts:2492-2510`).

Failure scenario. A change of the id layout in lowering makes the emitter print `callee(args)` for `all` and `traverse`. Only `deno check` on the generated code then fails.

Design. `ids.ts` owns `builtinInstanceId(module, name, hash): ValueId` and `builtinInstanceName(id): string | undefined`. Lowering and the emitter import both. The validator keeps its own regular expression in `validate/builtins.ts:20`, because it must stay independent. Parity: goldens `collections.ts` and `traverse.ts`, and the lowering capture records. Time to stable: hours.

### ED6. Editor queries hard-code front-end name lists (low)

Evidence. `editor_completion.ts:214-224` lists `Effect`, `Stream`, `Sink`, `Schema`, `Layer`, `SchemaError`, and `SchemaIssue`. These names are not in `BUILTIN_TYPES` (`resolve.ts:154`). `editor_actions.ts:17-18` hard-codes the two schema error ids, and six core files hold the same literals. `editor_tokens.ts:29-39` repeats the contextual keywords of `parse.ts:866,956,1093` (M).

Failure scenario. A new contextual keyword parses, but semantic tokens do not mark it, and no compile error occurs.

Design. Export `CONTAINER_TYPE_NAMES` from `resolve.ts`, `CONTEXTUAL_KEYWORDS` from `parse.ts` or `lex.ts`, and use `SCHEMA_ERROR_ID` and `SCHEMA_ISSUE_ID` from `ir.ts`. The parser reads its keywords from the same constant. Parity: `tests/editor_queries_test.ts`. Time to stable: hours.

### CK8. `ModuleChecker` phases depend on call order (low)

Evidence. `checkType` writes `typeInfos` (`check.ts:1342,1378`), and `checkCycles` (1395) and `checkDepths` (1492) read it. `guardedAliases` is written at 1431 and read at 1494 (M). Only the call order in `run()` (`check.ts:1196-1237`) states the dependency.

Failure scenario. Someone swaps two calls in `run()`. The code compiles, and the depth check skips the guarded aliases.

Design. Pass each phase result as a value: `const infos = lowerTypes(entries); const guarded = checkCycles(infos); checkDepths(infos, guarded);`. Parity: `behavior:capture` check records. Time to stable: hours.

### CK1 (part a). A missing prologue row compiles (medium)

Evidence. `PreludePrologues` is an optional mapped type (`check_expr.ts:270`, M, checked). 92 of 96 call names have a row. A forgotten row compiles and moves the arity test into the handler with no error. Each row also hand-writes its fact kind, so `setRef` with `{ kind: "get-ref" }` compiles (I).

Design. Make the mapped type required, with an explicit `"own-arity"` value for `fail`, `unbrand`, and `Some`. Add one test that each static fact kind equals the kebab form of its name. Parity: type check and `behavior:capture`. Time to stable: hours. Part b is in section 3.

## 3. Edit-spread findings (cost)

### CK1 (part b). One builtin is registered in four checker places

Evidence. A new builtin needs a `PRELUDE` row (`resolve.ts:49-147`), a handler row (`check_expr.ts:1029-1156`), a prologue row (`check_expr.ts:1181-1332`), an import of the family handler, and the family code. `throttleStream` has 24 sites in 9 files (M). Its commit `0cc5349` changed 155 lines of `check_expr.ts`, although no body-checking rule changed (M). The concurrency name union is declared three times (`check_expr.ts:1598-1605`, `collections.ts:30`, `stream.ts`).

Design. Each family exports its rows next to its handlers. A new `check_builtins/registry.ts` composes them:

```ts
export interface BuiltinRow<K extends PreludeCallName, C> {
  readonly prologue: Prologue<K> | "own-arity";
  readonly handle: (c: C, node: NodeId, name: K, args: readonly Arg[], expected: TypeRef | undefined) => NodeInfo;
}
export type Rows<N extends PreludeCallName, C> = { readonly [K in N]: BuiltinRow<K, C> };
// registry.ts
export const BUILTIN_ROWS = { ...STREAM_ROWS, ...SCHEMA_ROWS /* , ... */ } satisfies Rows<PreludeCallName, BodyChecker>;
```

A type test keeps exhaustiveness, and one test asserts that the family name sets are disjoint. `preludeCall`, `runPrologue`, and `arity` stay in `BodyChecker`, and the prologue step order stays. Result: a new stream builtin edits `resolve.ts`, `tables.ts`, and `stream.ts` in the checker. Parity: normalized AST comparison of moved rows, as R15b did, and `behavior:capture`. Time to stable: days.

### CK2. `checkModuleBodies` holds seven concerns and 13 maps

Evidence. `check_project.ts:224-452`: 229 lines, cyclomatic 20, 13 `new Map` sites (M). The concerns are imported values, method types, the value environment, SCC edges, run and commit, the solver loop, and initialization cycles. `values(view)` (261-277) reads `inferred` and `constantTypes`, which `commit` fills later. Only the callee-first SCC order makes that safe. Line 351 passes the live `modes` map as a `ModeLookup`, so readers see later writes (M, checked).

Design. A new `check_bodies.ts` with three units:

```ts
interface ModuleValues {
  environment(view: ModeLookup): BodyEnv;
  publish(run: Run, recursive: boolean): void; // the only write path
}
function moduleValues(d: ModuleDeclarations, interfaces: ReadonlyMap<string, ModuleInterface>): ModuleValues;
function scheduleRuns(entries: readonly Entry[], check: (e: Entry, view: ModeLookup) => Run, publish: ModuleValues["publish"]):
  { runs: readonly Run[]; modes: ModeMap; diagnostics: readonly Diagnostic[] };
function initializationDiagnostics(entries: readonly Entry[]): { graph: InitializationGraph; diagnostics: readonly Diagnostic[] };
```

`normalizeDiagnostics` sorts and removes duplicates, so the push order is not visible (M). Parity: `deno task check`, `behavior:capture`, and the 17 test files that import `check_project.ts`. Time to stable: days.

### IC2. The emitter `Scope` is one object with 44 members in six roles

Evidence. `emit/scope.ts` has 623 lines and 44 public members (M). The roles are names, imports, declaration lookup, helpers, host binding, and id parsers. `emit/expr.ts` makes 159 `this.scope.` calls. `nameOf` records an import as a side effect (`scope.ts:543-561`), so type printing needs the mutable import ledger. `emit.ts:120` states the phase order only in a comment. Hover builds a full `Scope` to print one type (`editor.ts:108`), so hover fails when the module emission fails for an unrelated reason.

Design. Keep one implementation behind role interfaces:

```ts
export interface TypeNames {
  nameOf(id: DeclarationId): string;
  effect(m: EffectModule): string;
  resolve(t: Type): Type;
  typeLevelDeclaration(id: DeclarationId): TypeLevel | undefined;
}
export interface Temporaries { temp(): string; fresh(base: string): string }
export class ModuleScope implements TypeNames, Temporaries { ledger(): ImportLedger }
```

`types.ts`, `fields.ts`, and hover take `TypeNames`. Hover gets a read-only adapter that allocates nothing. `emit.ts` reads `ledger()` after printing, so the phase is explicit. Risk: a hover on a foreign type with a name clash can print `User` where the emitter prints `User$1`. Parity: goldens byte-identical, `tests/editor_test.ts`, `tests/emit_test.ts`. Time to stable: days.

Correction (2026-10-22). The hover claim above is wrong. `backendOf` (`editor.ts:95-117`) tests `revision.emitted(...)` on purpose: the backend line shows the emitted type, so a module that does not emit has no backend type. Hover builds its `Scope` from the same IR and config as the emitter, so the names agree. The shared `Scope` is not a drift risk for hover. ED4 alone removes the hover copy. IC2 stays an edit-spread item and moves to Phase 4.

### IC3. `BodyValidator` has 149 members on one `this`

Evidence. `validate/expr.ts` has 4901 lines, 149 members, and 797 `this.` uses (M). Family sizes: schema 723 lines, stream 666, scope 277, schedule 217, ref and layer 190, codec 157, fiber 116. The schema family uses only `add`, `check`, `env`, and `poison` outside itself.

Design. Repeat the R15b split inside the validator, in `validate/families/<family>.ts`, with a validator-owned context. The validator never imports `check_builtins/`. `compute` stays (section 9).

```ts
export interface ValidatorCore {
  readonly env: TypeEnv;
  add(area: Area, path: string, what: string, span: Span): void;
  check(e: Expr, path: string): Out;
  poison(): Comp;
}
```

Parity: token-identical bodies after `this.` becomes `c.`, the 209 focused validation tests, the 18 `fixtures/validate` cases, and `behavior:capture`. Time to stable: days to weeks.

### ED1. Editor queries read checker and resolver shapes through `Revision`

Evidence. `Revision` exposes `project` and `checked` as public fields (`db.ts:153,155`). Six editor files read `checked.analysis.resolutions` 7 times, `checked.table` 3 times, `BodyTable.info` 3 times, and signature fields 7 times (M). 24 test files read `revision.project.*`, and 2 read `revision.checked.*`. Seven sites scan modules linearly to find a path.

Failure scenario. A change of `BodyTable.info` to a method needs 5 edits in 3 editor files and changes in 26 test files.

Design. A read-only view in `src/core/revision_view.ts`, or methods on `Revision`:

```ts
interface ModuleView {
  readonly name: string; readonly path: string; readonly tree: SyntaxTree;
  declByName(name: string): DeclEntry | undefined;
  targets(): Iterable<[NodeId, Target]>;
  nodeInfo(node: NodeId): NodeInfo | undefined;
  functions(): Iterable<FunctionView>;
}
// Revision
moduleAt(path: string): ModuleView | undefined;
moduleNamed(name: string): ModuleView | undefined;
typeText(ref: TypeRef): string;
```

Later, `checked` and `project` become private, and tests move to the view (ED7). Parity: `tests/editor_queries_test.ts`, `tests/editor_test.ts`. The capture does not record editor queries, so the tests are the oracle. Time to stable: days.

### ED3. `lsp/projects.ts` holds five concerns, and the save round repeats the CLI watch round

Evidence. `projects.ts` has 643 lines (M): project state 97, discovery 55, overlay notifications 112, save round 101, publishing 123. `saveRound` has cyclomatic 19. Module-removal tracking exists twice with different rules (`cli/main.ts:52-79` and `projects.ts:94-97,467-477`). The write path also exists twice (`build.ts:75-90` and `projects.ts:479-493`).

Design. `src/host/save_round.ts` holds one `runSaveRound` for the CLI watch loop and the LSP. `src/lsp/publish.ts` becomes the only file that imports the protocol `Diagnostic`. `src/lsp/overlay.ts` holds the document notifications. Each sort order stays separate (section 9). Decision 3 covers the different removal rules. Parity: `lsp_server_test`, `lsp_save_round_test`, `cli_test`. The capture records nothing from subprocesses, so compare the asserted `publishDiagnostics` sequences. Time to stable: days to weeks.

### Smaller items

| ID | Problem (M unless marked) | Design | Time |
| --- | --- | --- | --- |
| CK3 | Patterns (358 lines, 14 members) and binary operators (166 lines) remain in `BodyChecker`. `errorCount` is a hidden channel to `tryExpr`. | `check_patterns.ts` and `check_binary.ts` with narrow contexts. `tryExpr` gets the count as a return value. | days |
| CK4 | Family contexts declare `tree` 6 times, `kids` 5, and `fact` 5. | Shared `SyntaxView`, `FactView`, and `FactWriter` in `context.ts`. Move `nameTextOf` to `syntax_queries.ts`. | hours |
| CK5 | The body result shape is copied 3 times. The function-type build is copied 4 times. | One `FunctionBody { signature; bodyNode; run }` and one `functionTypeOf`. | hours |
| CK6 | Union order falls back to the type reference number (`types.ts:685-687`). Whether two refs share one IR key needs measurement. | Probe the fixtures. With 0 collisions, replace the fallback with an invariant throw. | hours |
| CK7 | `check_project.ts:244` parses the capability id text because imported methods are not in `methodTypes`. | Fill `methodTypes` for imported services in `checkModuleDeclarations`. | hours |
| IC4 | `structural` (542 lines, cyclomatic 69) and `leaf` (227 lines) mix target naming, temporaries, and 10 hand-written IR shape assertions. | `resolvedAs(t, kind)` for the assertions. One `targetCall` value and printer for the call arms. | days |
| IC6 | 223 hand-written path suffixes in the validator. | `sub<E>(path, field: keyof E & string)`. | hours |
| IC7 | Three emitter Type walkers. All end in `never`, and the kinds are fixed with `ir.ts`. | Low value. Do only if the files change anyway. | hours |
| ED5 | Generated-text staleness is tracked twice (`lsp/features.ts:181-269`, `playground/src/compile.ts:131-163`). | One `GeneratedTracker` in the core. | hours |
| ED7 | 8 `mod.ts` exports have no user outside the core. One adapter reads `checked.table.size`. | Add `Revision.typeTableSize`, remove the 8 exports, and make `checked` and `project` private after ED1. | hours |

## 4. Already well decoupled

The reviewers checked these units and found no defect to report (M). `PRELUDE_HANDLERS` is a required mapped type. `POSITIONAL_BUILDERS` and `SpecialKind` are checked in both directions. `emit/shape.ts` derives the walkers, and `emit/calls.ts` with the default arms rejects a missing kind. `validate/world.ts` walks with one `typeChildren`. `ModeLookup` has only a getter. `modes.ts` and `initialization.ts` are pure. `checkModuleStep` is shared by both drivers. The `GeneratedSource` port takes four queries. `diffFiles` is complete for the CLI and the LSP, and the playground needs no removal. Protocol types stay in `src/lsp/`.

## 5. Proposed order

Phase 1 (silent drift, small): IC5, ED6, CK8, CK1a, ED2 step 1, and the CK6 probe. Each item takes hours, keeps behavior, and has its own commit.

Phase 2 (one owner for each rule): IC1, then ED4, then CK2. Each item changes a contract between two stages, so each needs the Fable plan check first. IC2 moved to Phase 4 (see the IC2 correction).

Phase 3 (editor boundary): ED1, then ED7, then ED2 step 2 under Decision 2.

Phase 4 (edit spread): CK1b, CK3, CK4, CK5, IC2, IC3, IC4, IC6, ED3, and ED5. These items reduce edit count and do not fix a drift risk.

Each unit runs `deno task check` and a `behavior:capture` with constant test inputs before its commit. Do not run `golden:update` or `validate:update`.

## 6. Decisions for the user

Decision 1 (scope). Options: (a) Phases 1 and 2. (b) Phases 1 to 3. (c) All phases. (d) Phase 1 only. Recommendation: (a), because it removes the silent-drift risks and leaves the cost items for later.

Decision 2 (rename conflict test, ED2 step 2). Options: (a) Replace the count tests with `diagnosticDelta`, which can change some rename and action results. (b) Keep the count tests. Recommendation: (a), with each changed result listed in the commit.

Decision 3 (module removal rule, ED3). The LSP keeps a module after a failed removal, and the CLI watch loop does not. Options: (a) Keep both rules as parameters of one `runSaveRound`. (b) Use the LSP rule in both. Recommendation: (a), because it keeps behavior.

Decision 4 (hover result rule, ED4). Options: (a) Hover keeps the return type for inferred functions, as an explicit option of the shared header. (b) Hover matches the emitter exactly. Recommendation: (a), because hover then still shows the inferred type.

## 7. Implementation plan for Phases 1 and 2

Base: `98df0ef` or later on local `main`. Each unit is one commit. Each unit keeps behavior unless its text states an exact visible change. Each commit passes `deno task check`. A unit that keeps behavior also passes `deno task behavior:capture <previous-commit> <unit-commit>` with zero missing records and zero new records. Run captures one at a time. Never run `golden:update` or `validate:update`. Section 9 of the rederive review applies.

Plan check (2026-10-22). A Fable agent checked this section against the code. It rated CK8, CK1a, CK2, and ED4 sound, and IC5, ED6, ED2 step 1, IC1a, and IC1b sound with changes. This section includes those changes. It also found one existing defect: `makeJob() |> scoped` passes the checker, but its IR fails validation with `validation/003` and `validation/004`, because `stageEffects` has no arm for `scoped` and `forkScoped`. The coordinator reproduced the defect on `98df0ef`. IC1b fixes it, because lowering then uses the checker's own set.

### Phase 1

IC5 (builtin instance id). Add to `src/core/ids.ts`:

```ts
/** The identity of a closed builtin instance: `value:<module>#$builtin/<name>/<hash>`. */
export function builtinInstanceId(module: string, name: string, hash: string): ValueId;
/** The builtin name of an instance identity, or undefined for any other identity. */
export function builtinInstanceName(id: string): string | undefined;
```

`builtinInstanceName` keeps the rule of `builtinName` in `emit/expr.ts:542-548` and adds a `value:` prefix test: the text after the first `#` must start with `$builtin/`, and the result is the next `/`-separated part. Reachable callee targets are value or local ids, so the prefix test changes no output (I). `lower.ts:1009` calls `builtinInstanceId`. `emit/expr.ts` deletes `builtinName` and calls `builtinInstanceName` at its three call sites (`effectCollectionBuiltin`, `:1858`, `:2159`). The validator regular expression in `validate/builtins.ts:20` and the message in `validate/world.ts:963` stay, because the validator must stay independent. Add one test in a new `tests/ids_test.ts` that round-trips an id and rejects `value:m#map` and `type:m#$builtin/x/1`.

ED6 (editor name lists). In `editor_completion.ts`, the `"type"` context offers `BUILTIN_TYPE_NAMES`, every key of `TYPE_WORDS` (`syntax.ts:159`), and the Effect error names. In `resolve.ts`, export `EFFECT_ERROR_IDS: ReadonlyMap<string, ErrorId>` with `SchemaError` to `SCHEMA_ERROR_ID` and `SchemaIssue` to `SCHEMA_ISSUE_ID` (from `ir.ts`). Use it in `resolve.ts:738-743` and `:759-764`, in the `"fails"` completion context, and in `editor_actions.ts:17-18`. Visible change: type completion gains eight words: `Schedule`, `SchemaOptional`, `SchemaEncodedOptional`, `SchemaDecodedOptional`, `SchemaConstructorDefault`, `SchemaOptionalConstructorDefault`, `SchemaEncodedOptionalConstructorDefault`, and `SchemaDecodedOptionalConstructorDefault`. The parser and checker accept each one in any type position, although the `Schema*` words mean something only as struct field schemas. The completion list is sorted (`editor_completion.ts:103-106`), so the order of the source lists has no effect. No test pins the type list, so add an assertion in `tests/editor_queries_test.ts` that the type context offers the current words and the eight added words. Name the added words in the commit body. The capture does not record editor queries, so this change gives no capture difference. The contextual-keyword part of ED6 is dropped: the parser tests words by position and also tests `from`, `void`, and `_`, so a shared list would not let the compiler catch a new keyword.

CK8 (ModuleChecker phase values). In `check.ts`, `checkType` returns its `TypeNodeInfo` values to `run()`, or `run()` collects them in a local array. `checkCycles(infos)` returns the guarded alias set. `checkDepths(infos, guarded)` takes both. Delete the fields `typeInfos` and `guardedAliases`. `checkError` keeps its behavior; if it also writes type infos today, it returns them the same way. Diagnostic order inside `sink` must not change, so keep the call order of `run()`.

CK1a (required prologue rows). Change `PreludePrologues` (`check_expr.ts:270`) to `{ readonly [K in PreludeCallName]: Prologue<K> | "own-arity" }`. 92 of the 95 call names have a row now. Add rows `fail: "own-arity"`, `Some: "own-arity"`, and `unbrand: "own-arity"`. `preludeCall` (`:982`) runs the prologue only when the row is not `"own-arity"`. Optional, only if it compiles without changing a row: restrict a static `fact` object in `PrologueFacts<K>` to `NodeFact & { readonly kind: Kebab<K> }`, where `Kebab` converts camel case to kebab case at the type level. The validator measured that every static `fact` kind and every `bailFact` kind equals the kebab form of its name, so the restriction can also cover `bailFact`. If it does not compile, drop the option and report why.

ED2 step 1 (revision inputs). `Revision` gets a private field with a snapshot of `Program.files` at the time of `update`, and a method `inputs(): ReadonlyMap<string, string>`. `Program.check` passes `new Map(this.files)`. `Program.files` holds only `.eff`, `.effi`, and the root `effective.json`, with root-relative keys (M). Delete `revisionInputs` from `editor_rename.ts`; `mod.ts` does not export it and no test imports it. `renameAt` and `contractActionsAt` call `new Map(revision.inputs())`, then apply their edits. Visible change: the speculative program now reads the real config text. A config with unknown keys gives `module/001` diagnostics. Today they count in the base revision but not in the speculative program, so a rename that adds up to that many new diagnostics passes. After this unit, both sides count them, so such a rename is rejected. Contract actions change the same way. Add one test for this case in `tests/editor_queries_test.ts`, and state the change in the commit body. The capture records each `Program.update`, and the inputs of the speculative programs now include the real config text, so `program` records can change their input hash. Judge this unit with the capture and accept only differences in `program` input hashes whose diagnostic lists stay equal. Also run `tests/editor_queries_test.ts` and `tests/lsp_editor_test.ts`.

CK6 (probe, no commit). The coordinator adds a temporary counter in `TypeTable.union` for ties where `irKey(a) === irKey(b)` and `a !== b`, runs `deno task test`, records the count in this section, and reverts the probe. With 0 ties, a later unit replaces `|| a - b` with an internal invariant throw. With any ties, the fallback stays and this section records the cases.

CK6 result (2026-10-22, base `98df0ef`). A probe in a detached worktree counted the comparisons in `TypeTable.union`. The fast suite (1833 tests; the core boundary test fails because of the probe) made 4075 comparisons in 48 test isolates, and 0 were ties (M). The slow suite was not probed, because its subprocesses may not have write access. A later unit can replace `|| a - b` with an invariant throw. That unit runs the slow suite too, because a throw there would fail visibly.

### Phase 2

IC1 has two commits.

IC1a (tests first). `tests/lower_stage_effects_test.ts` already pins `retrySchedule`, retry with a schedule, `defer`, `run`, and `provide` with an effectful left value (M). Add cases to that file for the remaining arms: `call`, `perform`, `fail`, `retry` with a count, `closeScope`, `provideScope`, `addScopeFinalizer`, and a builtin call. Each case asserts that lowering succeeds and validation reports no diagnostic. Also add `scoped` and `forkScoped` cases with an effectful left value, such as `makeJob() |> scoped`. Today these two kinds have no arm in `stageEffects`, so lowering records the wrong set, and validation reports `validation/003` and `validation/004` (M, reproduced on `98df0ef`). In IC1a, these two cases assert the current diagnostics, with a comment that IC1b fixes them. Commit IC1a alone, after `deno task check`.

IC1b (one owner). In `pipe` (`check_expr.ts:1626`), when `leftInfo` is not quiet (mode `pure` with empty failures and requirements), call `invoke` with `pre: { type: leftInfo.type, ...PURE_EFFECTS }`. Record the returned effect set in a new `BodyTable` field `stageSets: Map<NodeId, EffectSet>` under the stage node. Then call `finish(stage, q.type, combine([leftInfo, q]))` and finish the pipe node with the same set as now. When `leftInfo` is quiet, keep the current call and record nothing. In `lower.ts`, `stage()` uses `stageSets.get(stage)` as the override set when the left value is not quiet. Delete `stageEffects`, the `override` parameter of `invoke` (its only caller is `stage()`; `lower.ts:758` passes undefined), and the `stageEffects` reference in the header comment at `lower.ts:6`. In the same commit, change the two `scoped` and `forkScoped` cases of IC1a to assert no diagnostic. Precondition: before IC1b, run `git grep` for handler reads of `args[0]` effect sets (`isPureInfo`, `.failures`, `.requirements`, `.mode`) in `check_builtins/` and `check_expr.ts`. If any handler reads the piped argument's sets, stop and report it. The validator found none: `isPureInfo` reads only `args[1]`, and each `.pre` read is a presence test (M). Known visible changes: (1) the `scoped` and `forkScoped` pipelines with an effectful left value now lower to valid IR; (2) `takeSink`, `layer`, and `schemaIdentityCall` drop the first argument's set from their result, but each one rejects a pipeline with a diagnostic, so only the stage node info of that rejected pipeline changes, and only hover shows it. Parity: capture between IC1a and IC1b. Accept only the missing and new `lower` and `validate` records of the two flipped `scoped` and `forkScoped` cases. The goldens and `fixtures/ir/example/log.ir.json` stay byte-identical.

ED4 (shared header). In `emit/decls.ts`, export `functionHeaderDoc(scope: Scope, d: FunctionDecl, result: "contract" | "always"): Doc` and `constantTypeDoc(scope: Scope, d: ConstantDecl): Doc`. `functionDeclaration` uses `functionHeaderDoc(this.scope, d, "contract")`, and `constantDeclaration` uses `constantTypeDoc`. `editor.ts` deletes `functionHeader` and `constantType`, and renders `functionHeaderDoc(scope, d, "always")` and `constantTypeDoc(scope, d)` at `FLAT_WIDTH`. `"always"` prints the result type for every function, as hover does now. The parameter list uses `property` as the emitter does; at flat width it prints the same text as hover prints now. A probe over 188 headers of the 8 clean fixture projects found 0 differences between the two renderings (M). The four functions of `users.eff` all have explicit contracts, so `tests/editor_test.ts:148` already covers them, and `tests/editor_test.ts:183` pins the inferred rule. Keep both tests unchanged. Parity: goldens byte-identical, capture with zero missing and zero new records.

CK2 (body scheduling). Split `checkModuleBodies` (`check_project.ts:224-452`) in the same file, or in a new `check_bodies.ts` that `check_project.ts` imports:

- `moduleValues(args)` owns `importedValues`, `methodTypes`, `inferred`, `constantTypes`, `functions`, `constants`, and `modes`. It returns `environment(view)`, `publish(run, recursive)`, `settledModes(): ModeLookup`, and `bodies()`. `publish` is the only writer of the maps, with the body of `commit` unchanged.
- `scheduleRuns(entries, edges, values, diagnostics)` holds the SCC loop and the solver, unchanged.
- `initializationDiagnostics(entries)` returns the graph and the `module/004` diagnostics, unchanged.
- `checkModuleBodies` composes them and keeps the final source-order loop.

No message, code, span, or order changes. Keep the order: the SCC runs first, then the `module/004` diagnostics, because `normalizeDiagnostics` resolves exact duplicates in push order (`diagnostics.ts:405-430`). Parity: capture with zero missing and zero new records, and the test files that import `check_project.ts`.

### Review and handoff

The implementer commits each unit after `deno task check`, and does not push. The coordinator reviews each commit diff line by line, runs `deno task check` and each capture, and records the result in this section. A failed unit goes back to the implementer with exact findings.

### Phase 1 results (2026-10-22)

The five units are on local `main`: IC5 `7b49fc0`, ED6 `47c6e05`, CK8 `32da06a`, CK1a `b7a405c`, and ED2 step 1 `16efd9d`. The implementer ran `deno task check` before each commit; the last gate passed 1837 fast and 177 slow tests. The coordinator reviewed each diff line by line. CK1a also took the optional `Kebab` restriction, so a static `fact` or `bailFact` with a wrong kind is now a compile error. The shared Schema prologue has its own type, `SharedPrologue`, because about 18 names share one row with a function fact.

Captures used temporary commits with the documented write overlay for `tests/parse_chain_slow_test.ts` on both sides, and one test set on both sides:

- IC5, ED6, CK8, and CK1a: source of `924f9aa` against source of `b7a405c`, both with the `924f9aa` tests. Each side had 9082 records, with 0 new and 0 missing.
- ED2 step 1: source of `b7a405c` against source of `16efd9d`, both with the `b7a405c` tests. Single-revision captures gave 679 `program` records on each side. Exactly 11 records differ, all `program`, and they pair one to one by diagnostic hash. So only the input hashes of the speculative rename and action programs changed, as planned. A first two-revision run also lost 4 `program` records that both single runs contain; that loss is run variance, probably from a timing-dependent slow test (not confirmed).

### Phase 2 results (2026-10-22)

The four units are on local `main`: IC1a `ebfcc28`, IC1b `ee77782`, ED4 `0f693bd`, and CK2 `6fa11fb`. The coordinator added `67333cb` after review: IC1b had left two copies of the quiet test, an inline one in the checker's `pipe` and `isQuiet` in lowering. `tables.ts` now owns `isQuiet`, and both stages import it. The validator keeps its own helper. The last gate passed 1847 fast and 177 slow tests.

Deviations from the spec, accepted after review. `ModuleValues` also has `settle(modes)`, so the solver result goes through the same owner as `publish`. Lowering reads `stageSets` in `invoke`, because the `override` parameter is gone, and `stage()` requires an entry when the left value is not quiet.

IC1b fixed the found defect. The coordinator's reproduction (`makeJob() |> scoped`) gave 3 validation diagnostics on `98df0ef` and 0 on `67333cb`. The IC1a tests pinned the wrong sets, and IC1b changed them to the checker's sets.

Capture: source of `ebfcc28` against source of `67333cb`, which covers IC1b, ED4, CK2, and the fix. Both sides used the IC1a tests without the two `scoped` and `forkScoped` cases, because those cases change their expected result between the revisions. Both sides also used the write overlay. Each side had 9109 records, with 0 new and 0 missing. That run includes the 8 new stage cases with an effectful left value. No file under `fixtures/` changed between `98df0ef` and `67333cb`.

Size (M, `scripts/measure.ts` over `src/core`, `98df0ef` against `67333cb`): filtered lines 34,502 to 34,393, and AST branches 8,065 to 7,961. `lower.ts` falls from 1948 to 1707 raw lines.

Remaining: Phases 3 and 4 are not started. Decisions 2 and 3 wait for ED2 step 2 and ED3. The capture still needs the write overlay for `tests/parse_chain_slow_test.ts`; this batch did not change that test.

## 8. Implementation plan for Phase 3

Base: `430460b` or later on local `main`. The user started Phase 3 on 2026-10-22. Decision 2 is (a), from the answer "as recommended". The rules of section 7 apply: one commit for each unit, `deno task check` before each commit, captures one at a time, and no `golden:update` or `validate:update`. Each capture runs the base tests on both sides with the write overlay, as in Phases 1 and 2. The new tests add `program` records, so a capture with the new tests on one side only would show new records for a sound change.

Measurements for this section (M, 2026-10-22, base `430460b`). In a probe worktree, `project` and `checked` of `Revision` were made private. `deno check` over `src`, `playground`, `tests`, `scripts`, and `bench` then gave 35 errors in 13 files. The editor files have 26 of them: `editor.ts` 8, `editor_completion.ts` 6, `editor_index.ts` 4, `editor_actions.ts` 4, `editor_rename.ts` 3, and `editor_tokens.ts` 1. The adapters have 7: `cli/build.ts` 2, `lsp/features.ts` 2, `lsp/projects.ts` 1, `host/outputs.ts` 1, and `playground/src/compile.ts` 1. The tests have 2: `tests/editor_test.ts:110` and `tests/chain_helpers.ts:69`.

Corrections to section 3. ED1 said that 24 test files read `revision.project.*` and 2 read `revision.checked.*`. That count came from a text search that also matched other objects. The compiler count is 2 test reads in total.

ED7 said that 8 `mod.ts` exports have no user outside the core. A name search over every `.ts` file outside `src/core` finds 20 such names. Only 4 of them are values: `methodOfCapability`, `moduleOfId`, `nameOfId`, and `readConfig`. The other 16 are types, and several of them name the result of a public function, for example `Completion` and `HoverBackend`. A public signature needs its types, so ED7 keeps the 16 type exports.

`docs/api.md:271` documents the `Revision` queries and does not name `project` or `checked`. `deno.json` exports `src/core/mod.ts` as the package `@srdjan/effective-lang` 0.6.0. So the private fields and the 4 removed values are a change of the package surface, but not of its documented contract. Each commit body states the change.

### ED1 (read-only queries on `Revision`)

Add these members to `Revision` in `src/core/db.ts`. The design puts methods on `Revision`, not a separate view file, because each query is a lookup in data that `Revision` already holds.

```ts
/** The project root. */
get root(): string;
/** The project configuration. */
get config(): ProjectConfig;
/** The type table of this revision, read-only. */
get types(): TypeReader;
/** The module infos in discovery order. */
moduleInfos(): Iterable<ModuleInfo>;
/** The module info of a module name. */
moduleInfo(name: string): ModuleInfo | undefined;
/** The module info of a root-relative file path. */
moduleInfoAt(path: string): ModuleInfo | undefined;
/** The checked module of a root-relative file path. */
checkedModuleAt(path: string): CheckedModule | undefined;
/** The resolver result of a module name. */
resolution(name: string): ModuleResolution | undefined;
/** The sorted module names that a module imports, or an empty list. */
imports(name: string): readonly string[];
/** The index entry of a declaration identity, or undefined for a malformed or unknown id. */
declEntry(id: string): DeclEntry | undefined;
/** Independent validation of the lowered modules, as `validateProject` with this project. */
validate(lowered: ReadonlyMap<string, Result<ModuleIR, LowerError>>): ReadonlyMap<string, readonly Diagnostic[]>;
```

`TypeReader` is a new export of `src/core/types.ts`: `export type TypeReader = Pick<TypeTable, "show" | "node" | "aliasOf" | "brandBaseOf" | "errorRecordOf" | "error" | "size">`. `Revision.types` is public, so `mod.ts` exports `TypeReader`. It also exports `TypeNode` and `TypeRef`, because `TypeReader` names them. The getter returns the same table object. The type only hides the writers.

`moduleInfoAt` and `checkedModuleAt` use one path map that `Revision` builds on first use and keeps. One path names one module, because the module name derives from the path, so a map gives the same result as today's first match. `moduleInfos()` iterates `project.modules` in its own order, because `symbolIndex` builds its occurrence lists in that order. `declEntry` moves the body of `declEntryOf` from `editor.ts` and the owner lookup from `declarationOf` in `editor_index.ts` into one method, with `moduleOfId` and `nameOfId` from `ids.ts`.

Then change every editor and adapter read from the measurement list to these members. Keep each result and its order. Delete `moduleAt` and `declEntryOf` from `editor.ts`. At `editor_tokens.ts:67` and `editor_completion.ts:191`, the path can be undefined (`declaration?.source`). Keep a guard there that gives undefined, as the current `find` does.

In `editor_index.ts`, `declarationOf` keeps its signature and calls `revision.declEntry`. In `lsp/features.ts`, `effModuleOf` becomes `revision.moduleInfoAt(path)` with the `mode === "eff"` test. `host/outputs.ts` and `lsp/projects.ts` use `revision.imports(name)` and `revision.moduleInfo(target)?.mode`. `cli/build.ts` uses `revision.validate(lowered)` and `revision.config`. `playground/src/compile.ts` uses `revision.moduleInfos()`. `lsp/features.ts:317` uses `revision?.types.size ?? 0`.

Do not make the fields private in this unit.

`Revision.validate` keeps the validator independent: `db.ts` imports `validate_project.ts`, and no validator file imports `db.ts`. The plan check proposed a sources overload of `validateProject` instead. The coordinator kept `validate`, because it leaves the public signature of `validateProject` unchanged.

Add the members to the `Revision` paragraph of `docs/api.md`. Add one test in `tests/db_test.ts` that checks `moduleInfoAt`, `checkedModuleAt`, `imports`, and `declEntry` on a two-module project. Include an unknown path and a malformed id. The test also pins the order of `moduleInfos()`: `b.eff` imports `a.eff`, so `moduleInfos()` gives b then a, and `moduleNames()` gives a then b.

Parity: `deno task check`, and a capture against the previous commit with zero new and zero missing records. The capture does not record editor queries, so `tests/editor_queries_test.ts`, `tests/editor_test.ts`, and the LSP tests are the oracle for them.

### ED7 (private fields and a smaller package surface)

Make `project` and `checked` of `Revision` private. Move the two test reads: `tests/editor_test.ts:110` reads `revision.types`, and `tests/chain_helpers.ts:69` calls `revision.value.validate(...)`. Remove `methodOfCapability`, `moduleOfId`, and `nameOfId` from the `mod.ts` re-exports, and remove `readConfig` from them too. Each of them stays exported from its own file for the core. Before the removal, search `docs/`, `README.md`, `editors/`, `bench/`, and `scripts/` for each of the 4 names again, and stop if one has a user. Keep all 16 type exports.

Parity: `deno task check`, and a capture with zero new and zero missing records. The commit body lists the 4 removed values and the two private fields. The version in `deno.json` stays 0.6.0, because a release is the user's decision. The commit body states that the next release should be a minor version.

### ED2 step 2 (diagnostic comparison, Decision 2a)

Add `src/core/diagnostic_delta.ts`:

```ts
/** The diagnostics that an edit adds and removes, by code, source, and moved span. */
export interface DiagnosticDelta {
  readonly added: readonly Diagnostic[];
  readonly removed: readonly Diagnostic[];
}
export function diagnosticDelta(
  before: readonly Diagnostic[],
  after: readonly Diagnostic[],
  edits: readonly SourceEdit[],
): DiagnosticDelta;
```

The key of a diagnostic is its code, its span source, and its span start and end. The function moves each span of `before` through `edits`. A position moves by the length change of each edit in the same source whose end is at or before the position. A position strictly inside an edit does not move. An empty edit at offset p moves a start at p, but it does not move an end at p.

The function compares the keys as multisets, so two equal diagnostics count twice. The message text is not part of the key, because a rename changes names in messages. The function does not use `movedSpan` of `editor_rename.ts`, because `movedSpan` does not move the end of a span that contains an edit.

Rename (`editor_rename.ts:140-147`) rejects when `diagnosticDelta(before analysis diagnostics, after analysis diagnostics, edits).added` is not empty. Keep the analysis diagnostics as the compared set and keep the error message. Contract actions (`editor_actions.ts:147`) skip an action unless `added` is empty and `removed` is not empty. They compare `revision.diagnostics` with the diagnostics of the speculative revision, and they use the merged edits.

Known visible changes. A rename that removes one analysis diagnostic and adds another passes today and is rejected after this unit. A contract action that removes two diagnostics and adds one is offered today and is skipped after this unit. A rename or action is no longer affected when an unrelated diagnostic moves only because of the edit.

Measure the visible change before the commit with a temporary probe that is not committed. It runs over the 14 fixture directories that hold an `effective.json` (`find fixtures -name effective.json`). For each identifier occurrence, the probe calls `renameAt` with the new name `renamedProbe`. The plan check measured 2800 such calls in 15.4 s. Only the 6 `errors/` fixtures have diagnostics, so only they can show a rename difference.

The fixtures offer 0 contract actions, so the probe also changes the fixtures for actions. For each function with an explicit contract and a `fails` or `uses` clause, the probe deletes that clause text. Then it calls `contractActionsAt` on the function span of the changed project, under the old and the new rule. The probe compares the old and the new results. List each difference in the commit body. With no difference, state that the probe found none, and state how many renames and actions it ran.

Add three tests for `diagnosticDelta` to `tests/editor_queries_test.ts`. In the first, an edit before a diagnostic moves it. Use the source that the plan check measured: a file with an unrelated `unknown-name/001` and a parameter `a`. The rename of `a` to `top` moves the diagnostic from 93-100 to 97-104. In the second, an edit inside a diagnostic span moves only its end. In the third, a duplicate diagnostic counts twice.

Also add one rename test where the count stays equal but a new analysis diagnostic appears. The rename must now be rejected.

The test asserts the full error text of the diagnostic check. A test of `ok === false` alone does not show which check rejected the rename. The text is "The new name is reserved or conflicts with an existing binding." The plan check tried five such sources, and the occurrence checks or the count test reject each of them today. If the implementer finds no such source, the implementer reports that and adds the `diagnosticDelta` tests only.

Parity: `deno task check`, `tests/editor_queries_test.ts`, `tests/lsp_editor_test.ts`, and a capture with zero new and zero missing records. The speculative programs get the same inputs as before, so their `program` records stay equal.

### Phase 3 results (2026-10-22)

ED1 is `8ff12fa` and ED7 is `7c8a185`. The implementer ran `deno task check` before each commit; both gates passed 1848 fast and 177 slow tests. The coordinator reviewed both diffs line by line.

Deviations, accepted after review. The order claim of the ED1 test was wrong, and the plan check repeated it. The loader queues the entry files in sorted path order, so `b.eff` that imports `a.eff` still loads a before b. The test now lets `a.eff` import `b.eff`: `moduleInfos()` gives a then b, and `moduleNames()` gives b then a. The plan also missed one read: the rename count test reads the analysis diagnostics. `Revision` has one more getter, `analysisDiagnostics`.

Captures used temporary commits with the write overlay on both sides. ED1: source of `d7338bf` against source of `8ff12fa`, both with the `d7338bf` tests. The first two-revision run gave 9118 against 9115 records, with 0 new and 3 missing. The 3 missing records were clean `program` records (result `[]`) of two inputs. Single-revision runs of both sides then gave 9115 records each, with equal record sets, and neither run held the 3 records. So the 3 records were extra updates in the first base run, which is run variance. ED7: source of `8ff12fa` against source of `7c8a185`, both with the `7c8a185` tests. Each side had 9116 records, with 0 new and 0 missing.

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

Evidence. `revisionInputs` (`editor_rename.ts:178-194`) writes `effektive.json` again with the keys `host`, `interface`, and `module` (M, checked). `parseConfig` holds the same key list in `TOP_KEYS` and `HOST_KEYS` (`project.ts:113-114`). Rename detects a conflict when the diagnostic count grows (`editor_rename.ts:142`, M, checked). Contract actions use `>=` on the same counts (`editor_actions.ts:145`). Each rename builds a new `Program` from no memo (`editor_rename.ts:132`): 168 to 232 ms on a generated project with 55 files and 2472 functions, against 14 ms for an incremental update (M).

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

ED2 step 1 (revision inputs). `Revision` gets a private field with a snapshot of `Program.files` at the time of `update`, and a method `inputs(): ReadonlyMap<string, string>`. `Program.check` passes `new Map(this.files)`. `Program.files` holds only `.eff`, `.effi`, and the root `effektive.json`, with root-relative keys (M). Delete `revisionInputs` from `editor_rename.ts`; `mod.ts` does not export it and no test imports it. `renameAt` and `contractActionsAt` call `new Map(revision.inputs())`, then apply their edits. Visible change: the speculative program now reads the real config text. A config with unknown keys gives `module/001` diagnostics. Today they count in the base revision but not in the speculative program, so a rename that adds up to that many new diagnostics passes. After this unit, both sides count them, so such a rename is rejected. Contract actions change the same way. Add one test for this case in `tests/editor_queries_test.ts`, and state the change in the commit body. The capture records each `Program.update`, and the inputs of the speculative programs now include the real config text, so `program` records can change their input hash. Judge this unit with the capture and accept only differences in `program` input hashes whose diagnostic lists stay equal. Also run `tests/editor_queries_test.ts` and `tests/lsp_editor_test.ts`.

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

`docs/api.md:271` documents the `Revision` queries and does not name `project` or `checked`. `deno.json` exports `src/core/mod.ts` as the package `@srdjan/effektive-lang` 0.6.0. So the private fields and the 4 removed values are a change of the package surface, but not of its documented contract. Each commit body states the change.

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

Measure the visible change before the commit with a temporary probe that is not committed. It runs over the 14 fixture directories that hold an `effektive.json` (`find fixtures -name effektive.json`). For each identifier occurrence, the probe calls `renameAt` with the new name `renamedProbe`. The plan check measured 2800 such calls in 15.4 s. Only the 6 `errors/` fixtures have diagnostics, so only they can show a rename difference.

The fixtures offer 0 contract actions, so the probe also changes the fixtures for actions. For each function with an explicit contract and a `fails` or `uses` clause, the probe deletes that clause text. Then it calls `contractActionsAt` on the function span of the changed project, under the old and the new rule. The probe compares the old and the new results. List each difference in the commit body. With no difference, state that the probe found none, and state how many renames and actions it ran.

Add three tests for `diagnosticDelta` to `tests/editor_queries_test.ts`. In the first, an edit before a diagnostic moves it. Use the source that the plan check measured: a file with an unrelated `unknown-name/001` and a parameter `a`. The rename of `a` to `top` moves the diagnostic from 93-100 to 97-104. In the second, an edit inside a diagnostic span moves only its end. In the third, a duplicate diagnostic counts twice.

Also add one rename test where the count stays equal but a new analysis diagnostic appears. The rename must now be rejected.

The test asserts the full error text of the diagnostic check. A test of `ok === false` alone does not show which check rejected the rename. The text is "The new name is reserved or conflicts with an existing binding." The plan check tried five such sources, and the occurrence checks or the count test reject each of them today. If the implementer finds no such source, the implementer reports that and adds the `diagnosticDelta` tests only.

Parity: `deno task check`, `tests/editor_queries_test.ts`, `tests/lsp_editor_test.ts`, and a capture with zero new and zero missing records. The speculative programs get the same inputs as before, so their `program` records stay equal.

### Phase 3 results (2026-10-22)

ED1 is `8ff12fa` and ED7 is `7c8a185`. The implementer ran `deno task check` before each commit; both gates passed 1848 fast and 177 slow tests. The coordinator reviewed both diffs line by line.

Deviations, accepted after review. The order claim of the ED1 test was wrong, and the plan check repeated it. The loader queues the entry files in sorted path order, so `b.eff` that imports `a.eff` still loads a before b. The test now lets `a.eff` import `b.eff`: `moduleInfos()` gives a then b, and `moduleNames()` gives b then a. The plan also missed one read: the rename count test reads the analysis diagnostics. `Revision` has one more getter, `analysisDiagnostics`.

Captures used temporary commits with the write overlay on both sides. ED1: source of `d7338bf` against source of `8ff12fa`, both with the `d7338bf` tests. The first two-revision run gave 9118 against 9115 records, with 0 new and 3 missing. The 3 missing records were clean `program` records (result `[]`) of two inputs. Single-revision runs of both sides then gave 9115 records each, with equal record sets, and neither run held the 3 records. So the 3 records were extra updates in the first base run, which is run variance.

ED7: source of `8ff12fa` against source of `7c8a185`, both with the `7c8a185` tests. Each side had 9116 records, with 0 new and 0 missing.

ED2 step 2 is `7345a91`. `src/core/diagnostic_delta.ts` compares diagnostics by code, source, and moved span, as multisets. Rename rejects an added analysis diagnostic. A contract action must remove at least one diagnostic and add none. The coordinator reviewed the diff line by line and ran `deno task check` on `7345a91`: 1852 fast and 177 slow tests passed.

The implementer's probe ran the old and the new code on the same inputs. 2800 renames over the 14 fixture projects gave 0 differences. The probe made 100 contract action cases. Each case deletes a `fails` clause, a `uses` clause, or both from an explicit contract. Each rule offered 98 actions, with 0 differences.

One visible change was found outside the fixtures, and a new test pins it. In `const f = (x: Int): Int => { const t = w; const w = 2; t + w + x }`, the rename of `x` to `w` removes `unknown-name/001` and adds `declaration/001`. The old code rejected it with "The rename would capture another name." The new code rejects it with "The new name is reserved or conflicts with an existing binding." Only the message changes.

Capture: source of `f351a21` against source of `7345a91`, both with the `f351a21` tests and the write overlay. Each side had 9116 records, with 0 new and 0 missing.

Size (M, `scripts/measure.ts` over `src/core`, `430460b` against `7345a91`): filtered lines 34,393 to 34,521, and AST branches 7,961 to 7,970. The new `Revision` members and `diagnostic_delta.ts` add more than the editor files lose. Phase 3 narrows the editor boundary. It does not reduce code size.

Remaining: Phase 4 is not started. Decision 3 waits for ED3. ED2 step 3 (speculative child programs) stays optional and needs the bench M4 measurement first.

## 9. Implementation plan for Phase 4

Base: `1665897` or later on local `main`. The user started Phase 4 on 2026-10-22. Decision 3 is (a), from the answer "as recommended". The rules of section 7 apply: one commit for each unit, `deno task check` before each commit, captures one at a time, and no `golden:update` or `validate:update`. Each capture runs one test set on both sides with the write overlay, as in Phases 1 to 3.

Commit `1665897` gives each capture its own DENO_DIR. A self-capture of one revision on both sides gave 9123 and 9124 records, with 1 new `program` record and 0 missing. So one extra or one missing `program` record with the result `[]` is run variance. Any other difference fails the unit.

Measurements for this section (M, 2026-10-22, HEAD `61ef88b`). Three agents measured the ten Phase 4 items again. Their scratch probes are in `/tmp/p4-ck`, `/tmp/p4-ic`, and `/tmp/p4-ed`. The coordinator checked the claims that this section depends on.

### Corrections to section 3

- CK1b. `check_expr.ts` now has 3 `throttleStream` sites. Commit `0cc5349` came before the family split, so its 155 lines do not show the current cost. A new builtin in an existing family has 5 checker edit sites in 3 files. The sites are the `PRELUDE` row, the family import, the handler row, the prologue row, and the family code.
- CK1b (concurrency names). The concurrency union is declared once in full (`check_expr.ts:1624-1633`). The two other declarations are subsets of it (`collections.ts:23-31`, `stream.ts:33-36`).
- CK3. The pattern code is 9 members and about 327 lines, not 14 members. `errorCount` is written in `errorInfo` and `unresolvedCall` and read only in `tryExpr`. A return value for it would change the return path of each `expr` call, so CK3 keeps the field.
- CK5. `TypeTable.function` (`types.ts:714-724`) already sorts and removes duplicates, so a shared `functionTypeOf` adds nothing. The name `FunctionBody` is already a public type through `CheckedModule`.
- IC2. The `TypeNames` role of section 3 is wrong. `types.ts` calls `nameOf`, `effect`, `scopeRuntime`, `encodedMirrorName`, and `intSchemaName`, and each of them records a name on first use. `fields.ts` allocates names and writes `fieldAdapters` directly. A hover adapter that allocates nothing cannot give the emitter's names, because a name depends on the earlier allocations.
- IC3. `BodyValidator` has 127 members, of which 122 are methods. The 797 `this.` uses are correct.
- IC4. The `targetCall` design already exists as `Callee`, `OPERAND_CALLS`, and `LEAF_CALLS` in `emit/calls.ts` (commit `9adc5cd`).
- IC6. The validator has 284 path templates, not 223. One path is wrong: `simpleSchedule` (`validate/expr.ts:4246`) checks the argument under `${path}.argument`, but the IR fields are `times` and `delayMillis` (`ir.ts:183-184`). All other 109 `this.check(X, path)` calls match the access chain of `X`.
- ED3. The CLI and the LSP already share `removeStaleOutputs`, `writableModules`, `writeGenerated`, and `generationSource`. About 25 lines of orchestration repeat on each side. Only `projects.ts:40` imports the protocol `Diagnostic`, so the proposed `publish.ts` gives nothing for that goal. The LSP also skips the modules that a nested `effektive.json` owns (`projects.ts:470,488`), and the CLI does not (N1, probe `/tmp/p4-ed/nested_probe.ts`).

### Scope

Phase 4 does these units, in this order. Each unit keeps behavior, except IC6a.

1. IC6a: the validator path fix.
2. CK5: one body outcome type.
3. CK4: shared family views and `nameTextOf` in `syntax_queries.ts`.
4. CK1b: builtin rows next to their handlers.
5. CK3: patterns and operator typing out of `BodyChecker`.
6. IC3: validator families, in five commits.
7. ED3: characterization tests, then one `runSaveRound`.

Phase 4 defers these items, because the measurements show that they add edit sites or code for a small gain:

- IC2: the role interfaces add one edit site for a new helper name. The probable hover clash of two foreign `User` names exists today. It needs a two-module probe to confirm.
- IC4: `resolvedAs` saves about 2 lines at each of 12 sites, and `targetCall` exists.
- IC6 (the `sub` helper): about 280 edits for a check that IC6a and its test give at the one wrong site.
- ED5: one tracker removes about 27 lines and adds about 37 lines. Each copy changed in 1 commit.
- The `publish.ts` and `overlay.ts` splits of ED3: they would expose the private state of `projects.ts` for file size only.

### IC6a (validator path fix)

In `simpleSchedule` (`validate/expr.ts:4241`), check the argument under `${path}.times` for `schedule-recurs` and `${path}.delayMillis` for `schedule-spaced`.

Add one test to `tests/validate_family_mutation_test.ts`. Its `lowerProgram` and `forge()` (lines 165-180) build forged IR from a source text. The test needs its own source with `scheduleRecurs`, because no case there uses a schedule. The test gives the literal under `times` a wrong recorded `type`, and asserts the path that ends in `.times.type`. `finish` reports a type mismatch at `${path}.type` (`validate/expr.ts:837-895`), so no path ends in `.times` alone.

Visible change: only the path of a validation diagnostic inside a schedule argument. Parity: `deno task check`, and a capture with 0 new and 0 missing records, because no fixture reaches that path.

### CK5 (one body outcome type)

In `check_expr.ts`, add `export interface BodyOutcome { readonly body: NodeInfo | undefined; readonly result: TypeRef; readonly failures: readonly ErrorId[]; readonly requirements: readonly CapabilityId[]; readonly mode: Execution }`. `checkBody` returns `BodyOutcome`, so its field `execution` becomes `mode`. The writes are at lines 515, 527, and 556, and the reads `run.execution` are at lines 2368, 3004, and 3019. Only the run field changes its name. The `execution` key of the `table.function` spec stays. `FunctionRun` extends `BodyOutcome` with `table`, `type`, and `diagnostics`.

In `check_project.ts`, `FunctionBody` extends `Omit<FunctionRun, "diagnostics">` with `kind`, `signature`, and `bodyNode`, so its fields stay flat and keep their names. `publish` takes `diagnostics` out and spreads the rest.

Delete the second sort and borrow guard at `check_expr.ts:3003-3011`, because `TypeTable.function` does the same. Before that deletion, read `types.ts:714-724` and confirm that it applies both steps. If it does not, keep the code and report it. Parity: `deno task check` and a capture.

### CK4 (shared family views)

In `check_builtins/context.ts`, add `SyntaxView { readonly tree: SyntaxTree; kids(node: NodeId): NodeId[] }`, `ResolveView { readonly targets: ... }`, `FactView { readonly facts: ... }`, `FactWriter { fact(node: NodeId, fact: NodeFact): void }`, and `LocalUseView { localUses(...): ... }`. Copy each member type from the current family declarations, and stop if two families declare one member with different types. Each family context extends the views that it uses, and drops its own copies of those members. `LayerContext` uses `Pick<SyntaxView, "tree">`.

Move `tokenKindOf` and `nameTextOf` from `index.ts:86-102` to `syntax_queries.ts`, and export both. `index.ts` imports them, and the 5 importers of `nameTextOf` import from `syntax_queries.ts`. Parity: `deno task check`. The change moves types and one function, so a capture is not needed.

### CK1b (builtin rows next to their handlers)

New file `check_builtins/rows.ts`. Move these from `check_expr.ts:228-327` without a change of logic: `PreludeCallName`, `Kebab`, `PrologueFacts`, `Prologue`, `SharedPrologue`, `direct`, `piped`, and `optionalLast`. Each type that names `BodyChecker` gets a context parameter `C`. Add:

```ts
export interface BuiltinRow<K extends PreludeCallName, C> {
  readonly prologue: Prologue<K, C> | "own-arity";
  readonly handle: (c: C, node: NodeId, name: K, args: readonly Arg[], expected: TypeRef | undefined) => NodeInfo;
}
export type Rows<N extends PreludeCallName, C> = { readonly [K in N]: BuiltinRow<K, C> };
```

Each family file exports one rows constant, for example `STREAM_ROWS`, with `satisfies Partial<Rows<PreludeCallName, StreamContext>>`. Each row takes its handler arrow and its prologue from the two current tables without a change. `codec.ts`, `ref.ts`, and `schedule.ts` use `BuiltinContext`. `schema.ts` keeps one shared prologue and has 19 explicit rows. Do not build rows with `Object.fromEntries`, because the result needs a cast.

New file `check_builtins/registry.ts` composes the family rows with a type annotation, not with `satisfies`:

```ts
export type FamilyContext = BuiltinContext & CollectionContext & EffectContext & LayerContext & FiberContext & ScopeContext & StreamContext & SchemaContext;
export const FAMILY_ROWS: Rows<Exclude<PreludeCallName, "unbrand" | "Some">, FamilyContext> = { ...EFFECT_ROWS, /* ... */ ...STREAM_ROWS };
```

A probe (`/tmp/p4-ck/probe2.ts`) showed that `satisfies` on the composed table breaks the generic index in `preludeCall` with TS2322, and that the annotation keeps it. `unbrand` and `Some` call private `BodyChecker` methods, so their rows stay in a private static `CORE_ROWS: Rows<"unbrand" | "Some", BodyChecker>`. `BodyChecker.PRELUDE_ROWS: Rows<PreludeCallName, BodyChecker> = { ...FAMILY_ROWS, ...BodyChecker.CORE_ROWS }` replaces `PRELUDE_HANDLERS` and `PRELUDE_PROLOGUES`. Declare `CORE_ROWS` before `PRELUDE_ROWS` in the class body, because static initializers run in source order.

`preludeCall`, `runPrologue`, and `arity` keep their logic and their step order, and read one row. Add `ConcurrencyOperation` to `context.ts`. The two families use `Extract<ConcurrencyOperation, ...>` for their subsets.

A key that two spreads give compiles with no error (probe `DUP`). So add one test that the key sets of the family rows and the core rows are disjoint and cover each `PreludeCallName`. Keep the `Kebab` restriction in `PrologueFacts`. Delete `PreludeHandler`, `PreludeHandlers`, and `PreludePrologues`. Update `docs/builtin-changes.md` for the new edit sites. After CK1b, a new builtin in an existing family edits the `PRELUDE` row, the family rows, and the family code, so `check_expr.ts` does not change.

Parity: `deno task check`, a capture, and a normalized comparison of the moved code. The comparison matches each handler body and prologue value by name, with the receiver `BodyChecker.` removed. The implementer puts the comparison script in `/tmp` and reports its result.

### CK3 (patterns and operator typing)

New file `check_patterns.ts`. Move these 9 members of `BodyChecker` with `this` changed to `c`: `missing`, `checkCoverage`, `reach`, `foreign`, `bindLocal`, `patternFact`, `pattern`, `recordPattern`, and the free function `describeDomain`. Also move `MatchState` (`check_expr.ts:220-226`). The context is:

```ts
export interface PatternContext {
  readonly tree: SyntaxTree;
  readonly table: TypeTable;
  readonly targets: ReadonlyMap<NodeId, Target>;
  readonly body: Pick<BodyTable, "locals">;
  kids(node: NodeId): NodeId[];
  kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[];
  report(code: DiagnosticCode, message: string, node: NodeId): void;
  fact(node: NodeId, fact: NodeFact): void;
}
```

Take each member type from the current code, not from this sketch. `BodyChecker` has no `locals` member, so the context reads `body.locals`.

`match` stays in `BodyChecker` and keeps its call order: the pattern of an arm, then the body of that arm. The `invalid` arrow in `recordPattern` captures `this`, so it must capture `c`.

New file `check_binary.ts` holds pure functions only: `isNumeric`, `numericBrand`, `sharedNumericBrand`, `isString`, `isBoolean`, `comparisonClass`, and one `operatorResult(table, operator, left, right)` that gives the result type, or a mismatch. `binary` stays in `BodyChecker`. It keeps the operand `expr` calls, the `errorInfo` calls, the one `report`, and `finish`, so `errorCount` and the diagnostic order do not change. `ifExpr` uses the moved `isBoolean`. `isNumeric`, `isString`, and `isBoolean` call `isError`, which is `table.node(ref).kind === "error"` (`check_expr.ts:398`). So each helper needs only `table`.

Parity: `deno task check`, a capture, and a normalized comparison of the moved pattern members.

### IC3 (validator families)

New file `validate/families/context.ts` with the validator-owned context. The validator must not import any file in `check_builtins/` or any other checker file.

```ts
export interface ValidatorCore {
  readonly env: TypeEnv;
  readonly ctx: Ctx;
  add(area: Area, path: string, what: string, span: Span): void; // type Area = Parameters<Report["add"]>[0]
  check(e: Expr, path: string): Out;
  poison(): Comp;
  checkConcurrency(e: { readonly concurrency: number | "unbounded" | undefined; readonly span: Span }, path: string, name: string): void;
  jobFunction(job: Out, path: string, span: Span, what: string): ReturnType<typeof asFunction>;
}
```

Take each member type from the current code. The same file holds `Area`, `Out`, `Comp`, `derivedResult`, `EFFECT_ONLY`, and `streamState(env: TypeEnv, type: Type): Type`. `streamState` (`validate/expr.ts:3528`) reads only `this.env`, and both `ref` and `stream` call it.

No family file may import `expr.ts`, because that makes an import cycle. So module-level helpers move with their users. The stream constants and types at `expr.ts:115-255` move with `stream`. The schema helpers at `expr.ts:260-370` move with `schema`. `validConcurrency`, `tagMayEqual`, and `checkedResult` stay in `expr.ts`, because only core members use them.

New file `validate/expr_walk.ts` holds `exprChildren` and `walkExprs`, and `expr.ts` re-exports `exprChildren`, because a test imports it. `BodyValidator implements ValidatorCore`, and the members of the interface become public. The five commits:

1. The context, `expr_walk.ts`, and the families `ref`, `codec`, and `fiber`.
2. `collections`, `effect`, and `layer`.
3. `schedule` and `scope`. `scope.ts` exports `borrowedReferences` for `checkFunction`.
4. `stream`.
5. `schema`. `schemaRows` becomes a module constant.

Each family file exports one function for each family case, of the form `(c: ValidatorCore, e, path) => Comp`. The `switch` in `BodyValidator` calls these functions.

One hazard: `guard` (`validate/index.ts:49`) puts the engine's `TypeError` text into a `validation/008` message. `tests/validate_builtin_test.ts:118` pins a text from `call`, which stays in the class. If a moved body crashes on forged IR, the text changes from `this.` to `c.`. Run that test after each commit.

Parity for each commit: `deno task check`, the 18 `fixtures/validate` cases, and a token comparison of each moved body. Before the comparison, `this.<core>` becomes `c.<core>`, `this.<own>(` becomes `<own>(c, `, and `BodyValidator.` is removed. One capture covers the five commits.

### ED3 (one save round)

Decision 3 is (a). ED3 has two commits.

ED3a (characterization tests first). Add tests for four behaviors that no test pins today:

1. The CLI watch loop forgets a module after a failed removal (probe `/tmp/p4-ed/forget_probe.ts`).
2. `effektive build` writes the outputs of a module that a nested `effektive.json` owns (N1, probe `/tmp/p4-ed/nested_probe.ts`).
3. The LSP logs each removed path and its notes in module order.
4. The relative order of the LSP type-4, type-1, and type-3 logs in one save round.

Commit ED3a alone, after `deno task check`.

ED3b. New file `src/host/save_round.ts`:

```ts
export type RemovalRule = "retry" | "forget"; // the LSP retries a failed removal; the CLI watch loop forgets it
export interface SaveRoundInput {
  readonly fs: CliFs;
  readonly root: string;
  readonly revision: Revision;
  readonly previous: readonly string[];
  readonly removal: RemovalRule;
  readonly owns: (name: string) => boolean;
  readonly validation?: ReadonlyMap<string, readonly Diagnostic[]>;
  readonly write: boolean;
}
export interface ModuleRemoval { readonly name: string; readonly removed: readonly string[]; readonly notes: readonly string[] }
export interface SaveRound {
  readonly modules: readonly string[];
  readonly removals: readonly ModuleRemoval[];
  readonly writable: readonly string[];
  readonly outputs: GeneratedOutputs; // export this interface from host/outputs.ts
}
export function runSaveRound(input: SaveRoundInput): SaveRound;
```

The prototype is `/tmp/p4-ed/proto/save_round.ts`. `runSaveRound` stays synchronous, and it returns one removal record for each module, so each caller keeps its log order. The CLI passes `owns: () => true`, which keeps N1.

`buildRevision` in `src/cli/build.ts` calls `runSaveRound`. `Session.build` (`cli/session.ts:84`) and `buildRevision` get `previous` as a new parameter. `effektive build` and the `host-change` round pass `previous: []`. `BuildOutcome` gets `modules` and `removals`. The removal notes must not go into `outcome.notes`, because `printOutcome` prints the notes after `rechecked:` (`cli/report.ts:22`). The watch loop prints the `removed:` lines and the notes before `rechecked:`, and sets `previous = outcome.modules`.

`saveRound` in `src/lsp/projects.ts` calls `runSaveRound` with `removal: "retry"` and the current ownership test. The sync steps, `heldReason`, the message texts, `deno check`, and each sort order stay where they are. The core must not import host code.

Parity: the four ED3a tests and `deno task check`. These 14 test files reach the changed code: `build_imports`, `cli_slow`, `cli_sort`, `cli_test`, `emit_lift_slot_slow`, `lsp_project_state`, `lsp_save_round`, `lsp_server`, `outputs_generation`, `outputs_stale`, `outputs_writable`, `task_permissions_slow`, `watch_host`, and `watch_stale`. The capture does not record subprocess output, so the tests are the oracle.

### Plan check

A Fable agent checked this section against HEAD `1665897`. It rated CK4 sound, and the other units sound with changes. The coordinator verified the claims about `body.locals`, `streamState`, `Area`, and `GeneratedOutputs`, and accepted each finding. The text above includes them:

- IC3: `ref` calls `streamState`, so `streamState` moves to the context in commit 1. `Area` is defined there. Module-level helpers move with their users.
- CK3: `BodyChecker` has no `locals` member.
- ED3b: `GeneratedOutputs` was not exported, and `previous` needs a path through `Session.build`. The removal notes must stay out of `outcome.notes`.
- CK1b: no test checks a wrong fact kind, so the `Kebab` restriction is the check. Static initializer order matters.
- IC6a: a forged child gives a path that ends in `.times.type`, not `.times`.
- CK5: one more read at line 3019.
- ED3a: the stats test was dropped. `effektive/stats` reads the overlay program, and the save round runs on `diskProgram`, so the test could not detect an ED3b regression.

### Phase 4 results (2026-10-22)

The seven units are on local `main`. IC6a is `76de0c2`, CK5 is `9bbc593`, CK4 is `7aa64ba`, CK1b is `e0def39`, and CK3 is `770dae4`. IC3 is `5175776`, `7e44c33`, `fed12e2`, `14ad733`, and `a14e100`. ED3a is `a88ad9c`, and ED3b is `6ea0021`. The coordinator added `88d5bdd` after review.

The implementers ran `deno task check` before each commit, and the last gate passed 1861 fast and 177 slow tests. The coordinator reviewed each diff line by line.

The coordinator also changed the capture tool. `1665897` gives each capture its own DENO_DIR, and `088d50f` prints the new records of a capture.

Review finding, fixed in `88d5bdd`. ED3b printed the removed paths and the notes of each module together. The old watch loop printed every removed path first, then every note. So with two modules that leave in one round, and a failed removal in the first, the stderr order changed. No test had two modules. The new test in `tests/watch_stale_test.ts` passes on `a88ad9c`, fails on `6ea0021`, and passes on `88d5bdd`.

Accepted difference in ED3b. The LSP save round now sends its `removed` logs after the round also wrote the new files, not before. The log texts and their order do not change, and no test or protocol message depends on that timing.

Deviations, accepted after review:

- CK1b exports `CoreRowName`, `CORE_ROW_NAMES`, and `FAMILY_ROW_TABLES` from `registry.ts`, so `tests/builtin_rows_test.ts` checks the key sets from outside the class.
- CK3 names the moved `missing` as `missingOf`, because a local `missing` in `checkCoverage` shadows it.
- IC3 rewrote the independence test in `tests/validate_test.ts`, because it read only the flat `validate/` directory. The test now walks `families/` and resolves each import against its file. The implementer confirmed that the test still rejects a planted `import "../../check_expr.ts"`. Five helpers that read no validator state take no `c`, because the lint rejects an unused parameter.

Parity evidence. Each moved-code comparison was run again by the coordinator:

- CK1b matched 95 handlers and 95 prologues.
- CK3 matched 16 moved members. The implementer confirmed that one changed diagnostic code fails the script.
- IC3 matched 119 items, and every one of the 87 members that left `BodyValidator` is in the comparison.

Captures, each with one test set on both sides and the write overlay:

- `b888a6a` against `7aa64ba` (IC6a, CK5, CK4): 9123 against 9124 records, with 1 new `program` record and 0 missing. A self-capture of one revision gave the same counts, so the record is run variance. The capture tool did not yet print new records, so the result of that record was not seen.
- `088d50f` against `e0def39` (CK1b): 9127 records on each side, with 0 new and 0 missing.
- `e0def39` against `770dae4` (CK3): 9127 records on each side, with 0 new and 0 missing.
- `770dae4` against `a14e100` (IC3): 9127 records on each side, with 0 new and 0 missing. Both sides used the `a14e100` tests, because the old independence test rejects the `families/` directory.
- `a88ad9c` against `6ea0021` (ED3b): 9180 records on each side, with 0 new and 0 missing. The capture records no subprocess output, so the ED3a tests and the order test of `88d5bdd` are the oracle for ED3.

Size (M, `scripts/measure.ts` over the `.ts` files of `src/core`, `b888a6a` against `88d5bdd`): 71 to 87 files. Filtered lines go from 34,521 to 35,184, and AST branches from 7,970 to 7,969. `check_expr.ts` falls from 3039 to 2092 raw lines, and `validate/expr.ts` falls from 4901 to 1638. The new files hold the moved code, their imports, and their context interfaces, so the total grows.

Edit sites after Phase 4. A new builtin in an existing family edits the `PRELUDE` row, the rows of the family, and the family code, and `check_expr.ts` does not change. A change of the removal or ownership rule of a save round edits `src/host/save_round.ts` only.

Decision 5 (N1), found in Phase 4. `effektive build` wrote the outputs of a module that a nested `effektive.json` owns, and the language server did not. ED3 kept this difference as the `owns` parameter.

The user chose (b) on 2026-10-22: the CLI uses the language server rule. `ownedByRoot` in `src/host/save_round.ts` now holds that rule for both callers. The ED3a test in `tests/cli_test.ts` now asserts that `build` skips those outputs, and a new test in `tests/watch_stale_test.ts` covers `watch`. Both tests fail with the old rule.

Remaining: the deferred items IC2, IC4, the IC6 path helper, ED5, and the ED3 file splits. ED2 step 3 stays optional and needs the bench M4 measurement first.

## 10. Implementation plan for Phase 5

Base: `5c0176c` or later on local `main`. The user chose Phase 5 on 2026-10-23: IC2, the emitter family split (IC8, new in this section), and IC4. The rules of section 7 apply: one commit for each unit, `deno task check` before each commit, captures one at a time, and no `golden:update` or `validate:update`. Section 9 of the rederive review applies. Each capture runs one test set on both sides with the write overlay. One extra or one missing `program` record with the result `[]` is run variance (section 9). Any other difference fails the unit.

Measurements for this section (M, HEAD `5c0176c`, unless marked I):

- `emit/expr.ts` has 2898 lines. It is the largest file in `src/`. `structural` has 544 lines and 44 `case` labels. `schemaExpr` has 375 lines, and `leaf` has 229 lines.
- The checker and the validator have one file for each builtin family (`check_builtins/`, `validate/families/`). The emitter has none. So a new builtin in a family edits a family file in two stages and `emit/expr.ts` in the third.
- The family code in `emit/expr.ts` uses these `ExprEmitter` members: `pure`, `fit`, `callback`, `effectCallback`, `arrow`, `genCall`, `adaptedInput`, `suspended`, `closure`, `objectLiteral`, and `functionTypeOf`. It uses these `Scope` members: `effect`, `resolve`, `temp`, `fresh`, `nameOf`, and `typeLevelDeclaration`. It also calls the module functions `emitted`, `at`, `free`, `callArguments`, `concurrencyArguments`, and `isEffectfulCallback` (only `schemaExpr`), and the constant `PREC`.
- Only `emit/emit.ts` reads the import ledger of `Scope`: `moduleImports`, `effectImports`, `hostImports`, `usesIntFunction`, `usesIntSchema`, and `usesScopeRuntime`. Only `emit/decls.ts` calls `resetTemporaries`.
- `emit/expr.ts` has 12 sites that call `this.scope.resolve`, test the `kind` of the result, and throw `internal(...)`. They are at lines 887, 1077, 1086, 1103, 1123, 1194, 1208, 1254, 1275, 1425, 1448, and 1956. The two tests in `sourceLayer` (1784-1788, 1795-1800) resolve behind a guard, so they are not in this set.
- No test checks the imports of `src/core/emit/`. The emitter imports `ir.ts`, `ids.ts`, `project.ts`, `source.ts`, `util.ts`, `diagnostics.ts` (`tsc.ts`), and `lower.ts` (type only, `emit.ts`).
- The behavior capture records each `emitModule` result. So the capture compares the emitted text of every test input, and it is the main oracle for this phase.

### Corrections to the proposal of 2026-10-23

The proposal gave IC2 as read-only role interfaces. Section 9 already records that this is wrong: `nameOf`, `effect`, `scopeRuntime`, `encodedMirrorName`, and `intSchemaName` record a name on first use. So the roles below keep the allocation, and the hover path does not change. Section 9 also records the costs: a new helper name gets one more edit site (its role interface), and `resolvedAs` saves about 2 lines at each site. The user accepted Phase 5 with these costs. The gain is a compile check of the phase order, and one file for each family in each of the three stages.

### Scope

Phase 5 does these units, in this order. Each unit keeps behavior and the emitted text byte for byte.

1. IC2: role interfaces for `Scope`.
2. IC8a: `emit/emitted.ts`, the family context, the import test, and the families `codec`, `layer`, and `fiber`.
3. IC8b: the families `schedule`, `effect`, `collections`, and `scope`.
4. IC8c: the family `stream`.
5. IC8d: the family `schema`.
6. IC4: one `resolvedAs` helper for the 12 resolve-and-throw sites.

IC4 comes last, so that the moves of IC8 stay token-identical.

### IC2 (role interfaces for `Scope`)

In `emit/scope.ts`, add these interfaces. Take each member type from the current `Scope` code, not from this sketch.

```ts
/** Names for the emitted module. Each member records the name on first use. */
export interface EmitNames {
  effect(module: EffectModule): string;
  nameOf(id: DeclarationId): string;
  encodedMirrorName(id: DeclarationId): string;
  intSchemaName(): string;
  intFunction(): string;
  scopeRuntime(): ScopeRuntimeNames;
  serviceParameter(): string;
  fieldHelper(key: string): string;
}
export interface Temporaries { fresh(base: string): string; temp(): string }
/** Reads of the module IR and the config. No member records anything. */
export interface TypeLookup {
  resolve(type: Type): Type;
  typeLevelDeclaration(id: DeclarationId): ...;
}
/** What `emit.ts` reads after all printing. */
export interface ImportLedger {
  moduleImports(): ImportGroup[];
  effectImports(): ...;
  hostImports(): ImportGroup[];
  usesIntFunction(): boolean;
  usesIntSchema(): boolean;
  usesScopeRuntime(): boolean;
}
export type ExprScope = EmitNames & Temporaries & TypeLookup & Pick<Scope, ...>;
export class Scope implements EmitNames, Temporaries, TypeLookup, ImportLedger { ... }
```

`ExprScope` adds only the remaining `Scope` members that `emit/expr.ts`, `emit/types.ts`, or `emit/fields.ts` read, for example `locals`, `hostBinding`, `fieldAdapters`, and `fieldHelpers`. `isTypeOnly` and `containsFunction` stay out of the roles, because only `decls.ts` and `Scope` read them. Export `HostBinding` and `ScopeRuntimeNames` only if the check needs it. The implementer finds that list with the compiler. It must not contain an `ImportLedger` member or `resetTemporaries`. If `expr.ts`, `types.ts`, or `fields.ts` needs one of them, stop and report it.

Change the parameter types:

- `ExprEmitter` takes `ExprScope` in its constructor.
- Each exported function in `emit/types.ts` and `emit/fields.ts` takes the narrowest of `EmitNames`, `TypeLookup`, `EmitNames & TypeLookup`, or `ExprScope` that compiles. The plan check measured: each function in `types.ts` takes `EmitNames`, and `needsFieldAdapter` takes `TypeLookup`. Every current caller passes a `Scope`.
- `emit/emit.ts`, `emit/decls.ts`, and `src/core/editor.ts` keep `Scope`.

No runtime code changes. Parity: `deno task check`. A capture is not needed, because the unit changes types only.

### IC8a (shared printing values, family context, and the first three families)

New file `emit/emitted.ts`. Move these from `emit/expr.ts` without a change: `PREC`, `Emitted`, the types that `Emitted` names (`Chain`, `ChainHead`, `ChainTail`, `Run`, `CondChain`, and their own member types), `emitted`, `flush`, `at`, `free`, `callArguments`, `concurrencyText`, `concurrencyArguments`, `Mode`, and `Kid`. Export each one. Move a further function only when a family needs it, and list it in the report. `isEffectfulCallback` (`expr.ts:533-535`) moves into `families/schema.ts` in IC8d, because only `schemaExpr` uses it. `decls.ts` imports `at` from `emitted.ts`. The other functions of the conditional-chain and binary-run printers stay in `expr.ts`.

New file `emit/families/context.ts` with the context of the family code:

```ts
export interface ExprCore {
  readonly scope: ExprScope;
  pure(e: Expr, expected?: Type): Emitted;
  fit(e: Expr, expected: Type | undefined, mode: Mode): Emitted;
  callback(arg: Expr, kid: Kid): Emitted;
  effectCallback(arg: Expr): Emitted;
  arrow(parameters: Doc, body: Emitted, bodyGroup?: GroupId): Doc;
  genCall(statements: readonly Doc[]): Emitted;
  adaptedInput(input: Emitted, type: Type, direction: "decoded" | "encoded" | "make", unknownInput?: boolean): Emitted;
  suspended(job: Expr): Emitted;
  closure(e: Extract<Expr, { kind: "closure" }>, annotate: boolean, forceEffect?: boolean): Emitted;
  objectLiteral(fields: readonly Doc[], spreads: readonly Doc[]): Emitted;
  functionTypeOf(type: Type): FunctionType | undefined;
}
```

Take each member type from the current code. `ExprEmitter implements ExprCore`, and the members of the interface become public. Add a member to `ExprCore` only when a moved body needs it.

Each family file `emit/families/<family>.ts` uses the family names of `validate/families/`. It exports one union of IR kinds for each emitter position, and one function for each union:

```ts
export type StreamStructuralKind = "unfold" | "map-effect" | ...;
export function streamStructural(c: ExprCore, e: ExprOf<StreamStructuralKind>, kid: Kid, ...): Emitted {
  switch (e.kind) { /* the moved case bodies */ default: { const unreachable: never = e; return unreachable; } }
}
export type StreamLeafKind = "fold-stream" | "fold-effect-stream";
export function streamLeaf(c: ExprCore, e: ExprOf<StreamLeafKind>, children: readonly Emitted[]): Emitted;
```

A family function takes only the parameters that its bodies use, for example `mode` for `defer`.

Exception to the `never` default: `ir.ts:186` declares `schedule-max`, `schedule-min`, and `schedule-concat` as one IR member, and `schedule-concat` prints through `OPERAND_CALLS`. So the default arm of `scheduleStructural` is `const rest: "schedule-concat" = e.kind; throw internal(...)`, with a comment that gives this reason. Every other family keeps `const unreachable: never = e`.

`leaf` computes `const effect = this.scope.effect("Effect")` (`expr.ts:2592`) before its switch, and the leaf cases read that local. So each leaf family function starts with `const effect = c.scope.effect("Effect");` when its bodies read `effect`. The second call returns the memo, so the text does not change. Line 2592 of `leaf` stays. Do not move any other `effect`, `temp`, or `fresh` call out of its case, because the allocated names depend on the call order (for example `unfold` and `schedule-from-step`). In `structural` and `leaf`, the family cases fall through to one call, for example `case "unfold": case "map-effect": ... return streamStructural(this, e, kid);`. The compiler checks both directions. A kind in the family union without a case in `structural` reaches the `operandCall` default, which does not compile, because the kind has no row in `OPERAND_CALLS`. A case in `structural` without the kind in the union makes the call fail to compile. Use the existing `ExprOf` from `emit/shape.ts`. If `ExprOf` of a union does not narrow in a family switch, stop and report it with the compiler error.

The moved bodies change only so: `this.scope` becomes `c.scope`, `this.<core member>` becomes `c.<core member>`, and `this.<moved member>(` becomes `<moved member>(c, `. The comparison script treats the `const effect` prologue of a leaf family and the schedule default arm as known additions. Comments move with their code.

No file in `emit/families/` may import `emit/expr.ts`, because that makes an import cycle. Add a test to `tests/emit_shape_test.ts` or a new `tests/emit_families_test.ts`, in the form of the validator independence test (`tests/validate_test.ts:1605`). It asserts two rules. First, each import of a file in `src/core/emit/families/` resolves to `src/core/ir.ts`, `src/core/ids.ts`, or a file in `src/core/emit/` other than `expr.ts`. Second, it checks at least one file. The implementer confirms that the test rejects a planted `import "../expr.ts"` and reports it.

The IC8a families:

- `codec`: the structural kinds `codec`, `decode`, and `encode`.
- `layer`: the structural kind `layer` (`sourceLayer`) and the leaf kind `provide`.
- `fiber`: the leaf kinds `with-fiber`, `join-fiber`, and `interrupt-fiber`.

### IC8b (schedule, effect, collections, and scope)

- `schedule`: the structural kinds `schedule-spaced`, `schedule-map`, `schedule-max`, `schedule-min`, and `schedule-from-step`.
- `effect`: the structural kinds `defer` and `retry-schedule`, and the leaf kinds `retry`, `retry-with-schedule`, and `run`.
- `collections`: the leaf kinds `partition-all`, `validate-all`, and `all-results`. The `all` and `traverse` branch of the `call` case stays in `leaf`, because `call` is not a family kind.
- `scope`: the leaf kinds `fork-scoped` and `with-resource`.

Before the move, the implementer confirms each family with the `validate/families/` file that handles the same kind. If a kind is in a different validator family, use the validator family and report it.

### IC8c (stream)

- `stream`: the structural kinds `unfold`, `map-effect`, `map-groups`, `scan-stream`, `map-accum-stream`, `flat-map-streams`, `debounce-stream`, `throttle-stream`, `take-sink`, `transduce-stream`, `aggregate-stream`, `aggregate-within-stream`, and `buffer-stream`, and the leaf kinds `fold-stream` and `fold-effect-stream`.

### IC8d (schema)

- `schema`: the structural kind `schema` (`schemaExpr` and its helpers, including `isEffectfulCallback`) and the leaf kinds `schema-make`, `schema-decode`, and `schema-encode`.

Section 9 of the rederive review lists `schemaExpr` as already tight. So `schemaExpr` moves token for token, with only the receiver changes above. Its logic and its switch do not change.

### IC4 (`resolvedAs`)

Add to `emit/scope.ts`:

```ts
/** `type` after `resolve`, when it has `kind`. Else an internal failure with `message`. */
export function resolvedAs<K extends Type["kind"]>(scope: TypeLookup, type: Type, kind: K, message: string): Extract<Type, { kind: K }>;
```

Use it at the 12 sites. Each call stays at the position of the `resolve` call that it replaces. Each site keeps its message text. A site that tests two or three operands calls `resolvedAs` once for each operand, with the same message, in the order of the current test. A site that tests a value that is not the result of `resolve` stays as it is, for example the closure test of `with-resource` and `closureType`. Do not convert the throws to `Result` (section 9). Parity: `deno task check` and a capture.

### Docs

In IC8d, update `docs/builtin-changes.md`: the emission row names `emit/families/<family>.ts`. Update the `src/core/` row of `docs/development.md`: `emit/families/` holds one file for each builtin family of the emitter.

### Parity and review

For each IC8 commit, the implementer:

1. runs `deno task check`.
2. compares the moved code with a script in `/tmp` and reports its result. The script matches each moved case body and member by name, after the receiver changes above. It reports each moved item and each item that differs.
3. confirms that `fixtures/golden/` and `fixtures/emit/forms/` did not change (`git status --short fixtures`).

The coordinator runs two captures, one at a time: the base against the IC8d commit, and the IC8d commit against the IC4 commit. After IC4, the coordinator measures `src/core` with `scripts/measure.ts` against the base and records the result in a Phase 5 results section.

### Plan check

A Fable agent checked this section against HEAD `3ef0ab6`. It rated IC8c and IC4 sound, and IC2, IC8a, IC8b, and IC8d sound with changes. Its probes confirmed the two-direction compile check of the family dispatch. The coordinator verified findings 1, 3, and 4 in the code and accepted each finding. The text above includes them:

- IC8b: the shared `schedule-max | schedule-min | schedule-concat` IR member breaks a `never` default, so the schedule family has its own default arm.
- IC8d: `isEffectfulCallback` moves with `schemaExpr`.
- IC8a and IC8b: the leaf families repeat the `effect` local as a prologue.
- IC2: `hostBinding` is in `ExprScope`, and `TypeLookup` omits `isTypeOnly` and `containsFunction`. `serviceParameter` is used only by the core `perform` case.
- IC4: each call stays at the position of its `resolve` call.

What not to touch in Phase 5: `ir.ts`, the `OPERAND_CALLS` and `LEAF_CALLS` rows, `emit/doc.ts`, the conditional-chain and binary-run printers, `catchEffect`, `perform`, the `call` case, and the order of `case` labels in `structural` and `leaf` outside the family cases.

### Phase 5 results (2026-10-23)

The six units are on local `main`. IC2 is `6310211`. IC8a is `da53bfa`, IC8b is `ef3b744`, IC8c is `bef55e3`, and IC8d is `9ea3af3`. IC4 is `5fb9dc1`.

The implementer ran `deno task check` before each commit. The coordinator reviewed each diff and ran the gate again on `5fb9dc1`: 1863 fast and 177 slow tests passed. `fixtures/golden/` and `fixtures/emit/forms/` did not change.

Captures, each with the write overlay (`/tmp/p5/capture.ts`):

- `ec8f81e` against `9ea3af3` (IC2 and IC8): 9198 records on each side, with 1749 `emit` records, 0 new, and 0 missing.
- `9ea3af3` against `5fb9dc1` (IC4): 9198 records on each side, with 0 new and 0 missing.

The moved-code comparison (`/tmp/p5/compare.py`) matched 38 items with 0 differences: 6 in IC8a, 14 in IC8b, 15 in IC8c, and 3 in IC8d. The import test of `tests/emit_families_test.ts` rejected a planted `import "../expr.ts"`.

Deviations, accepted after review:

- `layerStructural`, `layerLeaf`, and `schemaStructural` hold one kind each, so they have no outer `switch`. Their kind types still give the compile check.
- `schema-make`, `schema-decode`, and `schema-encode` share one IR member (`ir.ts:203`), as the schedule kinds do. So the default arm of `schemaLeaf` tests `e.kind` against `never`. The plan check did not find this.
- The multi-operand IC4 sites share one `message` constant. The texts and the call order do not change.
- `resolvedAs` uses a private `hasKind` type predicate, so IC4 adds no cast.

Size (M, `scripts/measure.ts` over the `.ts` files of `src/core`, `ec8f81e` against `5fb9dc1`): 87 to 98 files. Filtered lines go from 35,184 to 35,626, and AST branches from 7,969 to 8,003. `emit/expr.ts` falls from 2741 to 1633 filtered lines (2898 to 1769 raw lines). The new files hold the moved code, their imports, their kind types, and their default arms, so the total grows. The cause of the 34 new branches is probable, not measured: the family `switch` statements, their default arms, and `hasKind`.

Edit sites after Phase 5. A new builtin in an existing family edits the family file in each of the three stages: `check_builtins/`, `validate/families/`, and `emit/families/`. A new IR kind of a family also edits the case list in `structural` or `leaf`, and the compiler rejects an omission in either direction.

Remaining: the IC6 path helper, ED5, and the ED3 file splits stay deferred. ED2 step 3 stays optional and needs the bench M4 measurement first.

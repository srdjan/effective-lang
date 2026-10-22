# Decoupling review: coupling that remains after the rederive work

Date: 2026-10-22. Base revision: `3e7a84a`. Status: proposed. No item is accepted, and no source file changed.

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

Phase 2 (one owner for each rule): IC1, then IC2 with ED4, then CK2. Each item changes a contract between two stages, so each needs the Fable plan check first.

Phase 3 (editor boundary): ED1, then ED7, then ED2 step 2 under Decision 2.

Phase 4 (edit spread): CK1b, CK3, CK4, CK5, IC3, IC4, IC6, ED3, and ED5. These items reduce edit count and do not fix a drift risk.

Each unit runs `deno task check` and a `behavior:capture` with constant test inputs before its commit. Do not run `golden:update` or `validate:update`.

## 6. Decisions for the user

Decision 1 (scope). Options: (a) Phases 1 and 2. (b) Phases 1 to 3. (c) All phases. (d) Phase 1 only. Recommendation: (a), because it removes the silent-drift risks and leaves the cost items for later.

Decision 2 (rename conflict test, ED2 step 2). Options: (a) Replace the count tests with `diagnosticDelta`, which can change some rename and action results. (b) Keep the count tests. Recommendation: (a), with each changed result listed in the commit.

Decision 3 (module removal rule, ED3). The LSP keeps a module after a failed removal, and the CLI watch loop does not. Options: (a) Keep both rules as parameters of one `runSaveRound`. (b) Use the LSP rule in both. Recommendation: (a), because it keeps behavior.

Decision 4 (hover result rule, ED4). Options: (a) Hover keeps the return type for inferred functions, as an explicit option of the shared header. (b) Hover matches the emitter exactly. Recommendation: (a), because hover then still shows the inferred type.

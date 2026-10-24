# Optional TypeScript 7.1 integration for Effektive

Date: 2026-10-24. Status: **Deferred by user; implementation not authorized**.
TCM identifies this plan's future work units. Saving this plan does not authorize
the experiment or adoption. Resume only when the user explicitly reopens it.

## Recommendation

Content mappers are worth exploring for TypeScript project integration and live
host-boundary checking. Keep the existing Effektive compiler and language server,
and begin with a bounded experiment before making the integration a supported
default. The user selected integration only; replacing Effektive's checker is
outside this plan.

Microsoft released TypeScript 7.1 Beta on October 20. Content mappers let
TypeScript load custom extensions as virtual TypeScript and map diagnostics and
editor results back to the original files. See the
[official announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/).

## Advantages we could gain

These are expected benefits from the integration; they have not yet been
demonstrated in Effektive.

| Opportunity | Value for Effektive | Assessment |
| --- | --- | --- |
| Live host checks | Detect disagreements between `.effi` contracts and `.ts` implementations during editing. | Highest value |
| TypeScript consumes `.eff` | Let TypeScript callers check imports against current Effektive source without first generating `.ts` files. | High value, with import-resolution work |
| Navigation across languages | Navigate from TypeScript callers to Effektive declarations and inspect their exported types. | Useful, dependent on mapping precision |
| Standard TypeScript checking | Include Effektive modules in a configured TypeScript project and its checking workflow. | Useful for mixed projects |
| Faster target checks | Use TypeScript's native checker against generated Effect code. | Potentially useful; measure separately |

The mapper protocol supports mapped language-service operations, but TypeScript
explicitly expects languages with complex transformations to retain custom
language servers. That fits Effektive's existing source-specific contracts,
completions and refactoring. See the
[mapper design](https://github.com/microsoft/typescript-go/pull/4712).

## Fit with the current implementation

The compiler already has a suitable boundary:
[`TypeScriptOutputs`](../../src/core/typescript.ts) caches emitted text and
mappings separately from the frontend. An adapter could reuse this pipeline:

`Effektive source → existing checker and lowering → virtual TypeScript → TypeScript 7.1`

Four integration costs need attention:

- **Mapping conversion.** Existing [span tables](../../src/core/emit/spans.ts)
  contain nested ranges. TypeScript requires ordered, non-overlapping virtual
  segments. Its editable mappings also require identical source and generated
  text. Start with diagnostic mappings and enable navigation selectively. See the
  [beta mapping contract](https://github.com/microsoft/TypeScript/blob/3e9236361fa97a9e6c685f4833ac457ae2d8c50a/tsc/internal/spanmap/spanmap.go).
- **Import identity.** Generated modules currently import `.ts` paths; host
  adapters import companions such as `h.effi.ts`. A virtual source project must
  resolve these deliberately and avoid loading separate generated and virtual
  copies of the same module.
- **Unsaved project state.** Effektive checks a project-wide graph, while each
  mapper transformation receives one file's content. Changes to an imported
  contract must invalidate its consumers correctly, regardless of transformation
  order. The protocol does not automatically supply Effektive's complete
  open-document overlay. See the
  [beta protocol](https://github.com/microsoft/TypeScript/blob/3e9236361fa97a9e6c685f4833ac457ae2d8c50a/tsc/internal/contentmapper/hostimpl.go).
- **Runtime output remains necessary.** TypeScript leaves JavaScript emission for
  mapped files to the external compiler or build tool. Keep Effektive's build
  pipeline and debugger source maps. See the
  [beta emission behavior](https://github.com/microsoft/TypeScript/blob/3e9236361fa97a9e6c685f4833ac457ae2d8c50a/tsc/internal/compiler/emitter.go).

There is also a separate version distinction: Effektive's
[`--tsc` implementation](../../src/cli/tsc.ts) invokes `deno check`. During the
analysis, the required Deno 2.9.8 reported TypeScript **6.0.3** locally. The
repository's `typescript@5.9.3` dependency served measurement scripts and
benchmark variants. Bumping that dependency would not upgrade the production
target checker.

## Proposed experiment and acceptance tests

### TCM1: isolated integration experiment

Build an isolated adapter pinned to `typescript@7.1.0-beta`, registered for `.eff`
and `.effi`. Reuse the existing compiler, produce virtual output in memory, and
initially enable diagnostics only. No public frontend or IR changes are planned.

Use a small mixed project containing two Effektive modules, one host interface,
one TypeScript adapter and one TypeScript consumer. Verify:

- Correct programs check without pre-generated `.ts` files.
- Wrong host implementations and invalid TypeScript calls produce useful source
  locations.
- Unsaved imported-contract changes refresh consumer diagnostics; fixing errors
  clears them.
- Results remain correct across transformation order, configuration changes and
  project restart.
- Generated files already present on disk do not create duplicate module
  identities.
- Unicode positions map correctly, and source errors do not produce misleading
  success.

### TCM2: measurements and adoption assessment

Measure cold checking, warm edits and total memory against the existing
workflow. Separate the native-checker benefit from mapper overhead. Adoption
requires correct project state and a demonstrated workflow benefit; speed alone
is insufficient. Record the evidence and recommendation before selecting any
production integration work.

## Defaults and limits

Keep the integration optional during beta. CLI execution requires
`--runExternalCode`; VS Code also requires workspace trust and mapper permission.
See the [execution requirements](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/).

Keep Effektive's semantic diagnostics and editing features authoritative.
Broader package imports, runtime loaders and browser-playground changes remain
outside this experiment. The existing user deferral of broader package
interoperability remains in force; see [project status](../status.md#explicit-user-deferral-item-9).

The original analysis changed no files and ran no prototype or performance
benchmarks. The main unresolved risks are unsaved cross-file invalidation and
generated-versus-virtual module identity.

Before resuming, recheck the TypeScript release and protocol, the repository's
compiler boundaries, and the installed tool versions. The beta pin and source
links above preserve the analysis baseline; they are not a promise that the same
version will be appropriate when this deferred work is reopened.

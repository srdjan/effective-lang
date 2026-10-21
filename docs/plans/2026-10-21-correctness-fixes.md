# Correctness fixes (FX)

Accepted plan based on `4235bd7`; execution starts at `6009708` with Deno
2.9.7 and Effect 4.0.5. Complete before the editor and release plan.

| ID | Work | State |
| --- | --- | --- |
| FX1 | Use permitted PATH `deno` for target checks, playground bundles and benchmark subprocesses. Preserve restricted permissions, arguments, cleanup and exits. Test actual tasks through symlinked and canonical executables and missing executable failures. | Complete |
| FX2 | Preserve sensitive fields in records, updates, constructors, schemas and nominal errors. Use computed `__proto__`, collision-safe null-prototype construction and single-evaluation own optional reads. Adapt declared schema boundary shapes without recursive cloning. Preserve recursion, defaults, optional metadata, directional effects and recovery. | Complete |
| FX3 | Track local host JS/TS and configuration separately from source changes. Watch target checks rerun on edits, additions, removals and polling, retain source/configuration errors, and exclude generated writes. | Complete |

Add failing regressions first, covering absent/present sensitive fields, nesting,
updates, single evaluation, strict targets, schema roundtrips and nominal errors.
Run `deno task check` before each commit. Commit each complete unit on local
`main`. Preserve syntax, independent validation and ordinary output when
helpers are unnecessary. Keep R13/R15 separate. Update owning documentation
and the sibling site separately when status changes.

## FX1 evidence

The added actual-task regression failed with restricted run access before the
fix when PATH pointed at a temporary symlink. It passes through both canonical
and symlinked entry paths after the fix. A missing PATH executable gives the
existing `cannot run deno check` diagnostic. All production subprocess launches
now use PATH `deno`; the task permission lists stay restricted.

## FX2 evidence

`tests/sensitive_fields_slow_test.ts` first reproduced strict target errors for
absent optional Object fields and runtime schema failures from inherited fields.
Six compiled runtime cases now cover present/absent fields, nested records,
updates, one receiver evaluation, recursive roundtrips, codecs, defaults,
directional service effects, and nominal error construction/recovery. Error
schema identity remains nominal: a plain tagged record still is not an instance.
The source checker and independent validator are unchanged. Target adapters
traverse only declared data shapes and preserve error instances. A localized
assertion in the generated construction helper bridges the already checked
source shape to JavaScript own properties. Ordinary examples stay byte-identical.

Optional error presence uses non-enumerable symbol metadata shared by generated
modules; a failing two-module regression established why a per-module map was
insufficient. Helper names also respect source bindings, including `$record`,
`$optionalField`, and `Object`.

## FX3 evidence

`tests/watch_host_test.ts` regresses edits, additions, removals, polling-only
changes, configuration errors and source errors. Generated writes, hidden
folders and dependencies under `node_modules` remain excluded. JSON/JSONC
inputs include arbitrarily named local configuration extensions and import maps.
`tests/watch_host_slow_test.ts` runs actual `watch --tsc`: introducing and fixing
an imported helper's TypeScript error updates diagnostics without an Effective
edit, an Effective recheck, or a generated-output change. The combined Plan A
gate passed 1,763 fast and 171 slow tests before the final configuration-name
coverage addition; the commit gate repeats the full suite with that addition.

## FX2 boundary follow-up

Final release review added regressions for an undeclared throwing getter and
an own optional `unknown` field whose host-supplied value is `undefined`.
The first exposed eager reads of ignored fields; the second exposed the
undefined-based optional read. Adapters now copy property descriptors without
reading extra values, then adapt only declared child shapes. Copied descriptors
are configurable so frozen nested host values remain usable. Sensitive optional
reads use own presence to choose Some/None and retain a present undefined value.
The helper no longer depends on a potentially shadowed `Exclude` type name.
No source form or checker rule changed: void record fields remain illegal.

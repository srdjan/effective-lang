# Approved portable application extensions

Date: 2026-10-23. Baseline: `9498cb3`. PX identifies this plan's implementation units.

The user approved all three extension proposals in [the gap assessment](portable-applications-gaps.md).
That approval selects implementation despite the absence of an application blocker. The three-application stopping rule otherwise remains unchanged.

## Scope and settled decisions

Implement optional import rules, pure function types, and sealed nominal types. Preserve existing behavior when these controls are absent.
Named platforms continue to use existing services and Layers. Add no platform declaration, runtime framework, or predicate solver.

The approved designs in the gap assessment define semantics. This plan defines implementation order and verification.
The main agent owns integration, authoritative checks, documentation, and local commits. Sol agents with high reasoning effort can implement independent units.
All work stays on local `main`. No agent pushes changes.

## PX1: import rules

Add optional `imports` rules to `effektive.json`. The first matching `from` rule controls each module's allowed direct imports.
Resolve ordinary targets before matching normalized paths. Match host targets against their `host:` specifiers.
An unmatched module remains unrestricted. Preserve existing cycle diagnostics and all projects without rules.

Files: project configuration and loading, necessary configuration invalidation paths, and public project tests.
Verification: allowed and denied edges, first-match behavior, malformed configuration, absent-policy compatibility, and updated diagnostics after configuration edits.

## PX2: pure function types

Add `pure (value: T) => U` in function-type positions. Require pure execution and empty failure and requirement rows.
Preserve the effect default for unmarked function types. Preserve effect execution for fully provided operations and empty-row `run` operations.

Files: parser, type checking, independent validation, syntax tooling, and compiler and emitted-runtime tests.
Verification: inferred and imported pure functions, inline callbacks, effect rejection, nonempty-row rejection, validator mutations, and strict generated TypeScript.

## PX3: sealed nominal types

Add `[export] sealed nominal Name = T` in `.eff` files. Reject the modifier in `.effi` files.
Only the declaring module owns construction, retained nominal updates, nominal arithmetic, implicit base widening, and schema derivation or execution.
Apply schema restrictions to nested sealed positions. Preserve outside passing, comparison, and field reads.
The owner can export explicit conversions and decoders. Existing open nominal types retain their current behavior.

Files: parsing and indexing, type facts and interfaces, typed IR, checker, independent validator, syntax tooling, and compiler tests.
Verification: owner success and every outside bypass, private aliases, nested compatibility, schema operations, interface hashes, IR mutations, and emitted execution.

PX3 follows PX2 where parser and type-checker files overlap. PX1 can proceed independently.

## PX4: acceptance and documentation

Update language rules, shared terms, status, and relevant examples. Update the sibling specification and validation history in a separate commit.
Record exact commands, results, review findings, and evidence limits in the companion worklog.

Run focused tests before the full gate. Run `deno task check` before each complete local implementation commit.
Review every worker diff and run authoritative checks in the canonical checkout. Apply valid findings before delivery.

Completion requires passing checks, consistent specifications, local commits, and clean working trees for the work-owned files.

## Limits

Sealing is a source and IR contract. Generated TypeScript and unsound host code remain trusted boundaries.
Import rules enforce project dependencies, not runtime resource authority. Pure source contracts do not prove that a trusted host operation is pure.

# Portable applications: accepted gated roadmap

Date: 2026-10-23. Status: all six phases pass their acceptance checks. Initial revision: `5d0a2a9`.

PP identifies the six phases of this plan. The companion worklog records execution evidence and remaining work.

## Goal and decisions

Demonstrate one source-owned publication application on memory and file-backed SQLite. Determine which architectural guarantees need language or tooling changes.

The user selected a gated roadmap. A demonstrated language gap produces a concrete design for user review before extension implementation.

The user selected a host lexical primitive. Its blankness rule is `value.trim() === ""`. Pure Effektive code decides publication validity and retains original text.

Application orchestration remains in `.eff`. Existing language forms remain the baseline. Broader package interoperability stays deferred.

## Architecture

Domain modules own article states, revisions, assessment, and publication plans. They import no platform contract.

Feature modules own the ArticleStore port, publication workflow, source grants, and failure policy. Application adapters map these ports to platform primitives.

The platform contract owns generic textual KV operations, versions, time, and lexical primitives. Generic platform implementations import no article types.

The typed serialization bridge converts textual payloads to a source-defined storage record. It performs serialization and shape parsing only.

Effektive code owns domain validation, article keys, conditional publication, and conflict policy. Generic platform implementations own authoritative compare-and-set operations.

The public workflow publishes one article. The source batch workflow runs sequentially. Terminal failure starts no later command.

## PP1: contracts and baseline

Define separate domain, feature, platform, storage, and adapter contracts under `fixtures/applications/portable-publisher/`.

Draft and Published are distinct states. Revisions are nonnegative safe integers. Publication refuses advancement at the safe-integer maximum.

The platform uses textual payloads because Effektive does not treat `unknown` as a universal value type. Keys are nonempty, well-formed Unicode strings.

Key comparison is exact, without normalization. Invalid keys fail before writing. Reads return detached entry records.

Conditional writes compare the original read's token. Conflicts write nothing. An uncertain outcome may contain a committed write.

Storage versions differ from domain revisions. Successful writes change versions. SQLite preserves version state after reopening.

Stored records receive shape, identity, revision, and published-state checks. Expected failures distinguish invalid input, absence, corruption, conflict, unavailability, and uncertain writes.

Gate: one minimal application passes source checking, lowering, independent validation, and strict checking of generated TypeScript.

## PP2: memory publication witness

Implement publication and its memory platform with existing forms. Acquire ordinary callable KV records before constructing the feature Layer.

Do not pass function-bearing records through `withResource`. The host scoped lease owns their lifetime.

The workflow loads, classifies text, assesses, plans, and requests conditional publication. It samples time once after content and revision checks.

Invalid and already-published paths do not sample time. A competing edit invalidates the original token, even when that edit reuses a domain revision.

Conflict recovery reloads once. Published returns success. A draft or absent record remains conflict. Failed reloads preserve storage failures.

There is no automatic retry. Nominal identity is not a claim that arbitrary predicates remain sealed.

Gate: public behavior tests and negative source contracts pass. Record a minimal smoke's elapsed time before expanding scenarios.

## PP3: SQLite compatibility

Add file-backed SQLite through existing `node:sqlite` support. Use authoritative conditional writes and report success only after commit.

Run one conformance suite against both platforms. Run the same generated application modules against both implementations.

Inspect persistence through an independent reopened connection. Preserve storage versions across reopen.

Simulate a lost acknowledgement after an actual committed write. Confirm an uncertain result without retry. Label this evidence as a simulation.

Gate: both implementations pass the common suite. SQLite independently proves persisted article data and version continuity.

## PP4: lifetime and capabilities

Implement a finite batch driver with explicit acquisition and release. Successful execution waits for the final operation before releasing the platform.

Failure and interruption await cleanup. Test acquisition, startup, execution, and release failures. Preserve simultaneous execution and release failures.

The source grant issuer owns explicit revocation. A grant binds one article identifier. Revocation refuses later calls without promising active-call cancellation.

The host separately invalidates primitive operations when its lease closes. Test captured operations after release.

Gate: deterministic completion, cancellation, cleanup, revocation, and invalidation checks pass. This establishes no HTTP admission or server-shutdown guarantee.

## PP5: language and tooling dispositions

Evaluate named platforms, sealed source types, explicit purity contracts, and architectural import rules independently.

Named-platform evaluation concerns identity, entry compatibility, and implementation selection. Architectural import evaluation concerns allowed dependency edges.

Sealing probes cover current nominal construction, cross-module updates, base-type widening, arithmetic, and schema decoding. Recheck current syntax before selecting each witness.

Purity probes include fully supplied effects, empty failure and requirement rows, imported functions, and higher-order callback requirements.

Each candidate receives one disposition: existing composition, tooling gap, or language gap. A successful existing composition ends that candidate without new machinery.

A retained gap receives a concrete extension design. That design specifies syntax or configuration, compatibility, interfaces, IR, validation, emission, editor effects, and acceptance tests.

Gate: counterexamples support every retained gap. The user receives the designs before extension implementation. Do not add language forms in this plan.

## PP6: evidence and acceptance

Record commands, results, limits, and candidate dispositions. Distinguish trusted-host promises, tested behavior, and simulated failures.

The accepted three-application stopping rule remains unchanged. The new witness does not expand that target automatically.

Update factual status and documentation. Any project-status change also requires a separate documentation commit in the sibling website repository.

Gate: required checks pass, documentation agrees with evidence, and every candidate has a disposition or a design awaiting review.

## Verification and delivery

Fast tests cover checking, lowering, independent validation, and weakened source contracts. The existing application harness covers emitted memory execution.

A dedicated integration slow test covers SQLite with filesystem permissions limited to its temporary directory. Tests use barriers rather than timing sleeps.

Publication scenarios cover valid, blank, malformed, missing, published, exhausted revisions, and corrupt records. Conflict checks cover competing publications, edits, and failed reloads.

Platform checks cover create-if-absent, stale versions, competing writers, detached reads, invalid keys, exact key comparison, and close/reopen persistence.

Lifetime checks cover successful completion, interruption, acquisition and startup failures, release failures, and simultaneous failures. Grant checks cover binding and future-call revocation.

Each complete unit receives a local commit on `main`. Run `deno task check` before each commit. Never push.

## Limits

HTTP, Deno KV, distributed transactions, crash recovery, and exactly-once delivery are outside this witness. Synchronous SQLite operations do not become interruptible.

The implementing agent owns PP1 through PP6. The user owns review of retained extension designs.

# Extreme identifier formatting

The user approved this maintenance task on 2026-10-20. The target is Deno
2.9.7. The six exceptions in the A6b rules ledger define the scope.
This task changes emitted whitespace, preserves source names and semantics,
and keeps the core synchronous and free of I/O. The printer must record source
spans after layout. No external formatter runs in the emission pipeline.

## TODO

- [x] FI1: Reproduce all six cases and measure their wrapping boundaries.
- [x] FI2: Format long TaggedError type arguments.
- [x] FI3: Format long struct fields and Schema member chains.
- [x] FI4: Format long function names, including block bodies.
- [x] FI5: Format member access at a dot without changing evaluation.
- [x] FI6: Format yield* Service.use bindings.
- [x] FI7: Format long parameter annotations.
- [x] FI8: Verify boundary cases, strict emitted types, runtime behavior and source mappings.
- [x] FI9: Update the README and rules ledger only for passing cases.
- [x] FI10: Pass deno task check and commit the compiler change.
- [x] FI11: Update the website validation record, run its checks and commit separately.
- [x] FI12: Format long Schema initializers reached by parameter-type probes.
- [x] FI13: Format long service type arguments reached by the service-call probes.
- [x] FI14: Cover long fields in record values and long error-constructor calls, reached by executable fixtures.
- [x] FI15: Cover optional-field, brand-constructor and Schema-constructor member accesses reached by related probes.
- [x] FI16: Record the parent-layout rule in a solution note for future emitter changes.
- [x] FI17: Investigate the Markdown audit's 31 reported links. All are existing line-addressed references outside this change; their file paths resolve after removing the line suffix, which the helper does not support.
- [x] FI18: Preserve the existing reduce fixture's fixed point when its function type and callback break together. Use the ordinary type-argument printer.
- [x] FI19: Remeasure later groups after every rendered line break, including soft breaks inside a still-flat parent. The existing reduce fixture reproduces the interaction; its fixed-point check and all 115 focused tests pass.

Each new failure receives an item and a final status here. Historical audit
decisions remain historical; this plan records the newly approved work.

## Evidence

A source probe compared emitted text with Deno 2.9.7 formatting for identifier
lengths 30 through 110. Before the fix, its first differences occurred at 48
characters for error names, 63 for struct fields, 64 for function names and
block-bodied function names, 63 for member fields, 45 for service names and
51 for parameter type names. These are measurements for those probe contexts,
not universal identifier limits. After the fix, all 567 comparisons pass.

The permanent test checks 274 modules. It includes the six exceptions, block
bodies, zero-argument arrows, nested and optional reads, long parameter names,
brand constructors and Schema constructors. It runs emitted code, checks
strict TypeScript and formatting, verifies mapped source tokens after new
breaks, and checks that an effectful member base runs once.
The focused emitter, printer, span and source-map suite passes 115 tests.

Concurrent pruning edits belong to another task. This change owns only the
emitter modules, its new regression, these formatting docs and the FI prefix.

## Completion

The full deno task check passes on Deno 2.9.7: formatting, lint, type checking,
1,676 fast tests and 152 slow tests. The first combined run exposed the reduce
layout interaction; FI18 and FI19 resolve it without weakening that fixture.
The final run passes. Log: /private/tmp/extreme-identifiers-full-check-final.log.

The website records the resolved limitation and the printer contract in a
separate commit. Its eleven tests, 48 strict Effect-TS units and Markdown
link audit pass. All formatting TODO items are complete. The source-unreachable
arrow-chain case in the A6b ledger remains outside this task.

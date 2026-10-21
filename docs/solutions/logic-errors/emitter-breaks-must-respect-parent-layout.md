---
title: Conditional emitter breaks must respect the parent layout
date: 2026-10-20
module: src/core/emit/doc.ts
problem_type: logic_error
tags: [emitter, formatting, deno-fmt, source-maps, long-identifiers]
---

# Conditional emitter breaks must respect the parent layout

The emitter previously recorded six exceptions for very long identifiers.
Deno 2.9.7 changed their whitespace after emission. The cases included error
type arguments, struct fields, function names, member accesses, service bindings
and parameter annotations.

A field must stay unsplit while its enclosing list tests a flat layout.
Only after that list breaks can the printer move the field value below its
label. Otherwise an inner hard break can make the outer list appear to fit.
The result can keep an opening brace or parameter on the wrong line.

The `property` helper uses `ifBreak` to preserve that order. Its conditional
hard break lives inside `alt`, so it does not force every parent group to break.
The `assignment` helper measures the value's opening rather than its full
body. The `member` helper measures call heads and permits a break at an earlier
dot in a qualified Schema base. Probes include trailing punctuation when the
last column determines the layout.

After any rendered line break, the renderer must measure later groups against
the new column. This includes a soft break inside a still-flat parent command.
Without that measurement, a later call can inherit flat mode and exceed the
line width. The existing reduce fixture checks this interaction between a
function type and a callback.

Long error and service type arguments use the existing type-argument printer.
Optional reads and error constructors use the ordinary call-argument printer.
The core does not invoke Deno formatting. The renderer records spans while it
lays out the final text, so the new breaks preserve source mappings.

`tests/emit_extreme_identifiers_slow_test.ts` checks 273 generated modules.
It checks Deno formatting, strict target types, runtime results, mapped source
tokens and evaluation of an effectful member base exactly once. Boundary widths
include adjacent passing and failing lengths from the original probes.
These lengths describe those contexts, not universal limits on identifiers.

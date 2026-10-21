---
title: Emitted fields must preserve own-property presence
date: 2026-10-21
module: src/core/emit/fields.ts
problem_type: logic_error
tags: [emitter, schemas, records, optional-fields, errors]
---

# Emitted fields must preserve own-property presence

Legal source fields can collide with JavaScript prototype properties. An object
literal's uncomputed `__proto__` key changes its prototype, and an ordinary read
can find inherited `constructor`, `message`, or `name` values. Neither behavior
represents a supplied source field.

The emitter uses computed `__proto__` keys and fresh null-prototype records where
the checked shape needs protection. Collision-safe helpers evaluate an optional
receiver once and use own presence to select Some or None. A present optional
`unknown` value can contain host `undefined`; testing its value would incorrectly
turn that field into None. The generated construction helper contains one
documented assertion after source checking.

Schema boundaries follow declared decoded and encoded shapes, including guarded
recursion, rather than recursively cloning arbitrary host data. Descriptor copies
avoid evaluating undeclared getters. Their configurable descriptors allow child
adaptation even when the input is frozen. Existing defaults, optionality and
directional effects stay under the Schema implementation's control.

Nominal errors retain their instances. Non-enumerable symbol metadata records
which optional source fields were supplied, so inherited names and a generated
stack cannot become source data. The symbol is shared across generated modules;
a module-local map loses presence when an error crosses an import boundary.

Seven compiled runtime tests in `tests/sensitive_fields_slow_test.ts` check absent
and present names, nested records and updates, one receiver evaluation, schema
roundtrips, frozen inputs, ignored getters, directional effects, cross-module
nominal errors and helper-name collisions. Ordinary emitted examples retain their
existing output. The checker and independent validator do not change.

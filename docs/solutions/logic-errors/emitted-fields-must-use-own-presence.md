---
title: Emitted fields must preserve own-property presence
date: 2026-10-21
module: src/core/emit/fields.ts
problem_type: logic_error
tags: [emitter, schemas, records, optional-fields, errors, nominal-types]
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

## Nominal record copies (added 2026-10-23, updated for the nominal declaration)

Construction of a nominal record prints `$untagged<T>(value)` for each argument
whose IR node is not a `record` literal (`src/core/emit/fields.ts:161-172`,
`src/core/emit/expr.ts:729`). Before the `nominal` declaration, `unbrand`
printed this copy. Now a nominal value fits its base type with no call, so a
widened value can reach another constructor with its old `_tag`. The helper
copies the own fields, except `_tag`, into an object with no prototype. Both
parts are necessary.

The copy leaves out `_tag`, because `Schema.TaggedStruct(...).make` rejects an
input that still has the tag of another nominal record. So `Twin(user)` fails
with "Schema validation failed" when the copy keeps `_tag`. Only the top level
needs the copy. Measured on Effect 4.0.5: a nested `Struct` field drops a
foreign `_tag`. `Schema.is` of a structural schema accepts the value, and its
encode and decode drop the tag.

The copy has no prototype, because `make` reads an optional field through the
prototype chain. A probe on Effect 4.0.5 showed this. A nominal record with the
optional field `toString?: Text` fails `make` for the plain object
`{ label: "a" }`, because the object inherits the function `toString` from
`Object.prototype`. The same input with a null prototype passes. So a shorter
copy such as `({ _tag, ...rest }) => rest` brings the failure back for any
nominal record with an optional field whose name is on `Object.prototype`.

During the work, the implementer first gave the cause as an own `constructor`
field. That explanation was wrong: a probe with an own `constructor` field and
no optional prototype name passes with a plain spread. Keep the null-prototype
copy, and test a change to it with an optional field such as `toString`.


# Canonical spec amendment for collection literals and traversal

Status: implemented and applied to the canonical spec. The canonical file is
`/Users/srdjans/Code/effektive/public/effektive-spec.html`.

The [unified patch](2026-10-17-spec-amendment-collections.patch) applies these
rules to the canonical HTML. It was applied on 2026-10-17.

## Data and types

Add after the record-construction rule:

> A bracket expression constructs an immutable list. An expected tuple type
> requires the exact element count and checks each element against its position.
> Otherwise an expected array type checks each element against its element
> type. Without an expected type, a nonempty homogeneous list infers an array
> after literal widening. An empty list or elements without a common array
> element type require a contextual type. A trailing comma is allowed.

The elements evaluate once, from left to right. A failed element stops
evaluation. Their active failures and requirements are combined in the list
expression. The tuple or array choice is preserved in typed IR; the Effect
backend emits a JavaScript array for either shape.

## Pipelines and collections

Change the prelude sentence to name `traverse` alongside `map`, `filter`, and
`fold`. Replace the statement that all prelude callbacks must be pure with:

> The callbacks of map, filter, and fold require pure execution mode and empty
> failure and requirement sets. `traverse(items, callback)` accepts a pure or
> effectful callback, invokes it once per item from left to right, and returns
> an array in input order. It is an effectful operation even when the callback
> is pure. Its active failure and requirement sets include those of callback
> invocation. An empty array invokes no callbacks. A typed callback failure
> stops traversal before later items.

Remove the sentence that says effectful traversal remains outside version 0.
The Effect backend translates `traverse` to `Effect.forEach(items, callback)`
without a concurrency option. A pure callback is lifted into an Effect
callback. Pipeline form passes the left value as the first argument.

## Surface grammar

Add `listExpr = "[" [expression ("," expression)* [","]] "]"` to the
grammar and include list expressions among primary expressions. The same
brackets remain tuple syntax in a type position. The source rule is distinct
from a tuple type: context determines whether the expression is a tuple or an
array.

## Conformance and examples

Add fixtures for empty lists with and without context, tuple length and type
checks, heterogeneous lists without context, effectful elements, and traversal
with callback failure and requirements. Verify `check`, `build --validate`,
`build --tsc`, and sequential runtime order. The repository now contains these
checks; the canonical spec's delivered-checks and "no transpiler" statements
also need a separate factual update when that site is published.

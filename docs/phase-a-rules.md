# Phase A rules where the spec is silent

Status: ledger, 2026-10-16. The spec owner can override each rule. Each rule
names the part that chose it. The plan sets the policy: when the spec is silent,
the implementer picks the stricter rule and records it here.

## Lexer and parser (A1)

| Rule | Choice |
| --- | --- |
| Raw control characters in strings | Rejected (`syntax/003`), because JSON rejects them |
| Leading zeros in numbers | `01` is rejected (`syntax/006`) |
| Union continuation | A newline before `\|` does not continue a type; a newline after `\|` does |
| `fails` and `uses` on a new line | Continue a clause only when an identifier follows |
| `Some(_)` | Accepted; `_` is the binding name |
| Nesting depth | 512 levels of expressions and types; deeper input is `syntax/009` |
| Parenthesized types | `(A \| B)[]` and the empty tuple type are accepted |

## Projects and names (A2)

| Rule | Choice |
| --- | --- |
| Namespace | One namespace per module for types, errors, services, providers, constants, and imports |
| Prelude names | Neither modules nor locals may declare them; modules also may not declare builtin type names |
| Shared scopes | A block after a parameter list, pattern, or handler shares its scope, so a redeclaration is `declaration/001` |
| Early outer use | A block that uses an outer name and later binds the same name is `declaration/004` |
| Own initializer | `const x = x` is `unknown-name/001` |
| Module paths | Only letters, digits, `_`, `.`, `-`, and `/` |

## Declarations and types (A3a)

| Rule | Choice |
| --- | --- |
| `Brand<T>` position | Only as the whole body of a `type` declaration |
| `unknown` | Not a top type: only `unknown`, `never`, and the error type fit it |
| Private parameters | A module function parameter needs an annotation when nothing supplies its type (`declaration/011`) |
| Function types in type syntax | Execution defaults to `effect` |
| Provider compatibility | Equal `provides`, compatible execution, acquisition sets as subsets |
| Interface hash | Ignores spans, so comments and body edits do not change it |

## Expressions, modes, and contracts (A3b)

| Rule | Choice |
| --- | --- |
| Contract diagnostics | One diagnostic per function lists every extra error or capability |
| Literal widening | Unannotated bindings, branch joins, inferred results, and the `fold` accumulator widen literals to primitives |
| Branch joins | Without an expected type, one branch type must accept the other; no union is formed |
| Local recursion | A block-level function cannot call itself (`execution-mode/003`) |
| Mode fixed point | Round cap 32 (`execution-mode/004`) |
| Equality | Compares string, numeric, boolean, or one primitive brand; records and options are rejected |
| `retry` form | The second argument must be the literal record `{ times: N }` |
| Broken declarations | Checked for side tables; their body diagnostics are suppressed until the syntax is fixed |
| Effect type order | Sorted identity order everywhere, including `typeAt` |

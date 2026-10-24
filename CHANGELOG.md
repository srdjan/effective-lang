# Changelog

## 0.8.0 - 2026-10-24

Write less source while keeping explicit exported contracts:

- Omit parentheses around a single unannotated callback parameter: `user => user.name`.
- Unwrap an Option with `option ?? fallback`; the fallback runs only for `None`.
- Bind record fields inside a block: `const { id, revision: expectedRevision } = article`.
- Manage resources with `using (job = openJob()) { job.execute() } finally { job.close() }`.

The editor supports navigation, rename, completion, hover, and highlighting for
these forms. Examples and the language specification use the new syntax.

Includes the standalone CLI, language server, VS Code extension, and browser
playground. Requires Deno 2.9.8 and targets Effect 4.0.5.

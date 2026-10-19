// Assertion helpers for Schema negative tests. A negative case must name the
// rule that rejects it: the diagnostic code, a fragment of the message, and
// where the source is available the text of the offending node. A bare
// `length > 0` check passes when an unrelated diagnostic fires first.

import { assert, assertEquals } from "@std/assert";
import type { Diagnostic } from "../src/core/mod.ts";

/**
 * One expected checker diagnostic: the code, a fragment of the message, and
 * optionally the exact source text of the node that carries the span.
 */
export type Expected = readonly [
  code: string,
  fragment: string,
  text?: string,
];

/** One negative case: a declaration and the diagnostics it must produce. */
export type Case = readonly [declaration: string, ...expected: Expected[]];

/** The message of the module-constant rule that fires beside many Schema errors. */
export const PURE_CONSTANT = "a module constant must have a pure initializer";

/**
 * Checks each case. `build` makes the full source from the declaration, and
 * `diagnosticsOf` runs the checker on it.
 */
export function assertRejected(
  cases: readonly Case[],
  build: (declaration: string) => string,
  diagnosticsOf: (source: string) => readonly Diagnostic[],
): void {
  for (const [declaration, ...expected] of cases) {
    const source = build(declaration);
    assertDiagnostics(source, diagnosticsOf(source), expected, declaration);
  }
}

/** Requires exactly the expected diagnostics, in order. */
export function assertDiagnostics(
  source: string,
  diagnostics: readonly Diagnostic[],
  expected: readonly Expected[],
  label: string,
): void {
  const shown = JSON.stringify(
    diagnostics.map((d) => [
      d.code,
      d.message,
      source.slice(d.span.start, d.span.end),
    ]),
  );
  assertEquals(
    diagnostics.map((d) => d.code),
    expected.map(([code]) => code),
    `${label}: ${shown}`,
  );
  expected.forEach(([, fragment, text], index) => {
    const diagnostic = diagnostics[index];
    assert(
      diagnostic.message.includes(fragment),
      `${label}: message ${JSON.stringify(diagnostic.message)} lacks ${
        JSON.stringify(fragment)
      }`,
    );
    if (text !== undefined) {
      assertEquals(
        source.slice(diagnostic.span.start, diagnostic.span.end),
        text,
        `${label}: offending node`,
      );
    }
  });
}

/**
 * Requires a validator diagnostic with `code` whose message starts with the IR
 * `path` of the mutated node, for example `declarations[7].value.type`. The
 * optional fragment must occur later in the same message.
 */
export function assertValidation(
  diagnostics: readonly Diagnostic[],
  code: string,
  path: string,
  fragment: string | undefined,
  label: string,
): void {
  const shown = JSON.stringify(diagnostics.map((d) => [d.code, d.message]));
  assert(
    diagnostics.some((d) =>
      d.code === code && d.message.startsWith(`${path}:`) &&
      (fragment === undefined || d.message.includes(fragment))
    ),
    `${label}: expected ${code} at ${path}${
      fragment === undefined ? "" : ` with ${JSON.stringify(fragment)}`
    }, got ${shown}`,
  );
}

/** The IR path prefix of the named top-level declaration. */
export function declarationPath(
  module: { readonly declarations: readonly { readonly name?: string }[] },
  name: string,
): string {
  const index = module.declarations.findIndex((d) => d.name === name);
  assert(index >= 0, `no declaration named ${name}`);
  return `declarations[${index}]`;
}

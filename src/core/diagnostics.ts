// Diagnostics are data. Each code has one entry in the registry below.
// A part registers only the codes that it emits.

import { compareSpans, type Span } from "./source.ts";

export type Category =
  | "syntax"
  | "unknown-name"
  | "type-mismatch"
  | "failure-contract"
  | "requirement-contract"
  | "execution-mode"
  | "pattern"
  | "declaration"
  | "module"
  | "host-boundary";

export type Severity = "error" | "warning";

interface CodeInfo {
  readonly category: Category;
  readonly description: string;
}

/** The registry. A code is `<category>/<three digits>`. */
export const DIAGNOSTIC_CODES = {
  "syntax/001": {
    category: "syntax",
    description:
      "The source contains a character that the language does not use.",
  },
  "syntax/002": {
    category: "syntax",
    description: "A string literal has no closing quote on its line.",
  },
  "syntax/003": {
    category: "syntax",
    description:
      "A string literal contains an escape sequence or a raw control character that JSON does not allow.",
  },
  "syntax/004": {
    category: "syntax",
    description:
      "A block comment has no closing marker before the end of the file.",
  },
  "syntax/005": {
    category: "syntax",
    description: "A number literal is not a finite value.",
  },
  "syntax/006": {
    category: "syntax",
    description: "A number literal is malformed.",
  },
  "syntax/007": {
    category: "syntax",
    description: "A reserved JavaScript word is used as an identifier.",
  },
  "syntax/008": {
    category: "syntax",
    description:
      "The parser expected a token or a construct that is not present.",
  },
  "syntax/009": {
    category: "syntax",
    description:
      "The parser found a token that cannot start or continue a construct.",
  },
  "syntax/010": {
    category: "syntax",
    description: "A unary operator is used. Version 0 has no unary operators.",
  },
  "syntax/011": {
    category: "syntax",
    description: "A pattern is not one of the supported flat forms.",
  },
  "syntax/012": {
    category: "syntax",
    description: "A host interface file contains a const declaration.",
  },
  "syntax/013": {
    category: "syntax",
    description:
      "A provider declaration appears outside a host interface file.",
  },
  "syntax/014": {
    category: "syntax",
    description:
      "A record expression has a spread that is not the first and only spread.",
  },
  "unknown-name/001": {
    category: "unknown-name",
    description:
      "A name in an expression, a type, or a clause has no declaration or binding in scope.",
  },
  "unknown-name/002": {
    category: "unknown-name",
    description:
      "An import names a declaration that the module does not have, or one that it does not export.",
  },
  "unknown-name/003": {
    category: "unknown-name",
    description: "A service has no method with the given name.",
  },
  "unknown-name/004": {
    category: "unknown-name",
    description:
      "A name resolves to a declaration of the wrong kind for its position, or a builtin appears outside a call.",
  },
  "type-mismatch/001": {
    category: "type-mismatch",
    description:
      "A type has the wrong number of type arguments, or a name that takes no type arguments has some.",
  },
  "type-mismatch/002": {
    category: "type-mismatch",
    description:
      "void appears as a record field, an array element, or a tuple element.",
  },
  "declaration/001": {
    category: "declaration",
    description:
      "Two declarations or bindings use the same name in one namespace or scope.",
  },
  "declaration/002": {
    category: "declaration",
    description:
      "A declaration or binding uses a name that the prelude or the builtin types reserve.",
  },
  "declaration/003": {
    category: "declaration",
    description:
      "A provider declaration names a service method or a non-service in its provides clause.",
  },
  "declaration/004": {
    category: "declaration",
    description:
      "A block binding has the name of an outer binding that the block already used before the binding.",
  },
  "declaration/005": {
    category: "declaration",
    description:
      "An exported function lacks a parameter annotation or a result annotation, and no binding type annotation supplies them.",
  },
  "declaration/006": {
    category: "declaration",
    description:
      "An exported constant that is not a function has no binding type annotation.",
  },
  "declaration/007": {
    category: "declaration",
    description:
      "A type definition refers to itself, directly or through other aliases, brands, or errors.",
  },
  "declaration/008": {
    category: "declaration",
    description:
      "Brand<T> appears somewhere other than as the whole body of a type declaration.",
  },
  "declaration/009": {
    category: "declaration",
    description:
      "An error declaration has a field named _tag, which generated error tags reserve.",
  },
  "declaration/010": {
    category: "declaration",
    description: "A record type has two fields with the same name.",
  },
  "declaration/011": {
    category: "declaration",
    description:
      "A parameter of a module-level function, a service method, or a function type has no type annotation.",
  },
  "module/001": {
    category: "module",
    description:
      "A module reference is not valid: the import specifier or a project file entry breaks the module rules, or two files share one module name.",
  },
  "module/002": {
    category: "module",
    description:
      "An import names a file or a host module that does not exist, is not registered, or cannot be read.",
  },
  "module/003": {
    category: "module",
    description: "Modules import each other in a cycle.",
  },
} as const satisfies Readonly<Record<string, CodeInfo>>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export interface RelatedSpan {
  readonly span: Span;
  readonly message: string;
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly category: Category;
  readonly severity: Severity;
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly RelatedSpan[];
}

export function registeredCodes(): readonly DiagnosticCode[] {
  return Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[];
}

export function categoryOf(code: DiagnosticCode): Category {
  return DIAGNOSTIC_CODES[code].category;
}

export function describeCode(code: DiagnosticCode): string {
  return DIAGNOSTIC_CODES[code].description;
}

export function makeDiagnostic(
  code: DiagnosticCode,
  message: string,
  span: Span,
  related?: readonly RelatedSpan[],
): Diagnostic {
  const base = {
    code,
    category: categoryOf(code),
    severity: "error" as const,
    message,
    span,
  };
  return related === undefined || related.length === 0
    ? base
    : { ...base, related };
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const bySpan = compareSpans(a.span, b.span);
  if (bySpan !== 0) return bySpan;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

/** Sorts by span, then code, then message. The input is not changed. */
export function sortDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return [...diagnostics].sort(compareDiagnostics);
}

/** Removes diagnostics with equal code, span, and message. Keeps the first of each. */
export function dedupeDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key =
      `${d.code}\u0000${d.span.source}\u0000${d.span.start}\u0000${d.span.end}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(d);
  }
  return result;
}

/** Sort and dedupe. Publish diagnostics in this form. */
export function normalizeDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return dedupeDiagnostics(sortDiagnostics(diagnostics));
}

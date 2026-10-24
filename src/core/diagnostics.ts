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
  | "sealed"
  | "host-boundary"
  | "validation";

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
  "type-mismatch/003": {
    category: "type-mismatch",
    description:
      "A value has a type that does not fit the type that its context expects: an argument, a result, a binding annotation, a field, or a branch.",
  },
  "type-mismatch/004": {
    category: "type-mismatch",
    description:
      "A call, a constructor, or a prelude function gets the wrong number of arguments.",
  },
  "type-mismatch/005": {
    category: "type-mismatch",
    description:
      "A record construction or update has a missing, duplicate, or unknown field, or an update has a base that is not a record.",
  },
  "type-mismatch/006": {
    category: "type-mismatch",
    description:
      "A field read names a field that the record type does not have, or reads a field of a value that is not a record.",
  },
  "type-mismatch/007": {
    category: "type-mismatch",
    description:
      "An operator or a condition gets an operand of the wrong type. Conditions must be boolean.",
  },
  "type-mismatch/008": {
    category: "type-mismatch",
    description:
      "A call names a value that is not a function, or a service method appears where it is not called.",
  },
  "type-mismatch/009": {
    category: "type-mismatch",
    description:
      "The branches of an if, a match, or a try have no common result type.",
  },
  "type-mismatch/010": {
    category: "type-mismatch",
    description:
      "A prelude function or constructor gets an argument that it does not accept: fail, retry, provide, a nominal constructor, or a collection builtin.",
  },
  "type-mismatch/011": {
    category: "type-mismatch",
    description:
      "A parameter of a local function has no type annotation, and the context gives no function type for it.",
  },
  "type-mismatch/012": {
    category: "type-mismatch",
    description:
      "A bracket literal lacks an expected type for an empty list or has incompatible element types or tuple length.",
  },
  "failure-contract/001": {
    category: "failure-contract",
    description:
      "The body of a function with a written fails clause can fail with errors that the clause does not list. An exported function and a function with a binding type annotation have a written fails clause, empty when omitted.",
  },
  "failure-contract/002": {
    category: "failure-contract",
    description:
      "A catch handler names an error that the protected block cannot fail with.",
  },
  "failure-contract/003": {
    category: "failure-contract",
    description: "A catch clause has two handlers for the same error.",
  },
  "requirement-contract/001": {
    category: "requirement-contract",
    description:
      "The body of a function with a written uses clause needs service methods that the clause does not list. An exported function and a function with a binding type annotation have a written uses clause, empty when omitted.",
  },
  "execution-mode/001": {
    category: "execution-mode",
    description:
      "A callback of map, filter, or fold is not pure, or has failures or requirements.",
  },
  "execution-mode/002": {
    category: "execution-mode",
    description:
      "A module constant has an initializer that is not pure or has nonempty failure or requirement sets.",
  },
  "execution-mode/003": {
    category: "execution-mode",
    description:
      "A function calls itself, directly or through other functions, without a parameter and result annotation, or a block-level function refers to itself.",
  },
  "execution-mode/004": {
    category: "execution-mode",
    description:
      "The execution modes and effect sets of a recursive group did not settle within the round cap.",
  },
  "execution-mode/005": {
    category: "execution-mode",
    description: "A pure function type declares a failure or requirement row.",
  },
  "pattern/001": {
    category: "pattern",
    description:
      "A match does not cover every value of its subject. Unbounded primitives need a final wildcard.",
  },
  "pattern/002": {
    category: "pattern",
    description:
      "A match arm can never run, because an earlier arm or a wildcard already matches its values.",
  },
  "pattern/003": {
    category: "pattern",
    description:
      "A pattern names a constructor, a literal, or a tag that does not belong to the type of the subject.",
  },
  "pattern/004": {
    category: "pattern",
    description:
      "A pattern is malformed for its use, or the subject has a type that version 0 cannot match.",
  },
  "declaration/001": {
    category: "declaration",
    description:
      "Two declarations or bindings use the same name in one namespace or scope.",
  },
  "declaration/002": {
    category: "declaration",
    description:
      "A declaration or binding uses a name that the prelude, the builtin types, or the generated TypeScript reserve.",
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
      "A type definition refers to itself, directly or through other aliases, nominal types, or errors.",
  },
  "declaration/009": {
    category: "declaration",
    description:
      "A nominal or error declaration has a field named _tag, which generated tags reserve. A nominal type over a record alias has the field through the alias.",
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
  "declaration/012": {
    category: "declaration",
    description:
      "A type declaration is nested deeper than 128 levels, counting the levels inside its aliases.",
  },
  "declaration/013": {
    category: "declaration",
    description:
      "A primitive type (string, int, number, boolean, or a literal type) appears outside the body of a type, nominal, or error declaration.",
  },
  "declaration/014": {
    category: "declaration",
    description:
      "A nominal body is a nominal record, or a union that has a record or a nominal record as a member. Declare each record alone.",
  },
  "declaration/015": {
    category: "declaration",
    description:
      "A nominal or error declaration has a field, or a nominal declaration has a body, whose type contains a function or deferred type (Effect, Fiber, Stream, Sink, Schedule, RetrySchedule, Ref, Codec, Schema, provider, or scope), directly or through an alias. The emitter has no schema for such a type.",
  },
  "declaration/016": {
    category: "declaration",
    description:
      "A nominal or error field, or the body of a nominal type, contains an opaque type, directly or through an alias. An opaque type has no schema, so the emitter cannot build one for the declaration.",
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
  "module/004": {
    category: "module",
    description:
      "Module constants depend on each other in a cycle, directly or through functions, so the module cannot initialize.",
  },
  "module/005": {
    category: "module",
    description:
      "A direct import is not allowed by the first matching project import rule.",
  },
  "sealed/001": {
    category: "sealed",
    description:
      "A module constructs a sealed nominal type that another module declares.",
  },
  "sealed/002": {
    category: "sealed",
    description:
      "A record update retains a sealed nominal type outside its declaring module.",
  },
  "sealed/003": {
    category: "sealed",
    description:
      "Arithmetic uses a sealed nominal type outside its declaring module.",
  },
  "sealed/004": {
    category: "sealed",
    description:
      "A module derives or executes a Schema or Codec that produces a foreign sealed nominal type.",
  },
  "host-boundary/001": {
    category: "host-boundary",
    description:
      "A host module does not match its declaration file: the TypeScript module that implements a provider disagrees with the provider type that the host interface file declares.",
  },
  "validation/001": {
    category: "validation",
    description:
      "Identity: a reference, a capability, an import, an export, a type name, or a declaration identity does not resolve in its scope, or an identity is declared twice.",
  },
  "validation/002": {
    category: "validation",
    description:
      "Types: a recorded type differs from the type that the validator recomputes, or an argument, a field, a branch, a pattern, or a function result does not fit its type.",
  },
  "validation/003": {
    category: "validation",
    description:
      "Contracts: a recorded failure set or requirement set differs from the recomputed set, or a function body exceeds the sets that its signature declares.",
  },
  "validation/004": {
    category: "validation",
    description:
      "Execution: a recorded execution mode differs from the recomputed mode, or a builtin callback is not pure with empty sets.",
  },
  "validation/005": {
    category: "validation",
    description:
      "Recovery: a catch handler names a tag that the protected block cannot fail with, a tag has two handlers, or the branches of a catch have no common type.",
  },
  "validation/006": {
    category: "validation",
    description:
      "Control: a retry job or a provide job is not a zero-argument function, a retry count is not a finite nonnegative safe integer, or a provider expression has no provider type.",
  },
  "validation/007": {
    category: "validation",
    description:
      "Initialization: a module constant has an initializer that is not pure or that has nonempty failure or requirement sets.",
  },
  "validation/008": {
    category: "validation",
    description:
      "Serialization: an effect set is not sorted and unique, a literal is not finite, a span names a source that is not supplied or lies outside its text, or the IR has an unexpected shape.",
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

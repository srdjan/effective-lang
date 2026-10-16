// Serialization of typed IR (spec, "Equations and validation", row
// Serialization): sets are sorted and unique, and literals are finite.
//
// The output is canonical JSON: object keys in sorted order, two-space
// indentation, and a trailing newline. A key with an `undefined` value is left
// out. The check runs before the text is produced, so a bad module gives an
// error value and no text.

import type { ModuleIR, Result } from "./ir.ts";

export type SerializeError =
  /** A `failures` or `requirements` list that is not sorted, or that repeats an entry. */
  | {
    readonly tag: "unsorted-set";
    /** Where the list sits, as `declarations[2].body.effects.failures`. */
    readonly path: string;
  }
  /** A number literal that is `NaN` or infinite. */
  | { readonly tag: "non-finite-number"; readonly path: string };

const SET_KEYS: ReadonlySet<string> = new Set(["failures", "requirements"]);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the list holds strings in strictly increasing order. */
function isSortedUnique(list: readonly unknown[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "string") return false;
    const previous = list[i - 1];
    if (
      i > 0 && typeof previous === "string" && compareText(previous, item) >= 0
    ) {
      return false;
    }
  }
  return true;
}

/** Finds the first violation in tree order, or undefined. */
function findProblem(value: unknown, path: string): SerializeError | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : { tag: "non-finite-number", path };
  }
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = findProblem(value[i], `${path}[${i}]`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (SET_KEYS.has(key) && Array.isArray(item) && !isSortedUnique(item)) {
      return { tag: "unsorted-set", path: `${path}.${key}` };
    }
    const problem = findProblem(item, `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function print(value: unknown, indent: string): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${inner}${print(item, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort(
    compareText,
  );
  if (keys.length === 0) return "{}";
  const members = keys.map((key) =>
    `${inner}${JSON.stringify(key)}: ${print(record[key], inner)}`
  );
  return `{\n${members.join(",\n")}\n${indent}}`;
}

/**
 * The canonical JSON text of a module. The result is an error value when an
 * effect set is not sorted and unique or when a number literal is not finite.
 */
export function serializeModule(
  module: ModuleIR,
): Result<string, SerializeError> {
  const problem = findProblem(module, "$");
  if (problem !== undefined) return { ok: false, error: problem };
  return { ok: true, value: `${print(module, "")}\n` };
}

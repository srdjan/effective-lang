// Effect sets as sorted lists of unique identities. The order is the order of
// JavaScript string comparison, as in the serializer.

import type { CapabilityId, Effects, ErrorId, Execution } from "../ir.ts";

export function sortedUnique<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function isSubset(
  small: readonly string[],
  large: readonly string[],
): boolean {
  const set = new Set(large);
  return small.every((item) => set.has(item));
}

/** Both the failure set and the requirement set of `small` are subsets of those of `large`. */
export function effectsFit(small: Effects, large: Effects): boolean {
  return isSubset(small.failures, large.failures) &&
    isSubset(small.requirements, large.requirements);
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return isSubset(a, b) && isSubset(b, a);
}

export function minus<T extends string>(
  items: readonly T[],
  removed: readonly string[],
): T[] {
  const set = new Set(removed);
  return items.filter((item) => !set.has(item));
}

/** The active effects of one evaluation: sets and mode. */
export interface Active {
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  readonly execution: Execution;
}

export const QUIET: Active = {
  failures: [],
  requirements: [],
  execution: "pure",
};

/** True when the evaluation is pure and its failure and requirement sets are empty. */
export function isQuiet(active: Active): boolean {
  return active.execution === "pure" && active.failures.length === 0 &&
    active.requirements.length === 0;
}

/** The active effects of calling a function of the given type. */
export function invocationOf(fn: {
  readonly execution: Execution;
  readonly effects: Effects;
}): Active {
  return {
    failures: fn.effects.failures,
    requirements: fn.effects.requirements,
    execution: fn.execution,
  };
}

/** The sorted union of the failure sets and of the requirement sets of the parts. */
export function unionEffects(...parts: readonly Effects[]): Effects {
  return {
    failures: sortedUnique(parts.flatMap((part) => [...part.failures])),
    requirements: sortedUnique(parts.flatMap((part) => [...part.requirements])),
  };
}

/**
 * The union of several evaluations. The mode is effect when any part is
 * effect or when a set is nonempty (spec: nonempty sets require effect mode).
 */
export function combine(parts: readonly Active[]): Active {
  const failures: ErrorId[] = [];
  const requirements: CapabilityId[] = [];
  let effect = false;
  for (const part of parts) {
    failures.push(...part.failures);
    requirements.push(...part.requirements);
    if (part.execution === "effect") effect = true;
  }
  const f = sortedUnique(failures);
  const r = sortedUnique(requirements);
  return {
    failures: f,
    requirements: r,
    execution: effect || f.length > 0 || r.length > 0 ? "effect" : "pure",
  };
}

export function list(items: readonly string[]): string {
  return `[${items.join(", ")}]`;
}

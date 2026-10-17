// Type compatibility for the validator. The rules come from the spec ("Data
// and types", "Execution order and mode", "Retry and providers") and from the
// lift rule in docs/phase-a-rules.md. This file does not use the checker.
//
//   - A type alias unfolds structurally. A brand and an error are nominal.
//   - int fits number. A literal fits its primitive. never fits every type.
//   - A union fits a target when each member fits. A source fits a union
//     target when it fits one member.
//   - Records need equal field names and equal optional flags. Phase A has no
//     width subtyping. Field order does not matter.
//   - Arrays, options, and tuples are covariant.
//   - A function has contravariant parameters, a covariant result, and effect
//     sets that are subsets of the target sets. The execution modes must be
//     equal, except for the lift: a pure function fits an effect function type
//     only at the top of a value position.
//   - unknown is not a top type.

import type { Execution, Field, FunctionType, Type } from "../ir.ts";
import { isSubset, sameSet } from "./sets.ts";

export interface TypeEnv {
  /** Alias identity to the aliased type. */
  readonly aliases: ReadonlyMap<string, Type>;
  /** Brand identity to the base type. */
  readonly brands: ReadonlyMap<string, Type>;
  /** Error identity to its fields. */
  readonly errors: ReadonlyMap<string, readonly Field[]>;
}

export const INT: Type = { kind: "primitive", name: "int" };
export const NUMBER: Type = { kind: "primitive", name: "number" };
export const STRING: Type = { kind: "primitive", name: "string" };
export const BOOLEAN: Type = { kind: "primitive", name: "boolean" };
export const UNIT: Type = { kind: "primitive", name: "unit" };
export const NEVER: Type = { kind: "primitive", name: "never" };

// The bound on the recursion of one comparison. The parser limits written
// nesting to 512 levels and `declaration/012` limits an alias to 128 levels.
// So one type is at most about 640 levels deep, and two types give at most
// about 1280 frames. 1536 leaves room above that.
const MAX_DEPTH = 1536;

export function isNever(type: Type): boolean {
  return type.kind === "primitive" && type.name === "never";
}

/** Follows aliases until the type is not an alias. A brand or an error stays named. */
export function unfold(env: TypeEnv, type: Type): Type {
  let current = type;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (current.kind !== "named") return current;
    const alias = env.aliases.get(current.id);
    if (alias === undefined) return current;
    current = alias;
  }
  return current;
}

/** The members of a type after aliases unfold and unions flatten. */
export function members(env: TypeEnv, type: Type, depth = 0): Type[] {
  const unfolded = unfold(env, type);
  if (unfolded.kind === "union" && depth < MAX_DEPTH) {
    const out: Type[] = [];
    for (const member of unfolded.members) {
      out.push(...members(env, member, depth + 1));
    }
    return out;
  }
  return [unfolded];
}

function literalFits(
  value: string | number | boolean,
  name: string,
): boolean {
  switch (typeof value) {
    case "string":
      return name === "string";
    case "boolean":
      return name === "boolean";
    case "number":
      return name === "number" ||
        (name === "int" && Number.isSafeInteger(value));
  }
}

/** A pure function fits an effect target. An effect function does not fit a pure target. */
function executionFits(source: Execution, target: Execution): boolean {
  return source === target || (source === "pure" && target === "effect");
}

function assignable(
  env: TypeEnv,
  s: Type,
  t: Type,
  lift: boolean,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  if (s.kind === "named" && t.kind === "named" && s.id === t.id) return true;
  if (s.kind === "primitive" && s.name === "never") return true;
  if (s.kind === "named") {
    const alias = env.aliases.get(s.id);
    if (alias !== undefined) return assignable(env, alias, t, lift, depth + 1);
  }
  if (t.kind === "named") {
    const alias = env.aliases.get(t.id);
    if (alias !== undefined) return assignable(env, s, alias, lift, depth + 1);
  }
  if (s.kind === "union") {
    for (const member of s.members) {
      if (!assignable(env, member, t, false, depth + 1)) return false;
    }
    return true;
  }
  if (t.kind === "union") {
    for (const member of t.members) {
      if (assignable(env, s, member, false, depth + 1)) return true;
    }
    return false;
  }
  switch (t.kind) {
    case "primitive":
      if (s.kind === "primitive") {
        return s.name === t.name || (s.name === "int" && t.name === "number");
      }
      if (s.kind === "literal") return literalFits(s.value, t.name);
      return false;
    case "literal":
      return s.kind === "literal" && s.value === t.value;
    case "named":
      // Brands and errors are nominal. Equal identities matched above.
      return false;
    case "record": {
      if (s.kind !== "record") return false;
      if (s.fields.length !== t.fields.length) return false;
      for (const tf of t.fields) {
        const sf = s.fields.find((f) => f.name === tf.name);
        if (
          sf === undefined || sf.optional !== tf.optional ||
          !assignable(env, sf.type, tf.type, false, depth + 1)
        ) return false;
      }
      return true;
    }
    case "array":
      return s.kind === "array" &&
        assignable(env, s.element, t.element, false, depth + 1);
    case "option":
      return s.kind === "option" &&
        assignable(env, s.element, t.element, false, depth + 1);
    case "ref":
      return s.kind === "ref" &&
        assignable(env, s.element, t.element, false, depth + 1) &&
        assignable(env, t.element, s.element, false, depth + 1);
    case "retry-schedule":
      return s.kind === "retry-schedule" &&
        assignable(env, s.error, t.error, false, depth + 1) &&
        assignable(env, t.error, s.error, false, depth + 1);
    case "codec":
      return s.kind === "codec" &&
        assignable(env, s.decoded, t.decoded, false, depth + 1) &&
        assignable(env, t.decoded, s.decoded, false, depth + 1) &&
        assignable(env, s.encoded, t.encoded, false, depth + 1) &&
        assignable(env, t.encoded, s.encoded, false, depth + 1);
    case "fiber":
      return s.kind === "fiber" &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        sameSet(s.failures, t.failures);
    case "effect":
      return s.kind === "effect" &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        isSubset(s.effects.failures, t.effects.failures) &&
        isSubset(s.effects.requirements, t.effects.requirements);
    case "stream":
      return s.kind === "stream" &&
        assignable(env, s.element, t.element, false, depth + 1) &&
        isSubset(s.effects.failures, t.effects.failures) &&
        isSubset(s.effects.requirements, t.effects.requirements);
    case "sink":
      return s.kind === "sink" &&
        assignable(env, t.input, s.input, false, depth + 1) &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        isSubset(s.effects.failures, t.effects.failures) &&
        isSubset(s.effects.requirements, t.effects.requirements);
    case "tuple":
      if (s.kind !== "tuple" || s.elements.length !== t.elements.length) {
        return false;
      }
      for (let i = 0; i < s.elements.length; i++) {
        if (!assignable(env, s.elements[i], t.elements[i], false, depth + 1)) {
          return false;
        }
      }
      return true;
    case "function": {
      if (s.kind !== "function") return false;
      if (s.parameters.length !== t.parameters.length) return false;
      if (t.borrows?.some((borrow, i) => borrow && s.borrows?.[i] !== true)) {
        return false;
      }
      if (
        s.execution !== t.execution &&
        !(lift && executionFits(s.execution, t.execution))
      ) return false;
      if (!isSubset(s.effects.failures, t.effects.failures)) return false;
      if (!isSubset(s.effects.requirements, t.effects.requirements)) {
        return false;
      }
      if (!assignable(env, s.result, t.result, false, depth + 1)) return false;
      for (let i = 0; i < t.parameters.length; i++) {
        if (
          !assignable(env, t.parameters[i], s.parameters[i], false, depth + 1)
        ) {
          return false;
        }
      }
      return true;
    }
    case "provider":
      return s.kind === "provider" && sameSet(s.provides, t.provides) &&
        executionFits(
          s.acquisition.execution,
          t.acquisition.execution,
        ) &&
        isSubset(
          s.acquisition.effects.failures,
          t.acquisition.effects.failures,
        ) &&
        isSubset(
          s.acquisition.effects.requirements,
          t.acquisition.effects.requirements,
        );
  }
}

/** A value of type `source` fits a value position of type `target`. The lift applies at the top. */
export function fits(env: TypeEnv, source: Type, target: Type): boolean {
  return assignable(env, source, target, true, 0);
}

/** Each type fits the other, with no lift. This is type equality up to aliases and union order. */
export function same(env: TypeEnv, a: Type, b: Type): boolean {
  return assignable(env, a, b, false, 0) && assignable(env, b, a, false, 0);
}

/** A union of the given types without duplicates. One type stands for itself. */
export function unionOf(env: TypeEnv, types: readonly Type[]): Type {
  const kept: Type[] = [];
  for (const type of types) {
    if (!kept.some((k) => same(env, k, type))) kept.push(type);
  }
  if (kept.length === 0) return NEVER;
  return kept.length === 1 ? kept[0] : { kind: "union", members: kept };
}

/** The fields of a record type, of a named error, or of a brand of a record. */
export function fieldsOf(
  env: TypeEnv,
  type: Type,
  depth = 0,
): readonly Field[] | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const unfolded = unfold(env, type);
  if (unfolded.kind === "record") return unfolded.fields;
  if (unfolded.kind === "named") {
    const error = env.errors.get(unfolded.id);
    if (error !== undefined) return error;
    const base = env.brands.get(unfolded.id);
    return base === undefined ? undefined : fieldsOf(env, base, depth + 1);
  }
  return undefined;
}

export function asFunction(env: TypeEnv, type: Type): FunctionType | undefined {
  const unfolded = unfold(env, type);
  return unfolded.kind === "function" ? unfolded : undefined;
}

export function isBooleanLike(env: TypeEnv, type: Type): boolean {
  return fits(env, type, BOOLEAN) && !isNever(type);
}

export function isNumeric(env: TypeEnv, type: Type): boolean {
  return fits(env, type, NUMBER) && !isNever(type);
}

/**
 * The brand type when the type, after aliases, is a brand of `int` or
 * `number`. A brand of a literal union or of another brand is not numeric.
 */
export function numericBrandOf(env: TypeEnv, type: Type): Type | undefined {
  const unfolded = unfold(env, type);
  if (unfolded.kind !== "named") return undefined;
  const base = env.brands.get(unfolded.id);
  if (base === undefined) return undefined;
  const baseType = unfold(env, base);
  return baseType.kind === "primitive" &&
      (baseType.name === "int" || baseType.name === "number")
    ? unfolded
    : undefined;
}

export function isStringLike(env: TypeEnv, type: Type): boolean {
  return fits(env, type, STRING) && !isNever(type);
}

/**
 * The comparison class of a type for `===` and `!==`: a primitive class, or a
 * primitive brand identity. Every member of a union must have the same class.
 */
export function comparisonClass(
  env: TypeEnv,
  type: Type,
  depth = 0,
): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let found: string | undefined;
  for (const member of members(env, type)) {
    let current: string | undefined;
    if (member.kind === "literal") {
      current = typeof member.value;
    } else if (member.kind === "primitive") {
      if (member.name === "int" || member.name === "number") current = "number";
      else if (member.name === "string" || member.name === "boolean") {
        current = member.name;
      }
    } else if (member.kind === "named") {
      const base = env.brands.get(member.id);
      if (
        base !== undefined &&
        comparisonClass(env, base, depth + 1) !== undefined
      ) {
        current = `brand:${member.id}`;
      }
    }
    if (current === undefined) return undefined;
    if (found !== undefined && found !== current) return undefined;
    found = current;
  }
  return found;
}

/** A readable form for messages. */
export function show(type: Type): string {
  switch (type.kind) {
    case "primitive":
      return type.name === "unit" ? "void" : type.name;
    case "literal":
      return JSON.stringify(type.value);
    case "named":
      return type.id;
    case "record":
      return type.fields.length === 0
        ? "{}"
        : `{ ${
          type.fields.map((f) =>
            `${f.name}${f.optional ? "?" : ""}: ${show(f.type)}`
          ).join(", ")
        } }`;
    case "array": {
      const inner = show(type.element);
      return type.element.kind === "union" || type.element.kind === "function"
        ? `(${inner})[]`
        : `${inner}[]`;
    }
    case "tuple":
      return `[${type.elements.map(show).join(", ")}]`;
    case "union":
      return type.members.map(show).join(" | ");
    case "option":
      return `Option<${show(type.element)}>`;
    case "ref":
      return `Ref<${show(type.element)}>`;
    case "retry-schedule":
      return `RetrySchedule<${show(type.error)}>`;
    case "codec":
      return `Codec<${show(type.decoded)}, ${show(type.encoded)}>`;
    case "fiber":
      return `Fiber<${show(type.result)}, ${
        type.failures.join(" | ") || "never"
      }>`;
    case "effect":
      return `Effect<${show(type.result)}, ${
        type.effects.failures.join(" | ") || "never"
      }, ${type.effects.requirements.join(" | ") || "never"}>`;
    case "stream":
      return `Stream<${show(type.element)}, ${
        type.effects.failures.join(" | ") || "never"
      }, ${type.effects.requirements.join(" | ") || "never"}>`;
    case "sink":
      return `Sink<${show(type.input)}, ${show(type.result)}, ${
        type.effects.failures.join(" | ") || "never"
      }, ${type.effects.requirements.join(" | ") || "never"}>`;
    case "function": {
      const fails = type.effects.failures.length === 0
        ? ""
        : ` fails ${type.effects.failures.join(" | ")}`;
      const uses = type.effects.requirements.length === 0
        ? ""
        : ` uses ${type.effects.requirements.join(" | ")}`;
      return `(${type.parameters.map(show).join(", ")}) => ${
        show(type.result)
      }${fails}${uses} [${type.execution}]`;
    }
    case "provider":
      return `provider provides ${
        type.provides.join(" | ")
      } [${type.acquisition.execution}]`;
  }
}

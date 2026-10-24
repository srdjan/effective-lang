// Type compatibility for the validator. The rules come from the spec ("Data
// and types", "Execution order and mode", "Retry and providers") and from the
// lift rule in docs/language-rules.md. This file does not use the checker.
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
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "../ir.ts";
import { effectsFit, isSubset, sameSet } from "./sets.ts";
import { typeChildren } from "./type_children.ts";

export interface TypeEnv {
  readonly module: string;
  /** Alias identity to the aliased type. */
  readonly aliases: ReadonlyMap<string, Type>;
  /** Brand identity to the base type. */
  readonly brands: ReadonlyMap<string, Type>;
  /** Data type identity to the base record type. */
  readonly data: ReadonlyMap<string, Extract<Type, { kind: "record" }>>;
  /** Error identity to its fields. */
  readonly errors: ReadonlyMap<string, readonly Field[]>;
  /** Identities of opaque types. An opaque type does not widen to its base. */
  readonly opaque: ReadonlySet<string>;
  /** Identities of sealed nominal types. */
  readonly sealed: ReadonlySet<string>;
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
// about 1280 frames. 1536 leaves room above that. The type walkers of
// world.ts use the same bound and report a type that goes past it.
export const MAX_DEPTH = 1536;

export function isNever(type: Type): boolean {
  return type.kind === "primitive" && type.name === "never";
}

/** True when a nominal type is open or belongs to the module under validation. */
export function ownsSealed(env: TypeEnv, id: string): boolean {
  return !env.sealed.has(id) || id.startsWith(`type:${env.module}#`);
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

/**
 * The data-only rules. They differ in two decisions.
 *
 * - "value": a value or an operation type. Accepts `unit` and the reserved
 *   Schema errors.
 * - "codec": a codec type. Accepts `unit` and rejects the reserved Schema
 *   errors, which have no compiler-derived schema.
 * - "schema": a `Schema<...>` type. Rejects `unit` and the reserved Schema
 *   errors.
 */
export type DataRule = "value" | "codec" | "schema";

/**
 * What each rule rejects. A `Record` over the closed union makes a new rule a
 * compile error until this table names its two decisions.
 */
const DATA_RULES: Readonly<
  Record<DataRule, { readonly unit: boolean; readonly reserved: boolean }>
> = {
  value: { unit: false, reserved: false },
  codec: { unit: false, reserved: true },
  schema: { unit: true, reserved: true },
};

/** Whether `type` is data only under `rule`. A cycle through `seen` counts as data. */
export function dataOnly(
  env: TypeEnv,
  type: Type,
  rule: DataRule,
  seen = new Set<Type>(),
): boolean {
  const value = unfold(env, type);
  if (seen.has(value)) return true;
  seen.add(value);
  const rejects = DATA_RULES[rule];
  const nested = (child: Type): boolean => dataOnly(env, child, rule, seen);
  switch (value.kind) {
    case "primitive":
      return value.name !== "unknown" &&
        !(rejects.unit && value.name === "unit");
    case "literal":
      return true;
    case "record":
      return value.fields.every((field) => nested(field.type));
    case "array":
    case "option":
      return nested(value.element);
    case "tuple":
      return value.elements.every(nested);
    case "union":
      return value.members.every(nested);
    case "named": {
      if (
        rejects.reserved &&
        (value.id === SCHEMA_ERROR_ID || value.id === SCHEMA_ISSUE_ID)
      ) return false;
      const errorFields = env.errors.get(value.id);
      const base = env.data.get(value.id) ?? env.brands.get(value.id) ??
        (errorFields !== undefined
          ? { kind: "record" as const, fields: errorFields }
          : undefined);
      return base !== undefined && nested(base);
    }
    case "ref":
    case "closeable-scope":
    case "retry-schedule":
    case "codec":
    case "schema":
    case "fiber":
    case "effect":
    case "stream":
    case "schedule":
    case "sink":
    case "function":
    case "provider":
      return false;
    default: {
      const unreachable: never = value;
      return unreachable;
    }
  }
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
  value: string | number | boolean | null,
  name: string,
): boolean {
  if (value === null) return false;
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

/** Each type fits the other: the position is invariant. */
function invariant(env: TypeEnv, a: Type, b: Type, depth: number): boolean {
  return assignable(env, a, b, false, depth + 1) &&
    assignable(env, b, a, false, depth + 1);
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
  // Preserve a recursive alias's identity before unfolding it into a union arm.
  if (
    s.kind === "named" && t.kind === "union" &&
    t.members.some((member) => member.kind === "named" && member.id === s.id)
  ) return true;
  if (
    s.kind === "named" && t.kind === "named" && s.id !== t.id &&
    guardedAlias(env, s.id) && guardedAlias(env, t.id)
  ) return false;
  if (s.kind === "primitive" && s.name === "never") return true;
  if (s.kind === "named") {
    const alias = env.aliases.get(s.id);
    if (alias !== undefined) return assignable(env, alias, t, lift, depth + 1);
  }
  if (t.kind === "named") {
    const alias = env.aliases.get(t.id);
    if (alias !== undefined) return assignable(env, s, alias, lift, depth + 1);
  }
  // A nominal value fits its base, as `TypeTable.assignable` does.
  if (
    s.kind === "named" && !env.opaque.has(s.id) &&
    ownsSealed(env, s.id)
  ) {
    const base = env.data.get(s.id) ?? env.brands.get(s.id);
    if (base !== undefined && assignable(env, base, t, lift, depth + 1)) {
      return true;
    }
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
    case "closeable-scope":
      return s.kind === "closeable-scope";
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
        invariant(env, s.element, t.element, depth);
    case "retry-schedule":
      return s.kind === "retry-schedule" &&
        invariant(env, s.error, t.error, depth);
    case "codec":
      return s.kind === "codec" &&
        invariant(env, s.decoded, t.decoded, depth) &&
        invariant(env, s.encoded, t.encoded, depth);
    case "schema":
      return s.kind === "schema" &&
        s.optionalKey === t.optionalKey &&
        s.encodedOptionalKey === t.encodedOptionalKey &&
        s.decodedOptionalKey === t.decodedOptionalKey &&
        s.constructorDefault === t.constructorDefault &&
        invariant(
          env,
          s.makeInput ?? s.decoded,
          t.makeInput ?? t.decoded,
          depth,
        ) &&
        invariant(env, s.decoded, t.decoded, depth) &&
        invariant(env, s.encoded, t.encoded, depth) &&
        isSubset(s.decodeRequirements, t.decodeRequirements) &&
        isSubset(s.encodeRequirements, t.encodeRequirements);
    case "fiber":
      return s.kind === "fiber" &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        sameSet(s.failures, t.failures);
    case "effect":
      return s.kind === "effect" &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        effectsFit(s.effects, t.effects);
    case "stream":
      return s.kind === "stream" &&
        assignable(env, s.element, t.element, false, depth + 1) &&
        effectsFit(s.effects, t.effects);
    case "schedule":
      return s.kind === "schedule" &&
        assignable(env, s.output, t.output, false, depth + 1) &&
        (isUnknown(env, s.input) ||
          assignable(env, t.input, s.input, false, depth + 1)) &&
        effectsFit(s.effects, t.effects);
    case "sink":
      return s.kind === "sink" &&
        assignable(env, t.input, s.input, false, depth + 1) &&
        assignable(env, s.result, t.result, false, depth + 1) &&
        assignable(
          env,
          s.leftover ?? NEVER,
          t.leftover ?? NEVER,
          false,
          depth + 1,
        ) &&
        effectsFit(s.effects, t.effects);
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
      if (!effectsFit(s.effects, t.effects)) return false;
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
        effectsFit(s.acquisition.effects, t.acquisition.effects);
  }
}

function guardedAlias(env: TypeEnv, id: string): boolean {
  const alias = env.aliases.get(id);
  if (alias?.kind !== "record" && alias?.kind !== "union") return false;
  const visit = (type: Type, guarded: boolean): boolean => {
    switch (type.kind) {
      case "named":
        return type.id === id && guarded;
      case "array":
        return visit(type.element, true);
      case "record":
        return type.fields.some((field) =>
          visit(field.type, guarded || field.optional)
        );
      case "union":
        return type.members.some((member) => visit(member, true));
      case "primitive":
      case "literal":
      case "option":
      case "ref":
      case "tuple":
      case "closeable-scope":
      case "retry-schedule":
      case "codec":
      case "schema":
      case "fiber":
      case "effect":
      case "stream":
      case "schedule":
      case "sink":
      case "function":
      case "provider":
        return false;
      default: {
        const unreachable: never = type;
        return unreachable;
      }
    }
  };
  return visit(alias, false);
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

/** The fields of a record type, or of a named error or data type. */
export function fieldsOf(
  env: TypeEnv,
  type: Type,
): readonly Field[] | undefined {
  const unfolded = unfold(env, type);
  if (unfolded.kind === "record") return unfolded.fields;
  if (unfolded.kind === "named") {
    const error = env.errors.get(unfolded.id);
    if (error !== undefined) return error;
    return env.data.get(unfolded.id)?.fields;
  }
  return undefined;
}

/** The sealed nominal identity below aliases, if this type is one. */
export function sealedRootOf(env: TypeEnv, type: Type): string | undefined {
  let current = type;
  const seen = new Set<Type>();
  while (!seen.has(current)) {
    seen.add(current);
    if (current.kind !== "named") return undefined;
    if (env.sealed.has(current.id)) return current.id;
    const alias = env.aliases.get(current.id);
    if (alias === undefined) return undefined;
    current = alias;
  }
  return undefined;
}

/** A foreign sealed nominal identity contained in this type, if one exists. */
export function foreignSealedOf(
  env: TypeEnv,
  type: Type,
): string | undefined {
  const seen = new Set<Type>();
  const visit = (current: Type): string | undefined => {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (current.kind === "named") {
      if (!ownsSealed(env, current.id)) return current.id;
      const fields = env.errors.get(current.id);
      const target = env.aliases.get(current.id) ?? env.data.get(current.id) ??
        env.brands.get(current.id) ??
        (fields === undefined
          ? undefined
          : { kind: "record" as const, fields });
      return target === undefined ? undefined : visit(target);
    }
    for (const child of typeChildren(current)) {
      const found = visit(child.type);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(type);
}

export function asFunction(env: TypeEnv, type: Type): FunctionType | undefined {
  const unfolded = unfold(env, type);
  return unfolded.kind === "function" ? unfolded : undefined;
}

export function isUnknown(env: TypeEnv, type: Type): boolean {
  const unfolded = unfold(env, type);
  return unfolded.kind === "primitive" && unfolded.name === "unknown";
}

export function isBooleanLike(env: TypeEnv, type: Type): boolean {
  return fits(env, type, BOOLEAN) && !isNever(type);
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
      current = member.value === null ? "null" : typeof member.value;
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

const BRAND_CLASS = "brand:";

/** The class of the base of a brand class, or undefined for another class. */
function baseClass(env: TypeEnv, cls: string): string | undefined {
  if (!cls.startsWith(BRAND_CLASS)) return undefined;
  const base = env.brands.get(cls.slice(BRAND_CLASS.length));
  return base === undefined ? undefined : comparisonClass(env, base);
}

/** The class and the classes of its bases, as far as widening reaches. */
function classChain(env: TypeEnv, cls: string): readonly string[] {
  const chain = [cls];
  for (let next = baseClass(env, cls); next !== undefined;) {
    if (chain.includes(next)) break;
    chain.push(next);
    next = baseClass(env, next);
  }
  return chain;
}

/** Two classes are compatible when one widens to the other. */
export function compatibleClasses(
  env: TypeEnv,
  l: string,
  r: string,
): boolean {
  return classChain(env, l).includes(r) || classChain(env, r).includes(l);
}

/** True when the class widens to `number`. */
export function isNumericClass(env: TypeEnv, cls: string): boolean {
  return classChain(env, cls).includes("number");
}

export function isStringClass(env: TypeEnv, cls: string): boolean {
  return classChain(env, cls).includes("string");
}

/** The members of an identity set, or `never` for the empty set. */
function orNever(items: readonly string[]): string {
  return items.join(" | ") || "never";
}

/** A readable form for messages. */
export function show(type: Type): string {
  switch (type.kind) {
    case "closeable-scope":
      return "CloseableScope";
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
    case "schema":
      return `${
        type.optionalKey === true
          ? "SchemaOptional"
          : type.encodedOptionalKey === true
          ? "SchemaEncodedOptional"
          : type.decodedOptionalKey === true
          ? "SchemaDecodedOptional"
          : "Schema"
      }${type.constructorDefault === true ? "ConstructorDefault" : ""}<${
        show(type.decoded)
      }, ${show(type.encoded)}, ${orNever(type.decodeRequirements)}, ${
        orNever(type.encodeRequirements)
      }${type.makeInput === undefined ? "" : `, ${show(type.makeInput)}`}>`;
    case "fiber":
      return `Fiber<${show(type.result)}, ${orNever(type.failures)}>`;
    case "effect":
      return `Effect<${show(type.result)}, ${orNever(type.effects.failures)}, ${
        orNever(type.effects.requirements)
      }>`;
    case "stream":
      return `Stream<${show(type.element)}, ${
        orNever(type.effects.failures)
      }, ${orNever(type.effects.requirements)}>`;
    case "schedule":
      return `Schedule<${show(type.output)}, ${show(type.input)}, ${
        orNever(type.effects.failures)
      }, ${orNever(type.effects.requirements)}>`;
    case "sink":
      return `Sink<${show(type.input)}, ${show(type.result)}, ${
        orNever(type.effects.failures)
      }, ${orNever(type.effects.requirements)}${
        type.leftover === undefined ? "" : `, ${show(type.leftover)}`
      }>`;
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

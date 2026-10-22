// The pattern domain of a match subject (plan section 5.1). Given the type of a
// subject, `domainOf` says which pattern forms apply and which values a complete
// match must cover. The functions here are pure. The body checker walks the
// arms and reports the diagnostics.

import type { ErrorId } from "./ir.ts";
import type { TypeRef, TypeTable } from "./types.ts";
import { isErrorId } from "./ids.ts";

export type LiteralValue = string | number | boolean | null;

/** One record member of a tagged union, with the literal values of each literal field. */
interface TaggedMember {
  readonly type: TypeRef;
  readonly literals: ReadonlyMap<string, readonly LiteralValue[]>;
}

export type Domain =
  /** `Option<T>`: arms `Some(x)` and `None`. */
  | { readonly kind: "option"; readonly element: TypeRef }
  /** One or more named errors: arms `E(x)`. */
  | { readonly kind: "errors"; readonly ids: readonly ErrorId[] }
  /** Records with literal discriminator fields: arms `{ kind: "lit", ...name }`. */
  | { readonly kind: "tagged"; readonly members: readonly TaggedMember[] }
  /** A closed set of literal values, including `boolean`. */
  | { readonly kind: "literals"; readonly values: readonly LiteralValue[] }
  /** An unbounded primitive. A complete match needs `_`. */
  | { readonly kind: "open"; readonly primitive: "string" | "int" | "number" }
  /** The subject has the error type. The checker reports nothing about it. */
  | { readonly kind: "error" }
  | { readonly kind: "unsupported" };

// The bound on the recursion of one comparison. The parser limits written
// nesting to 512 levels and `declaration/012` limits an alias to 128 levels.
// So one type is at most about 640 levels deep, and two types give at most
// about 1280 frames. 1536 leaves room above that.
const MAX_DEPTH = 1536;

/**
 * The members of a type after aliases unfold and unions flatten. A type that is
 * not a union has itself as the only member.
 */
export function flattenMembers(table: TypeTable, ref: TypeRef): TypeRef[] {
  const out: TypeRef[] = [];
  const visit = (current: TypeRef, depth: number): void => {
    const unfolded = table.unfold(current);
    const node = table.node(unfolded);
    if (node.kind === "union" && depth < MAX_DEPTH) {
      for (const member of node.members) visit(member, depth + 1);
    } else {
      out.push(unfolded);
    }
  };
  visit(ref, 0);
  return out;
}

function literalValuesOf(
  table: TypeTable,
  ref: TypeRef,
): LiteralValue[] | undefined {
  const values: LiteralValue[] = [];
  for (const member of flattenMembers(table, ref)) {
    const node = table.node(member);
    if (node.kind === "literal") {
      values.push(node.value);
    } else if (node.kind === "primitive" && node.name === "boolean") {
      values.push(true, false);
    } else {
      return undefined;
    }
  }
  return values;
}

function unique(values: readonly LiteralValue[]): LiteralValue[] {
  const seen = new Set<LiteralValue>();
  const result: LiteralValue[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** The pattern domain of a subject type. */
export function domainOf(table: TypeTable, subject: TypeRef): Domain {
  const members = flattenMembers(table, subject);
  const nodes = members.map((m) => table.node(m));
  if (nodes.some((n) => n.kind === "error")) return { kind: "error" };

  if (nodes.length === 1 && nodes[0].kind === "option") {
    return { kind: "option", element: nodes[0].element };
  }

  if (
    nodes.length > 0 &&
    nodes.every((n) => n.kind === "named" && isErrorId(n.id))
  ) {
    const ids: ErrorId[] = [];
    for (const n of nodes) {
      if (n.kind === "named" && isErrorId(n.id)) ids.push(n.id);
    }
    return { kind: "errors", ids: [...new Set(ids)].sort() };
  }

  const literals = literalValuesOf(table, subject);
  if (literals !== undefined && literals.length > 0) {
    return { kind: "literals", values: unique(literals) };
  }

  if (nodes.length > 0 && nodes.every((n) => n.kind === "record")) {
    const tagged: TaggedMember[] = [];
    members.forEach((member, i) => {
      const node = nodes[i];
      const fields = new Map<string, readonly LiteralValue[]>();
      if (node.kind === "record") {
        for (const field of node.fields) {
          const values = literalValuesOf(table, field.type);
          if (!field.optional && values !== undefined && values.length > 0) {
            fields.set(field.name, unique(values));
          }
        }
      }
      tagged.push({ type: member, literals: fields });
    });
    return { kind: "tagged", members: tagged };
  }

  if (nodes.length === 1) {
    const only = nodes[0];
    if (
      only.kind === "primitive" &&
      (only.name === "string" || only.name === "int" ||
        only.name === "number")
    ) {
      return { kind: "open", primitive: only.name };
    }
  }
  return { kind: "unsupported" };
}

/** All values of the discriminator field across the members of a tagged union. */
export function taggedValues(
  members: readonly TaggedMember[],
  field: string,
): LiteralValue[] {
  const values: LiteralValue[] = [];
  for (const member of members) {
    values.push(...(member.literals.get(field) ?? []));
  }
  return unique(values);
}

/** The members whose discriminator field admits `value`. */
export function narrowTagged(
  table: TypeTable,
  members: readonly TaggedMember[],
  field: string,
  value: LiteralValue,
): TaggedMember[] {
  return members.filter((m) => {
    const node = table.node(m.type);
    const discriminator = node.kind === "record"
      ? node.fields.find((f) => f.name === field)
      : undefined;
    return discriminator !== undefined &&
      literalMayEqual(table, discriminator.type, value);
  });
}

/** Runtime equality sees a brand's erased base and may inspect unknown data. */
function literalMayEqual(
  table: TypeTable,
  type: TypeRef,
  value: LiteralValue,
  seen = new Set<TypeRef>(),
): boolean {
  // Keep a possible member when an invalid cycle or depth prevents a proof.
  if (seen.has(type) || seen.size >= MAX_DEPTH) return true;
  const next = new Set(seen).add(type);
  const node = table.node(type);
  if (node.kind === "named") {
    if (isErrorId(node.id)) return false;
    const base = table.aliasOf(node.id) ?? table.brandBaseOf(node.id);
    return base !== undefined && literalMayEqual(table, base, value, next);
  }
  if (node.kind === "union") {
    return node.members.some((m) => literalMayEqual(table, m, value, next));
  }
  if (node.kind === "primitive" && node.name === "unknown") return true;
  return table.isAssignable(table.literal(value), type);
}

export function describeLiteral(value: LiteralValue): string {
  return JSON.stringify(value);
}

// Interned types and type compatibility. Equal structural types share one
// integer id (a `TypeRef`), so type equality is id equality. Aliases keep their
// name: a `named` type points at the alias `TypeId`, and compatibility unfolds
// the alias on demand. Brands and errors are nominal by identity.
//
// The table is mutable and deterministic. A project owns one table. The ids
// depend on the order of interning, so no output may depend on a raw id. The
// serialization functions below sort by canonical text, not by id.

import type {
  CapabilityId,
  ErrorId,
  Execution,
  Field,
  FunctionType,
  Type,
  TypeId,
} from "./ir.ts";

declare const typeRefBrand: unique symbol;

/** An interned type. Equal structural types have equal refs. */
export type TypeRef = number & { readonly [typeRefBrand]: true };

export type PrimitiveName =
  | "string"
  | "boolean"
  | "int"
  | "number"
  | "unit"
  | "never"
  | "unknown";

export interface RecordField {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
}

/** The interned form. Records are sorted by field name, unions by ref. */
export type TypeNode =
  | { readonly kind: "primitive"; readonly name: PrimitiveName }
  | {
    readonly kind: "literal";
    readonly value: string | number | boolean;
  }
  | { readonly kind: "named"; readonly id: TypeId | ErrorId }
  | { readonly kind: "record"; readonly fields: readonly RecordField[] }
  | { readonly kind: "array"; readonly element: TypeRef }
  | { readonly kind: "tuple"; readonly elements: readonly TypeRef[] }
  | { readonly kind: "union"; readonly members: readonly TypeRef[] }
  | { readonly kind: "option"; readonly element: TypeRef }
  | { readonly kind: "ref"; readonly element: TypeRef }
  | { readonly kind: "retry-schedule"; readonly error: TypeRef }
  | {
    readonly kind: "codec";
    readonly decoded: TypeRef;
    readonly encoded: TypeRef;
  }
  | {
    readonly kind: "effect";
    readonly result: TypeRef;
    readonly failures: readonly ErrorId[];
    readonly requirements: readonly CapabilityId[];
  }
  | {
    readonly kind: "stream";
    readonly element: TypeRef;
    readonly failures: readonly ErrorId[];
    readonly requirements: readonly CapabilityId[];
  }
  | {
    readonly kind: "sink";
    readonly input: TypeRef;
    readonly result: TypeRef;
    readonly failures: readonly ErrorId[];
    readonly requirements: readonly CapabilityId[];
  }
  | {
    readonly kind: "function";
    readonly execution: Execution;
    readonly parameters: readonly TypeRef[];
    readonly result: TypeRef;
    /** Sorted and unique. */
    readonly failures: readonly ErrorId[];
    /** Sorted and unique. */
    readonly requirements: readonly CapabilityId[];
  }
  | {
    readonly kind: "provider";
    /** Sorted and unique. */
    readonly provides: readonly CapabilityId[];
    readonly execution: Execution;
    readonly failures: readonly ErrorId[];
    readonly requirements: readonly CapabilityId[];
  }
  /** The recovery type. It is compatible with every type in both directions. */
  | { readonly kind: "error" };

export interface FunctionSpec {
  readonly execution: Execution;
  readonly parameters: readonly TypeRef[];
  readonly result: TypeRef;
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
}

export interface ProviderSpec {
  readonly provides: readonly CapabilityId[];
  readonly execution: Execution;
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted copy without duplicates. */
export function sortedUnique<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)].sort(compareText);
}

function isSubset(
  small: readonly string[],
  large: readonly string[],
): boolean {
  const set = new Set(large);
  return small.every((item) => set.has(item));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// ------------------------------------------------------------------ canonical JSON

/**
 * JSON text with object keys in sorted order. Arrays keep their order. A key
 * with an `undefined` value is left out. Use it to hash a value.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort(compareText)) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

// ------------------------------------------------------------------ the table

/** What a graph of imported declarations supplies to the table. */
export interface DefinitionSource {
  readonly types: readonly {
    readonly id: TypeId;
    readonly definition:
      | { readonly kind: "alias"; readonly type: Type }
      | { readonly kind: "brand"; readonly base: Type };
  }[];
  readonly errors: readonly {
    readonly id: ErrorId;
    readonly fields: readonly Field[];
  }[];
}

// The bound on the recursion of one comparison. The parser limits written
// nesting to 512 levels and `declaration/012` limits an alias to 128 levels.
// So one type is at most about 640 levels deep, and two types give at most
// about 1280 frames. 1536 leaves room above that.
const MAX_DEPTH = 1536;

export class TypeTable {
  private readonly nodes: TypeNode[] = [];
  private readonly byKey = new Map<string, TypeRef>();
  private readonly aliases = new Map<TypeId, TypeRef>();
  private readonly brands = new Map<TypeId, TypeRef>();
  private readonly errorRecords = new Map<ErrorId, TypeRef>();

  /** The recovery type. */
  readonly error: TypeRef;
  readonly string: TypeRef;
  readonly boolean: TypeRef;
  readonly int: TypeRef;
  readonly number: TypeRef;
  readonly unit: TypeRef;
  readonly never: TypeRef;
  readonly unknown: TypeRef;

  constructor() {
    this.error = this.intern({ kind: "error" });
    this.string = this.primitive("string");
    this.boolean = this.primitive("boolean");
    this.int = this.primitive("int");
    this.number = this.primitive("number");
    this.unit = this.primitive("unit");
    this.never = this.primitive("never");
    this.unknown = this.primitive("unknown");
  }

  /** Number of interned types. */
  get size(): number {
    return this.nodes.length;
  }

  node(ref: TypeRef): TypeNode {
    const node = this.nodes[ref];
    if (node === undefined) throw new Error(`unknown type ref ${ref}`);
    return node;
  }

  // -------------------------------------------------------------- interning

  private keyOf(node: TypeNode): string {
    switch (node.kind) {
      case "primitive":
        return `p:${node.name}`;
      case "literal":
        return `l:${JSON.stringify(node.value)}`;
      case "named":
        return `n:${node.id}`;
      case "record":
        return `r:${
          JSON.stringify(node.fields.map((f) => [f.name, f.optional, f.type]))
        }`;
      case "array":
        return `a:${node.element}`;
      case "tuple":
        return `t:${JSON.stringify(node.elements)}`;
      case "union":
        return `u:${JSON.stringify(node.members)}`;
      case "option":
        return `o:${node.element}`;
      case "ref":
        return `q:${node.element}`;
      case "retry-schedule":
        return `z:${node.error}`;
      case "codec":
        return `c:${node.decoded}:${node.encoded}`;
      case "effect":
        return `x:${
          JSON.stringify([node.result, node.failures, node.requirements])
        }`;
      case "stream":
        return `s:${
          JSON.stringify([node.element, node.failures, node.requirements])
        }`;
      case "sink":
        return `k:${
          JSON.stringify([
            node.input,
            node.result,
            node.failures,
            node.requirements,
          ])
        }`;
      case "function":
        return `f:${
          JSON.stringify([
            node.execution,
            node.parameters,
            node.result,
            node.failures,
            node.requirements,
          ])
        }`;
      case "provider":
        return `v:${
          JSON.stringify([
            node.provides,
            node.execution,
            node.failures,
            node.requirements,
          ])
        }`;
      case "error":
        return "e";
    }
  }

  /** Interns a node that is already in normal form. */
  private intern(node: TypeNode): TypeRef {
    const key = this.keyOf(node);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const ref = this.nodes.length as TypeRef;
    this.nodes.push(node);
    this.byKey.set(key, ref);
    return ref;
  }

  primitive(name: PrimitiveName): TypeRef {
    return this.intern({ kind: "primitive", name });
  }

  literal(value: string | number | boolean): TypeRef {
    return this.intern({ kind: "literal", value });
  }

  named(id: TypeId | ErrorId): TypeRef {
    return this.intern({ kind: "named", id });
  }

  /** Sorts the fields by name. Duplicate names keep the first field. */
  record(fields: readonly RecordField[]): TypeRef {
    const seen = new Set<string>();
    const unique: RecordField[] = [];
    for (const field of fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      unique.push(field);
    }
    unique.sort((a, b) => compareText(a.name, b.name));
    return this.intern({ kind: "record", fields: unique });
  }

  array(element: TypeRef): TypeRef {
    return this.intern({ kind: "array", element });
  }

  tuple(elements: readonly TypeRef[]): TypeRef {
    return this.intern({ kind: "tuple", elements: [...elements] });
  }

  option(element: TypeRef): TypeRef {
    return this.intern({ kind: "option", element });
  }

  ref(element: TypeRef): TypeRef {
    return this.intern({ kind: "ref", element });
  }

  retrySchedule(error: TypeRef): TypeRef {
    return this.intern({ kind: "retry-schedule", error });
  }

  codec(decoded: TypeRef, encoded: TypeRef): TypeRef {
    return this.intern({ kind: "codec", decoded, encoded });
  }

  effect(
    result: TypeRef,
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
  ): TypeRef {
    return this.intern({
      kind: "effect",
      result,
      failures: sortedUnique(failures),
      requirements: sortedUnique(requirements),
    });
  }

  stream(
    element: TypeRef,
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
  ): TypeRef {
    return this.intern({
      kind: "stream",
      element,
      failures: sortedUnique(failures),
      requirements: sortedUnique(requirements),
    });
  }

  sink(
    input: TypeRef,
    result: TypeRef,
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
  ): TypeRef {
    return this.intern({
      kind: "sink",
      input,
      result,
      failures: sortedUnique(failures),
      requirements: sortedUnique(requirements),
    });
  }

  /**
   * Flattens nested unions, removes duplicates, and sorts by ref. A union of one
   * member is that member. An empty union is `never`. A union with the error type
   * is the error type.
   */
  union(members: readonly TypeRef[]): TypeRef {
    const flat = new Set<TypeRef>();
    for (const member of members) {
      const node = this.node(member);
      if (node.kind === "error") return this.error;
      if (node.kind === "union") {
        for (const inner of node.members) flat.add(inner);
      } else {
        flat.add(member);
      }
    }
    if (flat.size === 0) return this.never;
    const sorted = [...flat].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    return this.intern({ kind: "union", members: sorted });
  }

  /** Sorts and deduplicates the failure and requirement sets. */
  function(spec: FunctionSpec): TypeRef {
    return this.intern({
      kind: "function",
      execution: spec.execution,
      parameters: [...spec.parameters],
      result: spec.result,
      failures: sortedUnique(spec.failures),
      requirements: sortedUnique(spec.requirements),
    });
  }

  provider(spec: ProviderSpec): TypeRef {
    return this.intern({
      kind: "provider",
      provides: sortedUnique(spec.provides),
      execution: spec.execution,
      failures: sortedUnique(spec.failures),
      requirements: sortedUnique(spec.requirements),
    });
  }

  // -------------------------------------------------------------- definitions

  /** Registers the definition of an alias. The last definition wins. */
  defineAlias(id: TypeId, target: TypeRef): void {
    this.aliases.set(id, target);
  }

  defineBrand(id: TypeId, base: TypeRef): void {
    this.brands.set(id, base);
  }

  /** Registers the field record of an error declaration. */
  defineError(id: ErrorId, record: TypeRef): void {
    this.errorRecords.set(id, record);
  }

  aliasOf(id: TypeId): TypeRef | undefined {
    return this.aliases.get(id);
  }

  brandBaseOf(id: TypeId): TypeRef | undefined {
    return this.brands.get(id);
  }

  errorRecordOf(id: ErrorId): TypeRef | undefined {
    return this.errorRecords.get(id);
  }

  /** True when a definition for the id exists. */
  isDefined(id: TypeId | ErrorId): boolean {
    return id.startsWith("error:")
      ? this.errorRecords.has(id as ErrorId)
      : this.aliases.has(id as TypeId) || this.brands.has(id as TypeId);
  }

  /**
   * Registers the declarations of an imported module graph. A definition that
   * the table already has stays as it is.
   */
  load(source: DefinitionSource): void {
    for (const decl of source.types) {
      if (this.isDefined(decl.id)) continue;
      if (decl.definition.kind === "alias") {
        this.defineAlias(decl.id, this.fromIr(decl.definition.type));
      } else {
        this.defineBrand(decl.id, this.fromIr(decl.definition.base));
      }
    }
    for (const decl of source.errors) {
      if (this.isDefined(decl.id)) continue;
      this.defineError(
        decl.id,
        this.record(decl.fields.map((f) => ({
          name: f.name,
          type: this.fromIr(f.type),
          optional: f.optional,
        }))),
      );
    }
  }

  /** Follows alias definitions until the type is not a defined alias. */
  unfold(ref: TypeRef): TypeRef {
    let current = ref;
    for (let steps = 0; steps <= this.aliases.size; steps++) {
      const node = this.node(current);
      if (node.kind !== "named") return current;
      const target = this.aliases.get(node.id as TypeId);
      if (target === undefined) return current;
      current = target;
    }
    return this.error;
  }

  /**
   * True when the type is deeper than `limit` levels. A leaf has depth 1. A
   * composite type has 1 plus the largest depth of its children. An alias name
   * has 1 plus the depth of its target, so the levels inside aliases count. The
   * `memo` holds exact depths of types that fit in the limit. A walk that goes
   * past the limit stops and memoizes nothing for the nodes it aborted. The
   * recursion has at most `limit + 1` frames.
   */
  exceedsDepth(
    ref: TypeRef,
    limit: number,
    memo: Map<TypeRef, number>,
  ): boolean {
    return this.heightWithin(ref, limit, memo) === Infinity;
  }

  /** The exact height of the type when it is at most `budget`, else `Infinity`. */
  private heightWithin(
    ref: TypeRef,
    budget: number,
    memo: Map<TypeRef, number>,
  ): number {
    const known = memo.get(ref);
    if (known !== undefined) return known <= budget ? known : Infinity;
    if (budget < 1) return Infinity;
    const node = this.node(ref);
    let tallest = 0;
    switch (node.kind) {
      case "named": {
        const alias = this.aliases.get(node.id as TypeId);
        if (alias === undefined) break;
        tallest = this.heightWithin(alias, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      }
      case "record":
        for (const field of node.fields) {
          const height = this.heightWithin(field.type, budget - 1, memo);
          if (height === Infinity) return Infinity;
          if (height > tallest) tallest = height;
        }
        break;
      case "array":
      case "option": {
        tallest = this.heightWithin(node.element, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      }
      case "tuple":
        for (const element of node.elements) {
          const height = this.heightWithin(element, budget - 1, memo);
          if (height === Infinity) return Infinity;
          if (height > tallest) tallest = height;
        }
        break;
      case "union":
        for (const member of node.members) {
          const height = this.heightWithin(member, budget - 1, memo);
          if (height === Infinity) return Infinity;
          if (height > tallest) tallest = height;
        }
        break;
      case "function": {
        tallest = this.heightWithin(node.result, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        for (const parameter of node.parameters) {
          const height = this.heightWithin(parameter, budget - 1, memo);
          if (height === Infinity) return Infinity;
          if (height > tallest) tallest = height;
        }
        break;
      }
      case "effect":
        tallest = this.heightWithin(node.result, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      case "ref":
        tallest = this.heightWithin(node.element, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      case "retry-schedule":
        tallest = this.heightWithin(node.error, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      case "codec":
        tallest = Math.max(
          this.heightWithin(node.decoded, budget - 1, memo),
          this.heightWithin(node.encoded, budget - 1, memo),
        );
        if (tallest === Infinity) return Infinity;
        break;
      case "stream":
        tallest = this.heightWithin(node.element, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        break;
      case "sink":
        tallest = this.heightWithin(node.input, budget - 1, memo);
        if (tallest === Infinity) return Infinity;
        {
          const resultHeight = this.heightWithin(node.result, budget - 1, memo);
          if (resultHeight === Infinity) return Infinity;
          if (resultHeight > tallest) tallest = resultHeight;
        }
        break;
      case "primitive":
      case "literal":
      case "provider":
      case "error":
        break;
    }
    const height = 1 + tallest;
    memo.set(ref, height);
    return height;
  }

  // -------------------------------------------------------------- IR conversion

  /** Interns an IR type tree. Unions flatten and sort, records sort. */
  fromIr(type: Type): TypeRef {
    switch (type.kind) {
      case "primitive":
        return this.primitive(type.name);
      case "literal":
        return this.literal(type.value);
      case "named":
        return this.named(type.id);
      case "record":
        return this.record(type.fields.map((f) => ({
          name: f.name,
          type: this.fromIr(f.type),
          optional: f.optional,
        })));
      case "array":
        return this.array(this.fromIr(type.element));
      case "tuple":
        return this.tuple(type.elements.map((e) => this.fromIr(e)));
      case "union":
        return this.union(type.members.map((m) => this.fromIr(m)));
      case "option":
        return this.option(this.fromIr(type.element));
      case "ref":
        return this.ref(this.fromIr(type.element));
      case "retry-schedule":
        return this.retrySchedule(this.fromIr(type.error));
      case "codec":
        return this.codec(this.fromIr(type.decoded), this.fromIr(type.encoded));
      case "effect":
        return this.effect(
          this.fromIr(type.result),
          type.effects.failures,
          type.effects.requirements,
        );
      case "stream":
        return this.stream(
          this.fromIr(type.element),
          type.effects.failures,
          type.effects.requirements,
        );
      case "sink":
        return this.sink(
          this.fromIr(type.input),
          this.fromIr(type.result),
          type.effects.failures,
          type.effects.requirements,
        );
      case "function":
        return this.fromIrFunction(type);
      case "provider":
        return this.provider({
          provides: type.provides,
          execution: type.acquisition.execution,
          failures: type.acquisition.effects.failures,
          requirements: type.acquisition.effects.requirements,
        });
    }
  }

  fromIrFunction(type: FunctionType): TypeRef {
    return this.function({
      execution: type.execution,
      parameters: type.parameters.map((p) => this.fromIr(p)),
      result: this.fromIr(type.result),
      failures: type.effects.failures,
      requirements: type.effects.requirements,
    });
  }

  /**
   * The IR tree of an interned type. Records list fields by name. Union members
   * sort by their canonical text, so the result does not depend on ref numbers.
   * The error type becomes `unknown`.
   */
  toIr(ref: TypeRef): Type {
    const node = this.node(ref);
    switch (node.kind) {
      case "primitive":
        return { kind: "primitive", name: node.name };
      case "literal":
        return { kind: "literal", value: node.value };
      case "named":
        return { kind: "named", id: node.id };
      case "record":
        return {
          kind: "record",
          fields: node.fields.map((f) => ({
            name: f.name,
            type: this.toIr(f.type),
            optional: f.optional,
          })),
        };
      case "array":
        return { kind: "array", element: this.toIr(node.element) };
      case "tuple":
        return {
          kind: "tuple",
          elements: node.elements.map((e) => this.toIr(e)),
        };
      case "union": {
        const members = node.members.map((m) => {
          const ir = this.toIr(m);
          return { ir, text: canonicalJson(ir) };
        });
        members.sort((a, b) => compareText(a.text, b.text));
        return { kind: "union", members: members.map((m) => m.ir) };
      }
      case "option":
        return { kind: "option", element: this.toIr(node.element) };
      case "ref":
        return { kind: "ref", element: this.toIr(node.element) };
      case "retry-schedule":
        return { kind: "retry-schedule", error: this.toIr(node.error) };
      case "codec":
        return {
          kind: "codec",
          decoded: this.toIr(node.decoded),
          encoded: this.toIr(node.encoded),
        };
      case "effect":
        return {
          kind: "effect",
          result: this.toIr(node.result),
          effects: {
            failures: node.failures,
            requirements: node.requirements,
          },
        };
      case "stream":
        return {
          kind: "stream",
          element: this.toIr(node.element),
          effects: { failures: node.failures, requirements: node.requirements },
        };
      case "sink":
        return {
          kind: "sink",
          input: this.toIr(node.input),
          result: this.toIr(node.result),
          effects: { failures: node.failures, requirements: node.requirements },
        };
      case "function":
        return this.toIrFunction(ref);
      case "provider":
        return {
          kind: "provider",
          provides: node.provides,
          acquisition: {
            execution: node.execution,
            effects: {
              failures: node.failures,
              requirements: node.requirements,
            },
          },
        };
      case "error":
        return { kind: "primitive", name: "unknown" };
    }
  }

  /** The IR function type of a ref that must be a function type. */
  toIrFunction(ref: TypeRef): FunctionType {
    const node = this.node(ref);
    if (node.kind !== "function") {
      throw new Error(`type ref ${ref} is not a function type`);
    }
    return {
      kind: "function",
      execution: node.execution,
      parameters: node.parameters.map((p) => this.toIr(p)),
      result: this.toIr(node.result),
      effects: { failures: node.failures, requirements: node.requirements },
    };
  }

  // -------------------------------------------------------------- compatibility

  /** True when a value of type `source` may be used where `target` is expected. */
  isAssignable(source: TypeRef, target: TypeRef): boolean {
    return this.assignable(source, target, 0, true);
  }

  /**
   * `lift` is true only at the top of a value position. There a pure function
   * may fit an effect function type, because the emitter wraps the value. A
   * function nested in a record, array, option, tuple, union, result, or
   * parameter cannot be wrapped, so its execution must match.
   */
  private assignable(
    s: TypeRef,
    t: TypeRef,
    depth: number,
    lift = false,
  ): boolean {
    if (s === t) return true;
    if (depth > MAX_DEPTH) return false;
    const sn = this.node(s);
    const tn = this.node(t);
    if (sn.kind === "error" || tn.kind === "error") return true;
    if (sn.kind === "primitive" && sn.name === "never") return true;
    if (sn.kind === "named") {
      const alias = this.aliases.get(sn.id as TypeId);
      if (alias !== undefined) {
        return this.assignable(alias, t, depth + 1, lift);
      }
    }
    if (tn.kind === "named") {
      const alias = this.aliases.get(tn.id as TypeId);
      if (alias !== undefined) {
        return this.assignable(s, alias, depth + 1, lift);
      }
    }
    if (sn.kind === "union") {
      for (const member of sn.members) {
        if (!this.assignable(member, t, depth + 1)) return false;
      }
      return true;
    }
    if (tn.kind === "union") {
      for (const member of tn.members) {
        if (this.assignable(s, member, depth + 1)) return true;
      }
      return false;
    }
    switch (tn.kind) {
      case "primitive":
        if (sn.kind === "primitive") {
          return sn.name === tn.name ||
            (sn.name === "int" && tn.name === "number");
        }
        if (sn.kind === "literal") {
          return literalFitsPrimitive(sn.value, tn.name);
        }
        return false;
      case "literal":
        return sn.kind === "literal" && sn.value === tn.value;
      case "named":
        // Brands and errors are nominal. Equal ids have equal refs.
        return false;
      case "record":
        if (sn.kind !== "record") return false;
        if (sn.fields.length !== tn.fields.length) return false;
        for (let i = 0; i < sn.fields.length; i++) {
          const field = sn.fields[i];
          const other = tn.fields[i];
          if (
            field.name !== other.name || field.optional !== other.optional ||
            !this.assignable(field.type, other.type, depth + 1)
          ) return false;
        }
        return true;
      case "array":
        return sn.kind === "array" &&
          this.assignable(sn.element, tn.element, depth + 1);
      case "option":
        return sn.kind === "option" &&
          this.assignable(sn.element, tn.element, depth + 1);
      case "ref":
        return sn.kind === "ref" &&
          this.assignable(sn.element, tn.element, depth + 1) &&
          this.assignable(tn.element, sn.element, depth + 1);
      case "retry-schedule":
        return sn.kind === "retry-schedule" &&
          this.assignable(sn.error, tn.error, depth + 1) &&
          this.assignable(tn.error, sn.error, depth + 1);
      case "codec":
        return sn.kind === "codec" &&
          this.assignable(sn.decoded, tn.decoded, depth + 1) &&
          this.assignable(tn.decoded, sn.decoded, depth + 1) &&
          this.assignable(sn.encoded, tn.encoded, depth + 1) &&
          this.assignable(tn.encoded, sn.encoded, depth + 1);
      case "effect":
        return sn.kind === "effect" &&
          this.assignable(sn.result, tn.result, depth + 1) &&
          isSubset(sn.failures, tn.failures) &&
          isSubset(sn.requirements, tn.requirements);
      case "stream":
        return sn.kind === "stream" &&
          this.assignable(sn.element, tn.element, depth + 1) &&
          isSubset(sn.failures, tn.failures) &&
          isSubset(sn.requirements, tn.requirements);
      case "sink":
        return sn.kind === "sink" &&
          this.assignable(tn.input, sn.input, depth + 1) &&
          this.assignable(sn.result, tn.result, depth + 1) &&
          isSubset(sn.failures, tn.failures) &&
          isSubset(sn.requirements, tn.requirements);
      case "tuple":
        if (sn.kind !== "tuple" || sn.elements.length !== tn.elements.length) {
          return false;
        }
        for (let i = 0; i < sn.elements.length; i++) {
          if (!this.assignable(sn.elements[i], tn.elements[i], depth + 1)) {
            return false;
          }
        }
        return true;
      case "function":
        if (sn.kind !== "function") return false;
        if (sn.parameters.length !== tn.parameters.length) return false;
        if (
          sn.execution !== tn.execution &&
          !(lift && executionFits(sn.execution, tn.execution))
        ) {
          return false;
        }
        if (!isSubset(sn.failures, tn.failures)) return false;
        if (!isSubset(sn.requirements, tn.requirements)) return false;
        if (!this.assignable(sn.result, tn.result, depth + 1)) return false;
        for (let i = 0; i < tn.parameters.length; i++) {
          if (!this.assignable(tn.parameters[i], sn.parameters[i], depth + 1)) {
            return false;
          }
        }
        return true;
      case "provider":
        return sn.kind === "provider" &&
          sameList(sn.provides, tn.provides) &&
          executionFits(sn.execution, tn.execution) &&
          isSubset(sn.failures, tn.failures) &&
          isSubset(sn.requirements, tn.requirements);
    }
  }

  // -------------------------------------------------------------- printing

  /** A readable form for messages. It is not a serialization format. */
  show(ref: TypeRef): string {
    const node = this.node(ref);
    switch (node.kind) {
      case "primitive":
        return node.name === "unit" ? "void" : node.name;
      case "literal":
        return JSON.stringify(node.value);
      case "named": {
        const hash = node.id.indexOf("#");
        return hash < 0 ? node.id : node.id.slice(hash + 1);
      }
      case "record":
        return node.fields.length === 0
          ? "{}"
          : `{ ${
            node.fields.map((f) =>
              `${f.name}${f.optional ? "?" : ""}: ${this.show(f.type)}`
            ).join(", ")
          } }`;
      case "array": {
        const inner = this.node(node.element).kind;
        const text = this.show(node.element);
        return inner === "union" || inner === "function"
          ? `(${text})[]`
          : `${text}[]`;
      }
      case "tuple":
        return `[${node.elements.map((e) => this.show(e)).join(", ")}]`;
      case "union":
        return node.members.map((m) => this.show(m)).join(" | ");
      case "option":
        return `Option<${this.show(node.element)}>`;
      case "ref":
        return `Ref<${this.show(node.element)}>`;
      case "retry-schedule":
        return `RetrySchedule<${this.show(node.error)}>`;
      case "codec":
        return `Codec<${this.show(node.decoded)}, ${this.show(node.encoded)}>`;
      case "effect":
        return `Effect<${this.show(node.result)}, ${
          node.failures.map(idName).join(" | ") || "never"
        }, ${node.requirements.map(idName).join(" | ") || "never"}>`;
      case "stream":
        return `Stream<${this.show(node.element)}, ${
          node.failures.map(idName).join(" | ") || "never"
        }, ${node.requirements.map(idName).join(" | ") || "never"}>`;
      case "sink":
        return `Sink<${this.show(node.input)}, ${this.show(node.result)}, ${
          node.failures.map(idName).join(" | ") || "never"
        }, ${node.requirements.map(idName).join(" | ") || "never"}>`;
      case "function": {
        const parameters = node.parameters.map((p) => this.show(p)).join(", ");
        const fails = node.failures.length === 0
          ? ""
          : ` fails ${node.failures.map(idName).join(" | ")}`;
        const uses = node.requirements.length === 0
          ? ""
          : ` uses ${node.requirements.map(idName).join(" | ")}`;
        return `(${parameters}) => ${this.show(node.result)}${fails}${uses}`;
      }
      case "provider":
        return `provider provides ${node.provides.map(idName).join(" | ")}`;
      case "error":
        return "<error>";
    }
  }
}

function idName(id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? id : id.slice(hash + 1);
}

function literalFitsPrimitive(
  value: string | number | boolean,
  name: PrimitiveName,
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

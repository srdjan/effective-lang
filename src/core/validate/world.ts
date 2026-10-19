// The identities that a module can see: its own declarations, then the
// payloads of its imports. The checks here are the Identity checks of the
// declaration level and the type-level checks of the declarations.

import type {
  ErrorDecl,
  Field,
  Import,
  MethodDecl,
  ModuleIR,
  ServiceDecl,
  Span,
  Type,
  TypeDecl,
} from "../ir.ts";
import { SCOPE_CAPABILITY } from "../ir.ts";
import { AREA, type Report } from "./report.ts";
import { isNever, same, type TypeEnv, unfold } from "./typing.ts";
import { sameSet } from "./sets.ts";

export const PRELUDE_MODULE = "effective:prelude";

export interface World {
  readonly module: string;
  readonly env: TypeEnv;
  readonly types: ReadonlyMap<string, TypeDecl>;
  readonly errors: ReadonlyMap<string, ErrorDecl>;
  readonly services: ReadonlyMap<string, ServiceDecl>;
  readonly methods: ReadonlyMap<string, MethodDecl>;
  /** The recorded type of every value a module can reference. */
  readonly values: ReadonlyMap<string, Type>;
  /** The builtin ids of the prelude import. */
  readonly builtins: ReadonlyMap<string, string>;
}

function addFirst<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key)) map.set(key, value);
}

/** Own declarations come first, then the import payloads. The first entry of an identity wins. */
export function buildWorld(ir: ModuleIR): World {
  const types = new Map<string, TypeDecl>();
  const errors = new Map<string, ErrorDecl>();
  const services = new Map<string, ServiceDecl>();
  const values = new Map<string, Type>();
  const builtins = new Map<string, string>();
  for (const d of ir.declarations) {
    switch (d.kind) {
      case "type":
        addFirst(types, d.id, d);
        break;
      case "error":
        addFirst(errors, d.id, d);
        break;
      case "service":
        addFirst(services, d.id, d);
        break;
      case "function":
        addFirst(values, d.id, d.type);
        break;
      case "constant":
        addFirst(values, d.id, d.type);
        break;
    }
  }
  for (const imp of ir.imports) {
    for (const t of imp.types) addFirst(types, t.id, t);
    for (const e of imp.errors) addFirst(errors, e.id, e);
    for (const s of imp.services) addFirst(services, s.id, s);
    for (const v of imp.values) {
      addFirst(values, v.id, v.type);
      if (imp.module === PRELUDE_MODULE) addFirst(builtins, v.id, v.name);
    }
  }
  errors.set("error:effect/SchemaError", {
    kind: "error",
    id: "error:effect/SchemaError",
    name: "SchemaError",
    fields: [{
      name: "message",
      type: { kind: "primitive", name: "string" },
      optional: false,
    }],
    span: { source: ir.module, start: 0, end: 0 },
  });
  errors.set("error:effect/SchemaIssue", {
    kind: "error",
    id: "error:effect/SchemaIssue",
    name: "SchemaIssue",
    fields: [],
    span: { source: ir.module, start: 0, end: 0 },
  });
  const methods = new Map<string, MethodDecl>();
  for (const s of services.values()) {
    for (const m of s.methods) addFirst(methods, m.id, m);
  }
  const aliases = new Map<string, Type>();
  const brands = new Map<string, Type>();
  for (const t of types.values()) {
    if (t.definition.kind === "alias") aliases.set(t.id, t.definition.type);
    else brands.set(t.id, t.definition.base);
  }
  const errorFields = new Map<string, readonly Field[]>();
  for (const e of errors.values()) errorFields.set(e.id, e.fields);
  return {
    module: ir.module,
    env: { aliases, brands, errors: errorFields },
    types,
    errors,
    services,
    methods,
    values,
    builtins,
  };
}

// ------------------------------------------------------------------ type identities

export interface Ctx {
  readonly world: World;
  readonly report: Report;
}

/**
 * Checks that every identity in a type resolves: named types, failure
 * identities, and capability identities. Returns true when all resolve.
 */
export function checkTypeIds(
  ctx: Ctx,
  type: Type,
  path: string,
  span: Span,
): boolean {
  const { world, report } = ctx;
  let ok = true;
  const fail = (at: string, what: string): void => {
    ok = false;
    report.add(AREA.identity, at, what, span);
  };
  const effects = (
    at: string,
    e: {
      readonly failures: readonly string[];
      readonly requirements: readonly string[];
    },
  ): void => {
    e.failures.forEach((id, i) => {
      if (!world.errors.has(id)) {
        fail(
          `${at}.failures[${i}]`,
          `the failure ${id} is not a declared error`,
        );
      }
    });
    e.requirements.forEach((id, i) => {
      if (!world.methods.has(id) && id !== SCOPE_CAPABILITY) {
        fail(
          `${at}.requirements[${i}]`,
          `the requirement ${id} is not a declared service method`,
        );
      }
    });
  };
  const walk = (t: Type, at: string, depth: number): void => {
    if (depth > 200) return;
    switch (t.kind) {
      case "closeable-scope":
      case "primitive":
      case "literal":
        return;
      case "named": {
        const found = t.id.startsWith("type:")
          ? world.types.has(t.id)
          : t.id.startsWith("error:")
          ? world.errors.has(t.id)
          : false;
        if (!found) fail(at, `the type ${t.id} is not declared`);
        return;
      }
      case "record":
        t.fields.forEach((f, i) =>
          walk(f.type, `${at}.fields[${i}].type`, depth + 1)
        );
        return;
      case "array":
      case "option":
      case "ref":
        walk(t.element, `${at}.element`, depth + 1);
        return;
      case "retry-schedule":
        walk(t.error, `${at}.error`, depth + 1);
        if (t.error.kind !== "named" || !t.error.id.startsWith("error:")) {
          fail(at, "a retry schedule needs a nominal error type");
        }
        return;
      case "codec":
        walk(t.decoded, `${at}.decoded`, depth + 1);
        walk(t.encoded, `${at}.encoded`, depth + 1);
        return;
      case "schema":
        walk(t.decoded, `${at}.decoded`, depth + 1);
        walk(t.encoded, `${at}.encoded`, depth + 1);
        if (t.makeInput !== undefined) {
          walk(t.makeInput, `${at}.makeInput`, depth + 1);
        }
        // The IR allows each flag to be absent or exactly true.
        for (
          const flag of [
            "optionalKey",
            "encodedOptionalKey",
            "decodedOptionalKey",
            "constructorDefault",
          ] as const
        ) {
          const value: unknown = t[flag];
          if (value !== undefined && value !== true) {
            fail(at, `the Schema flag ${flag} must be absent or true`);
          }
        }
        if (
          Number(t.optionalKey === true) +
              Number(t.encodedOptionalKey === true) +
              Number(t.decodedOptionalKey === true) > 1
        ) fail(at, "Schema field optionality flags are mutually exclusive");
        if (
          !recursiveDataOnly(world, t.decoded) ||
          !recursiveDataOnly(world, t.encoded) ||
          !recursiveDataOnly(world, t.makeInput ?? t.decoded)
        ) {
          fail(at, "Schema decoded and encoded types must be data only");
        }
        effects(`${at}.decodeRequirements`, {
          failures: [],
          requirements: t.decodeRequirements,
        });
        effects(`${at}.encodeRequirements`, {
          failures: [],
          requirements: t.encodeRequirements,
        });
        return;
      case "fiber":
        walk(t.result, `${at}.result`, depth + 1);
        effects(`${at}.effects`, { failures: t.failures, requirements: [] });
        return;
      case "effect":
        walk(t.result, `${at}.result`, depth + 1);
        effects(`${at}.effects`, t.effects);
        return;
      case "stream":
        walk(t.element, `${at}.element`, depth + 1);
        effects(`${at}.effects`, t.effects);
        return;
      case "schedule":
        walk(t.output, `${at}.output`, depth + 1);
        walk(t.input, `${at}.input`, depth + 1);
        effects(`${at}.effects`, t.effects);
        return;
      case "sink":
        walk(t.input, `${at}.input`, depth + 1);
        walk(t.result, `${at}.result`, depth + 1);
        if (t.leftover !== undefined) {
          walk(t.leftover, `${at}.leftover`, depth + 1);
        }
        effects(`${at}.effects`, t.effects);
        return;
      case "tuple":
        t.elements.forEach((e, i) =>
          walk(e, `${at}.elements[${i}]`, depth + 1)
        );
        return;
      case "union":
        t.members.forEach((m, i) => walk(m, `${at}.members[${i}]`, depth + 1));
        return;
      case "function":
        if (
          t.borrows !== undefined && t.borrows.length !== t.parameters.length
        ) {
          fail(at, "borrow flags must match function parameters");
        }
        t.parameters.forEach((p, i) =>
          walk(p, `${at}.parameters[${i}]`, depth + 1)
        );
        walk(t.result, `${at}.result`, depth + 1);
        effects(`${at}.effects`, t.effects);
        return;
      case "provider":
        t.provides.forEach((id, i) => {
          if (!world.methods.has(id)) {
            fail(
              `${at}.provides[${i}]`,
              `the provided capability ${id} is not a declared service method`,
            );
          }
        });
        effects(`${at}.acquisition.effects`, t.acquisition.effects);
        return;
    }
  };
  walk(type, path, 0);
  return ok;
}

/** Reports a record type with two fields of one name. */
function checkFieldNames(
  ctx: Ctx,
  fields: readonly Field[],
  path: string,
  span: Span,
): void {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.name)) {
      ctx.report.add(
        AREA.types,
        `${path}[${i}]`,
        `the field ${f.name} appears twice`,
        span,
      );
    }
    seen.add(f.name);
  });
}

/** Checks the field names of every record type inside a type. */
export function checkRecordFields(
  ctx: Ctx,
  type: Type,
  path: string,
  span: Span,
): void {
  const walk = (t: Type, at: string, depth: number): void => {
    if (depth > 200) return;
    switch (t.kind) {
      case "record":
        checkFieldNames(ctx, t.fields, `${at}.fields`, span);
        t.fields.forEach((f, i) =>
          walk(f.type, `${at}.fields[${i}].type`, depth + 1)
        );
        return;
      case "array":
      case "option":
      case "ref":
        walk(t.element, `${at}.element`, depth + 1);
        return;
      case "retry-schedule":
        walk(t.error, `${at}.error`, depth + 1);
        return;
      case "codec":
        walk(t.decoded, `${at}.decoded`, depth + 1);
        walk(t.encoded, `${at}.encoded`, depth + 1);
        return;
      case "schema":
        walk(t.decoded, `${at}.decoded`, depth + 1);
        walk(t.encoded, `${at}.encoded`, depth + 1);
        if (t.makeInput !== undefined) {
          walk(t.makeInput, `${at}.makeInput`, depth + 1);
        }
        return;
      case "fiber":
        walk(t.result, `${at}.result`, depth + 1);
        return;
      case "effect":
        walk(t.result, `${at}.result`, depth + 1);
        return;
      case "stream":
        walk(t.element, `${at}.element`, depth + 1);
        return;
      case "schedule":
        walk(t.output, `${at}.output`, depth + 1);
        walk(t.input, `${at}.input`, depth + 1);
        return;
      case "sink":
        walk(t.input, `${at}.input`, depth + 1);
        walk(t.result, `${at}.result`, depth + 1);
        if (t.leftover !== undefined) {
          walk(t.leftover, `${at}.leftover`, depth + 1);
        }
        return;
      case "tuple":
        t.elements.forEach((e, i) =>
          walk(e, `${at}.elements[${i}]`, depth + 1)
        );
        return;
      case "union":
        t.members.forEach((m, i) => walk(m, `${at}.members[${i}]`, depth + 1));
        return;
      case "function":
        t.parameters.forEach((p, i) =>
          walk(p, `${at}.parameters[${i}]`, depth + 1)
        );
        walk(t.result, `${at}.result`, depth + 1);
        return;
      default:
        return;
    }
  };
  walk(type, path, 0);
}

/** Identity and field checks of one type in a declaration. */
export function checkDeclaredType(
  ctx: Ctx,
  type: Type,
  path: string,
  span: Span,
): void {
  checkTypeIds(ctx, type, path, span);
  checkRecordFields(ctx, type, path, span);
}

// ------------------------------------------------------------------ declarations

const KIND_PREFIX = {
  type: "type:",
  error: "error:",
  service: "service:",
  function: "value:",
  constant: "value:",
} as const;

function checkServiceDecl(
  ctx: Ctx,
  service: ServiceDecl,
  path: string,
  seenMethods: Set<string>,
): void {
  const base = service.id.startsWith("service:")
    ? service.id.slice("service:".length)
    : service.id;
  service.methods.forEach((m, j) => {
    const at = `${path}.methods[${j}]`;
    if (m.id !== `cap:${base}.${m.name}`) {
      ctx.report.add(
        AREA.identity,
        `${at}.id`,
        `expected the capability identity cap:${base}.${m.name}, recorded ${m.id}`,
        m.span,
      );
    }
    if (seenMethods.has(m.id)) {
      ctx.report.add(
        AREA.identity,
        `${at}.id`,
        `the capability ${m.id} is declared twice`,
        m.span,
      );
    }
    seenMethods.add(m.id);
    checkDeclaredType(ctx, m.type, `${at}.type`, m.span);
    if (m.borrows !== undefined) {
      if (m.borrows.length !== m.type.parameters.length) {
        ctx.report.add(
          AREA.types,
          `${at}.borrows`,
          "borrow flags must match method parameters",
          m.span,
        );
      }
      m.borrows.forEach((borrow, index) => {
        if (!borrow) return;
        if (!m.span.source.endsWith(".effi")) {
          ctx.report.add(
            AREA.types,
            `${at}.borrows[${index}]`,
            "a service borrow parameter belongs in a host interface",
            m.span,
          );
        }
        const parameter = m.type.parameters[index];
        if (
          parameter?.kind !== "named" ||
          ctx.world.types.get(parameter.id)?.opaque !== true
        ) {
          ctx.report.add(
            AREA.types,
            `${at}.borrows[${index}]`,
            "a borrow parameter needs an opaque type",
            m.span,
          );
        }
      });
    }
  });
}

function checkTypeDecl(ctx: Ctx, d: TypeDecl, path: string): void {
  if (d.opaque === true && !d.span.source.endsWith(".effi")) {
    ctx.report.add(
      AREA.types,
      `${path}.opaque`,
      "an opaque type belongs in a host interface",
      d.span,
    );
  }
  if (
    d.opaque === true &&
    (d.definition.kind !== "brand" || d.definition.base.kind !== "primitive" ||
      d.definition.base.name !== "unknown")
  ) {
    ctx.report.add(
      AREA.types,
      `${path}.definition`,
      "an opaque type needs an unknown nominal base",
      d.span,
    );
  }
  const type = d.definition.kind === "alias"
    ? d.definition.type
    : d.definition.base;
  const at = d.definition.kind === "alias"
    ? `${path}.definition.type`
    : `${path}.definition.base`;
  checkDeclaredType(ctx, type, at, d.span);
}

function checkErrorDecl(ctx: Ctx, d: ErrorDecl, path: string): void {
  checkFieldNames(ctx, d.fields, `${path}.fields`, d.span);
  d.fields.forEach((f, i) =>
    checkDeclaredType(ctx, f.type, `${path}.fields[${i}].type`, d.span)
  );
}

/** Identity and type checks of the declaration headers of the module. */
export function checkDeclarationHeaders(ctx: Ctx, ir: ModuleIR): void {
  const { report } = ctx;
  const seen = new Set<string>();
  const seenMethods = new Set<string>();
  ir.declarations.forEach((d, i) => {
    const path = `declarations[${i}]`;
    const expected = `${KIND_PREFIX[d.kind]}${ir.module}#${d.name}`;
    if (d.id !== expected) {
      report.add(
        AREA.identity,
        `${path}.id`,
        `expected the identity ${expected}, recorded ${d.id}`,
        d.span,
      );
    }
    if (seen.has(d.id)) {
      report.add(
        AREA.identity,
        `${path}.id`,
        `the identity ${d.id} is declared twice`,
        d.span,
      );
    }
    seen.add(d.id);
    switch (d.kind) {
      case "type":
        checkTypeDecl(ctx, d, path);
        break;
      case "error":
        checkErrorDecl(ctx, d, path);
        break;
      case "service":
        checkServiceDecl(ctx, d, path, seenMethods);
        break;
      case "function":
        checkDeclaredType(ctx, d.type, `${path}.type`, d.span);
        break;
      case "constant":
        checkDeclaredType(ctx, d.type, `${path}.type`, d.span);
        break;
    }
  });
  const declared = new Set(ir.declarations.map((d) => d.id));
  const exported = new Set<string>();
  ir.exports.forEach((id, i) => {
    const span = { source: ir.sources[0] ?? ir.module, start: 0, end: 0 };
    if (!declared.has(id)) {
      report.add(
        AREA.identity,
        `exports[${i}]`,
        `the export ${id} is not declared in this module`,
        span,
      );
    }
    if (exported.has(id)) {
      report.add(
        AREA.identity,
        `exports[${i}]`,
        `the export ${id} appears twice`,
        span,
      );
    }
    exported.add(id);
  });
}

// ------------------------------------------------------------------ recursion

/** Rechecks finite self recursion without trusting the checker. */
function guardedRecord(type: Type, id: string): boolean {
  const containsSelf = (part: Type): boolean => {
    switch (part.kind) {
      case "named":
        return part.id === id;
      case "array":
      case "option":
        return containsSelf(part.element);
      case "record":
        return part.fields.some((field) => containsSelf(field.type));
      case "union":
        return part.members.some(containsSelf);
      default:
        return false;
    }
  };
  const tagged = type.kind === "union" && type.members.length >= 2 &&
    type.members.every((member) => member.kind === "record") &&
    type.members.some((member) => !containsSelf(member));
  const tagNames = tagged && type.kind === "union"
    ? (type.members[0] as Extract<Type, { kind: "record" }>).fields
      .filter((field) =>
        !field.optional && field.type.kind === "literal" &&
        typeof field.type.value === "string"
      ).map((field) => field.name)
    : [];
  const hasDistinctTag = type.kind === "union" && tagNames.some((name) => {
    const fields = type.members.map((member) =>
      member.kind === "record"
        ? member.fields.find((field) => field.name === name)
        : undefined
    );
    return fields.every((field) =>
      field !== undefined && !field.optional &&
      field.type.kind === "literal" && typeof field.type.value === "string"
    ) && new Set(fields.map((field) =>
          field?.type.kind === "literal" ? field.type.value : undefined
        )).size === fields.length;
  });
  if (type.kind !== "record" && !(tagged && hasDistinctTag)) return false;
  let sawSelf = false;
  const walk = (part: Type, guarded: boolean): boolean => {
    switch (part.kind) {
      case "named":
        if (part.id !== id) return true;
        sawSelf = true;
        return guarded;
      case "array":
        return walk(part.element, true);
      case "record":
        return part.fields.every((field) =>
          walk(field.type, guarded || field.optional)
        );
      case "union":
        return (guarded || (part === type && tagged && hasDistinctTag)) &&
          part.members.every((member) => walk(member, true));
      case "primitive":
      case "literal":
        return true;
      default:
        return false;
    }
  };
  return walk(type, false) && sawSelf;
}

function recursiveDataOnly(
  world: World,
  type: Type,
  seen = new Set<Type>(),
): boolean {
  const value = unfold(world.env, type);
  if (seen.has(value)) return true;
  seen.add(value);
  switch (value.kind) {
    case "primitive":
      return value.name !== "unknown" && value.name !== "unit";
    case "literal":
      return true;
    case "record":
      return value.fields.every((field) =>
        recursiveDataOnly(world, field.type, seen)
      );
    case "array":
    case "option":
      return recursiveDataOnly(world, value.element, seen);
    case "tuple":
      return value.elements.every((element) =>
        recursiveDataOnly(world, element, seen)
      );
    case "union":
      return value.members.every((member) =>
        recursiveDataOnly(world, member, seen)
      );
    case "named": {
      if (
        value.id === "error:effect/SchemaError" ||
        value.id === "error:effect/SchemaIssue"
      ) return false;
      const nested = world.env.brands.get(value.id) ??
        (world.env.errors.has(value.id)
          ? { kind: "record" as const, fields: world.env.errors.get(value.id)! }
          : undefined);
      return nested !== undefined && recursiveDataOnly(world, nested, seen);
    }
    default:
      return false;
  }
}

/** Reports cycles other than a single array-guarded data record. */
export function checkRecursion(ctx: Ctx, ir: ModuleIR): void {
  const { world } = ctx;
  const state = new Map<string, 1 | 2>();
  const index = new Map<string, number>();
  ir.declarations.forEach((d, i) => {
    if (d.kind === "type" || d.kind === "error") index.set(d.id, i);
  });
  const guarded = new Set<string>();
  ir.declarations.forEach((d) => {
    if (
      d.kind === "type" && d.definition.kind === "alias" &&
      guardedRecord(d.definition.type, d.id) &&
      recursiveDataOnly(world, d.definition.type)
    ) guarded.add(d.id);
  });
  const reported = new Set<string>();
  const reaches = (type: Type, from: string, depth: number): void => {
    if (depth > 200) return;
    switch (type.kind) {
      case "named":
        if (type.id === from && guarded.has(from)) return;
        visit(type.id);
        return;
      case "record":
        type.fields.forEach((f) => reaches(f.type, from, depth + 1));
        return;
      case "array":
      case "option":
      case "ref":
        reaches(type.element, from, depth + 1);
        return;
      case "retry-schedule":
        reaches(type.error, from, depth + 1);
        return;
      case "codec":
        reaches(type.decoded, from, depth + 1);
        reaches(type.encoded, from, depth + 1);
        return;
      case "schema":
        reaches(type.decoded, from, depth + 1);
        reaches(type.encoded, from, depth + 1);
        if (type.makeInput !== undefined) {
          reaches(type.makeInput, from, depth + 1);
        }
        return;
      case "fiber":
        reaches(type.result, from, depth + 1);
        return;
      case "effect":
        reaches(type.result, from, depth + 1);
        return;
      case "stream":
        reaches(type.element, from, depth + 1);
        return;
      case "schedule":
        reaches(type.output, from, depth + 1);
        reaches(type.input, from, depth + 1);
        return;
      case "sink":
        reaches(type.input, from, depth + 1);
        reaches(type.result, from, depth + 1);
        if (type.leftover !== undefined) {
          reaches(type.leftover, from, depth + 1);
        }
        return;
      case "tuple":
        type.elements.forEach((e) => reaches(e, from, depth + 1));
        return;
      case "union":
        type.members.forEach((m) => reaches(m, from, depth + 1));
        return;
      case "function":
        type.parameters.forEach((p) => reaches(p, from, depth + 1));
        reaches(type.result, from, depth + 1);
        return;
      default:
        return;
    }
  };
  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 2) return;
    if (mark === 1) {
      const at = index.get(id);
      if (at !== undefined && !reported.has(id)) {
        reported.add(id);
        const decl = ir.declarations[at];
        ctx.report.add(
          AREA.types,
          `declarations[${at}]`,
          `the type ${id} refers to itself; version 0 has no recursive types`,
          decl.span,
        );
      }
      return;
    }
    state.set(id, 1);
    const alias = world.env.aliases.get(id);
    const brand = world.env.brands.get(id);
    const fields = world.env.errors.get(id);
    if (alias !== undefined) reaches(alias, id, 0);
    if (brand !== undefined) reaches(brand, id, 0);
    if (fields !== undefined) fields.forEach((f) => reaches(f.type, id, 0));
    state.set(id, 2);
  };
  for (const id of index.keys()) visit(id);
}

// ------------------------------------------------------------------ imports

const BUILTIN_ID =
  /^value:(.+)#\$builtin\/(map|filter|fold|all|traverse)\/[0-9a-f]+$/;

function checkBuiltinShape(
  ctx: Ctx,
  name: string,
  type: Type,
  path: string,
  span: Span,
): void {
  const { world, report } = ctx;
  const env = world.env;
  if (type.kind !== "function") {
    report.add(
      AREA.types,
      path,
      `a builtin has a function type, recorded ${type.kind}`,
      span,
    );
    return;
  }
  const quiet = (fn: Type, at: string): void => {
    if (
      fn.kind === "function" &&
      (fn.execution !== "pure" || fn.effects.failures.length > 0 ||
        fn.effects.requirements.length > 0)
    ) {
      report.add(
        AREA.execution,
        at,
        "a builtin callback is pure with empty failure and requirement sets",
        span,
      );
    }
  };
  if (name !== "traverse" && name !== "all") quiet(type, path);
  const wrong = (what: string): void =>
    report.add(AREA.types, path, `the builtin ${name} ${what}`, span);
  const count = type.parameters.length;
  if (name === "all") {
    if (count !== 1 && count !== 2) {
      wrong(`has an invalid parameter count ${count}`);
      return;
    }
    if (count === 2) {
      const options = unfold(env, type.parameters[1]);
      const field = options.kind === "record" && options.fields.length === 1
        ? options.fields[0]
        : undefined;
      if (
        field?.name !== "concurrency" || field.optional ||
        (!same(env, field.type, { kind: "primitive", name: "int" }) &&
          !same(env, field.type, { kind: "primitive", name: "string" }))
      ) wrong("requires a concurrency options record");
    }
    const input = unfold(env, type.parameters[0]);
    const entries = input.kind === "tuple"
      ? input.elements
      : input.kind === "record"
      ? input.fields.map((field) => field.type)
      : input.kind === "array"
      ? [input.element]
      : undefined;
    if (entries === undefined) {
      wrong("takes a tuple, record, or array of Effects");
      return;
    }
    if (
      input.kind === "record" && input.fields.some((field) => field.optional)
    ) {
      wrong("requires every record field to be present");
    }
    const effects = entries.map((entry) => unfold(env, entry));
    if (effects.some((entry) => entry.kind !== "effect")) {
      wrong("requires an Effect at every position");
      return;
    }
    const effectEntries = effects.filter((entry) => entry.kind === "effect");
    const results = effectEntries.map((entry) => entry.result);
    const result: Type = input.kind === "tuple"
      ? { kind: "tuple", elements: results }
      : input.kind === "record"
      ? {
        kind: "record",
        fields: input.fields.map((field, i) => ({
          name: field.name,
          type: results[i],
          optional: false,
        })),
      }
      : { kind: "array", element: results[0] };
    if (!same(env, type.result, result)) wrong("must preserve input shape");
    if (
      type.execution !== "effect" ||
      !sameSet(
        type.effects.failures,
        effectEntries.flatMap((entry) => entry.effects.failures),
      ) ||
      !sameSet(
        type.effects.requirements,
        effectEntries.flatMap((entry) => entry.effects.requirements),
      )
    ) wrong("must carry the failures and requirements of every Effect");
    return;
  }
  const validCount = name === "fold"
    ? count === 3
    : name === "traverse"
    ? count === 2 || count === 3
    : count === 2;
  if (!validCount) {
    wrong(`has an invalid parameter count ${count}`);
    return;
  }
  if (name === "traverse" && count === 3) {
    const options = unfold(env, type.parameters[2]);
    const field = options.kind === "record" && options.fields.length === 1
      ? options.fields[0]
      : undefined;
    if (
      field?.name !== "concurrency" || field.optional ||
      (!same(env, field.type, { kind: "primitive", name: "int" }) &&
        !same(env, field.type, { kind: "primitive", name: "string" }))
    ) {
      wrong("requires a concurrency options record as its third parameter");
    }
  }
  const first = unfold(env, type.parameters[0]);
  if (first.kind !== "array") {
    wrong("takes an array as its first parameter");
    return;
  }
  const callbackIndex = name === "fold" ? 2 : 1;
  const callbackType = type.parameters[callbackIndex];
  const callback = unfold(env, callbackType);
  if (callback.kind !== "function") {
    wrong("takes a function as its last parameter");
    return;
  }
  if (name !== "traverse") {
    quiet(callback, `${path}.parameters[${callbackIndex}]`);
  } else if (
    type.execution !== "effect" || callback.execution !== "effect" ||
    !sameSet(type.effects.failures, callback.effects.failures) ||
    !sameSet(type.effects.requirements, callback.effects.requirements)
  ) {
    report.add(
      AREA.contracts,
      path,
      "traverse invokes an effect callback and carries its failures and requirements",
      span,
    );
  }
  if (name === "fold") {
    const accumulator = type.parameters[1];
    const ok = callback.parameters.length === 2 &&
      same(env, callback.parameters[0], accumulator) &&
      same(env, callback.parameters[1], first.element) &&
      same(env, callback.result, accumulator) &&
      same(env, type.result, accumulator);
    if (!ok) wrong("does not keep one accumulator type");
    return;
  }
  const ok = callback.parameters.length === 1 &&
    same(env, callback.parameters[0], first.element);
  if (!ok) {
    wrong("passes the callback an element that is not the element type");
    return;
  }
  const result = unfold(env, type.result);
  if (name === "map" || name === "traverse") {
    if (
      result.kind !== "array" || !same(env, result.element, callback.result)
    ) {
      wrong("returns an array of the callback result");
    }
  } else {
    if (
      !same(env, callback.result, { kind: "primitive", name: "boolean" }) ||
      isNever(callback.result) || !same(env, type.result, first)
    ) {
      wrong("returns the array type with a boolean predicate");
    }
  }
}

function checkImport(
  ctx: Ctx,
  imp: Import,
  i: number,
  ir: ModuleIR,
  own: ReadonlySet<string>,
): void {
  const { report } = ctx;
  const path = `imports[${i}]`;
  const span: Span = { source: ir.sources[0] ?? ir.module, start: 0, end: 0 };
  const ids = new Set<string>();
  const add = (id: string, at: string, s: Span): void => {
    if (ids.has(id)) {
      report.add(AREA.identity, at, `the payload declares ${id} twice`, s);
    }
    if (own.has(id)) {
      report.add(
        AREA.identity,
        at,
        `the payload declares ${id}, which this module declares itself`,
        s,
      );
    }
    ids.add(id);
  };
  imp.types.forEach((t, j) => {
    add(t.id, `${path}.types[${j}].id`, t.span);
    checkTypeDecl(ctx, t, `${path}.types[${j}]`);
  });
  imp.errors.forEach((e, j) => {
    add(e.id, `${path}.errors[${j}].id`, e.span);
    checkErrorDecl(ctx, e, `${path}.errors[${j}]`);
  });
  const seenMethods = new Set<string>();
  imp.services.forEach((s, j) => {
    add(s.id, `${path}.services[${j}].id`, s.span);
    checkServiceDecl(ctx, s, `${path}.services[${j}]`, seenMethods);
  });
  imp.values.forEach((v, j) => {
    add(v.id, `${path}.values[${j}].id`, span);
    checkDeclaredType(ctx, v.type, `${path}.values[${j}].type`, span);
  });
  const exported = new Set(imp.exports);
  imp.exports.forEach((id, j) => {
    if (!ids.has(id)) {
      report.add(
        AREA.identity,
        `${path}.exports[${j}]`,
        `the module ${imp.module} exports ${id}, which its payload does not declare`,
        span,
      );
    }
  });
  imp.bindings.forEach((b, j) => {
    if (!exported.has(b.target)) {
      report.add(
        AREA.identity,
        `${path}.bindings[${j}].target`,
        `the binding ${b.name} targets ${b.target}, which the module ${imp.module} does not export`,
        span,
      );
    }
  });
  if (imp.module !== PRELUDE_MODULE) return;
  if (
    imp.bindings.length > 0 || imp.types.length > 0 ||
    imp.errors.length > 0 || imp.services.length > 0
  ) {
    report.add(
      AREA.identity,
      path,
      "the prelude import has no bindings, types, errors, or services",
      span,
    );
  }
  if (!sameSet(imp.exports, imp.values.map((v) => v.id))) {
    report.add(
      AREA.identity,
      `${path}.exports`,
      "the prelude import exports exactly the builtin ids of its values",
      span,
    );
  }
  imp.values.forEach((v, j) => {
    const at = `${path}.values[${j}]`;
    const match = BUILTIN_ID.exec(v.id);
    if (match === null || match[1] !== ir.module) {
      report.add(
        AREA.identity,
        `${at}.id`,
        `a builtin identity has the form value:${ir.module}#$builtin/<name>/<hash>, recorded ${v.id}`,
        span,
      );
      return;
    }
    if (v.name !== v.id.slice(v.id.indexOf("#") + 1)) {
      report.add(
        AREA.identity,
        `${at}.name`,
        `the builtin name is the text after # in its identity, recorded ${v.name}`,
        span,
      );
    }
    checkBuiltinShape(ctx, match[2], v.type, `${at}.type`, span);
  });
}

export function checkImports(ctx: Ctx, ir: ModuleIR): void {
  const own = new Set(ir.declarations.map((d) => d.id));
  ir.imports.forEach((imp, i) => checkImport(ctx, imp, i, ir, own));
}

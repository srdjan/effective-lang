// Bottom-up recomputation of the annotations of one declaration body. For each
// node the checker recomputes the type, the failure set, the requirement set,
// and the execution mode from the children and from the identities in scope.
// It then compares the result with the recorded annotation.
//
// After a disagreement the checker continues with the recomputed value, so one
// bad node gives one diagnostic and its parents stay consistent. When a node
// cannot be recomputed (an unknown identity), the checker continues with the
// recorded annotation.
//
// The equations come from the spec, "Equations and validation".

import type {
  ConstantDecl,
  ErrorId,
  Expr,
  FunctionDecl,
  Parameter,
  Pattern,
  Span,
  Type,
} from "../ir.ts";
import { AREA } from "./report.ts";
import {
  type Active,
  combine,
  isSubset,
  list,
  minus,
  QUIET,
  sameSet,
  sortedUnique,
} from "./sets.ts";
import {
  asFunction,
  BOOLEAN,
  comparisonClass,
  fieldsOf,
  fits,
  INT,
  isBooleanLike,
  isNumeric,
  isStringLike,
  members,
  NEVER,
  NUMBER,
  same,
  show,
  STRING,
  unfold,
  unionOf,
  UNIT,
} from "./typing.ts";
import { checkTypeIds, type Ctx } from "./world.ts";

const EFFECT_ONLY: Active = {
  failures: [],
  requirements: [],
  execution: "effect",
};

/** What a checked node contributes to its parent. */
interface Out extends Active {
  readonly type: Type;
}

/** The recomputed annotation of a node. */
interface Comp {
  /** The recomputed type. Undefined: the node validated its type itself, or it cannot be recomputed. */
  readonly type: Type | undefined;
  /** Exact: the recorded type must equal it. Fit: the recomputed type must fit the recorded type. */
  readonly match: "exact" | "fit";
  readonly active: Active;
  /** The sets could not be recomputed. The recorded sets stand. */
  readonly poisoned?: boolean;
}

function invocationOf(fn: {
  readonly execution: Active["execution"];
  readonly effects: {
    readonly failures: Active["failures"];
    readonly requirements: Active["requirements"];
  };
}): Active {
  return {
    failures: fn.effects.failures,
    requirements: fn.effects.requirements,
    execution: fn.execution,
  };
}

function literalValues(
  ctx: Ctx,
  type: Type,
): (string | number | boolean)[] | undefined {
  const values: (string | number | boolean)[] = [];
  for (const member of members(ctx.world.env, type)) {
    if (member.kind === "literal") values.push(member.value);
    else if (member.kind === "primitive" && member.name === "boolean") {
      values.push(true, false);
    } else return undefined;
  }
  return values;
}

export class BodyValidator {
  private readonly scope = new Map<string, Type>();
  private readonly declared = new Set<string>();

  constructor(private readonly ctx: Ctx) {}

  private get env() {
    return this.ctx.world.env;
  }

  private add(
    area: Parameters<Ctx["report"]["add"]>[0],
    path: string,
    what: string,
    span: Span,
  ): void {
    this.ctx.report.add(area, path, what, span);
  }

  // -------------------------------------------------------------- locals

  private declareLocal(p: Parameter, path: string): void {
    if (!p.id.startsWith("local:")) {
      this.add(
        AREA.identity,
        `${path}.id`,
        `${p.id} is not a local identity`,
        p.span,
      );
    }
    if (this.declared.has(p.id)) {
      this.add(
        AREA.identity,
        `${path}.id`,
        `the local ${p.id} is declared twice in this function`,
        p.span,
      );
    }
    this.declared.add(p.id);
    this.scope.set(p.id, p.type);
    checkTypeIds(this.ctx, p.type, `${path}.type`, p.span);
  }

  private release(ids: readonly string[]): void {
    for (const id of ids) this.scope.delete(id);
  }

  // -------------------------------------------------------------- declarations

  checkFunction(d: FunctionDecl, path: string): void {
    const env = this.env;
    const added: string[] = [];
    d.parameters.forEach((p, j) => {
      this.declareLocal(p, `${path}.parameters[${j}]`);
      added.push(p.id);
    });
    if (d.type.parameters.length !== d.parameters.length) {
      this.add(
        AREA.types,
        `${path}.type.parameters`,
        `the function type has ${d.type.parameters.length} parameters, the function declares ${d.parameters.length}`,
        d.span,
      );
    } else {
      d.parameters.forEach((p, j) => {
        if (!same(env, p.type, d.type.parameters[j])) {
          this.add(
            AREA.types,
            `${path}.type.parameters[${j}]`,
            `expected ${show(p.type)}, recorded ${show(d.type.parameters[j])}`,
            p.span,
          );
        }
      });
    }
    const body = this.check(d.body, `${path}.body`);
    this.release(added);
    if (!fits(env, body.type, d.type.result)) {
      this.add(
        AREA.types,
        `${path}.body`,
        `the body type ${show(body.type)} does not fit the declared result ${
          show(d.type.result)
        }`,
        d.body.span,
      );
    }
    const declared = d.type.effects;
    if (d.contract === "explicit") {
      const extraF = minus(body.failures, declared.failures);
      if (extraF.length > 0) {
        this.add(
          AREA.contracts,
          `${path}.body`,
          `the body can fail with ${
            list(extraF)
          }, which the declared failures ${
            list(declared.failures)
          } do not list`,
          d.body.span,
        );
      }
      const extraR = minus(body.requirements, declared.requirements);
      if (extraR.length > 0) {
        this.add(
          AREA.contracts,
          `${path}.body`,
          `the body requires ${list(extraR)}, which the declared requirements ${
            list(declared.requirements)
          } do not list`,
          d.body.span,
        );
      }
    } else {
      if (!sameSet(declared.failures, body.failures)) {
        this.add(
          AREA.contracts,
          `${path}.type.effects.failures`,
          `an inferred contract equals the body: expected ${
            list(body.failures)
          }, recorded ${list(declared.failures)}`,
          d.span,
        );
      }
      if (!sameSet(declared.requirements, body.requirements)) {
        this.add(
          AREA.contracts,
          `${path}.type.effects.requirements`,
          `an inferred contract equals the body: expected ${
            list(body.requirements)
          }, recorded ${list(declared.requirements)}`,
          d.span,
        );
      }
    }
    const nonempty = declared.failures.length + declared.requirements.length >
      0;
    const expected = nonempty || body.execution === "effect"
      ? "effect"
      : "pure";
    if (d.type.execution !== expected) {
      this.add(
        AREA.execution,
        `${path}.type.execution`,
        `expected ${expected}, recorded ${d.type.execution}`,
        d.span,
      );
    }
  }

  checkConstant(d: ConstantDecl, path: string): void {
    const out = this.check(d.value, `${path}.value`);
    if (!fits(this.env, out.type, d.type)) {
      this.add(
        AREA.types,
        `${path}.value`,
        `the initializer type ${
          show(out.type)
        } does not fit the constant type ${show(d.type)}`,
        d.value.span,
      );
    }
    const v = d.value;
    if (
      v.execution !== "pure" || v.effects.failures.length > 0 ||
      v.effects.requirements.length > 0
    ) {
      this.add(
        AREA.initialization,
        `${path}.value`,
        `a module constant needs a pure initializer with empty sets; recorded ${v.execution}, failures ${
          list(v.effects.failures)
        }, requirements ${list(v.effects.requirements)}`,
        v.span,
      );
    }
  }

  // -------------------------------------------------------------- expressions

  check(e: Expr, path: string, callee = false): Out {
    return this.finish(e, path, this.compute(e, path, callee));
  }

  private finish(e: Expr, path: string, comp: Comp): Out {
    const env = this.env;
    const typeOk = checkTypeIds(this.ctx, e.type, `${path}.type`, e.span);
    let type = e.type;
    if (comp.type !== undefined && typeOk) {
      const good = comp.match === "exact"
        ? same(env, comp.type, e.type)
        : fits(env, comp.type, e.type);
      if (!good) {
        this.add(
          AREA.types,
          `${path}.type`,
          comp.match === "exact"
            ? `expected ${show(comp.type)}, recorded ${show(e.type)}`
            : `the recomputed type ${
              show(comp.type)
            } does not fit the recorded type ${show(e.type)}`,
          e.span,
        );
        type = comp.type;
      }
    }
    const recorded: Active = {
      failures: sortedUnique(e.effects.failures),
      requirements: sortedUnique(e.effects.requirements),
      execution: e.execution,
    };
    if (comp.poisoned === true) return { ...recorded, type };
    const active = comp.active;
    if (!sameSet(recorded.failures, active.failures)) {
      this.add(
        AREA.contracts,
        `${path}.effects.failures`,
        `expected ${list(active.failures)}, recorded ${
          list(recorded.failures)
        }`,
        e.span,
      );
    }
    if (!sameSet(recorded.requirements, active.requirements)) {
      this.add(
        AREA.contracts,
        `${path}.effects.requirements`,
        `expected ${list(active.requirements)}, recorded ${
          list(recorded.requirements)
        }`,
        e.span,
      );
    }
    if (recorded.execution !== active.execution) {
      this.add(
        AREA.execution,
        `${path}.execution`,
        `expected ${active.execution}, recorded ${recorded.execution}`,
        e.span,
      );
    }
    return { ...active, type };
  }

  private poison(): Comp {
    return { type: undefined, match: "exact", active: QUIET, poisoned: true };
  }

  private compute(e: Expr, path: string, callee: boolean): Comp {
    switch (e.kind) {
      case "literal":
        return {
          type: e.value === null ? UNIT : { kind: "literal", value: e.value },
          match: "fit",
          active: QUIET,
        };
      case "reference":
        return this.reference(e.target, e.span, path, callee);
      case "record":
        return this.recordLike(e, path);
      case "array":
        return this.arrayLike(e, path);
      case "tuple":
        return this.tupleLike(e, path);
      case "get":
        return this.get(e, path);
      case "update":
        return this.update(e, path);
      case "brand":
        return this.brand(e, path);
      case "unbrand":
        return this.unbrand(e, path);
      case "some": {
        const v = this.check(e.value, `${path}.value`);
        return {
          type: { kind: "option", element: v.type },
          match: "fit",
          active: combine([v]),
        };
      }
      case "none":
        return {
          type: { kind: "option", element: NEVER },
          match: "fit",
          active: QUIET,
        };
      case "error":
        return this.errorConstruction(e, path);
      case "closure":
        return this.closure(e, path);
      case "call":
        return this.call(e, path);
      case "perform":
        return this.perform(e, path);
      case "block":
        return this.block(e, path);
      case "if":
        return this.ifExpr(e, path);
      case "match":
        return this.matchExpr(e, path);
      case "fail":
        return this.fail(e, path);
      case "catch":
        return this.catchExpr(e, path);
      case "retry":
        return this.retry(e, path);
      case "provide":
        return this.provide(e, path);
      case "binary":
        return this.binary(e, path);
    }
  }

  // -------------------------------------------------------------- leaves and data

  private reference(
    target: string,
    span: Span,
    path: string,
    callee: boolean,
  ): Comp {
    const world = this.ctx.world;
    const type = target.startsWith("local:")
      ? this.scope.get(target)
      : target.startsWith("value:")
      ? world.values.get(target)
      : undefined;
    if (type === undefined) {
      this.add(
        AREA.identity,
        `${path}.target`,
        `the target ${target} is not a parameter, a binding, or a declaration in scope`,
        span,
      );
      return this.poison();
    }
    if (world.builtins.has(target) && !callee) {
      this.add(
        AREA.identity,
        `${path}.target`,
        `the builtin ${target} may appear only as the callee of a call`,
        span,
      );
    }
    return { type, match: "exact", active: QUIET };
  }

  /** Checks field values against declared fields. Used by records, updates, and errors. */
  private checkFieldValues(
    fields: readonly { readonly name: string; readonly value: Expr }[],
    outs: readonly Out[],
    declared: readonly {
      readonly name: string;
      readonly type: Type;
      readonly optional: boolean;
    }[],
    path: string,
    span: Span,
    requireAll: boolean,
    what: string,
  ): void {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      const at = `${path}.fields[${i}]`;
      if (seen.has(f.name)) {
        this.add(AREA.types, at, `the field ${f.name} appears twice`, span);
        return;
      }
      seen.add(f.name);
      const field = declared.find((d) => d.name === f.name);
      if (field === undefined) {
        this.add(
          AREA.types,
          at,
          `${what} has no field ${f.name}`,
          span,
        );
        return;
      }
      if (!fits(this.env, outs[i].type, field.type)) {
        this.add(
          AREA.types,
          `${at}.value`,
          `the value of ${f.name} has type ${
            show(outs[i].type)
          }, which does not fit ${show(field.type)}`,
          f.value.span,
        );
      }
    });
    if (requireAll) {
      const missing = declared.filter((d) => !d.optional && !seen.has(d.name))
        .map((d) => d.name);
      if (missing.length > 0) {
        this.add(
          AREA.types,
          path,
          `the construction is missing the required fields ${list(missing)}`,
          span,
        );
      }
    }
  }

  private recordLike(
    e: Extract<Expr, { kind: "record" }>,
    path: string,
  ): Comp {
    const outs = e.fields.map((f, i) =>
      this.check(f.value, `${path}.fields[${i}].value`)
    );
    const target = unfold(this.env, e.type);
    if (target.kind !== "record") {
      this.add(
        AREA.types,
        `${path}.type`,
        `a record construction has a record type, recorded ${show(e.type)}`,
        e.span,
      );
    } else {
      this.checkFieldValues(
        e.fields,
        outs,
        target.fields,
        path,
        e.span,
        true,
        `the record type ${show(e.type)}`,
      );
    }
    return { type: undefined, match: "exact", active: combine(outs) };
  }

  private arrayLike(
    e: Extract<Expr, { kind: "array" }>,
    path: string,
  ): Comp {
    const outs = e.elements.map((x, i) =>
      this.check(x, `${path}.elements[${i}]`)
    );
    const target = unfold(this.env, e.type);
    if (target.kind !== "array") {
      this.add(
        AREA.types,
        `${path}.type`,
        `an array construction has an array type, recorded ${show(e.type)}`,
        e.span,
      );
    } else {
      outs.forEach((o, i) => {
        if (!fits(this.env, o.type, target.element)) {
          this.add(
            AREA.types,
            `${path}.elements[${i}]`,
            `the element has type ${show(o.type)}, which does not fit ${
              show(target.element)
            }`,
            e.elements[i].span,
          );
        }
      });
    }
    return { type: undefined, match: "exact", active: combine(outs) };
  }

  private tupleLike(
    e: Extract<Expr, { kind: "tuple" }>,
    path: string,
  ): Comp {
    const outs = e.elements.map((x, i) =>
      this.check(x, `${path}.elements[${i}]`)
    );
    const target = unfold(this.env, e.type);
    if (target.kind !== "tuple" || target.elements.length !== outs.length) {
      this.add(
        AREA.types,
        `${path}.type`,
        `a tuple construction of ${outs.length} elements has a tuple type of equal length, recorded ${
          show(e.type)
        }`,
        e.span,
      );
    } else {
      outs.forEach((o, i) => {
        if (!fits(this.env, o.type, target.elements[i])) {
          this.add(
            AREA.types,
            `${path}.elements[${i}]`,
            `the element has type ${show(o.type)}, which does not fit ${
              show(target.elements[i])
            }`,
            e.elements[i].span,
          );
        }
      });
    }
    return { type: undefined, match: "exact", active: combine(outs) };
  }

  private get(e: Extract<Expr, { kind: "get" }>, path: string): Comp {
    const base = this.check(e.record, `${path}.record`);
    const types: Type[] = [];
    let optional = false;
    for (const member of members(this.env, base.type)) {
      const fields = fieldsOf(this.env, member);
      const field = fields?.find((f) => f.name === e.field);
      if (field === undefined) {
        this.add(
          AREA.types,
          `${path}.field`,
          fields === undefined
            ? `a value of type ${show(base.type)} has no fields`
            : `the type ${show(member)} has no field ${e.field}`,
          e.span,
        );
        return { type: undefined, match: "exact", active: combine([base]) };
      }
      if (field.optional) optional = true;
      types.push(field.type);
    }
    const type = unionOf(this.env, types);
    return {
      type: optional ? { kind: "option", element: type } : type,
      match: "exact",
      active: combine([base]),
    };
  }

  private update(e: Extract<Expr, { kind: "update" }>, path: string): Comp {
    const base = this.check(e.record, `${path}.record`);
    const outs = e.fields.map((f, i) =>
      this.check(f.value, `${path}.fields[${i}].value`)
    );
    const active = combine([base, ...outs]);
    const unfolded = unfold(this.env, base.type);
    const fields = unfolded.kind === "union"
      ? undefined
      : fieldsOf(this.env, unfolded);
    if (fields === undefined) {
      this.add(
        AREA.types,
        `${path}.record`,
        `a record update needs a record, but the base has type ${
          show(base.type)
        }`,
        e.span,
      );
      return { type: undefined, match: "exact", active };
    }
    this.checkFieldValues(
      e.fields,
      outs,
      fields,
      path,
      e.span,
      false,
      `the record type ${show(base.type)}`,
    );
    return { type: base.type, match: "exact", active };
  }

  private brand(e: Extract<Expr, { kind: "brand" }>, path: string): Comp {
    const v = this.check(e.value, `${path}.value`);
    const decl = this.ctx.world.types.get(e.brand);
    if (decl === undefined) {
      this.add(
        AREA.identity,
        `${path}.brand`,
        `the brand ${e.brand} is not a declared type`,
        e.span,
      );
      return { type: undefined, match: "exact", active: combine([v]) };
    }
    if (decl.definition.kind !== "brand") {
      this.add(
        AREA.types,
        `${path}.brand`,
        `${e.brand} is a type alias, not a brand`,
        e.span,
      );
    } else if (!fits(this.env, v.type, decl.definition.base)) {
      this.add(
        AREA.types,
        `${path}.value`,
        `the value has type ${show(v.type)}, which does not fit the base ${
          show(decl.definition.base)
        }`,
        e.value.span,
      );
    }
    return {
      type: { kind: "named", id: e.brand },
      match: "exact",
      active: combine([v]),
    };
  }

  private unbrand(e: Extract<Expr, { kind: "unbrand" }>, path: string): Comp {
    const v = this.check(e.value, `${path}.value`);
    const unfolded = unfold(this.env, v.type);
    const base = unfolded.kind === "named"
      ? this.env.brands.get(unfolded.id)
      : undefined;
    if (base === undefined) {
      this.add(
        AREA.types,
        `${path}.value`,
        `unbrand needs a brand value, but the value has type ${show(v.type)}`,
        e.value.span,
      );
    }
    return { type: base, match: "exact", active: combine([v]) };
  }

  private errorConstruction(
    e: Extract<Expr, { kind: "error" }>,
    path: string,
  ): Comp {
    const outs = e.fields.map((f, i) =>
      this.check(f.value, `${path}.fields[${i}].value`)
    );
    const active = combine(outs);
    const decl = this.ctx.world.errors.get(e.error);
    if (decl === undefined) {
      this.add(
        AREA.identity,
        `${path}.error`,
        `the error ${e.error} is not declared`,
        e.span,
      );
      return { type: undefined, match: "exact", active };
    }
    this.checkFieldValues(
      e.fields,
      outs,
      decl.fields,
      path,
      e.span,
      true,
      `the error ${e.error}`,
    );
    return {
      type: { kind: "named", id: e.error },
      match: "exact",
      active,
    };
  }

  // -------------------------------------------------------------- functions

  private closure(e: Extract<Expr, { kind: "closure" }>, path: string): Comp {
    const env = this.env;
    const added: string[] = [];
    e.parameters.forEach((p, j) => {
      this.declareLocal(p, `${path}.parameters[${j}]`);
      added.push(p.id);
    });
    const body = this.check(e.body, `${path}.body`);
    this.release(added);
    const fn = asFunction(env, e.type);
    if (fn === undefined) {
      this.add(
        AREA.types,
        `${path}.type`,
        `a closure has a function type, recorded ${show(e.type)}`,
        e.span,
      );
      return { type: undefined, match: "exact", active: QUIET };
    }
    if (fn.parameters.length !== e.parameters.length) {
      this.add(
        AREA.types,
        `${path}.type.parameters`,
        `the closure declares ${e.parameters.length} parameters, its type has ${fn.parameters.length}`,
        e.span,
      );
    } else {
      e.parameters.forEach((p, j) => {
        if (!same(env, p.type, fn.parameters[j])) {
          this.add(
            AREA.types,
            `${path}.type.parameters[${j}]`,
            `expected ${show(p.type)}, recorded ${show(fn.parameters[j])}`,
            p.span,
          );
        }
      });
    }
    if (!fits(env, body.type, fn.result)) {
      this.add(
        AREA.types,
        `${path}.body`,
        `the body type ${show(body.type)} does not fit the closure result ${
          show(fn.result)
        }`,
        e.body.span,
      );
    }
    if (!isSubset(body.failures, fn.effects.failures)) {
      this.add(
        AREA.contracts,
        `${path}.type.effects.failures`,
        `the body can fail with ${
          list(body.failures)
        }, the closure type lists ${list(fn.effects.failures)}`,
        e.span,
      );
    }
    if (!isSubset(body.requirements, fn.effects.requirements)) {
      this.add(
        AREA.contracts,
        `${path}.type.effects.requirements`,
        `the body requires ${list(body.requirements)}, the closure type lists ${
          list(fn.effects.requirements)
        }`,
        e.span,
      );
    }
    const nonempty =
      fn.effects.failures.length + fn.effects.requirements.length >
        0;
    const expected = nonempty || body.execution === "effect"
      ? "effect"
      : "pure";
    if (fn.execution !== expected) {
      this.add(
        AREA.execution,
        `${path}.type.execution`,
        `expected ${expected}, recorded ${fn.execution}`,
        e.span,
      );
    }
    // Construction evaluates no part of the body: closure construction is pure.
    return { type: undefined, match: "exact", active: QUIET };
  }

  private checkArguments(
    args: readonly Expr[],
    outs: readonly Out[],
    parameters: readonly Type[],
    path: string,
    span: Span,
    builtin: boolean,
  ): void {
    if (outs.length !== parameters.length) {
      this.add(
        AREA.types,
        `${path}.arguments`,
        `the function takes ${parameters.length} arguments, the call has ${outs.length}`,
        span,
      );
      return;
    }
    outs.forEach((o, i) => {
      if (builtin) {
        const fn = asFunction(this.env, o.type);
        if (
          fn !== undefined &&
          (fn.execution !== "pure" || fn.effects.failures.length > 0 ||
            fn.effects.requirements.length > 0)
        ) {
          this.add(
            AREA.execution,
            `${path}.arguments[${i}]`,
            "a builtin callback is pure with empty failure and requirement sets",
            args[i].span,
          );
          return;
        }
      }
      if (!fits(this.env, o.type, parameters[i])) {
        this.add(
          AREA.types,
          `${path}.arguments[${i}]`,
          `the argument has type ${
            show(o.type)
          }, which does not fit the parameter ${show(parameters[i])}`,
          args[i].span,
        );
      }
    });
  }

  private call(e: Extract<Expr, { kind: "call" }>, path: string): Comp {
    const callee = this.check(e.callee, `${path}.callee`, true);
    const outs = e.arguments.map((a, i) =>
      this.check(a, `${path}.arguments[${i}]`)
    );
    const fn = asFunction(this.env, callee.type);
    if (fn === undefined) {
      this.add(
        AREA.types,
        `${path}.callee`,
        `the callee has type ${show(callee.type)}, which is not a function`,
        e.callee.span,
      );
      return {
        type: undefined,
        match: "exact",
        active: combine([callee, ...outs]),
      };
    }
    const builtin = e.callee.kind === "reference" &&
      this.ctx.world.builtins.has(e.callee.target);
    this.checkArguments(
      e.arguments,
      outs,
      fn.parameters,
      path,
      e.span,
      builtin,
    );
    return {
      type: fn.result,
      match: "exact",
      active: combine([callee, ...outs, invocationOf(fn)]),
    };
  }

  private perform(e: Extract<Expr, { kind: "perform" }>, path: string): Comp {
    const outs = e.arguments.map((a, i) =>
      this.check(a, `${path}.arguments[${i}]`)
    );
    const method = this.ctx.world.methods.get(e.capability);
    if (method === undefined) {
      this.add(
        AREA.identity,
        `${path}.capability`,
        `the capability ${e.capability} is not a method of a service of this module or of an import`,
        e.span,
      );
      return this.poison();
    }
    const fn = method.type;
    this.checkArguments(e.arguments, outs, fn.parameters, path, e.span, false);
    return {
      type: fn.result,
      match: "exact",
      active: combine([
        ...outs,
        invocationOf(fn),
        { failures: [], requirements: [e.capability], execution: "effect" },
      ]),
    };
  }

  // -------------------------------------------------------------- control flow

  private block(e: Extract<Expr, { kind: "block" }>, path: string): Comp {
    const added: string[] = [];
    const parts: Out[] = [];
    e.steps.forEach((step, i) => {
      const at = `${path}.steps[${i}]`;
      const value = this.check(step.value, `${at}.value`);
      parts.push(value);
      if (step.kind === "bind") {
        this.declareLocal(step.binding, `${at}.binding`);
        added.push(step.binding.id);
        if (!fits(this.env, value.type, step.binding.type)) {
          this.add(
            AREA.types,
            `${at}.binding.type`,
            `the value has type ${
              show(value.type)
            }, which does not fit the binding type ${show(step.binding.type)}`,
            step.binding.span,
          );
        }
      }
    });
    const result = this.check(e.result, `${path}.result`);
    this.release(added);
    return {
      type: result.type,
      match: "exact",
      active: combine([...parts, result]),
    };
  }

  private branchFits(
    branch: Out,
    recorded: Type,
    path: string,
    span: Span,
    area: typeof AREA.types | typeof AREA.recovery,
  ): void {
    if (!fits(this.env, branch.type, recorded)) {
      this.add(
        area,
        path,
        `the branch has type ${
          show(branch.type)
        }, which does not fit the recorded type ${show(recorded)}`,
        span,
      );
    }
  }

  private ifExpr(e: Extract<Expr, { kind: "if" }>, path: string): Comp {
    const cond = this.check(e.condition, `${path}.condition`);
    if (!isBooleanLike(this.env, cond.type)) {
      this.add(
        AREA.types,
        `${path}.condition`,
        `a condition must be boolean, but it has type ${show(cond.type)}`,
        e.condition.span,
      );
    }
    const thenOut = this.check(e.then, `${path}.then`);
    const elseOut = this.check(e.else, `${path}.else`);
    this.branchFits(thenOut, e.type, `${path}.then`, e.then.span, AREA.types);
    this.branchFits(elseOut, e.type, `${path}.else`, e.else.span, AREA.types);
    return {
      type: undefined,
      match: "exact",
      active: combine([cond, thenOut, elseOut]),
    };
  }

  private matchExpr(e: Extract<Expr, { kind: "match" }>, path: string): Comp {
    const subject = this.check(e.subject, `${path}.subject`);
    const parts: Out[] = [subject];
    e.arms.forEach((arm, i) => {
      const at = `${path}.arms[${i}]`;
      const added = this.pattern(arm.pattern, subject.type, `${at}.pattern`);
      const body = this.check(arm.body, `${at}.body`);
      this.release(added);
      parts.push(body);
      this.branchFits(body, e.type, `${at}.body`, arm.body.span, AREA.types);
    });
    return { type: undefined, match: "exact", active: combine(parts) };
  }

  /** Checks one pattern against the subject type and declares its bindings. */
  private pattern(p: Pattern, subject: Type, path: string): string[] {
    const env = this.env;
    const added: string[] = [];
    const bind = (binding: Parameter, expected: Type | undefined): void => {
      this.declareLocal(binding, `${path}.binding`);
      added.push(binding.id);
      if (expected !== undefined && !same(env, binding.type, expected)) {
        this.add(
          AREA.types,
          `${path}.binding.type`,
          `expected ${show(expected)}, recorded ${show(binding.type)}`,
          binding.span,
        );
      }
    };
    const foreign = (what: string): void =>
      this.add(
        AREA.types,
        path,
        `${what} does not belong to the subject of type ${show(subject)}`,
        p.span,
      );
    const unfolded = unfold(env, subject);
    switch (p.kind) {
      case "wildcard":
        return added;
      case "literal":
        if (!fits(env, { kind: "literal", value: p.value }, subject)) {
          foreign(`the literal ${JSON.stringify(p.value)}`);
        }
        return added;
      case "none":
        if (unfolded.kind !== "option") foreign("None");
        return added;
      case "some":
        if (unfolded.kind !== "option") {
          foreign("Some");
          bind(p.binding, undefined);
        } else {
          bind(p.binding, unfolded.element);
        }
        return added;
      case "error": {
        const ms = members(env, subject);
        const ok = ms.length > 0 &&
          ms.every((m) => m.kind === "named" && env.errors.has(m.id)) &&
          ms.some((m) => m.kind === "named" && m.id === p.error);
        if (!ok) foreign(`the error ${p.error}`);
        bind(p.binding, ok ? { kind: "named", id: p.error } : undefined);
        return added;
      }
      case "tag": {
        const ms = members(env, subject);
        const records = ms.every((m) => m.kind === "record");
        const narrowed = records
          ? ms.filter((m) => {
            if (m.kind !== "record") return false;
            const field = m.fields.find((f) => f.name === p.field);
            return field !== undefined &&
              (literalValues(this.ctx, field.type)?.includes(p.value) ?? false);
          })
          : [];
        if (!records || narrowed.length === 0) {
          foreign(`the tag ${p.field}: ${JSON.stringify(p.value)}`);
        }
        if (p.binding !== null) {
          bind(
            p.binding,
            narrowed.length > 0 ? unionOf(env, narrowed) : undefined,
          );
        }
        return added;
      }
    }
  }

  private fail(e: Extract<Expr, { kind: "fail" }>, path: string): Comp {
    const err = this.check(e.error, `${path}.error`);
    const unfolded = unfold(this.env, err.type);
    let failures: ErrorId[] = [];
    if (unfolded.kind === "named" && this.env.errors.has(unfolded.id)) {
      failures = [unfolded.id as ErrorId];
    } else {
      this.add(
        AREA.types,
        `${path}.error`,
        `fail needs a value of a named error type, but the value has type ${
          show(err.type)
        }`,
        e.error.span,
      );
    }
    return {
      type: NEVER,
      match: "exact",
      active: combine([
        err,
        {
          failures,
          requirements: [],
          execution: "effect",
        },
      ]),
    };
  }

  private catchExpr(e: Extract<Expr, { kind: "catch" }>, path: string): Comp {
    const env = this.env;
    const body = this.check(e.body, `${path}.body`);
    this.branchFits(body, e.type, `${path}.body`, e.body.span, AREA.recovery);
    const handled = new Set<string>();
    const seen = new Set<string>();
    const outs: Out[] = [];
    e.handlers.forEach((h, i) => {
      const at = `${path}.handlers[${i}]`;
      if (!this.ctx.world.errors.has(h.error)) {
        this.add(
          AREA.identity,
          `${at}.error`,
          `the handled error ${h.error} is not declared`,
          h.span,
        );
      }
      if (seen.has(h.error)) {
        this.add(
          AREA.recovery,
          `${at}.error`,
          `the error ${h.error} has two handlers`,
          h.span,
        );
      } else if (!body.failures.includes(h.error)) {
        this.add(
          AREA.recovery,
          `${at}.error`,
          `the protected block cannot fail with ${h.error}; its failures are ${
            list(body.failures)
          }`,
          h.span,
        );
      } else {
        handled.add(h.error);
      }
      seen.add(h.error);
      this.declareLocal(h.binding, `${at}.binding`);
      if (
        this.ctx.world.errors.has(h.error) &&
        !same(env, h.binding.type, { kind: "named", id: h.error })
      ) {
        this.add(
          AREA.types,
          `${at}.binding.type`,
          `expected ${h.error}, recorded ${show(h.binding.type)}`,
          h.binding.span,
        );
      }
      const out = this.check(h.body, `${at}.body`);
      this.release([h.binding.id]);
      outs.push(out);
      this.branchFits(out, e.type, `${at}.body`, h.body.span, AREA.recovery);
    });
    const remaining: Active = {
      failures: minus(body.failures, [...handled]),
      requirements: body.requirements,
      execution: body.execution,
    };
    return {
      type: undefined,
      match: "exact",
      active: combine([remaining, ...outs, EFFECT_ONLY]),
    };
  }

  /**
   * The function type of a retry or provide job. A job with parameters is
   * reported, but its sets still count. A job that is no function is
   * reported, and the caller keeps the recorded annotation of the node.
   */
  private jobFunction(
    job: Out,
    path: string,
    span: Span,
    what: string,
  ): ReturnType<typeof asFunction> {
    const fn = asFunction(this.env, job.type);
    if (fn === undefined) {
      this.add(
        AREA.control,
        path,
        `${what} needs a function that takes no arguments, but the job has type ${
          show(job.type)
        }`,
        span,
      );
    } else if (fn.parameters.length > 0) {
      this.add(
        AREA.control,
        path,
        `${what} needs a function that takes no arguments, but the job takes ${fn.parameters.length}`,
        span,
      );
    }
    return fn;
  }

  private retry(e: Extract<Expr, { kind: "retry" }>, path: string): Comp {
    const job = this.check(e.job, `${path}.job`);
    const fn = this.jobFunction(job, `${path}.job`, e.job.span, "retry");
    if (!Number.isSafeInteger(e.times) || e.times < 0) {
      this.add(
        AREA.control,
        `${path}.times`,
        `retry needs a finite nonnegative safe integer count, recorded ${e.times}`,
        e.span,
      );
    }
    if (fn === undefined) return this.poison();
    return {
      type: fn.result,
      match: "exact",
      active: combine([job, invocationOf(fn), EFFECT_ONLY]),
    };
  }

  private provide(e: Extract<Expr, { kind: "provide" }>, path: string): Comp {
    const provider = this.check(e.provider, `${path}.provider`);
    const job = this.check(e.job, `${path}.job`);
    const providerType = unfold(this.env, provider.type);
    if (providerType.kind !== "provider") {
      this.add(
        AREA.control,
        `${path}.provider`,
        `provide needs a provider, but the expression has type ${
          show(provider.type)
        }`,
        e.provider.span,
      );
    }
    const fn = this.jobFunction(job, `${path}.job`, e.job.span, "provide");
    if (fn === undefined || providerType.kind !== "provider") {
      return this.poison();
    }
    const invocation: Active = {
      failures: fn.effects.failures,
      requirements: minus(fn.effects.requirements, providerType.provides),
      execution: fn.execution,
    };
    const acquisition: Active = {
      failures: providerType.acquisition.effects.failures,
      requirements: providerType.acquisition.effects.requirements,
      execution: "effect",
    };
    return {
      type: fn.result,
      match: "exact",
      active: combine([
        combine([provider, job]),
        invocation,
        acquisition,
        EFFECT_ONLY,
      ]),
    };
  }

  // -------------------------------------------------------------- operators

  private binary(e: Extract<Expr, { kind: "binary" }>, path: string): Comp {
    const env = this.env;
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const active = combine([left, right]);
    const mismatch = (): Comp => {
      this.add(
        AREA.types,
        path,
        `the operator ${e.operator} does not accept operands of type ${
          show(left.type)
        } and ${show(right.type)}`,
        e.span,
      );
      return { type: undefined, match: "exact", active };
    };
    switch (e.operator) {
      case "&&":
      case "||":
        return isBooleanLike(env, left.type) && isBooleanLike(env, right.type)
          ? { type: BOOLEAN, match: "exact", active }
          : mismatch();
      case "<":
      case "<=":
      case ">":
      case ">=":
        return isNumeric(env, left.type) && isNumeric(env, right.type)
          ? { type: BOOLEAN, match: "exact", active }
          : mismatch();
      case "===":
      case "!==": {
        const l = comparisonClass(env, left.type);
        const r = comparisonClass(env, right.type);
        return l !== undefined && l === r
          ? { type: BOOLEAN, match: "exact", active }
          : mismatch();
      }
      case "+":
      case "-":
      case "*":
      case "/": {
        if (isNumeric(env, left.type) && isNumeric(env, right.type)) {
          const integral = e.operator !== "/" && fits(env, left.type, INT) &&
            fits(env, right.type, INT);
          return {
            type: integral ? INT : NUMBER,
            match: "exact",
            active,
          };
        }
        if (
          e.operator === "+" && isStringLike(env, left.type) &&
          isStringLike(env, right.type)
        ) {
          return { type: STRING, match: "exact", active };
        }
        return mismatch();
      }
    }
  }
}

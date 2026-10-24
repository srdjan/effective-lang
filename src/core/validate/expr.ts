// Bottom-up recomputation of the annotations of one declaration body. For each
// node the validator recomputes the type, the failure set, the requirement set,
// and the execution mode from the children and from the identities in scope.
// It then compares the result with the recorded annotation.
//
// After a disagreement the validator continues with the recomputed value, so one
// bad node gives one diagnostic and its parents stay consistent. When a node
// cannot be recomputed (an unknown identity), the validator continues with the
// recorded annotation.
//
// The equations come from the spec, "Equations and validation".

import {
  type BuiltinCallName,
  classifyBuiltinCall,
  isConcurrencyOption,
} from "./builtins.ts";

import type {
  ConstantDecl,
  Effects,
  ErrorId,
  Execution,
  Expr,
  FunctionDecl,
  Parameter,
  Pattern,
  Span,
  Type,
} from "../ir.ts";
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "../ir.ts";
import { AREA } from "./report.ts";
import {
  type Active,
  combine,
  invocationOf,
  isQuiet,
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
  compatibleClasses,
  dataOnly,
  fieldsOf,
  fits,
  foreignSealedOf,
  identityBody,
  INT,
  isBooleanLike,
  isNumericClass,
  isStringClass,
  MAX_DEPTH,
  members,
  NEVER,
  NUMBER,
  numericBrandOf,
  ownsSealed,
  same,
  sealedRootOf,
  show,
  STRING,
  type TypeEnv,
  unfold,
  unionOf,
  UNIT,
} from "./typing.ts";
import { checkTypeIds, type Ctx } from "./world.ts";
import { exprChildren } from "./expr_walk.ts";
import {
  type Area,
  type Comp,
  derivedResult,
  EFFECT_ONLY,
  type Out,
  type ValidatorCore,
} from "./families/context.ts";
import { codec, codecOperation } from "./families/codec.ts";
import {
  allResults,
  partitionAll,
  validateAll,
} from "./families/collections.ts";
import {
  defer,
  race,
  retry,
  retrySchedule,
  retryWithSchedule,
  run,
} from "./families/effect.ts";
import { fiberOperation, withFiber } from "./families/fiber.ts";
import { layer, mergeLayers, provide } from "./families/layer.ts";
import {
  scheduleCompose,
  scheduleFromStep,
  scheduleMap,
  simpleSchedule,
} from "./families/schedule.ts";
import {
  borrowedReferences,
  explicitScope,
  forkScoped,
  scoped,
  withResource,
} from "./families/scope.ts";
import {
  accumulateStream,
  aggregateStream,
  aggregateWithinStream,
  bufferStream,
  catchStream,
  concatStreams,
  debounceStream,
  effectStreamPredicate,
  mapElements,
  mapGroups,
  mapStreams,
  mergeStreams,
  pureStreamPredicate,
  retryStream,
  runStream,
  sinkForEach,
  streamCount,
  streamTerminal,
  takeSink,
  throttleStream,
  transduceStream,
  unfoldStream,
  zipStreams,
} from "./families/stream.ts";
import { schema, schemaOperation } from "./families/schema.ts";
import { refOperation } from "./families/ref.ts";

// The test of the expression children imports this walk from here.
export { exprChildren };

function checkedResult(active: Active): Comp {
  return { kind: "checked", active };
}

/** A concurrency limit is `unbounded` or a positive safe integer. Undefined selects the default. */
function validConcurrency(value: number | "unbounded" | undefined): boolean {
  return value === undefined || value === "unbounded" ||
    (Number.isSafeInteger(value) && value > 0);
}

/** Equality can match unknown values and the runtime base of nominal brands. */
function tagMayEqual(
  env: TypeEnv,
  type: Type,
  value: string,
  seen = new Set<Type>(),
): boolean {
  if (seen.has(type) || seen.size >= MAX_DEPTH) return true;
  const next = new Set(seen).add(type);
  if (type.kind === "named") {
    const base = env.aliases.get(type.id) ?? env.brands.get(type.id);
    return base !== undefined && tagMayEqual(env, base, value, next);
  }
  if (type.kind === "union") {
    return type.members.some((m) => tagMayEqual(env, m, value, next));
  }
  if (type.kind === "primitive" && type.name === "unknown") return true;
  return fits(env, { kind: "literal", value }, type);
}

/**
 * The identity type when exactly one operand is a numeric identity and the
 * other operand is unnamed and fits the body of that identity.
 */
function adoptedNumericBrand(
  env: TypeEnv,
  left: Type,
  right: Type,
): Type | undefined {
  const l = numericBrandOf(env, left);
  const r = numericBrandOf(env, right);
  if ((l === undefined) === (r === undefined)) return undefined;
  const named = l ?? r;
  const unnamed = l === undefined ? left : right;
  const body = named?.kind === "named"
    ? identityBody(env, named.id)
    : undefined;
  return named !== undefined && body !== undefined && fits(env, unnamed, body)
    ? named
    : undefined;
}

export class BodyValidator implements ValidatorCore {
  private readonly scope = new Map<string, Type>();
  private readonly declared = new Set<string>();

  constructor(readonly ctx: Ctx) {}

  get env(): TypeEnv {
    return this.ctx.world.env;
  }

  add(
    area: Area,
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

  /**
   * Runs `run` with the locals that it declares in scope, and releases them
   * when `run` ends. A local cannot stay in scope after its region.
   */
  private withLocals<T>(
    run: (declare: (p: Parameter, path: string) => void) => T,
  ): T {
    const added: string[] = [];
    try {
      return run((p, path) => {
        this.declareLocal(p, path);
        added.push(p.id);
      });
    } finally {
      this.release(added);
    }
  }

  /** Compares each declared parameter type with the recorded function type. */
  private checkParameterTypes(
    parameters: readonly Parameter[],
    recorded: readonly Type[],
    path: string,
    countMessage: string,
    span: Span,
  ): void {
    if (recorded.length !== parameters.length) {
      this.add(AREA.types, `${path}.type.parameters`, countMessage, span);
      return;
    }
    parameters.forEach((p, j) => {
      if (!same(this.env, p.type, recorded[j])) {
        this.add(
          AREA.types,
          `${path}.type.parameters[${j}]`,
          `expected ${show(p.type)}, recorded ${show(recorded[j])}`,
          p.span,
        );
      }
    });
  }

  /** The recorded execution mode must follow the body mode and the effect sets. */
  private checkExecution(
    recorded: { readonly execution: Execution; readonly effects: Effects },
    body: Active,
    path: string,
    span: Span,
  ): void {
    const nonempty =
      recorded.effects.failures.length + recorded.effects.requirements.length >
        0;
    const expected = nonempty || body.execution === "effect"
      ? "effect"
      : "pure";
    if (recorded.execution !== expected) {
      this.add(
        AREA.execution,
        `${path}.type.execution`,
        `expected ${expected}, recorded ${recorded.execution}`,
        span,
      );
    }
  }

  // -------------------------------------------------------------- declarations

  checkFunction(d: FunctionDecl, path: string): void {
    const env = this.env;
    const body = this.withLocals((declare) => {
      d.parameters.forEach((p, j) => declare(p, `${path}.parameters[${j}]`));
      this.checkParameterTypes(
        d.parameters,
        d.type.parameters,
        path,
        `the function type has ${d.type.parameters.length} parameters, the function declares ${d.parameters.length}`,
        d.span,
      );
      const checked = this.check(d.body, `${path}.body`);
      if (
        d.type.borrows !== undefined &&
        d.type.borrows.length !== d.parameters.length
      ) {
        this.add(
          AREA.types,
          `${path}.type.borrows`,
          "borrow flags must match function parameters",
          d.span,
        );
      }
      d.parameters.forEach((parameter, index) => {
        if (d.type.borrows?.[index] === true && parameter.borrow !== true) {
          this.add(
            AREA.types,
            `${path}.parameters[${index}]`,
            "borrow parameter flag disagrees with function type",
            parameter.span,
          );
        }
        if (parameter.borrow !== true) return;
        const type = unfold(env, parameter.type);
        if (
          type.kind !== "named" ||
          this.ctx.world.types.get(type.id)?.opaque !== true
        ) {
          this.add(
            AREA.types,
            `${path}.parameters[${index}]`,
            "a borrow parameter needs an opaque type",
            parameter.span,
          );
        }
        if (d.type.borrows?.[index] !== true) {
          this.add(
            AREA.types,
            `${path}.type.borrows[${index}]`,
            "borrow flag missing from function type",
            parameter.span,
          );
        }
        if (!dataOnly(this.env, d.type.result, "value")) {
          this.add(
            AREA.types,
            `${path}.type.result`,
            "a borrow function must return data only",
            d.span,
          );
        }
        borrowedReferences(this, d.body, parameter.id, `${path}.body`);
      });
      return checked;
    });
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
    // A written set bounds the body from above. An inferred set equals the body.
    if (d.written.fails) {
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
    } else if (!sameSet(declared.failures, body.failures)) {
      this.add(
        AREA.contracts,
        `${path}.type.effects.failures`,
        `an inferred contract equals the body: expected ${
          list(body.failures)
        }, recorded ${list(declared.failures)}`,
        d.span,
      );
    }
    if (d.written.uses) {
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
    } else if (!sameSet(declared.requirements, body.requirements)) {
      this.add(
        AREA.contracts,
        `${path}.type.effects.requirements`,
        `an inferred contract equals the body: expected ${
          list(body.requirements)
        }, recorded ${list(declared.requirements)}`,
        d.span,
      );
    }
    this.checkExecution(d.type, body, path, d.span);
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
    if (!isQuiet(invocationOf(v))) {
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
    if (comp.kind === "derived" && typeOk) {
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
    if (comp.kind === "poisoned") return { ...recorded, type };
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

  poison(): Comp {
    return { kind: "poisoned" };
  }

  /** Reports a concurrency limit that is neither `unbounded` nor a positive safe integer. */
  checkConcurrency(
    e: {
      readonly concurrency: number | "unbounded" | undefined;
      readonly span: Span;
    },
    path: string,
    name: string,
  ): void {
    if (validConcurrency(e.concurrency)) return;
    this.add(
      AREA.control,
      `${path}.concurrency`,
      `${name} concurrency must be a positive safe integer or unbounded`,
      e.span,
    );
  }

  private compute(e: Expr, path: string, callee: boolean): Comp {
    switch (e.kind) {
      case "null":
        return derivedResult({ kind: "literal", value: null }, QUIET);
      case "literal":
        return derivedResult(
          e.value === null ? UNIT : { kind: "literal", value: e.value },
          QUIET,
          "fit",
        );
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
      case "nominal":
        return this.nominal(e, path);
      case "some": {
        const v = this.check(e.value, `${path}.value`);
        return derivedResult(
          { kind: "option", element: v.type },
          combine([v]),
          "fit",
        );
      }
      case "none":
        return derivedResult({ kind: "option", element: NEVER }, QUIET, "fit");
      case "error":
        return this.errorConstruction(e, path);
      case "closure":
        return this.closure(e, path);
      case "call":
        return this.call(e, path);
      case "defer":
        return defer(this, e, path);
      case "run":
        return run(this, e, path);
      case "partition-all":
        return partitionAll(this, e, path);
      case "validate-all":
        return validateAll(this, e, path);
      case "all-results":
        return allResults(this, e, path);
      case "scoped":
        return scoped(this, e, path);
      case "fork-scoped":
        return forkScoped(this, e, path);
      case "make-scope":
        return derivedResult({ kind: "closeable-scope" }, EFFECT_ONLY);
      case "provide-scope":
      case "add-scope-finalizer":
      case "close-scope":
        return explicitScope(this, e, path);
      case "with-resource":
        return withResource(this, e, path);
      case "unfold":
        return unfoldStream(this, e, path);
      case "map-effect":
      case "map-stream":
        return mapElements(this, e, path);
      case "map-groups":
        return mapGroups(this, e, path);
      case "scan-stream":
      case "map-accum-stream":
      case "fold-stream":
      case "fold-effect-stream":
        return accumulateStream(this, e, path);
      case "collect-stream":
      case "head-stream":
      case "last-stream":
      case "drain-stream":
        return streamTerminal(this, e, path);
      case "flat-map-streams":
      case "switch-map-streams":
        return mapStreams(this, e, path);
      case "catch-stream":
        return catchStream(this, e, path);
      case "retry-stream":
        return retryStream(this, e, path);
      case "debounce-stream":
        return debounceStream(this, e, path);
      case "throttle-stream":
        return throttleStream(this, e, path);
      case "take-stream":
      case "drop-stream":
        return streamCount(this, e, path);
      case "drop-while-stream":
      case "filter-stream":
      case "take-while-stream":
      case "take-until-stream":
        return pureStreamPredicate(this, e, path);
      case "filter-effect-stream":
      case "take-while-effect-stream":
      case "take-until-effect-stream":
      case "drop-while-effect-stream":
        return effectStreamPredicate(this, e, path);
      case "sink-for-each":
        return sinkForEach(this, e, path);
      case "take-sink":
        return takeSink(this, e, path);
      case "transduce-stream":
        return transduceStream(this, e, path);
      case "aggregate-stream":
        return aggregateStream(this, e, path);
      case "aggregate-within-stream":
        return aggregateWithinStream(this, e, path);
      case "schedule-from-step":
        return scheduleFromStep(this, e, path);
      case "schedule-recurs":
      case "schedule-spaced":
        return simpleSchedule(this, e, path);
      case "schedule-map":
        return scheduleMap(this, e, path);
      case "schedule-max":
      case "schedule-min":
      case "schedule-concat":
        return scheduleCompose(this, e, path);
      case "run-stream":
        return runStream(this, e, path);
      case "buffer-stream":
        return bufferStream(this, e, path);
      case "merge-streams":
        return mergeStreams(this, e, path);
      case "zip-streams":
        return zipStreams(this, e, path);
      case "concat-streams":
        return concatStreams(this, e, path);
      case "race":
        return race(this, e, path);
      case "make-ref":
      case "get-ref":
      case "set-ref":
      case "update-ref":
        return refOperation(this, e, path);
      case "layer":
        return layer(this, e, path);
      case "merge-layers":
        return mergeLayers(this, e, path);
      case "retry-schedule":
        return retrySchedule(this, e, path);
      case "retry-with-schedule":
        return retryWithSchedule(this, e, path);
      case "codec":
        return codec(this, e, path);
      case "schema":
        return schema(this, e, path);
      case "schema-make":
      case "schema-decode":
      case "schema-encode":
        return schemaOperation(this, e, path);
      case "decode":
      case "encode":
        return codecOperation(this, e, path);
      case "with-fiber":
        return withFiber(this, e, path);
      case "join-fiber":
      case "interrupt-fiber":
        return fiberOperation(this, e, path);
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
        return retry(this, e, path);
      case "provide":
        return provide(this, e, path);
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
    return derivedResult(type, QUIET);
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
    return checkedResult(combine(outs));
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
    return checkedResult(combine(outs));
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
    return checkedResult(combine(outs));
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
        return checkedResult(combine([base]));
      }
      if (field.optional) optional = true;
      types.push(field.type);
    }
    const type = unionOf(this.env, types);
    return derivedResult(
      optional ? { kind: "option", element: type } : type,
      combine([base]),
    );
  }

  private update(e: Extract<Expr, { kind: "update" }>, path: string): Comp {
    const base = this.check(e.record, `${path}.record`);
    const outs = e.fields.map((f, i) =>
      this.check(f.value, `${path}.fields[${i}].value`)
    );
    const active = combine([base, ...outs]);
    const sealed = sealedRootOf(this.env, base.type);
    if (sealed !== undefined && !ownsSealed(this.env, sealed)) {
      this.add(
        AREA.types,
        path,
        `a foreign module cannot retain the sealed nominal type ${sealed} after an update`,
        e.span,
      );
    }
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
      return checkedResult(active);
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
    return derivedResult(base.type, active);
  }

  private nominal(e: Extract<Expr, { kind: "nominal" }>, path: string): Comp {
    const v = this.check(e.value, `${path}.value`);
    const decl = this.ctx.world.types.get(e.nominal);
    if (decl === undefined) {
      this.add(
        AREA.identity,
        `${path}.nominal`,
        `the nominal type ${e.nominal} is not a declared type`,
        e.span,
      );
      return checkedResult(combine([v]));
    }
    if (decl.definition.kind !== "nominal") {
      this.add(
        AREA.types,
        `${path}.nominal`,
        `${e.nominal} is not a nominal type`,
        e.span,
      );
    } else if (decl.opaque === true) {
      this.add(
        AREA.types,
        `${path}.nominal`,
        "an opaque type cannot be constructed in source",
        e.span,
      );
    } else if (
      decl.definition.sealed === true &&
      !ownsSealed(this.env, e.nominal)
    ) {
      this.add(
        AREA.types,
        `${path}.nominal`,
        `the module cannot construct the foreign sealed nominal type ${e.nominal}`,
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
    return derivedResult({ kind: "named", id: e.nominal }, combine([v]));
  }

  private errorConstruction(
    e: Extract<Expr, { kind: "error" }>,
    path: string,
  ): Comp {
    const outs = e.fields.map((f, i) =>
      this.check(f.value, `${path}.fields[${i}].value`)
    );
    const active = combine(outs);
    if (e.error === SCHEMA_ERROR_ID || e.error === SCHEMA_ISSUE_ID) {
      this.add(
        AREA.types,
        path,
        "reserved Schema errors cannot be constructed as source errors",
        e.span,
      );
      return checkedResult(active);
    }
    const decl = this.ctx.world.errors.get(e.error);
    if (decl === undefined) {
      this.add(
        AREA.identity,
        `${path}.error`,
        `the error ${e.error} is not declared`,
        e.span,
      );
      return checkedResult(active);
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
    return derivedResult({ kind: "named", id: e.error }, active);
  }

  // -------------------------------------------------------------- functions

  private closure(e: Extract<Expr, { kind: "closure" }>, path: string): Comp {
    const env = this.env;
    const body = this.withLocals((declare) => {
      e.parameters.forEach((p, j) => declare(p, `${path}.parameters[${j}]`));
      return this.check(e.body, `${path}.body`);
    });
    const fn = asFunction(env, e.type);
    if (fn === undefined) {
      this.add(
        AREA.types,
        `${path}.type`,
        `a closure has a function type, recorded ${show(e.type)}`,
        e.span,
      );
      return checkedResult(QUIET);
    }
    this.checkParameterTypes(
      e.parameters,
      fn.parameters,
      path,
      `the closure declares ${e.parameters.length} parameters, its type has ${fn.parameters.length}`,
      e.span,
    );
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
    this.checkExecution(fn, body, path, e.span);
    // Construction evaluates no part of the body: closure construction is pure.
    return checkedResult(QUIET);
  }

  private checkArguments(
    args: readonly Expr[],
    outs: readonly Out[],
    parameters: readonly Type[],
    path: string,
    span: Span,
    builtin: BuiltinCallName | undefined,
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
      if (builtin !== undefined && builtin !== "traverse") {
        const fn = asFunction(this.env, o.type);
        if (
          fn !== undefined &&
          !isQuiet(invocationOf(fn))
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
      return checkedResult(combine([callee, ...outs]));
    }
    const metadata = e.callee.kind === "reference"
      ? this.ctx.world.builtinInfo.get(e.callee.target)
      : undefined;
    // Keep malformed names on the original guarded expression path.
    const builtin = metadata?.call.parsed
      ? metadata.call.name
      : e.callee.kind === "reference"
      ? classifyBuiltinCall(
        this.ctx.world.builtins.get(e.callee.target)?.split("/")[1],
      )
      : undefined;
    this.checkArguments(
      e.arguments,
      outs,
      fn.parameters,
      path,
      e.span,
      builtin,
    );
    if (builtin === "traverse" && (outs.length === 2 || outs.length === 3)) {
      const callback = asFunction(this.env, outs[1].type);
      if (
        fn.execution !== "effect" || callback === undefined ||
        !sameSet(fn.effects.failures, callback.effects.failures) ||
        !sameSet(fn.effects.requirements, callback.effects.requirements)
      ) {
        this.add(
          AREA.contracts,
          path,
          "traverse must invoke the callback with its declared failures and requirements",
          e.span,
        );
      }
      if (outs.length === 3) {
        const options = e.arguments[2];
        if (!isConcurrencyOption(options)) {
          this.add(
            AREA.control,
            `${path}.arguments[2]`,
            "traverse needs a positive safe integer or unbounded concurrency literal",
            options?.span ?? e.span,
          );
        }
      }
    }
    if (builtin === "all" && outs.length === 2) {
      const options = e.arguments[1];
      if (!isConcurrencyOption(options)) {
        this.add(
          AREA.control,
          `${path}.arguments[1]`,
          "all needs a positive safe integer or unbounded concurrency literal",
          options?.span ?? e.span,
        );
      }
    }
    return derivedResult(
      fn.result,
      combine([callee, ...outs, invocationOf(fn)]),
    );
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
    this.checkArguments(
      e.arguments,
      outs,
      fn.parameters,
      path,
      e.span,
      undefined,
    );
    return derivedResult(
      fn.result,
      combine([
        ...outs,
        invocationOf(fn),
        { failures: [], requirements: [e.capability], execution: "effect" },
      ]),
    );
  }

  // -------------------------------------------------------------- control flow

  private block(e: Extract<Expr, { kind: "block" }>, path: string): Comp {
    const parts: Out[] = [];
    const result = this.withLocals((declare) => {
      e.steps.forEach((step, i) => {
        const at = `${path}.steps[${i}]`;
        const value = this.check(step.value, `${at}.value`);
        parts.push(value);
        if (step.kind === "bind") {
          declare(step.binding, `${at}.binding`);
          if (!fits(this.env, value.type, step.binding.type)) {
            this.add(
              AREA.types,
              `${at}.binding.type`,
              `the value has type ${
                show(value.type)
              }, which does not fit the binding type ${
                show(step.binding.type)
              }`,
              step.binding.span,
            );
          }
        }
      });
      return this.check(e.result, `${path}.result`);
    });
    return derivedResult(result.type, combine([...parts, result]));
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
    return checkedResult(combine([cond, thenOut, elseOut]));
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
    return checkedResult(combine(parts));
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
      case "error":
      case "nominal": {
        // A name pattern needs a subject of data and error types only, and the name must be one of them.
        const id = p.kind === "error" ? p.error : p.nominal;
        const ms = members(env, subject);
        const ok = ms.length > 0 &&
          ms.every((m) =>
            m.kind === "named" && (env.errors.has(m.id) || env.data.has(m.id))
          ) &&
          ms.some((m) => m.kind === "named" && m.id === id) &&
          (p.kind === "error" ? env.errors.has(id) : env.data.has(id));
        if (!ok) {
          foreign(
            `the ${p.kind === "error" ? "error" : "nominal record"} ${id}`,
          );
        }
        bind(p.binding, ok ? { kind: "named", id } : undefined);
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
              tagMayEqual(env, field.type, p.value);
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
    return derivedResult(
      NEVER,
      combine([
        err,
        {
          failures,
          requirements: [],
          execution: "effect",
        },
      ]),
    );
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
      const out = this.withLocals((declare) => {
        declare(h.binding, `${at}.binding`);
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
        return this.check(h.body, `${at}.body`);
      });
      outs.push(out);
      this.branchFits(out, e.type, `${at}.body`, h.body.span, AREA.recovery);
    });
    const remaining: Active = {
      failures: minus(body.failures, [...handled]),
      requirements: body.requirements,
      execution: body.execution,
    };
    return checkedResult(combine([remaining, ...outs, EFFECT_ONLY]));
  }

  /**
   * The function type of a retry or provide job. A job with parameters is
   * reported, but its sets still count. A job that is no function is
   * reported, and the caller keeps the recorded annotation of the node.
   */
  jobFunction(
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

  // The argument readers share one rule: a missing argument gives undefined.

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
      return checkedResult(active);
    };
    const l = comparisonClass(env, left.type);
    const r = comparisonClass(env, right.type);
    if (
      (e.operator === "+" || e.operator === "-" || e.operator === "*" ||
        e.operator === "/") &&
      (foreignSealedOf(env, left.type) !== undefined ||
        foreignSealedOf(env, right.type) !== undefined)
    ) {
      this.add(
        AREA.types,
        path,
        "arithmetic cannot use a foreign sealed nominal type",
        e.span,
      );
    }
    // Two values of one numeric brand add and subtract (D32).
    const leftBrand = numericBrandOf(env, left.type);
    const brand = leftBrand !== undefined && same(env, leftBrand, right.type)
      ? leftBrand
      : undefined;
    switch (e.operator) {
      case "&&":
      case "||":
        return isBooleanLike(env, left.type) && isBooleanLike(env, right.type)
          ? derivedResult(BOOLEAN, active)
          : mismatch();
      case "<":
      case "<=":
      case ">":
      case ">=":
        // `isNumeric` widens a brand to its base, so the classes decide.
        return l !== undefined && r !== undefined &&
            compatibleClasses(env, l, r) &&
            isNumericClass(env, l) && isNumericClass(env, r)
          ? derivedResult(BOOLEAN, active)
          : mismatch();
      case "===":
      case "!==": {
        const isNull = (type: Type) => {
          const value = unfold(env, type);
          return value.kind === "literal" && value.value === null;
        };
        const nullable =
          (isNull(left.type) && fits(env, left.type, right.type)) ||
          (isNull(right.type) && fits(env, right.type, left.type));
        return nullable ||
            l !== undefined && r !== undefined && compatibleClasses(env, l, r)
          ? derivedResult(BOOLEAN, active)
          : mismatch();
      }
      case "+":
      case "-":
      case "*":
      case "/": {
        if (
          l === undefined || r === undefined || !compatibleClasses(env, l, r)
        ) return mismatch();
        if (brand !== undefined && (e.operator === "+" || e.operator === "-")) {
          return derivedResult(brand, active);
        }
        // One named operand and one unnamed operand that fits its body keep the name.
        const adopted = e.operator !== "/"
          ? adoptedNumericBrand(env, left.type, right.type)
          : undefined;
        if (adopted !== undefined) return derivedResult(adopted, active);
        if (isNumericClass(env, l) && isNumericClass(env, r)) {
          const integral = e.operator !== "/" && fits(env, left.type, INT) &&
            fits(env, right.type, INT);
          return derivedResult(integral ? INT : NUMBER, active);
        }
        if (
          e.operator === "+" && isStringClass(env, l) && isStringClass(env, r)
        ) {
          return derivedResult(STRING, active);
        }
        return mismatch();
      }
    }
  }
}

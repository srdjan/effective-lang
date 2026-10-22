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
  FunctionType,
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
  dataOnly,
  fieldsOf,
  fits,
  INT,
  isBooleanLike,
  isNumeric,
  isStringLike,
  MAX_DEPTH,
  members,
  NEVER,
  NUMBER,
  numericBrandOf,
  same,
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

type SchemaExpr = Extract<Expr, { kind: "schema" }>;
type SchemaOp = SchemaExpr["op"];
type SchemaType = Extract<Type, { kind: "schema" }>;
type DefaultKeyOp = Extract<
  SchemaOp,
  "default-key" | "default-null-key" | "default-encoded-key"
>;

const DEFAULT_KEY_NAMES: Record<DefaultKeyOp, string> = {
  "default-key": "schemaDefaultKey",
  "default-null-key": "schemaDefaultNullKey",
  "default-encoded-key": "schemaDefaultEncodedKey",
};

/** The Schema operation under validation: the node, its path, and its checked arguments. */
interface SchemaCall {
  readonly e: SchemaExpr;
  readonly path: string;
  readonly args: readonly Out[];
}

/**
 * How a Schema operation passes the self reference of a recursive Schema body.
 * - none: the operation cannot hold the reference.
 * - default: argument 0 holds it, and the later arguments must not.
 * - optional: arguments 0 and 1 hold it, and the callbacks after them must not.
 * - guarding: every argument holds it, and the operation guards the recursion.
 * - passing: every argument holds it, and the guard state passes through.
 */
type SchemaRecursion = "none" | "default" | "optional" | "guarding" | "passing";

interface SchemaRow {
  readonly run: (self: BodyValidator, call: SchemaCall) => Comp;
  /** The input Schema may carry a constructor default. */
  readonly acceptsDefault: boolean;
  readonly recursion: SchemaRecursion;
}

function schemaIssueType(): Type {
  return { kind: "named", id: SCHEMA_ISSUE_ID };
}

/** The function has no failure outside `allowed`, and at most one failure. */
function failsOnly(fn: FunctionType, allowed: readonly string[]): boolean {
  const { failures } = fn.effects;
  return failures.length === 0 ||
    (failures.length === 1 && allowed.includes(failures[0]));
}

function validSchemaCallback(fn: FunctionType | undefined): boolean {
  return fn !== undefined && failsOnly(fn, [SCHEMA_ISSUE_ID]) &&
    (fn.execution !== "pure" ||
      (fn.effects.failures.length === 0 &&
        fn.effects.requirements.length === 0));
}

/** The requirement sets of a Schema made from a source, a target, and two callbacks. */
function directionalRequirements(
  source: SchemaType,
  target: SchemaType,
  decode: FunctionType,
  encode: FunctionType,
): Pick<SchemaType, "decodeRequirements" | "encodeRequirements"> {
  return {
    decodeRequirements: sortedUnique([
      ...source.decodeRequirements,
      ...target.decodeRequirements,
      ...decode.effects.requirements,
    ]),
    encodeRequirements: sortedUnique([
      ...source.encodeRequirements,
      ...target.encodeRequirements,
      ...encode.effects.requirements,
    ]),
  };
}

function inheritedDefault(
  target: SchemaType,
): Pick<SchemaType, "constructorDefault"> {
  return target.constructorDefault === true ? { constructorDefault: true } : {};
}

function inheritedMakeInput(target: SchemaType): Pick<SchemaType, "makeInput"> {
  return target.makeInput === undefined ? {} : { makeInput: target.makeInput };
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
      case "brand":
        return this.brand(e, path);
      case "unbrand":
        return this.unbrand(e, path);
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
        return this.schema(e, path);
      case "schema-make":
      case "schema-decode":
      case "schema-encode":
        return this.schemaOperation(e, path);
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
      return checkedResult(combine([v]));
    }
    if (decl.definition.kind !== "brand") {
      this.add(
        AREA.types,
        `${path}.brand`,
        `${e.brand} is a type alias, not a brand`,
        e.span,
      );
    } else if (decl.opaque === true) {
      this.add(
        AREA.types,
        `${path}.brand`,
        "an opaque type cannot be constructed in source",
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
    return derivedResult({ kind: "named", id: e.brand }, combine([v]));
  }

  private unbrand(e: Extract<Expr, { kind: "unbrand" }>, path: string): Comp {
    const v = this.check(e.value, `${path}.value`);
    const unfolded = unfold(this.env, v.type);
    if (
      unfolded.kind === "named" &&
      this.ctx.world.types.get(unfolded.id)?.opaque === true
    ) {
      this.add(
        AREA.types,
        `${path}.value`,
        "an opaque type cannot be unbranded in source",
        e.value.span,
      );
      return this.poison();
    }
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
      return checkedResult(combine([v]));
    }
    return derivedResult(base, combine([v]));
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

  /**
   * One row for each Schema operation. A new operation is a compile error
   * until it has a row. The columns are the handler, whether `schemaOf`
   * accepts an input with a constructor default, and the role of the
   * operation in a recursive Schema body.
   */
  private static readonly schemaRows: Record<SchemaOp, SchemaRow> = {
    "identity": {
      run: (self, call) => self.schemaIdentity(call),
      acceptsDefault: false,
      recursion: "none",
    },
    "array": {
      run: (self, call) => self.schemaArray(call),
      acceptsDefault: false,
      recursion: "guarding",
    },
    "struct": {
      run: (self, call) => self.schemaStruct(call),
      acceptsDefault: false,
      recursion: "passing",
    },
    "optional-key": {
      run: (self, call) => self.schemaOptionalKey(call),
      acceptsDefault: true,
      recursion: "guarding",
    },
    "null-to-missing-key": {
      run: (self, call) => self.schemaNullToMissingKey(call),
      acceptsDefault: true,
      recursion: "guarding",
    },
    "option-from-optional-key": {
      run: (self, call) => self.schemaOptionFromOptionalKey(call),
      acceptsDefault: true,
      recursion: "none",
    },
    "default-key": {
      run: (self, call) => self.schemaDefaultKey(call, "default-key"),
      acceptsDefault: true,
      recursion: "default",
    },
    "constructor-default": {
      run: (self, call) => self.schemaConstructorDefault(call),
      acceptsDefault: false,
      recursion: "default",
    },
    "default-null-key": {
      run: (self, call) => self.schemaDefaultKey(call, "default-null-key"),
      acceptsDefault: true,
      recursion: "default",
    },
    "default-encoded-key": {
      run: (self, call) => self.schemaDefaultKey(call, "default-encoded-key"),
      acceptsDefault: true,
      recursion: "default",
    },
    "optional-transform": {
      run: (self, call) => self.schemaOptionalTransform(call),
      acceptsDefault: false,
      recursion: "optional",
    },
    "optional-from-required": {
      run: (self, call) => self.schemaOptionalFromRequired(call),
      acceptsDefault: true,
      recursion: "optional",
    },
    "union": {
      run: (self, call) => self.schemaUnion(call),
      acceptsDefault: false,
      recursion: "passing",
    },
    "transform": {
      run: (self, call) => self.schemaTransform(call),
      acceptsDefault: false,
      recursion: "none",
    },
    "recursive": {
      run: (self, call) => self.schemaRecursive(call),
      acceptsDefault: false,
      recursion: "none",
    },
    "invalid": {
      run: (self, call) => self.schemaInvalid(call),
      acceptsDefault: false,
      recursion: "none",
    },
    "at": {
      run: (self, call) => self.schemaAt(call),
      acceptsDefault: false,
      recursion: "none",
    },
    "both": {
      run: (self, call) => self.schemaBoth(call),
      acceptsDefault: false,
      recursion: "none",
    },
  };

  /**
   * The validator reads IR that can be forged, so an operation can lie
   * outside the type. The table is read only for an operation that it names.
   */
  private static isSchemaOp(op: string): op is SchemaOp {
    return Object.hasOwn(BodyValidator.schemaRows, op);
  }

  private schema(e: SchemaExpr, path: string): Comp {
    const call: SchemaCall = {
      e,
      path,
      args: e.arguments.map((arg, i) =>
        this.check(arg, `${path}.arguments[${i}]`)
      ),
    };
    if (!BodyValidator.isSchemaOp(e.op)) {
      return this.schemaBad(call, "unknown schema constructor");
    }
    return BodyValidator.schemaRows[e.op].run(this, call);
  }

  /** The Schema that the operation accepts as input, or undefined. */
  private schemaOf(call: SchemaCall, type: Type): SchemaType | undefined {
    const found = unfold(this.env, type);
    const { e } = call;
    return found.kind === "schema" &&
        (e.op === "constructor-default" || (found.optionalKey !== true &&
          found.encodedOptionalKey !== true &&
          found.decodedOptionalKey !== true)) &&
        (BodyValidator.schemaRows[e.op].acceptsDefault ||
          found.constructorDefault !== true) &&
        (found.makeInput === undefined ||
          same(this.env, found.makeInput, found.decoded) ||
          // "invalid" and "at" return before any Schema is read, so only
          // "identity" is left out of the make-input operations.
          e.op !== "identity")
      ? found
      : undefined;
  }

  // The argument readers share one rule: a missing argument gives undefined.

  /** The accepted input Schema at an argument position. */
  private schemaArg(call: SchemaCall, index: number): SchemaType | undefined {
    const arg = call.args[index];
    return arg === undefined ? undefined : this.schemaOf(call, arg.type);
  }

  /** The optional-key Schema at an argument position. */
  private optionalArg(call: SchemaCall, index: number): SchemaType | undefined {
    const arg = call.args[index];
    if (arg === undefined) return undefined;
    const found = unfold(this.env, arg.type);
    return found.kind === "schema" && found.optionalKey === true &&
        found.encodedOptionalKey !== true &&
        found.decodedOptionalKey !== true
      ? found
      : undefined;
  }

  /** The function type at an argument position. */
  private functionArg(
    call: SchemaCall,
    index: number,
  ): FunctionType | undefined {
    const arg = call.args[index];
    return arg === undefined ? undefined : asFunction(this.env, arg.type);
  }

  /** The unfolded type at an argument position. */
  private typeArg(call: SchemaCall, index: number): Type | undefined {
    const arg = call.args[index];
    return arg === undefined ? undefined : unfold(this.env, arg.type);
  }

  /** Whether the node holds an inline closure at an argument position. */
  private closureArg(call: SchemaCall, index: number): boolean {
    return call.e.arguments[index]?.kind === "closure";
  }

  private schemaBad(call: SchemaCall, message: string): Comp {
    this.add(AREA.types, call.path, message, call.e.span);
    return this.poison();
  }

  private schemaResult(call: SchemaCall, type: Type): Comp {
    return derivedResult(type, combine(call.args));
  }

  private schemaInvalid(call: SchemaCall): Comp {
    const { args } = call;
    if (args.length !== 1 || !fits(this.env, args[0].type, STRING)) {
      return this.schemaBad(call, "schemaInvalid needs a string message");
    }
    return this.schemaResult(call, schemaIssueType());
  }

  private schemaAt(call: SchemaCall): Comp {
    const { args } = call;
    if (
      args.length !== 2 ||
      !fits(this.env, args[0].type, {
        kind: "union",
        members: [
          { kind: "primitive", name: "string" },
          { kind: "primitive", name: "int" },
        ],
      }) || !fits(this.env, args[1].type, schemaIssueType())
    ) return this.schemaBad(call, "schemaAt needs a key and a SchemaIssue");
    return this.schemaResult(call, schemaIssueType());
  }

  private schemaBoth(call: SchemaCall): Comp {
    const { args } = call;
    if (
      args.length !== 3 || this.schemaArg(call, 0) === undefined ||
      !fits(this.env, args[1].type, schemaIssueType()) ||
      !fits(this.env, args[2].type, schemaIssueType())
    ) {
      return this.schemaBad(call, "schemaBoth needs a Schema and two issues");
    }
    return this.schemaResult(call, schemaIssueType());
  }

  private schemaIdentity(call: SchemaCall): Comp {
    const hint = this.schemaOf(call, call.e.type);
    if (
      call.args.length !== 0 || hint === undefined ||
      !same(this.env, hint.decoded, hint.encoded) ||
      hint.decodeRequirements.length || hint.encodeRequirements.length ||
      !dataOnly(this.env, hint.decoded, "value")
    ) {
      return this.schemaBad(
        call,
        "schema() needs an identity data Schema with no services",
      );
    }
    return derivedResult(hint, QUIET);
  }

  private schemaConstructorDefault(call: SchemaCall): Comp {
    const source = this.schemaArg(call, 0);
    const fn = this.functionArg(call, 1);
    if (
      call.args.length !== 2 || source === undefined || fn === undefined ||
      !this.closureArg(call, 1) ||
      fn.parameters.length !== 0 || fn.effects.requirements.length !== 0 ||
      !failsOnly(fn, [SCHEMA_ISSUE_ID]) ||
      (fn.execution === "pure" && fn.effects.failures.length !== 0) ||
      !fits(this.env, fn.result, source.makeInput ?? source.decoded)
    ) {
      return this.schemaBad(
        call,
        "schemaConstructorDefault needs an inline make-input callback with no services and only SchemaIssue failure",
      );
    }
    return this.schemaResult(call, { ...source, constructorDefault: true });
  }

  private schemaArray(call: SchemaCall): Comp {
    const input = this.schemaArg(call, 0);
    if (call.args.length !== 1 || input === undefined) {
      return this.schemaBad(call, "schemaArray needs one Schema");
    }
    return this.schemaResult(call, {
      kind: "schema",
      decoded: { kind: "array", element: input.decoded },
      encoded: { kind: "array", element: input.encoded },
      makeInput: {
        kind: "array",
        element: input.makeInput ?? input.decoded,
      },
      decodeRequirements: input.decodeRequirements,
      encodeRequirements: input.encodeRequirements,
    });
  }

  private schemaNullToMissingKey(call: SchemaCall): Comp {
    const input = this.schemaArg(call, 0);
    const nil: Type = { kind: "literal", value: null };
    if (
      call.args.length !== 1 || input === undefined ||
      fits(this.env, nil, input.decoded) || fits(this.env, nil, input.encoded)
    ) {
      return this.schemaBad(
        call,
        "schemaNullToMissingKey needs one ordinary Schema with nonnullable decoded and encoded types",
      );
    }
    return this.schemaResult(call, {
      ...input,
      encoded: { kind: "union", members: [input.encoded, nil] },
      optionalKey: true,
    });
  }

  private schemaOptionalKey(call: SchemaCall): Comp {
    const input = this.schemaArg(call, 0);
    if (call.args.length !== 1 || input === undefined) {
      return this.schemaBad(
        call,
        "schemaOptionalKey needs one ordinary Schema",
      );
    }
    return this.schemaResult(call, { ...input, optionalKey: true });
  }

  private schemaOptionFromOptionalKey(call: SchemaCall): Comp {
    const input = this.schemaArg(call, 0);
    if (call.args.length !== 1 || input === undefined) {
      return this.schemaBad(
        call,
        "schemaOptionFromOptionalKey needs one ordinary Schema",
      );
    }
    const { constructorDefault: _constructorDefault, ...plain } = input;
    return this.schemaResult(call, {
      ...plain,
      decoded: { kind: "option", element: input.decoded },
      makeInput: { kind: "option", element: input.decoded },
      encodedOptionalKey: true,
    });
  }

  private schemaDefaultKey(call: SchemaCall, op: DefaultKeyOp): Comp {
    const name = DEFAULT_KEY_NAMES[op];
    const direction = op === "default-encoded-key" ? "encoded" : "decoded";
    const nil: Type = { kind: "literal", value: null };
    const input = this.schemaArg(call, 0);
    const fallback = this.functionArg(call, 1);
    const validFailure = fallback !== undefined &&
      failsOnly(fallback, [SCHEMA_ISSUE_ID, SCHEMA_ERROR_ID]);
    const options = call.e.arguments[2];
    if (options !== undefined) {
      const field = options.kind === "record" && options.fields.length === 1
        ? options.fields[0]
        : undefined;
      if (
        field?.name !== "encodingStrategy" ||
        field.value.kind !== "literal" ||
        (field.value.value !== "omit" && field.value.value !== "passthrough")
      ) {
        return this.schemaBad(
          call,
          `${name} options need one literal "omit" or "passthrough" encodingStrategy`,
        );
      }
    }
    if (
      (call.args.length !== 2 && call.args.length !== 3) ||
      input === undefined || fallback === undefined ||
      !this.closureArg(call, 1) ||
      fallback.parameters.length !== 0 ||
      !validFailure ||
      (fallback.execution === "pure" &&
        (fallback.effects.failures.length !== 0 ||
          fallback.effects.requirements.length !== 0)) ||
      !fits(this.env, fallback.result, input[direction])
    ) {
      return this.schemaBad(
        call,
        `${name} needs a callback returning the ${direction} field type with only SchemaIssue or SchemaError failure`,
      );
    }
    if (
      op === "default-null-key" &&
      (fits(this.env, nil, input.decoded) ||
        fits(this.env, nil, input.encoded))
    ) {
      return this.schemaBad(
        call,
        `${name} needs nonnullable decoded and encoded field types`,
      );
    }
    return this.schemaResult(call, {
      ...input,
      encoded: op === "default-null-key"
        ? { kind: "union", members: [input.encoded, nil] }
        : input.encoded,
      encodedOptionalKey: true,
      decodeRequirements: sortedUnique([
        ...input.decodeRequirements,
        ...fallback.effects.requirements,
      ]),
    });
  }

  private schemaStruct(call: SchemaCall): Comp {
    const record = this.typeArg(call, 0);
    if (
      call.args.length !== 1 || record?.kind !== "record" ||
      record.fields.some((field) => field.optional)
    ) return this.schemaBad(call, "schemaStruct needs required Schema fields");
    const fields = record.fields.map((field) => ({
      field,
      schema: unfold(this.env, field.type),
    }));
    if (fields.some((field) => field.schema.kind !== "schema")) {
      return this.schemaBad(
        call,
        "schemaStruct field is not a Schema or optional descriptor",
      );
    }
    return this.schemaResult(call, {
      kind: "schema",
      decoded: {
        kind: "record",
        fields: fields.map(({ field, schema }) => ({
          name: field.name,
          optional: schema.kind === "schema" &&
            (schema.optionalKey === true ||
              schema.decodedOptionalKey === true),
          type: schema.kind === "schema" ? schema.decoded : field.type,
        })),
      },
      encoded: {
        kind: "record",
        fields: fields.map(({ field, schema }) => ({
          name: field.name,
          optional: schema.kind === "schema" &&
            (schema.optionalKey === true ||
              schema.encodedOptionalKey === true),
          type: schema.kind === "schema" ? schema.encoded : field.type,
        })),
      },
      makeInput: {
        kind: "record",
        fields: fields.map(({ field, schema }) => ({
          name: field.name,
          type: schema.kind === "schema"
            ? schema.makeInput ?? schema.decoded
            : field.type,
          optional: schema.kind === "schema" &&
            (schema.optionalKey === true ||
              schema.decodedOptionalKey === true ||
              schema.constructorDefault === true),
        })),
      },
      decodeRequirements: sortedUnique(
        fields.flatMap(({ schema }) =>
          schema.kind === "schema" ? schema.decodeRequirements : []
        ),
      ),
      encodeRequirements: sortedUnique(
        fields.flatMap(({ schema }) =>
          schema.kind === "schema" ? schema.encodeRequirements : []
        ),
      ),
    });
  }

  private schemaUnion(call: SchemaCall): Comp {
    const list = call.e.arguments[0];
    const tuple = this.typeArg(call, 0);
    if (
      call.args.length !== 1 || list?.kind !== "tuple" ||
      tuple?.kind !== "tuple" || tuple.elements.length < 2
    ) {
      return this.schemaBad(
        call,
        "schemaUnion needs an inline tuple of branches",
      );
    }
    const branches = tuple.elements.map((element) =>
      this.schemaOf(call, element)
    );
    if (branches.some((branch) => branch === undefined)) {
      return this.schemaBad(
        call,
        "schemaUnion branches must be ordinary Schema values",
      );
    }
    const schemas = branches.filter((branch) => branch !== undefined);
    return this.schemaResult(call, {
      kind: "schema",
      decoded: { kind: "union", members: schemas.map((s) => s.decoded) },
      encoded: { kind: "union", members: schemas.map((s) => s.encoded) },
      makeInput: {
        kind: "union",
        members: schemas.map((s) => s.makeInput ?? s.decoded),
      },
      decodeRequirements: sortedUnique(
        schemas.flatMap((s) => s.decodeRequirements),
      ),
      encodeRequirements: sortedUnique(
        schemas.flatMap((s) => s.encodeRequirements),
      ),
    });
  }

  private schemaOptionalFromRequired(call: SchemaCall): Comp {
    const source = this.schemaArg(call, 0);
    const target = this.optionalArg(call, 1);
    const decode = this.functionArg(call, 2);
    const encode = this.functionArg(call, 3);
    if (
      call.args.length !== 4 || source === undefined || target === undefined ||
      !validSchemaCallback(decode) || !validSchemaCallback(encode) ||
      decode?.parameters.length !== 1 || encode?.parameters.length !== 1 ||
      !fits(this.env, source.decoded, decode.parameters[0]) ||
      !fits(
        this.env,
        { kind: "option", element: target.encoded },
        encode.parameters[0],
      ) ||
      !fits(this.env, decode.result, {
        kind: "option",
        element: target.encoded,
      }) ||
      !fits(this.env, encode.result, source.decoded) ||
      !this.closureArg(call, 2) ||
      !this.closureArg(call, 3)
    ) {
      return this.schemaBad(
        call,
        "schemaOptionalFromRequired needs required-to-optional callbacks with only SchemaIssue failure",
      );
    }
    return this.schemaResult(call, {
      kind: "schema",
      decoded: target.decoded,
      encoded: source.encoded,
      ...directionalRequirements(source, target, decode, encode),
      decodedOptionalKey: true,
      ...inheritedDefault(target),
      ...inheritedMakeInput(target),
    });
  }

  private schemaOptionalTransform(call: SchemaCall): Comp {
    const source = this.optionalArg(call, 0);
    const target = this.optionalArg(call, 1);
    const decode = this.functionArg(call, 2);
    const encode = this.functionArg(call, 3);
    if (
      call.args.length !== 4 || source === undefined || target === undefined ||
      !validSchemaCallback(decode) || !validSchemaCallback(encode) ||
      decode?.parameters.length !== 1 || encode?.parameters.length !== 1 ||
      !fits(
        this.env,
        { kind: "option", element: source.decoded },
        decode.parameters[0],
      ) ||
      !fits(
        this.env,
        { kind: "option", element: target.encoded },
        encode.parameters[0],
      ) ||
      !fits(this.env, decode.result, {
        kind: "option",
        element: target.encoded,
      }) ||
      !fits(this.env, encode.result, {
        kind: "option",
        element: source.decoded,
      }) ||
      !this.closureArg(call, 2) ||
      !this.closureArg(call, 3)
    ) {
      return this.schemaBad(
        call,
        "schemaOptionalTransform needs directional Option callbacks with only SchemaIssue failure",
      );
    }
    return this.schemaResult(call, {
      kind: "schema",
      decoded: target.decoded,
      encoded: source.encoded,
      ...directionalRequirements(source, target, decode, encode),
      optionalKey: true,
      ...inheritedDefault(target),
      ...inheritedMakeInput(target),
    });
  }

  private schemaRecursive(call: SchemaCall): Comp {
    const hint = this.schemaOf(call, call.e.type);
    const fn = this.functionArg(call, 0);
    if (
      call.args.length !== 1 || hint === undefined || fn === undefined ||
      fn.parameters.length !== 1 ||
      !same(this.env, fn.parameters[0], hint) ||
      !fits(this.env, fn.result, hint) || !isQuiet(invocationOf(fn)) ||
      !dataOnly(this.env, hint.decoded, "value") ||
      !dataOnly(this.env, hint.encoded, "value") ||
      !dataOnly(this.env, hint.makeInput ?? hint.decoded, "value") ||
      !this.guardedSchemaBody(call.e.arguments[0])
    ) {
      return this.schemaBad(
        call,
        "schemaRecursive needs a pure body from self to the expected data Schema",
      );
    }
    return this.schemaResult(call, hint);
  }

  private schemaTransform(call: SchemaCall): Comp {
    const source = this.schemaArg(call, 0);
    const target = this.schemaArg(call, 1);
    const decode = this.functionArg(call, 2);
    const encode = this.functionArg(call, 3);
    const callbackResult = (fn: typeof decode, value: Type) => {
      if (fn === undefined) return false;
      if (fn.effects.failures.length === 0) {
        return fits(this.env, fn.result, {
          kind: "option",
          element: value,
        });
      }
      return fn.effects.failures.length === 1 &&
        fn.effects.failures[0] === SCHEMA_ISSUE_ID &&
        fits(this.env, fn.result, value);
    };
    if (
      call.args.length !== 4 || source === undefined || target === undefined ||
      decode === undefined || encode === undefined ||
      decode.parameters.length !== 1 || encode.parameters.length !== 1 ||
      !fits(this.env, source.decoded, decode.parameters[0]) ||
      !fits(this.env, target.encoded, encode.parameters[0]) ||
      !callbackResult(decode, target.encoded) ||
      !callbackResult(encode, source.decoded) ||
      !this.closureArg(call, 2) ||
      !this.closureArg(call, 3)
    ) {
      return this.schemaBad(
        call,
        "schemaTransform callback types or failure channels do not match",
      );
    }
    return this.schemaResult(call, {
      kind: "schema",
      decoded: target.decoded,
      ...inheritedMakeInput(target),
      encoded: source.encoded,
      ...directionalRequirements(source, target, decode, encode),
    });
  }

  private guardedSchemaBody(callback: Expr | undefined): boolean {
    if (
      callback?.kind !== "closure" || callback.parameters.length !== 1 ||
      callback.body.kind !== "schema" ||
      (callback.body.op !== "struct" && callback.body.op !== "union")
    ) return false;
    const self = callback.parameters[0].id;
    const containsSelf = (value: Expr): boolean =>
      (value.kind === "reference" && value.target === self) ||
      exprChildren(value).some(containsSelf);
    const branches = callback.body.op === "union" &&
        callback.body.arguments[0]?.kind === "tuple"
      ? callback.body.arguments[0].elements
      : undefined;
    const tagMaps = (branches ?? []).map((branch) => {
      const schema = unfold(this.env, branch.type);
      const decoded = schema.kind === "schema"
        ? unfold(this.env, schema.decoded)
        : undefined;
      const encoded = schema.kind === "schema"
        ? unfold(this.env, schema.encoded)
        : undefined;
      const candidates = new Map<string, string>();
      if (decoded?.kind !== "record" || encoded?.kind !== "record") {
        return candidates;
      }
      for (const field of decoded.fields) {
        if (field.optional) continue;
        const other = encoded.fields.find((item) => item.name === field.name);
        if (other === undefined || other.optional) continue;
        const left = unfold(this.env, field.type);
        const right = unfold(this.env, other.type);
        if (
          left.kind === "literal" && right.kind === "literal" &&
          typeof left.value === "string" && left.value === right.value
        ) candidates.set(field.name, left.value);
      }
      return candidates;
    });
    const tagged = tagMaps.length >= 2 &&
      [...tagMaps[0].keys()].some((name) => {
        const values = tagMaps.map((candidate) => candidate.get(name));
        return values.every((value) => value !== undefined) &&
          new Set(values).size === values.length;
      });
    const finiteChoice = branches !== undefined && tagged &&
      branches.some((branch) => !containsSelf(branch));
    let found = false;
    const visit = (value: Expr, guarded: boolean): boolean => {
      if (!containsSelf(value)) return true;
      if (value.kind === "reference") {
        if (value.target !== self) return true;
        found = true;
        return guarded;
      }
      if (value.kind === "record") {
        return value.fields.every((field) => visit(field.value, guarded));
      }
      if (value.kind === "schema") {
        const role = BodyValidator.isSchemaOp(value.op)
          ? BodyValidator.schemaRows[value.op].recursion
          : "none";
        switch (role) {
          case "default":
            return value.arguments.length >= 2 &&
              value.arguments.slice(1).every((argument) =>
                !containsSelf(argument)
              ) &&
              visit(value.arguments[0], guarded);
          case "optional":
            return value.arguments.length === 4 &&
              value.arguments.slice(2).every((argument) =>
                !containsSelf(argument)
              ) &&
              value.arguments.slice(0, 2).every((argument) =>
                visit(argument, guarded)
              );
          case "guarding":
            return value.arguments.every((argument) => visit(argument, true));
          case "passing":
            return value.arguments.every((argument) =>
              visit(argument, guarded)
            );
          case "none":
            return false;
          default: {
            const unreachable: never = role;
            return unreachable;
          }
        }
      }
      if (value.kind === "tuple") {
        return value.elements.every((element) => visit(element, guarded));
      }
      return false;
    };
    return visit(callback.body, finiteChoice) && found;
  }

  private schemaOperation(
    e: Extract<
      Expr,
      { kind: "schema-decode" | "schema-encode" | "schema-make" }
    >,
    path: string,
  ): Comp {
    const schema = this.check(e.schema, `${path}.schema`);
    const input = this.check(e.input, `${path}.input`);
    const type = unfold(this.env, schema.type);
    if (
      type.kind !== "schema" || type.constructorDefault === true ||
      (e.kind === "schema-make" &&
        (type.optionalKey === true || type.encodedOptionalKey === true ||
          type.decodedOptionalKey === true))
    ) {
      this.add(
        AREA.types,
        path,
        "schema runner needs an ordinary Schema value",
        e.span,
      );
      return this.poison();
    }
    if (
      e.kind !== "schema-decode" &&
      !fits(
        this.env,
        input.type,
        e.kind === "schema-make"
          ? type.makeInput ?? type.decoded
          : type.decoded,
      )
    ) {
      this.add(
        AREA.types,
        `${path}.input`,
        `${
          e.kind === "schema-make" ? "schemaMake" : "schemaEncode"
        } input does not fit decoded type`,
        e.input.span,
      );
    }
    return derivedResult(
      e.kind === "schema-encode" ? type.encoded : type.decoded,
      combine([schema, input, {
        execution: "effect",
        failures: [
          e.kind === "schema-make" ? SCHEMA_ISSUE_ID : SCHEMA_ERROR_ID,
        ],
        requirements: e.kind === "schema-make"
          ? []
          : e.kind === "schema-decode"
          ? type.decodeRequirements
          : type.encodeRequirements,
      }]),
    );
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
      return checkedResult(active);
    };
    // Two values of one numeric brand compare, add, and subtract (D32).
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
        return brand !== undefined ||
            isNumeric(env, left.type) && isNumeric(env, right.type)
          ? derivedResult(BOOLEAN, active)
          : mismatch();
      case "===":
      case "!==": {
        const l = comparisonClass(env, left.type);
        const r = comparisonClass(env, right.type);
        const isNull = (type: Type) => {
          const value = unfold(env, type);
          return value.kind === "literal" && value.value === null;
        };
        const nullable =
          (isNull(left.type) && fits(env, left.type, right.type)) ||
          (isNull(right.type) && fits(env, right.type, left.type));
        return nullable || l !== undefined && l === r
          ? derivedResult(BOOLEAN, active)
          : mismatch();
      }
      case "+":
      case "-":
      case "*":
      case "/": {
        if (brand !== undefined && (e.operator === "+" || e.operator === "-")) {
          return derivedResult(brand, active);
        }
        if (isNumeric(env, left.type) && isNumeric(env, right.type)) {
          const integral = e.operator !== "/" && fits(env, left.type, INT) &&
            fits(env, right.type, INT);
          return derivedResult(integral ? INT : NUMBER, active);
        }
        if (
          e.operator === "+" && isStringLike(env, left.type) &&
          isStringLike(env, right.type)
        ) {
          return derivedResult(STRING, active);
        }
        return mismatch();
      }
    }
  }
}

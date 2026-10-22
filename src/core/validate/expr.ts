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
  containerEntries,
  isConcurrencyOption,
  rebuildContainer,
} from "./builtins.ts";

import type {
  CapabilityId,
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
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID, SCOPE_CAPABILITY } from "../ir.ts";
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
  unionEffects,
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
  isUnknown,
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
type Comp =
  | {
    readonly kind: "derived";
    readonly type: Type;
    /** Exact equality, or assignability to the recorded type. */
    readonly match: "exact" | "fit";
    readonly active: Active;
  }
  /** The node checks its own type, or reports why it cannot be recomputed. */
  | { readonly kind: "checked"; readonly active: Active }
  /** Effects cannot be recomputed; the recorded sets stand. */
  | { readonly kind: "poisoned" };

function derivedResult(
  type: Type,
  active: Active,
  match: "exact" | "fit" = "exact",
): Comp {
  return { kind: "derived", type, active, match };
}

function checkedResult(active: Active): Comp {
  return { kind: "checked", active };
}

/** The Stream operators that run a Stream to one value, with the result type. */
type StreamTerminal = Extract<
  Expr,
  {
    kind: "collect-stream" | "head-stream" | "last-stream" | "drain-stream";
  }
>;

const STREAM_TERMINALS: Record<
  StreamTerminal["kind"],
  { readonly name: string; readonly result: (element: Type) => Type }
> = {
  "collect-stream": {
    name: "collectStream",
    result: (element) => ({ kind: "array", element }),
  },
  "head-stream": {
    name: "headStream",
    result: (element) => ({ kind: "option", element }),
  },
  "last-stream": {
    name: "lastStream",
    result: (element) => ({ kind: "option", element }),
  },
  "drain-stream": { name: "drainStream", result: () => UNIT },
};

/** The Stream operators that flatten a Stream of Streams, with the operator name. */
type StreamFlatten = Extract<
  Expr,
  { kind: "flat-map-streams" | "switch-map-streams" }
>;

const STREAM_FLATTENS: Record<StreamFlatten["kind"], string> = {
  "flat-map-streams": "flatMapStreams",
  "switch-map-streams": "switchMapStreams",
};

/** The Stream operators that map the elements, with the callback rule and the message. */
type StreamMap = Extract<Expr, { kind: "map-effect" | "map-stream" }>;

const STREAM_MAPS: Record<
  StreamMap["kind"],
  {
    readonly name: string;
    /** The callback must be pure. Its effects then stay out of the result. */
    readonly pure: boolean;
    readonly needs: string;
  }
> = {
  "map-effect": {
    name: "mapEffect",
    pure: false,
    needs: "mapEffect needs a Stream and an element callback",
  },
  "map-stream": {
    name: "mapStream",
    pure: true,
    needs: "mapStream needs a Stream and a pure element callback",
  },
};

/** The Stream operators that carry a state through a callback of two arguments. */
type StreamAccumulator = Extract<
  Expr,
  {
    kind:
      | "scan-stream"
      | "map-accum-stream"
      | "fold-stream"
      | "fold-effect-stream";
  }
>;

const STREAM_ACCUMULATORS: Record<
  StreamAccumulator["kind"],
  {
    readonly name: string;
    /** The callback must be pure. Its effects then stay out of the result. */
    readonly pure: boolean;
    /** The operator runs the Stream to the final state instead of returning a Stream. */
    readonly terminal: boolean;
    readonly needs: string;
  }
> = {
  "scan-stream": {
    name: "scanStream",
    pure: true,
    terminal: false,
    needs: "scanStream needs a Stream and a pure state update callback",
  },
  "map-accum-stream": {
    name: "mapAccumStream",
    pure: true,
    terminal: false,
    needs:
      "mapAccumStream needs a Stream and a pure callback returning [State, Output[]]",
  },
  "fold-stream": {
    name: "foldStream",
    pure: true,
    terminal: true,
    needs: "foldStream needs a Stream and a pure state update callback",
  },
  "fold-effect-stream": {
    name: "foldEffectStream",
    pure: false,
    terminal: true,
    needs:
      "foldEffectStream needs a Stream and a compatible state update callback",
  },
};

/** The Stream operators that take a pure Int count, with the operator name. */
type StreamCount = Extract<Expr, { kind: "take-stream" | "drop-stream" }>;

const STREAM_COUNTS: Record<StreamCount["kind"], string> = {
  "take-stream": "takeStream",
  "drop-stream": "dropStream",
};

/** The Stream operators that take a pure boolean predicate, with the operator name. */
type PureStreamPredicate = Extract<
  Expr,
  {
    kind:
      | "drop-while-stream"
      | "filter-stream"
      | "take-while-stream"
      | "take-until-stream";
  }
>;

const PURE_STREAM_PREDICATES: Record<PureStreamPredicate["kind"], string> = {
  "drop-while-stream": "dropWhileStream",
  "filter-stream": "filterStream",
  "take-while-stream": "takeWhileStream",
  "take-until-stream": "takeUntilStream",
};

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

/**
 * The nearest child expressions of a node. The switch has no default case, so
 * the compiler rejects a new Expr kind that the switch does not name.
 */
export function exprChildren(e: Expr): readonly Expr[] {
  switch (e.kind) {
    case "take-sink":
    case "make-scope":
    case "null":
    case "literal":
    case "reference":
    case "none":
      return [];
    case "record":
    case "error":
      return e.fields.map((f) => f.value);
    case "array":
    case "tuple":
      return [...e.elements];
    case "get":
      return [e.record];
    case "update":
      return [e.record, ...e.fields.map((f) => f.value)];
    case "brand":
    case "unbrand":
    case "some":
    case "run":
    case "scoped":
      return [e.value];
    case "partition-all":
      return [e.jobs];
    case "validate-all":
      return [e.jobs, e.onErrors];
    case "all-results":
      return [e.jobs];
    case "closure":
      return [e.body];
    case "call":
      return [e.callee, ...e.arguments];
    case "provide-scope":
    case "add-scope-finalizer":
      return [e.owner, e.job];
    case "close-scope":
      return [e.owner];
    case "with-resource":
      return [e.acquire, e.use, e.release];
    case "unfold":
      return [e.seed, e.next];
    case "map-groups":
      return [e.stream, e.key, e.use];
    case "map-effect":
    case "map-stream":
    case "flat-map-streams":
    case "switch-map-streams":
      return [e.stream, e.transform];
    case "catch-stream":
      return [e.stream, e.recover];
    case "retry-stream":
      return [e.stream, e.policy];
    case "debounce-stream":
    case "throttle-stream":
      return [e.stream];
    case "scan-stream":
    case "map-accum-stream":
    case "fold-stream":
    case "fold-effect-stream":
      return [e.stream, e.seed, e.update];
    case "collect-stream":
    case "head-stream":
    case "last-stream":
    case "drain-stream":
      return [e.stream];
    case "take-stream":
      return [e.stream, e.count];
    case "drop-stream":
      return [e.stream, e.count];
    case "drop-while-stream":
      return [e.stream, e.predicate];
    case "filter-stream":
    case "filter-effect-stream":
    case "take-while-effect-stream":
    case "take-until-effect-stream":
    case "drop-while-effect-stream":
      return [e.stream, e.predicate];
    case "take-while-stream":
      return [e.stream, e.predicate];
    case "take-until-stream":
      return [e.stream, e.predicate];
    case "sink-for-each":
      return [e.consume];
    case "transduce-stream":
    case "aggregate-stream":
    case "run-stream":
      return [e.stream, e.sink];
    case "aggregate-within-stream":
      return [e.stream, e.sink, e.schedule];
    case "schedule-from-step":
      return [e.initial, e.decide];
    case "schedule-recurs":
      return [e.times];
    case "schedule-spaced":
      return [e.delayMillis];
    case "schedule-map":
      return [e.schedule, e.transform];
    case "schedule-max":
    case "schedule-min":
    case "schedule-concat":
      return [e.left, e.right];
    case "buffer-stream":
      return [e.stream];
    case "merge-streams":
    case "zip-streams":
    case "concat-streams":
      return [e.left, e.right];
    case "race":
      return [e.left, e.right];
    case "make-ref":
      return [e.value];
    case "get-ref":
      return [e.ref];
    case "set-ref":
      return [e.ref, e.value];
    case "update-ref":
      return [e.ref, e.transform];
    case "layer":
      return [e.acquire];
    case "merge-layers":
      return [e.left, e.right];
    case "retry-schedule":
      return [e.step];
    case "retry-with-schedule":
      return [e.job, e.options];
    case "codec":
      return [e.decode, e.encode];
    case "schema":
      return [...e.arguments];
    case "schema-make":
    case "schema-decode":
    case "schema-encode":
      return [e.schema, e.input];
    case "decode":
    case "encode":
      return [e.codec, e.input];
    case "with-fiber":
      return [e.job, e.use];
    case "join-fiber":
    case "interrupt-fiber":
      return [e.fiber];
    case "defer":
    case "retry":
    case "fork-scoped":
      return [e.job];
    case "perform":
      return [...e.arguments];
    case "block":
      return [...e.steps.map((s) => s.value), e.result];
    case "if":
      return [e.condition, e.then, e.else];
    case "match":
      return [e.subject, ...e.arms.map((a) => a.body)];
    case "fail":
      return [e.error];
    case "catch":
      return [e.body, ...e.handlers.map((h) => h.body)];
    case "provide":
      return [e.provider, e.job];
    case "binary":
      return [e.left, e.right];
  }
}

/**
 * Visits `body` and every expression below it, parents first. The visitor
 * gets the node, its parent, its grandparent, and whether a closure lies
 * between the node and `body`. The closure itself is not nested.
 */
function walkExprs(
  body: Expr,
  visit: (
    e: Expr,
    parent: Expr | undefined,
    grandparent: Expr | undefined,
    nested: boolean,
  ) => void,
): void {
  const go = (
    e: Expr,
    parent: Expr | undefined,
    grandparent: Expr | undefined,
    nested: boolean,
  ): void => {
    visit(e, parent, grandparent, nested);
    for (const child of exprChildren(e)) {
      go(child, e, parent, nested || e.kind === "closure");
    }
  };
  go(body, undefined, undefined, false);
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
        this.borrowedReferences(d.body, parameter.id, `${path}.body`);
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

  private poison(): Comp {
    return { kind: "poisoned" };
  }

  /** Reports a concurrency limit that is neither `unbounded` nor a positive safe integer. */
  private checkConcurrency(
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
        return this.defer(e, path);
      case "run":
        return this.run(e, path);
      case "partition-all":
        return this.partitionAll(e, path);
      case "validate-all":
        return this.validateAll(e, path);
      case "all-results":
        return this.allResults(e, path);
      case "scoped":
        return this.scoped(e, path);
      case "fork-scoped":
        return this.forkScoped(e, path);
      case "make-scope":
        return derivedResult({ kind: "closeable-scope" }, EFFECT_ONLY);
      case "provide-scope":
      case "add-scope-finalizer":
      case "close-scope":
        return this.explicitScope(e, path);
      case "with-resource":
        return this.withResource(e, path);
      case "unfold":
        return this.unfoldStream(e, path);
      case "map-effect":
      case "map-stream":
        return this.mapElements(e, path);
      case "map-groups":
        return this.mapGroups(e, path);
      case "scan-stream":
      case "map-accum-stream":
      case "fold-stream":
      case "fold-effect-stream":
        return this.accumulateStream(e, path);
      case "collect-stream":
      case "head-stream":
      case "last-stream":
      case "drain-stream":
        return this.streamTerminal(e, path);
      case "flat-map-streams":
      case "switch-map-streams":
        return this.mapStreams(e, path);
      case "catch-stream":
        return this.catchStream(e, path);
      case "retry-stream":
        return this.retryStream(e, path);
      case "debounce-stream":
        return this.debounceStream(e, path);
      case "throttle-stream":
        return this.throttleStream(e, path);
      case "take-stream":
      case "drop-stream":
        return this.streamCount(e, path);
      case "drop-while-stream":
      case "filter-stream":
      case "take-while-stream":
      case "take-until-stream":
        return this.pureStreamPredicate(e, path);
      case "filter-effect-stream":
      case "take-while-effect-stream":
      case "take-until-effect-stream":
      case "drop-while-effect-stream":
        return this.effectStreamPredicate(e, path);
      case "sink-for-each":
        return this.sinkForEach(e, path);
      case "take-sink":
        return this.takeSink(e, path);
      case "transduce-stream":
        return this.transduceStream(e, path);
      case "aggregate-stream":
        return this.aggregateStream(e, path);
      case "aggregate-within-stream":
        return this.aggregateWithinStream(e, path);
      case "schedule-from-step":
        return this.scheduleFromStep(e, path);
      case "schedule-recurs":
      case "schedule-spaced":
        return this.simpleSchedule(e, path);
      case "schedule-map":
        return this.scheduleMap(e, path);
      case "schedule-max":
      case "schedule-min":
      case "schedule-concat":
        return this.scheduleCompose(e, path);
      case "run-stream":
        return this.runStream(e, path);
      case "buffer-stream":
        return this.bufferStream(e, path);
      case "merge-streams":
        return this.mergeStreams(e, path);
      case "zip-streams":
        return this.zipStreams(e, path);
      case "concat-streams":
        return this.concatStreams(e, path);
      case "race":
        return this.race(e, path);
      case "make-ref":
      case "get-ref":
      case "set-ref":
      case "update-ref":
        return this.refOperation(e, path);
      case "layer":
        return this.layer(e, path);
      case "merge-layers":
        return this.mergeLayers(e, path);
      case "retry-schedule":
        return this.retrySchedule(e, path);
      case "retry-with-schedule":
        return this.retryWithSchedule(e, path);
      case "codec":
        return this.codec(e, path);
      case "schema":
        return this.schema(e, path);
      case "schema-make":
      case "schema-decode":
      case "schema-encode":
        return this.schemaOperation(e, path);
      case "decode":
      case "encode":
        return this.codecOperation(e, path);
      case "with-fiber":
        return this.withFiber(e, path);
      case "join-fiber":
      case "interrupt-fiber":
        return this.fiberOperation(e, path);
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
    return derivedResult(
      fn.result,
      combine([job, invocationOf(fn), EFFECT_ONLY]),
    );
  }

  private retrySchedule(
    e: Extract<Expr, { kind: "retry-schedule" }>,
    path: string,
  ): Comp {
    const step = this.check(e.step, `${path}.step`);
    const fn = asFunction(this.env, step.type);
    if (fn === undefined || fn.parameters.length !== 2) {
      this.add(
        AREA.control,
        `${path}.step`,
        "retry schedule needs a two-parameter callback",
        e.step.span,
      );
      return this.poison();
    }
    const error = unfold(this.env, fn.parameters[0]);
    if (error.kind !== "named" || !this.env.errors.has(error.id)) {
      this.add(
        AREA.types,
        `${path}.step`,
        "retry schedule needs a nominal error parameter",
        e.step.span,
      );
    }
    if (
      !fits(this.env, INT, fn.parameters[1]) ||
      !fits(this.env, fn.result, { kind: "option", element: INT })
    ) {
      this.add(
        AREA.types,
        `${path}.step`,
        "retry schedule needs an Int attempt and Option<Int> result",
        e.step.span,
      );
    }
    if (!isQuiet(invocationOf(fn))) {
      this.add(
        AREA.control,
        `${path}.step`,
        "retry schedule callback must be pure",
        e.step.span,
      );
    }
    return derivedResult(
      { kind: "retry-schedule", error: fn.parameters[0] },
      combine([step]),
    );
  }

  private retryWithSchedule(
    e: Extract<Expr, { kind: "retry-with-schedule" }>,
    path: string,
  ): Comp {
    const job = this.check(e.job, `${path}.job`);
    const options = this.check(e.options, `${path}.options`);
    const fn = this.jobFunction(job, `${path}.job`, e.job.span, "retry");
    const shape = unfold(this.env, options.type);
    const fields = shape.kind === "record" ? shape.fields : [];
    const policy = fields.length === 1 && fields[0].name === "schedule" &&
        !fields[0].optional
      ? unfold(this.env, fields[0].type)
      : undefined;
    if (policy?.kind !== "retry-schedule") {
      this.add(
        AREA.control,
        `${path}.options`,
        "retry needs a schedule option",
        e.options.span,
      );
    } else if (fn !== undefined) {
      for (const failure of fn.effects.failures) {
        if (!fits(this.env, { kind: "named", id: failure }, policy.error)) {
          this.add(
            AREA.types,
            `${path}.options`,
            `retry schedule does not accept ${failure}`,
            e.options.span,
          );
        }
      }
    }
    if (fn === undefined) return this.poison();
    return derivedResult(
      fn.result,
      combine([job, options, invocationOf(fn), EFFECT_ONLY]),
    );
  }

  private codec(e: Extract<Expr, { kind: "codec" }>, path: string): Comp {
    const decode = this.check(e.decode, `${path}.decode`);
    const encode = this.check(e.encode, `${path}.encode`);
    const d = asFunction(this.env, decode.type);
    const en = asFunction(this.env, encode.type);
    if (
      d === undefined || en === undefined || d.parameters.length !== 1 ||
      en.parameters.length !== 1
    ) {
      this.add(
        AREA.types,
        path,
        "codec needs two single-argument functions",
        e.span,
      );
      return this.poison();
    }
    if (!isQuiet(invocationOf(d)) || !isQuiet(invocationOf(en))) {
      this.add(
        AREA.control,
        path,
        "codec transformations must be pure",
        e.span,
      );
    }
    if (
      !fits(this.env, d.result, en.parameters[0]) ||
      !fits(this.env, en.result, d.parameters[0])
    ) {
      this.add(
        AREA.types,
        path,
        "codec encode transformation must reverse decode types",
        e.span,
      );
    }
    if (
      !dataOnly(this.env, d.result, "codec") ||
      !dataOnly(this.env, d.parameters[0], "codec")
    ) {
      this.add(
        AREA.types,
        path,
        "codec types need compiler-derived schemas",
        e.span,
      );
    }
    return derivedResult(
      { kind: "codec", decoded: d.result, encoded: d.parameters[0] },
      combine([decode, encode]),
      "fit",
    );
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

  private codecOperation(
    e: Extract<Expr, { kind: "decode" | "encode" }>,
    path: string,
  ): Comp {
    const codec = this.check(e.codec, `${path}.codec`);
    const input = this.check(e.input, `${path}.input`);
    const type = unfold(this.env, codec.type);
    if (type.kind !== "codec") {
      this.add(
        AREA.types,
        `${path}.codec`,
        `${e.kind} needs a Codec value`,
        e.codec.span,
      );
      return this.poison();
    }
    if (e.kind === "encode" && !fits(this.env, input.type, type.decoded)) {
      this.add(
        AREA.types,
        `${path}.input`,
        "encode input does not fit decoded type",
        e.input.span,
      );
    }
    return derivedResult({
      kind: "option",
      element: e.kind === "decode" ? type.decoded : type.encoded,
    }, combine([codec, input]));
  }

  private withFiber(
    e: Extract<Expr, { kind: "with-fiber" }>,
    path: string,
  ): Comp {
    const job = this.check(e.job, `${path}.job`);
    const use = this.check(e.use, `${path}.use`);
    const effect = unfold(this.env, job.type);
    const fn = asFunction(this.env, use.type);
    if (
      effect.kind !== "effect" || e.use.kind !== "closure" ||
      fn === undefined || fn.parameters.length !== 1 ||
      e.use.parameters[0]?.id !== e.useBinding
    ) {
      this.add(
        AREA.control,
        path,
        "with-fiber needs an Effect and one inline use callback",
        e.span,
      );
      return this.poison();
    }
    const fiber: Type = {
      kind: "fiber",
      result: effect.result,
      failures: effect.effects.failures,
    };
    if (!same(this.env, fn.parameters[0], fiber)) {
      this.add(
        AREA.types,
        `${path}.use`,
        "fiber use parameter does not match child type",
        e.use.span,
      );
    }
    if (!dataOnly(this.env, fn.result, "value")) {
      this.add(
        AREA.types,
        `${path}.use`,
        "fiber use result must be data only",
        e.use.span,
      );
    }
    this.fiberReferences(e.use.body, e.useBinding, `${path}.use.body`);
    return derivedResult(
      fn.result,
      combine([
        job,
        use,
        {
          failures: [],
          requirements: effect.effects.requirements,
          execution: "effect",
        },
        invocationOf(fn),
        EFFECT_ONLY,
      ]),
    );
  }

  private fiberOperation(
    e: Extract<Expr, { kind: "join-fiber" | "interrupt-fiber" }>,
    path: string,
  ): Comp {
    const fiber = this.check(e.fiber, `${path}.fiber`);
    const type = unfold(this.env, fiber.type);
    if (type.kind !== "fiber") {
      this.add(
        AREA.types,
        `${path}.fiber`,
        "fiber operation needs a Fiber value",
        e.fiber.span,
      );
      return this.poison();
    }
    return derivedResult(
      e.kind === "join-fiber" ? type.result : UNIT,
      combine([
        fiber,
        e.kind === "join-fiber"
          ? { failures: type.failures, requirements: [], execution: "effect" }
          : EFFECT_ONLY,
      ]),
    );
  }

  private fiberReferences(body: Expr, id: string, path: string): void {
    walkExprs(body, (expr, parent, _grandparent, nested) => {
      if (expr.kind === "reference" && expr.target === id) {
        if (
          nested ||
          (parent?.kind !== "join-fiber" &&
            parent?.kind !== "interrupt-fiber") ||
          parent.fiber !== expr
        ) {
          this.add(
            AREA.control,
            path,
            "borrowed fiber may only be joined or interrupted directly",
            expr.span,
          );
        }
      }
    });
  }

  private defer(e: Extract<Expr, { kind: "defer" }>, path: string): Comp {
    const job = this.check(e.job, `${path}.job`);
    const fn = this.jobFunction(job, `${path}.job`, e.job.span, "defer");
    if (fn === undefined) return this.poison();
    return derivedResult({
      kind: "effect",
      result: fn.result,
      effects: fn.effects,
    }, combine([job]));
  }

  private run(e: Extract<Expr, { kind: "run" }>, path: string): Comp {
    const value = this.check(e.value, `${path}.value`);
    const type = unfold(this.env, value.type);
    if (type.kind !== "effect") {
      this.add(
        AREA.control,
        `${path}.value`,
        `run needs an Effect value, but the expression has type ${
          show(value.type)
        }`,
        e.value.span,
      );
      return this.poison();
    }
    return derivedResult(
      type.result,
      combine([
        value,
        {
          failures: type.effects.failures,
          requirements: type.effects.requirements,
          execution: "effect",
        },
      ]),
    );
  }

  private partitionAll(
    e: Extract<Expr, { kind: "partition-all" }>,
    path: string,
  ): Comp {
    const jobs = this.check(e.jobs, `${path}.jobs`);
    const array = unfold(this.env, jobs.type);
    const job = array.kind === "array"
      ? unfold(this.env, array.element)
      : undefined;
    if (job?.kind !== "effect") {
      this.add(
        AREA.types,
        path,
        "partitionAll needs an array of Effect values",
        e.span,
      );
      return this.poison();
    }
    this.checkConcurrency(e, path, "partitionAll");
    const errors = unionOf(
      this.env,
      job.effects.failures.map((id) => ({ kind: "named", id })),
    );
    return derivedResult(
      {
        kind: "tuple",
        elements: [
          { kind: "array", element: job.result },
          { kind: "array", element: errors },
        ],
      },
      combine([jobs, {
        failures: [],
        requirements: job.effects.requirements,
        execution: "effect",
      }]),
    );
  }

  private validateAll(
    e: Extract<Expr, { kind: "validate-all" }>,
    path: string,
  ): Comp {
    const jobs = this.check(e.jobs, `${path}.jobs`);
    const onErrors = this.check(e.onErrors, `${path}.onErrors`);
    const array = unfold(this.env, jobs.type);
    const job = array.kind === "array"
      ? unfold(this.env, array.element)
      : undefined;
    const wrapper = asFunction(this.env, onErrors.type);
    const errors = job?.kind === "effect"
      ? unionOf(
        this.env,
        job.effects.failures.map((id) => ({ kind: "named", id })),
      )
      : undefined;
    const failure = wrapper === undefined
      ? undefined
      : unfold(this.env, wrapper.result);
    if (
      job?.kind !== "effect" || wrapper === undefined ||
      errors === undefined || wrapper.parameters.length !== 1 ||
      !fits(
        this.env,
        { kind: "array", element: errors },
        wrapper.parameters[0],
      ) ||
      !isQuiet(invocationOf(wrapper)) || failure?.kind !== "named" ||
      !this.env.errors.has(failure.id)
    ) {
      this.add(
        AREA.types,
        path,
        "validateAll needs Effect jobs and a pure error-array wrapper returning a nominal error",
        e.span,
      );
      return this.poison();
    }
    this.checkConcurrency(e, path, "validateAll");
    return derivedResult(
      { kind: "array", element: job.result },
      combine([jobs, onErrors, {
        failures: [failure.id as ErrorId],
        requirements: job.effects.requirements,
        execution: "effect",
      }]),
    );
  }

  private allResults(
    e: Extract<Expr, { kind: "all-results" }>,
    path: string,
  ): Comp {
    const jobs = this.check(e.jobs, `${path}.jobs`);
    const shape = unfold(this.env, jobs.type);
    const container = containerEntries(shape);
    if (
      container === undefined ||
      (shape.kind === "record" && shape.fields.some((field) => field.optional))
    ) {
      this.add(
        AREA.types,
        path,
        "allResults needs a tuple, record, or array of Effect values with required fields",
        e.span,
      );
      return this.poison();
    }
    const outcomes: Type[] = [];
    const requirements: CapabilityId[] = [];
    for (const type of container.entries) {
      const member = unfold(this.env, type);
      if (member.kind !== "effect") {
        this.add(
          AREA.types,
          path,
          "allResults requires an Effect value at every position",
          e.span,
        );
        return this.poison();
      }
      const error = unionOf(
        this.env,
        member.effects.failures.map((id) => ({ kind: "named", id })),
      );
      outcomes.push(unionOf(this.env, [
        {
          kind: "record",
          fields: [
            {
              name: "_tag",
              type: { kind: "literal", value: "Success" },
              optional: false,
            },
            { name: "success", type: member.result, optional: false },
          ],
        },
        {
          kind: "record",
          fields: [
            {
              name: "_tag",
              type: { kind: "literal", value: "Failure" },
              optional: false,
            },
            { name: "failure", type: error, optional: false },
          ],
        },
      ]));
      requirements.push(...member.effects.requirements);
    }
    this.checkConcurrency(e, path, "allResults");
    const result = rebuildContainer(container, outcomes);
    return derivedResult(
      result,
      combine([jobs, {
        failures: [],
        requirements,
        execution: "effect",
      }]),
    );
  }

  private scoped(e: Extract<Expr, { kind: "scoped" }>, path: string): Comp {
    const value = this.check(e.value, `${path}.value`);
    const effect = unfold(this.env, value.type);
    if (effect.kind !== "effect") {
      this.add(AREA.control, path, "scoped needs an Effect value", e.span);
      return this.poison();
    }
    return derivedResult(
      effect.result,
      combine([value, {
        failures: effect.effects.failures,
        requirements: minus(effect.effects.requirements, [SCOPE_CAPABILITY]),
        execution: "effect",
      }]),
    );
  }

  private forkScoped(
    e: Extract<Expr, { kind: "fork-scoped" }>,
    path: string,
  ): Comp {
    const job = this.check(e.job, `${path}.job`);
    const effect = unfold(this.env, job.type);
    if (effect.kind !== "effect") {
      this.add(AREA.control, path, "forkScoped needs an Effect value", e.span);
      return this.poison();
    }
    if (effect.effects.failures.length > 0) {
      this.add(
        AREA.control,
        path,
        "forkScoped needs an Effect value without typed failures",
        e.span,
      );
    }
    return derivedResult(
      UNIT,
      combine([job, {
        failures: [],
        requirements: [...effect.effects.requirements, SCOPE_CAPABILITY],
        execution: "effect",
      }]),
    );
  }

  private explicitScope(
    e: Extract<
      Expr,
      { kind: "provide-scope" | "add-scope-finalizer" | "close-scope" }
    >,
    path: string,
  ): Comp {
    const owner = this.check(e.owner, `${path}.owner`);
    if (!fits(this.env, owner.type, { kind: "closeable-scope" })) {
      this.add(
        AREA.control,
        path,
        `${e.kind} needs a CloseableScope owner`,
        e.span,
      );
    }
    if (e.kind === "close-scope") {
      return derivedResult(UNIT, combine([owner, EFFECT_ONLY]));
    }
    const job = this.check(e.job, `${path}.job`);
    const effect = unfold(this.env, job.type);
    if (effect.kind !== "effect") {
      this.add(AREA.control, path, `${e.kind} needs an Effect value`, e.span);
      return this.poison();
    }
    if (
      e.kind === "add-scope-finalizer" && (
        !fits(this.env, effect.result, UNIT) ||
        effect.effects.failures.length > 0 ||
        effect.effects.requirements.includes(SCOPE_CAPABILITY)
      )
    ) {
      this.add(
        AREA.control,
        path,
        "a scope finalizer must return void without typed failures or the reserved Scope requirement",
        e.span,
      );
    }
    return derivedResult(
      e.kind === "provide-scope" ? effect.result : UNIT,
      combine([owner, job, {
        failures: e.kind === "provide-scope" ? effect.effects.failures : [],
        requirements: e.kind === "provide-scope"
          ? minus(effect.effects.requirements, [SCOPE_CAPABILITY])
          : effect.effects.requirements,
        execution: "effect",
      }]),
    );
  }

  private checkOperationRecord(type: Type, path: string, span: Span): void {
    const value = unfold(this.env, type);
    if (
      value.kind !== "record" || value.fields.length === 0 ||
      value.fields.some((f) => f.optional)
    ) {
      this.add(
        AREA.types,
        path,
        "acquisition must return a nonempty record of required operations",
        span,
      );
      return;
    }
    for (const field of value.fields) {
      const fn = asFunction(this.env, field.type);
      if (
        fn === undefined || !fn.parameters.every((p) =>
          dataOnly(this.env, p, "value")
        ) ||
        !dataOnly(this.env, fn.result, "value")
      ) {
        this.add(
          AREA.types,
          `${path}.${field.name}`,
          "an operation must take and return data-only values",
          span,
        );
      }
    }
  }

  private scopedReferences(body: Expr, id: string, path: string): void {
    walkExprs(body, (e, parent, grandparent, nested) => {
      if (e.kind === "reference" && e.target === id) {
        if (
          nested || parent?.kind !== "get" || parent.record !== e ||
          grandparent?.kind !== "call" || grandparent.callee !== parent
        ) {
          this.add(
            AREA.control,
            path,
            "a scoped operation record may only be the direct receiver of an operation call",
            e.span,
          );
        }
      }
    });
  }

  private withResource(
    e: Extract<Expr, { kind: "with-resource" }>,
    path: string,
  ): Comp {
    const acquire = this.check(e.acquire, `${path}.acquire`);
    const use = this.check(e.use, `${path}.use`);
    const release = this.check(e.release, `${path}.release`);
    const a = asFunction(this.env, acquire.type);
    const u = asFunction(this.env, use.type);
    const r = asFunction(this.env, release.type);
    if (
      e.acquire.kind !== "closure" || e.use.kind !== "closure" ||
      e.release.kind !== "closure" || a === undefined || u === undefined ||
      r === undefined
    ) {
      this.add(
        AREA.control,
        path,
        "with-resource requires three inline closures",
        e.span,
      );
      return this.poison();
    }
    if (
      a.parameters.length !== 0 || u.parameters.length !== 1 ||
      r.parameters.length !== 1 ||
      e.use.parameters[0]?.id !== e.useBinding ||
      e.release.parameters[0]?.id !== e.releaseBinding
    ) {
      this.add(
        AREA.control,
        path,
        "with-resource callback arity or scoped identity is invalid",
        e.span,
      );
      return this.poison();
    }
    const acquired = unfold(this.env, a.result);
    const opaque = acquired.kind === "named" &&
      this.ctx.world.types.get(acquired.id)?.opaque === true;
    if (!opaque) {
      this.checkOperationRecord(
        a.result,
        `${path}.acquire.type.result`,
        e.acquire.span,
      );
    }
    if (
      !same(this.env, a.result, u.parameters[0]) ||
      !same(this.env, a.result, r.parameters[0])
    ) {
      this.add(
        AREA.types,
        path,
        "use and release must accept the acquired operation record",
        e.span,
      );
    }
    if (!fits(this.env, r.result, UNIT)) {
      this.add(
        AREA.types,
        `${path}.release.type.result`,
        "release must return void",
        e.release.span,
      );
    }
    if (!dataOnly(this.env, u.result, "value")) {
      this.add(
        AREA.types,
        `${path}.use.type.result`,
        "use must return data only",
        e.use.span,
      );
    }
    if (opaque) {
      this.borrowedReferences(e.use.body, e.useBinding, `${path}.use.body`);
      this.borrowedReferences(
        e.release.body,
        e.releaseBinding,
        `${path}.release.body`,
      );
    } else {
      this.scopedReferences(e.use.body, e.useBinding, `${path}.use.body`);
      this.scopedReferences(
        e.release.body,
        e.releaseBinding,
        `${path}.release.body`,
      );
    }
    return derivedResult(
      u.result,
      combine([
        acquire,
        use,
        release,
        invocationOf(a),
        invocationOf(u),
        invocationOf(r),
        EFFECT_ONLY,
      ]),
    );
  }

  private borrowedReferences(body: Expr, id: string, path: string): void {
    walkExprs(body, (expr, parent, _grandparent, nested) => {
      if (expr.kind === "reference" && expr.target === id) {
        const index = parent?.kind === "perform" || parent?.kind === "call"
          ? parent.arguments.indexOf(expr)
          : -1;
        const method = parent?.kind === "perform"
          ? this.ctx.world.methods.get(parent.capability)
          : undefined;
        const functionType =
          parent?.kind === "call" && parent.callee.kind === "reference"
            ? this.ctx.world.values.get(parent.callee.target)
            : undefined;
        const borrowed = method?.borrows?.[index] === true ||
          (functionType?.kind === "function" &&
            functionType.borrows?.[index] === true);
        if (nested || index < 0 || !borrowed) {
          this.add(
            AREA.control,
            path,
            "borrowed handle may only pass to a borrow-qualified method",
            expr.span,
          );
        }
      }
    });
  }

  private streamState(type: Type): Type {
    const value = unfold(this.env, type);
    if (value.kind !== "literal" || value.value === null) return type;
    return typeof value.value === "string"
      ? STRING
      : typeof value.value === "boolean"
      ? BOOLEAN
      : Number.isSafeInteger(value.value)
      ? INT
      : NUMBER;
  }

  private unfoldStream(
    e: Extract<Expr, { kind: "unfold" }>,
    path: string,
  ): Comp {
    const seed = this.check(e.seed, `${path}.seed`);
    const next = this.check(e.next, `${path}.next`);
    const fn = asFunction(this.env, next.type);
    if (e.next.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.next`,
        "unfold requires an inline closure",
        e.next.span,
      );
    }
    const state = this.streamState(seed.type);
    if (
      fn === undefined || fn.parameters.length !== 1 ||
      !fits(this.env, state, fn.parameters[0])
    ) {
      this.add(
        AREA.types,
        `${path}.next`,
        "unfold needs a callback accepting the state",
        e.next.span,
      );
      return this.poison();
    }
    const option = unfold(this.env, fn.result);
    const pair = option.kind === "option"
      ? unfold(this.env, option.element)
      : undefined;
    if (
      pair?.kind !== "tuple" || pair.elements.length !== 2 ||
      !fits(this.env, pair.elements[1], state)
    ) {
      this.add(
        AREA.types,
        `${path}.next`,
        "unfold callback must return Option<[Element, State]>",
        e.next.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: pair.elements[0],
      effects: fn.effects,
    }, combine([seed, next]));
  }

  private mapElements(e: StreamMap, path: string): Comp {
    const row = STREAM_MAPS[e.kind];
    if (e.kind === "map-effect") this.checkConcurrency(e, path, row.name);
    const stream = this.check(e.stream, `${path}.stream`);
    const transform = this.check(e.transform, `${path}.transform`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, transform.type);
    if (e.transform.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.transform`,
        `${row.name} requires an inline closure`,
        e.transform.span,
      );
    }
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 1 ||
      !fits(this.env, source.element, fn.parameters[0]) ||
      (row.pure && !isQuiet(invocationOf(fn)))
    ) {
      this.add(AREA.types, path, row.needs, e.span);
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: fn.result,
      effects: row.pure
        ? source.effects
        : { ...unionEffects(source.effects, fn.effects) },
    }, combine([stream, transform]));
  }

  private accumulateStream(e: StreamAccumulator, path: string): Comp {
    const row = STREAM_ACCUMULATORS[e.kind];
    const stream = this.check(e.stream, `${path}.stream`);
    const seed = this.check(e.seed, `${path}.seed`);
    const update = this.check(e.update, `${path}.update`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, update.type);
    if (e.update.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.update`,
        `${row.name} requires an inline closure`,
        e.update.span,
      );
    }
    // mapAccumStream returns [State, Output[]]. The others return the State.
    const pair = e.kind === "map-accum-stream" && fn !== undefined
      ? unfold(this.env, fn.result)
      : undefined;
    const elements = pair?.kind === "tuple" && pair.elements.length === 2
      ? pair.elements
      : undefined;
    const output = elements === undefined
      ? undefined
      : unfold(this.env, elements[1]);
    const state = e.kind === "map-accum-stream" ? elements?.[0] : fn?.result;
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 2 ||
      !fits(this.env, seed.type, fn.parameters[0]) ||
      !fits(this.env, source.element, fn.parameters[1]) ||
      state === undefined || !fits(this.env, state, seed.type) ||
      (e.kind === "map-accum-stream" && output?.kind !== "array") ||
      (row.pure && !isQuiet(invocationOf(fn)))
    ) {
      this.add(AREA.types, path, row.needs, e.span);
      return this.poison();
    }
    if (!isQuiet(seed)) {
      this.add(
        AREA.execution,
        `${path}.seed`,
        `${row.name} seed must be pure`,
        e.seed.span,
      );
    }
    if (row.terminal) {
      return derivedResult(
        seed.type,
        combine([stream, seed, update, {
          ...(row.pure
            ? source.effects
            : unionEffects(source.effects, fn.effects)),
          execution: "effect",
        }]),
      );
    }
    return derivedResult({
      kind: "stream",
      element: output?.kind === "array" ? output.element : seed.type,
      effects: source.effects,
    }, combine([stream, seed, update]));
  }

  private streamTerminal(e: StreamTerminal, path: string): Comp {
    const row = STREAM_TERMINALS[e.kind];
    const stream = this.check(e.stream, `${path}.stream`);
    const source = unfold(this.env, stream.type);
    if (source.kind !== "stream") {
      this.add(
        AREA.types,
        path,
        `${row.name} needs a Stream value`,
        e.span,
      );
      return this.poison();
    }
    return derivedResult(
      row.result(source.element),
      combine([stream, {
        failures: source.effects.failures,
        requirements: source.effects.requirements,
        execution: "effect",
      }]),
    );
  }

  private mapStreams(e: StreamFlatten, path: string): Comp {
    const name = STREAM_FLATTENS[e.kind];
    if (e.kind === "flat-map-streams") this.checkConcurrency(e, path, name);
    const stream = this.check(e.stream, `${path}.stream`);
    const transform = this.check(e.transform, `${path}.transform`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, transform.type);
    if (e.transform.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.transform`,
        `${name} requires an inline closure`,
        e.transform.span,
      );
    }
    const inner = fn === undefined ? undefined : unfold(this.env, fn.result);
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 1 ||
      !fits(this.env, source.element, fn.parameters[0]) ||
      !isQuiet(invocationOf(fn)) || inner?.kind !== "stream"
    ) {
      this.add(
        AREA.types,
        path,
        `${name} needs a Stream and a pure callback returning a Stream`,
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: inner.element,
      effects: {
        ...unionEffects(source.effects, inner.effects),
      },
    }, combine([stream, transform]));
  }

  private catchStream(
    e: Extract<Expr, { kind: "catch-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const recover = this.check(e.recover, `${path}.recover`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, recover.type);
    if (e.recover.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.recover`,
        "catchStream requires an inline closure",
        e.recover.span,
      );
    }
    const replacement = fn === undefined
      ? undefined
      : unfold(this.env, fn.result);
    const errors = source.kind === "stream"
      ? unionOf(
        this.env,
        source.effects.failures.map((id) => ({ kind: "named", id })),
      )
      : NEVER;
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 1 ||
      !fits(this.env, errors, fn.parameters[0]) ||
      !isQuiet(invocationOf(fn)) || replacement?.kind !== "stream"
    ) {
      this.add(
        AREA.types,
        path,
        "catchStream needs a Stream and a pure error callback returning a Stream",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: unionOf(this.env, [source.element, replacement.element]),
      effects: {
        failures: replacement.effects.failures,
        requirements: sortedUnique([
          ...source.effects.requirements,
          ...replacement.effects.requirements,
        ]),
      },
    }, combine([stream, recover]));
  }

  private retryStream(
    e: Extract<Expr, { kind: "retry-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const policy = this.check(e.policy, `${path}.policy`);
    const source = unfold(this.env, stream.type);
    const schedule = unfold(this.env, policy.type);
    if (source.kind !== "stream" || schedule.kind !== "retry-schedule") {
      this.add(
        AREA.types,
        path,
        "retryStream needs a Stream and a RetrySchedule",
        e.span,
      );
      return this.poison();
    }
    for (const failure of source.effects.failures) {
      if (!fits(this.env, { kind: "named", id: failure }, schedule.error)) {
        this.add(
          AREA.types,
          `${path}.policy`,
          `retry schedule does not accept ${failure}`,
          e.policy.span,
        );
      }
    }
    if (!isQuiet(policy)) {
      this.add(
        AREA.execution,
        `${path}.policy`,
        "retryStream policy must be pure",
        e.policy.span,
      );
    }
    return derivedResult(source, combine([stream, policy]));
  }

  private debounceStream(
    e: Extract<Expr, { kind: "debounce-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const source = unfold(this.env, stream.type);
    if (source.kind !== "stream") {
      this.add(AREA.types, path, "debounceStream needs a Stream", e.span);
      return this.poison();
    }
    if (!Number.isSafeInteger(e.delayMs) || e.delayMs < 0) {
      this.add(
        AREA.control,
        `${path}.delayMs`,
        "debounceStream delay must be a nonnegative safe integer",
        e.span,
      );
    }
    return derivedResult(source, combine([stream]));
  }

  private throttleStream(
    e: Extract<Expr, { kind: "throttle-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const source = unfold(this.env, stream.type);
    if (source.kind !== "stream") {
      this.add(AREA.types, path, "throttleStream needs a Stream", e.span);
      return this.poison();
    }
    if (
      !Number.isSafeInteger(e.units) || e.units <= 0 ||
      !Number.isSafeInteger(e.durationMs) || e.durationMs <= 0 ||
      (e.strategy !== "shape" && e.strategy !== "enforce")
    ) {
      this.add(
        AREA.control,
        path,
        "throttleStream needs positive units and duration and a known strategy",
        e.span,
      );
    }
    return derivedResult(source, combine([stream]));
  }

  private streamCount(e: StreamCount, path: string): Comp {
    const name = STREAM_COUNTS[e.kind];
    const stream = this.check(e.stream, `${path}.stream`);
    const count = this.check(e.count, `${path}.count`);
    const source = unfold(this.env, stream.type);
    if (source.kind !== "stream" || !fits(this.env, count.type, INT)) {
      this.add(
        AREA.types,
        path,
        `${name} needs a Stream value and an Int count`,
        e.span,
      );
      return this.poison();
    }
    if (!isQuiet(count)) {
      this.add(
        AREA.execution,
        `${path}.count`,
        `${name} count must be pure`,
        e.count.span,
      );
    }
    return derivedResult(source, combine([stream, count]));
  }

  private pureStreamPredicate(e: PureStreamPredicate, path: string): Comp {
    const name = PURE_STREAM_PREDICATES[e.kind];
    const stream = this.check(e.stream, `${path}.stream`);
    const predicate = this.check(e.predicate, `${path}.predicate`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, predicate.type);
    if (e.predicate.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.predicate`,
        `${name} requires an inline closure`,
        e.predicate.span,
      );
    }
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 1 ||
      !fits(this.env, source.element, fn.parameters[0]) ||
      !fits(this.env, fn.result, BOOLEAN) ||
      !isQuiet(invocationOf(fn))
    ) {
      this.add(
        AREA.types,
        path,
        `${name} needs a Stream and a pure boolean predicate`,
        e.span,
      );
      return this.poison();
    }
    return derivedResult(source, combine([stream, predicate]));
  }

  private effectStreamPredicate(
    e: Extract<
      Expr,
      {
        kind:
          | "filter-effect-stream"
          | "take-while-effect-stream"
          | "take-until-effect-stream"
          | "drop-while-effect-stream";
      }
    >,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const predicate = this.check(e.predicate, `${path}.predicate`);
    const source = unfold(this.env, stream.type);
    const fn = asFunction(this.env, predicate.type);
    if (e.predicate.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.predicate`,
        "effectful stream predicate requires an inline closure",
        e.predicate.span,
      );
    }
    if (
      source.kind !== "stream" || fn === undefined ||
      fn.parameters.length !== 1 ||
      !fits(this.env, source.element, fn.parameters[0]) ||
      !fits(this.env, fn.result, BOOLEAN)
    ) {
      this.add(
        AREA.types,
        path,
        "effectful stream predicate needs a Stream and a boolean callback",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: source.element,
      effects: {
        ...unionEffects(source.effects, fn.effects),
      },
    }, combine([stream, predicate]));
  }

  private sinkForEach(
    e: Extract<Expr, { kind: "sink-for-each" }>,
    path: string,
  ): Comp {
    const consume = this.check(e.consume, `${path}.consume`);
    const fn = asFunction(this.env, consume.type);
    if (e.consume.kind !== "closure") {
      this.add(
        AREA.control,
        `${path}.consume`,
        "sinkForEach requires an inline closure",
        e.consume.span,
      );
    }
    if (
      fn === undefined || fn.parameters.length !== 1 ||
      !fits(this.env, fn.result, UNIT)
    ) {
      this.add(
        AREA.types,
        path,
        "sinkForEach needs a one-argument void callback",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "sink",
      input: fn.parameters[0],
      result: UNIT,
      effects: fn.effects,
    }, combine([consume]));
  }

  private takeSink(
    e: Extract<Expr, { kind: "take-sink" }>,
    path: string,
  ): Comp {
    if (!Number.isSafeInteger(e.count) || e.count <= 0) {
      this.add(
        AREA.control,
        path,
        "takeSink needs a positive safe integer count",
        e.span,
      );
    }
    const sink = unfold(this.env, e.type);
    if (sink.kind !== "sink") {
      this.add(AREA.types, path, "takeSink needs a Sink annotation", e.span);
      return this.poison();
    }
    return derivedResult({
      kind: "sink",
      input: sink.input,
      result: { kind: "array", element: sink.input },
      leftover: sink.input,
      effects: { failures: [], requirements: [] },
    }, QUIET);
  }

  private mapGroups(
    e: Extract<Expr, { kind: "map-groups" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const key = this.check(e.key, `${path}.key`);
    const use = this.check(e.use, `${path}.use`);
    const source = unfold(this.env, stream.type);
    const classifier = asFunction(this.env, key.type);
    const consumer = asFunction(this.env, use.type);
    if (
      source.kind !== "stream" || e.key.kind !== "closure" ||
      e.use.kind !== "closure" ||
      classifier === undefined || consumer === undefined ||
      classifier.parameters.length !== 1 || consumer.parameters.length !== 2 ||
      e.use.parameters[1]?.id !== e.groupBinding ||
      e.use.parameters[0]?.id === e.groupBinding
    ) {
      this.add(
        AREA.control,
        path,
        "mapGroups needs a Stream and inline key/use callbacks with the declared group binding",
        e.span,
      );
      return this.poison();
    }
    if (!Number.isSafeInteger(e.bufferSize) || e.bufferSize <= 0) {
      this.add(
        AREA.control,
        path,
        "mapGroups needs a positive safe integer buffer size",
        e.span,
      );
    }
    const group: Type = {
      kind: "stream",
      element: source.element,
      effects: { failures: [], requirements: [] },
    };
    if (
      !fits(this.env, source.element, classifier.parameters[0]) ||
      !fits(this.env, classifier.result, consumer.parameters[0]) ||
      !same(this.env, group, consumer.parameters[1]) ||
      this.groupKeyClass(classifier.result) === undefined ||
      !dataOnly(this.env, consumer.result, "value")
    ) {
      this.add(
        AREA.types,
        path,
        "mapGroups needs a primitive key class, matching borrowed input, and data-only result",
        e.span,
      );
    }
    if (!isQuiet(invocationOf(classifier))) {
      this.add(
        AREA.control,
        path,
        "the group classifier must be pure",
        e.key.span,
      );
    }
    this.groupReferences(e.use.body, e.groupBinding, `${path}.use.body`);
    return derivedResult({
      kind: "stream",
      element: consumer.result,
      effects: {
        ...unionEffects(source.effects, {
          failures: consumer.effects.failures,
          requirements: minus(consumer.effects.requirements, [
            SCOPE_CAPABILITY,
          ]),
        }),
      },
    }, combine([stream, key, use]));
  }

  private groupKeyClass(type: Type, depth = 0): string | undefined {
    if (depth > 128) return undefined;
    let found: string | undefined;
    for (const member of members(this.env, type)) {
      let current: string | undefined;
      if (member.kind === "literal") {
        if (member.value === null) return undefined;
        current = typeof member.value === "number"
          ? Number.isSafeInteger(member.value) ? "int" : undefined
          : typeof member.value;
      } else if (member.kind === "primitive") {
        if (
          member.name === "int" || member.name === "string" ||
          member.name === "boolean"
        ) current = member.name;
      } else if (member.kind === "named") {
        const base = this.env.brands.get(member.id);
        if (
          base !== undefined &&
          this.groupKeyClass(base, depth + 1) !== undefined
        ) current = `brand:${member.id}`;
      }
      if (current === undefined || (found !== undefined && found !== current)) {
        return undefined;
      }
      found = current;
    }
    return found;
  }

  private groupReferences(body: Expr, id: string, path: string): void {
    let references = 0;
    walkExprs(body, (expr, parent, _grandparent, nested) => {
      if (expr.kind === "reference" && expr.target === id) {
        references++;
        const terminal = parent?.kind === "collect-stream" ||
          parent?.kind === "run-stream" ||
          parent?.kind === "fold-stream" ||
          parent?.kind === "fold-effect-stream" ||
          parent?.kind === "head-stream" || parent?.kind === "last-stream" ||
          parent?.kind === "drain-stream";
        if (nested || references > 1 || !terminal || parent.stream !== expr) {
          this.add(
            AREA.control,
            path,
            "a borrowed group permits at most one direct terminal use and cannot escape or be captured",
            expr.span,
          );
        }
      }
    });
  }

  private transduceStream(
    e: Extract<Expr, { kind: "transduce-stream" }>,
    path: string,
  ): Comp {
    return this.sinkTransformStream(e, path, "transduceStream");
  }

  private aggregateStream(
    e: Extract<Expr, { kind: "aggregate-stream" }>,
    path: string,
  ): Comp {
    return this.sinkTransformStream(e, path, "aggregateStream");
  }

  private scheduleInput(input: Type): Extract<Type, { kind: "record" }> {
    return {
      kind: "record",
      fields: [
        { name: "input", type: input, optional: false },
        { name: "attempt", type: INT, optional: false },
        ...["start", "now", "elapsed", "elapsedSincePrevious"].map((name) => ({
          name,
          type: NUMBER,
          optional: false,
        })),
      ],
    };
  }

  private scheduleDecision(state: Type, output: Type): Type {
    return {
      kind: "union",
      members: [
        {
          kind: "record",
          fields: [
            {
              name: "kind",
              type: { kind: "literal", value: "Continue" },
              optional: false,
            },
            { name: "state", type: state, optional: false },
            { name: "output", type: output, optional: false },
            { name: "delayMillis", type: NUMBER, optional: false },
          ],
        },
        {
          kind: "record",
          fields: [
            {
              name: "kind",
              type: { kind: "literal", value: "Done" },
              optional: false,
            },
            { name: "output", type: output, optional: false },
          ],
        },
      ],
    };
  }

  private simpleSchedule(
    e: Extract<Expr, { kind: "schedule-recurs" | "schedule-spaced" }>,
    path: string,
  ): Comp {
    const argument = e.kind === "schedule-recurs" ? e.times : e.delayMillis;
    const value = this.check(argument, `${path}.argument`);
    if (
      !fits(this.env, value.type, e.kind === "schedule-recurs" ? INT : NUMBER)
    ) {
      this.add(AREA.types, path, "invalid schedule argument", argument.span);
    }
    return derivedResult({
      kind: "schedule",
      output: INT,
      input: { kind: "primitive", name: "unknown" },
      effects: { failures: [], requirements: [] },
    }, combine([value]));
  }

  private scheduleFromStep(
    e: Extract<Expr, { kind: "schedule-from-step" }>,
    path: string,
  ): Comp {
    const initial = this.check(e.initial, `${path}.initial`);
    const decide = this.check(e.decide, `${path}.decide`);
    const factory = asFunction(this.env, initial.type);
    const step = asFunction(this.env, decide.type);
    if (
      e.initial.kind !== "closure" || e.decide.kind !== "closure" ||
      factory === undefined || factory.parameters.length !== 0 ||
      step === undefined || step.parameters.length !== 2
    ) {
      this.add(
        AREA.types,
        path,
        "scheduleFromStep needs inline state and decision callbacks",
        e.span,
      );
      return this.poison();
    }
    const input = fieldsOf(this.env, step.parameters[1])?.find((field) =>
      field.name === "input"
    )?.type;
    const outputs = members(this.env, step.result).map((member) =>
      fieldsOf(this.env, member)?.find((field) => field.name === "output")?.type
    ).filter((type): type is Type => type !== undefined);
    const output = unionOf(this.env, outputs);
    if (
      input === undefined || outputs.length === 0 ||
      !fits(this.env, factory.result, step.parameters[0]) ||
      !fits(this.env, this.scheduleInput(input), step.parameters[1]) ||
      !fits(
        this.env,
        step.result,
        this.scheduleDecision(factory.result, output),
      )
    ) {
      this.add(
        AREA.types,
        path,
        "scheduleFromStep needs ScheduleInput and ScheduleDecision<State, Output>",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "schedule",
      output,
      input,
      effects: {
        ...unionEffects(factory.effects, step.effects),
      },
    }, combine([initial, decide]));
  }

  private scheduleMap(
    e: Extract<Expr, { kind: "schedule-map" }>,
    path: string,
  ): Comp {
    const schedule = this.check(e.schedule, `${path}.schedule`);
    const transform = this.check(e.transform, `${path}.transform`);
    const policy = unfold(this.env, schedule.type);
    const fn = asFunction(this.env, transform.type);
    if (
      e.transform.kind !== "closure" || policy.kind !== "schedule" ||
      fn === undefined || fn.parameters.length !== 1
    ) {
      this.add(
        AREA.types,
        path,
        "scheduleMap needs a Schedule and inline callback",
        e.span,
      );
      return this.poison();
    }
    const base = this.scheduleInput(policy.input);
    const metadata: Type = {
      kind: "record",
      fields: [
        ...base.fields,
        { name: "output", type: policy.output, optional: false },
        { name: "durationMillis", type: NUMBER, optional: false },
      ],
    };
    if (!fits(this.env, metadata, fn.parameters[0])) {
      this.add(
        AREA.types,
        path,
        "scheduleMap callback needs ScheduleMetadata<Output, Input>",
        e.span,
      );
    }
    return derivedResult({
      kind: "schedule",
      output: fn.result,
      input: policy.input,
      effects: {
        ...unionEffects(policy.effects, fn.effects),
      },
    }, combine([schedule, transform]));
  }

  private scheduleCompose(
    e: Extract<
      Expr,
      { kind: "schedule-max" | "schedule-min" | "schedule-concat" }
    >,
    path: string,
  ): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const first = unfold(this.env, left.type);
    const second = unfold(this.env, right.type);
    if (first.kind !== "schedule" || second.kind !== "schedule") {
      this.add(
        AREA.types,
        path,
        "schedule composition needs two Schedules",
        e.span,
      );
      return this.poison();
    }
    const accepts = (input: Type, offered: Type): boolean =>
      isUnknown(this.env, input) || fits(this.env, offered, input);
    const input = accepts(second.input, first.input)
      ? first.input
      : accepts(first.input, second.input)
      ? second.input
      : undefined;
    if (input === undefined) {
      this.add(
        AREA.types,
        path,
        "schedule composition needs comparable input types",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "schedule",
      output: e.kind === "schedule-concat"
        ? unionOf(this.env, [first.output, second.output])
        : NUMBER,
      input,
      effects: {
        ...unionEffects(first.effects, second.effects),
      },
    }, combine([left, right]));
  }

  private aggregateWithinStream(
    e: Extract<Expr, { kind: "aggregate-within-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const sink = this.check(e.sink, `${path}.sink`);
    const schedule = this.check(e.schedule, `${path}.schedule`);
    const source = unfold(this.env, stream.type);
    const consumer = unfold(this.env, sink.type);
    const policy = unfold(this.env, schedule.type);
    const unknownInput = policy.kind === "schedule" &&
      isUnknown(this.env, policy.input);
    if (
      source.kind !== "stream" || consumer.kind !== "sink" ||
      policy.kind !== "schedule" ||
      !fits(this.env, source.element, consumer.input) ||
      !fits(this.env, consumer.leftover ?? NEVER, consumer.input) ||
      !(unknownInput ||
        fits(
          this.env,
          { kind: "option", element: consumer.result },
          policy.input,
        ))
    ) {
      this.add(
        AREA.types,
        path,
        "aggregateWithinStream needs compatible Stream, Sink, and Schedule inputs",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: consumer.result,
      effects: {
        ...unionEffects(source.effects, consumer.effects, policy.effects),
      },
    }, combine([stream, sink, schedule]));
  }

  private sinkTransformStream(
    e: Extract<Expr, { kind: "transduce-stream" | "aggregate-stream" }>,
    path: string,
    name: "transduceStream" | "aggregateStream",
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const sink = this.check(e.sink, `${path}.sink`);
    const source = unfold(this.env, stream.type);
    const consumer = unfold(this.env, sink.type);
    if (
      source.kind !== "stream" || consumer.kind !== "sink" ||
      !fits(this.env, source.element, consumer.input) ||
      !fits(this.env, consumer.leftover ?? NEVER, consumer.input)
    ) {
      this.add(
        AREA.types,
        path,
        `${name} needs compatible input and replayable Sink leftovers`,
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: consumer.result,
      effects: {
        ...unionEffects(source.effects, consumer.effects),
      },
    }, combine([stream, sink]));
  }

  private runStream(
    e: Extract<Expr, { kind: "run-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const sink = this.check(e.sink, `${path}.sink`);
    const source = unfold(this.env, stream.type);
    const consumer = unfold(this.env, sink.type);
    if (
      source.kind !== "stream" || consumer.kind !== "sink" ||
      !fits(this.env, source.element, consumer.input)
    ) {
      this.add(
        AREA.types,
        path,
        "runStream needs compatible Stream and Sink values",
        e.span,
      );
      return this.poison();
    }
    return derivedResult(
      consumer.result,
      combine([stream, sink, {
        ...unionEffects(source.effects, consumer.effects),
        execution: "effect",
      }]),
    );
  }

  private bufferStream(
    e: Extract<Expr, { kind: "buffer-stream" }>,
    path: string,
  ): Comp {
    const stream = this.check(e.stream, `${path}.stream`);
    const source = unfold(this.env, stream.type);
    if (source.kind !== "stream") {
      this.add(AREA.types, path, "bufferStream needs a Stream value", e.span);
      return this.poison();
    }
    if (!Number.isSafeInteger(e.capacity) || e.capacity <= 0) {
      this.add(
        AREA.control,
        path,
        "bufferStream capacity must be a positive safe integer",
        e.span,
      );
    }
    return derivedResult(source, combine([stream]));
  }

  private mergeStreams(
    e: Extract<Expr, { kind: "merge-streams" }>,
    path: string,
  ): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const a = unfold(this.env, left.type);
    const b = unfold(this.env, right.type);
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.add(
        AREA.types,
        path,
        "mergeStreams needs two Stream values",
        e.span,
      );
      return this.poison();
    }
    const aFitsB = fits(this.env, a.element, b.element);
    const bFitsA = fits(this.env, b.element, a.element);
    if (!aFitsB && !bFitsA) {
      this.add(
        AREA.types,
        path,
        "mergeStreams needs compatible element types",
        e.span,
      );
    }
    return derivedResult({
      kind: "stream",
      element: aFitsB ? b.element : a.element,
      effects: {
        ...unionEffects(a.effects, b.effects),
      },
    }, combine([left, right]));
  }

  private zipStreams(
    e: Extract<Expr, { kind: "zip-streams" }>,
    path: string,
  ): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const a = unfold(this.env, left.type);
    const b = unfold(this.env, right.type);
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.add(AREA.types, path, "zipStreams needs two Stream values", e.span);
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: { kind: "tuple", elements: [a.element, b.element] },
      effects: {
        ...unionEffects(a.effects, b.effects),
      },
    }, combine([left, right]));
  }

  private concatStreams(
    e: Extract<Expr, { kind: "concat-streams" }>,
    path: string,
  ): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const a = unfold(this.env, left.type);
    const b = unfold(this.env, right.type);
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.add(
        AREA.types,
        path,
        "concatStreams needs two Stream values",
        e.span,
      );
      return this.poison();
    }
    return derivedResult({
      kind: "stream",
      element: unionOf(this.env, [a.element, b.element]),
      effects: {
        ...unionEffects(a.effects, b.effects),
      },
    }, combine([left, right]));
  }

  private race(e: Extract<Expr, { kind: "race" }>, path: string): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const a = unfold(this.env, left.type);
    const b = unfold(this.env, right.type);
    if (a.kind !== "effect" || b.kind !== "effect") {
      this.add(AREA.types, path, "race needs two Effect values", e.span);
      return this.poison();
    }
    const aFitsB = fits(this.env, a.result, b.result);
    const bFitsA = fits(this.env, b.result, a.result);
    if (!aFitsB && !bFitsA) {
      this.add(AREA.types, path, "race needs compatible success types", e.span);
    }
    return derivedResult({
      kind: "effect",
      result: aFitsB ? b.result : a.result,
      effects: {
        ...unionEffects(a.effects, b.effects),
      },
    }, combine([left, right]));
  }

  private refOperation(
    e: Extract<
      Expr,
      { kind: "make-ref" | "get-ref" | "set-ref" | "update-ref" }
    >,
    path: string,
  ): Comp {
    if (e.kind === "make-ref") {
      const value = this.check(e.value, `${path}.value`);
      return derivedResult({
        kind: "ref",
        element: this.streamState(value.type),
      }, combine([value, EFFECT_ONLY]));
    }
    const ref = this.check(e.ref, `${path}.ref`);
    const type = unfold(this.env, ref.type);
    if (type.kind !== "ref") {
      this.add(AREA.types, path, `${e.kind} needs a Ref value`, e.span);
      return this.poison();
    }
    if (e.kind === "get-ref") {
      return derivedResult(type.element, combine([ref, EFFECT_ONLY]));
    }
    if (e.kind === "set-ref") {
      const value = this.check(e.value, `${path}.value`);
      if (!fits(this.env, value.type, type.element)) {
        this.add(
          AREA.types,
          `${path}.value`,
          "the new value must fit the Ref element",
          e.value.span,
        );
      }
      return derivedResult(UNIT, combine([ref, value, EFFECT_ONLY]));
    }
    const transform = this.check(e.transform, `${path}.transform`);
    const fn = asFunction(this.env, transform.type);
    if (
      fn === undefined || fn.parameters.length !== 1 ||
      !isQuiet(invocationOf(fn)) ||
      !fits(this.env, type.element, fn.parameters[0]) ||
      !fits(this.env, fn.result, type.element)
    ) {
      this.add(
        AREA.execution,
        `${path}.transform`,
        "updateRef needs a pure element-to-element callback",
        e.transform.span,
      );
    }
    return derivedResult(UNIT, combine([ref, transform, EFFECT_ONLY]));
  }

  private layer(e: Extract<Expr, { kind: "layer" }>, path: string): Comp {
    const acquire = this.check(e.acquire, `${path}.acquire`);
    const service = this.ctx.world.services.get(e.service);
    const fn = asFunction(this.env, acquire.type);
    if (
      service === undefined || fn === undefined || fn.parameters.length !== 0 ||
      e.acquire.kind !== "closure"
    ) {
      this.add(
        AREA.control,
        path,
        "layer needs a declared service and inline zero-argument callback",
        e.span,
      );
      return this.poison();
    }
    const implementation = unfold(this.env, fn.result);
    if (
      implementation.kind !== "record" ||
      implementation.fields.length !== service.methods.length
    ) {
      this.add(
        AREA.types,
        `${path}.acquire`,
        "layer must return exactly the service methods",
        e.acquire.span,
      );
      return this.poison();
    }
    for (const method of service.methods) {
      const field = implementation.fields.find((f) => f.name === method.name);
      if (
        field === undefined || field.optional ||
        !fits(this.env, field.type, method.type)
      ) {
        this.add(
          AREA.types,
          `${path}.acquire`,
          `layer method ${method.name} does not fit its service contract`,
          e.acquire.span,
        );
      }
    }
    const provides = service.methods.map((m) => m.id).sort();
    if (fn.effects.requirements.some((r) => provides.includes(r))) {
      this.add(
        AREA.control,
        path,
        "layer acquisition requires a method it provides",
        e.span,
      );
    }
    return derivedResult({
      kind: "provider",
      provides,
      acquisition: { execution: "effect", effects: fn.effects },
    }, combine([acquire]));
  }

  private mergeLayers(
    e: Extract<Expr, { kind: "merge-layers" }>,
    path: string,
  ): Comp {
    const left = this.check(e.left, `${path}.left`);
    const right = this.check(e.right, `${path}.right`);
    const a = unfold(this.env, left.type);
    const b = unfold(this.env, right.type);
    if (a.kind !== "provider" || b.kind !== "provider") {
      this.add(AREA.types, path, "mergeLayers needs two Layer values", e.span);
      return this.poison();
    }
    const services = new Set(
      a.provides.map((id) => id.slice(0, id.lastIndexOf("."))),
    );
    if (
      b.provides.some((id) => services.has(id.slice(0, id.lastIndexOf("."))))
    ) {
      this.add(
        AREA.control,
        path,
        "mergeLayers cannot provide one service twice",
        e.span,
      );
    }
    return derivedResult({
      kind: "provider",
      provides: sortedUnique([...a.provides, ...b.provides]),
      acquisition: {
        execution: "effect",
        effects: {
          ...unionEffects(a.acquisition.effects, b.acquisition.effects),
        },
      },
    }, combine([left, right]));
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
    return derivedResult(
      fn.result,
      combine([
        combine([provider, job]),
        invocation,
        acquisition,
        EFFECT_ONLY,
      ]),
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

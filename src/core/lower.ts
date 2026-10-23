// Lowering of a checked module to typed IR (plan part A4, design 6.1 and 6.3).
//
// The lowering reads the syntax tree and the side tables that body checking
// built. It never infers a type or an effect set itself. A pipeline stage whose
// left value moved into a fresh binding takes its set from `stageSets`.
//
// The IR exists only for a module whose diagnostics are empty. A module in a
// `.effi` file lowers to its declarations, without its providers. Expected
// failures are error values. A violated internal invariant throws inside the
// lowering and the entry point turns it into an `internal` error value.

import {
  arrowBody,
  type BinaryOperator,
  initOf,
  isTypeKind,
  kidsOf,
  literalOf,
  nameTextOf,
  operatorOf,
} from "./syntax_queries.ts";
import { signatureType } from "./check.ts";
import type {
  CheckedModule,
  CheckedProject,
  ConstantBody,
  FunctionBody,
} from "./check_project.ts";
import type {
  Annotation,
  Arm,
  Declaration,
  DeclarationId,
  Effects,
  Expr,
  FunctionType,
  Handler,
  Import,
  LocalId,
  ModuleIR,
  Parameter,
  Pattern,
  Result,
  ServiceDecl,
  ServiceId,
  Span,
  Step,
  Type,
  ValueId,
} from "./ir.ts";
import { TokenKind } from "./lex.ts";
import type { ModuleInfo } from "./project.ts";
import type { ModuleResolution, Target } from "./resolve.ts";
import { sha256Hex } from "./sha256.ts";
import { compareText } from "./util.ts";
import {
  kindOf,
  type NodeId,
  nodeSpan,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";
import {
  type BodyTable,
  combine,
  type EffectSet,
  isQuiet,
  type NodeFact,
  type NodeInfo,
} from "./tables.ts";
import {
  canonicalJson,
  sortedUnique,
  type TypeNode,
  type TypeRef,
  type TypeTable,
} from "./types.ts";
import { builtinInstanceId } from "./ids.ts";

type FunctionNode = Extract<TypeNode, { readonly kind: "function" }>;

// ------------------------------------------------------------------ errors

export type LowerError =
  /** The module name is not part of the checked project. */
  | { readonly tag: "unknown-module"; readonly module: string }
  /** The module has diagnostics, so it has no IR. */
  | {
    readonly tag: "diagnostics";
    readonly module: string;
    readonly count: number;
  }
  /** The interface of an imported module is missing. */
  | {
    readonly tag: "no-interface";
    readonly module: string;
    readonly imported: string;
  }
  /** A form that the IR cannot express. */
  | {
    readonly tag: "unsupported";
    readonly module: string;
    readonly message: string;
    readonly span: Span;
  }
  /** A violated invariant between the checker tables and the tree. */
  | {
    readonly tag: "internal";
    readonly module: string;
    readonly message: string;
  };

type Failure =
  | {
    readonly tag: "unsupported";
    readonly message: string;
    readonly span: Span;
  }
  | { readonly tag: "internal"; readonly message: string };

/** Thrown inside the lowering only. `lowerModule` turns it into a `LowerError`. */
class LowerFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

function internal(message: string): LowerFailure {
  return new LowerFailure({ tag: "internal", message });
}

function unsupported(message: string, span: Span): LowerFailure {
  return new LowerFailure({ tag: "unsupported", message, span });
}

// ------------------------------------------------------------------ context

/** A specialized builtin instance of one module. */
interface BuiltinInstance {
  readonly name: string;
  readonly type: FunctionType;
}

/** What the lowering of every body of one module shares. */
interface ModuleContext {
  readonly module: string;
  readonly tree: SyntaxTree;
  readonly types: TypeTable;
  readonly targets: ReadonlyMap<NodeId, Target>;
  /** Local and imported services by identity. */
  readonly services: ReadonlyMap<ServiceId, ServiceDecl>;
  /** Specialized builtins in the order of first use. */
  readonly builtins: Map<ValueId, BuiltinInstance>;
  /** The identifier texts of the module, which a generated `$p<n>` name skips. */
  readonly identifiers: ReadonlySet<string>;
}

const EMPTY_EFFECTS: Effects = { failures: [], requirements: [] };

/** Every identifier text of a module. */
function identifiersOf(tree: SyntaxTree): ReadonlySet<string> {
  const lexed = tree.lexed;
  const names = new Set<string>();
  for (let t = 0; t < lexed.count; t++) {
    if (lexed.kinds[t] === TokenKind.Ident) {
      names.add(lexed.text.slice(lexed.starts[t], lexed.ends[t]));
    }
  }
  return names;
}

function setOf(expr: Expr): EffectSet {
  return {
    failures: expr.effects.failures,
    requirements: expr.effects.requirements,
    mode: expr.execution,
  };
}

const PATTERN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.WildcardPattern,
  SyntaxKind.LiteralPattern,
  SyntaxKind.NamePattern,
  SyntaxKind.CtorPattern,
  SyntaxKind.RecordPattern,
]);

// ------------------------------------------------------------------ call facts

type FactKind = NodeFact["kind"];

/** The argument reader of `invoke`: argument `i`, or an internal error. */
type ArgumentAt = (i: number) => Expr;

/**
 * The fact kinds that `invoke` lowers in its own cases: a fact field with
 * logic, a callee, a closure check, or no call at all.
 */
type SpecialKind =
  | "call"
  | "perform"
  | "builtin"
  | "error-construction"
  | "brand-construction"
  | "data-construction"
  | "retry"
  | "schema"
  | "with-fiber"
  | "with-resource"
  | "map-groups"
  | "debounce-stream"
  | "throttle-stream"
  | "take-sink"
  | "buffer-stream"
  | "layer"
  | "none"
  | "list"
  | "field"
  | "arrow"
  | "binding"
  | "pattern"
  | "handler";

/** The fact kinds whose node moves positional arguments into named fields. */
type PositionalKind = Exclude<FactKind, SpecialKind>;

/** The fact members that have a kind in `K`. */
type FactOf<K extends FactKind> = NodeFact extends infer F
  ? F extends { readonly kind: infer FK }
    ? [Extract<K, FK>] extends [never] ? never
    : F
  : never
  : never;

/** The node members that have a kind in `K`, without their annotation. */
type BodyOf<K extends PositionalKind> = Expr extends infer E
  ? E extends { readonly kind: infer EK }
    ? [Extract<K, EK>] extends [never] ? never
    : Omit<E, keyof Annotation>
  : never
  : never;

/**
 * One builder for each positional kind. A kind without a row, and a row for a
 * kind that `invoke` handles itself, fail to compile. A row that builds the
 * wrong fields for its kind fails too.
 */
type PositionalBuilders = {
  readonly [K in PositionalKind]: (
    arg: ArgumentAt,
    fact: FactOf<K>,
  ) => BodyOf<K>;
};

const POSITIONAL_BUILDERS: PositionalBuilders = {
  "unbrand": (arg) => ({ kind: "unbrand", value: arg(0) }),
  "some": (arg) => ({ kind: "some", value: arg(0) }),
  "fail": (arg) => ({ kind: "fail", error: arg(0) }),
  "retry-schedule": (arg) => ({ kind: "retry-schedule", step: arg(0) }),
  "retry-with-schedule": (arg) => ({
    kind: "retry-with-schedule",
    job: arg(0),
    options: arg(1),
  }),
  "codec": (arg) => ({ kind: "codec", decode: arg(0), encode: arg(1) }),
  "decode": (arg) => ({ kind: "decode", codec: arg(0), input: arg(1) }),
  "encode": (arg) => ({ kind: "encode", codec: arg(0), input: arg(1) }),
  "join-fiber": (arg) => ({ kind: "join-fiber", fiber: arg(0) }),
  "interrupt-fiber": (arg) => ({ kind: "interrupt-fiber", fiber: arg(0) }),
  "provide": (arg) => ({ kind: "provide", provider: arg(0), job: arg(1) }),
  "defer": (arg) => ({ kind: "defer", job: arg(0) }),
  "run": (arg) => ({ kind: "run", value: arg(0) }),
  "scoped": (arg) => ({ kind: "scoped", value: arg(0) }),
  "fork-scoped": (arg) => ({ kind: "fork-scoped", job: arg(0) }),
  "make-scope": () => ({ kind: "make-scope" }),
  "provide-scope": (arg) => ({
    kind: "provide-scope",
    owner: arg(0),
    job: arg(1),
  }),
  "add-scope-finalizer": (arg) => ({
    kind: "add-scope-finalizer",
    owner: arg(0),
    job: arg(1),
  }),
  "close-scope": (arg) => ({ kind: "close-scope", owner: arg(0) }),
  "unfold": (arg) => ({ kind: "unfold", seed: arg(0), next: arg(1) }),
  "map-effect": (arg, fact) => ({
    kind: "map-effect",
    stream: arg(0),
    transform: arg(1),
    concurrency: fact.concurrency,
  }),
  "map-stream": (arg) => ({
    kind: "map-stream",
    stream: arg(0),
    transform: arg(1),
  }),
  "scan-stream": (arg) => ({
    kind: "scan-stream",
    stream: arg(0),
    seed: arg(1),
    update: arg(2),
  }),
  "map-accum-stream": (arg) => ({
    kind: "map-accum-stream",
    stream: arg(0),
    seed: arg(1),
    update: arg(2),
  }),
  "fold-stream": (arg) => ({
    kind: "fold-stream",
    stream: arg(0),
    seed: arg(1),
    update: arg(2),
  }),
  "fold-effect-stream": (arg) => ({
    kind: "fold-effect-stream",
    stream: arg(0),
    seed: arg(1),
    update: arg(2),
  }),
  "collect-stream": (arg) => ({ kind: "collect-stream", stream: arg(0) }),
  "head-stream": (arg) => ({ kind: "head-stream", stream: arg(0) }),
  "last-stream": (arg) => ({ kind: "last-stream", stream: arg(0) }),
  "drain-stream": (arg) => ({ kind: "drain-stream", stream: arg(0) }),
  "flat-map-streams": (arg, fact) => ({
    kind: "flat-map-streams",
    stream: arg(0),
    transform: arg(1),
    concurrency: fact.concurrency,
  }),
  "switch-map-streams": (arg) => ({
    kind: "switch-map-streams",
    stream: arg(0),
    transform: arg(1),
  }),
  "catch-stream": (arg) => ({
    kind: "catch-stream",
    stream: arg(0),
    recover: arg(1),
  }),
  "retry-stream": (arg) => ({
    kind: "retry-stream",
    stream: arg(0),
    policy: arg(1),
  }),
  "take-stream": (arg) => ({
    kind: "take-stream",
    stream: arg(0),
    count: arg(1),
  }),
  "drop-stream": (arg) => ({
    kind: "drop-stream",
    stream: arg(0),
    count: arg(1),
  }),
  "drop-while-stream": (arg) => ({
    kind: "drop-while-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "filter-stream": (arg) => ({
    kind: "filter-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "filter-effect-stream": (arg) => ({
    kind: "filter-effect-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "take-while-effect-stream": (arg) => ({
    kind: "take-while-effect-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "take-until-effect-stream": (arg) => ({
    kind: "take-until-effect-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "drop-while-effect-stream": (arg) => ({
    kind: "drop-while-effect-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "take-while-stream": (arg) => ({
    kind: "take-while-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "take-until-stream": (arg) => ({
    kind: "take-until-stream",
    stream: arg(0),
    predicate: arg(1),
  }),
  "partition-all": (arg, fact) => ({
    kind: "partition-all",
    jobs: arg(0),
    concurrency: fact.concurrency,
  }),
  "validate-all": (arg, fact) => ({
    kind: "validate-all",
    jobs: arg(0),
    onErrors: arg(1),
    concurrency: fact.concurrency,
  }),
  "all-results": (arg, fact) => ({
    kind: "all-results",
    jobs: arg(0),
    concurrency: fact.concurrency,
  }),
  "sink-for-each": (arg) => ({ kind: "sink-for-each", consume: arg(0) }),
  "transduce-stream": (arg) => ({
    kind: "transduce-stream",
    stream: arg(0),
    sink: arg(1),
  }),
  "aggregate-stream": (arg) => ({
    kind: "aggregate-stream",
    stream: arg(0),
    sink: arg(1),
  }),
  "aggregate-within-stream": (arg) => ({
    kind: "aggregate-within-stream",
    stream: arg(0),
    sink: arg(1),
    schedule: arg(2),
  }),
  "schedule-from-step": (arg) => ({
    kind: "schedule-from-step",
    initial: arg(0),
    decide: arg(1),
  }),
  "schedule-recurs": (arg) => ({ kind: "schedule-recurs", times: arg(0) }),
  "schedule-spaced": (arg) => ({
    kind: "schedule-spaced",
    delayMillis: arg(0),
  }),
  "schedule-map": (arg) => ({
    kind: "schedule-map",
    schedule: arg(0),
    transform: arg(1),
  }),
  "schedule-max": (arg) => ({
    kind: "schedule-max",
    left: arg(0),
    right: arg(1),
  }),
  "schedule-min": (arg) => ({
    kind: "schedule-min",
    left: arg(0),
    right: arg(1),
  }),
  "schedule-concat": (arg) => ({
    kind: "schedule-concat",
    left: arg(0),
    right: arg(1),
  }),
  "run-stream": (arg) => ({ kind: "run-stream", stream: arg(0), sink: arg(1) }),
  "merge-streams": (arg) => ({
    kind: "merge-streams",
    left: arg(0),
    right: arg(1),
  }),
  "zip-streams": (arg) => ({
    kind: "zip-streams",
    left: arg(0),
    right: arg(1),
  }),
  "concat-streams": (arg) => ({
    kind: "concat-streams",
    left: arg(0),
    right: arg(1),
  }),
  "race": (arg) => ({ kind: "race", left: arg(0), right: arg(1) }),
  "make-ref": (arg) => ({ kind: "make-ref", value: arg(0) }),
  "get-ref": (arg) => ({ kind: "get-ref", ref: arg(0) }),
  "set-ref": (arg) => ({ kind: "set-ref", ref: arg(0), value: arg(1) }),
  "update-ref": (arg) => ({
    kind: "update-ref",
    ref: arg(0),
    transform: arg(1),
  }),
  "merge-layers": (arg) => ({
    kind: "merge-layers",
    left: arg(0),
    right: arg(1),
  }),
};

/** The node of a positional fact, without its annotation. */
function positionalBody<K extends PositionalKind>(
  kind: K,
  fact: FactOf<K>,
  arg: ArgumentAt,
): BodyOf<K> {
  return POSITIONAL_BUILDERS[kind](arg, fact);
}

// ------------------------------------------------------------------ one body

/**
 * Lowers the expressions of one top-level declaration. The counter of generated
 * pipeline bindings belongs to the declaration and starts at 1.
 */
class BodyLowerer {
  private pipelines = 0;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly body: BodyTable,
    /** The name of the top-level declaration, which forms generated local identities. */
    private readonly owner: string,
  ) {}

  // -------------------------------------------------------------- helpers

  private kids(node: NodeId): NodeId[] {
    return kidsOf(this.ctx.tree, node);
  }

  private kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[] {
    return this.kids(node).filter((k) => kindOf(this.ctx.tree, k) === kind);
  }

  private span(node: NodeId): Span {
    return nodeSpan(this.ctx.tree, node);
  }

  private info(node: NodeId): NodeInfo {
    const info = this.body.info.get(node);
    if (info === undefined) {
      throw internal(`no checker info for the node at ${this.describe(node)}`);
    }
    return info;
  }

  private fact(node: NodeId): NodeFact | undefined {
    return this.body.facts.get(node);
  }

  private describe(node: NodeId): string {
    const span = this.span(node);
    return `${span.source}:${span.start}-${span.end}`;
  }

  private ir(ref: TypeRef): Type {
    return this.ctx.types.toIr(ref);
  }

  private annotationWith(
    type: TypeRef,
    set: EffectSet,
    span: Span,
  ): Annotation {
    return {
      type: this.ir(type),
      execution: set.mode,
      effects: {
        failures: [...set.failures],
        requirements: [...set.requirements],
      },
      span,
    };
  }

  /** The annotation that the checker recorded for a node. */
  private annotation(node: NodeId, spanNode: NodeId = node): Annotation {
    const info = this.info(node);
    return this.annotationWith(info.type, info, this.span(spanNode));
  }

  private nameText(nameNode: NodeId | undefined): string {
    const text = nameNode === undefined
      ? undefined
      : nameTextOf(this.ctx.tree, nameNode);
    if (text === undefined) throw internal("a name node has no identifier");
    return text;
  }

  private required<T>(value: T | undefined, what: string, node: NodeId): T {
    if (value === undefined) {
      throw internal(`${what} is missing at ${this.describe(node)}`);
    }
    return value;
  }

  private functionOf(ref: TypeRef): FunctionNode {
    const node = this.ctx.types.node(this.ctx.types.unfold(ref));
    if (node.kind !== "function") {
      throw internal("a callee does not have a function type");
    }
    return node;
  }

  private parameter(
    id: LocalId | undefined,
    name: string,
    type: TypeRef | undefined,
    span: Span,
  ): Parameter {
    if (id === undefined || type === undefined) {
      throw internal(`the binding \`${name}\` has no local identity`);
    }
    return { id, name, type: this.ir(type), span };
  }

  /** A binding that a pattern or handler names: the local identity and the name node. */
  private bindingOf(
    id: LocalId | undefined,
    nameNode: NodeId | undefined,
  ): Parameter {
    if (id === undefined || nameNode === undefined) {
      throw internal("a pattern binding has no local identity");
    }
    return this.parameter(
      id,
      this.nameText(nameNode),
      this.body.locals.get(id),
      this.span(nameNode),
    );
  }

  private nextPipelineBinding(): LocalId {
    this.pipelines += 1;
    while (this.ctx.identifiers.has(`$p${this.pipelines}`)) {
      this.pipelines += 1;
    }
    return `local:${this.ctx.module}#${this.owner}/$p${this.pipelines}`;
  }

  // -------------------------------------------------------------- expressions

  expr(node: NodeId): Expr {
    const tree = this.ctx.tree;
    switch (kindOf(tree, node)) {
      case SyntaxKind.LiteralExpr: {
        const value = literalOf(tree, node);
        if (value === undefined) {
          throw internal(`a literal has no value at ${this.describe(node)}`);
        }
        return value === null
          ? { kind: "null", ...this.annotation(node) }
          : { kind: "literal", value, ...this.annotation(node) };
      }
      case SyntaxKind.NameExpr:
        return this.name(node);
      case SyntaxKind.ParenExpr: {
        const inner = this.kids(node)[0];
        return this.expr(this.required(inner, "a parenthesized value", node));
      }
      case SyntaxKind.ArrowExpr:
        return this.closure(node);
      case SyntaxKind.CallExpr:
        return this.call(node);
      case SyntaxKind.FieldExpr:
        return this.field(node);
      case SyntaxKind.BinaryExpr:
        return this.binary(node);
      case SyntaxKind.PipeExpr:
        return this.pipeline(node);
      case SyntaxKind.RecordExpr:
        return this.record(node);
      case SyntaxKind.ListExpr: {
        const fact = this.fact(node);
        if (fact?.kind !== "list") {
          throw internal(`no list fact at ${this.describe(node)}`);
        }
        return {
          kind: fact.shape,
          elements: this.kids(node).map((child) => this.expr(child)),
          ...this.annotation(node),
        };
      }
      case SyntaxKind.Block:
        return this.block(node);
      case SyntaxKind.IfExpr:
        return this.ifExpr(node);
      case SyntaxKind.MatchExpr:
        return this.match(node);
      case SyntaxKind.TryExpr:
        return this.tryExpr(node);
      default:
        throw internal(`cannot lower the node at ${this.describe(node)}`);
    }
  }

  private valueTarget(nameNode: NodeId): LocalId | ValueId {
    const target = this.ctx.targets.get(nameNode);
    if (
      target?.kind === "local" || target?.kind === "value" ||
      target?.kind === "provider"
    ) {
      return target.id;
    }
    throw internal(
      `the name at ${this.describe(nameNode)} does not refer to a value`,
    );
  }

  private name(node: NodeId): Expr {
    if (this.fact(node)?.kind === "none") {
      return { kind: "none", ...this.annotation(node) };
    }
    return {
      kind: "reference",
      target: this.valueTarget(node),
      ...this.annotation(node),
    };
  }

  private closure(node: NodeId): Expr {
    const fact = this.fact(node);
    if (fact?.kind !== "arrow") {
      throw internal(`no arrow fact at ${this.describe(node)}`);
    }
    const parts = this.kids(node);
    const paramList = parts.find((k) =>
      kindOf(this.ctx.tree, k) === SyntaxKind.ParamList
    );
    const params = paramList === undefined
      ? []
      : this.kidsOfKind(paramList, SyntaxKind.Param);
    const parameters = fact.parameters.map((p, i) =>
      this.parameter(
        p.id,
        p.name,
        p.type,
        this.span(this.required(params[i], "a parameter", node)),
      )
    );
    const bodyNode = arrowBody(this.ctx.tree, node);
    return {
      kind: "closure",
      parameters,
      body: this.expr(this.required(bodyNode, "the arrow body", node)),
      ...this.annotation(node),
    };
  }

  private call(node: NodeId): Expr {
    const kids = this.kids(node);
    const callee = this.required(kids[0], "the callee", node);
    const argList = kids.find((k) =>
      kindOf(this.ctx.tree, k) === SyntaxKind.ArgList
    );
    const args = argList === undefined ? [] : this.kids(argList);
    return this.invoke(node, callee, args, undefined);
  }

  /**
   * Lowers a call node or a pipeline stage by the checker fact of `node`.
   * `pre` is the lowered left value of a stage, which is the first argument.
   * A stage whose left value moved into a binding takes its set from `stageSets`.
   */
  private invoke(
    node: NodeId,
    calleeNode: NodeId,
    argNodes: readonly NodeId[],
    pre: Expr | undefined,
  ): Expr {
    const fact = this.required(this.fact(node), "the call fact", node);
    if (fact.kind === "layer") {
      if (pre !== undefined) {
        throw internal("layer does not accept a pipeline input");
      }
      return {
        kind: "layer",
        service: this.required(fact.service, "the supplied service", node),
        acquire: this.expr(
          this.required(argNodes[1], "the layer acquisition", node),
        ),
        ...this.annotation(node),
      };
    }
    const callee: Expr | undefined = fact.kind === "call"
      ? this.calleeExpr(calleeNode)
      : undefined;
    const args: Expr[] = pre === undefined ? [] : [pre];
    if (fact.kind !== "error-construction") {
      for (const argNode of argNodes) args.push(this.expr(argNode));
    }
    const stageSet = this.body.stageSets.get(node);
    const annotation = stageSet === undefined
      ? this.annotation(node)
      : this.annotationWith(this.info(node).type, stageSet, this.span(node));
    const arg: ArgumentAt = (i) =>
      this.required(args[i], `argument ${i + 1}`, node);
    switch (fact.kind) {
      case "call":
        return {
          kind: "call",
          callee: this.required(callee, "the callee", node),
          arguments: args,
          ...annotation,
        };
      case "perform":
        return {
          kind: "perform",
          capability: fact.capability,
          arguments: args,
          ...annotation,
        };
      case "builtin": {
        const id = this.specialize(fact.name, fact.ir);
        return {
          kind: "call",
          callee: {
            kind: "reference",
            target: id,
            type: fact.ir,
            execution: "pure",
            effects: EMPTY_EFFECTS,
            span: this.span(calleeNode),
          },
          arguments: args,
          ...annotation,
        };
      }
      case "error-construction": {
        const record = argNodes[0];
        if (
          pre !== undefined || argNodes.length !== 1 || record === undefined ||
          kindOf(this.ctx.tree, record) !== SyntaxKind.RecordExpr
        ) {
          throw unsupported(
            "an error is constructed from a record literal; this argument is not one",
            this.span(node),
          );
        }
        return {
          kind: "error",
          error: fact.error,
          fields: this.recordFields(this.kids(record)),
          ...annotation,
        };
      }
      case "brand-construction":
        return {
          kind: "brand",
          brand: fact.brand,
          value: arg(0),
          ...annotation,
        };
      case "data-construction":
        return {
          kind: "data",
          data: fact.data,
          value: arg(0),
          ...annotation,
        };
      case "retry":
        return {
          kind: "retry",
          job: arg(0),
          times: this.required(fact.times, "the retry count", node),
          ...annotation,
        };
      case "schema":
        return fact.op === "decode" || fact.op === "encode" ||
            fact.op === "make"
          ? {
            kind: fact.op === "decode"
              ? "schema-decode"
              : fact.op === "encode"
              ? "schema-encode"
              : "schema-make",
            schema: arg(0),
            input: arg(1),
            ...annotation,
          }
          : {
            kind: "schema",
            op: fact.op,
            arguments: this.schemaArguments(
              fact.op,
              args.map((_, i) => arg(i)),
            ),
            ...annotation,
          };
      case "with-fiber": {
        const job = arg(0);
        const use = arg(1);
        if (use.kind !== "closure" || use.parameters[0] === undefined) {
          throw internal("withFiber needs an inline use callback");
        }
        return {
          kind: "with-fiber",
          job,
          use,
          useBinding: use.parameters[0].id,
          ...annotation,
        };
      }
      case "with-resource": {
        const acquire = arg(0);
        const use = arg(1);
        const release = arg(2);
        if (
          use.kind !== "closure" || release.kind !== "closure" ||
          use.parameters[0] === undefined || release.parameters[0] === undefined
        ) {
          throw internal("withResource needs inline scoped closures");
        }
        return {
          kind: "with-resource",
          acquire,
          use,
          release,
          useBinding: use.parameters[0].id,
          releaseBinding: release.parameters[0].id,
          ...annotation,
        };
      }
      case "map-groups": {
        const stream = arg(0);
        const key = arg(1);
        const use = arg(2);
        if (use.kind !== "closure" || use.parameters[1] === undefined) {
          throw internal("mapGroups needs an inline use callback");
        }
        return {
          kind: "map-groups",
          stream,
          key,
          use,
          bufferSize: this.required(
            fact.bufferSize,
            "the group capacity",
            node,
          ),
          groupBinding: use.parameters[1].id,
          ...annotation,
        };
      }
      case "debounce-stream":
        return {
          kind: "debounce-stream",
          stream: arg(0),
          delayMs: this.required(fact.delayMs, "debounce delay", node),
          ...annotation,
        };
      case "throttle-stream":
        return {
          kind: "throttle-stream",
          stream: arg(0),
          units: this.required(fact.units, "throttle units", node),
          durationMs: this.required(fact.durationMs, "throttle duration", node),
          strategy: this.required(fact.strategy, "throttle strategy", node),
          ...annotation,
        };
      case "take-sink":
        return {
          kind: "take-sink",
          count: this.required(fact.count, "the sink count", node),
          ...annotation,
        };
      case "buffer-stream":
        return {
          kind: "buffer-stream",
          stream: arg(0),
          capacity: this.required(
            fact.capacity,
            "the stream buffer capacity",
            node,
          ),
          ...annotation,
        };
      case "none":
      case "list":
      case "field":
      case "arrow":
      case "binding":
      case "pattern":
      case "handler":
        throw internal(
          `the fact ${fact.kind} is no call at ${this.describe(node)}`,
        );
      default:
        // Every other fact kind has a row in POSITIONAL_BUILDERS. A kind
        // without a row, or without a case above, fails to compile here.
        return {
          ...positionalBody(fact.kind, fact, arg),
          ...annotation,
        };
    }
  }

  /** A callee expression, or the qualified name of a pipeline stage. */
  private calleeExpr(calleeNode: NodeId): Expr {
    if (kindOf(this.ctx.tree, calleeNode) !== SyntaxKind.QualifiedName) {
      return this.expr(calleeNode);
    }
    return {
      kind: "reference",
      target: this.valueTarget(calleeNode),
      ...this.annotation(calleeNode),
    };
  }

  /** The identity of a closed builtin instance. Equal types share one identity. */
  private specialize(name: string, type: FunctionType): ValueId {
    const json = canonicalJson(type);
    const hash = sha256Hex(json).slice(0, 12);
    const id: ValueId = builtinInstanceId(this.ctx.module, name, hash);
    const known = this.ctx.builtins.get(id);
    if (known === undefined) {
      this.ctx.builtins.set(id, { name, type });
    } else if (canonicalJson(known.type) !== json) {
      // The 12-digit hash is a truncation, so two types could share an id.
      throw internal(`two builtin instance types share the id ${id}`);
    }
    return id;
  }

  private field(node: NodeId): Expr {
    const fact = this.fact(node);
    if (fact?.kind !== "field") {
      throw internal(`no field fact at ${this.describe(node)}`);
    }
    const base = this.required(this.kids(node)[0], "the record", node);
    return {
      kind: "get",
      record: this.expr(base),
      field: fact.name,
      ...this.annotation(node),
    };
  }

  private binary(node: NodeId): Expr {
    const kids = this.kids(node);
    const operator: BinaryOperator = this.required(
      operatorOf(this.ctx.tree, node),
      "the operator",
      node,
    );
    return {
      kind: "binary",
      operator,
      left: this.expr(this.required(kids[0], "the left operand", node)),
      right: this.expr(this.required(kids[1], "the right operand", node)),
      ...this.annotation(node),
    };
  }

  // -------------------------------------------------------------- pipelines

  /**
   * `x |> s1 |> s2(a)` becomes a block that binds `$p1 = x` and `$p2 = s1($p1)`
   * and returns `s2($p2, a)`. A generated binding and each reference to it use
   * the span of the left expression that it stands for. Each call keeps the
   * span of its stage.
   */
  private pipeline(node: NodeId): Expr {
    const chain: { readonly pipe: NodeId; readonly stage: NodeId }[] = [];
    let base = node;
    while (kindOf(this.ctx.tree, base) === SyntaxKind.PipeExpr) {
      const parts = this.kids(base);
      const stage = parts.find((k) =>
        kindOf(this.ctx.tree, k) === SyntaxKind.PipeStage
      );
      chain.unshift({
        pipe: base,
        stage: this.required(stage, "the pipeline stage", base),
      });
      base = this.required(parts[0], "the pipeline value", base);
    }
    // One binding for the base value and one for each stage but the last.
    const ids = chain.map(() => this.nextPipelineBinding());
    const steps: Step[] = [];
    let left: NodeId = base;
    let value = this.expr(base);
    let result: Expr | undefined;
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i];
      const leftInfo = this.info(left);
      const leftSpan = this.span(left);
      const type = this.ir(leftInfo.type);
      steps.push({
        kind: "bind",
        binding: {
          id: ids[i],
          name: ids[i].slice(ids[i].lastIndexOf("/") + 1),
          type,
          span: leftSpan,
        },
        value,
      });
      const reference: Expr = {
        kind: "reference",
        target: ids[i],
        type,
        execution: "pure",
        effects: EMPTY_EFFECTS,
        span: leftSpan,
      };
      const call = this.stage(link.stage, reference, leftInfo);
      if (i === chain.length - 1) {
        result = call;
      } else {
        value = call;
        left = link.pipe;
      }
    }
    const last = this.required(result, "the pipeline result", node);
    const outer = this.info(node);
    const set = combine([...steps.map((s) => setOf(s.value)), setOf(last)]);
    return {
      kind: "block",
      steps,
      result: last,
      ...this.annotationWith(outer.type, set, this.span(node)),
    };
  }

  /** Lowers one stage as a call whose first argument is the generated reference. */
  private stage(stage: NodeId, pre: Expr, leftInfo: NodeInfo): Expr {
    const parts = this.kids(stage);
    const qualified = this.required(
      parts.find((k) => kindOf(this.ctx.tree, k) === SyntaxKind.QualifiedName),
      "the stage name",
      stage,
    );
    const argList = parts.find((k) =>
      kindOf(this.ctx.tree, k) === SyntaxKind.ArgList
    );
    const argNodes = argList === undefined ? [] : this.kids(argList);
    if (!isQuiet(leftInfo)) {
      this.required(
        this.body.stageSets.get(stage),
        "the stage effect set",
        stage,
      );
    }
    return this.invoke(stage, qualified, argNodes, pre);
  }

  // -------------------------------------------------------------- records

  /** The label, label node, and value node of a field. The value is absent in a shorthand field. */
  private fieldParts(field: NodeId): {
    readonly label: string;
    readonly labelNode: NodeId;
    readonly value: NodeId | undefined;
  } {
    const kind = kindOf(this.ctx.tree, field);
    if (kind !== SyntaxKind.RecordField && kind !== SyntaxKind.ShorthandField) {
      throw unsupported(
        "a record spread must come first in a record",
        this.span(field),
      );
    }
    const parts = this.kids(field);
    const labelNode = this.required(
      parts.find((k) => kindOf(this.ctx.tree, k) === SyntaxKind.Name),
      "the field label",
      field,
    );
    return {
      label: this.nameText(labelNode),
      labelNode,
      value: kind === SyntaxKind.ShorthandField
        ? undefined
        : parts.find((k) => k !== labelNode),
    };
  }

  private fieldValue(field: NodeId): Expr {
    const parts = this.fieldParts(field);
    if (parts.value !== undefined) return this.expr(parts.value);
    // A shorthand field `{ id }` reads the variable `id`. The checker keeps its sets on the field node.
    return {
      kind: "reference",
      target: this.valueTarget(parts.labelNode),
      ...this.annotation(field),
    };
  }

  /**
   * The `on` option of `schemaDefaultKey` selects the operation and is not
   * part of the IR. Rebuild the options record without it, or drop the record.
   * The record type is the single required field that the IR always had.
   */
  private schemaArguments(
    op: string,
    args: readonly Expr[],
  ): readonly Expr[] {
    const options = args[2];
    if (
      (op !== "default-key" && op !== "default-null-key" &&
        op !== "default-encoded-key") ||
      options === undefined || options.kind !== "record"
    ) return args;
    const fields = options.fields.filter((field) => field.name !== "on");
    if (fields.length === 0) return args.slice(0, 2);
    const type = options.type;
    return [
      args[0],
      args[1],
      {
        ...options,
        fields,
        type: type.kind === "record"
          ? {
            kind: "record",
            fields: type.fields
              .filter((field) => field.name !== "on")
              .map((field) => ({ ...field, optional: false })),
          }
          : type,
      },
    ];
  }

  private recordFields(
    fields: readonly NodeId[],
  ): { readonly name: string; readonly value: Expr }[] {
    return fields.map((field) => ({
      name: this.fieldParts(field).label,
      value: this.fieldValue(field),
    }));
  }

  private record(node: NodeId): Expr {
    const fields = this.kids(node);
    const first = fields[0];
    if (
      first !== undefined &&
      kindOf(this.ctx.tree, first) === SyntaxKind.SpreadField
    ) {
      const baseNode = this.required(
        this.kids(first)[0],
        "the spread base",
        first,
      );
      return {
        kind: "update",
        record: this.expr(baseNode),
        fields: this.recordFields(fields.slice(1)),
        ...this.annotation(node),
      };
    }
    return {
      kind: "record",
      fields: this.recordFields(fields),
      ...this.annotation(node),
    };
  }

  // -------------------------------------------------------------- blocks and control

  private block(node: NodeId): Expr {
    const items = this.kids(node);
    const steps: Step[] = [];
    let result: Expr | undefined;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (kindOf(this.ctx.tree, item) === SyntaxKind.ConstDecl) {
        steps.push(this.binding(item));
      } else if (i === items.length - 1) {
        result = this.expr(item);
      } else {
        steps.push({ kind: "evaluate", value: this.expr(item) });
      }
    }
    return {
      kind: "block",
      steps,
      // A block that ends with a binding, or has no items, yields unit.
      result: result ?? {
        kind: "literal",
        value: null,
        type: { kind: "primitive", name: "unit" },
        execution: "pure",
        effects: EMPTY_EFFECTS,
        span: this.span(node),
      },
      ...this.annotation(node),
    };
  }

  /** A `const` in a block. The binding span covers the name and its annotation. */
  private binding(node: NodeId): Step {
    const fact = this.fact(node);
    if (fact?.kind !== "binding") {
      throw internal(`no binding fact at ${this.describe(node)}`);
    }
    const parts = this.kids(node);
    const nameNode = this.required(
      parts.find((k) => kindOf(this.ctx.tree, k) === SyntaxKind.Name),
      "the binding name",
      node,
    );
    const typeNode = parts.find((k) => isTypeKind(kindOf(this.ctx.tree, k)));
    const init = initOf(this.ctx.tree, node, nameNode);
    const name = this.span(nameNode);
    const end = typeNode === undefined ? name.end : this.span(typeNode).end;
    return {
      kind: "bind",
      binding: this.parameter(fact.id, this.nameText(nameNode), fact.type, {
        source: name.source,
        start: name.start,
        end,
      }),
      value: this.expr(this.required(init, "the binding value", node)),
    };
  }

  private ifExpr(node: NodeId): Expr {
    const kids = this.kids(node);
    const part = (i: number, what: string): Expr =>
      this.expr(this.required(kids[i], what, node));
    return {
      kind: "if",
      condition: part(0, "the condition"),
      then: part(1, "the then branch"),
      else: part(2, "the else branch"),
      ...this.annotation(node),
    };
  }

  private match(node: NodeId): Expr {
    const kids = this.kids(node);
    const subject = this.expr(this.required(kids[0], "the subject", node));
    const arms: Arm[] = kids.slice(1)
      .filter((k) => kindOf(this.ctx.tree, k) === SyntaxKind.MatchArm)
      .map((arm) => {
        const parts = this.kids(arm);
        const patternNode = this.required(
          parts.find((k) => PATTERN_KINDS.has(kindOf(this.ctx.tree, k))),
          "the pattern",
          arm,
        );
        const bodyNode = parts.filter((k) => k !== patternNode).pop();
        return {
          pattern: this.pattern(patternNode),
          body: this.expr(this.required(bodyNode, "the arm body", arm)),
        };
      });
    return { kind: "match", subject, arms, ...this.annotation(node) };
  }

  private pattern(node: NodeId): Pattern {
    const fact = this.fact(node);
    if (fact?.kind !== "pattern") {
      throw internal(`no pattern fact at ${this.describe(node)}`);
    }
    const pattern = fact.pattern;
    const span = this.span(node);
    const names = this.kidsOfKind(node, SyntaxKind.Name);
    switch (pattern.kind) {
      case "wildcard":
        return { kind: "wildcard", span };
      case "literal":
        return { kind: "literal", value: pattern.value, span };
      case "none":
        return { kind: "none", span };
      case "some":
        return {
          kind: "some",
          binding: this.bindingOf(pattern.binding, names[1]),
          span,
        };
      case "error":
        return {
          kind: "error",
          error: pattern.error,
          binding: this.bindingOf(pattern.binding, names[1]),
          span,
        };
      case "data":
        return {
          kind: "data",
          data: pattern.data,
          binding: this.bindingOf(pattern.binding, names[1]),
          span,
        };
      case "tag": {
        const spread = this.kidsOfKind(node, SyntaxKind.SpreadPattern)[0];
        const spreadName = spread === undefined
          ? undefined
          : this.kidsOfKind(spread, SyntaxKind.Name)[0];
        return {
          kind: "tag",
          field: pattern.field,
          value: pattern.value,
          binding: pattern.binding === null
            ? null
            : this.bindingOf(pattern.binding, spreadName),
          span,
        };
      }
      case "invalid":
        throw internal(`an invalid pattern at ${this.describe(node)}`);
    }
  }

  private tryExpr(node: NodeId): Expr {
    const kids = this.kids(node);
    const bodyNode = this.required(
      kids.find((k) => kindOf(this.ctx.tree, k) === SyntaxKind.Block),
      "the protected block",
      node,
    );
    const catchNode = kids.find((k) =>
      kindOf(this.ctx.tree, k) === SyntaxKind.CatchClause
    );
    const body = this.expr(bodyNode);
    const handlers: Handler[] = catchNode === undefined
      ? []
      : this.kidsOfKind(catchNode, SyntaxKind.Handler).map((h) =>
        this.handler(h)
      );
    return { kind: "catch", body, handlers, ...this.annotation(node) };
  }

  private handler(node: NodeId): Handler {
    const fact = this.fact(node);
    if (fact?.kind !== "handler") {
      throw internal(`no handler fact at ${this.describe(node)}`);
    }
    const parts = this.kids(node);
    const nameNodes = parts.filter((k) =>
      kindOf(this.ctx.tree, k) === SyntaxKind.Name
    );
    const bodyNode = parts.filter((k) =>
      kindOf(this.ctx.tree, k) !== SyntaxKind.Name
    ).pop();
    return {
      error: this.required(fact.error, "the handled error", node),
      binding: this.bindingOf(fact.binding, nameNodes[1]),
      body: this.expr(this.required(bodyNode, "the handler body", node)),
      span: this.span(node),
    };
  }
}

// ------------------------------------------------------------------ one module

function targetId(target: Target | undefined): DeclarationId | undefined {
  switch (target?.kind) {
    case "type":
    case "error":
    case "service":
    case "provider":
    case "value":
      return target.id;
    default:
      return undefined;
  }
}

function lowerImports(
  checked: CheckedProject,
  info: ModuleInfo,
  resolution: ModuleResolution,
  module: string,
): Result<Import[], LowerError> {
  const imports: Import[] = [];
  for (let i = 0; i < info.links.length; i++) {
    const link = info.links[i];
    const imported = link.target === undefined
      ? undefined
      : checked.modules.get(link.target);
    const iface = imported?.interface;
    if (
      link.label === undefined || imported === undefined ||
      iface === undefined || !iface.ok
    ) {
      return {
        ok: false,
        error: {
          tag: "no-interface",
          module,
          imported: link.label ?? link.entry.specifier ?? "",
        },
      };
    }
    const bindings: { name: string; target: DeclarationId }[] = [];
    for (const name of link.entry.names) {
      const target = targetId(resolution.namespace.get(name.name)?.target);
      if (target === undefined) {
        return {
          ok: false,
          error: {
            tag: "internal",
            module,
            message: `the imported name ${name.name} has no target`,
          },
        };
      }
      bindings.push({ name: name.name, target });
    }
    const payload = iface.value.payload;
    imports.push({
      module: link.label,
      bindings,
      exports: payload.exports,
      values: payload.values,
      types: payload.types,
      errors: payload.errors,
      services: payload.services,
    });
  }
  return { ok: true, value: imports };
}

/** The synthetic import of the closed prelude interface, or nothing when no builtin is used. */
function preludeImport(
  builtins: ReadonlyMap<ValueId, BuiltinInstance>,
): Import | undefined {
  if (builtins.size === 0) return undefined;
  const entries = [...builtins].sort(([a], [b]) => compareText(a, b));
  return {
    module: "effective:prelude",
    bindings: [],
    exports: entries.map(([id]) => id),
    values: entries.map(([id, builtin]) => ({
      id,
      name: id.slice(id.indexOf("#") + 1),
      type: builtin.type,
    })),
    types: [],
    errors: [],
    services: [],
  };
}

function lowerDeclarations(
  checked: CheckedProject,
  module: CheckedModule,
  ctx: ModuleContext,
): Declaration[] {
  const found: { readonly start: number; readonly declaration: Declaration }[] =
    [];
  const decls = module.declarations;
  for (const declaration of decls.types) {
    found.push({ start: declaration.span.start, declaration });
  }
  for (const declaration of decls.errors) {
    found.push({ start: declaration.span.start, declaration });
  }
  for (const declaration of decls.services) {
    found.push({ start: declaration.span.start, declaration });
  }
  for (const fn of module.functions.values()) {
    found.push({
      start: fn.signature.span.start,
      declaration: lowerFunction(checked, module, ctx, fn),
    });
  }
  for (const constant of module.constants.values()) {
    found.push({
      start: constant.signature.span.start,
      declaration: lowerConstant(ctx, constant),
    });
  }
  found.sort((a, b) => a.start - b.start);
  return found.map((f) => f.declaration);
}

function lowerFunction(
  checked: CheckedProject,
  module: CheckedModule,
  ctx: ModuleContext,
  fn: FunctionBody,
): Declaration {
  const signature = fn.signature;
  const lowerer = new BodyLowerer(ctx, fn.table, signature.name);
  if (fn.bodyNode === undefined) {
    throw internal(`the function ${signature.name} has no body`);
  }
  let type: FunctionType;
  if (signature.contract === "explicit") {
    const computed = signatureType(checked.table, signature, module.modes);
    if (!computed.ok) {
      throw internal(`the function ${signature.name} has no computed mode`);
    }
    type = computed.value.ir;
  } else {
    type = checked.table.toIrFunction(fn.type);
  }
  const parameters: Parameter[] = signature.parameters.map((p) => {
    if (p.id === undefined) {
      throw internal(`the parameter ${p.name} has no local identity`);
    }
    return {
      id: p.id,
      name: p.name,
      type: p.type.ir,
      ...(p.borrow ? { borrow: true } : {}),
      span: p.span,
    };
  });
  return {
    kind: "function",
    id: signature.id,
    name: signature.name,
    parameters,
    type,
    contract: signature.contract,
    body: lowerer.expr(fn.bodyNode),
    span: signature.span,
  };
}

function lowerConstant(
  ctx: ModuleContext,
  constant: ConstantBody,
): Declaration {
  const signature = constant.signature;
  if (constant.initNode === undefined) {
    throw internal(`the constant ${signature.name} has no initializer`);
  }
  const lowerer = new BodyLowerer(ctx, constant.table, signature.name);
  return {
    kind: "constant",
    id: signature.id,
    name: signature.name,
    type: signature.type?.ir ?? ctx.types.toIr(constant.type),
    value: lowerer.expr(constant.initNode),
    span: signature.span,
  };
}

/**
 * Lowers one checked module to typed IR. The module must have no diagnostics.
 * A `.effi` module lowers to its type, error, and service declarations. The diagnostics of the module are the declaration and body
 * diagnostics plus every project diagnostic whose span names the module's file.
 */
export function lowerModule(
  checked: CheckedProject,
  module: string,
): Result<ModuleIR, LowerError> {
  const checkedModule = checked.modules.get(module);
  const info = checked.analysis.project.modules.get(module);
  const resolution = checked.analysis.resolutions.get(module);
  if (
    checkedModule === undefined || info === undefined ||
    resolution === undefined
  ) {
    return { ok: false, error: { tag: "unknown-module", module } };
  }
  const count =
    checked.diagnostics.filter((d) => d.span.source === checkedModule.path)
      .length;
  if (count > 0 || checkedModule.diagnostics.length > 0) {
    return {
      ok: false,
      error: {
        tag: "diagnostics",
        module,
        count: Math.max(count, checkedModule.diagnostics.length),
      },
    };
  }
  const imports = lowerImports(checked, info, resolution, module);
  if (!imports.ok) return imports;
  const ctx: ModuleContext = {
    module,
    tree: checkedModule.tree,
    types: checked.table,
    targets: resolution.targets,
    services: checkedModule.declarations.env.services,
    builtins: new Map(),
    identifiers: identifiersOf(checkedModule.tree),
  };
  try {
    const declarations = lowerDeclarations(checked, checkedModule, ctx);
    const prelude = preludeImport(ctx.builtins);
    return {
      ok: true,
      value: {
        format: "light-functional-ir",
        version: 2,
        module,
        sources: [checkedModule.path],
        imports: prelude === undefined
          ? imports.value
          : [...imports.value, prelude],
        declarations,
        // The companion module of a `.effi` file exports every declaration,
        // because the host module needs each one. Providers are not lowered.
        exports: info.mode === "effi"
          ? sortedUnique(declarations.map((d) => d.id))
          : checkedModule.declarations.exports,
      },
    };
  } catch (e) {
    if (e instanceof LowerFailure) {
      return {
        ok: false,
        error: e.failure.tag === "unsupported"
          ? {
            tag: "unsupported",
            module,
            message: e.failure.message,
            span: e.failure.span,
          }
          : { tag: "internal", module, message: e.failure.message },
      };
    }
    throw e;
  }
}

/**
 * Lowers every `.eff` and `.effi` module of the project, in topological order.
 * A module with an error value has no IR.
 */
export function lowerProject(
  checked: CheckedProject,
): ReadonlyMap<string, Result<ModuleIR, LowerError>> {
  const results = new Map<string, Result<ModuleIR, LowerError>>();
  for (const name of checked.modules.keys()) {
    results.set(name, lowerModule(checked, name));
  }
  return results;
}

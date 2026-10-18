// Expression checking (plan part A3b). A `BodyChecker` checks one declaration
// body. For each syntax node it records the type, the failure set, the
// requirement set, and the mode in a `BodyTable`, and it records the facts that
// lowering needs. See `tables.ts` for the shapes.
//
// Checking is bidirectional. `expr(node, expected)` passes an expected type
// down so that literals, record constructions, `None`, and arrows can use it. An
// expected type is always a requirement: the construct or its parent verifies
// that the result fits.
//
// Error recovery follows design 6.4. An error node, an unresolved name, or an
// operand of the error type gives the error type, empty sets, and pure mode, and
// no diagnostic. Diagnostics go to `sink`; the driver decides when to publish.

import {
  type Diagnostic,
  type DiagnosticCode,
  makeDiagnostic,
} from "./diagnostics.ts";
import { isTypeKind, nameTextOf } from "./index.ts";
import { SCOPE_CAPABILITY } from "./ir.ts";
import type {
  CapabilityId,
  ErrorId,
  Execution,
  LocalId,
  ServiceId,
  TypeId,
  ValueId,
} from "./ir.ts";
import { TokenKind } from "./lex.ts";
import type { Target } from "./resolve.ts";
import type { Span } from "./source.ts";
import {
  childrenOf,
  kindOf,
  type NodeId,
  nodeSpan,
  nodeText,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";
import {
  type ConstantSignature,
  decodeString,
  type FunctionSignature,
  type TypeEnv,
  TypeLowerer,
} from "./check.ts";
import {
  describeLiteral,
  type Domain,
  domainOf,
  flattenMembers,
  type LiteralValue,
  narrowTagged,
  taggedValues,
} from "./patterns.ts";
import {
  type ArrowParameterFact,
  type BodyTable,
  combine,
  EFFECT_ONLY,
  type EffectSet,
  newBodyTable,
  type NodeFact,
  type NodeInfo,
  type PatternFact,
  PURE_EFFECTS,
  without,
} from "./tables.ts";
import {
  sortedUnique,
  type TypeNode,
  type TypeRef,
  type TypeTable,
} from "./types.ts";

// ------------------------------------------------------------------ environment

/** What the body checker needs from the module and from the project. */
export interface BodyEnv {
  readonly module: string;
  readonly env: TypeEnv;
  /** The type of a module-level value, local or imported. The error type when unknown. */
  readonly values: (id: ValueId) => TypeRef;
  /** The function type of a service method. The error type when unknown. */
  readonly methodType: (capability: CapabilityId) => TypeRef;
}

type FunctionNode = Extract<TypeNode, { readonly kind: "function" }>;

/** The contract of a function body. A result means the contract is explicit and closed. */
export interface Contract {
  readonly result: TypeRef | undefined;
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
}

/** What checking one function body produces. */
export interface FunctionRun {
  readonly table: BodyTable;
  /** The info of the body expression. Absent when the body is missing. */
  readonly body: NodeInfo | undefined;
  /** The declared or inferred result type. */
  readonly result: TypeRef;
  /** The invocation sets: declared for an explicit contract, inferred otherwise. */
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  /** The invocation mode. */
  readonly mode: Execution;
  /** The function type with that mode. */
  readonly type: TypeRef;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ConstantRun {
  readonly table: BodyTable;
  readonly init: NodeInfo | undefined;
  /** The binding annotation, or the widened type of the initializer. */
  readonly type: TypeRef;
  readonly diagnostics: readonly Diagnostic[];
}

interface Arg {
  readonly node: NodeId;
  /** The value of a pipeline's left side, which is evaluated once before the stage. */
  readonly pre?: NodeInfo;
}

interface ArrowContext {
  readonly parameters: readonly TypeRef[];
  readonly result: TypeRef | undefined;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

const OPERATORS: ReadonlyMap<TokenKind, BinaryOperator> = new Map([
  [TokenKind.Plus, "+"],
  [TokenKind.Minus, "-"],
  [TokenKind.Star, "*"],
  [TokenKind.Slash, "/"],
  [TokenKind.EqEqEq, "==="],
  [TokenKind.BangEqEq, "!=="],
  [TokenKind.Lt, "<"],
  [TokenKind.LtEq, "<="],
  [TokenKind.Gt, ">"],
  [TokenKind.GtEq, ">="],
  [TokenKind.AmpAmp, "&&"],
  [TokenKind.PipePipe, "||"],
]);

const PATTERN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.WildcardPattern,
  SyntaxKind.LiteralPattern,
  SyntaxKind.NamePattern,
  SyntaxKind.CtorPattern,
  SyntaxKind.RecordPattern,
]);

/** Child nodes of a node that are not tokens or Missing nodes. */
export function kidsOf(tree: SyntaxTree, node: NodeId): NodeId[] {
  const result: NodeId[] = [];
  for (const child of childrenOf(tree, node)) {
    const kind = kindOf(tree, child);
    if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
      result.push(child);
    }
  }
  return result;
}

/** The name after the `#` of an identity, for messages. */
export function shortName(id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? id : id.slice(hash + 1);
}

function names(ids: readonly string[]): string {
  return ids.map(shortName).join(", ");
}

export function literalOf(
  tree: SyntaxTree,
  node: NodeId,
): LiteralValue | undefined {
  for (const child of childrenOf(tree, node)) {
    if (kindOf(tree, child) !== SyntaxKind.Token) continue;
    const kind = tree.lexed.kinds[tree.tokens[child]] as TokenKind;
    const text = nodeText(tree, child);
    if (kind === TokenKind.String) return decodeString(text);
    if (kind === TokenKind.Number) {
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    if (kind === TokenKind.KwTrue) return true;
    if (kind === TokenKind.KwFalse) return false;
  }
  return undefined;
}

export function operatorOf(
  tree: SyntaxTree,
  node: NodeId,
): BinaryOperator | undefined {
  for (const child of childrenOf(tree, node)) {
    if (kindOf(tree, child) !== SyntaxKind.Token) continue;
    const kind = tree.lexed.kinds[tree.tokens[child]] as TokenKind;
    const operator = OPERATORS.get(kind);
    if (operator !== undefined) return operator;
  }
  return undefined;
}

interface MatchState {
  wildcard: boolean;
  readonly covered: Set<string>;
  /** The discriminator field of a tagged match, once an arm names it. */
  tagField: string | undefined;
}

// ------------------------------------------------------------------ the checker

export class BodyChecker {
  readonly sink: Diagnostic[] = [];
  readonly body: BodyTable;
  private readonly lowerer: TypeLowerer;
  private readonly tree: SyntaxTree;
  private readonly table: TypeTable;
  private readonly targets: ReadonlyMap<NodeId, Target>;
  /** Block-local functions whose bodies are being checked. */
  private readonly pendingLocals = new Set<LocalId>();
  /** Counts the error nodes made so far. Recovery uses it to hold back cascades. */
  private errorCount = 0;

  constructor(private readonly benv: BodyEnv, declaration: ValueId) {
    this.tree = benv.env.tree;
    this.table = benv.env.table;
    this.targets = benv.env.targets;
    this.lowerer = new TypeLowerer(benv.env, this.sink);
    this.body = newBodyTable(declaration);
  }

  // -------------------------------------------------------------- helpers

  private kids(node: NodeId): NodeId[] {
    return kidsOf(this.tree, node);
  }

  private kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[] {
    return this.kids(node).filter((k) => kindOf(this.tree, k) === kind);
  }

  private span(node: NodeId): Span {
    return nodeSpan(this.tree, node);
  }

  private report(code: DiagnosticCode, message: string, node: NodeId): void {
    this.sink.push(makeDiagnostic(code, message, this.span(node)));
  }

  private show(ref: TypeRef): string {
    return this.table.show(ref);
  }

  private isError(ref: TypeRef): boolean {
    return this.table.node(ref).kind === "error";
  }

  private finish(node: NodeId, type: TypeRef, eff: EffectSet): NodeInfo {
    const info: NodeInfo = {
      type,
      failures: eff.failures,
      requirements: eff.requirements,
      mode: eff.mode,
    };
    this.body.info.set(node, info);
    return info;
  }

  private fact(node: NodeId, fact: NodeFact): void {
    this.body.facts.set(node, fact);
  }

  private errorInfo(node: NodeId): NodeInfo {
    this.errorCount++;
    return this.finish(node, this.table.error, PURE_EFFECTS);
  }

  /** Reports a mismatch when `found` does not fit `expected`. Returns true when it fits. */
  private fits(
    node: NodeId,
    found: TypeRef,
    expected: TypeRef | undefined,
    what: string,
  ): boolean {
    if (expected === undefined || this.table.isAssignable(found, expected)) {
      return true;
    }
    this.report(
      "type-mismatch/003",
      `${what} has type ${this.show(found)}, but ${
        this.show(expected)
      } is expected`,
      node,
    );
    return false;
  }

  /** Literal types of a fresh value become their primitive. Declared types stay. */
  private widen(ref: TypeRef): TypeRef {
    const node = this.table.node(ref);
    if (node.kind === "literal") return this.primitiveOf(node.value);
    if (node.kind === "union" && node.members.some((m) => this.isLiteral(m))) {
      return this.table.union(node.members.map((m) => this.widen(m)));
    }
    return ref;
  }

  private isLiteral(ref: TypeRef): boolean {
    return this.table.node(ref).kind === "literal";
  }

  private primitiveOf(value: LiteralValue): TypeRef {
    if (typeof value === "string") return this.table.string;
    if (typeof value === "boolean") return this.table.boolean;
    return Number.isSafeInteger(value) ? this.table.int : this.table.number;
  }

  private functionOf(ref: TypeRef): FunctionNode | undefined {
    const node = this.table.node(this.table.unfold(ref));
    return node.kind === "function" ? node : undefined;
  }

  private contextOf(expected: TypeRef | undefined): ArrowContext | undefined {
    if (expected === undefined) return undefined;
    const fn = this.functionOf(expected);
    return fn === undefined
      ? undefined
      : { parameters: fn.parameters, result: fn.result };
  }

  /** The element type of an option type, or undefined when the type is no option. */
  private optionElement(ref: TypeRef | undefined): TypeRef | undefined {
    if (ref === undefined) return undefined;
    const members = flattenMembers(this.table, ref).map((m) =>
      this.table.node(m)
    );
    const options = members.filter((m) => m.kind === "option");
    if (options.length !== 1) return undefined;
    const only = options[0];
    return only.kind === "option" ? only.element : undefined;
  }

  // -------------------------------------------------------------- public entries

  /**
   * Checks a function body against its contract. The parameters must already be
   * in `locals`.
   */
  checkBody(
    bodyNode: NodeId | undefined,
    contract: Contract,
    hint: TypeRef | undefined,
  ): {
    readonly body: NodeInfo | undefined;
    readonly result: TypeRef;
    readonly failures: readonly ErrorId[];
    readonly requirements: readonly CapabilityId[];
    readonly execution: Execution;
  } {
    if (bodyNode === undefined) {
      const failures = contract.result === undefined ? [] : contract.failures;
      const requirements = contract.result === undefined
        ? []
        : contract.requirements;
      return {
        body: undefined,
        result: contract.result ?? this.table.error,
        failures,
        requirements,
        execution: failures.length + requirements.length > 0
          ? "effect"
          : "pure",
      };
    }
    const body = this.expr(bodyNode, contract.result ?? hint);
    if (contract.result === undefined) {
      return {
        body,
        result: this.widen(body.type),
        failures: body.failures,
        requirements: body.requirements,
        execution: body.mode,
      };
    }
    this.fits(bodyNode, body.type, contract.result, "the function body");
    const extraFailures = without(body.failures, contract.failures);
    if (extraFailures.length > 0) {
      this.report(
        "failure-contract/001",
        `the body can fail with ${
          names(extraFailures)
        }, which the \`fails\` clause does not list`,
        bodyNode,
      );
    }
    const extraRequirements = without(body.requirements, contract.requirements);
    if (extraRequirements.length > 0) {
      this.report(
        "requirement-contract/001",
        `the body requires ${
          names(extraRequirements)
        }, which the \`uses\` clause does not list`,
        bodyNode,
      );
    }
    return {
      body,
      result: contract.result,
      failures: contract.failures,
      requirements: contract.requirements,
      execution: contract.failures.length + contract.requirements.length > 0
        ? "effect"
        : body.mode,
    };
  }

  /** Checks a module-level constant initializer. */
  checkConstant(
    initNode: NodeId | undefined,
    annotation: TypeRef | undefined,
  ): { readonly init: NodeInfo | undefined; readonly type: TypeRef } {
    if (initNode === undefined) {
      return { init: undefined, type: annotation ?? this.table.error };
    }
    const init = this.expr(initNode, annotation);
    this.fits(initNode, init.type, annotation, "the constant");
    if (
      init.mode === "effect" || init.failures.length > 0 ||
      init.requirements.length > 0
    ) {
      this.report(
        "execution-mode/002",
        "a module constant must have a pure initializer with empty failure and requirement sets",
        initNode,
      );
    }
    return { init, type: annotation ?? this.widen(init.type) };
  }

  // -------------------------------------------------------------- expressions

  expr(node: NodeId, expected?: TypeRef): NodeInfo {
    switch (kindOf(this.tree, node)) {
      case SyntaxKind.LiteralExpr:
        return this.literal(node, expected);
      case SyntaxKind.NameExpr:
        return this.referenceInfo(node, this.targets.get(node), expected);
      case SyntaxKind.ParenExpr: {
        const inner = this.kids(node)[0];
        if (inner === undefined) return this.errorInfo(node);
        const info = this.expr(inner, expected);
        return this.finish(node, info.type, info);
      }
      case SyntaxKind.ArrowExpr:
        return this.arrow(node, this.contextOf(expected));
      case SyntaxKind.CallExpr:
        return this.call(node, expected);
      case SyntaxKind.FieldExpr:
        return this.fieldExpr(node);
      case SyntaxKind.BinaryExpr:
        return this.binary(node);
      case SyntaxKind.PipeExpr:
        return this.pipe(node, expected);
      case SyntaxKind.RecordExpr:
        return this.recordExpr(node, expected);
      case SyntaxKind.ListExpr:
        return this.listExpr(node, expected);
      case SyntaxKind.Block:
        return this.block(node, expected);
      case SyntaxKind.IfExpr:
        return this.ifExpr(node, expected);
      case SyntaxKind.MatchExpr:
        return this.match(node, expected);
      case SyntaxKind.TryExpr:
        return this.tryExpr(node, expected);
      default:
        return this.errorInfo(node);
    }
  }

  private argInfo(arg: Arg, expected?: TypeRef): NodeInfo {
    return arg.pre ?? this.expr(arg.node, expected);
  }

  // -------------------------------------------------------------- literals and names

  private literal(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const value = literalOf(this.tree, node);
    if (value === undefined) return this.errorInfo(node);
    return this.finish(node, this.literalType(value, expected), PURE_EFFECTS);
  }

  /** An expected literal alternative survives. Otherwise the literal takes its primitive. */
  private literalType(
    value: LiteralValue,
    expected: TypeRef | undefined,
  ): TypeRef {
    if (expected !== undefined) {
      const members = flattenMembers(this.table, expected).map((m) =>
        this.table.node(m)
      );
      if (members.some((m) => m.kind === "literal" && m.value === value)) {
        return this.table.literal(value);
      }
      if (typeof value === "number") {
        const hasInt = members.some((m) =>
          m.kind === "primitive" && m.name === "int"
        );
        const hasNumber = members.some((m) =>
          m.kind === "primitive" && m.name === "number"
        );
        if (hasNumber && !(hasInt && Number.isSafeInteger(value))) {
          return this.table.number;
        }
      }
    }
    return this.primitiveOf(value);
  }

  private referenceInfo(
    node: NodeId,
    target: Target | undefined,
    expected: TypeRef | undefined,
  ): NodeInfo {
    if (target === undefined) return this.errorInfo(node);
    switch (target.kind) {
      case "local": {
        if (this.pendingLocals.has(target.id)) {
          this.report(
            "execution-mode/003",
            "a local function cannot refer to itself; version 0 requires recursive functions to be module-level functions with explicit signatures",
            node,
          );
          return this.errorInfo(node);
        }
        return this.finish(
          node,
          this.body.locals.get(target.id) ?? this.table.error,
          PURE_EFFECTS,
        );
      }
      case "value":
      case "provider":
        return this.finish(node, this.benv.values(target.id), PURE_EFFECTS);
      case "builtin":
        if (target.name === "None") return this.none(node, expected);
        return this.errorInfo(node);
      default:
        return this.errorInfo(node);
    }
  }

  private none(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const element = this.optionElement(expected);
    const type = element === undefined
      ? this.table.option(this.table.never)
      : this.table.option(element);
    this.fact(node, { kind: "none" });
    return this.finish(node, type, PURE_EFFECTS);
  }

  // -------------------------------------------------------------- calls

  private call(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const kids = this.kids(node);
    const callee = kids[0];
    if (callee === undefined) return this.errorInfo(node);
    const argList = kids.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.ArgList
    );
    const args: Arg[] = argList === undefined
      ? []
      : this.kids(argList).map((n) => ({ node: n }));
    const calleeKind = kindOf(this.tree, callee);
    const target = calleeKind === SyntaxKind.NameExpr ||
        calleeKind === SyntaxKind.FieldExpr
      ? this.targets.get(callee)
      : undefined;
    return this.invoke(node, callee, target, false, args, expected);
  }

  /**
   * Checks a call. `callee` is the callee expression or, for a pipeline stage, the
   * qualified name. A target of `undefined` on an expression callee means the
   * callee is an ordinary expression that evaluates to a function.
   */
  private invoke(
    node: NodeId,
    callee: NodeId,
    target: Target | undefined,
    stage: boolean,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    if (target === undefined) {
      if (stage) return this.unresolvedCall(node, args);
      return this.apply(node, this.expr(callee), args);
    }
    switch (target.kind) {
      case "builtin":
        return this.builtinCall(node, target.name, args, expected);
      case "error":
        return this.errorConstruction(node, target.id, args);
      case "type":
        return this.brandConstruction(node, target.id, args);
      case "cap":
        return this.perform(node, target.id, args);
      case "local":
      case "value":
      case "provider":
        return this.apply(
          node,
          this.referenceInfo(callee, target, undefined),
          args,
        );
      default:
        return this.unresolvedCall(node, args);
    }
  }

  /** The callee could not be resolved. The arguments still get checked. */
  private unresolvedCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    const infos = args.map((a) => this.argInfo(a));
    this.errorCount++;
    return this.finish(node, this.table.error, combine(infos));
  }

  private apply(
    node: NodeId,
    callee: NodeInfo,
    args: readonly Arg[],
  ): NodeInfo {
    const fn = this.functionOf(callee.type);
    if (fn === undefined) {
      const infos = args.map((a) => this.argInfo(a));
      if (!this.isError(callee.type)) {
        this.report(
          "type-mismatch/008",
          `a value of type ${this.show(callee.type)} is not a function`,
          node,
        );
      }
      this.fact(node, { kind: "call" });
      return this.finish(
        node,
        this.table.error,
        combine([callee, ...infos]),
      );
    }
    this.fact(node, { kind: "call" });
    return this.applyFunction(node, fn, callee, args, PURE_EFFECTS);
  }

  private applyFunction(
    node: NodeId,
    fn: FunctionNode,
    base: EffectSet,
    args: readonly Arg[],
    extra: EffectSet,
  ): NodeInfo {
    if (args.length !== fn.parameters.length) {
      this.report(
        "type-mismatch/004",
        `the function takes ${fn.parameters.length} argument${
          fn.parameters.length === 1 ? "" : "s"
        }, but ${args.length} ${args.length === 1 ? "is" : "are"} given`,
        node,
      );
    }
    const infos = args.map((arg, i) => {
      const expected = fn.parameters[i];
      const info = this.argInfo(arg, expected);
      if (expected !== undefined) {
        this.fits(arg.node, info.type, expected, `argument ${i + 1}`);
      }
      return info;
    });
    const invocation: EffectSet = {
      failures: fn.failures,
      requirements: fn.requirements,
      mode: fn.execution,
    };
    return this.finish(
      node,
      fn.result,
      combine([base, ...infos, invocation, extra]),
    );
  }

  private perform(
    node: NodeId,
    capability: CapabilityId,
    args: readonly Arg[],
  ): NodeInfo {
    this.fact(node, { kind: "perform", capability });
    const fn = this.functionOf(this.benv.methodType(capability));
    if (fn === undefined) return this.unresolvedCall(node, args);
    return this.applyFunction(node, fn, PURE_EFFECTS, args, {
      failures: [],
      requirements: [capability],
      mode: "effect",
    });
  }

  /** True for `{ a: x, b }` without a spread. */
  private isPlainRecordLiteral(node: NodeId): boolean {
    if (kindOf(this.tree, node) === SyntaxKind.ParenExpr) {
      const inner = this.kids(node)[0];
      return inner !== undefined && this.isPlainRecordLiteral(inner);
    }
    if (kindOf(this.tree, node) !== SyntaxKind.RecordExpr) return false;
    return this.kids(node).every((field) =>
      kindOf(this.tree, field) !== SyntaxKind.SpreadField
    );
  }

  private errorConstruction(
    node: NodeId,
    id: ErrorId,
    args: readonly Arg[],
  ): NodeInfo {
    this.fact(node, { kind: "error-construction", error: id });
    const record = this.table.errorRecordOf(id);
    if (args.length !== 1) {
      this.report(
        "type-mismatch/004",
        `the error \`${
          shortName(id)
        }\` takes one record argument, but ${args.length} are given`,
        node,
      );
    }
    const infos = args.map((arg, i) => {
      const info = this.argInfo(arg, i === 0 ? record : undefined);
      if (i === 0) {
        const fits = this.fits(
          arg.node,
          info.type,
          record,
          `the argument of ${shortName(id)}`,
        );
        // The IR error node lists its fields, so the argument must be a record
        // literal without a spread.
        if (
          fits && !this.isError(info.type) &&
          !this.isPlainRecordLiteral(arg.node)
        ) {
          this.report(
            "type-mismatch/010",
            `the error \`${shortName(id)}\` needs a record literal such as ${
              shortName(id)
            }({ field: value })`,
            arg.node,
          );
        }
      }
      return info;
    });
    return this.finish(node, this.table.named(id), combine(infos));
  }

  private brandConstruction(
    node: NodeId,
    id: TypeId,
    args: readonly Arg[],
  ): NodeInfo {
    if (this.table.isOpaque(id)) {
      const infos = args.map((a) => this.argInfo(a));
      this.report(
        "type-mismatch/010",
        "an opaque type cannot be constructed in source",
        node,
      );
      return this.finish(node, this.table.error, combine(infos));
    }
    const base = this.table.brandBaseOf(id);
    if (base === undefined) {
      const infos = args.map((a) => this.argInfo(a));
      this.report(
        "type-mismatch/010",
        `\`${
          shortName(id)
        }\` is a type alias, not a brand; only a brand can be used as a constructor`,
        node,
      );
      return this.finish(node, this.table.error, combine(infos));
    }
    this.fact(node, { kind: "brand-construction", brand: id });
    if (args.length !== 1) {
      this.report(
        "type-mismatch/004",
        `the brand \`${
          shortName(id)
        }\` takes one argument, but ${args.length} are given`,
        node,
      );
    }
    const infos = args.map((arg, i) => {
      const info = this.argInfo(arg, i === 0 ? base : undefined);
      if (i === 0) {
        this.fits(arg.node, info.type, base, `the value of ${shortName(id)}`);
      }
      return info;
    });
    return this.finish(node, this.table.named(id), combine(infos));
  }

  // -------------------------------------------------------------- prelude calls

  private builtinCall(
    node: NodeId,
    name: string,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    switch (name) {
      case "fail":
        return this.failCall(node, args);
      case "retry":
        return this.retryCall(node, args);
      case "retrySchedule":
        return this.retryScheduleCall(node, args, expected);
      case "codec":
        return this.codecCall(node, args);
      case "decode":
      case "encode":
        return this.codecOperation(node, name, args);
      case "withFiber":
        return this.withFiberCall(node, args, expected);
      case "joinFiber":
      case "interruptFiber":
        return this.fiberOperation(node, name, args);
      case "provide":
        return this.provideCall(node, args);
      case "defer":
        return this.deferCall(node, args);
      case "run":
        return this.runCall(node, args);
      case "scoped":
        return this.scopedCall(node, args);
      case "forkScoped":
        return this.forkScopedCall(node, args);
      case "withResource":
        return this.withResourceCall(node, args, expected);
      case "unfold":
        return this.unfoldCall(node, args);
      case "mapEffect":
        return this.mapEffectCall(node, args);
      case "flatMapStreams":
        return this.flatMapStreamsCall(node, args);
      case "sinkForEach":
        return this.sinkForEachCall(node, args);
      case "runStream":
        return this.runStreamCall(node, args);
      case "bufferStream":
        return this.bufferStreamCall(node, args);
      case "mergeStreams":
        return this.mergeStreamsCall(node, args);
      case "zipStreams":
        return this.zipStreamsCall(node, args);
      case "concatStreams":
        return this.concatStreamsCall(node, args);
      case "race":
        return this.raceCall(node, args);
      case "makeRef":
      case "getRef":
      case "setRef":
      case "updateRef":
        return this.refCall(node, name, args);
      case "layer":
        return this.layerCall(node, args);
      case "mergeLayers":
        return this.mergeLayersCall(node, args);
      case "unbrand":
        return this.unbrandCall(node, args);
      case "Some":
        return this.someCall(node, args, expected);
      case "all":
        return this.allCall(node, args);
      case "partitionAll":
        return this.partitionAllCall(node, args);
      case "validateAll":
        return this.validateAllCall(node, args);
      case "map":
      case "filter":
      case "fold":
      case "traverse":
        return this.collectionCall(node, name, args, expected);
      default: {
        const infos = args.map((a) => this.argInfo(a));
        this.report(
          "type-mismatch/008",
          `\`${name}\` is a value, not a function`,
          node,
        );
        return this.finish(node, this.table.error, combine(infos));
      }
    }
  }

  /** Reports a wrong argument count for a prelude call. Returns true when the count is right. */
  private arity(
    node: NodeId,
    name: string,
    expectedCount: number,
    args: readonly Arg[],
  ): boolean {
    if (args.length === expectedCount) return true;
    this.report(
      "type-mismatch/004",
      `\`${name}\` takes ${expectedCount} argument${
        expectedCount === 1 ? "" : "s"
      }, but ${args.length} ${args.length === 1 ? "is" : "are"} given`,
      node,
    );
    return false;
  }

  private failCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "fail" });
    const rightCount = this.arity(node, "fail", 1, args);
    const infos = args.map((a) => this.argInfo(a));
    let failure: ErrorId | undefined;
    if (rightCount) {
      const unfolded = this.table.node(this.table.unfold(infos[0].type));
      if (unfolded.kind === "named" && unfolded.id.startsWith("error:")) {
        failure = unfolded.id as ErrorId;
      } else if (!this.isError(infos[0].type)) {
        this.report(
          "type-mismatch/010",
          `\`fail\` needs a value of a named error type, but the value has type ${
            this.show(infos[0].type)
          }`,
          args[0].node,
        );
      }
    }
    const own: EffectSet = {
      failures: failure === undefined ? [] : [failure],
      requirements: [],
      mode: "effect",
    };
    return this.finish(node, this.table.never, combine([...infos, own]));
  }

  private unbrandCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "unbrand" });
    const rightCount = this.arity(node, "unbrand", 1, args);
    const infos = args.map((a) => this.argInfo(a));
    let type = this.table.error;
    if (rightCount) {
      const unfolded = this.table.node(this.table.unfold(infos[0].type));
      if (
        unfolded.kind === "named" && unfolded.id.startsWith("type:") &&
        this.table.isOpaque(unfolded.id as TypeId)
      ) {
        this.report(
          "type-mismatch/010",
          "an opaque type cannot be unbranded in source",
          args[0].node,
        );
        return this.finish(node, this.table.error, combine(infos));
      }
      const base = unfolded.kind === "named"
        ? this.table.brandBaseOf(unfolded.id as TypeId)
        : undefined;
      if (base !== undefined) {
        type = base;
      } else if (!this.isError(infos[0].type)) {
        this.report(
          "type-mismatch/010",
          `\`unbrand\` needs a brand value, but the value has type ${
            this.show(infos[0].type)
          }`,
          args[0].node,
        );
      }
    }
    return this.finish(node, type, combine(infos));
  }

  private someCall(
    node: NodeId,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    this.fact(node, { kind: "some" });
    const rightCount = this.arity(node, "Some", 1, args);
    const hint = this.optionElement(expected);
    const infos = args.map((a, i) =>
      this.argInfo(a, i === 0 ? hint : undefined)
    );
    const type = rightCount
      ? this.table.option(infos[0].type)
      : this.table.error;
    return this.finish(node, type, combine(infos));
  }

  /** The literal count of `{ times: N }`, or undefined after a diagnostic. */
  private retryTimes(arg: Arg): number | undefined {
    const bad = (): undefined => {
      this.report(
        "type-mismatch/010",
        "`retry` needs `{ times: N }`, where N is a finite nonnegative safe integer literal",
        arg.node,
      );
      return undefined;
    };
    if (arg.pre !== undefined) return bad();
    if (kindOf(this.tree, arg.node) !== SyntaxKind.RecordExpr) return bad();
    const fields = this.kids(arg.node);
    if (fields.length !== 1) return bad();
    const field = fields[0];
    if (kindOf(this.tree, field) !== SyntaxKind.RecordField) return bad();
    const parts = this.kids(field);
    const label = parts.find((k) => kindOf(this.tree, k) === SyntaxKind.Name);
    const valueNode = parts.find((k) => k !== label);
    if (
      label === undefined || valueNode === undefined ||
      nameTextOf(this.tree, label) !== "times" ||
      kindOf(this.tree, valueNode) !== SyntaxKind.LiteralExpr
    ) return bad();
    const value = literalOf(this.tree, valueNode);
    if (
      typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    ) return bad();
    this.finish(
      valueNode,
      this.table.int,
      PURE_EFFECTS,
    );
    this.finish(
      arg.node,
      this.table.record([{
        name: "times",
        type: this.table.int,
        optional: false,
      }]),
      PURE_EFFECTS,
    );
    return value;
  }

  /** The zero-argument function type of a `retry` or `provide` job, or undefined after a diagnostic. */
  private jobFunction(
    name: string,
    arg: Arg,
    info: NodeInfo,
  ): FunctionNode | undefined {
    const fn = this.functionOf(info.type);
    if (fn === undefined) {
      if (!this.isError(info.type)) {
        this.report(
          "type-mismatch/010",
          `\`${name}\` needs a function that takes no arguments, but the job has type ${
            this.show(info.type)
          }`,
          arg.node,
        );
      }
      return undefined;
    }
    if (fn.parameters.length > 0) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` needs a function that takes no arguments, but the job takes ${fn.parameters.length}`,
        arg.node,
      );
      return undefined;
    }
    return fn;
  }

  private retryCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (!this.arity(node, "retry", 2, args)) {
      this.fact(node, { kind: "retry", times: undefined });
      const infos = args.map((a) => this.argInfo(a));
      return this.finish(
        node,
        this.table.error,
        combine([...infos, EFFECT_ONLY]),
      );
    }
    const job = this.argInfo(args[0]);
    const fn = this.jobFunction("retry", args[0], job);
    if (this.retryScheduleOption(args[1])) {
      const options = this.argInfo(args[1]);
      const shape = this.table.node(this.table.unfold(options.type));
      const policy = shape.kind === "record"
        ? this.table.node(this.table.unfold(shape.fields[0].type))
        : undefined;
      if (policy?.kind !== "retry-schedule") {
        this.report(
          "type-mismatch/010",
          "`retry` needs a RetrySchedule in `schedule`",
          args[1].node,
        );
      } else if (fn !== undefined) {
        for (const failure of fn.failures) {
          if (
            !this.table.isAssignable(this.table.named(failure), policy.error)
          ) {
            this.report(
              "type-mismatch/003",
              `the retry schedule does not accept ${failure}`,
              args[1].node,
            );
          }
        }
      }
      this.fact(node, { kind: "retry-with-schedule" });
      const invocation: EffectSet = fn === undefined ? PURE_EFFECTS : {
        failures: fn.failures,
        requirements: fn.requirements,
        mode: fn.execution,
      };
      return this.finish(
        node,
        fn?.result ?? this.table.error,
        combine([job, options, invocation, EFFECT_ONLY]),
      );
    }
    const times = this.retryTimes(args[1]);
    this.fact(node, { kind: "retry", times });
    const invocation: EffectSet = fn === undefined ? PURE_EFFECTS : {
      failures: fn.failures,
      requirements: fn.requirements,
      mode: fn.execution,
    };
    return this.finish(
      node,
      fn?.result ?? this.table.error,
      combine([job, invocation, EFFECT_ONLY]),
    );
  }

  private retryScheduleOption(arg: Arg): boolean {
    if (
      arg.pre !== undefined ||
      kindOf(this.tree, arg.node) !== SyntaxKind.RecordExpr
    ) return false;
    const fields = this.kids(arg.node);
    if (
      fields.length !== 1 ||
      kindOf(this.tree, fields[0]) !== SyntaxKind.RecordField
    ) return false;
    const name = this.kids(fields[0]).find((k) =>
      kindOf(this.tree, k) === SyntaxKind.Name
    );
    return name !== undefined && nameTextOf(this.tree, name) === "schedule";
  }

  private retryScheduleCall(
    node: NodeId,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    this.fact(node, { kind: "retry-schedule" });
    if (!this.arity(node, "retrySchedule", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    const expectedType = expected === undefined
      ? undefined
      : this.table.node(this.table.unfold(expected));
    const errorHint = expectedType?.kind === "retry-schedule"
      ? expectedType.error
      : undefined;
    const info = errorHint === undefined
      ? this.argInfo(args[0])
      : this.callback(
        "retrySchedule",
        args[0],
        [errorHint, this.table.int],
        this.table.option(this.table.int),
      ).info;
    const fn = this.functionOf(info.type);
    if (fn === undefined) {
      if (!this.isError(info.type)) {
        this.report(
          "type-mismatch/010",
          "`retrySchedule` needs a function",
          args[0].node,
        );
      }
      return this.finish(node, this.table.error, combine([info]));
    }
    if (fn.parameters.length !== 2) {
      this.report(
        "type-mismatch/004",
        "the retry schedule callback takes an error and an attempt number",
        args[0].node,
      );
      return this.finish(node, this.table.error, combine([info]));
    }
    const error = this.table.node(this.table.unfold(fn.parameters[0]));
    if (error.kind !== "named" || !error.id.startsWith("error:")) {
      this.report(
        "type-mismatch/010",
        "the retry schedule callback needs a nominal error parameter",
        args[0].node,
      );
    }
    this.fits(
      args[0].node,
      fn.parameters[1],
      this.table.int,
      "the retry attempt number",
    );
    this.fits(
      args[0].node,
      fn.result,
      this.table.option(this.table.int),
      "the retry delay",
    );
    if (
      fn.execution !== "pure" || fn.failures.length > 0 ||
      fn.requirements.length > 0
    ) {
      this.report(
        "execution-mode/001",
        "the retry schedule callback must be pure",
        args[0].node,
      );
    }
    const type = error.kind === "named" && error.id.startsWith("error:")
      ? this.table.retrySchedule(fn.parameters[0])
      : this.table.error;
    return this.finish(node, type, combine([info]));
  }

  private codecCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "codec" });
    if (!this.arity(node, "codec", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("codec", args);
    const decode = this.argInfo(args[0]);
    const encode = this.argInfo(args[1]);
    const d = this.functionOf(decode.type);
    const e = this.functionOf(encode.type);
    if (
      d === undefined || e === undefined || d.parameters.length !== 1 ||
      e.parameters.length !== 1
    ) {
      this.report(
        "type-mismatch/010",
        "`codec` needs two single-argument functions",
        node,
      );
      return this.finish(node, this.table.error, combine([decode, encode]));
    }
    if (
      d.execution !== "pure" || e.execution !== "pure" || d.failures.length ||
      d.requirements.length || e.failures.length || e.requirements.length
    ) {
      this.report(
        "execution-mode/001",
        "codec transformations must be pure",
        node,
      );
    }
    const decoded = this.widen(d.result);
    const encoded = this.widen(d.parameters[0]);
    if (
      !this.table.isAssignable(decoded, e.parameters[0]) ||
      !this.table.isAssignable(e.result, encoded)
    ) {
      this.report(
        "type-mismatch/003",
        "codec encode transformation must reverse the decode types",
        args[1].node,
      );
    }
    if (!this.dataOnly(decoded) || !this.dataOnly(encoded)) {
      this.report(
        "type-mismatch/010",
        "codec types need compiler-derived schemas",
        node,
      );
    }
    return this.finish(
      node,
      this.table.codec(decoded, encoded),
      combine([decode, encode]),
    );
  }

  private codecOperation(
    node: NodeId,
    name: string,
    args: readonly Arg[],
  ): NodeInfo {
    this.fact(node, { kind: name === "decode" ? "decode" : "encode" });
    if (!this.arity(node, name, 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline(name, args);
    const codec = this.argInfo(args[0]);
    const type = this.table.node(this.table.unfold(codec.type));
    if (type.kind !== "codec" && !this.isError(codec.type)) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` needs a Codec value`,
        args[0].node,
      );
    }
    const input = this.argInfo(
      args[1],
      name === "encode" && type.kind === "codec" ? type.decoded : undefined,
    );
    if (name === "encode" && type.kind === "codec") {
      this.fits(args[1].node, input.type, type.decoded, "the codec input");
    }
    const result = type.kind === "codec"
      ? this.table.option(name === "decode" ? type.decoded : type.encoded)
      : this.table.error;
    return this.finish(node, result, combine([codec, input]));
  }

  private withFiberCall(
    node: NodeId,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    this.fact(node, { kind: "with-fiber" });
    if (!this.arity(node, "withFiber", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((a) => this.argInfo(a)), EFFECT_ONLY]),
      );
    }
    this.noPipeline("withFiber", args);
    const job = this.argInfo(args[0]);
    const effect = this.table.node(this.table.unfold(job.type));
    if (effect.kind !== "effect") {
      this.report(
        "type-mismatch/010",
        "`withFiber` needs an Effect value",
        args[0].node,
      );
      return this.finish(
        node,
        this.table.error,
        combine([job, this.argInfo(args[1]), EFFECT_ONLY]),
      );
    }
    if (
      args[1].pre !== undefined ||
      kindOf(this.tree, args[1].node) !== SyntaxKind.ArrowExpr
    ) {
      this.report(
        "type-mismatch/010",
        "`withFiber` needs an inline use callback",
        args[1].node,
      );
    }
    const fiber = this.table.fiber(effect.result, effect.failures);
    const use = this.callback("withFiber", args[1], [fiber], expected, true);
    if (!this.dataOnly(use.result)) {
      this.report(
        "type-mismatch/010",
        "the fiber use result must be data only",
        args[1].node,
      );
    }
    const fact = this.body.facts.get(args[1].node);
    if (fact?.kind === "arrow" && fact.parameters[0]?.id !== undefined) {
      const body = this.kids(args[1].node).at(-1);
      if (body !== undefined) this.scopedFiberUses(body, fact.parameters[0].id);
    }
    const useFn = this.functionOf(use.info.type);
    const invocation: EffectSet = useFn === undefined ? PURE_EFFECTS : {
      failures: useFn.failures,
      requirements: useFn.requirements,
      mode: useFn.execution,
    };
    return this.finish(
      node,
      use.result,
      combine([
        job,
        use.info,
        { failures: [], requirements: effect.requirements, mode: "effect" },
        invocation,
        EFFECT_ONLY,
      ]),
    );
  }

  private fiberOperation(
    node: NodeId,
    name: string,
    args: readonly Arg[],
  ): NodeInfo {
    this.fact(node, {
      kind: name === "joinFiber" ? "join-fiber" : "interrupt-fiber",
    });
    if (!this.arity(node, name, 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((a) => this.argInfo(a)), EFFECT_ONLY]),
      );
    }
    const ref = this.argInfo(args[0]);
    const fiber = this.table.node(this.table.unfold(ref.type));
    if (fiber.kind !== "fiber") {
      if (!this.isError(ref.type)) {
        this.report(
          "type-mismatch/010",
          `\`${name}\` needs a Fiber value`,
          args[0].node,
        );
      }
      return this.finish(node, this.table.error, combine([ref, EFFECT_ONLY]));
    }
    return this.finish(
      node,
      name === "joinFiber" ? fiber.result : this.table.unit,
      combine([
        ref,
        name === "joinFiber"
          ? { failures: fiber.failures, requirements: [], mode: "effect" }
          : EFFECT_ONLY,
      ]),
    );
  }

  private scopedFiberUses(body: NodeId, id: LocalId): void {
    const visit = (
      node: NodeId,
      parent: NodeId | undefined,
      grandparent: NodeId | undefined,
      nested: boolean,
    ): void => {
      if (kindOf(this.tree, node) === SyntaxKind.NameExpr) {
        const target = this.targets.get(node);
        if (target?.kind === "local" && target.id === id) {
          const call = parent !== undefined &&
              kindOf(this.tree, parent) === SyntaxKind.CallExpr
            ? parent
            : parent !== undefined &&
                kindOf(this.tree, parent) === SyntaxKind.ArgList &&
                grandparent !== undefined &&
                kindOf(this.tree, grandparent) === SyntaxKind.CallExpr
            ? grandparent
            : undefined;
          const callee = call === undefined ? undefined : this.kids(call)[0];
          const called = callee === undefined
            ? undefined
            : this.targets.get(callee);
          if (
            nested || callee === undefined ||
            (parent !== call &&
              (parent === undefined || this.kids(parent).length !== 1 ||
                this.kids(parent)[0] !== node)) ||
            called?.kind !== "builtin" ||
            (called.name !== "joinFiber" && called.name !== "interruptFiber")
          ) {
            this.report(
              "type-mismatch/010",
              "a borrowed fiber may only be joined or interrupted directly",
              node,
            );
          }
        }
      }
      for (const child of this.kids(node)) {
        visit(
          child,
          node,
          parent,
          nested || kindOf(this.tree, node) === SyntaxKind.ArrowExpr,
        );
      }
    };
    visit(body, undefined, undefined, false);
  }

  private deferCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "defer" });
    if (!this.arity(node, "defer", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    const job = this.argInfo(args[0]);
    const fn = this.jobFunction("defer", args[0], job);
    return this.finish(
      node,
      fn === undefined
        ? this.table.error
        : this.table.effect(fn.result, fn.failures, fn.requirements),
      job,
    );
  }

  private runCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "run" });
    if (!this.arity(node, "run", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((a) => this.argInfo(a)), EFFECT_ONLY]),
      );
    }
    const value = this.argInfo(args[0]);
    const type = this.table.node(this.table.unfold(value.type));
    if (type.kind !== "effect") {
      if (!this.isError(value.type)) {
        this.report(
          "type-mismatch/010",
          `\`run\` needs an Effect value, but the argument has type ${
            this.show(value.type)
          }`,
          args[0].node,
        );
      }
      return this.finish(node, this.table.error, combine([value, EFFECT_ONLY]));
    }
    return this.finish(
      node,
      type.result,
      combine([
        value,
        {
          failures: type.failures,
          requirements: type.requirements,
          mode: "effect",
        },
      ]),
    );
  }

  private scopedCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "scoped" });
    if (!this.arity(node, "scoped", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((arg) => this.argInfo(arg)), EFFECT_ONLY]),
      );
    }
    const value = this.argInfo(args[0]);
    const effect = this.table.node(this.table.unfold(value.type));
    if (effect.kind !== "effect") {
      this.report(
        "type-mismatch/010",
        "`scoped` needs an Effect value",
        args[0].node,
      );
      return this.finish(node, this.table.error, combine([value, EFFECT_ONLY]));
    }
    return this.finish(
      node,
      effect.result,
      combine([value, {
        failures: effect.failures,
        requirements: without(effect.requirements, [SCOPE_CAPABILITY]),
        mode: "effect",
      }]),
    );
  }

  private forkScopedCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "fork-scoped" });
    if (!this.arity(node, "forkScoped", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((arg) => this.argInfo(arg)), EFFECT_ONLY]),
      );
    }
    const job = this.argInfo(args[0]);
    const effect = this.table.node(this.table.unfold(job.type));
    if (effect.kind !== "effect") {
      this.report(
        "type-mismatch/010",
        "`forkScoped` needs an Effect value",
        args[0].node,
      );
      return this.finish(node, this.table.error, combine([job, EFFECT_ONLY]));
    }
    if (effect.failures.length > 0) {
      this.report(
        "type-mismatch/010",
        "`forkScoped` needs an Effect value without typed failures",
        args[0].node,
      );
    }
    return this.finish(
      node,
      this.table.unit,
      combine([job, {
        failures: [],
        requirements: [...effect.requirements, SCOPE_CAPABILITY],
        mode: "effect",
      }]),
    );
  }

  /** A scoped handle is usable only as `handle.operation(...)`. */
  private scopedUses(body: NodeId, id: LocalId): void {
    const visit = (
      node: NodeId,
      parent: NodeId | undefined,
      grandparent: NodeId | undefined,
      nested: boolean,
    ): void => {
      if (kindOf(this.tree, node) === SyntaxKind.NameExpr) {
        const target = this.targets.get(node);
        if (target?.kind === "local" && target.id === id) {
          const directField = parent !== undefined &&
            kindOf(this.tree, parent) === SyntaxKind.FieldExpr &&
            this.kids(parent)[0] === node;
          const directCall = grandparent !== undefined &&
            kindOf(this.tree, grandparent) === SyntaxKind.CallExpr &&
            this.kids(grandparent)[0] === parent;
          if (nested || !directField || !directCall) {
            this.report(
              "type-mismatch/010",
              "a scoped operation record may only be used as the direct receiver of an operation call",
              node,
            );
          }
        }
      }
      for (const child of this.kids(node)) {
        visit(
          child,
          node,
          parent,
          nested || kindOf(this.tree, node) === SyntaxKind.ArrowExpr,
        );
      }
    };
    visit(body, undefined, undefined, false);
  }

  private dataOnly(ref: TypeRef, seen = new Set<TypeRef>()): boolean {
    const unfolded = this.table.unfold(ref);
    if (seen.has(unfolded)) return true;
    seen.add(unfolded);
    const type = this.table.node(unfolded);
    switch (type.kind) {
      case "primitive":
        return type.name !== "unknown";
      case "literal":
        return true;
      case "record":
        return type.fields.every((f) => this.dataOnly(f.type, seen));
      case "array":
      case "option":
        return this.dataOnly(type.element, seen);
      case "tuple":
        return type.elements.every((element) => this.dataOnly(element, seen));
      case "union":
        return type.members.every((member) => this.dataOnly(member, seen));
      case "named": {
        const record = type.id.startsWith("error:")
          ? this.table.errorRecordOf(type.id as ErrorId)
          : this.table.brandBaseOf(type.id as TypeId);
        return record !== undefined && this.dataOnly(record, seen);
      }
      default:
        return false;
    }
  }

  private operationRecord(ref: TypeRef, node: NodeId): boolean {
    const type = this.table.node(this.table.unfold(ref));
    if (
      type.kind !== "record" || type.fields.length === 0 ||
      type.fields.some((f) => f.optional)
    ) {
      this.report(
        "type-mismatch/010",
        "acquisition must return a nonempty record of required operations",
        node,
      );
      return false;
    }
    let valid = true;
    for (const field of type.fields) {
      const fn = this.functionOf(field.type);
      if (
        fn === undefined || !fn.parameters.every((p) => this.dataOnly(p)) ||
        !this.dataOnly(fn.result)
      ) {
        this.report(
          "type-mismatch/010",
          `operation ${field.name} must take and return data-only values`,
          node,
        );
        valid = false;
      }
    }
    return valid;
  }

  private withResourceCall(
    node: NodeId,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    this.fact(node, { kind: "with-resource" });
    if (!this.arity(node, "withResource", 3, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    for (const arg of args) {
      if (
        arg.pre !== undefined ||
        kindOf(this.tree, arg.node) !== SyntaxKind.ArrowExpr
      ) {
        this.report(
          "type-mismatch/010",
          "withResource requires three inline arrow callbacks",
          arg.node,
        );
      }
    }
    const acquire = this.callback("withResource", args[0], [], undefined, true);
    const opaque = this.opaqueHandle(acquire.result);
    if (!opaque) this.operationRecord(acquire.result, args[0].node);
    const use = this.callback(
      "withResource",
      args[1],
      [acquire.result],
      expected,
      true,
    );
    const release = this.callback(
      "withResource",
      args[2],
      [acquire.result],
      this.table.unit,
      true,
    );
    this.fits(
      args[2].node,
      release.result,
      this.table.unit,
      "the release result",
    );
    if (!this.dataOnly(use.result)) {
      this.report(
        "type-mismatch/010",
        "the use result must be data only",
        args[1].node,
      );
    }
    for (const arg of [args[1], args[2]]) {
      const fact = this.body.facts.get(arg.node);
      if (fact?.kind === "arrow" && fact.parameters[0]?.id !== undefined) {
        const body = this.kids(arg.node).at(-1);
        if (body !== undefined) {
          if (opaque) this.scopedBorrowUses(body, fact.parameters[0].id);
          else this.scopedUses(body, fact.parameters[0].id);
        }
      }
    }
    const invoked = [acquire.info, use.info, release.info].map((info) => {
      const fn = this.functionOf(info.type);
      return fn === undefined ? PURE_EFFECTS : {
        failures: fn.failures,
        requirements: fn.requirements,
        mode: fn.execution,
      };
    });
    return this.finish(
      node,
      use.result,
      combine([
        acquire.info,
        use.info,
        release.info,
        ...invoked,
        EFFECT_ONLY,
      ]),
    );
  }

  private opaqueHandle(ref: TypeRef): boolean {
    const type = this.table.node(this.table.unfold(ref));
    return type.kind === "named" && type.id.startsWith("type:") &&
      this.table.isOpaque(type.id as TypeId);
  }

  private scopedBorrowUses(body: NodeId, id: LocalId): void {
    const visit = (
      node: NodeId,
      parent: NodeId | undefined,
      grandparent: NodeId | undefined,
      nested: boolean,
    ): void => {
      if (kindOf(this.tree, node) === SyntaxKind.NameExpr) {
        const target = this.targets.get(node);
        if (target?.kind === "local" && target.id === id) {
          const call = parent !== undefined &&
              kindOf(this.tree, parent) === SyntaxKind.ArgList &&
              grandparent !== undefined &&
              kindOf(this.tree, grandparent) === SyntaxKind.CallExpr
            ? grandparent
            : undefined;
          const callee = call === undefined ? undefined : this.kids(call)[0];
          const method = callee === undefined
            ? undefined
            : this.targets.get(callee);
          const index = parent === undefined
            ? -1
            : this.kids(parent).indexOf(node);
          const capability = method?.kind === "cap" ? method.id : undefined;
          const serviceId = capability === undefined
            ? undefined
            : `service:${
              capability.slice(4, capability.lastIndexOf("."))
            }` as ServiceId;
          const signature = serviceId === undefined
            ? undefined
            : this.benv.env.services.get(serviceId)?.methods.find((m) =>
              m.id === capability
            );
          const functionType = method?.kind === "value"
            ? this.functionOf(this.benv.values(method.id))
            : undefined;
          const borrowed = signature?.borrows?.[index] === true ||
            functionType?.borrows?.[index] === true;
          if (nested || index < 0 || !borrowed) {
            this.report(
              "type-mismatch/010",
              "a borrowed handle may only pass to a borrow-qualified method",
              node,
            );
          }
        }
      }
      for (const child of this.kids(node)) {
        visit(
          child,
          node,
          parent,
          nested || kindOf(this.tree, node) === SyntaxKind.ArrowExpr,
        );
      }
    };
    visit(body, undefined, undefined, false);
  }

  checkBorrowedParameter(
    body: NodeId | undefined,
    parameter: {
      readonly id: LocalId | undefined;
      readonly type: { readonly ref: TypeRef };
    },
    result: TypeRef,
  ): void {
    if (parameter.id === undefined) return;
    if (!this.opaqueHandle(parameter.type.ref)) {
      this.report(
        "type-mismatch/010",
        "a borrow parameter needs an opaque type",
        body ?? this.tree.root,
      );
    }
    if (!this.dataOnly(result)) {
      this.report(
        "type-mismatch/010",
        "a borrow function must return data only",
        body ?? this.tree.root,
      );
    }
    if (body !== undefined) this.scopedBorrowUses(body, parameter.id);
  }

  private noPipeline(name: string, args: readonly Arg[]): void {
    if (args[0]?.pre !== undefined) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` requires direct call syntax`,
        args[0].node,
      );
    }
  }

  private inlineStreamCallback(name: string, arg: Arg): void {
    if (
      arg.pre !== undefined ||
      kindOf(this.tree, arg.node) !== SyntaxKind.ArrowExpr
    ) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` requires an inline arrow callback`,
        arg.node,
      );
    }
  }

  private unfoldCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "unfold" });
    if (!this.arity(node, "unfold", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("unfold", args);
    this.inlineStreamCallback("unfold", args[1]);
    const seed = this.argInfo(args[0]);
    const state = this.widen(seed.type);
    const next = this.callback("unfold", args[1], [state], undefined, true);
    const fn = this.functionOf(next.info.type);
    const option = this.table.node(this.table.unfold(next.result));
    const pair = option.kind === "option"
      ? this.table.node(this.table.unfold(option.element))
      : undefined;
    let element = this.table.error;
    if (pair?.kind !== "tuple" || pair.elements.length !== 2) {
      if (!this.isError(next.result)) {
        this.report(
          "type-mismatch/010",
          "`unfold` callback must return Option<[Element, State]>",
          args[1].node,
        );
      }
    } else {
      element = pair.elements[0];
      this.fits(args[1].node, pair.elements[1], state, "the next stream state");
    }
    const type = this.table.stream(
      element,
      fn?.failures ?? [],
      fn?.requirements ?? [],
    );
    return this.finish(node, type, combine([seed, next.info]));
  }

  private mapEffectCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "map-effect" });
    if (!this.arity(node, "mapEffect", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("mapEffect", args);
    this.inlineStreamCallback("mapEffect", args[1]);
    const stream = this.argInfo(args[0]);
    const source = this.table.node(this.table.unfold(stream.type));
    if (source.kind !== "stream" && !this.isError(stream.type)) {
      this.report(
        "type-mismatch/010",
        "`mapEffect` needs a Stream value",
        args[0].node,
      );
    }
    const element = source.kind === "stream"
      ? source.element
      : this.table.error;
    const transform = this.callback(
      "mapEffect",
      args[1],
      [element],
      undefined,
      true,
    );
    const fn = this.functionOf(transform.info.type);
    const type = this.table.stream(
      transform.result,
      [
        ...(source.kind === "stream" ? source.failures : []),
        ...(fn?.failures ?? []),
      ],
      [
        ...(source.kind === "stream" ? source.requirements : []),
        ...(fn?.requirements ?? []),
      ],
    );
    return this.finish(node, type, combine([stream, transform.info]));
  }

  private flatMapStreamsCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "flat-map-streams" });
    if (!this.arity(node, "flatMapStreams", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    this.noPipeline("flatMapStreams", args);
    this.inlineStreamCallback("flatMapStreams", args[1]);
    const stream = this.argInfo(args[0]);
    const source = this.table.node(this.table.unfold(stream.type));
    if (source.kind !== "stream" && !this.isError(stream.type)) {
      this.report(
        "type-mismatch/010",
        "`flatMapStreams` needs a Stream value",
        args[0].node,
      );
    }
    const element = source.kind === "stream"
      ? source.element
      : this.table.error;
    const transform = this.callback(
      "flatMapStreams",
      args[1],
      [element],
      undefined,
    );
    const inner = this.table.node(this.table.unfold(transform.result));
    if (inner.kind !== "stream" && !this.isError(transform.result)) {
      this.report(
        "type-mismatch/010",
        "`flatMapStreams` callback must return a Stream value",
        args[1].node,
      );
    }
    const type = this.table.stream(
      inner.kind === "stream" ? inner.element : this.table.error,
      [
        ...(source.kind === "stream" ? source.failures : []),
        ...(inner.kind === "stream" ? inner.failures : []),
      ],
      [
        ...(source.kind === "stream" ? source.requirements : []),
        ...(inner.kind === "stream" ? inner.requirements : []),
      ],
    );
    return this.finish(node, type, combine([stream, transform.info]));
  }

  private sinkForEachCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "sink-for-each" });
    if (!this.arity(node, "sinkForEach", 1, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("sinkForEach", args);
    this.inlineStreamCallback("sinkForEach", args[0]);
    const consume = this.argInfo(args[0]);
    const fn = this.functionOf(consume.type);
    if (fn === undefined || fn.parameters.length !== 1) {
      if (!this.isError(consume.type)) {
        this.report(
          "type-mismatch/010",
          "`sinkForEach` needs a one-argument callback with an annotated input",
          args[0].node,
        );
      }
      return this.finish(node, this.table.error, consume);
    }
    this.fits(
      args[0].node,
      fn.result,
      this.table.unit,
      "the sink callback result",
    );
    const type = this.table.sink(
      fn.parameters[0],
      this.table.unit,
      fn.failures,
      fn.requirements,
    );
    return this.finish(node, type, consume);
  }

  private runStreamCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "run-stream" });
    if (!this.arity(node, "runStream", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((a) => this.argInfo(a)), EFFECT_ONLY]),
      );
    }
    this.noPipeline("runStream", args);
    const stream = this.argInfo(args[0]);
    const sink = this.argInfo(args[1]);
    const producer = this.table.node(this.table.unfold(stream.type));
    const consumer = this.table.node(this.table.unfold(sink.type));
    if (producer.kind !== "stream" && !this.isError(stream.type)) {
      this.report(
        "type-mismatch/010",
        "`runStream` needs a Stream as its first argument",
        args[0].node,
      );
    }
    if (consumer.kind !== "sink" && !this.isError(sink.type)) {
      this.report(
        "type-mismatch/010",
        "`runStream` needs a Sink as its second argument",
        args[1].node,
      );
    }
    if (producer.kind !== "stream" || consumer.kind !== "sink") {
      return this.finish(
        node,
        this.table.error,
        combine([stream, sink, EFFECT_ONLY]),
      );
    }
    this.fits(args[1].node, producer.element, consumer.input, "the sink input");
    return this.finish(
      node,
      consumer.result,
      combine([stream, sink, {
        failures: [...producer.failures, ...consumer.failures],
        requirements: [...producer.requirements, ...consumer.requirements],
        mode: "effect",
      }]),
    );
  }

  private bufferStreamCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (!this.arity(node, "bufferStream", 2, args)) {
      this.fact(node, { kind: "buffer-stream", capacity: undefined });
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("bufferStream", args);
    const stream = this.argInfo(args[0]);
    const source = this.table.node(this.table.unfold(stream.type));
    if (source.kind !== "stream" && !this.isError(stream.type)) {
      this.report(
        "type-mismatch/010",
        "`bufferStream` needs a Stream value",
        args[0].node,
      );
    }
    const capacity = this.streamBufferCapacity(args[1]);
    this.fact(node, { kind: "buffer-stream", capacity });
    return this.finish(node, stream.type, stream);
  }

  private streamBufferCapacity(arg: Arg): number | undefined {
    const bad = (): undefined => {
      this.report(
        "type-mismatch/010",
        "`bufferStream` needs `{ capacity: N }` with a positive safe integer literal",
        arg.node,
      );
      return undefined;
    };
    if (
      arg.pre !== undefined ||
      kindOf(this.tree, arg.node) !== SyntaxKind.RecordExpr
    ) return bad();
    const fields = this.kids(arg.node);
    if (
      fields.length !== 1 ||
      kindOf(this.tree, fields[0]) !== SyntaxKind.RecordField
    ) return bad();
    const parts = this.kids(fields[0]);
    const label = parts.find((k) => kindOf(this.tree, k) === SyntaxKind.Name);
    const valueNode = parts.find((k) => k !== label);
    if (
      label === undefined || valueNode === undefined ||
      nameTextOf(this.tree, label) !== "capacity" ||
      kindOf(this.tree, valueNode) !== SyntaxKind.LiteralExpr
    ) return bad();
    const value = literalOf(this.tree, valueNode);
    if (
      typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
    ) return bad();
    this.finish(valueNode, this.table.int, PURE_EFFECTS);
    this.finish(
      arg.node,
      this.table.record([{
        name: "capacity",
        type: this.table.int,
        optional: false,
      }]),
      PURE_EFFECTS,
    );
    return value;
  }

  private mergeStreamsCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "merge-streams" });
    if (!this.arity(node, "mergeStreams", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("mergeStreams", args);
    const left = this.argInfo(args[0]);
    const right = this.argInfo(args[1]);
    const a = this.table.node(this.table.unfold(left.type));
    const b = this.table.node(this.table.unfold(right.type));
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.report(
        "type-mismatch/010",
        "`mergeStreams` needs two Stream values",
        node,
      );
      return this.finish(node, this.table.error, combine([left, right]));
    }
    const aFitsB = this.table.isAssignable(a.element, b.element);
    const bFitsA = this.table.isAssignable(b.element, a.element);
    if (!aFitsB && !bFitsA) {
      this.report(
        "type-mismatch/010",
        "`mergeStreams` needs compatible element types",
        node,
      );
    }
    const element = aFitsB ? b.element : a.element;
    const type = this.table.stream(element, [...a.failures, ...b.failures], [
      ...a.requirements,
      ...b.requirements,
    ]);
    return this.finish(node, type, combine([left, right]));
  }

  private zipStreamsCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "zip-streams" });
    if (!this.arity(node, "zipStreams", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    this.noPipeline("zipStreams", args);
    const left = this.argInfo(args[0]);
    const right = this.argInfo(args[1]);
    const a = this.table.node(this.table.unfold(left.type));
    const b = this.table.node(this.table.unfold(right.type));
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.report(
        "type-mismatch/010",
        "`zipStreams` needs two Stream values",
        node,
      );
      return this.finish(node, this.table.error, combine([left, right]));
    }
    const type = this.table.stream(
      this.table.tuple([a.element, b.element]),
      [...a.failures, ...b.failures],
      [...a.requirements, ...b.requirements],
    );
    return this.finish(node, type, combine([left, right]));
  }

  private concatStreamsCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "concat-streams" });
    if (!this.arity(node, "concatStreams", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    this.noPipeline("concatStreams", args);
    const left = this.argInfo(args[0]);
    const right = this.argInfo(args[1]);
    const a = this.table.node(this.table.unfold(left.type));
    const b = this.table.node(this.table.unfold(right.type));
    if (a.kind !== "stream" || b.kind !== "stream") {
      this.report(
        "type-mismatch/010",
        "`concatStreams` needs two Stream values",
        node,
      );
      return this.finish(node, this.table.error, combine([left, right]));
    }
    const type = this.table.stream(
      this.table.union([a.element, b.element]),
      [...a.failures, ...b.failures],
      [...a.requirements, ...b.requirements],
    );
    return this.finish(node, type, combine([left, right]));
  }

  private raceCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "race" });
    if (!this.arity(node, "race", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("race", args);
    const left = this.argInfo(args[0]);
    const right = this.argInfo(args[1]);
    const a = this.table.node(this.table.unfold(left.type));
    const b = this.table.node(this.table.unfold(right.type));
    if (a.kind !== "effect" || b.kind !== "effect") {
      this.report("type-mismatch/010", "`race` needs two Effect values", node);
      return this.finish(node, this.table.error, combine([left, right]));
    }
    const aFitsB = this.table.isAssignable(a.result, b.result);
    const bFitsA = this.table.isAssignable(b.result, a.result);
    if (!aFitsB && !bFitsA) {
      this.report(
        "type-mismatch/010",
        "`race` needs compatible success types",
        node,
      );
    }
    const type = this.table.effect(
      aFitsB ? b.result : a.result,
      [...a.failures, ...b.failures],
      [...a.requirements, ...b.requirements],
    );
    return this.finish(node, type, combine([left, right]));
  }

  private refCall(node: NodeId, name: string, args: readonly Arg[]): NodeInfo {
    const kind = name === "makeRef"
      ? "make-ref"
      : name === "getRef"
      ? "get-ref"
      : name === "setRef"
      ? "set-ref"
      : "update-ref";
    this.fact(node, { kind });
    const count = kind === "make-ref" || kind === "get-ref" ? 1 : 2;
    if (!this.arity(node, name, count, args)) {
      return this.finish(
        node,
        this.table.error,
        combine([...args.map((a) => this.argInfo(a)), EFFECT_ONLY]),
      );
    }
    this.noPipeline(name, args);
    const first = this.argInfo(args[0]);
    if (kind === "make-ref") {
      return this.finish(
        node,
        this.table.ref(this.widen(first.type)),
        combine([first, EFFECT_ONLY]),
      );
    }
    const ref = this.table.node(this.table.unfold(first.type));
    if (ref.kind !== "ref" && !this.isError(first.type)) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` needs a Ref value`,
        args[0].node,
      );
    }
    const element = ref.kind === "ref" ? ref.element : this.table.error;
    if (kind === "get-ref") {
      return this.finish(node, element, combine([first, EFFECT_ONLY]));
    }
    if (kind === "set-ref") {
      const value = this.argInfo(args[1], element);
      this.fits(args[1].node, value.type, element, "the new Ref value");
      return this.finish(
        node,
        this.table.unit,
        combine([first, value, EFFECT_ONLY]),
      );
    }
    const transform = this.callback(name, args[1], [element], element);
    this.fits(args[1].node, transform.result, element, "the updated Ref value");
    return this.finish(
      node,
      this.table.unit,
      combine([first, transform.info, EFFECT_ONLY]),
    );
  }

  private provideCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (!this.arity(node, "provide", 2, args)) {
      this.fact(node, { kind: "provide", provider: undefined });
      const infos = args.map((a) => this.argInfo(a));
      return this.finish(
        node,
        this.table.error,
        combine([...infos, EFFECT_ONLY]),
      );
    }
    const providerInfo = this.argInfo(args[0]);
    const job = this.argInfo(args[1]);
    const providerNode = kindOf(this.tree, args[0].node) === SyntaxKind.NameExpr
      ? args[0].node
      : undefined;
    const target = providerNode === undefined
      ? undefined
      : this.targets.get(providerNode);
    const providerType = this.table.node(this.table.unfold(providerInfo.type));
    let provider: ValueId | undefined;
    if (target?.kind === "provider" && providerType.kind === "provider") {
      provider = target.id;
    } else if (
      providerType.kind !== "provider" && !this.isError(providerInfo.type)
    ) {
      this.report(
        "type-mismatch/010",
        "`provide` needs a Layer value",
        args[0].node,
      );
    }
    this.fact(node, { kind: "provide", provider });
    const fn = this.jobFunction("provide", args[1], job);
    const construction = combine([providerInfo, job]);
    const supplied = providerType.kind === "provider"
      ? providerType.provides
      : [];
    const acquisition: EffectSet = providerType.kind === "provider"
      ? {
        failures: providerType.failures,
        requirements: providerType.requirements,
        mode: "effect",
      }
      : PURE_EFFECTS;
    const invocation: EffectSet = fn === undefined ? PURE_EFFECTS : {
      failures: fn.failures,
      requirements: without(fn.requirements, supplied),
      mode: fn.execution,
    };
    return this.finish(
      node,
      fn?.result ?? this.table.error,
      combine([construction, invocation, acquisition, EFFECT_ONLY]),
    );
  }

  private layerCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (!this.arity(node, "layer", 2, args)) {
      this.fact(node, { kind: "layer", service: undefined });
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("layer", args);
    const target = kindOf(this.tree, args[0].node) === SyntaxKind.NameExpr
      ? this.targets.get(args[0].node)
      : undefined;
    const service: ServiceId | undefined = target?.kind === "service"
      ? target.id
      : undefined;
    this.fact(node, { kind: "layer", service });
    if (service === undefined) {
      this.report(
        "type-mismatch/010",
        "`layer` needs a declared service name",
        args[0].node,
      );
    }
    if (kindOf(this.tree, args[1].node) !== SyntaxKind.ArrowExpr) {
      this.report(
        "type-mismatch/010",
        "`layer` needs an inline acquisition callback",
        args[1].node,
      );
    }
    const acquire = this.argInfo(args[1]);
    const fn = this.jobFunction("layer", args[1], acquire);
    const declaration = service === undefined
      ? undefined
      : this.benv.env.services.get(service);
    const implementation = fn === undefined
      ? undefined
      : this.table.node(this.table.unfold(fn.result));
    if (declaration !== undefined && implementation?.kind === "record") {
      if (implementation.fields.length !== declaration.methods.length) {
        this.report(
          "type-mismatch/010",
          "`layer` must implement exactly the service methods",
          args[1].node,
        );
      }
      for (const method of declaration.methods) {
        const field = implementation.fields.find((f) => f.name === method.name);
        if (
          field === undefined || field.optional ||
          !this.table.isAssignable(field.type, this.table.fromIr(method.type))
        ) {
          this.report(
            "type-mismatch/010",
            `\`layer\` method ${method.name} does not fit its service contract`,
            args[1].node,
          );
        }
      }
    } else if (fn !== undefined) {
      this.report(
        "type-mismatch/010",
        "`layer` acquisition must return a service method record",
        args[1].node,
      );
    }
    const provides = declaration?.methods.map((m) => m.id) ?? [];
    if (fn?.requirements.some((r) => provides.includes(r))) {
      this.report(
        "type-mismatch/010",
        "`layer` acquisition cannot require a method it provides",
        args[1].node,
      );
    }
    const type = this.table.provider({
      provides,
      execution: "effect",
      failures: fn?.failures ?? [],
      requirements: fn?.requirements ?? [],
    });
    return this.finish(node, type, acquire);
  }

  private mergeLayersCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "merge-layers" });
    if (!this.arity(node, "mergeLayers", 2, args)) {
      return this.finish(
        node,
        this.table.error,
        combine(args.map((a) => this.argInfo(a))),
      );
    }
    this.noPipeline("mergeLayers", args);
    const left = this.argInfo(args[0]);
    const right = this.argInfo(args[1]);
    const a = this.table.node(this.table.unfold(left.type));
    const b = this.table.node(this.table.unfold(right.type));
    if (a.kind !== "provider" || b.kind !== "provider") {
      this.report(
        "type-mismatch/010",
        "`mergeLayers` needs two Layer values",
        node,
      );
      return this.finish(node, this.table.error, combine([left, right]));
    }
    const services = new Set(
      a.provides.map((id) => id.slice(0, id.lastIndexOf("."))),
    );
    if (
      b.provides.some((id) => services.has(id.slice(0, id.lastIndexOf("."))))
    ) {
      this.report(
        "type-mismatch/010",
        "`mergeLayers` cannot provide one service twice",
        node,
      );
    }
    const type = this.table.provider({
      provides: [...a.provides, ...b.provides],
      execution: "effect",
      failures: [...a.failures, ...b.failures],
      requirements: [...a.requirements, ...b.requirements],
    });
    return this.finish(node, type, combine([left, right]));
  }

  // -------------------------------------------------------------- map, filter, fold

  /** The element type of an array argument, or the error type after a diagnostic. */
  private arrayElement(name: string, arg: Arg, info: NodeInfo): TypeRef {
    const node = this.table.node(this.table.unfold(info.type));
    if (node.kind === "array") return node.element;
    if (!this.isError(info.type)) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` needs an array as its first argument, but the value has type ${
          this.show(info.type)
        }`,
        arg.node,
      );
    }
    return this.table.error;
  }

  /**
   * Checks a collection callback. An inline arrow receives its parameter
   * types from the context. Only traverse permits invocation effects.
   */
  private callback(
    name: string,
    arg: Arg,
    parameters: readonly TypeRef[],
    resultHint: TypeRef | undefined,
    allowEffects = false,
  ): { readonly info: NodeInfo; readonly result: TypeRef } {
    const info = arg.pre === undefined &&
        kindOf(this.tree, arg.node) === SyntaxKind.ArrowExpr
      ? this.arrow(arg.node, { parameters, result: resultHint })
      : this.argInfo(arg);
    if (this.isError(info.type)) return { info, result: this.table.error };
    const fn = this.functionOf(info.type);
    if (fn === undefined) {
      this.report(
        "type-mismatch/010",
        `the callback of \`${name}\` must be a function, but the value has type ${
          this.show(info.type)
        }`,
        arg.node,
      );
      return { info, result: this.table.error };
    }
    if (fn.parameters.length !== parameters.length) {
      this.report(
        "type-mismatch/004",
        `the callback of \`${name}\` takes ${parameters.length} parameter${
          parameters.length === 1 ? "" : "s"
        }, but the function takes ${fn.parameters.length}`,
        arg.node,
      );
    } else {
      parameters.forEach((expected, i) => {
        if (!this.table.isAssignable(expected, fn.parameters[i])) {
          this.report(
            "type-mismatch/003",
            `parameter ${i + 1} of the callback has type ${
              this.show(fn.parameters[i])
            }, but the collection supplies ${this.show(expected)}`,
            arg.node,
          );
        }
      });
    }
    if (
      !allowEffects &&
      (fn.execution !== "pure" || fn.failures.length > 0 ||
        fn.requirements.length > 0)
    ) {
      this.report(
        "execution-mode/001",
        `the callback of \`${name}\` must be pure with empty failure and requirement sets`,
        arg.node,
      );
    }
    return { info, result: fn.result };
  }

  private pureFunction(
    parameters: readonly TypeRef[],
    result: TypeRef,
  ): TypeRef {
    return this.table.function({
      execution: "pure",
      parameters,
      result,
      failures: [],
      requirements: [],
    });
  }

  private concurrencyBound(
    arg: Arg,
    operation: "traverse" | "all" | "partitionAll" | "validateAll" = "traverse",
  ): number | "unbounded" | undefined {
    const bad = (): undefined => {
      this.report(
        "type-mismatch/010",
        `\`${operation}\` needs \`{ concurrency: N }\` with a positive safe integer literal, or \`{ concurrency: "unbounded" }\``,
        arg.node,
      );
      return undefined;
    };
    if (
      arg.pre !== undefined ||
      kindOf(this.tree, arg.node) !== SyntaxKind.RecordExpr
    ) return bad();
    const fields = this.kids(arg.node);
    if (
      fields.length !== 1 ||
      kindOf(this.tree, fields[0]) !== SyntaxKind.RecordField
    ) return bad();
    const parts = this.kids(fields[0]);
    const name = parts.find((p) => kindOf(this.tree, p) === SyntaxKind.Name);
    const value = parts.find((p) => p !== name);
    if (
      name === undefined || value === undefined ||
      nameTextOf(this.tree, name) !== "concurrency" ||
      kindOf(this.tree, value) !== SyntaxKind.LiteralExpr
    ) return bad();
    const literal = literalOf(this.tree, value);
    if (literal === "unbounded") return literal;
    return typeof literal === "number" && Number.isSafeInteger(literal) &&
        literal > 0
      ? literal
      : bad();
  }

  private allCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (args.length !== 1 && args.length !== 2) {
      this.report(
        "type-mismatch/004",
        "`all` takes an Effect collection and an optional concurrency record",
        node,
      );
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    const input = this.argInfo(args[0]);
    const table = this.table;
    const shape = table.node(table.unfold(input.type));
    const effectTypes = shape.kind === "tuple"
      ? shape.elements
      : shape.kind === "record"
      ? shape.fields.map((field) => field.type)
      : shape.kind === "array"
      ? [shape.element]
      : undefined;
    const option = args[1] === undefined ? undefined : this.argInfo(args[1]);
    const concurrency = args[1] === undefined
      ? undefined
      : this.concurrencyBound(args[1], "all");
    if (effectTypes === undefined) {
      this.report(
        "type-mismatch/010",
        "`all` needs a tuple, record, or array of Effect values",
        args[0].node,
      );
      return this.finish(
        node,
        table.error,
        combine([input, ...(option === undefined ? [] : [option])]),
      );
    }
    if (
      shape.kind === "record" && shape.fields.some((field) => field.optional)
    ) {
      this.report(
        "type-mismatch/010",
        "`all` requires every record field to be present",
        args[0].node,
      );
    }
    const effects = effectTypes.map((type) => {
      const member = table.node(table.unfold(type));
      if (member.kind !== "effect") {
        this.report(
          "type-mismatch/010",
          "`all` requires an Effect value at every position",
          args[0].node,
        );
        return { result: table.error, failures: [], requirements: [] };
      }
      return member;
    });
    const invocation = combine(effects.map((effect) => ({
      failures: effect.failures,
      requirements: effect.requirements,
      mode: "effect" as const,
    })));
    const results = effects.map((effect) => effect.result);
    const result = shape.kind === "tuple"
      ? table.tuple(results)
      : shape.kind === "record"
      ? table.record(shape.fields.map((field, i) => ({
        name: field.name,
        type: results[i],
        optional: false,
      })))
      : table.array(results[0]);
    const specialized = table.function({
      execution: "effect",
      parameters: args.length === 2
        ? [
          input.type,
          table.record([{
            name: "concurrency",
            type: concurrency === "unbounded" ? table.string : table.int,
            optional: false,
          }]),
        ]
        : [input.type],
      result,
      failures: invocation.failures,
      requirements: invocation.requirements,
    });
    this.fact(node, {
      kind: "builtin",
      name: "all",
      specialized,
      ir: table.toIrFunction(specialized),
    });
    return this.finish(
      node,
      result,
      combine([input, ...(option === undefined ? [] : [option]), invocation]),
    );
  }

  private partitionAllCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (args.length !== 1 && args.length !== 2) {
      this.report(
        "type-mismatch/004",
        "`partitionAll` takes an Effect array and an optional concurrency record",
        node,
      );
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    this.noPipeline("partitionAll", args);
    const jobs = this.argInfo(args[0]);
    const option = args[1] === undefined ? undefined : this.argInfo(args[1]);
    const concurrency = args[1] === undefined
      ? undefined
      : this.concurrencyBound(args[1], "partitionAll");
    this.fact(node, { kind: "partition-all", concurrency });
    const shape = this.table.node(this.table.unfold(jobs.type));
    const member = shape.kind === "array"
      ? this.table.node(this.table.unfold(shape.element))
      : undefined;
    if (member?.kind !== "effect") {
      if (!this.isError(jobs.type)) {
        this.report(
          "type-mismatch/010",
          "`partitionAll` needs an array of Effect values",
          args[0].node,
        );
      }
      return this.finish(
        node,
        this.table.error,
        combine([jobs, ...(option === undefined ? [] : [option])]),
      );
    }
    const errors = this.table.union(
      member.failures.map((id) => this.table.named(id)),
    );
    const result = this.table.tuple([
      this.table.array(member.result),
      this.table.array(errors),
    ]);
    return this.finish(
      node,
      result,
      combine([jobs, ...(option === undefined ? [] : [option]), {
        failures: [],
        requirements: member.requirements,
        mode: "effect",
      }]),
    );
  }

  private validateAllCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    if (args.length !== 2 && args.length !== 3) {
      this.report(
        "type-mismatch/004",
        "`validateAll` takes an Effect array, an error wrapper, and an optional concurrency record",
        node,
      );
      return this.finish(
        node,
        this.table.error,
        combine(args.map((arg) => this.argInfo(arg))),
      );
    }
    this.noPipeline("validateAll", args);
    const jobs = this.argInfo(args[0]);
    const shape = this.table.node(this.table.unfold(jobs.type));
    const member = shape.kind === "array"
      ? this.table.node(this.table.unfold(shape.element))
      : undefined;
    if (member?.kind !== "effect" && !this.isError(jobs.type)) {
      this.report(
        "type-mismatch/010",
        "`validateAll` needs an array of Effect values",
        args[0].node,
      );
    }
    const errors = member?.kind === "effect"
      ? this.table.union(member.failures.map((id) => this.table.named(id)))
      : this.table.error;
    const wrapped = this.callback(
      "validateAll",
      args[1],
      [this.table.array(errors)],
      undefined,
    );
    const wrapper = this.table.node(this.table.unfold(wrapped.result));
    if (wrapper.kind !== "named" || !wrapper.id.startsWith("error:")) {
      if (!this.isError(wrapped.result)) {
        this.report(
          "type-mismatch/010",
          "`validateAll` error wrapper must return a nominal error",
          args[1].node,
        );
      }
    }
    const option = args[2] === undefined ? undefined : this.argInfo(args[2]);
    const concurrency = args[2] === undefined
      ? undefined
      : this.concurrencyBound(args[2], "validateAll");
    this.fact(node, { kind: "validate-all", concurrency });
    return this.finish(
      node,
      member?.kind === "effect"
        ? this.table.array(member.result)
        : this.table.error,
      combine([jobs, wrapped.info, ...(option === undefined ? [] : [option]), {
        failures: wrapper.kind === "named" &&
            wrapper.id.startsWith("error:")
          ? [wrapper.id as ErrorId]
          : [],
        requirements: member?.kind === "effect" ? member.requirements : [],
        mode: "effect",
      }]),
    );
  }

  private collectionCall(
    node: NodeId,
    name: "map" | "filter" | "fold" | "traverse",
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    const count = name === "fold" ? 3 : 2;
    const unspecialized = (): NodeInfo => {
      const infos = args.map((a) => this.argInfo(a));
      return this.finish(node, this.table.error, combine(infos));
    };
    if (name === "traverse") {
      if (args.length !== 2 && args.length !== 3) {
        this.report(
          "type-mismatch/004",
          "`traverse` takes two arguments and an optional concurrency record",
          node,
        );
        return unspecialized();
      }
    } else if (!this.arity(node, name, count, args)) return unspecialized();

    const xs = this.argInfo(args[0]);
    const element = this.arrayElement(name, args[0], xs);
    const table = this.table;
    const infos: NodeInfo[] = [xs];
    let result: TypeRef;
    let specialized: TypeRef;

    if (name === "traverse") {
      const cb = this.callback(name, args[1], [element], undefined, true);
      infos.push(cb.info);
      const concurrency = args[2] === undefined
        ? undefined
        : this.concurrencyBound(args[2]);
      if (args[2] !== undefined) {
        infos.push(this.argInfo(args[2]));
      }
      const fn = this.functionOf(cb.info.type);
      const failures = fn?.failures ?? [];
      const requirements = fn?.requirements ?? [];
      const callbackType = table.function({
        execution: "effect",
        parameters: [element],
        result: cb.result,
        failures,
        requirements,
      });
      result = table.array(cb.result);
      specialized = table.function({
        execution: "effect",
        parameters: args.length === 3
          ? [
            table.array(element),
            callbackType,
            table.record([{
              name: "concurrency",
              type: concurrency === "unbounded" ? table.string : table.int,
              optional: false,
            }]),
          ]
          : [table.array(element), callbackType],
        result,
        failures,
        requirements,
      });
    } else if (name === "map") {
      const cb = this.callback(name, args[1], [element], undefined);
      infos.push(cb.info);
      result = table.array(cb.result);
      specialized = this.pureFunction(
        [table.array(element), this.pureFunction([element], cb.result)],
        result,
      );
    } else if (name === "filter") {
      const cb = this.callback(name, args[1], [element], table.boolean);
      infos.push(cb.info);
      this.fits(args[1].node, cb.result, table.boolean, "the predicate result");
      result = table.array(element);
      specialized = this.pureFunction(
        [result, this.pureFunction([element], table.boolean)],
        result,
      );
    } else {
      const initial = this.argInfo(args[1], expected);
      infos.push(initial);
      const accumulator = expected ?? this.widen(initial.type);
      this.fits(args[1].node, initial.type, accumulator, "the initial value");
      const cb = this.callback(
        name,
        args[2],
        [accumulator, element],
        accumulator,
      );
      infos.push(cb.info);
      this.fits(args[2].node, cb.result, accumulator, "the callback result");
      result = accumulator;
      specialized = this.pureFunction(
        [
          table.array(element),
          accumulator,
          this.pureFunction([accumulator, element], accumulator),
        ],
        result,
      );
    }
    this.fact(node, {
      kind: "builtin",
      name,
      specialized,
      ir: table.toIrFunction(specialized),
    });
    const invocation = name === "traverse"
      ? this.table.node(specialized)
      : undefined;
    return this.finish(
      node,
      result,
      invocation?.kind === "function"
        ? combine([...infos, {
          failures: invocation.failures,
          requirements: invocation.requirements,
          mode: invocation.execution,
        }])
        : combine(infos),
    );
  }

  // -------------------------------------------------------------- pipelines

  private pipe(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const kids = this.kids(node);
    const left = kids[0];
    const stage = kids.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.PipeStage
    );
    if (left === undefined) return this.errorInfo(node);
    const leftInfo = this.expr(left);
    if (stage === undefined) return this.errorInfo(node);
    const parts = this.kids(stage);
    const qualified = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.QualifiedName
    );
    const argList = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.ArgList
    );
    if (qualified === undefined) {
      this.errorInfo(stage);
      return this.finish(node, this.table.error, leftInfo);
    }
    const args: Arg[] = [
      { node: left, pre: leftInfo },
      ...(argList === undefined
        ? []
        : this.kids(argList).map((n) => ({ node: n }))),
    ];
    const info = this.invoke(
      stage,
      qualified,
      this.targets.get(qualified),
      true,
      args,
      expected,
    );
    return this.finish(node, info.type, info);
  }

  // -------------------------------------------------------------- fields and records

  private fieldExpr(node: NodeId): NodeInfo {
    const kids = this.kids(node);
    const base = kids[0];
    const member = kids.find((k, i) =>
      i > 0 && kindOf(this.tree, k) === SyntaxKind.Name
    );
    const target = this.targets.get(node);
    if (target?.kind === "cap") {
      this.report(
        "type-mismatch/008",
        `the service method \`${
          shortName(target.id)
        }\` can only be called or used as a pipeline stage`,
        node,
      );
      return this.errorInfo(node);
    }
    if (target?.kind === "unresolved") return this.errorInfo(node);
    if (base === undefined) return this.errorInfo(node);
    const baseInfo = this.expr(base);
    const name = member === undefined
      ? undefined
      : nameTextOf(this.tree, member);
    if (member === undefined || name === undefined) {
      return this.finish(node, this.table.error, baseInfo);
    }
    const read = this.readField(baseInfo.type, name, member);
    this.fact(node, { kind: "field", name, optional: read.optional });
    return this.finish(node, read.type, baseInfo);
  }

  /** The record fields of a type that is a record or a named error. */
  private recordFields(ref: TypeRef):
    | readonly {
      readonly name: string;
      readonly type: TypeRef;
      readonly optional: boolean;
    }[]
    | undefined {
    const unfolded = this.table.unfold(ref);
    const node = this.table.node(unfolded);
    if (node.kind === "record") return node.fields;
    if (node.kind === "named" && node.id.startsWith("error:")) {
      const record = this.table.errorRecordOf(node.id as ErrorId);
      const recordNode = record === undefined
        ? undefined
        : this.table.node(record);
      return recordNode?.kind === "record" ? recordNode.fields : undefined;
    }
    if (node.kind === "named") {
      // A brand of a record has the fields of its base.
      const base = this.table.brandBaseOf(node.id as TypeId);
      if (base !== undefined) return this.recordFields(base);
    }
    return undefined;
  }

  private readField(
    ref: TypeRef,
    name: string,
    nameNode: NodeId,
  ): { readonly type: TypeRef; readonly optional: boolean } {
    const failed = { type: this.table.error, optional: false };
    if (this.isError(ref)) return failed;
    const members = flattenMembers(this.table, ref);
    const types: TypeRef[] = [];
    let optional = false;
    for (const member of members) {
      const fields = this.recordFields(member);
      const field = fields?.find((f) => f.name === name);
      if (field === undefined) {
        this.report(
          "type-mismatch/006",
          fields === undefined
            ? `a value of type ${this.show(ref)} has no fields`
            : `the type ${this.show(member)} has no field \`${name}\``,
          nameNode,
        );
        return failed;
      }
      if (field.optional) optional = true;
      types.push(field.type);
    }
    const type = this.table.union(types);
    return { type: optional ? this.table.option(type) : type, optional };
  }

  private recordExpr(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const fields = this.kids(node);
    const first = fields[0];
    if (
      first !== undefined && kindOf(this.tree, first) === SyntaxKind.SpreadField
    ) {
      return this.recordUpdate(node, first, fields.slice(1));
    }
    return this.recordConstruction(node, fields, expected);
  }

  private listExpr(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const table = this.table;
    const target = expected === undefined
      ? undefined
      : table.node(table.unfold(expected));
    const elements = this.kids(node);
    if (target?.kind === "tuple") {
      this.fact(node, { kind: "list", shape: "tuple" });
      if (elements.length !== target.elements.length) {
        this.report(
          "type-mismatch/012",
          `the tuple needs ${target.elements.length} elements, but ${elements.length} are given`,
          node,
        );
      }
      const infos = elements.map((element, i) => {
        const hint = target.elements[i];
        const info = this.expr(element, hint);
        this.fits(element, info.type, hint, `tuple element ${i + 1}`);
        return info;
      });
      return this.finish(node, expected!, combine(infos));
    }

    this.fact(node, { kind: "list", shape: "array" });
    const hint = target?.kind === "array" ? target.element : undefined;
    const infos = elements.map((element, i) => {
      const info = this.expr(element, hint);
      if (hint !== undefined) {
        this.fits(element, info.type, hint, `array element ${i + 1}`);
      }
      return info;
    });
    if (hint !== undefined) {
      return this.finish(node, expected!, combine(infos));
    }
    if (infos.length === 0) {
      this.report(
        "type-mismatch/012",
        "an empty list needs an expected array or tuple type",
        node,
      );
      return this.finish(node, table.array(table.error), PURE_EFFECTS);
    }
    let element = this.widen(infos[0].type);
    for (let i = 1; i < infos.length; i++) {
      const next = this.widen(infos[i].type);
      if (this.isError(element) || this.isError(next)) {
        element = table.error;
      } else if (table.isAssignable(next, element)) {
        continue;
      } else if (table.isAssignable(element, next)) {
        element = next;
      } else {
        this.report(
          "type-mismatch/012",
          `list element ${i + 1} has type ${
            this.show(next)
          }, which has no common array element type with ${this.show(element)}`,
          elements[i],
        );
        element = table.error;
      }
    }
    return this.finish(node, table.array(element), combine(infos));
  }

  /** The label, label node, and value node of a record field. */
  private fieldParts(
    field: NodeId,
  ): {
    readonly label: string;
    readonly labelNode: NodeId;
    readonly value: NodeId | undefined;
  } | undefined {
    const kind = kindOf(this.tree, field);
    const parts = this.kids(field);
    const labelNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.Name
    );
    if (labelNode === undefined) return undefined;
    const label = nameTextOf(this.tree, labelNode);
    if (label === undefined) return undefined;
    if (kind === SyntaxKind.ShorthandField) {
      return { label, labelNode, value: undefined };
    }
    if (kind === SyntaxKind.RecordField) {
      return { label, labelNode, value: parts.find((k) => k !== labelNode) };
    }
    return undefined;
  }

  /** The value of a field: an expression, or the variable of a shorthand field. */
  private fieldValue(
    field: NodeId,
    parts: { readonly labelNode: NodeId; readonly value: NodeId | undefined },
    expected: TypeRef | undefined,
  ): NodeInfo {
    if (parts.value !== undefined) return this.expr(parts.value, expected);
    const info = this.referenceInfo(
      parts.labelNode,
      this.targets.get(parts.labelNode),
      expected,
    );
    return this.finish(field, info.type, info);
  }

  /** Picks the record type that a construction targets. */
  private recordTarget(
    expected: TypeRef | undefined,
    labels: readonly string[],
  ): {
    readonly ref: TypeRef;
    readonly fields: readonly {
      readonly name: string;
      readonly type: TypeRef;
      readonly optional: boolean;
    }[];
  } | undefined {
    if (expected === undefined) return undefined;
    const unfolded = this.table.unfold(expected);
    const node = this.table.node(unfolded);
    if (node.kind === "record") return { ref: expected, fields: node.fields };
    if (node.kind !== "union") return undefined;
    const candidates = flattenMembers(this.table, expected).flatMap((m) => {
      const mNode = this.table.node(m);
      return mNode.kind === "record" ? [{ ref: m, fields: mNode.fields }] : [];
    });
    const fitting = candidates.filter((c) =>
      labels.every((l) => c.fields.some((f) => f.name === l)) &&
      c.fields.every((f) => f.optional || labels.includes(f.name))
    );
    return fitting[0] ?? candidates[0];
  }

  private recordConstruction(
    node: NodeId,
    fields: readonly NodeId[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    const parsed = fields.map((f) => ({ node: f, parts: this.fieldParts(f) }));
    const labels = parsed.flatMap((p) =>
      p.parts === undefined ? [] : [p.parts.label]
    );
    const target = this.recordTarget(expected, labels);
    const seen = new Set<string>();
    const infos: NodeInfo[] = [];
    const inferred: { name: string; type: TypeRef; optional: boolean }[] = [];
    for (const { node: fieldNode, parts } of parsed) {
      if (parts === undefined) {
        if (kindOf(this.tree, fieldNode) === SyntaxKind.SpreadField) {
          this.report(
            "type-mismatch/005",
            "a record spread must come first",
            fieldNode,
          );
        }
        continue;
      }
      const declared = target?.fields.find((f) => f.name === parts.label);
      const duplicate = seen.has(parts.label);
      if (duplicate) {
        this.report(
          "type-mismatch/005",
          `the field \`${parts.label}\` appears twice`,
          parts.labelNode,
        );
      }
      seen.add(parts.label);
      if (target !== undefined && declared === undefined && !duplicate) {
        this.report(
          "type-mismatch/005",
          `the record type ${
            this.show(target.ref)
          } has no field \`${parts.label}\``,
          parts.labelNode,
        );
      }
      const info = this.fieldValue(fieldNode, parts, declared?.type);
      infos.push(info);
      if (declared !== undefined && !duplicate) {
        this.fits(
          parts.value ?? fieldNode,
          info.type,
          declared.type,
          `the field \`${parts.label}\``,
        );
      }
      if (!duplicate) {
        inferred.push({ name: parts.label, type: info.type, optional: false });
      }
    }
    let type: TypeRef;
    if (target !== undefined) {
      const missing = target.fields.filter((f) =>
        !f.optional && !seen.has(f.name)
      ).map((f) => f.name);
      if (missing.length > 0) {
        this.report(
          "type-mismatch/005",
          `the record is missing the field${missing.length === 1 ? "" : "s"} ${
            missing.map((m) => `\`${m}\``).join(", ")
          }`,
          node,
        );
      }
      type = target.ref;
    } else {
      type = this.table.record(inferred);
    }
    return this.finish(node, type, combine(infos));
  }

  private recordUpdate(
    node: NodeId,
    spread: NodeId,
    rest: readonly NodeId[],
  ): NodeInfo {
    const baseNode = this.kids(spread)[0];
    if (baseNode === undefined) return this.errorInfo(node);
    const base = this.expr(baseNode);
    this.finish(spread, base.type, base);
    const baseFields = this.isError(base.type)
      ? undefined
      : this.recordFields(base.type);
    if (baseFields === undefined && !this.isError(base.type)) {
      this.report(
        "type-mismatch/005",
        `a record update needs a record, but the base has type ${
          this.show(base.type)
        }`,
        baseNode,
      );
    }
    const seen = new Set<string>();
    const infos: NodeInfo[] = [base];
    for (const fieldNode of rest) {
      const parts = this.fieldParts(fieldNode);
      if (parts === undefined) {
        if (kindOf(this.tree, fieldNode) === SyntaxKind.SpreadField) {
          this.report(
            "type-mismatch/005",
            "a record spread must come first",
            fieldNode,
          );
        }
        continue;
      }
      const duplicate = seen.has(parts.label);
      if (duplicate) {
        this.report(
          "type-mismatch/005",
          `the field \`${parts.label}\` appears twice`,
          parts.labelNode,
        );
      }
      seen.add(parts.label);
      const declared = baseFields?.find((f) => f.name === parts.label);
      if (baseFields !== undefined && declared === undefined && !duplicate) {
        this.report(
          "type-mismatch/005",
          `the record has no field \`${parts.label}\` to replace`,
          parts.labelNode,
        );
      }
      const info = this.fieldValue(fieldNode, parts, declared?.type);
      infos.push(info);
      if (declared !== undefined && !duplicate) {
        this.fits(
          parts.value ?? fieldNode,
          info.type,
          declared.type,
          `the field \`${parts.label}\``,
        );
      }
    }
    return this.finish(node, base.type, combine(infos));
  }

  // -------------------------------------------------------------- operators

  /** True when the type is `int` or `number` (literals included). */
  private isNumeric(ref: TypeRef): boolean {
    return this.table.isAssignable(ref, this.table.number) &&
      !this.isError(ref) && ref !== this.table.never;
  }

  /**
   * The brand id when the type, after aliases, is a brand of `int` or `number`.
   * A brand of a literal union or of another brand is not numeric.
   */
  private numericBrand(ref: TypeRef): TypeId | undefined {
    const node = this.table.node(this.table.unfold(ref));
    if (node.kind !== "named") return undefined;
    const id = node.id as TypeId;
    const base = this.table.brandBaseOf(id);
    if (base === undefined) return undefined;
    const baseNode = this.table.node(this.table.unfold(base));
    return baseNode.kind === "primitive" &&
        (baseNode.name === "int" || baseNode.name === "number")
      ? id
      : undefined;
  }

  /** The brand id when both operands have one numeric brand. */
  private sharedNumericBrand(
    left: TypeRef,
    right: TypeRef,
  ): TypeId | undefined {
    const brand = this.numericBrand(left);
    return brand !== undefined && brand === this.numericBrand(right)
      ? brand
      : undefined;
  }

  private isString(ref: TypeRef): boolean {
    return this.table.isAssignable(ref, this.table.string) &&
      !this.isError(ref) && ref !== this.table.never;
  }

  private isBoolean(ref: TypeRef): boolean {
    return this.table.isAssignable(ref, this.table.boolean) &&
      !this.isError(ref) && ref !== this.table.never;
  }

  /** The comparison class of a type: a primitive name or a brand identity. */
  private comparisonClass(ref: TypeRef): string | undefined {
    const members = flattenMembers(this.table, ref);
    let found: string | undefined;
    for (const member of members) {
      const node = this.table.node(member);
      let current: string | undefined;
      if (node.kind === "literal") {
        current = typeof node.value === "number" ? "number" : typeof node.value;
      } else if (node.kind === "primitive") {
        if (node.name === "int" || node.name === "number") current = "number";
        else if (node.name === "string" || node.name === "boolean") {
          current = node.name;
        }
      } else if (node.kind === "named") {
        const base = this.table.brandBaseOf(node.id as TypeId);
        if (base !== undefined && this.comparisonClass(base) !== undefined) {
          current = `brand:${node.id}`;
        }
      }
      if (current === undefined) return undefined;
      if (found !== undefined && found !== current) return undefined;
      found = current;
    }
    return found;
  }

  private binary(node: NodeId): NodeInfo {
    const kids = this.kids(node);
    const operator = operatorOf(this.tree, node);
    if (operator === undefined || kids.length < 2) return this.errorInfo(node);
    const left = this.expr(kids[0]);
    const equality = operator === "===" || operator === "!==";
    const right = this.expr(kids[1], equality ? left.type : undefined);
    const eff = combine([left, right]);
    const table = this.table;
    const either = this.isError(left.type) || this.isError(right.type);
    const mismatch = (): void => {
      this.report(
        "type-mismatch/007",
        `the operator \`${operator}\` does not accept operands of type ${
          this.show(left.type)
        } and ${this.show(right.type)}`,
        node,
      );
    };
    switch (operator) {
      case "&&":
      case "||": {
        if (
          !either && !(this.isBoolean(left.type) && this.isBoolean(right.type))
        ) mismatch();
        return this.finish(node, table.boolean, eff);
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (
          !either &&
          !(this.isNumeric(left.type) && this.isNumeric(right.type)) &&
          this.sharedNumericBrand(left.type, right.type) === undefined
        ) mismatch();
        return this.finish(node, table.boolean, eff);
      }
      case "===":
      case "!==": {
        if (!either) {
          const l = this.comparisonClass(left.type);
          const r = this.comparisonClass(right.type);
          if (l === undefined || r === undefined || l !== r) mismatch();
        }
        return this.finish(node, table.boolean, eff);
      }
      default: {
        // An error operand hides whether the result is int or number.
        if (either) return this.finish(node, table.error, eff);
        if (operator === "+" || operator === "-") {
          const brand = this.sharedNumericBrand(left.type, right.type);
          if (brand !== undefined) {
            return this.finish(node, table.named(brand), eff);
          }
        }
        if (this.isNumeric(left.type) && this.isNumeric(right.type)) {
          const integral = operator !== "/" &&
            table.isAssignable(left.type, table.int) &&
            table.isAssignable(right.type, table.int);
          return this.finish(node, integral ? table.int : table.number, eff);
        }
        if (
          operator === "+" && this.isString(left.type) &&
          this.isString(right.type)
        ) {
          return this.finish(node, table.string, eff);
        }
        mismatch();
        return this.finish(node, table.error, eff);
      }
    }
  }

  // -------------------------------------------------------------- arrows

  /**
   * Checks an arrow expression. Creating a closure is pure with empty sets. The
   * function type carries the invocation mode and sets.
   */
  private arrow(node: NodeId, context: ArrowContext | undefined): NodeInfo {
    const parts = this.kids(node);
    const paramList = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.ParamList
    );
    const params = paramList === undefined
      ? []
      : this.kidsOfKind(paramList, SyntaxKind.Param);
    const parameterFacts: ArrowParameterFact[] = [];
    params.forEach((param, i) => {
      const piece = this.kids(param);
      const nameNode = piece.find((k) =>
        kindOf(this.tree, k) === SyntaxKind.Name
      );
      const typeNode = piece.find((k) => k !== nameNode);
      const name = nameNode === undefined
        ? ""
        : nameTextOf(this.tree, nameNode) ?? "";
      const target = nameNode === undefined
        ? undefined
        : this.targets.get(nameNode);
      let type: TypeRef;
      if (typeNode !== undefined) {
        type = this.lowerer.lower(typeNode).ref;
      } else if (context !== undefined && i < context.parameters.length) {
        type = context.parameters[i];
      } else {
        this.report(
          "type-mismatch/011",
          `the parameter \`${name}\` needs a type annotation, because the context gives no function type`,
          param,
        );
        type = this.table.error;
      }
      const id = target?.kind === "local" ? target.id : undefined;
      if (id !== undefined) this.body.locals.set(id, type);
      parameterFacts.push({ id, name, type });
    });
    const resultNode = parts.find((k) => isTypeKind(kindOf(this.tree, k)));
    const failsNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.FailsClause
    );
    const usesNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.UsesClause
    );
    const bodyNode = parts.filter((k) => {
      const kind = kindOf(this.tree, k);
      return k !== paramList && kind !== SyntaxKind.FailsClause &&
        kind !== SyntaxKind.UsesClause && !isTypeKind(kind);
    }).pop();
    const contract: Contract = {
      result: resultNode === undefined
        ? undefined
        : this.lowerer.lower(resultNode).ref,
      failures: this.lowerer.failures(failsNode),
      requirements: this.lowerer.requirements(usesNode),
    };
    const run = this.checkBody(bodyNode, contract, context?.result);
    const type = this.table.function({
      execution: run.execution,
      parameters: parameterFacts.map((p) => p.type),
      result: run.result,
      failures: run.failures,
      requirements: run.requirements,
    });
    this.fact(node, {
      kind: "arrow",
      parameters: parameterFacts,
      contract: resultNode === undefined ? "inferred" : "explicit",
    });
    return this.finish(node, type, PURE_EFFECTS);
  }

  // -------------------------------------------------------------- blocks and control

  private block(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const items = this.kids(node);
    const infos: NodeInfo[] = [];
    let type = this.table.unit;
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      if (kindOf(this.tree, item) === SyntaxKind.ConstDecl) {
        infos.push(this.blockConst(item));
        type = this.table.unit;
      } else {
        const info = this.expr(item, last ? expected : undefined);
        infos.push(info);
        type = info.type;
      }
    });
    return this.finish(node, type, combine(infos));
  }

  private blockConst(node: NodeId): NodeInfo {
    const parts = this.kids(node);
    const nameNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.Name
    );
    const typeNode = parts.find((k) => isTypeKind(kindOf(this.tree, k)));
    const init = parts.filter((k) =>
      k !== nameNode && !isTypeKind(kindOf(this.tree, k))
    ).pop();
    const target = nameNode === undefined
      ? undefined
      : this.targets.get(nameNode);
    const id = target?.kind === "local" ? target.id : undefined;
    const annotation = typeNode === undefined
      ? undefined
      : this.lowerer.lower(typeNode).ref;
    let info: NodeInfo | undefined;
    if (init !== undefined) {
      if (kindOf(this.tree, init) === SyntaxKind.ArrowExpr) {
        if (id !== undefined) this.pendingLocals.add(id);
        info = this.arrow(init, this.contextOf(annotation));
        if (id !== undefined) this.pendingLocals.delete(id);
      } else {
        info = this.expr(init, annotation);
      }
    }
    let type: TypeRef;
    if (annotation !== undefined) {
      if (info !== undefined && init !== undefined) {
        this.fits(init, info.type, annotation, "the value");
      }
      type = annotation;
    } else {
      type = info === undefined ? this.table.error : this.widen(info.type);
    }
    if (id !== undefined) this.body.locals.set(id, type);
    this.fact(node, { kind: "binding", id, type });
    return this.finish(node, type, info ?? PURE_EFFECTS);
  }

  /**
   * The common type of branch results. With an expected type each branch must fit
   * it and the result is the expected type. Without one, literals widen and the
   * result is the branch type that the others fit.
   */
  private joinResults(
    branches: readonly { readonly node: NodeId; readonly type: TypeRef }[],
    expected: TypeRef | undefined,
  ): TypeRef {
    if (expected !== undefined) {
      for (const branch of branches) {
        this.fits(branch.node, branch.type, expected, "the branch");
      }
      return expected;
    }
    let joined: TypeRef | undefined;
    for (const branch of branches) {
      const type = this.widen(branch.type);
      if (joined === undefined) {
        joined = type;
      } else if (this.isError(joined) || this.isError(type)) {
        joined = this.table.error;
      } else if (this.table.isAssignable(type, joined)) {
        // The earlier type already covers this branch.
      } else if (this.table.isAssignable(joined, type)) {
        joined = type;
      } else {
        this.report(
          "type-mismatch/009",
          `this branch has type ${
            this.show(type)
          }, which has no common type with ${
            this.show(joined)
          } from the earlier branches`,
          branch.node,
        );
        joined = this.table.error;
      }
    }
    return joined ?? this.table.never;
  }

  private ifExpr(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const kids = this.kids(node);
    const condition = kids[0];
    if (condition === undefined) return this.errorInfo(node);
    const cond = this.expr(condition);
    if (!this.isError(cond.type) && !this.isBoolean(cond.type)) {
      this.report(
        "type-mismatch/007",
        `a condition must be boolean, but it has type ${this.show(cond.type)}`,
        condition,
      );
    }
    const infos: NodeInfo[] = [cond];
    const branches: { node: NodeId; type: TypeRef }[] = [];
    for (const branch of kids.slice(1, 3)) {
      const info = this.expr(branch, expected);
      infos.push(info);
      branches.push({ node: branch, type: info.type });
    }
    const type = this.joinResults(branches, expected);
    return this.finish(node, type, combine(infos));
  }

  // -------------------------------------------------------------- try and catch

  private tryExpr(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const kids = this.kids(node);
    const bodyNode = kids.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.Block
    );
    const catchNode = kids.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.CatchClause
    );
    if (bodyNode === undefined) return this.errorInfo(node);
    const errorsBefore = this.errorCount;
    const body = this.expr(bodyNode, expected);
    const bodyHadErrors = this.errorCount > errorsBefore;
    const handlers = catchNode === undefined
      ? []
      : this.kidsOfKind(catchNode, SyntaxKind.Handler);
    const protectedSet = new Set<ErrorId>(body.failures);
    const handled = new Set<ErrorId>();
    // Every error that a handler names, so a repeat is a duplicate even for an absent error.
    const named = new Set<ErrorId>();
    const handlerInfos: NodeInfo[] = [];
    const branches = [{ node: bodyNode, type: body.type }];
    for (const handler of handlers) {
      const parts = this.kids(handler);
      const nameNodes = parts.filter((k) =>
        kindOf(this.tree, k) === SyntaxKind.Name
      );
      const errorNode = nameNodes[0];
      const bindingNode = nameNodes[1];
      const handlerBody = parts.filter((k) =>
        kindOf(this.tree, k) !== SyntaxKind.Name
      ).pop();
      const errorTarget = errorNode === undefined
        ? undefined
        : this.targets.get(errorNode);
      const error = errorTarget?.kind === "error" ? errorTarget.id : undefined;
      const bindingTarget = bindingNode === undefined
        ? undefined
        : this.targets.get(bindingNode);
      const binding = bindingTarget?.kind === "local"
        ? bindingTarget.id
        : undefined;
      if (error !== undefined && errorNode !== undefined) {
        const repeated = named.has(error);
        named.add(error);
        if (repeated) {
          this.report(
            "failure-contract/003",
            `the error \`${shortName(error)}\` already has a handler`,
            errorNode,
          );
        } else if (!protectedSet.has(error)) {
          if (!bodyHadErrors) {
            this.report(
              "failure-contract/002",
              `the protected block cannot fail with \`${shortName(error)}\``,
              errorNode,
            );
          }
        } else {
          handled.add(error);
        }
      }
      if (binding !== undefined) {
        this.body.locals.set(
          binding,
          error === undefined ? this.table.error : this.table.named(error),
        );
      }
      this.fact(handler, { kind: "handler", error, binding });
      if (handlerBody === undefined) {
        handlerInfos.push(this.errorInfo(handler));
        continue;
      }
      const info = this.expr(handlerBody, expected);
      handlerInfos.push(this.finish(handler, info.type, info));
      branches.push({ node: handlerBody, type: info.type });
    }
    const remaining: EffectSet = {
      failures: without(body.failures, [...handled]),
      requirements: body.requirements,
      mode: body.mode,
    };
    const type = this.joinResults(branches, expected);
    return this.finish(
      node,
      type,
      combine([remaining, ...handlerInfos, EFFECT_ONLY]),
    );
  }

  // -------------------------------------------------------------- match

  private match(node: NodeId, expected: TypeRef | undefined): NodeInfo {
    const kids = this.kids(node);
    const subjectNode = kids[0];
    if (subjectNode === undefined) return this.errorInfo(node);
    const subject = this.expr(subjectNode);
    const arms = kids.slice(1).filter((k) =>
      kindOf(this.tree, k) === SyntaxKind.MatchArm
    );
    const domain = domainOf(this.table, subject.type);
    if (domain.kind === "unsupported") {
      this.report(
        "pattern/004",
        `a match cannot take a value of type ${
          this.show(subject.type)
        }; version 0 matches options, errors, tagged records, literals, and primitives`,
        subjectNode,
      );
    }
    const state: MatchState = {
      wildcard: false,
      covered: new Set(),
      tagField: undefined,
    };
    const infos: NodeInfo[] = [subject];
    const branches: { node: NodeId; type: TypeRef }[] = [];
    for (const arm of arms) {
      const parts = this.kids(arm);
      const patternNode = parts.find((k) =>
        PATTERN_KINDS.has(kindOf(this.tree, k))
      );
      const bodyNode = parts.filter((k) => k !== patternNode).pop();
      if (patternNode !== undefined) {
        this.pattern(patternNode, domain, state);
      }
      if (bodyNode === undefined) continue;
      const info = this.expr(bodyNode, expected);
      infos.push(info);
      branches.push({ node: bodyNode, type: info.type });
      this.finish(arm, info.type, info);
    }
    if (!state.wildcard) this.checkCoverage(node, domain, state, arms.length);
    const type = this.joinResults(branches, expected);
    return this.finish(node, type, combine(infos));
  }

  /**
   * The values that a match still needs, or undefined when the domain has no
   * coverage rule (the error type and unsupported types).
   */
  private missing(domain: Domain, state: MatchState): string[] | undefined {
    const missing: string[] = [];
    switch (domain.kind) {
      case "option":
        if (!state.covered.has("Some")) missing.push("Some(_)");
        if (!state.covered.has("None")) missing.push("None");
        return missing;
      case "errors":
        for (const id of domain.ids) {
          if (!state.covered.has(`E:${id}`)) {
            missing.push(`${shortName(id)}(_)`);
          }
        }
        return missing;
      case "literals":
        for (const value of domain.values) {
          if (!state.covered.has(`L:${JSON.stringify(value)}`)) {
            missing.push(describeLiteral(value));
          }
        }
        return missing;
      case "open":
        return ["_"];
      case "tagged": {
        const field = state.tagField;
        if (field === undefined) {
          return domain.members.length > 0 ? ["a tagged arm"] : [];
        }
        for (const value of taggedValues(domain.members, field)) {
          if (!state.covered.has(`T:${field}:${JSON.stringify(value)}`)) {
            missing.push(`{ ${field}: ${describeLiteral(value)} }`);
          }
        }
        return missing;
      }
      case "error":
      case "unsupported":
        return undefined;
    }
  }

  private checkCoverage(
    node: NodeId,
    domain: Domain,
    state: MatchState,
    armCount: number,
  ): void {
    const missing = this.missing(domain, state);
    if (missing === undefined) return;
    if (missing.length === 0 && armCount > 0) return;
    this.report(
      "pattern/001",
      missing.length === 0
        ? "the match has no arms"
        : `the match is not exhaustive; it needs ${missing.join(", ")}`,
      node,
    );
  }

  /** Reports a duplicate or unreachable arm. Returns true when the arm can run. */
  private reach(
    node: NodeId,
    state: MatchState,
    key: string | undefined,
  ): boolean {
    if (state.wildcard) {
      this.report(
        "pattern/002",
        "this arm is unreachable, because an earlier `_` arm matches every value",
        node,
      );
      return false;
    }
    if (key !== undefined) {
      if (state.covered.has(key)) {
        this.report(
          "pattern/002",
          "this arm is unreachable, because an earlier arm matches the same value",
          node,
        );
        return false;
      }
      state.covered.add(key);
    }
    return true;
  }

  private foreign(node: NodeId, what: string, domain: Domain): void {
    this.report(
      "pattern/003",
      `${what} does not belong to the subject (${describeDomain(domain)})`,
      node,
    );
  }

  private bindLocal(
    nameNode: NodeId | undefined,
    type: TypeRef,
  ): LocalId | undefined {
    if (nameNode === undefined) return undefined;
    const target = this.targets.get(nameNode);
    if (target?.kind !== "local") return undefined;
    this.body.locals.set(target.id, type);
    return target.id;
  }

  private patternFact(node: NodeId, pattern: PatternFact): void {
    this.fact(node, { kind: "pattern", pattern });
  }

  private pattern(node: NodeId, domain: Domain, state: MatchState): void {
    const kind = kindOf(this.tree, node);
    const names = this.kidsOfKind(node, SyntaxKind.Name);
    const silent = domain.kind === "error" || domain.kind === "unsupported";
    switch (kind) {
      case SyntaxKind.WildcardPattern: {
        if (this.reach(node, state, undefined)) {
          const needed = this.missing(domain, state);
          if (needed !== undefined && needed.length === 0) {
            this.report(
              "pattern/002",
              "this arm is unreachable, because the earlier arms already cover every value",
              node,
            );
          }
        }
        state.wildcard = true;
        this.patternFact(node, { kind: "wildcard" });
        return;
      }
      case SyntaxKind.NamePattern: {
        const target = names[0] === undefined
          ? undefined
          : this.targets.get(names[0]);
        if (target?.kind === "builtin" && target.name === "None") {
          if (domain.kind === "option") {
            this.reach(node, state, "None");
          } else if (!silent) {
            this.foreign(node, "`None`", domain);
          }
          this.patternFact(node, { kind: "none" });
        } else {
          if (target !== undefined && target.kind !== "unresolved") {
            this.report(
              "pattern/004",
              "a constructor pattern needs a binding, as in `Some(x)` or `E(x)`",
              node,
            );
          }
          this.patternFact(node, { kind: "invalid" });
        }
        return;
      }
      case SyntaxKind.CtorPattern: {
        const target = names[0] === undefined
          ? undefined
          : this.targets.get(names[0]);
        const bindingNode = names[1];
        if (target?.kind === "builtin" && target.name === "Some") {
          let element = this.table.error;
          if (domain.kind === "option") {
            element = domain.element;
            this.reach(node, state, "Some");
          } else if (!silent) {
            this.foreign(node, "`Some`", domain);
          }
          const binding = this.bindLocal(bindingNode, element);
          this.patternFact(node, { kind: "some", binding });
        } else if (target?.kind === "builtin") {
          this.report(
            "pattern/004",
            `\`${target.name}\` cannot be a constructor pattern with a binding`,
            node,
          );
          this.bindLocal(bindingNode, this.table.error);
          this.patternFact(node, { kind: "invalid" });
        } else if (target?.kind === "error") {
          let type = this.table.error;
          if (domain.kind === "errors" && domain.ids.includes(target.id)) {
            type = this.table.named(target.id);
            this.reach(node, state, `E:${target.id}`);
          } else if (!silent) {
            this.foreign(node, `\`${shortName(target.id)}\``, domain);
          }
          const binding = this.bindLocal(bindingNode, type);
          this.patternFact(node, { kind: "error", error: target.id, binding });
        } else {
          this.bindLocal(bindingNode, this.table.error);
          this.patternFact(node, { kind: "invalid" });
        }
        return;
      }
      case SyntaxKind.LiteralPattern: {
        const value = literalOf(this.tree, node);
        if (value === undefined) {
          this.patternFact(node, { kind: "invalid" });
          return;
        }
        let fits = false;
        if (domain.kind === "literals") {
          fits = domain.values.includes(value);
        } else if (domain.kind === "open") {
          fits = domain.primitive === "string"
            ? typeof value === "string"
            : domain.primitive === "int"
            ? typeof value === "number" && Number.isSafeInteger(value)
            : typeof value === "number";
        }
        if (fits) {
          this.reach(node, state, `L:${JSON.stringify(value)}`);
        } else if (!silent) {
          this.foreign(node, describeLiteral(value), domain);
        }
        this.patternFact(node, { kind: "literal", value });
        return;
      }
      case SyntaxKind.RecordPattern:
        this.recordPattern(node, domain, state, silent);
        return;
      default:
        this.patternFact(node, { kind: "invalid" });
    }
  }

  private recordPattern(
    node: NodeId,
    domain: Domain,
    state: MatchState,
    silent: boolean,
  ): void {
    const parts = this.kids(node);
    const fields = parts.filter((k) =>
      kindOf(this.tree, k) === SyntaxKind.PatternField
    );
    const spread = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.SpreadPattern
    );
    const spreadName = spread === undefined
      ? undefined
      : this.kidsOfKind(spread, SyntaxKind.Name)[0];
    const invalid = (
      message?: string,
      code: DiagnosticCode = "pattern/004",
    ): void => {
      if (message !== undefined) this.report(code, message, node);
      this.bindLocal(spreadName, this.table.error);
      this.patternFact(node, { kind: "invalid" });
    };
    if (domain.kind !== "tagged") {
      if (silent) return invalid();
      this.foreign(node, "a tagged record pattern", domain);
      return invalid();
    }
    if (fields.length !== 1) {
      return invalid(
        'a tagged record pattern needs exactly one discriminator field, as in `{ kind: "circle", ...c }`',
      );
    }
    const fieldParts = this.kids(fields[0]);
    const labelNode = fieldParts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.Name
    );
    const literalNode = fieldParts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.LiteralPattern
    );
    const label = labelNode === undefined
      ? undefined
      : nameTextOf(this.tree, labelNode);
    const value = literalNode === undefined
      ? undefined
      : literalOf(this.tree, literalNode);
    if (label === undefined || value === undefined) return invalid();
    if (typeof value !== "string") {
      return invalid(
        "the discriminator of a tagged record pattern must be a string literal",
      );
    }
    if (state.tagField !== undefined && state.tagField !== label) {
      return invalid(
        `an earlier arm matches on the field \`${state.tagField}\`; every arm must use the same discriminator field`,
      );
    }
    state.tagField = label;
    const known = taggedValues(domain.members, label);
    if (!known.includes(value)) {
      this.foreign(
        node,
        known.length === 0
          ? `the field \`${label}\``
          : `${label}: ${describeLiteral(value)}`,
        domain,
      );
      return invalid();
    }
    this.reach(node, state, `T:${label}:${JSON.stringify(value)}`);
    const narrowed = narrowTagged(domain.members, label, value).map((m) =>
      m.type
    );
    const binding = this.bindLocal(spreadName, this.table.union(narrowed));
    this.patternFact(node, {
      kind: "tag",
      field: label,
      value,
      binding: binding ?? null,
    });
  }
}

function describeDomain(domain: Domain): string {
  switch (domain.kind) {
    case "option":
      return "an option";
    case "errors":
      return `the errors ${domain.ids.map(shortName).join(" | ")}`;
    case "tagged":
      return "a tagged record union";
    case "literals":
      return `the values ${domain.values.map(describeLiteral).join(" | ")}`;
    case "open":
      return `a ${domain.primitive}`;
    case "error":
    case "unsupported":
      return "an unsupported type";
  }
}

// ------------------------------------------------------------------ entry points

/** Checks the body of a module-level function against its signature. */
export function checkFunctionBody(
  benv: BodyEnv,
  signature: FunctionSignature,
  bodyNode: NodeId | undefined,
): FunctionRun {
  const checker = new BodyChecker(benv, signature.id);
  for (const parameter of signature.parameters) {
    if (parameter.id !== undefined) {
      checker.body.locals.set(parameter.id, parameter.type.ref);
    }
  }
  const explicit = signature.contract === "explicit" &&
    signature.result !== undefined;
  const contract: Contract = {
    result: explicit ? signature.result?.ref : undefined,
    failures: explicit ? signature.failures : [],
    requirements: explicit ? signature.requirements : [],
  };
  const run = checker.checkBody(bodyNode, contract, undefined);
  for (const parameter of signature.parameters) {
    if (parameter.borrow) {
      checker.checkBorrowedParameter(bodyNode, parameter, run.result);
    }
  }
  const table = benv.env.table;
  const type = table.function({
    execution: run.execution,
    parameters: signature.parameters.map((p) => p.type.ref),
    ...(signature.parameters.some((p) => p.borrow)
      ? { borrows: signature.parameters.map((p) => p.borrow) }
      : {}),
    result: run.result,
    failures: sortedUnique(run.failures),
    requirements: sortedUnique(run.requirements),
  });
  return {
    table: checker.body,
    body: run.body,
    result: run.result,
    failures: run.failures,
    requirements: run.requirements,
    mode: run.execution,
    type,
    diagnostics: checker.sink,
  };
}

/** Checks the initializer of a module-level constant. */
export function checkConstantBody(
  benv: BodyEnv,
  signature: ConstantSignature,
  initNode: NodeId | undefined,
): ConstantRun {
  const checker = new BodyChecker(benv, signature.id);
  const run = checker.checkConstant(initNode, signature.type?.ref);
  return {
    table: checker.body,
    init: run.init,
    type: run.type,
    diagnostics: checker.sink,
  };
}

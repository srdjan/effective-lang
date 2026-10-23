// Expression checking. A `BodyChecker` checks one declaration
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
import {
  arrowBody,
  initOf,
  isPatternKind,
  isTypeKind,
  kidsOf,
  literalOf,
  nameTextOf,
  operatorOf,
} from "./syntax_queries.ts";
import { isBoolean, operatorResult } from "./check_binary.ts";
import {
  checkCoverage,
  type MatchState,
  pattern,
  type PatternContext,
} from "./check_patterns.ts";
import { SCHEMA_ERROR_ID, SCHEMA_ISSUE_ID } from "./ir.ts";
import type {
  CapabilityId,
  ErrorId,
  Execution,
  LocalId,
  Result,
  TypeId,
  ValueId,
} from "./ir.ts";
import type { PreludeName, Target } from "./resolve.ts";
import type { Span } from "./source.ts";
import {
  kindOf,
  type NodeId,
  nodeSpan,
  SyntaxKind,
  type SyntaxTree,
} from "./syntax.ts";
import {
  type ConstantSignature,
  type FunctionSignature,
  type TypeEnv,
  TypeLowerer,
} from "./check.ts";
import { domainOf, flattenMembers, type LiteralValue } from "./patterns.ts";
import {
  type ArrowParameterFact,
  type BodyTable,
  combine,
  EFFECT_ONLY,
  type EffectSet,
  isQuiet,
  newBodyTable,
  type NodeFact,
  type NodeInfo,
  PURE_EFFECTS,
  without,
} from "./tables.ts";
import type { TypeRef, TypeTable } from "./types.ts";
import { isErrorId, isTypeId, shortName } from "./ids.ts";
import {
  type Arg,
  type BuiltinContext,
  type ConcurrencyOperation,
  type FunctionNode,
  invocationOf,
  type LiteralField,
  type LocalUse,
} from "./check_builtins/context.ts";
import type { CollectionContext } from "./check_builtins/collections.ts";
import type { EffectContext } from "./check_builtins/effect.ts";
import type { FiberContext } from "./check_builtins/fiber.ts";
import type { LayerContext } from "./check_builtins/layer.ts";
import { type CoreRowName, FAMILY_ROWS } from "./check_builtins/registry.ts";
import type {
  BuiltinRow,
  PreludeCallName,
  Prologue,
  Rows,
} from "./check_builtins/rows.ts";
import type { SchemaContext } from "./check_builtins/schema.ts";
import {
  checkBorrowedParameter,
  type ScopeContext,
} from "./check_builtins/scope.ts";
import type { StreamContext } from "./check_builtins/stream.ts";

// ------------------------------------------------------------------ environment

/** What the body checker needs from the module and from the project. */
export interface BodyEnv {
  readonly env: TypeEnv;
  /** The type of a module-level value, local or imported. The error type when unknown. */
  readonly values: (id: ValueId) => TypeRef;
  /** The function type of a service method. The error type when unknown. */
  readonly methodType: (capability: CapabilityId) => TypeRef;
}

/** The contract of a function body. A result means the contract is explicit and closed. */
export interface Contract {
  readonly result: TypeRef | undefined;
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
}

/** What checking the body expression of a function produces. */
export interface BodyOutcome {
  /** The info of the body expression. Absent when the body is missing. */
  readonly body: NodeInfo | undefined;
  /** The declared or inferred result type. */
  readonly result: TypeRef;
  /** The invocation sets: declared for an explicit contract, inferred otherwise. */
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  /** The invocation mode. */
  readonly mode: Execution;
}

/** What checking one function body produces. */
export interface FunctionRun extends BodyOutcome {
  readonly table: BodyTable;
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

interface ArrowContext {
  readonly parameters: readonly TypeRef[];
  readonly result: TypeRef | undefined;
}

function names(ids: readonly string[]): string {
  return ids.map(shortName).join(", ");
}

// ------------------------------------------------------------------ the checker

// Family contexts expose only the checker operations and read views they need.
class BodyChecker
  implements
    BuiltinContext,
    CollectionContext,
    EffectContext,
    LayerContext,
    FiberContext,
    ScopeContext,
    StreamContext,
    SchemaContext,
    PatternContext {
  readonly sink: Diagnostic[] = [];
  readonly body: BodyTable;
  private readonly lowerer: TypeLowerer;
  readonly tree: SyntaxTree;
  readonly table: TypeTable;
  readonly targets: ReadonlyMap<NodeId, Target>;
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

  get services(): Pick<TypeEnv["services"], "get"> {
    return this.benv.env.services;
  }

  get infos(): ReadonlyMap<NodeId, NodeInfo> {
    return this.body.info;
  }

  get facts(): ReadonlyMap<NodeId, NodeFact> {
    return this.body.facts;
  }

  valueType(id: ValueId): TypeRef {
    return this.benv.values(id);
  }

  // -------------------------------------------------------------- helpers

  kids(node: NodeId): NodeId[] {
    return kidsOf(this.tree, node);
  }

  kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[] {
    return this.kids(node).filter((k) => kindOf(this.tree, k) === kind);
  }

  private span(node: NodeId): Span {
    return nodeSpan(this.tree, node);
  }

  report(code: DiagnosticCode, message: string, node: NodeId): void {
    this.sink.push(makeDiagnostic(code, message, this.span(node)));
  }

  private show(ref: TypeRef): string {
    return this.table.show(ref);
  }

  isError(ref: TypeRef): boolean {
    return this.table.node(ref).kind === "error";
  }

  finish(node: NodeId, type: TypeRef, eff: EffectSet): NodeInfo {
    const info: NodeInfo = {
      type,
      failures: eff.failures,
      requirements: eff.requirements,
      mode: eff.mode,
    };
    this.body.info.set(node, info);
    return info;
  }

  fact(node: NodeId, fact: NodeFact): void {
    this.body.facts.set(node, fact);
  }

  private errorInfo(node: NodeId): NodeInfo {
    this.errorCount++;
    return this.finish(node, this.table.error, PURE_EFFECTS);
  }

  /** Reports a mismatch when `found` does not fit `expected`. Returns true when it fits. */
  fits(
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
  widen(ref: TypeRef): TypeRef {
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
    if (value === null) return this.table.literal(null);
    if (typeof value === "string") return this.table.string;
    if (typeof value === "boolean") return this.table.boolean;
    return Number.isSafeInteger(value) ? this.table.int : this.table.number;
  }

  functionOf(ref: TypeRef): FunctionNode | undefined {
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
  ): BodyOutcome {
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
        mode: failures.length + requirements.length > 0 ? "effect" : "pure",
      };
    }
    const body = this.expr(bodyNode, contract.result ?? hint);
    if (contract.result === undefined) {
      return {
        body,
        result: this.widen(body.type),
        failures: body.failures,
        requirements: body.requirements,
        mode: body.mode,
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
      mode: contract.failures.length + contract.requirements.length > 0
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

  argInfo(arg: Arg, expected?: TypeRef): NodeInfo {
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
            "a local function cannot refer to itself; a recursive function must be a module-level function with an explicit signature",
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
      case "type":
      case "error":
      case "service":
      case "cap":
      case "builtin-type":
      case "field":
      case "unresolved":
        return this.errorInfo(node);
      default: {
        const unreachable: never = target;
        return unreachable;
      }
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
      case "type": {
        const record = this.table.dataRecordOf(target.id);
        return record === undefined
          ? this.brandConstruction(node, target.id, args)
          : this.dataConstruction(node, target.id, record, args);
      }
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
      case "service":
      case "builtin-type":
      case "field":
      case "unresolved":
        return this.unresolvedCall(node, args);
      default: {
        const unreachable: never = target;
        return unreachable;
      }
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
    return this.finish(
      node,
      fn.result,
      combine([base, ...infos, invocationOf(fn), extra]),
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
    if (id === SCHEMA_ERROR_ID || id === SCHEMA_ISSUE_ID) {
      const infos = args.map((arg) => this.argInfo(arg));
      this.report(
        "type-mismatch/010",
        `${
          id === SCHEMA_ERROR_ID ? "SchemaError" : "SchemaIssue"
        } cannot be constructed directly`,
        node,
      );
      return this.finish(node, this.table.error, combine(infos));
    }
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
        // literal without a spread. A pipeline stage with one piped value has no
        // record literal of its own, so the stage is the error. A value that
        // does not fit has its type report already, as in the direct form.
        const piped = arg.pre !== undefined && args.length === 1;
        if (
          fits && !this.isError(info.type) &&
          (piped || !this.isPlainRecordLiteral(arg.node))
        ) {
          this.report(
            "type-mismatch/010",
            `the error \`${shortName(id)}\` needs a record literal such as ${
              shortName(id)
            }({ field: value })`,
            piped ? node : arg.node,
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
    return this.constructFrom(node, id, base, "brand", args);
  }

  private dataConstruction(
    node: NodeId,
    id: TypeId,
    record: TypeRef,
    args: readonly Arg[],
  ): NodeInfo {
    this.fact(node, { kind: "data-construction", data: id });
    return this.constructFrom(node, id, record, "data type", args);
  }

  /** The single argument of a brand or data constructor must fit the base type. */
  private constructFrom(
    node: NodeId,
    id: TypeId,
    base: TypeRef,
    noun: "brand" | "data type",
    args: readonly Arg[],
  ): NodeInfo {
    if (args.length !== 1) {
      this.report(
        "type-mismatch/004",
        `the ${noun} \`${
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
    name: PreludeName,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    if (name === "None") {
      const infos = args.map((a) => this.argInfo(a));
      this.report(
        "type-mismatch/008",
        `\`${name}\` is a value, not a function`,
        node,
      );
      return this.finish(node, this.table.error, combine(infos));
    }
    return this.preludeCall(node, name, args, expected);
  }

  /** Runs the handler of a prelude name. The table has one row for each name except `None`. */
  private preludeCall<K extends PreludeCallName>(
    node: NodeId,
    name: K,
    args: readonly Arg[],
    expected: TypeRef | undefined,
  ): NodeInfo {
    const row: BuiltinRow<K, BodyChecker> = BodyChecker.PRELUDE_ROWS[name];
    if (row.prologue !== "own-arity") {
      const bailed = this.runPrologue(node, name, args, row.prologue);
      if (bailed !== undefined) return bailed;
    }
    return row.handle(this, node, name, args, expected);
  }

  /** Runs a prologue. Returns the result of a wrong argument count, or undefined. */
  private runPrologue<K extends PreludeCallName>(
    node: NodeId,
    name: K,
    args: readonly Arg[],
    prologue: Prologue<K, BodyChecker>,
  ): NodeInfo | undefined {
    const { fact, bailFact } = prologue;
    if (fact !== undefined) {
      this.fact(
        node,
        typeof fact === "function" ? fact(this, name, args) : fact,
      );
    }
    const count = typeof prologue.arity === "number"
      ? prologue.arity
      : prologue.arity(name, args);
    if (!this.arity(node, name, count, args, prologue.usage)) {
      if (bailFact !== undefined) this.fact(node, bailFact);
      const infos = args.map((a) => this.argInfo(a));
      return this.finish(
        node,
        this.table.error,
        combine(prologue.bail === "effect" ? [...infos, EFFECT_ONLY] : infos),
      );
    }
    if (prologue.pipeline === "direct") this.noPipeline(name, args);
    return undefined;
  }

  /** The rows of the builtins that call private members of the checker. */
  private static readonly CORE_ROWS: Rows<CoreRowName, BodyChecker> = {
    unbrand: {
      prologue: "own-arity",
      handle: (c, node, _name, args) => c.unbrandCall(node, args),
    },
    Some: {
      prologue: "own-arity",
      handle: (c, node, _name, args, expected) =>
        c.someCall(node, args, expected),
    },
  };

  /**
   * The row of each prelude call name. The family files own the rows of the
   * other builtins. A row with the prologue `"own-arity"` tests its own
   * argument count. `CORE_ROWS` must come first, because static initializers
   * run in source order.
   */
  private static readonly PRELUDE_ROWS: Rows<PreludeCallName, BodyChecker> = {
    ...FAMILY_ROWS,
    ...BodyChecker.CORE_ROWS,
  };

  /** Reports a wrong argument count for a prelude call. Returns true when the count is right. */
  arity(
    node: NodeId,
    name: string,
    expectedCount: number,
    args: readonly Arg[],
    usage?: string,
  ): boolean {
    if (args.length === expectedCount) return true;
    this.report(
      "type-mismatch/004",
      usage ??
        `\`${name}\` takes ${expectedCount} argument${
          expectedCount === 1 ? "" : "s"
        }, but ${args.length} ${args.length === 1 ? "is" : "are"} given`,
      node,
    );
    return false;
  }

  private unbrandCall(node: NodeId, args: readonly Arg[]): NodeInfo {
    this.fact(node, { kind: "unbrand" });
    const rightCount = this.arity(node, "unbrand", 1, args);
    const infos = args.map((a) => this.argInfo(a));
    let type = this.table.error;
    if (rightCount) {
      const unfolded = this.table.node(this.table.unfold(infos[0].type));
      if (
        unfolded.kind === "named" && isTypeId(unfolded.id) &&
        this.table.isOpaque(unfolded.id)
      ) {
        this.report(
          "type-mismatch/010",
          "an opaque type cannot be unbranded in source",
          args[0].node,
        );
        return this.finish(node, this.table.error, combine(infos));
      }
      const base = unfolded.kind === "named" && !isErrorId(unfolded.id)
        ? this.table.dataRecordOf(unfolded.id) ??
          this.table.brandBaseOf(unfolded.id)
        : undefined;
      if (base !== undefined) {
        type = base;
      } else if (!this.isError(infos[0].type)) {
        this.report(
          "type-mismatch/010",
          `\`unbrand\` needs a brand or data value, but the value has type ${
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

  /**
   * Reads an option record of exactly `count` fields, each `name: literal`, and
   * gives the fields by name. It fails with "shape" for a pipeline left side, a
   * value that is not a record, another field count, a field of another form,
   * or a repeated name. It reports nothing and records nothing.
   */
  literalRecord(
    arg: Arg,
    count: number,
  ): Result<ReadonlyMap<string, LiteralField>, "shape"> {
    const shape = { ok: false, error: "shape" } as const;
    if (
      arg.pre !== undefined ||
      kindOf(this.tree, arg.node) !== SyntaxKind.RecordExpr
    ) return shape;
    const fields = this.kids(arg.node);
    if (fields.length !== count) return shape;
    const values = new Map<string, LiteralField>();
    for (const field of fields) {
      if (kindOf(this.tree, field) !== SyntaxKind.RecordField) return shape;
      const parts = this.kids(field);
      const label = parts.find((part) =>
        kindOf(this.tree, part) === SyntaxKind.Name
      );
      const valueNode = parts.find((part) => part !== label);
      if (
        label === undefined || valueNode === undefined ||
        kindOf(this.tree, valueNode) !== SyntaxKind.LiteralExpr
      ) return shape;
      const name = nameTextOf(this.tree, label);
      if (name === undefined || values.has(name)) return shape;
      values.set(name, {
        node: valueNode,
        value: literalOf(this.tree, valueNode),
      });
    }
    return { ok: true, value: values };
  }

  /** The zero-argument function type of a `retry` or `provide` job, or undefined after a diagnostic. */
  jobFunction(
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

  /**
   * The uses of a local in `body`, in syntax order. Each use has its two nearest
   * ancestors and tells whether an arrow function encloses it. With `shorthand`,
   * the name in a shorthand field such as `{ id }` also counts as a use.
   */
  localUses(
    body: NodeId,
    id: LocalId,
    shorthand = false,
  ): LocalUse[] {
    const uses: LocalUse[] = [];
    const visit = (
      node: NodeId,
      parent: NodeId | undefined,
      grandparent: NodeId | undefined,
      nested: boolean,
    ): void => {
      const kind = kindOf(this.tree, node);
      const target = this.targets.get(node);
      if (
        (kind === SyntaxKind.NameExpr ||
          (shorthand && kind === SyntaxKind.Name && parent !== undefined &&
            kindOf(this.tree, parent) === SyntaxKind.ShorthandField)) &&
        target?.kind === "local" && target.id === id
      ) {
        uses.push({ node, parent, grandparent, nested });
      }
      for (const child of this.kids(node)) {
        visit(child, node, parent, nested || kind === SyntaxKind.ArrowExpr);
      }
    };
    visit(body, undefined, undefined, false);
    return uses;
  }

  noPipeline(name: string, args: readonly Arg[]): void {
    if (args[0]?.pre !== undefined) {
      this.report(
        "type-mismatch/010",
        `\`${name}\` requires direct call syntax`,
        args[0].node,
      );
    }
  }

  inlineStreamCallback(name: string, arg: Arg): void {
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

  /**
   * Checks a collection callback. An inline arrow receives its parameter
   * types from the context. Only traverse permits invocation effects.
   */
  callback(
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

  concurrencyBound(
    arg: Arg,
    operation: ConcurrencyOperation = "traverse",
  ): number | "unbounded" | undefined {
    const record = this.literalRecord(arg, 1);
    const literal = record.ok
      ? record.value.get("concurrency")?.value
      : undefined;
    if (literal === "unbounded") return literal;
    if (
      typeof literal === "number" && Number.isSafeInteger(literal) &&
      literal > 0
    ) return literal;
    this.report(
      "type-mismatch/010",
      `\`${operation}\` needs \`{ concurrency: N }\` with a positive safe integer literal, or \`{ concurrency: "unbounded" }\``,
      arg.node,
    );
    return undefined;
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
    // The lowering evaluates a left value with effects in its own binding, so
    // the handler sees it as pure and the stage keeps its own sets.
    const quiet = isQuiet(leftInfo);
    const pre: NodeInfo = quiet
      ? leftInfo
      : { type: leftInfo.type, ...PURE_EFFECTS };
    const args: Arg[] = [
      { node: left, pre },
      ...(argList === undefined
        ? []
        : this.kids(argList).map((n) => ({ node: n }))),
    ];
    const q = this.invoke(
      stage,
      qualified,
      this.targets.get(qualified),
      true,
      args,
      expected,
    );
    if (quiet) return this.finish(node, q.type, q);
    this.body.stageSets.set(stage, {
      failures: q.failures,
      requirements: q.requirements,
      mode: q.mode,
    });
    const combined = combine([leftInfo, q]);
    this.finish(stage, q.type, combined);
    return this.finish(node, q.type, combined);
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
    if (node.kind === "named") {
      if (isErrorId(node.id)) {
        const record = this.table.errorRecordOf(node.id);
        const recordNode = record === undefined
          ? undefined
          : this.table.node(record);
        return recordNode?.kind === "record" ? recordNode.fields : undefined;
      }
      // A data type, or a brand of a record, has the fields of its base.
      const base = this.table.dataRecordOf(node.id) ??
        this.table.brandBaseOf(node.id);
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
    if (expected !== undefined && target?.kind === "tuple") {
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
      return this.finish(node, expected, combine(infos));
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
    if (hint !== undefined && expected !== undefined) {
      return this.finish(node, expected, combine(infos));
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
  fieldParts(
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
    literals: ReadonlyMap<string, LiteralValue>,
    known: ReadonlyMap<string, TypeRef>,
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
    const discriminated = fitting.filter((c) =>
      [...literals].every(([label, value]) => {
        const field = c.fields.find((f) => f.name === label);
        return field !== undefined &&
          this.table.isAssignable(this.table.literal(value), field.type);
      })
    );
    const narrowed = (discriminated.length > 0 ? discriminated : fitting)
      .filter(
        (c) =>
          [...known].every(([label, type]) => {
            const field = c.fields.find((f) => f.name === label);
            return field !== undefined &&
              this.table.isAssignable(type, field.type);
          }),
      );
    return narrowed[0] ?? discriminated[0] ?? fitting[0] ?? candidates[0];
  }

  /**
   * The type of a field value that a name reference gives without context: a
   * settled local, a value, or a provider. It records no fact and reports nothing.
   */
  private knownNameType(node: NodeId): TypeRef | undefined {
    const target = this.targets.get(node);
    if (target === undefined) return undefined;
    let type: TypeRef | undefined;
    if (target.kind === "local") {
      if (!this.pendingLocals.has(target.id)) {
        type = this.body.locals.get(target.id);
      }
    } else if (target.kind === "value" || target.kind === "provider") {
      type = this.benv.values(target.id);
    }
    return type === undefined || type === this.table.error ? undefined : type;
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
    const literals = new Map<string, LiteralValue>();
    const known = new Map<string, TypeRef>();
    for (const { parts } of parsed) {
      if (parts === undefined) continue;
      if (parts.value === undefined) {
        const type = this.knownNameType(parts.labelNode);
        if (type !== undefined) known.set(parts.label, type);
        continue;
      }
      let valueNode = parts.value;
      while (kindOf(this.tree, valueNode) === SyntaxKind.ParenExpr) {
        const inner = this.kids(valueNode)[0];
        if (inner === undefined) break;
        valueNode = inner;
      }
      if (kindOf(this.tree, valueNode) === SyntaxKind.NameExpr) {
        const type = this.knownNameType(valueNode);
        if (type !== undefined) known.set(parts.label, type);
        continue;
      }
      if (kindOf(this.tree, valueNode) !== SyntaxKind.LiteralExpr) continue;
      const value = literalOf(this.tree, valueNode);
      if (value !== undefined) literals.set(parts.label, value);
    }
    const target = this.recordTarget(expected, labels, literals, known);
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

  private binary(node: NodeId): NodeInfo {
    const kids = this.kids(node);
    const operator = operatorOf(this.tree, node);
    if (operator === undefined || kids.length < 2) return this.errorInfo(node);
    const left = this.expr(kids[0]);
    const equality = operator === "===" || operator === "!==";
    const right = this.expr(kids[1], equality ? left.type : undefined);
    const eff = combine([left, right]);
    const result = operatorResult(this.table, operator, left.type, right.type);
    if (result.mismatch) {
      this.report(
        "type-mismatch/007",
        `the operator \`${operator}\` does not accept operands of type ${
          this.show(left.type)
        } and ${this.show(right.type)}`,
        node,
      );
    }
    return this.finish(node, result.type, eff);
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
    const bodyNode = arrowBody(this.tree, node);
    const contract: Contract = {
      result: resultNode === undefined
        ? undefined
        : this.lowerer.lower(resultNode).ref,
      failures: this.lowerer.failures(failsNode),
      requirements: this.lowerer.requirements(usesNode),
    };
    const run = this.checkBody(bodyNode, contract, context?.result);
    const type = this.table.function({
      execution: run.mode,
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
    const init = initOf(this.tree, node, nameNode);
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
    if (!this.isError(cond.type) && !isBoolean(this.table, cond.type)) {
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
        }; version 0 matches options, errors, data types, tagged records, literals, and primitives`,
        subjectNode,
      );
    } else if (domain.kind === "mixed") {
      this.report(
        "pattern/004",
        `a match cannot take a value of type ${
          this.show(subject.type)
        }, which mixes data or error types with other types; a match over names needs data or error types only`,
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
        isPatternKind(kindOf(this.tree, k))
      );
      const bodyNode = parts.filter((k) => k !== patternNode).pop();
      if (patternNode !== undefined) {
        pattern(this, patternNode, domain, state);
      }
      if (bodyNode === undefined) continue;
      const info = this.expr(bodyNode, expected);
      infos.push(info);
      branches.push({ node: bodyNode, type: info.type });
      this.finish(arm, info.type, info);
    }
    if (!state.wildcard) checkCoverage(this, node, domain, state, arms.length);
    const type = this.joinResults(branches, expected);
    return this.finish(node, type, combine(infos));
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
      checkBorrowedParameter(checker, bodyNode, parameter, run.result);
    }
  }
  const table = benv.env.table;
  const type = table.function({
    execution: run.mode,
    parameters: signature.parameters.map((p) => p.type.ref),
    borrows: signature.parameters.map((p) => p.borrow),
    result: run.result,
    failures: run.failures,
    requirements: run.requirements,
  });
  return {
    table: checker.body,
    body: run.body,
    result: run.result,
    failures: run.failures,
    requirements: run.requirements,
    mode: run.mode,
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

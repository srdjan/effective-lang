// The declaration level of the checker (plan part A3a). It lowers every type
// syntax node to an interned type and builds the declarations of a module:
// types, errors, services, providers, and the signatures of module-level consts.
// It reports the declaration diagnostics. It does not look at expression
// bodies. Part A3b checks the bodies in check_expr.ts and drives the whole
// project in check_project.ts.
//
// Seams that A3b uses.
// - `TypeLowerer` lowers any type syntax node of a module. The body checker uses
//   it for the annotations inside bodies.
// - `ModuleDeclarations.values` holds one signature for each module-level const
//   and provider. The body checker checks each body against its signature.
// - A function signature without a written result has no result and empty
//   sets. A set whose clause is not written (`written.fails` or `written.uses`
//   is false) is open: the body checker infers it, and the signature holds an
//   empty set for it.
// - The execution mode and the open sets of a function come from a `Solved`
//   lookup that the body checker supplies. `executionOf` and `signatureType`
//   take the lookup and return a Result error when an entry is missing.

import type { Analysis } from "./analyze.ts";
import {
  type Diagnostic,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
import type { DeclEntry } from "./index.ts";
import type {
  CapabilityId,
  DeclarationId,
  ErrorDecl,
  ErrorId,
  Execution,
  Field,
  FunctionType,
  LocalId,
  MethodDecl,
  ServiceDecl,
  ServiceId,
  Type,
  TypeDecl,
  TypeId,
  ValueId,
  WrittenParts,
} from "./ir.ts";
import { TokenKind } from "./lex.ts";
import { type Solved, stronglyConnectedComponents } from "./modes.ts";
import { flattenMembers } from "./patterns.ts";
import type { ModuleInfo } from "./project.ts";
import type { Target } from "./resolve.ts";
import type { Result, Span } from "./source.ts";
import {
  childrenOf,
  kindOf,
  type NodeId,
  nodeSpan,
  nodeText,
  SyntaxKind,
  type SyntaxTree,
  TYPE_WORDS,
  walk,
} from "./syntax.ts";
import {
  containsDeferredType,
  containsOpaqueType,
  dataOnly,
  guardedRecord,
  sortedUnique,
  type TypeNode,
  type TypeRef,
  type TypeTable,
} from "./types.ts";
import {
  declarationId,
  type DeclarationPrefix,
  isErrorId,
  isTypeId,
  serviceOfCapability,
} from "./ids.ts";
import {
  initOf,
  isTypeKind,
  kidsOf,
  literalOf,
  nameTextOf,
} from "./syntax_queries.ts";
import { compareText } from "./util.ts";

// ------------------------------------------------------------------ shapes

/** An interned type together with its IR tree in source order. */
export interface Lowered {
  readonly ref: TypeRef;
  readonly ir: Type;
}

/** The declarations that an imported module supplies, as an interface carries them. */
export interface TypeGraph {
  readonly types: readonly TypeDecl[];
  readonly errors: readonly ErrorDecl[];
  readonly services: readonly ServiceDecl[];
}

/** Everything that type lowering reads about one module. */
export interface TypeEnv {
  readonly module: string;
  readonly tree: SyntaxTree;
  readonly targets: ReadonlyMap<NodeId, Target>;
  readonly table: TypeTable;
  /** Local and imported services by identity. */
  readonly services: Map<ServiceId, ServiceDecl>;
}

type FunctionNode = Extract<TypeNode, { readonly kind: "function" }>;

interface ParameterSignature {
  readonly name: string;
  readonly borrow: boolean;
  /** The local identity from the resolver. Absent in a function type, where names are labels. */
  readonly id: LocalId | undefined;
  readonly type: Lowered;
  /** True when the source gives the parameter a type annotation. */
  readonly annotated: boolean;
  /** Covers the name and its annotation. */
  readonly span: Span;
}

interface SignatureBase {
  readonly name: string;
  readonly exported: boolean;
  /** The declaration node. */
  readonly node: NodeId;
  readonly nameNode: NodeId;
  /** The span of the whole declaration. */
  readonly span: Span;
  readonly nameSpan: Span;
}

export interface FunctionSignature extends SignatureBase {
  readonly kind: "function";
  readonly id: ValueId;
  /**
   * The parts that close the contract. A part that is not written is inferred.
   * An exported function closes both sets: an omitted clause is an empty set.
   */
  readonly written: WrittenParts;
  /** Where a written result comes from: the arrow, or the binding type annotation. */
  readonly annotation: "arrow" | "binding" | "none";
  readonly parameters: readonly ParameterSignature[];
  /** Absent when the result is not written. */
  readonly result: Lowered | undefined;
  /** Sorted and unique. Empty when the set is open. */
  readonly failures: readonly ErrorId[];
  /** Sorted and unique. A whole service is expanded to all its methods. Empty when the set is open. */
  readonly requirements: readonly CapabilityId[];
  /** Present when a binding type requires pure execution. */
  readonly expectedExecution?: "pure";
}

export interface ConstantSignature extends SignatureBase {
  readonly kind: "constant";
  readonly id: ValueId;
  /** The binding type annotation, when present. */
  readonly type: Lowered | undefined;
}

interface ProviderSignature extends SignatureBase {
  readonly kind: "provider";
  readonly id: ValueId;
  readonly provides: readonly CapabilityId[];
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  /** The provider type: acquisition execution is always `effect`. */
  readonly type: Lowered;
}

export type ValueSignature =
  | FunctionSignature
  | ConstantSignature
  | ProviderSignature;

export interface ModuleDeclarations {
  readonly module: string;
  readonly env: TypeEnv;
  /** Source order. Duplicate names after the first are left out. */
  readonly types: readonly TypeDecl[];
  readonly errors: readonly ErrorDecl[];
  readonly services: readonly ServiceDecl[];
  readonly methodTypes: ReadonlyMap<CapabilityId, TypeRef>;
  /** Module-level consts and providers in source order. */
  readonly values: ReadonlyMap<ValueId, ValueSignature>;
  /** Identities of the exported declarations, sorted. */
  readonly exports: readonly DeclarationId[];
  /** Declaration diagnostics of this module, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

// ------------------------------------------------------------------ modes

/** The mode map of a module: the invocation mode of each function. */
export type ModeMap = ReadonlyMap<ValueId, Execution>;
/** Consumers can look up a solved state without owning or mutating the map. */
export type SolvedLookup = Pick<ReadonlyMap<ValueId, Solved>, "get">;

type SignatureError =
  | { readonly tag: "missing-mode"; readonly id: ValueId }
  | { readonly tag: "inferred-contract"; readonly id: ValueId };

/**
 * The lookup of a mode map for a signature whose sets are closed. Exported
 * functions are closed, so their sets never come from the lookup.
 */
export function modesAsSolved(modes: Pick<ModeMap, "get">): SolvedLookup {
  return {
    get: (id) => {
      const mode = modes.get(id);
      return mode === undefined
        ? undefined
        : { mode, failures: [], requirements: [] };
    },
  };
}

/**
 * True when the body decides part of the contract of a function with a written
 * result: the mode, because the closed sets are empty, or an open set.
 */
export function isPendingMode(signature: FunctionSignature): boolean {
  const { written } = signature;
  return written.result &&
    !(written.fails && written.uses &&
      signature.failures.length + signature.requirements.length > 0);
}

/**
 * The mode and the sets of a signature with a written result. A closed set is
 * the written one. An open set and a pending mode come from `solved`, which must
 * hold an entry then.
 */
function contractOf(
  signature: FunctionSignature,
  solved: SolvedLookup,
): Result<Solved, SignatureError> {
  if (!signature.written.result) {
    return { ok: false, error: { tag: "inferred-contract", id: signature.id } };
  }
  const { written } = signature;
  if (!isPendingMode(signature)) {
    return {
      ok: true,
      value: {
        mode: "effect",
        failures: signature.failures,
        requirements: signature.requirements,
      },
    };
  }
  const entry = solved.get(signature.id);
  if (entry === undefined) {
    return { ok: false, error: { tag: "missing-mode", id: signature.id } };
  }
  const failures = written.fails ? signature.failures : entry.failures;
  const requirements = written.uses
    ? signature.requirements
    : entry.requirements;
  return {
    ok: true,
    value: {
      mode: failures.length + requirements.length > 0 ? "effect" : entry.mode,
      failures,
      requirements,
    },
  };
}

/**
 * The execution mode of a signature with a written result. A nonempty set gives
 * `effect`. Otherwise the mode comes from `solved`.
 */
export function executionOf(
  signature: FunctionSignature,
  solved: SolvedLookup,
): Result<Execution, SignatureError> {
  const contract = contractOf(signature, solved);
  return contract.ok ? { ok: true, value: contract.value.mode } : contract;
}

interface SignatureType {
  readonly ref: TypeRef;
  readonly ir: FunctionType;
}

/** The function type of a signature with a written result, with the state from `solved`. */
export function signatureType(
  table: TypeTable,
  signature: FunctionSignature,
  solved: SolvedLookup,
): Result<SignatureType, SignatureError> {
  const contract = contractOf(signature, solved);
  if (!contract.ok) return contract;
  const result = signature.result;
  if (result === undefined) {
    return { ok: false, error: { tag: "inferred-contract", id: signature.id } };
  }
  return {
    ok: true,
    value: loweredFunction(
      table,
      contract.value.mode,
      signature.parameters.map((p) => p.type),
      result,
      contract.value.failures,
      contract.value.requirements,
      signature.parameters.map((p) => p.borrow),
    ),
  };
}

/** A function type as an interned type and an IR tree. The sets are sorted and unique. */
function loweredFunction(
  table: TypeTable,
  execution: Execution,
  parameters: readonly Lowered[],
  result: Lowered,
  failures: readonly ErrorId[],
  requirements: readonly CapabilityId[],
  borrows?: readonly boolean[],
): SignatureType {
  const failureSet = sortedUnique(failures);
  const requirementSet = sortedUnique(requirements);
  const borrowed = borrows?.some(Boolean) ? { borrows } : {};
  return {
    ref: table.function({
      execution,
      parameters: parameters.map((p) => p.ref),
      ...borrowed,
      result: result.ref,
      failures: failureSet,
      requirements: requirementSet,
    }),
    ir: {
      kind: "function",
      execution,
      parameters: parameters.map((p) => p.ir),
      ...borrowed,
      result: result.ir,
      effects: { failures: failureSet, requirements: requirementSet },
    },
  };
}

// ------------------------------------------------------------------ type lowering

type BuiltinTypeName = Extract<
  Target,
  { readonly kind: "builtin-type" }
>["name"];

/** How a built-in type name lowers. */
type BuiltinTypeRow =
  /** The name takes no type arguments. */
  | {
    readonly kind: "plain";
    readonly build: (lowerer: TypeLowerer) => Lowered;
  }
  /**
   * The name takes `arity` type arguments. The lowerer lowers them in order and
   * calls `build` with them and with their nodes. A wrong count is a report.
   */
  | {
    readonly kind: "generic";
    readonly arity: 1 | 2;
    readonly build: (
      lowerer: TypeLowerer,
      args: readonly Lowered[],
      nodes: readonly NodeId[],
    ) => Lowered;
  };

/** The row of a primitive type name that takes no type arguments. */
function primitiveRow(
  name: "string" | "boolean" | "int" | "number" | "never" | "unknown",
): BuiltinTypeRow {
  return {
    kind: "plain",
    build: (lowerer) => ({
      ref: lowerer.env.table.primitive(name),
      ir: { kind: "primitive", name },
    }),
  };
}

/** Lowers type syntax nodes to interned types and IR trees. Diagnostics go to `sink`. */
export class TypeLowerer {
  constructor(
    readonly env: TypeEnv,
    readonly sink: Diagnostic[],
  ) {}

  private get tree(): SyntaxTree {
    return this.env.tree;
  }

  report(
    code: Diagnostic["code"],
    message: string,
    span: Span,
    related?: readonly { span: Span; message: string }[],
  ): void {
    this.sink.push(makeDiagnostic(code, message, span, related));
  }

  /** Child nodes that are not tokens or Missing nodes. */
  kids(node: NodeId): NodeId[] {
    return kidsOf(this.tree, node);
  }

  kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[] {
    return this.kids(node).filter((k) => kindOf(this.tree, k) === kind);
  }

  span(node: NodeId): Span {
    return nodeSpan(this.tree, node);
  }

  errorLowered(): Lowered {
    return {
      ref: this.env.table.error,
      ir: { kind: "primitive", name: "unknown" },
    };
  }

  /** Lowers a type syntax node. */
  lower(node: NodeId): Lowered {
    const table = this.env.table;
    switch (kindOf(this.tree, node)) {
      case SyntaxKind.NamedType:
        return this.named(node);
      case SyntaxKind.EffectType:
      case SyntaxKind.StreamType:
      case SyntaxKind.SinkType:
      case SyntaxKind.ScheduleType:
      case SyntaxKind.SchemaType:
      case SyntaxKind.LayerType:
        return this.deferredType(node);
      case SyntaxKind.LiteralType:
        return this.literal(node);
      case SyntaxKind.RecordType:
        return this.recordOf(this.fields(node, false));
      case SyntaxKind.TupleType: {
        const elements = this.kids(node).map((k) => this.element(k));
        return {
          ref: table.tuple(elements.map((e) => e.ref)),
          ir: { kind: "tuple", elements: elements.map((e) => e.ir) },
        };
      }
      case SyntaxKind.ArrayType: {
        const inner = this.kids(node)[0];
        if (inner === undefined) return this.errorLowered();
        const element = this.element(inner);
        return {
          ref: table.array(element.ref),
          ir: { kind: "array", element: element.ir },
        };
      }
      case SyntaxKind.UnionType:
        return this.union(node);
      case SyntaxKind.FunctionType:
        return this.functionType(node);
      case SyntaxKind.ParenType: {
        const inner = this.kids(node)[0];
        return inner === undefined ? this.errorLowered() : this.lower(inner);
      }
      default:
        return this.errorLowered();
    }
  }

  /** A record field, array element, or tuple element. `void` is not allowed here. */
  private element(node: NodeId): Lowered {
    const lowered = this.lower(node);
    if (lowered.ref === this.env.table.unit) {
      this.report(
        "type-mismatch/002",
        "`void` cannot be a record field, an array element, or a tuple element",
        this.span(node),
      );
      return this.errorLowered();
    }
    return lowered;
  }

  private literal(node: NodeId): Lowered {
    const value = literalOf(this.tree, node);
    return value === undefined
      ? this.errorLowered()
      : { ref: this.env.table.literal(value), ir: { kind: "literal", value } };
  }

  private named(node: NodeId): Lowered {
    const table = this.env.table;
    const nameNode = this.kidsOfKind(node, SyntaxKind.Name)[0];
    const argsNode = this.kidsOfKind(node, SyntaxKind.TypeArgs)[0];
    const args = argsNode === undefined ? [] : this.kids(argsNode);
    if (nameNode === undefined) return this.errorLowered();
    const name = nameTextOf(this.tree, nameNode) ?? "";
    const target = this.env.targets.get(nameNode);
    if (target === undefined || target.kind === "unresolved") {
      for (const arg of args) this.lower(arg);
      return this.errorLowered();
    }
    if (target.kind === "type" || target.kind === "error") {
      this.noArguments(name, args, argsNode);
      return {
        ref: table.named(target.id),
        ir: { kind: "named", id: target.id },
      };
    }
    if (target.kind !== "builtin-type") return this.errorLowered();
    const row = TypeLowerer.BUILTIN_TYPES[target.name];
    switch (row.kind) {
      case "plain":
        this.noArguments(name, args, argsNode);
        return row.build(this);
      case "generic": {
        if (args.length !== row.arity) {
          this.arity(name, row.arity, args, node);
          return this.errorLowered();
        }
        return row.build(this, args.map((arg) => this.lower(arg)), args);
      }
      default: {
        const unreachable: never = row;
        return unreachable;
      }
    }
  }

  /** One row for each built-in type name. A missing name is a compile error. */
  private static readonly BUILTIN_TYPES: {
    readonly [N in BuiltinTypeName]: BuiltinTypeRow;
  } = {
    string: primitiveRow("string"),
    boolean: primitiveRow("boolean"),
    int: primitiveRow("int"),
    number: primitiveRow("number"),
    never: primitiveRow("never"),
    unknown: primitiveRow("unknown"),
    void: {
      kind: "plain",
      build: (lowerer) => ({
        ref: lowerer.env.table.unit,
        ir: { kind: "primitive", name: "unit" },
      }),
    },
    CloseableScope: {
      kind: "plain",
      build: (lowerer) => ({
        ref: lowerer.env.table.closeableScope,
        ir: { kind: "closeable-scope" },
      }),
    },
    Option: {
      kind: "generic",
      arity: 1,
      build: (lowerer, [element]) => ({
        ref: lowerer.env.table.option(element.ref),
        ir: { kind: "option", element: element.ir },
      }),
    },
    Ref: {
      kind: "generic",
      arity: 1,
      build: (lowerer, [element]) => ({
        ref: lowerer.env.table.ref(element.ref),
        ir: { kind: "ref", element: element.ir },
      }),
    },
    RetrySchedule: {
      kind: "generic",
      arity: 1,
      build: (lowerer, [error], nodes) => {
        if (error.ir.kind !== "named" || !isErrorId(error.ir.id)) {
          lowerer.report(
            "type-mismatch/001",
            "RetrySchedule needs a nominal error type",
            lowerer.span(nodes[0]),
          );
        }
        return {
          ref: lowerer.env.table.retrySchedule(error.ref),
          ir: { kind: "retry-schedule", error: error.ir },
        };
      },
    },
    ScheduleInput: {
      kind: "generic",
      arity: 1,
      build: (lowerer, [input]) => {
        const ref = lowerer.env.table.scheduleInput(input.ref);
        return { ref, ir: lowerer.env.table.toIr(ref) };
      },
    },
    ScheduleMetadata: {
      kind: "generic",
      arity: 2,
      build: (lowerer, [input, output]) => {
        const ref = lowerer.env.table.scheduleMetadata(input.ref, output.ref);
        return { ref, ir: lowerer.env.table.toIr(ref) };
      },
    },
    ScheduleDecision: {
      kind: "generic",
      arity: 2,
      build: (lowerer, [state, input]) => {
        const ref = lowerer.env.table.scheduleDecision(state.ref, input.ref);
        return { ref, ir: lowerer.env.table.toIr(ref) };
      },
    },
    Codec: {
      kind: "generic",
      arity: 2,
      build: (lowerer, [decoded, encoded]) => ({
        ref: lowerer.env.table.codec(decoded.ref, encoded.ref),
        ir: { kind: "codec", decoded: decoded.ir, encoded: encoded.ir },
      }),
    },
    Fiber: {
      kind: "generic",
      arity: 2,
      build: (lowerer, [result, error], nodes) => {
        const failures: ErrorId[] = [];
        const collect = (type: Type): void => {
          if (type.kind === "primitive" && type.name === "never") return;
          if (type.kind === "union") {
            type.members.forEach(collect);
          } else if (type.kind === "named" && isErrorId(type.id)) {
            failures.push(type.id);
          } else {
            lowerer.report(
              "type-mismatch/001",
              "Fiber failure type needs nominal errors or never",
              lowerer.span(nodes[1]),
            );
          }
        };
        collect(error.ir);
        const unique = sortedUnique(failures);
        return {
          ref: lowerer.env.table.fiber(result.ref, unique),
          ir: { kind: "fiber", result: result.ir, failures: unique },
        };
      },
    },
  };

  private noArguments(
    name: string,
    args: readonly NodeId[],
    argsNode: NodeId | undefined,
  ): void {
    if (argsNode === undefined) return;
    for (const arg of args) this.lower(arg);
    this.report(
      "type-mismatch/001",
      `\`${name}\` takes no type arguments`,
      this.span(argsNode),
    );
  }

  private arity(
    name: string,
    expected: number,
    args: readonly NodeId[],
    node: NodeId,
  ): void {
    for (const arg of args) this.lower(arg);
    this.report(
      "type-mismatch/001",
      `\`${name}\` takes ${expected} type argument${
        expected === 1 ? "" : "s"
      }, but ${args.length} ${args.length === 1 ? "is" : "are"} given`,
      this.span(node),
    );
  }

  /**
   * The fields of a record type in source order. Reports duplicate names, void
   * fields, and, for a nominal or error declaration, a field named `_tag`.
   */
  fields(node: NodeId, errorDeclaration: boolean): LoweredField[] {
    const result: LoweredField[] = [];
    const seen = new Map<string, Span>();
    for (const fieldNode of this.kidsOfKind(node, SyntaxKind.FieldType)) {
      const parts = this.kids(fieldNode);
      const nameNode = parts.find((k) =>
        kindOf(this.tree, k) === SyntaxKind.Name
      );
      const typeNode = parts.find((k) => k !== nameNode);
      const name = nameNode === undefined
        ? undefined
        : nameTextOf(this.tree, nameNode);
      // Lower the type first so that its diagnostics appear even for a bad name.
      const type = typeNode === undefined
        ? this.errorLowered()
        : this.element(typeNode);
      if (nameNode === undefined || name === undefined) continue;
      const nameSpan = this.span(nameNode);
      if (errorDeclaration && name === "_tag") {
        this.report(
          "declaration/009",
          "the field name `_tag` is reserved for generated tags",
          nameSpan,
        );
        continue;
      }
      const first = seen.get(name);
      if (first !== undefined) {
        this.report(
          "declaration/010",
          `the record type already has a field named \`${name}\``,
          nameSpan,
          [{ span: first, message: "first declared here" }],
        );
        continue;
      }
      seen.set(name, nameSpan);
      const optional = childrenOf(this.tree, fieldNode).some((c) =>
        kindOf(this.tree, c) === SyntaxKind.Token &&
        this.tree.lexed.kinds[this.tree.tokens[c]] === TokenKind.Question
      );
      result.push({
        name,
        optional,
        type,
        span: this.span(fieldNode),
        typeSpan: this.span(typeNode ?? fieldNode),
      });
    }
    return result;
  }

  recordOf(fields: readonly LoweredField[]): Lowered {
    return {
      ref: this.env.table.record(fields.map((f) => ({
        name: f.name,
        type: f.type.ref,
        optional: f.optional,
      }))),
      ir: { kind: "record", fields: fields.map(toIrField) },
    };
  }

  private union(node: NodeId): Lowered {
    const members: Lowered[] = [];
    this.collectUnion(node, members);
    const refs = new Set<TypeRef>();
    const unique: Lowered[] = [];
    for (const member of members) {
      if (refs.has(member.ref)) continue;
      refs.add(member.ref);
      unique.push(member);
    }
    if (unique.length === 0) return this.errorLowered();
    if (unique.length === 1) return unique[0];
    const ref = this.env.table.union(unique.map((m) => m.ref));
    if (ref === this.env.table.error) return this.errorLowered();
    return { ref, ir: { kind: "union", members: unique.map((m) => m.ir) } };
  }

  private collectUnion(node: NodeId, out: Lowered[]): void {
    for (const kid of this.kids(node)) {
      const kind = kindOf(this.tree, kid);
      if (kind === SyntaxKind.UnionType) {
        this.collectUnion(kid, out);
      } else if (kind === SyntaxKind.ParenType) {
        const inner = this.kids(kid);
        if (
          inner.length === 1 &&
          kindOf(this.tree, inner[0]) === SyntaxKind.UnionType
        ) {
          this.collectUnion(inner[0], out);
        } else {
          out.push(this.lower(kid));
        }
      } else {
        out.push(this.lower(kid));
      }
    }
  }

  /** A function type in type syntax. An unmarked type defaults to `effect`. */
  private functionType(node: NodeId): Lowered {
    const first = childrenOf(this.tree, node)[0];
    const execution =
      first !== undefined && nodeText(this.tree, first) === "pure"
        ? "pure"
        : "effect";
    const kids = this.kids(node);
    const paramList = kids.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.ParamList
    );
    const parameters = paramList === undefined
      ? []
      : this.parameters(paramList, "report");
    const resultNode = kids.find((k) => {
      const kind = kindOf(this.tree, k);
      return k !== paramList && kind !== SyntaxKind.FailsClause &&
        kind !== SyntaxKind.UsesClause;
    });
    const result = resultNode === undefined
      ? this.errorLowered()
      : this.lower(resultNode);
    const failures = this.failures(
      kids.find((k) => kindOf(this.tree, k) === SyntaxKind.FailsClause),
    );
    const requirements = this.requirements(
      kids.find((k) => kindOf(this.tree, k) === SyntaxKind.UsesClause),
    );
    if (
      execution === "pure" &&
      (failures.length > 0 || requirements.length > 0)
    ) {
      this.report(
        "execution-mode/005",
        "a pure function type cannot declare failures or requirements",
        this.span(node),
      );
    }
    return this.functionOf(
      execution,
      parameters.map((p) => p.type),
      result,
      failures,
      requirements,
      parameters.map((p) => p.borrow),
    );
  }

  private deferredType(node: NodeId): Lowered {
    const kids = this.kids(node);
    const typeNodes = kids.filter((k) => isTypeKind(kindOf(this.tree, k)));
    const first = typeNodes[0] === undefined
      ? this.errorLowered()
      : this.lower(typeNodes[0]);
    if (kindOf(this.tree, node) === SyntaxKind.SchemaType) {
      // The first child is the token of the type word.
      const wordToken = childrenOf(this.tree, node)[0];
      const flags = TYPE_WORDS.get(nodeText(this.tree, wordToken))?.schema;
      const optionalKey = flags?.optionalKey === true;
      const encodedOptionalKey = flags?.encodedOptionalKey === true;
      const decodedOptionalKey = flags?.decodedOptionalKey === true;
      const constructorDefault = flags?.constructorDefault === true;
      const encoded = typeNodes[1] === undefined
        ? first
        : this.lower(typeNodes[1]);
      const makeInput = typeNodes[2] === undefined
        ? first
        : this.lower(typeNodes[2]);
      if (
        !dataOnly(this.env.table, first.ref, "schema", true) ||
        !dataOnly(this.env.table, encoded.ref, "schema", true) ||
        !dataOnly(this.env.table, makeInput.ref, "schema", true)
      ) {
        this.report(
          "type-mismatch/010",
          "Schema decoded and encoded types must be data only",
          this.span(node),
        );
      }
      const uses = kids.filter((k) =>
        kindOf(this.tree, k) === SyntaxKind.UsesClause
      );
      const decodeRequirements = this.requirements(uses[0]);
      const encodeRequirements = this.requirements(uses[1]);
      return {
        ref: this.env.table.schema(
          first.ref,
          encoded.ref,
          decodeRequirements,
          encodeRequirements,
          {
            presence: optionalKey
              ? "optional"
              : encodedOptionalKey
              ? "encoded-optional"
              : decodedOptionalKey
              ? "decoded-optional"
              : "required",
            makeInput: makeInput.ref,
            constructorDefault,
          },
        ),
        ir: {
          kind: "schema",
          decoded: first.ir,
          encoded: encoded.ir,
          decodeRequirements,
          encodeRequirements,
          ...(optionalKey ? { optionalKey: true as const } : {}),
          ...(encodedOptionalKey ? { encodedOptionalKey: true as const } : {}),
          ...(decodedOptionalKey ? { decodedOptionalKey: true as const } : {}),
          ...(makeInput.ref === first.ref ? {} : { makeInput: makeInput.ir }),
          ...(constructorDefault ? { constructorDefault: true as const } : {}),
        },
      };
    }
    const failures = this.failures(
      kids.find((k) => kindOf(this.tree, k) === SyntaxKind.FailsClause),
    );
    const requirements = this.requirements(
      kids.find((k) => kindOf(this.tree, k) === SyntaxKind.UsesClause),
    );
    const effects = { failures, requirements };
    const kind = kindOf(this.tree, node);
    if (kind === SyntaxKind.LayerType) {
      const provides: CapabilityId[] = [];
      const clause = kids.find((k) =>
        kindOf(this.tree, k) === SyntaxKind.ProvidesClause
      );
      if (clause !== undefined) {
        for (const qn of this.kidsOfKind(clause, SyntaxKind.QualifiedName)) {
          provides.push(...this.capabilitiesOf(qn));
        }
      }
      return this.providerOf(provides, failures, requirements);
    }
    if (kind === SyntaxKind.StreamType) {
      return {
        ref: this.env.table.stream(first.ref, failures, requirements),
        ir: { kind: "stream", element: first.ir, effects },
      };
    }
    if (kind === SyntaxKind.ScheduleType) {
      const input = typeNodes[1] === undefined
        ? {
          ref: this.env.table.unknown,
          ir: { kind: "primitive" as const, name: "unknown" as const },
        }
        : this.lower(typeNodes[1]);
      return {
        ref: this.env.table.schedule(
          first.ref,
          input.ref,
          failures,
          requirements,
        ),
        ir: { kind: "schedule", output: first.ir, input: input.ir, effects },
      };
    }
    if (kind === SyntaxKind.SinkType) {
      const second = typeNodes[1] === undefined
        ? this.errorLowered()
        : this.lower(typeNodes[1]);
      const leftover = typeNodes[2] === undefined
        ? {
          ref: this.env.table.never,
          ir: { kind: "primitive" as const, name: "never" as const },
        }
        : this.lower(typeNodes[2]);
      return {
        ref: this.env.table.sink(
          first.ref,
          second.ref,
          failures,
          requirements,
          leftover.ref,
        ),
        ir: {
          kind: "sink",
          input: first.ir,
          result: second.ir,
          ...(leftover.ref === this.env.table.never
            ? {}
            : { leftover: leftover.ir }),
          effects,
        },
      };
    }
    return {
      ref: this.env.table.effect(first.ref, failures, requirements),
      ir: { kind: "effect", result: first.ir, effects },
    };
  }

  /** A provider type. Its acquisition execution is always `effect`. */
  providerOf(
    provides: readonly CapabilityId[],
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
  ): Lowered {
    const provided = sortedUnique(provides);
    return {
      ref: this.env.table.provider({
        provides: provided,
        execution: "effect",
        failures,
        requirements,
      }),
      ir: {
        kind: "provider",
        provides: provided,
        acquisition: {
          execution: "effect",
          effects: { failures, requirements },
        },
      },
    };
  }

  functionOf(
    execution: Execution,
    parameters: readonly Lowered[],
    result: Lowered,
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
    borrows?: readonly boolean[],
  ): SignatureType {
    return loweredFunction(
      this.env.table,
      execution,
      parameters,
      result,
      failures,
      requirements,
      borrows,
    );
  }

  /**
   * The parameters of a parameter list. With `report`, a parameter without a type
   * annotation gets a diagnostic. Either way its type is the error type.
   */
  parameters(
    paramList: NodeId,
    missing: "report" | "silent",
  ): ParameterSignature[] {
    const result: ParameterSignature[] = [];
    for (const param of this.kidsOfKind(paramList, SyntaxKind.Param)) {
      const parts = this.kids(param);
      const nameNode = parts.find((k) =>
        kindOf(this.tree, k) === SyntaxKind.Name
      );
      const typeNode = parts.find((k) => k !== nameNode);
      const name = nameNode === undefined
        ? ""
        : nameTextOf(this.tree, nameNode) ?? "";
      const target = nameNode === undefined
        ? undefined
        : this.env.targets.get(nameNode);
      if (
        typeNode === undefined && missing === "report" && nameNode !== undefined
      ) {
        this.report(
          "declaration/011",
          `the parameter \`${name}\` needs a type annotation`,
          this.span(param),
        );
      }
      result.push({
        name,
        borrow: /^borrow\s+/.test(nodeText(this.tree, param)),
        id: target?.kind === "local" ? target.id : undefined,
        type: typeNode === undefined
          ? this.errorLowered()
          : this.lower(typeNode),
        annotated: typeNode !== undefined,
        span: this.span(param),
      });
    }
    return result;
  }

  /** The error identities of a `fails` clause, sorted and unique. */
  failures(clause: NodeId | undefined): ErrorId[] {
    if (clause === undefined) return [];
    const ids: ErrorId[] = [];
    for (const name of this.kidsOfKind(clause, SyntaxKind.Name)) {
      const target = this.env.targets.get(name);
      if (target?.kind === "error") ids.push(target.id);
    }
    return sortedUnique(ids);
  }

  /**
   * The capabilities of a `uses` clause, sorted and unique. A whole service
   * expands to all its methods.
   */
  requirements(clause: NodeId | undefined): CapabilityId[] {
    if (clause === undefined) return [];
    const ids: CapabilityId[] = [];
    for (const qn of this.kidsOfKind(clause, SyntaxKind.QualifiedName)) {
      ids.push(...this.capabilitiesOf(qn));
    }
    return sortedUnique(ids);
  }

  /** The capabilities that a qualified name stands for: one method, or all methods of a service. */
  capabilitiesOf(qn: NodeId): CapabilityId[] {
    const target = this.env.targets.get(qn);
    if (target?.kind === "cap") return [target.id];
    if (target?.kind === "service") {
      const service = this.env.services.get(target.id);
      return service === undefined ? [] : service.methods.map((m) => m.id);
    }
    return [];
  }
}

interface LoweredField {
  readonly name: string;
  readonly optional: boolean;
  readonly type: Lowered;
  readonly span: Span;
  /** The span of the field type, or of the whole field when the type is missing. */
  readonly typeSpan: Span;
}

function toIrField(field: LoweredField): Field {
  return { name: field.name, type: field.type.ir, optional: field.optional };
}

// ------------------------------------------------------------------ type graph walk

/**
 * Rule 11 for one group of data types and aliases that refer to each other.
 * `roots[n]` lists the IR types of member `n`: the record of a data type, or
 * the target of an alias. The group is guarded when no cycle is made of aliases
 * alone, and no cycle is made of references that avoid an `Option`, an array,
 * an optional field, and a union with a member outside the group.
 */
function recursionIsGuarded(
  members: readonly { readonly id: string; readonly data: boolean }[],
  roots: readonly (readonly Type[])[],
): boolean {
  const index = new Map(members.map((m, n) => [m.id, n]));
  const inGroup = (type: Type): boolean => {
    const ids = new Set<string>();
    referencedIds(type, ids);
    return [...ids].some((id) => index.has(id));
  };
  // The edges of a member, and whether a path with no guard reaches the target.
  const edges = roots.map((types) => {
    const found = new Map<number, boolean>();
    const reach = (id: string, guarded: boolean): void => {
      const target = index.get(id);
      if (target !== undefined) {
        found.set(target, (found.get(target) ?? false) || !guarded);
      }
    };
    const visit = (type: Type, guarded: boolean): void => {
      switch (type.kind) {
        case "named":
          reach(type.id, guarded);
          return;
        case "option":
        case "array":
          visit(type.element, true);
          return;
        case "union": {
          const outside = type.members.some((m) => !inGroup(m));
          for (const member of type.members) visit(member, guarded || outside);
          return;
        }
        case "record":
          // A value can leave out an optional field, so the field ends the recursion.
          for (const field of type.fields) {
            visit(field.type, guarded || field.optional);
          }
          return;
        case "tuple":
          for (const element of type.elements) visit(element, guarded);
          return;
        default: {
          const ids = new Set<string>();
          referencedIds(type, ids);
          for (const id of ids) reach(id, guarded);
        }
      }
    };
    for (const type of types) visit(type, false);
    return found;
  });
  const cyclic = (
    keep: (from: number, to: number, bare: boolean) => boolean,
  ) => {
    const graph = edges.map((targets, from) =>
      [...targets].filter(([to, bare]) => keep(from, to, bare)).map(([to]) =>
        to
      )
    );
    return stronglyConnectedComponents(members.length, graph).some((c) =>
      c.length > 1 || graph[c[0]].includes(c[0])
    );
  };
  return !cyclic((from, to) => !members[from].data && !members[to].data) &&
    !cyclic((_from, _to, bare) => bare);
}

/** Adds the type and error identities that an IR type mentions, and the services of its capabilities. */
export function referencedIds(type: Type, ids: Set<string>): void {
  switch (type.kind) {
    case "closeable-scope":
    case "primitive":
    case "literal":
      return;
    case "named":
      ids.add(type.id);
      return;
    case "record":
      for (const field of type.fields) referencedIds(field.type, ids);
      return;
    case "array":
    case "option":
    case "ref":
      referencedIds(type.element, ids);
      return;
    case "retry-schedule":
      referencedIds(type.error, ids);
      return;
    case "codec":
      referencedIds(type.decoded, ids);
      referencedIds(type.encoded, ids);
      return;
    case "schema":
      referencedIds(type.decoded, ids);
      referencedIds(type.encoded, ids);
      if (type.makeInput !== undefined) referencedIds(type.makeInput, ids);
      effectIds([], type.decodeRequirements, ids);
      effectIds([], type.encodeRequirements, ids);
      return;
    case "fiber":
      referencedIds(type.result, ids);
      effectIds(type.failures, [], ids);
      return;
    case "effect":
      referencedIds(type.result, ids);
      effectIds(type.effects.failures, type.effects.requirements, ids);
      return;
    case "stream":
      referencedIds(type.element, ids);
      effectIds(type.effects.failures, type.effects.requirements, ids);
      return;
    case "schedule":
      referencedIds(type.output, ids);
      referencedIds(type.input, ids);
      effectIds(type.effects.failures, type.effects.requirements, ids);
      return;
    case "sink":
      referencedIds(type.input, ids);
      referencedIds(type.result, ids);
      if (type.leftover !== undefined) referencedIds(type.leftover, ids);
      effectIds(type.effects.failures, type.effects.requirements, ids);
      return;
    case "tuple":
      for (const element of type.elements) referencedIds(element, ids);
      return;
    case "union":
      for (const member of type.members) referencedIds(member, ids);
      return;
    case "function":
      for (const parameter of type.parameters) referencedIds(parameter, ids);
      referencedIds(type.result, ids);
      effectIds(type.effects.failures, type.effects.requirements, ids);
      return;
    case "provider":
      effectIds([], type.provides, ids);
      effectIds(
        type.acquisition.effects.failures,
        type.acquisition.effects.requirements,
        ids,
      );
      return;
  }
}

/** Adds failure identities and the services of capabilities. */
export function effectIds(
  failures: readonly ErrorId[],
  capabilities: readonly CapabilityId[],
  ids: Set<string>,
): void {
  for (const failure of failures) ids.add(failure);
  for (const capability of capabilities) {
    const service = serviceOfCapability(capability);
    if (service !== undefined) ids.add(service);
  }
}

// ------------------------------------------------------------------ the module checker

type TypeNodeInfo =
  & {
    readonly name: string;
    readonly nameSpan: Span;
    readonly start: number;
    readonly refs: ReadonlySet<string>;
  }
  & (
    | { readonly kind: "alias" | "brand" | "data"; readonly id: TypeId }
    | { readonly kind: "error"; readonly id: ErrorId }
  );

/** A nominal declaration that waits for the record classification of `classifyNominal`. */
type PendingNominal = {
  readonly pending: true;
  readonly entry: DeclEntry;
  readonly id: TypeId;
  readonly index: number;
  readonly lowered: Lowered;
  readonly literal: LoweredField[] | undefined;
  readonly span: Span;
};

/** The most levels that a type declaration may have, counting its aliases. */
const MAX_TYPE_DEPTH = 128;

class ModuleChecker {
  readonly sink: Diagnostic[] = [];
  readonly lowerer: TypeLowerer;
  private readonly tree: SyntaxTree;
  private readonly table: TypeTable;
  private readonly types: TypeDecl[] = [];
  private readonly errors: ErrorDecl[] = [];
  /** The fields and record bodies of nominal and error declarations, for the deferred-type rule. */
  private readonly nominalFields: {
    readonly subject: string;
    readonly ref: TypeRef;
    readonly span: Span;
  }[] = [];
  /** The body of every nominal declaration that is not a record, for rule 12. */
  private readonly nominalBodies: {
    readonly id: TypeId;
    readonly span: Span;
  }[] = [];
  private readonly services: ServiceDecl[] = [];
  private readonly methodTypes = new Map<CapabilityId, TypeRef>();
  private readonly values = new Map<ValueId, ValueSignature>();
  private readonly exports: DeclarationId[] = [];

  constructor(
    private readonly info: ModuleInfo,
    readonly env: TypeEnv,
    /** The alias bodies of the imported modules, in source field order. */
    private readonly importedAliases: ReadonlyMap<string, Type>,
  ) {
    this.tree = env.tree;
    this.table = env.table;
    this.lowerer = new TypeLowerer(env, this.sink);
  }

  private id<P extends DeclarationPrefix>(
    prefix: P,
    name: string,
  ): `${P}:${string}` {
    return declarationId(prefix, this.env.module, name);
  }

  /** The first declaration of each name. Later ones are duplicates that the resolver reported. */
  private entries(): DeclEntry[] {
    const { index } = this.info;
    return index.decls.filter((d) => index.byName.get(d.name) === d);
  }

  run(): ModuleDeclarations {
    const entries = this.entries();
    const slots: (TypeNodeInfo | PendingNominal)[] = [];
    for (const entry of entries) {
      if (entry.kind === "type") slots.push(this.checkType(entry));
      else if (entry.kind === "data") slots.push(this.checkNominal(entry));
      else if (entry.kind === "error") slots.push(this.checkError(entry));
    }
    // A body is a record after aliases unfold, so the table must hold every definition first.
    const infos = slots.map((slot) =>
      "pending" in slot ? this.classifyNominal(slot) : slot
    );
    const guarded = this.checkCycles(infos);
    this.checkDepths(infos, guarded);
    this.checkDeferredFields();
    this.checkNominalBodies();
    this.checkPrimitivePositions();
    for (const entry of entries) {
      if (entry.kind === "service") this.checkService(entry);
    }
    for (const entry of entries) {
      if (entry.kind === "provider") this.checkProvider(entry);
      else if (entry.kind === "const") this.checkConst(entry);
    }
    for (const entry of entries) {
      if (!entry.exported) continue;
      const prefix = entry.kind === "const" || entry.kind === "provider"
        ? "value"
        : entry.kind === "data"
        ? "type"
        : entry.kind;
      this.exports.push(this.id(prefix, entry.name));
    }
    this.exports.sort(compareText);
    return {
      module: this.env.module,
      env: this.env,
      types: this.types,
      errors: this.errors,
      services: this.services,
      methodTypes: this.methodTypes,
      values: this.values,
      exports: this.exports,
      diagnostics: normalizeDiagnostics(this.sink),
    };
  }

  /**
   * Rule R1: a primitive type node can occur only inside a type, nominal, or error declaration.
   * The walk skips those declarations and the regions that the parser already reported.
   * A broken declaration is checked, because its annotations parsed.
   */
  private checkPrimitivePositions(): void {
    const { tree } = this;
    walk(tree, tree.root, (node) => {
      const kind = kindOf(tree, node);
      if (
        kind === SyntaxKind.TypeDecl || kind === SyntaxKind.DataDecl ||
        kind === SyntaxKind.ErrorDecl || kind === SyntaxKind.Error
      ) return false;
      if (kind === SyntaxKind.LiteralType || this.isPrimitiveName(node)) {
        this.lowerer.report(
          "declaration/013",
          `the primitive type \`${
            nodeText(tree, node)
          }\` can occur only inside a type, nominal, or error declaration`,
          nodeSpan(tree, node),
        );
      }
    });
  }

  /** True for a named type that resolves to string, int, number, or boolean. */
  private isPrimitiveName(node: NodeId): boolean {
    if (kindOf(this.tree, node) !== SyntaxKind.NamedType) return false;
    const nameNode = this.lowerer.kidsOfKind(node, SyntaxKind.Name)[0];
    if (nameNode === undefined) return false;
    const target = this.env.targets.get(nameNode);
    if (target?.kind !== "builtin-type") return false;
    const name = target.name;
    switch (name) {
      case "string":
      case "int":
      case "number":
      case "boolean":
        return true;
      case "void":
      case "never":
      case "unknown":
      case "Option":
      case "Ref":
      case "RetrySchedule":
      case "ScheduleInput":
      case "ScheduleMetadata":
      case "ScheduleDecision":
      case "Codec":
      case "Fiber":
      case "CloseableScope":
        return false;
      default: {
        const unreachable: never = name;
        return unreachable;
      }
    }
  }

  // -------------------------------------------------------------- types and errors

  private bodyOf(entry: DeclEntry): NodeId | undefined {
    return this.lowerer.kids(entry.node).find((k) =>
      k !== entry.nameNode && kindOf(this.tree, k) !== SyntaxKind.Error
    );
  }

  private checkType(entry: DeclEntry): TypeNodeInfo {
    const id = this.id("type", entry.name);
    const body = this.bodyOf(entry);
    const opaque = /^(?:export\s+)?opaque\s+type\b/.test(
      nodeText(this.tree, entry.node),
    );
    let definition: TypeDecl["definition"];
    let kind: "alias" | "brand" = "alias";
    if (opaque) {
      this.table.defineBrand(id, this.table.unknown);
      this.table.markOpaque(id);
      definition = {
        kind: "nominal",
        base: { kind: "primitive", name: "unknown" },
      };
      kind = "brand";
    } else {
      const lowered = body === undefined
        ? this.lowerer.errorLowered()
        : this.lowerer.lower(body);
      this.table.defineAlias(id, lowered.ref);
      definition = { kind: "alias", type: lowered.ir };
    }
    this.types.push({
      kind: "type",
      id,
      name: entry.name,
      definition,
      ...(opaque ? { opaque: true } : {}),
      span: entry.span,
    });
    const refs = new Set<string>();
    referencedIds(
      definition.kind === "alias" ? definition.type : definition.base,
      refs,
    );
    return {
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind,
      refs,
    };
  }

  /**
   * Lowers the body of a nominal declaration. The table gets a provisional
   * definition, and `classifyNominal` decides later whether the body is a record.
   */
  private checkNominal(entry: DeclEntry): PendingNominal {
    const id = this.id("type", entry.name);
    const body = this.bodyOf(entry);
    // A literal record keeps its source field order and reports a `_tag` field at its name.
    const literal = body !== undefined &&
        kindOf(this.tree, body) === SyntaxKind.RecordType
      ? this.lowerer.fields(body, true)
      : undefined;
    // A body that did not parse gets the error type, so its uses report nothing more.
    const lowered = body === undefined
      ? this.lowerer.errorLowered()
      : literal !== undefined
      ? this.lowerer.recordOf(literal)
      : this.lowerer.lower(body);
    this.table.defineBrand(id, lowered.ref, entry.sealed);
    this.types.push({
      kind: "type",
      id,
      name: entry.name,
      definition: {
        kind: "nominal",
        base: lowered.ir,
        ...(entry.sealed ? { sealed: true } : {}),
      },
      span: entry.span,
    });
    return {
      pending: true,
      entry,
      id,
      index: this.types.length - 1,
      lowered,
      literal,
      span: nodeSpan(this.tree, body ?? entry.node),
    };
  }

  /**
   * A nominal body that is a record after aliases unfold is a tagged record at
   * run time. The IR base of such a body is the unfolded
   * record, so the validator and the emitter need no alias walk.
   */
  private classifyNominal(pending: PendingNominal): TypeNodeInfo {
    const { entry, id, lowered, literal, span } = pending;
    const unfolded = this.table.unfold(lowered.ref);
    const node = this.table.node(unfolded);
    let base = lowered.ir;
    let kind: "brand" | "data" = "brand";
    if (node.kind === "error") {
      // A body that did not parse or resolve acts as a record, so its uses report nothing more.
      kind = "data";
      this.table.defineData(id, unfolded, entry.sealed);
    } else if (node.kind === "record") {
      kind = "data";
      const hasTag = node.fields.some((f) => f.name === "_tag");
      if (hasTag) {
        this.lowerer.report(
          "declaration/009",
          "the field name `_tag` is reserved for generated tags",
          span,
        );
      }
      const fields = node.fields.filter((f) => f.name !== "_tag");
      const record = hasTag ? this.table.record(fields) : unfolded;
      this.table.defineData(id, record, entry.sealed);
      base = literal !== undefined && !hasTag
        ? lowered.ir
        : (hasTag ? undefined : this.aliasRecordIr(lowered.ir)) ??
          this.table.toIr(record);
      if (literal !== undefined) {
        for (const field of literal) {
          this.nominalFields.push({
            subject: `the field \`${field.name}\``,
            ref: field.type.ref,
            span: field.typeSpan,
          });
        }
      } else {
        this.nominalFields.push({
          subject: `the body of \`${entry.name}\``,
          ref: record,
          span,
        });
      }
    } else {
      this.nominalBodies.push({ id, span });
    }
    this.types[pending.index] = {
      ...this.types[pending.index],
      definition: {
        kind: "nominal",
        base,
        ...(entry.sealed ? { sealed: true } : {}),
      },
    };
    const refs = new Set<string>();
    referencedIds(base, refs);
    return {
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind,
      refs,
    };
  }

  /**
   * The record at the end of an alias chain, as the alias declares it. The
   * table sorts record fields by name, and the emitted struct keeps the source order.
   */
  private aliasRecordIr(ir: Type): Type | undefined {
    const seen = new Set<string>();
    let current = ir;
    while (current.kind === "named" && !seen.has(current.id)) {
      const id = current.id;
      seen.add(id);
      const local = this.types.find((d) => d.id === id);
      const next = local?.definition.kind === "alias"
        ? local.definition.type
        : this.importedAliases.get(id);
      if (next === undefined) return undefined;
      current = next;
    }
    return current.kind === "record" ? current : undefined;
  }

  private checkError(entry: DeclEntry): TypeNodeInfo {
    const id = this.id("error", entry.name);
    const record =
      this.lowerer.kidsOfKind(entry.node, SyntaxKind.RecordType)[0];
    const fields = record === undefined
      ? []
      : this.lowerer.fields(record, true);
    for (const field of fields) {
      this.nominalFields.push({
        subject: `the field \`${field.name}\``,
        ref: field.type.ref,
        span: field.typeSpan,
      });
    }
    this.table.defineError(
      id,
      record === undefined
        ? this.table.error
        : this.lowerer.recordOf(fields).ref,
    );
    this.errors.push({
      kind: "error",
      id,
      name: entry.name,
      fields: fields.map(toIrField),
      span: entry.span,
    });
    const refs = new Set<string>();
    for (const field of fields) referencedIds(field.type.ir, refs);
    return {
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind: "error",
      refs,
    };
  }

  /**
   * Version 0 rejects recursive type definitions. Finds the strongly connected
   * components of the reference graph, reports one diagnostic for each cycle, and
   * redefines its aliases and brands as the error type so that compatibility ends.
   * Returns the aliases that stay as guarded records.
   */
  private checkCycles(typeInfos: readonly TypeNodeInfo[]): Set<TypeId> {
    const guardedAliases = new Set<TypeId>();
    const infos = new Map<string, TypeNodeInfo>();
    for (const info of typeInfos) infos.set(info.id, info);
    // The search starts from the declarations in source order, and follows the
    // references of each one in text order.
    const nodes = [...infos.values()];
    const indexOfId = new Map<string, number>();
    nodes.forEach((node, n) => indexOfId.set(node.id, n));
    const edges = nodes.map((node) =>
      [...node.refs].sort(compareText).flatMap((ref) => {
        const target = indexOfId.get(ref);
        return target === undefined ? [] : [target];
      })
    );
    const components: TypeNodeInfo[][] = [];
    for (const members of stronglyConnectedComponents(nodes.length, edges)) {
      const component = members.map((n) => nodes[n]);
      const selfLoop = component.length === 1 &&
        component[0].refs.has(component[0].id);
      if (component.length > 1 || selfLoop) components.push(component);
    }

    for (const component of components) {
      component.sort((a, b) => a.start - b.start);
      const first = component[0];
      if (this.guardedDataGroup(component)) continue;
      if (component.length === 1 && first.kind === "alias") {
        const declaration = this.types.find((d) => d.id === first.id);
        const aliased = this.table.aliasOf(first.id);
        if (
          declaration?.definition.kind === "alias" &&
          guardedRecord(
            declaration.definition.type,
            first.id,
            (type) => this.literalTag(type),
          ) &&
          aliased !== undefined &&
          dataOnly(this.table, aliased, "schema")
        ) {
          guardedAliases.add(first.id);
          this.table.markGuardedAlias(first.id);
          continue;
        }
      }
      const names = component.map((m) => m.name);
      this.lowerer.report(
        "declaration/007",
        component.length === 1
          ? `the type \`${first.name}\` is defined in terms of itself`
          : `recursive type definition: ${names.join(" -> ")} -> ${names[0]}`,
        first.nameSpan,
        component.slice(1).map((m) => ({
          span: m.nameSpan,
          message: "also part of the cycle",
        })),
      );
      for (const member of component) {
        if (member.kind === "alias") {
          this.table.defineAlias(member.id, this.table.error);
        } else if (member.kind === "brand") {
          this.table.defineBrand(member.id, this.table.error);
        }
      }
    }
    return guardedAliases;
  }

  /**
   * Rule 11: a cycle that has a record nominal type, and only such types and aliases, is
   * legal when no cycle is made of aliases alone and every cycle passes through
   * an `Option`, an array, an optional field, or a union that has a member
   * outside the group.
   */
  private guardedDataGroup(component: readonly TypeNodeInfo[]): boolean {
    if (!component.some((m) => m.kind === "data")) return false;
    if (component.some((m) => m.kind !== "data" && m.kind !== "alias")) {
      return false;
    }
    const roots = component.map((m): Type[] => {
      const declaration = this.types.find((d) => d.id === m.id);
      const definition = declaration?.definition;
      // The record keeps the optional flag of each field.
      if (definition?.kind === "nominal" && definition.base.kind === "record") {
        return [definition.base];
      }
      return definition?.kind === "alias" ? [definition.type] : [];
    });
    return recursionIsGuarded(
      component.map((m) => ({ id: m.id, data: m.kind === "data" })),
      roots,
    );
  }

  /**
   * The string value of a tag field type: an inline string literal, or a name
   * that reaches one through literal aliases. The table holds every definition
   * before the cycle analysis, and a repeated name stops an alias cycle.
   */
  private literalTag(type: Type): string | undefined {
    if (type.kind === "literal") {
      return typeof type.value === "string" ? type.value : undefined;
    }
    if (type.kind !== "named") return undefined;
    const seen = new Set<string>();
    let id: TypeId | ErrorId = type.id;
    while (!isErrorId(id) && !seen.has(id)) {
      seen.add(id);
      const target = this.table.aliasOf(id);
      if (target === undefined) return undefined;
      const node = this.table.node(target);
      if (node.kind === "literal") {
        return typeof node.value === "string" ? node.value : undefined;
      }
      if (node.kind !== "named") return undefined;
      id = node.id;
    }
    return undefined;
  }

  /**
   * A type declaration whose alias is nested deeper than `MAX_TYPE_DEPTH`
   * levels, counting the levels inside its aliases, gets `declaration/012`. The
   * alias becomes the error type, so a later comparison never walks the chain.
   * The walk has a budget, so a cycle cannot loop.
   */
  private checkDepths(
    typeInfos: readonly TypeNodeInfo[],
    guardedAliases: ReadonlySet<TypeId>,
  ): void {
    const memo = new Map<TypeRef, number>();
    for (const info of typeInfos) {
      if (info.kind !== "alias") continue;
      if (guardedAliases.has(info.id)) continue;
      const body = this.table.aliasOf(info.id);
      if (body === undefined) continue;
      if (!this.table.exceedsDepth(body, MAX_TYPE_DEPTH, memo)) continue;
      this.lowerer.report(
        "declaration/012",
        `the type \`${info.name}\` is nested deeper than ${MAX_TYPE_DEPTH} levels, counting the levels inside its aliases`,
        info.nameSpan,
      );
      this.table.defineAlias(info.id, this.table.error);
    }
  }

  /**
   * A nominal or error field cannot hold a function, deferred, or opaque type, at
   * any depth, after aliases unfold. The emitter has no schema for one. The
   * check runs after every alias is defined, so a field may name a later alias.
   */
  private checkDeferredFields(): void {
    for (const field of this.nominalFields) {
      if (containsDeferredType(this.table, field.ref)) {
        this.lowerer.report(
          "declaration/015",
          `${field.subject} has a function or deferred type, which a nominal type or error declaration cannot hold`,
          field.span,
        );
      } else if (containsOpaqueType(this.table, field.ref)) {
        this.lowerer.report(
          "declaration/016",
          `${field.subject} has an opaque type, which has no schema`,
          field.span,
        );
      }
    }
  }

  /**
   * Rule 12: the body of a nominal type that is not a record cannot be a record
   * or a nominal record, or a union with such a member, after aliases unfold.
   * The type becomes the error type so that its uses report nothing more. Any
   * other body gets the deferred-type and opaque-type rules of the fields.
   */
  private checkNominalBodies(): void {
    for (const nominal of this.nominalBodies) {
      const base = this.table.brandBaseOf(nominal.id);
      if (base === undefined) continue;
      const hasRecord = flattenMembers(this.table, base).some((member) => {
        const node = this.table.node(member);
        return node.kind === "record" ||
          (node.kind === "named" && !isErrorId(node.id) &&
            this.table.dataRecordOf(node.id) !== undefined);
      });
      if (hasRecord) {
        this.lowerer.report(
          "declaration/014",
          "a nominal body cannot hold a nominal record or a union with a record; declare each record alone",
          nominal.span,
        );
        this.table.defineBrand(nominal.id, this.table.error);
      } else if (containsDeferredType(this.table, base)) {
        this.lowerer.report(
          "declaration/015",
          "the body has a function or deferred type, which a nominal type cannot hold",
          nominal.span,
        );
      } else if (containsOpaqueType(this.table, base)) {
        this.lowerer.report(
          "declaration/016",
          "the body has an opaque type, which has no schema",
          nominal.span,
        );
      }
    }
  }

  // -------------------------------------------------------------- services and providers

  private checkService(entry: DeclEntry): void {
    const id = this.id("service", entry.name);
    const methods: MethodDecl[] = [];
    for (const method of entry.methodList) {
      if (entry.methods.get(method.name) !== method) continue;
      const parts = this.lowerer.kids(method.node);
      const paramList = parts.find((k) =>
        kindOf(this.tree, k) === SyntaxKind.ParamList
      );
      const parameters = paramList === undefined
        ? []
        : this.lowerer.parameters(paramList, "report");
      for (const parameter of parameters) {
        if (parameter.borrow) {
          if (this.tree.mode !== "effi") {
            this.lowerer.report(
              "type-mismatch/010",
              "a service borrow parameter belongs in a host interface",
              parameter.span,
            );
          }
          const ref = this.table.node(this.table.unfold(parameter.type.ref));
          if (
            ref.kind !== "named" || !isTypeId(ref.id) ||
            !this.table.isOpaque(ref.id)
          ) {
            this.lowerer.report(
              "type-mismatch/010",
              "borrow parameters need an opaque type",
              parameter.span,
            );
          }
        }
      }
      const resultNode = parts.find((k) =>
        k !== method.nameNode && k !== paramList &&
        kindOf(this.tree, k) !== SyntaxKind.FailsClause
      );
      const result = resultNode === undefined
        ? this.lowerer.errorLowered()
        : this.lowerer.lower(resultNode);
      const failures = this.lowerer.failures(
        parts.find((k) => kindOf(this.tree, k) === SyntaxKind.FailsClause),
      );
      const type = this.lowerer.functionOf(
        "effect",
        parameters.map((p) => p.type),
        result,
        failures,
        [],
      );
      const capability: CapabilityId =
        `cap:${this.env.module}#${entry.name}.${method.name}`;
      this.methodTypes.set(capability, type.ref);
      methods.push({
        id: capability,
        name: method.name,
        type: type.ir,
        ...(parameters.some((p) => p.borrow)
          ? { borrows: parameters.map((p) => p.borrow) }
          : {}),
        span: method.span,
      });
    }
    const declaration: ServiceDecl = {
      kind: "service",
      id,
      name: entry.name,
      methods,
      span: entry.span,
    };
    this.services.push(declaration);
    this.env.services.set(id, declaration);
  }

  private checkProvider(entry: DeclEntry): void {
    const id = this.id("value", entry.name);
    const parts = this.lowerer.kids(entry.node);
    const provides: CapabilityId[] = [];
    for (
      const clause of parts.filter((k) =>
        kindOf(this.tree, k) === SyntaxKind.ProvidesClause
      )
    ) {
      for (
        const qn of this.lowerer.kidsOfKind(clause, SyntaxKind.QualifiedName)
      ) {
        provides.push(...this.lowerer.capabilitiesOf(qn));
      }
    }
    const failures = this.lowerer.failures(
      parts.find((k) => kindOf(this.tree, k) === SyntaxKind.FailsClause),
    );
    const requirements = this.lowerer.requirements(
      parts.find((k) => kindOf(this.tree, k) === SyntaxKind.UsesClause),
    );
    const signature: ProviderSignature = {
      kind: "provider",
      id,
      ...this.base(entry),
      provides: sortedUnique(provides),
      failures,
      requirements,
      type: this.lowerer.providerOf(provides, failures, requirements),
    };
    this.values.set(id, signature);
  }

  // -------------------------------------------------------------- consts

  private base(entry: DeclEntry): SignatureBase {
    return {
      name: entry.name,
      exported: entry.exported,
      node: entry.node,
      nameNode: entry.nameNode,
      span: entry.span,
      nameSpan: entry.nameSpan,
    };
  }

  private checkConst(entry: DeclEntry): void {
    const id = this.id("value", entry.name);
    const rest = this.lowerer.kids(entry.node).filter((k) =>
      k !== entry.nameNode
    );
    const bindingNode = rest.find((k) => isTypeKind(kindOf(this.tree, k)));
    const init = initOf(this.tree, entry.node, entry.nameNode);
    const binding = bindingNode === undefined
      ? undefined
      : this.lowerer.lower(bindingNode);
    if (
      init !== undefined && kindOf(this.tree, init) === SyntaxKind.ArrowExpr
    ) {
      this.values.set(id, this.functionSignature(entry, id, init, binding));
      return;
    }
    if (entry.exported && bindingNode === undefined && !entry.broken) {
      this.lowerer.report(
        "declaration/006",
        `the exported constant \`${entry.name}\` needs a type annotation`,
        entry.nameSpan,
      );
    }
    this.values.set(id, {
      kind: "constant",
      id,
      ...this.base(entry),
      type: binding,
    });
  }

  private functionSignature(
    entry: DeclEntry,
    id: ValueId,
    arrow: NodeId,
    binding: Lowered | undefined,
  ): FunctionSignature {
    const lowerer = this.lowerer;
    const parts = lowerer.kids(arrow);
    const paramList = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.ParamList
    );
    const resultNode = parts.find((k) => isTypeKind(kindOf(this.tree, k)));
    const failsNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.FailsClause
    );
    const usesNode = parts.find((k) =>
      kindOf(this.tree, k) === SyntaxKind.UsesClause
    );
    const written = paramList === undefined
      ? []
      : lowerer.parameters(paramList, "silent");

    // A binding type annotation that is a function type of the same arity supplies
    // the types that the arrow does not write.
    let bindingFn: {
      type: FunctionType;
      parameters: readonly TypeRef[];
      result: TypeRef;
    } | undefined;
    const bindingFunction = binding === undefined
      ? undefined
      : this.functionOfBinding(binding);
    if (
      bindingFunction !== undefined &&
      bindingFunction.node.parameters.length === written.length
    ) {
      bindingFn = {
        type: bindingFunction.ir,
        parameters: bindingFunction.node.parameters,
        result: bindingFunction.node.result,
      };
    }
    const parameters: ParameterSignature[] = written.map((p, i) => {
      if (p.annotated || bindingFn === undefined) return p;
      return {
        ...p,
        type: {
          ref: bindingFn.parameters[i],
          ir: bindingFn.type.parameters[i],
        },
      };
    });
    const missing = written.filter((p) =>
      !p.annotated && bindingFn === undefined
    );
    const explicit = resultNode !== undefined || bindingFn !== undefined;
    let result: Lowered | undefined;
    let failures: ErrorId[] = [];
    let requirements: CapabilityId[] = [];
    let annotation: FunctionSignature["annotation"] = "none";
    // A binding type is a type, so it closes every part. An exported function
    // closes both sets: an omitted clause is an empty set.
    let closedParts: WrittenParts = {
      result: false,
      fails: false,
      uses: false,
    };
    if (resultNode !== undefined) {
      result = lowerer.lower(resultNode);
      annotation = "arrow";
      closedParts = { result: true, fails: false, uses: false };
    } else if (bindingFn !== undefined) {
      result = { ref: bindingFn.result, ir: bindingFn.type.result };
      failures = [...bindingFn.type.effects.failures];
      requirements = [...bindingFn.type.effects.requirements];
      annotation = "binding";
      closedParts = { result: true, fails: true, uses: true };
    }
    if (annotation !== "binding") {
      const closed = entry.exported || bindingFn !== undefined;
      closedParts = {
        ...closedParts,
        fails: failsNode !== undefined || closed,
        uses: usesNode !== undefined || closed,
      };
      if (closedParts.fails) failures = lowerer.failures(failsNode);
      if (closedParts.uses) requirements = lowerer.requirements(usesNode);
    }

    if (!entry.broken && binding !== undefined) {
      this.checkBindingFits(arrow, binding, parameters, result, {
        failures,
        requirements,
      });
    }
    if (!entry.broken) {
      if (entry.exported) {
        if (missing.length > 0 || !explicit) {
          lowerer.report(
            "declaration/005",
            `the exported function \`${entry.name}\` needs an annotation on every parameter and on its result`,
            entry.nameSpan,
          );
        }
      } else {
        for (const param of missing) {
          lowerer.report(
            "declaration/011",
            `the parameter \`${param.name}\` needs a type annotation`,
            param.span,
          );
        }
      }
    }
    return {
      kind: "function",
      id,
      ...this.base(entry),
      written: closedParts,
      annotation,
      parameters,
      result,
      failures,
      requirements,
      ...(bindingFn?.type.execution === "pure"
        ? { expectedExecution: "pure" as const }
        : {}),
    };
  }

  /**
   * The function type of a binding annotation, seen through alias names. A
   * written function type keeps its lowered IR, which holds the source order and
   * schema make inputs that `toIr` does not.
   */
  private functionOfBinding(
    binding: Lowered,
  ): { node: FunctionNode; ir: FunctionType } | undefined {
    const ref = this.table.unfold(binding.ref);
    const node = this.table.node(ref);
    if (node.kind !== "function") return undefined;
    const ir = binding.ir.kind === "function"
      ? binding.ir
      : this.table.toIr(ref);
    return ir.kind === "function" ? { node, ir } : undefined;
  }

  /**
   * The arrow of an annotated binding must fit the binding type. The arrow takes
   * the execution of the binding type, because its body decides its own mode later.
   */
  private checkBindingFits(
    arrow: NodeId,
    binding: Lowered,
    parameters: readonly ParameterSignature[],
    result: Lowered | undefined,
    effects: {
      failures: readonly ErrorId[];
      requirements: readonly CapabilityId[];
    },
  ): void {
    const expected = this.table.show(binding.ref);
    const fn = this.functionOfBinding(binding);
    if (fn === undefined) {
      this.lowerer.report(
        "type-mismatch/003",
        `the value is a function, but ${expected} is expected`,
        this.lowerer.span(arrow),
      );
      return;
    }
    if (result === undefined) {
      // The body infers the result. Only the arity can disagree here.
      if (parameters.length !== fn.ir.parameters.length) {
        this.lowerer.report(
          "type-mismatch/003",
          `the function takes ${parameters.length} parameters, but ${expected} is expected`,
          this.lowerer.span(arrow),
        );
      }
      return;
    }
    const found = this.table.function({
      execution: fn.ir.execution,
      parameters: parameters.map((p) => p.type.ref),
      result: result.ref,
      failures: effects.failures,
      requirements: effects.requirements,
    });
    if (!this.table.isAssignableIn(this.env.module, found, binding.ref)) {
      this.lowerer.report(
        "type-mismatch/003",
        `the function has type ${
          this.table.show(found)
        }, but ${expected} is expected`,
        this.lowerer.span(arrow),
      );
    }
  }
}

/**
 * Checks the declarations of one module. `imported` holds the type graphs of the
 * modules that this module reaches through its imports. The table registers their
 * definitions before it lowers any local type.
 */
export function checkModuleDeclarations(
  analysis: Analysis,
  module: string,
  table: TypeTable,
  imported: ReadonlyMap<string, TypeGraph>,
): ModuleDeclarations {
  const info = analysis.project.modules.get(module);
  const resolution = analysis.resolutions.get(module);
  if (info === undefined || resolution === undefined) {
    throw new Error(`module ${module} is not part of the analysis`);
  }
  const services = new Map<ServiceId, ServiceDecl>();
  const aliases = new Map<string, Type>();
  for (const graph of imported.values()) {
    table.load(graph);
    for (const service of graph.services) services.set(service.id, service);
    for (const type of graph.types) {
      if (type.definition.kind === "alias") {
        aliases.set(type.id, type.definition.type);
      }
    }
  }
  const env: TypeEnv = {
    module,
    tree: info.tree,
    targets: resolution.targets,
    table,
    services,
  };
  return new ModuleChecker(info, env, aliases).run();
}

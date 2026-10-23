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
// - A function signature with `contract: "inferred"` has no result and empty
//   sets. The body checker infers them.
// - The execution mode of a function with empty sets comes from a `ModeMap`
//   that the body checker supplies. `executionOf` and `signatureType` take the
//   map and return a Result error when an entry is missing.

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
} from "./ir.ts";
import { TokenKind } from "./lex.ts";
import { stronglyConnectedComponents } from "./modes.ts";
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
  readonly contract: "explicit" | "inferred";
  /** Where an explicit contract comes from: the arrow, or the binding type annotation. */
  readonly annotation: "arrow" | "binding" | "none";
  readonly parameters: readonly ParameterSignature[];
  /** Absent when the contract is inferred. */
  readonly result: Lowered | undefined;
  /** Sorted and unique. Empty when the contract is inferred. */
  readonly failures: readonly ErrorId[];
  /** Sorted and unique. A whole service is expanded to all its methods. */
  readonly requirements: readonly CapabilityId[];
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

/** The execution mode of each function whose mode the sets do not decide. */
export type ModeMap = ReadonlyMap<ValueId, Execution>;
/** Mode consumers can look up a mode without owning or mutating the map. */
export type ModeLookup = Pick<ModeMap, "get">;

type SignatureError =
  | { readonly tag: "missing-mode"; readonly id: ValueId }
  | { readonly tag: "inferred-contract"; readonly id: ValueId };

/** True when the sets of an explicit contract are empty, so the body decides the mode. */
export function isPendingMode(signature: FunctionSignature): boolean {
  return signature.contract === "explicit" &&
    signature.failures.length === 0 &&
    signature.requirements.length === 0;
}

/**
 * The execution mode of an explicit signature. A nonempty failure or requirement
 * set gives `effect`. Empty sets need an entry in the mode map.
 */
export function executionOf(
  signature: FunctionSignature,
  modes: ModeLookup,
): Result<Execution, SignatureError> {
  if (signature.contract !== "explicit") {
    return { ok: false, error: { tag: "inferred-contract", id: signature.id } };
  }
  if (!isPendingMode(signature)) return { ok: true, value: "effect" };
  const mode = modes.get(signature.id);
  if (mode === undefined) {
    return { ok: false, error: { tag: "missing-mode", id: signature.id } };
  }
  return { ok: true, value: mode };
}

interface SignatureType {
  readonly ref: TypeRef;
  readonly ir: FunctionType;
}

/** The function type of an explicit signature, with the mode from the map. */
export function signatureType(
  table: TypeTable,
  signature: FunctionSignature,
  modes: ModeLookup,
): Result<SignatureType, SignatureError> {
  const execution = executionOf(signature, modes);
  if (!execution.ok) return execution;
  const result = signature.result;
  if (result === undefined) {
    return { ok: false, error: { tag: "inferred-contract", id: signature.id } };
  }
  return {
    ok: true,
    value: loweredFunction(
      table,
      execution.value,
      signature.parameters.map((p) => p.type),
      result,
      signature.failures,
      signature.requirements,
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
  }
  /** `Brand<T>` is allowed only as the whole body of a type declaration. */
  | { readonly kind: "brand" };

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
      case "brand":
        for (const arg of args) this.lower(arg);
        this.report(
          "declaration/008",
          "`Brand<T>` is allowed only as the whole body of a type declaration",
          this.span(node),
        );
        return this.errorLowered();
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
    Brand: { kind: "brand" },
  };

  /** Lowers the argument of `Brand<T>` for a type declaration. Reports a wrong argument count. */
  brandBase(node: NodeId): Lowered {
    const argsNode = this.kidsOfKind(node, SyntaxKind.TypeArgs)[0];
    const args = argsNode === undefined ? [] : this.kids(argsNode);
    if (args.length !== 1) {
      this.arity("Brand", 1, args, node);
      return this.errorLowered();
    }
    return this.lower(args[0]);
  }

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
   * fields, and, for a data or error declaration, a field named `_tag`.
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
      result.push({ name, optional, type, span: this.span(fieldNode) });
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

  /** A function type in type syntax. Its execution defaults to `effect`. */
  private functionType(node: NodeId): Lowered {
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
    return this.functionOf(
      "effect",
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
}

function toIrField(field: LoweredField): Field {
  return { name: field.name, type: field.type.ir, optional: field.optional };
}

// ------------------------------------------------------------------ type graph walk

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

/** The most levels that a type declaration may have, counting its aliases. */
const MAX_TYPE_DEPTH = 128;

class ModuleChecker {
  readonly sink: Diagnostic[] = [];
  readonly lowerer: TypeLowerer;
  private readonly tree: SyntaxTree;
  private readonly table: TypeTable;
  private readonly types: TypeDecl[] = [];
  private readonly errors: ErrorDecl[] = [];
  private readonly services: ServiceDecl[] = [];
  private readonly methodTypes = new Map<CapabilityId, TypeRef>();
  private readonly values = new Map<ValueId, ValueSignature>();
  private readonly exports: DeclarationId[] = [];

  constructor(
    private readonly info: ModuleInfo,
    readonly env: TypeEnv,
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
    const infos: TypeNodeInfo[] = [];
    for (const entry of entries) {
      if (entry.kind === "type") infos.push(this.checkType(entry));
      else if (entry.kind === "data") infos.push(this.checkData(entry));
      else if (entry.kind === "error") infos.push(this.checkError(entry));
    }
    const guarded = this.checkCycles(infos);
    this.checkDepths(infos, guarded);
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
   * Rule R1: a primitive type node can occur only inside a type, data, or error declaration.
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
          }\` can occur only inside a type, data, or error declaration`,
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
      case "Brand":
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
        kind: "brand",
        base: { kind: "primitive", name: "unknown" },
      };
      kind = "brand";
    } else if (body !== undefined && this.isBrand(body)) {
      const base = this.lowerer.brandBase(body);
      this.table.defineBrand(id, base.ref);
      definition = { kind: "brand", base: base.ir };
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

  /** True when the node is `Brand<...>` or `Brand`. */
  private isBrand(node: NodeId): boolean {
    if (kindOf(this.tree, node) !== SyntaxKind.NamedType) return false;
    const nameNode = this.lowerer.kidsOfKind(node, SyntaxKind.Name)[0];
    if (nameNode === undefined) return false;
    const target = this.env.targets.get(nameNode);
    return target?.kind === "builtin-type" && target.name === "Brand";
  }

  private checkData(entry: DeclEntry): TypeNodeInfo {
    const id = this.id("type", entry.name);
    const record =
      this.lowerer.kidsOfKind(entry.node, SyntaxKind.RecordType)[0];
    const fields = record === undefined
      ? []
      : this.lowerer.fields(record, true);
    this.table.defineData(id, this.lowerer.recordOf(fields).ref);
    this.types.push({
      kind: "type",
      id,
      name: entry.name,
      definition: { kind: "data", fields: fields.map(toIrField) },
      span: entry.span,
    });
    const refs = new Set<string>();
    for (const field of fields) referencedIds(field.type.ir, refs);
    return {
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind: "data",
      refs,
    };
  }

  private checkError(entry: DeclEntry): TypeNodeInfo {
    const id = this.id("error", entry.name);
    const record =
      this.lowerer.kidsOfKind(entry.node, SyntaxKind.RecordType)[0];
    const fields = record === undefined
      ? []
      : this.lowerer.fields(record, true);
    this.table.defineError(id, this.lowerer.recordOf(fields).ref);
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
    if (resultNode !== undefined) {
      result = lowerer.lower(resultNode);
      failures = lowerer.failures(failsNode);
      requirements = lowerer.requirements(usesNode);
      annotation = "arrow";
    } else if (bindingFn !== undefined) {
      result = { ref: bindingFn.result, ir: bindingFn.type.result };
      failures = [...bindingFn.type.effects.failures];
      requirements = [...bindingFn.type.effects.requirements];
      annotation = "binding";
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
      contract: explicit ? "explicit" : "inferred",
      annotation,
      parameters,
      result: explicit ? result : undefined,
      failures: explicit ? failures : [],
      requirements: explicit ? requirements : [],
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
    if (!this.table.isAssignable(found, binding.ref)) {
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
  for (const graph of imported.values()) {
    table.load(graph);
    for (const service of graph.services) services.set(service.id, service);
  }
  const env: TypeEnv = {
    module,
    tree: info.tree,
    targets: resolution.targets,
    table,
    services,
  };
  return new ModuleChecker(info, env).run();
}

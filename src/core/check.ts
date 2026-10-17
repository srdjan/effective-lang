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
import { type DeclEntry, isTypeKind, nameTextOf } from "./index.ts";
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
} from "./syntax.ts";
import { sortedUnique, type TypeRef, type TypeTable } from "./types.ts";

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

export interface ParameterSignature {
  readonly name: string;
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

export interface ProviderSignature extends SignatureBase {
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

export type SignatureError =
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
  modes: ModeMap,
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

export interface SignatureType {
  readonly ref: TypeRef;
  readonly ir: FunctionType;
}

/** The function type of an explicit signature, with the mode from the map. */
export function signatureType(
  table: TypeTable,
  signature: FunctionSignature,
  modes: ModeMap,
): Result<SignatureType, SignatureError> {
  const execution = executionOf(signature, modes);
  if (!execution.ok) return execution;
  const result = signature.result;
  if (result === undefined) {
    return { ok: false, error: { tag: "inferred-contract", id: signature.id } };
  }
  const ref = table.function({
    execution: execution.value,
    parameters: signature.parameters.map((p) => p.type.ref),
    result: result.ref,
    failures: signature.failures,
    requirements: signature.requirements,
  });
  const ir: FunctionType = {
    kind: "function",
    execution: execution.value,
    parameters: signature.parameters.map((p) => p.type.ir),
    result: result.ir,
    effects: {
      failures: sortedUnique(signature.failures),
      requirements: sortedUnique(signature.requirements),
    },
  };
  return { ok: true, value: { ref, ir } };
}

// ------------------------------------------------------------------ type lowering

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
    const result: NodeId[] = [];
    for (const child of childrenOf(this.tree, node)) {
      const kind = kindOf(this.tree, child);
      if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
        result.push(child);
      }
    }
    return result;
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
    const table = this.env.table;
    for (const child of childrenOf(this.tree, node)) {
      if (kindOf(this.tree, child) !== SyntaxKind.Token) continue;
      const kind = this.tree.lexed.kinds[this.tree.tokens[child]] as TokenKind;
      const text = nodeText(this.tree, child);
      let value: string | number | boolean | undefined;
      if (kind === TokenKind.String) value = decodeString(text);
      else if (kind === TokenKind.Number) value = Number(text);
      else if (kind === TokenKind.KwTrue) value = true;
      else if (kind === TokenKind.KwFalse) value = false;
      if (value === undefined) return this.errorLowered();
      if (typeof value === "number" && !Number.isFinite(value)) {
        return this.errorLowered();
      }
      return { ref: table.literal(value), ir: { kind: "literal", value } };
    }
    return this.errorLowered();
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
    switch (target.name) {
      case "string":
      case "boolean":
      case "int":
      case "number":
      case "never":
      case "unknown": {
        this.noArguments(name, args, argsNode);
        return {
          ref: table.primitive(target.name),
          ir: { kind: "primitive", name: target.name },
        };
      }
      case "void":
        this.noArguments(name, args, argsNode);
        return { ref: table.unit, ir: { kind: "primitive", name: "unit" } };
      case "Option": {
        if (args.length !== 1) {
          this.arity(name, 1, args, node);
          return this.errorLowered();
        }
        const element = this.lower(args[0]);
        return {
          ref: table.option(element.ref),
          ir: { kind: "option", element: element.ir },
        };
      }
      case "Brand":
        for (const arg of args) this.lower(arg);
        this.report(
          "declaration/008",
          "`Brand<T>` is allowed only as the whole body of a type declaration",
          this.span(node),
        );
        return this.errorLowered();
    }
  }

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
   * fields, and, for an error declaration, a field named `_tag`.
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
          "the field name `_tag` is reserved for generated error tags",
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
    );
  }

  functionOf(
    execution: Execution,
    parameters: readonly Lowered[],
    result: Lowered,
    failures: readonly ErrorId[],
    requirements: readonly CapabilityId[],
  ): Lowered {
    const failureSet = sortedUnique(failures);
    const requirementSet = sortedUnique(requirements);
    return {
      ref: this.env.table.function({
        execution,
        parameters: parameters.map((p) => p.ref),
        result: result.ref,
        failures: failureSet,
        requirements: requirementSet,
      }),
      ir: {
        kind: "function",
        execution,
        parameters: parameters.map((p) => p.ir),
        result: result.ir,
        effects: { failures: failureSet, requirements: requirementSet },
      },
    };
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

export interface LoweredField {
  readonly name: string;
  readonly optional: boolean;
  readonly type: Lowered;
  readonly span: Span;
}

function toIrField(field: LoweredField): Field {
  return { name: field.name, type: field.type.ir, optional: field.optional };
}

/** Decodes a string token. The lexer accepts only strings that JSON accepts. */
export function decodeString(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ type graph walk

/** Adds the type and error identities that an IR type mentions, and the services of its capabilities. */
export function referencedIds(type: Type, ids: Set<string>): void {
  switch (type.kind) {
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
      referencedIds(type.element, ids);
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

/** `cap:m#S.method` to `service:m#S`. */
export function serviceOfCapability(
  capability: CapabilityId,
): ServiceId | undefined {
  const hash = capability.indexOf("#");
  if (hash < 0) return undefined;
  const dot = capability.indexOf(".", hash);
  if (dot < 0) return undefined;
  return `service:${capability.slice(4, dot)}` as ServiceId;
}

// ------------------------------------------------------------------ the module checker

interface TypeNodeInfo {
  readonly id: TypeId | ErrorId;
  readonly name: string;
  readonly nameSpan: Span;
  readonly start: number;
  readonly kind: "alias" | "brand" | "error";
  readonly refs: ReadonlySet<string>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  private readonly typeInfos: TypeNodeInfo[] = [];

  constructor(
    private readonly info: ModuleInfo,
    readonly env: TypeEnv,
  ) {
    this.tree = env.tree;
    this.table = env.table;
    this.lowerer = new TypeLowerer(env, this.sink);
  }

  private id(prefix: string, name: string): string {
    return `${prefix}:${this.env.module}#${name}`;
  }

  /** The first declaration of each name. Later ones are duplicates that the resolver reported. */
  private entries(): DeclEntry[] {
    const { index } = this.info;
    return index.decls.filter((d) => index.byName.get(d.name) === d);
  }

  run(): ModuleDeclarations {
    const entries = this.entries();
    for (const entry of entries) {
      if (entry.kind === "type") this.checkType(entry);
      else if (entry.kind === "error") this.checkError(entry);
    }
    this.checkCycles();
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
        : entry.kind;
      this.exports.push(this.id(prefix, entry.name) as DeclarationId);
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

  // -------------------------------------------------------------- types and errors

  private bodyOf(entry: DeclEntry): NodeId | undefined {
    return this.lowerer.kids(entry.node).find((k) =>
      k !== entry.nameNode && kindOf(this.tree, k) !== SyntaxKind.Error
    );
  }

  private checkType(entry: DeclEntry): void {
    const id = this.id("type", entry.name) as TypeId;
    const body = this.bodyOf(entry);
    let definition: TypeDecl["definition"];
    let kind: "alias" | "brand" = "alias";
    if (body !== undefined && this.isBrand(body)) {
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
      span: entry.span,
    });
    const refs = new Set<string>();
    referencedIds(
      definition.kind === "alias" ? definition.type : definition.base,
      refs,
    );
    this.typeInfos.push({
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind,
      refs,
    });
  }

  /** True when the node is `Brand<...>` or `Brand`. */
  private isBrand(node: NodeId): boolean {
    if (kindOf(this.tree, node) !== SyntaxKind.NamedType) return false;
    const nameNode = this.lowerer.kidsOfKind(node, SyntaxKind.Name)[0];
    if (nameNode === undefined) return false;
    const target = this.env.targets.get(nameNode);
    return target?.kind === "builtin-type" && target.name === "Brand";
  }

  private checkError(entry: DeclEntry): void {
    const id = this.id("error", entry.name) as ErrorId;
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
    this.typeInfos.push({
      id,
      name: entry.name,
      nameSpan: entry.nameSpan,
      start: entry.span.start,
      kind: "error",
      refs,
    });
  }

  /**
   * Version 0 rejects recursive type definitions. Finds the strongly connected
   * components of the reference graph, reports one diagnostic for each cycle, and
   * redefines its aliases and brands as the error type so that compatibility ends.
   */
  private checkCycles(): void {
    const infos = new Map<string, TypeNodeInfo>();
    for (const info of this.typeInfos) infos.set(info.id, info);
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    const components: TypeNodeInfo[][] = [];

    const visit = (id: string): void => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      const refs = [...infos.get(id)!.refs].filter((r) => infos.has(r)).sort(
        compareText,
      );
      for (const next of refs) {
        if (!index.has(next)) {
          visit(next);
          low.set(id, Math.min(low.get(id)!, low.get(next)!));
        } else if (onStack.has(next)) {
          low.set(id, Math.min(low.get(id)!, index.get(next)!));
        }
      }
      if (low.get(id) !== index.get(id)) return;
      const component: TypeNodeInfo[] = [];
      while (true) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(infos.get(member)!);
        if (member === id) break;
      }
      const selfLoop = component.length === 1 &&
        component[0].refs.has(component[0].id);
      if (component.length > 1 || selfLoop) components.push(component);
    };
    for (const info of this.typeInfos) {
      if (!index.has(info.id)) visit(info.id);
    }

    for (const component of components) {
      component.sort((a, b) => a.start - b.start);
      const first = component[0];
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
          this.table.defineAlias(member.id as TypeId, this.table.error);
        } else if (member.kind === "brand") {
          this.table.defineBrand(member.id as TypeId, this.table.error);
        }
      }
    }
  }

  // -------------------------------------------------------------- services and providers

  private checkService(entry: DeclEntry): void {
    const id = this.id("service", entry.name) as ServiceId;
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
      const capability =
        `cap:${this.env.module}#${entry.name}.${method.name}` as CapabilityId;
      this.methodTypes.set(capability, type.ref);
      methods.push({
        id: capability,
        name: method.name,
        type: type.ir as FunctionType,
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
    const id = this.id("value", entry.name) as ValueId;
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
    const providesSet = sortedUnique(provides);
    const ref = this.table.provider({
      provides: providesSet,
      execution: "effect",
      failures,
      requirements,
    });
    const signature: ProviderSignature = {
      kind: "provider",
      id,
      ...this.base(entry),
      provides: providesSet,
      failures,
      requirements,
      type: {
        ref,
        ir: {
          kind: "provider",
          provides: providesSet,
          acquisition: {
            execution: "effect",
            effects: { failures, requirements },
          },
        },
      },
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
    const id = this.id("value", entry.name) as ValueId;
    const rest = this.lowerer.kids(entry.node).filter((k) =>
      k !== entry.nameNode
    );
    const bindingNode = rest.find((k) => isTypeKind(kindOf(this.tree, k)));
    const init = rest.filter((k) => !isTypeKind(kindOf(this.tree, k))).pop();
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
    if (binding !== undefined && binding.ir.kind === "function") {
      const node = this.table.node(binding.ref);
      if (
        node.kind === "function" && node.parameters.length === written.length
      ) {
        bindingFn = {
          type: binding.ir,
          parameters: node.parameters,
          result: node.result,
        };
      }
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
    if (binding.ir.kind !== "function") {
      this.lowerer.report(
        "type-mismatch/003",
        `the value is a function, but ${expected} is expected`,
        this.lowerer.span(arrow),
      );
      return;
    }
    if (result === undefined) {
      // The body infers the result. Only the arity can disagree here.
      if (parameters.length !== binding.ir.parameters.length) {
        this.lowerer.report(
          "type-mismatch/003",
          `the function takes ${parameters.length} parameters, but ${expected} is expected`,
          this.lowerer.span(arrow),
        );
      }
      return;
    }
    const found = this.table.function({
      execution: binding.ir.execution,
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

// Name resolution. Each name node gets one entry in a side table from the node id
// to its target: a declaration identity, a local identity, a prelude builtin, or
// a builtin type. See plan sections 5.2 to 5.4 for the rules.
//
// Scope rules. Module-level names live in one namespace for the whole module
// (types, errors, services, providers, consts, and imports) and are visible
// everywhere, in any order. A local scope holds parameters, block consts, match
// pattern bindings, and catch handler bindings. A block that follows a parameter
// list, a pattern, or a handler binding shares that scope, because the emitted
// function body shares it too.

import {
  type Diagnostic,
  type DiagnosticCode,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
import {
  type DeclEntry,
  type DeclKind,
  isTypeKind,
  nameTextOf,
} from "./index.ts";
import type {
  CapabilityId,
  ErrorId,
  LocalId,
  ServiceId,
  TypeId,
  ValueId,
} from "./ir.ts";
import type { ModuleInfo, Project } from "./project.ts";
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

// ------------------------------------------------------------------ prelude

export type PreludeName =
  | "fail"
  | "retry"
  | "provide"
  | "defer"
  | "run"
  | "scoped"
  | "forkScoped"
  | "withResource"
  | "unfold"
  | "mapEffect"
  | "mapStream"
  | "scanStream"
  | "mapAccumStream"
  | "foldStream"
  | "foldEffectStream"
  | "collectStream"
  | "headStream"
  | "lastStream"
  | "drainStream"
  | "sinkForEach"
  | "runStream"
  | "bufferStream"
  | "mergeStreams"
  | "zipStreams"
  | "concatStreams"
  | "flatMapStreams"
  | "switchMapStreams"
  | "catchStream"
  | "retryStream"
  | "debounceStream"
  | "throttleStream"
  | "takeStream"
  | "dropStream"
  | "dropWhileStream"
  | "filterStream"
  | "filterEffectStream"
  | "takeWhileEffectStream"
  | "takeUntilEffectStream"
  | "dropWhileEffectStream"
  | "takeWhileStream"
  | "takeUntilStream"
  | "race"
  | "makeRef"
  | "getRef"
  | "setRef"
  | "updateRef"
  | "layer"
  | "mergeLayers"
  | "retrySchedule"
  | "codec"
  | "decode"
  | "encode"
  | "withFiber"
  | "joinFiber"
  | "interruptFiber"
  | "unbrand"
  | "Some"
  | "None"
  | "map"
  | "filter"
  | "fold"
  | "all"
  | "partitionAll"
  | "validateAll"
  | "allResults"
  | "traverse";

export const PRELUDE_NAMES: ReadonlySet<string> = new Set<PreludeName>([
  "fail",
  "retry",
  "provide",
  "defer",
  "run",
  "scoped",
  "forkScoped",
  "withResource",
  "unfold",
  "mapEffect",
  "mapStream",
  "scanStream",
  "mapAccumStream",
  "foldStream",
  "foldEffectStream",
  "collectStream",
  "headStream",
  "lastStream",
  "drainStream",
  "sinkForEach",
  "runStream",
  "bufferStream",
  "mergeStreams",
  "zipStreams",
  "concatStreams",
  "flatMapStreams",
  "switchMapStreams",
  "catchStream",
  "retryStream",
  "debounceStream",
  "throttleStream",
  "takeStream",
  "dropStream",
  "dropWhileStream",
  "filterStream",
  "filterEffectStream",
  "takeWhileEffectStream",
  "takeUntilEffectStream",
  "dropWhileEffectStream",
  "takeWhileStream",
  "takeUntilStream",
  "race",
  "makeRef",
  "getRef",
  "setRef",
  "updateRef",
  "layer",
  "mergeLayers",
  "retrySchedule",
  "codec",
  "decode",
  "encode",
  "withFiber",
  "joinFiber",
  "interruptFiber",
  "unbrand",
  "Some",
  "None",
  "map",
  "filter",
  "fold",
  "all",
  "partitionAll",
  "validateAll",
  "allResults",
  "traverse",
]);

export type BuiltinTypeName =
  | "string"
  | "boolean"
  | "int"
  | "number"
  | "void"
  | "never"
  | "unknown"
  | "Option"
  | "Brand"
  | "Ref"
  | "RetrySchedule"
  | "Codec"
  | "Fiber";

export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set<
  BuiltinTypeName
>([
  "string",
  "boolean",
  "int",
  "number",
  "void",
  "never",
  "unknown",
  "Option",
  "Brand",
  "Ref",
  "RetrySchedule",
  "Codec",
  "Fiber",
]);

/**
 * Names that the generated TypeScript needs, so no declaration or binding may
 * take them. The emitter prints the globals `undefined`, `Number`, `RangeError`,
 * and `ReadonlyArray`. TypeScript rejects `any`, `bigint`, `object`, and
 * `symbol` as the name of a type or a class.
 */
export const TARGET_NAMES: ReadonlySet<string> = new Set([
  "undefined",
  "Number",
  "RangeError",
  "ReadonlyArray",
  "any",
  "bigint",
  "object",
  "symbol",
]);

function asPrelude(name: string): PreludeName | undefined {
  return PRELUDE_NAMES.has(name) ? name as PreludeName : undefined;
}

function asBuiltinType(name: string): BuiltinTypeName | undefined {
  return BUILTIN_TYPE_NAMES.has(name) ? name as BuiltinTypeName : undefined;
}

// ------------------------------------------------------------------ targets

export type Target =
  | { readonly kind: "type"; readonly id: TypeId }
  | { readonly kind: "error"; readonly id: ErrorId }
  | { readonly kind: "service"; readonly id: ServiceId }
  | { readonly kind: "provider"; readonly id: ValueId }
  | { readonly kind: "value"; readonly id: ValueId }
  | { readonly kind: "cap"; readonly id: CapabilityId }
  | { readonly kind: "local"; readonly id: LocalId }
  | { readonly kind: "builtin"; readonly name: PreludeName }
  | { readonly kind: "builtin-type"; readonly name: BuiltinTypeName }
  /** A field label or a field access. The checker resolves it against a record type. */
  | { readonly kind: "field"; readonly name: string }
  /** A name that did not resolve. A diagnostic exists, or an earlier one covers it. */
  | { readonly kind: "unresolved"; readonly name: string };

/** The identity string of a target, or the builtin name. */
export function targetText(target: Target): string {
  switch (target.kind) {
    case "builtin":
      return `prelude:${target.name}`;
    case "builtin-type":
    case "field":
    case "unresolved":
      return `${target.kind}:${target.name}`;
    default:
      return target.id;
  }
}

/** A module-level name. */
export interface Binding {
  readonly target: Target;
  /** For a service: the defining module and the declaration, to look up methods. */
  readonly service?: { readonly module: string; readonly entry: DeclEntry };
  readonly span: Span;
}

export interface ModuleResolution {
  readonly module: string;
  /** From syntax node id to target. Every resolved name node has one entry. */
  readonly targets: ReadonlyMap<NodeId, Target>;
  /** From local identity to the span of the name that binds it. */
  readonly locals: ReadonlyMap<LocalId, Span>;
  /** The module-level names, including imported names. */
  readonly namespace: ReadonlyMap<string, Binding>;
  readonly diagnostics: readonly Diagnostic[];
}

// ------------------------------------------------------------------ scopes

interface LocalBinding {
  readonly id: LocalId;
  /** True while a block const initializer that is not an arrow is being resolved. */
  pending: boolean;
  readonly span: Span;
}

class Scope {
  readonly names = new Map<string, LocalBinding>();
  /** Names that a use inside this scope resolved to a binding outside it. */
  readonly outerUses = new Map<string, Span>();
  constructor(readonly parent: Scope | undefined) {}
}

type Found =
  | { readonly tag: "local"; readonly binding: LocalBinding }
  | { readonly tag: "module"; readonly binding: Binding }
  | { readonly tag: "builtin"; readonly name: PreludeName };

type Position = "value" | "callee";

const PATTERN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.WildcardPattern,
  SyntaxKind.LiteralPattern,
  SyntaxKind.NamePattern,
  SyntaxKind.CtorPattern,
  SyntaxKind.RecordPattern,
]);

const DECL_PREFIX: Readonly<Record<DeclKind, string>> = {
  type: "type",
  error: "error",
  service: "service",
  provider: "value",
  const: "value",
};

function describeKind(target: Target): string {
  switch (target.kind) {
    case "type":
      return "a type";
    case "error":
      return "an error";
    case "service":
      return "a service";
    case "provider":
      return "a provider";
    case "value":
      return "a value";
    case "cap":
      return "a service method";
    case "local":
      return "a local binding";
    case "builtin":
      return "a builtin function";
    case "builtin-type":
      return "a builtin type";
    case "field":
      return "a field";
    case "unresolved":
      return "an unresolved name";
  }
}

// ------------------------------------------------------------------ resolver

class Resolver {
  readonly targets = new Map<NodeId, Target>();
  readonly locals = new Map<LocalId, Span>();
  readonly diagnostics: Diagnostic[] = [];
  readonly namespace = new Map<string, Binding>();

  private readonly tree: SyntaxTree;
  private readonly name: string;
  private scope: Scope | undefined;
  private fn = "";
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly info: ModuleInfo,
    private readonly project: Project,
  ) {
    this.tree = info.tree;
    this.name = info.name;
  }

  // -------------------------------------------------------------- helpers

  private kids(node: NodeId): NodeId[] {
    const result: NodeId[] = [];
    for (const child of childrenOf(this.tree, node)) {
      const kind = kindOf(this.tree, child);
      if (kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing) {
        result.push(child);
      }
    }
    return result;
  }

  private kidsOfKind(node: NodeId, kind: SyntaxKind): NodeId[] {
    return this.kids(node).filter((k) => kindOf(this.tree, k) === kind);
  }

  private span(node: NodeId): Span {
    return nodeSpan(this.tree, node);
  }

  private report(
    code: DiagnosticCode,
    message: string,
    span: Span,
    related?: readonly { span: Span; message: string }[],
  ): void {
    this.diagnostics.push(makeDiagnostic(code, message, span, related));
  }

  private set(node: NodeId, target: Target): void {
    this.targets.set(node, target);
  }

  private unresolved(node: NodeId, name: string): void {
    this.set(node, { kind: "unresolved", name });
  }

  private id(prefix: string, name: string): string {
    return `${prefix}:${this.name}#${name}`;
  }

  // -------------------------------------------------------------- namespace

  private declareModuleName(
    name: string,
    binding: Binding,
    nameNode: NodeId,
  ): void {
    // Existing programs may use these names as values. Bindings shadow
    // these prelude operations; lookupValue already checks bindings first.
    if (
      (PRELUDE_NAMES.has(name) && name !== "run" && name !== "all" &&
        name !== "partitionAll" &&
        name !== "validateAll" &&
        name !== "allResults" &&
        name !== "scoped" && name !== "forkScoped" && name !== "zipStreams" &&
        name !== "concatStreams" && name !== "flatMapStreams" &&
        name !== "switchMapStreams" &&
        name !== "catchStream" &&
        name !== "retryStream" &&
        name !== "debounceStream" && name !== "throttleStream" &&
        name !== "takeStream" && name !== "dropStream" &&
        name !== "dropWhileStream" && name !== "filterStream" &&
        name !== "filterEffectStream" &&
        name !== "takeWhileEffectStream" &&
        name !== "takeUntilEffectStream" &&
        name !== "dropWhileEffectStream" &&
        name !== "mapStream" && name !== "scanStream" &&
        name !== "mapAccumStream" && name !== "foldStream" &&
        name !== "foldEffectStream" && name !== "collectStream" &&
        name !== "headStream" && name !== "lastStream" &&
        name !== "drainStream" &&
        name !== "takeWhileStream" &&
        name !== "takeUntilStream") ||
      BUILTIN_TYPE_NAMES.has(name)
    ) {
      this.report(
        "declaration/002",
        `\`${name}\` is a reserved prelude or builtin name and cannot be declared`,
        binding.span,
      );
    } else if (TARGET_NAMES.has(name)) {
      this.report(
        "declaration/002",
        `\`${name}\` is reserved because the generated TypeScript needs it`,
        binding.span,
      );
    }
    const existing = this.namespace.get(name);
    if (existing !== undefined) {
      this.report(
        "declaration/001",
        `\`${name}\` is already declared in this module`,
        binding.span,
        [{ span: existing.span, message: "first declared here" }],
      );
      this.set(nameNode, existing.target);
      return;
    }
    this.namespace.set(name, binding);
    this.set(nameNode, binding.target);
  }

  private bindImports(): void {
    const { index } = this.info;
    const events: { start: number; run: () => void }[] = [];
    index.imports.forEach((entry, i) => {
      events.push({ start: entry.span.start, run: () => this.bindImport(i) });
    });
    for (const decl of index.decls) {
      events.push({
        start: decl.span.start,
        run: () => this.bindDecl(decl),
      });
    }
    events.sort((a, b) => a.start - b.start);
    for (const event of events) event.run();
  }

  private bindImport(i: number): void {
    const link = this.info.links[i];
    const entry = this.info.index.imports[i];
    const target = link.target === undefined
      ? undefined
      : this.project.modules.get(link.target);
    for (const imported of entry.names) {
      const poison: Binding = {
        target: { kind: "unresolved", name: imported.name },
        span: imported.span,
      };
      if (target === undefined) {
        this.declareModuleName(imported.name, poison, imported.node);
        continue;
      }
      const decl = target.index.byName.get(imported.name);
      if (decl === undefined) {
        this.report(
          "unknown-name/002",
          `module \`${target.name}\` has no declaration named \`${imported.name}\``,
          imported.span,
        );
        this.declareModuleName(imported.name, poison, imported.node);
        continue;
      }
      if (!decl.exported) {
        this.report(
          "unknown-name/002",
          `\`${imported.name}\` is not exported by module \`${target.name}\``,
          imported.span,
        );
        this.declareModuleName(imported.name, poison, imported.node);
        continue;
      }
      this.declareModuleName(
        imported.name,
        this.bindingFor(target.name, decl, imported.span),
        imported.node,
      );
    }
  }

  private bindDecl(decl: DeclEntry): void {
    this.declareModuleName(
      decl.name,
      this.bindingFor(this.name, decl, decl.nameSpan),
      decl.nameNode,
    );
    const seen = new Set<string>();
    for (const method of decl.methodList) {
      if (seen.has(method.name)) {
        this.report(
          "declaration/001",
          `service \`${decl.name}\` already has a method named \`${method.name}\``,
          method.nameSpan,
          [{
            span: decl.methods.get(method.name)!.nameSpan,
            message: "first declared here",
          }],
        );
      }
      seen.add(method.name);
      this.set(method.nameNode, {
        kind: "cap",
        id: `cap:${this.name}#${decl.name}.${method.name}`,
      });
    }
  }

  private bindingFor(module: string, decl: DeclEntry, span: Span): Binding {
    const id = `${DECL_PREFIX[decl.kind]}:${module}#${decl.name}`;
    switch (decl.kind) {
      case "type":
        return { target: { kind: "type", id: id as TypeId }, span };
      case "error":
        return { target: { kind: "error", id: id as ErrorId }, span };
      case "service":
        return {
          target: { kind: "service", id: id as ServiceId },
          service: { module, entry: decl },
          span,
        };
      case "provider":
        return { target: { kind: "provider", id: id as ValueId }, span };
      case "const":
        return { target: { kind: "value", id: id as ValueId }, span };
    }
  }

  // -------------------------------------------------------------- locals

  private declareLocal(
    nameNode: NodeId,
    pending: boolean,
  ): LocalBinding | undefined {
    const scope = this.scope;
    if (scope === undefined) return undefined;
    const name = nameTextOf(this.tree, nameNode);
    if (name === undefined) return undefined;
    const span = this.span(nameNode);
    if (
      PRELUDE_NAMES.has(name) && name !== "run" && name !== "all" &&
      name !== "partitionAll" &&
      name !== "validateAll" &&
      name !== "allResults" &&
      name !== "scoped" && name !== "forkScoped" && name !== "zipStreams" &&
      name !== "concatStreams" && name !== "flatMapStreams" &&
      name !== "switchMapStreams" &&
      name !== "catchStream" &&
      name !== "retryStream" &&
      name !== "debounceStream" && name !== "throttleStream" &&
      name !== "takeStream" && name !== "dropStream" &&
      name !== "dropWhileStream" && name !== "filterStream" &&
      name !== "filterEffectStream" &&
      name !== "takeWhileEffectStream" &&
      name !== "takeUntilEffectStream" &&
      name !== "dropWhileEffectStream" &&
      name !== "mapStream" && name !== "scanStream" &&
      name !== "mapAccumStream" && name !== "foldStream" &&
      name !== "foldEffectStream" && name !== "collectStream" &&
      name !== "headStream" && name !== "lastStream" &&
      name !== "drainStream" &&
      name !== "takeWhileStream" &&
      name !== "takeUntilStream"
    ) {
      this.report(
        "declaration/002",
        `\`${name}\` is a reserved prelude name and cannot be a binding`,
        span,
      );
    } else if (TARGET_NAMES.has(name)) {
      this.report(
        "declaration/002",
        `\`${name}\` is reserved because the generated TypeScript needs it`,
        span,
      );
    }
    const existing = scope.names.get(name);
    if (existing !== undefined) {
      this.report(
        "declaration/001",
        `\`${name}\` is already bound in this scope`,
        span,
        [{ span: existing.span, message: "first bound here" }],
      );
      this.set(nameNode, { kind: "local", id: existing.id });
      return undefined;
    }
    const used = scope.outerUses.get(name);
    if (used !== undefined) {
      this.report(
        "declaration/004",
        `\`${name}\` is used earlier in this block as an outer name, and this binding would capture that use`,
        span,
        [{ span: used, message: "the earlier use" }],
      );
    }
    const key = `${this.fn}/${name}`;
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    const base = `local:${this.name}#${this.fn}/${name}`;
    const binding: LocalBinding = {
      id: (count === 1 ? base : `${base}/${count}`) as LocalId,
      pending,
      span,
    };
    scope.names.set(name, binding);
    this.locals.set(binding.id, span);
    this.set(nameNode, { kind: "local", id: binding.id });
    return binding;
  }

  private lookupValue(name: string, useSpan: Span): Found | undefined {
    const passed: Scope[] = [];
    for (let s = this.scope; s !== undefined; s = s.parent) {
      const binding = s.names.get(name);
      if (binding !== undefined) {
        for (const p of passed) {
          if (!p.outerUses.has(name)) p.outerUses.set(name, useSpan);
        }
        return { tag: "local", binding };
      }
      passed.push(s);
    }
    let found: Found | undefined;
    const moduleBinding = this.namespace.get(name);
    if (moduleBinding !== undefined) {
      found = { tag: "module", binding: moduleBinding };
    } else {
      const builtin = asPrelude(name);
      if (builtin !== undefined) found = { tag: "builtin", name: builtin };
    }
    if (found !== undefined) {
      for (const p of passed) {
        if (!p.outerUses.has(name)) p.outerUses.set(name, useSpan);
      }
    }
    return found;
  }

  // -------------------------------------------------------------- name references

  private unknown(node: NodeId, name: string, what: string): void {
    this.report(
      "unknown-name/001",
      `unknown ${what} \`${name}\``,
      this.span(node),
    );
    this.unresolved(node, name);
  }

  private wrongKind(node: NodeId, name: string, message: string): void {
    this.report("unknown-name/004", message, this.span(node));
    this.unresolved(node, name);
  }

  /** A name in an expression position. `node` receives the target. */
  private valueRef(node: NodeId, name: string, position: Position): void {
    const found = this.lookupValue(name, this.span(node));
    if (found === undefined) {
      this.unknown(node, name, "name");
      return;
    }
    if (found.tag === "local") {
      if (found.binding.pending) {
        this.report(
          "unknown-name/001",
          `\`${name}\` is used in its own initializer before it is bound`,
          this.span(node),
        );
        this.unresolved(node, name);
        return;
      }
      this.set(node, { kind: "local", id: found.binding.id });
      return;
    }
    if (found.tag === "builtin") {
      if (position === "callee" || found.name === "None") {
        this.set(node, { kind: "builtin", name: found.name });
      } else {
        this.wrongKind(
          node,
          name,
          `the builtin \`${name}\` can only be called or used as a pipeline stage`,
        );
      }
      return;
    }
    const target = found.binding.target;
    switch (target.kind) {
      case "value":
      case "provider":
      case "unresolved":
        this.set(node, target);
        return;
      case "type":
      case "error":
        if (position === "callee") {
          this.set(node, target);
        } else {
          this.wrongKind(
            node,
            name,
            `\`${name}\` is ${
              describeKind(target)
            }, not a value; call it to construct a value`,
          );
        }
        return;
      default:
        this.wrongKind(
          node,
          name,
          `\`${name}\` is ${describeKind(target)}, not a value`,
        );
    }
  }

  /** A name in a type position. Locals do not take part. */
  private typeRef(nameNode: NodeId): void {
    const name = nameTextOf(this.tree, nameNode);
    if (name === undefined) return;
    const binding = this.namespace.get(name);
    if (binding !== undefined) {
      const t = binding.target;
      if (t.kind === "type" || t.kind === "error" || t.kind === "unresolved") {
        this.set(nameNode, t);
      } else {
        this.wrongKind(
          nameNode,
          name,
          `\`${name}\` is ${describeKind(t)}, not a type`,
        );
      }
      return;
    }
    const builtin = asBuiltinType(name);
    if (builtin !== undefined) {
      this.set(nameNode, { kind: "builtin-type", name: builtin });
      return;
    }
    this.unknown(nameNode, name, "type");
  }

  /** A name in `fails` or a catch handler. */
  private errorRef(nameNode: NodeId): void {
    const name = nameTextOf(this.tree, nameNode);
    if (name === undefined) return;
    const binding = this.namespace.get(name);
    if (binding === undefined) {
      this.unknown(nameNode, name, "error");
      return;
    }
    const t = binding.target;
    if (t.kind === "error" || t.kind === "unresolved") {
      this.set(nameNode, t);
    } else {
      this.wrongKind(
        nameNode,
        name,
        `\`${name}\` is ${describeKind(t)}, not an error`,
      );
    }
  }

  /** A constructor name in a pattern: `Some`, `None`, or an error. */
  private ctorRef(nameNode: NodeId): void {
    const name = nameTextOf(this.tree, nameNode);
    if (name === undefined) return;
    if (name === "Some" || name === "None") {
      this.set(nameNode, { kind: "builtin", name });
      return;
    }
    this.errorRef(nameNode);
  }

  /** The service for the first part of a qualified name, or undefined after a diagnostic. */
  private serviceRef(
    nameNode: NodeId,
    scoped: boolean,
  ): Binding | undefined {
    const name = nameTextOf(this.tree, nameNode);
    if (name === undefined) return undefined;
    let binding: Binding | undefined;
    if (scoped) {
      const found = this.lookupValue(name, this.span(nameNode));
      if (found === undefined) {
        this.unknown(nameNode, name, "service");
        return undefined;
      }
      if (found.tag === "local") {
        this.wrongKind(
          nameNode,
          name,
          `\`${name}\` is a local binding, not a service`,
        );
        return undefined;
      }
      if (found.tag === "builtin") {
        this.wrongKind(
          nameNode,
          name,
          `\`${name}\` is a builtin function, not a service`,
        );
        return undefined;
      }
      binding = found.binding;
    } else {
      binding = this.namespace.get(name);
      if (binding === undefined) {
        this.unknown(nameNode, name, "service");
        return undefined;
      }
    }
    const t = binding.target;
    if (t.kind === "service") {
      this.set(nameNode, t);
      return binding;
    }
    if (t.kind === "unresolved") {
      this.set(nameNode, t);
      return undefined;
    }
    this.wrongKind(
      nameNode,
      name,
      `\`${name}\` is ${describeKind(t)}, not a service`,
    );
    return undefined;
  }

  /** `Service.method` for a method name node. Returns the target, or undefined after a diagnostic. */
  private methodRef(
    service: Binding,
    methodNode: NodeId,
  ): Target | undefined {
    const method = nameTextOf(this.tree, methodNode);
    const info = service.service;
    if (method === undefined || info === undefined) return undefined;
    if (!info.entry.methods.has(method)) {
      this.report(
        "unknown-name/003",
        `service \`${info.entry.name}\` has no method named \`${method}\``,
        this.span(methodNode),
      );
      this.unresolved(methodNode, method);
      return undefined;
    }
    const target: Target = {
      kind: "cap",
      id: `cap:${info.module}#${info.entry.name}.${method}`,
    };
    this.set(methodNode, target);
    return target;
  }

  /** A qualified name in `uses`, `provides`, or a pipeline stage. */
  private qualified(
    qn: NodeId,
    context: "uses" | "provides" | "stage",
  ): void {
    const names = this.kidsOfKind(qn, SyntaxKind.Name);
    if (names.length === 0) return;
    if (context === "stage" && names.length === 1) {
      const name = nameTextOf(this.tree, names[0]);
      if (name === undefined) return;
      this.valueRef(names[0], name, "callee");
      const target = this.targets.get(names[0]);
      if (target !== undefined) this.set(qn, target);
      return;
    }
    const service = this.serviceRef(names[0], context === "stage");
    let whole: Target | undefined = service?.target;
    if (names.length >= 2) {
      if (context === "provides") {
        this.report(
          "declaration/003",
          "a provider provides whole services; a method name is not allowed here",
          this.span(qn),
        );
        if (service !== undefined) this.methodRef(service, names[1]);
        whole = service?.target;
      } else if (service !== undefined) {
        whole = this.methodRef(service, names[1]) ?? undefined;
      }
    }
    for (const extra of names.slice(2)) {
      this.wrongKind(
        extra,
        nameTextOf(this.tree, extra) ?? "",
        "a qualified name has at most two parts: a service and a method",
      );
    }
    if (whole !== undefined) this.set(qn, whole);
  }

  // -------------------------------------------------------------- types and clauses

  private resolveType(node: NodeId): void {
    const kind = kindOf(this.tree, node);
    switch (kind) {
      case SyntaxKind.NamedType:
        for (const kid of this.kids(node)) {
          if (kindOf(this.tree, kid) === SyntaxKind.Name) this.typeRef(kid);
          else this.resolveType(kid);
        }
        return;
      case SyntaxKind.RecordType:
        for (const field of this.kidsOfKind(node, SyntaxKind.FieldType)) {
          for (const kid of this.kids(field)) {
            if (kindOf(this.tree, kid) === SyntaxKind.Name) {
              this.fieldLabel(kid);
            } else {
              this.resolveType(kid);
            }
          }
        }
        return;
      case SyntaxKind.FunctionType:
        for (const kid of this.kids(node)) {
          const k = kindOf(this.tree, kid);
          if (k === SyntaxKind.ParamList) this.labelParams(kid);
          else if (
            k === SyntaxKind.FailsClause || k === SyntaxKind.UsesClause
          ) {
            this.clause(kid);
          } else this.resolveType(kid);
        }
        return;
      case SyntaxKind.EffectType:
      case SyntaxKind.StreamType:
      case SyntaxKind.SinkType:
      case SyntaxKind.LayerType:
        for (const kid of this.kids(node)) {
          const k = kindOf(this.tree, kid);
          if (
            k === SyntaxKind.FailsClause || k === SyntaxKind.UsesClause ||
            k === SyntaxKind.ProvidesClause
          ) {
            this.clause(kid);
          } else this.resolveType(kid);
        }
        return;
      case SyntaxKind.TypeArgs:
      case SyntaxKind.TupleType:
      case SyntaxKind.ArrayType:
      case SyntaxKind.UnionType:
      case SyntaxKind.ParenType:
        for (const kid of this.kids(node)) this.resolveType(kid);
        return;
      default:
        return;
    }
  }

  private fieldLabel(nameNode: NodeId): void {
    const name = nameTextOf(this.tree, nameNode);
    if (name !== undefined) this.set(nameNode, { kind: "field", name });
  }

  /** Parameter names in a signature without a body are labels. Their types resolve. */
  private labelParams(paramList: NodeId): void {
    for (const param of this.kidsOfKind(paramList, SyntaxKind.Param)) {
      for (const kid of this.kids(param)) {
        if (kindOf(this.tree, kid) === SyntaxKind.Name) this.fieldLabel(kid);
        else this.resolveType(kid);
      }
    }
  }

  private clause(node: NodeId): void {
    const kind = kindOf(this.tree, node);
    if (kind === SyntaxKind.FailsClause) {
      for (const name of this.kidsOfKind(node, SyntaxKind.Name)) {
        if (nameTextOf(this.tree, name) === "never") continue;
        this.errorRef(name);
      }
    } else if (kind === SyntaxKind.UsesClause) {
      for (const qn of this.kidsOfKind(node, SyntaxKind.QualifiedName)) {
        if (nodeText(this.tree, qn) === "never") continue;
        this.qualified(qn, "uses");
      }
    } else if (kind === SyntaxKind.ProvidesClause) {
      for (const qn of this.kidsOfKind(node, SyntaxKind.QualifiedName)) {
        this.qualified(qn, "provides");
      }
    }
  }

  // -------------------------------------------------------------- declarations

  private resolveDecl(decl: DeclEntry): void {
    const node = decl.node;
    this.fn = decl.name;
    this.scope = new Scope(undefined);
    switch (decl.kind) {
      case "type":
      case "error":
        for (const kid of this.kids(node)) {
          if (kid !== decl.nameNode) this.resolveType(kid);
        }
        break;
      case "service":
        for (const method of this.kidsOfKind(node, SyntaxKind.ServiceMethod)) {
          for (const kid of this.kids(method)) {
            const k = kindOf(this.tree, kid);
            if (k === SyntaxKind.Name) continue;
            if (k === SyntaxKind.ParamList) this.labelParams(kid);
            else if (k === SyntaxKind.FailsClause) this.clause(kid);
            else this.resolveType(kid);
          }
        }
        break;
      case "provider":
        for (const kid of this.kids(node)) {
          const k = kindOf(this.tree, kid);
          if (k === SyntaxKind.Name) continue;
          this.clause(kid);
        }
        break;
      case "const":
        this.resolveConstParts(node, decl.nameNode);
        break;
    }
    this.scope = undefined;
  }

  /** The type annotation and the initializer of a top-level const. */
  private resolveConstParts(node: NodeId, nameNode: NodeId): void {
    const rest = this.kids(node).filter((k) => k !== nameNode);
    for (const kid of rest) {
      if (isTypeKind(kindOf(this.tree, kid))) this.resolveType(kid);
    }
    const init = rest[rest.length - 1];
    if (init !== undefined && !isTypeKind(kindOf(this.tree, init))) {
      this.expr(init, "value");
    }
  }

  // -------------------------------------------------------------- expressions

  private expr(node: NodeId, position: Position): void {
    const kind = kindOf(this.tree, node);
    switch (kind) {
      case SyntaxKind.NameExpr:
        this.valueRef(node, nodeText(this.tree, node), position);
        return;
      case SyntaxKind.ArrowExpr:
        this.arrow(node);
        return;
      case SyntaxKind.CallExpr: {
        const kids = this.kids(node);
        if (kids.length > 0) this.expr(kids[0], "callee");
        if (
          kids[0] !== undefined &&
          kindOf(this.tree, kids[0]) === SyntaxKind.NameExpr &&
          nodeText(this.tree, kids[0]) === "layer" &&
          kids[1] !== undefined &&
          kindOf(this.tree, kids[1]) === SyntaxKind.ArgList
        ) {
          const args = this.kids(kids[1]);
          const first = args[0];
          if (
            first !== undefined &&
            kindOf(this.tree, first) === SyntaxKind.NameExpr
          ) {
            const found = this.lookupValue(
              nodeText(this.tree, first),
              this.span(first),
            );
            if (
              found?.tag === "module" && found.binding.target.kind === "service"
            ) {
              this.set(first, found.binding.target);
            } else this.expr(first, "value");
          } else if (first !== undefined) this.expr(first, "value");
          for (const arg of args.slice(1)) this.expr(arg, "value");
          return;
        }
        for (const arg of kids.slice(1)) this.expr(arg, "value");
        return;
      }
      case SyntaxKind.FieldExpr:
        this.fieldExpr(node);
        return;
      case SyntaxKind.PipeExpr: {
        const kids = this.kids(node);
        if (kids.length > 0) this.expr(kids[0], "value");
        for (const stage of kids.slice(1)) this.pipeStage(stage);
        return;
      }
      case SyntaxKind.RecordExpr:
        for (const field of this.kids(node)) this.recordField(field);
        return;
      case SyntaxKind.Block:
        this.block(node, undefined);
        return;
      case SyntaxKind.MatchExpr: {
        const kids = this.kids(node);
        if (kids.length > 0) this.expr(kids[0], "value");
        for (const arm of kids.slice(1)) {
          if (kindOf(this.tree, arm) === SyntaxKind.MatchArm) this.arm(arm);
        }
        return;
      }
      case SyntaxKind.TryExpr:
        for (const kid of this.kids(node)) {
          if (kindOf(this.tree, kid) === SyntaxKind.CatchClause) {
            for (const h of this.kidsOfKind(kid, SyntaxKind.Handler)) {
              this.handler(h);
            }
          } else {
            this.expr(kid, "value");
          }
        }
        return;
      case SyntaxKind.ParenExpr:
      case SyntaxKind.BinaryExpr:
      case SyntaxKind.ArgList:
      case SyntaxKind.ListExpr:
      case SyntaxKind.IfExpr:
        for (const kid of this.kids(node)) this.expr(kid, "value");
        return;
      default:
        return;
    }
  }

  private fieldExpr(node: NodeId): void {
    const kids = this.kids(node);
    const base = kids[0];
    const member = kids.find((k, i) =>
      i > 0 && kindOf(this.tree, k) === SyntaxKind.Name
    );
    if (base === undefined) return;
    if (kindOf(this.tree, base) === SyntaxKind.NameExpr) {
      const baseName = nodeText(this.tree, base);
      const found = this.lookupValue(baseName, this.span(base));
      if (
        found !== undefined && found.tag === "module" &&
        found.binding.target.kind === "service"
      ) {
        this.set(base, found.binding.target);
        if (member === undefined) return;
        const cap = this.methodRef(found.binding, member);
        if (cap !== undefined) this.set(node, cap);
        else this.unresolved(node, nameTextOf(this.tree, member) ?? "");
        return;
      }
    }
    this.expr(base, "value");
    if (member !== undefined) this.fieldLabel(member);
  }

  private pipeStage(stage: NodeId): void {
    if (kindOf(this.tree, stage) !== SyntaxKind.PipeStage) return;
    for (const kid of this.kids(stage)) {
      const kind = kindOf(this.tree, kid);
      if (kind === SyntaxKind.QualifiedName) this.qualified(kid, "stage");
      else this.expr(kid, "value");
    }
  }

  private recordField(field: NodeId): void {
    const kind = kindOf(this.tree, field);
    if (kind === SyntaxKind.RecordField) {
      for (const kid of this.kids(field)) {
        if (kindOf(this.tree, kid) === SyntaxKind.Name) this.fieldLabel(kid);
        else this.expr(kid, "value");
      }
    } else if (kind === SyntaxKind.ShorthandField) {
      for (const kid of this.kids(field)) {
        if (kindOf(this.tree, kid) !== SyntaxKind.Name) continue;
        const name = nameTextOf(this.tree, kid);
        if (name !== undefined) this.valueRef(kid, name, "value");
      }
    } else if (kind === SyntaxKind.SpreadField) {
      for (const kid of this.kids(field)) this.expr(kid, "value");
    }
  }

  private arrow(node: NodeId): void {
    const outer = this.scope;
    const scope = new Scope(outer);
    this.scope = scope;
    for (const kid of this.kids(node)) {
      const kind = kindOf(this.tree, kid);
      if (kind === SyntaxKind.ParamList) {
        for (const param of this.kidsOfKind(kid, SyntaxKind.Param)) {
          for (const part of this.kids(param)) {
            if (kindOf(this.tree, part) === SyntaxKind.Name) {
              this.declareLocal(part, false);
            } else {
              this.resolveType(part);
            }
          }
        }
      } else if (
        kind === SyntaxKind.FailsClause || kind === SyntaxKind.UsesClause
      ) {
        this.clause(kid);
      } else if (isTypeKind(kind)) {
        this.resolveType(kid);
      } else if (kind === SyntaxKind.Block) {
        this.block(kid, scope);
      } else {
        this.expr(kid, "value");
      }
    }
    this.scope = outer;
  }

  /** A block. It reuses `shared` when a parameter list, pattern, or handler already opened a scope. */
  private block(node: NodeId, shared: Scope | undefined): void {
    const outer = this.scope;
    this.scope = shared ?? new Scope(outer);
    for (const item of this.kids(node)) {
      if (kindOf(this.tree, item) === SyntaxKind.ConstDecl) {
        this.blockConst(item);
      } else {
        this.expr(item, "value");
      }
    }
    this.scope = outer;
  }

  private blockConst(node: NodeId): void {
    const kids = this.kids(node);
    const nameNode = kids.find((k) => kindOf(this.tree, k) === SyntaxKind.Name);
    if (nameNode === undefined) return;
    const rest = kids.filter((k) => k !== nameNode);
    const init = rest.find((k) => !isTypeKind(kindOf(this.tree, k)));
    const isArrow = init !== undefined &&
      kindOf(this.tree, init) === SyntaxKind.ArrowExpr;
    const binding = this.declareLocal(nameNode, !isArrow);
    for (const kid of rest) {
      if (isTypeKind(kindOf(this.tree, kid))) this.resolveType(kid);
    }
    if (init !== undefined) this.expr(init, "value");
    if (binding !== undefined) binding.pending = false;
  }

  private arm(node: NodeId): void {
    const outer = this.scope;
    const scope = new Scope(outer);
    this.scope = scope;
    for (const kid of this.kids(node)) {
      const kind = kindOf(this.tree, kid);
      if (PATTERN_KINDS.has(kind)) this.pattern(kid);
      else if (kind === SyntaxKind.Block) this.block(kid, scope);
      else this.expr(kid, "value");
    }
    this.scope = outer;
  }

  private handler(node: NodeId): void {
    const outer = this.scope;
    const scope = new Scope(outer);
    this.scope = scope;
    let names = 0;
    for (const kid of this.kids(node)) {
      const kind = kindOf(this.tree, kid);
      if (kind === SyntaxKind.Name) {
        if (names === 0) this.errorRef(kid);
        else this.declareLocal(kid, false);
        names++;
      } else if (kind === SyntaxKind.Block) {
        this.block(kid, scope);
      } else {
        this.expr(kid, "value");
      }
    }
    this.scope = outer;
  }

  private pattern(node: NodeId): void {
    const kind = kindOf(this.tree, node);
    switch (kind) {
      case SyntaxKind.NamePattern:
        for (const name of this.kidsOfKind(node, SyntaxKind.Name)) {
          this.ctorRef(name);
        }
        return;
      case SyntaxKind.CtorPattern: {
        const names = this.kidsOfKind(node, SyntaxKind.Name);
        if (names.length > 0) this.ctorRef(names[0]);
        if (names.length > 1) this.declareLocal(names[1], false);
        return;
      }
      case SyntaxKind.RecordPattern:
        for (const field of this.kids(node)) {
          const fieldKind = kindOf(this.tree, field);
          if (fieldKind === SyntaxKind.PatternField) {
            for (const name of this.kidsOfKind(field, SyntaxKind.Name)) {
              this.fieldLabel(name);
            }
          } else if (fieldKind === SyntaxKind.SpreadPattern) {
            for (const name of this.kidsOfKind(field, SyntaxKind.Name)) {
              this.declareLocal(name, false);
            }
          }
        }
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------- driver

  run(): ModuleResolution {
    this.bindImports();
    for (const decl of this.info.index.decls) this.resolveDecl(decl);
    return {
      module: this.name,
      targets: this.targets,
      locals: this.locals,
      namespace: this.namespace,
      diagnostics: normalizeDiagnostics(this.diagnostics),
    };
  }
}

/** Resolves every name of one module of the project. */
export function resolveModule(
  project: Project,
  info: ModuleInfo,
): ModuleResolution {
  return new Resolver(info, project).run();
}

/** Resolves every module of the project. The map follows the topological order. */
export function resolveProject(
  project: Project,
): ReadonlyMap<string, ModuleResolution> {
  const result = new Map<string, ModuleResolution>();
  for (const name of project.order) {
    const info = project.modules.get(name);
    if (info !== undefined) result.set(name, resolveModule(project, info));
  }
  return result;
}

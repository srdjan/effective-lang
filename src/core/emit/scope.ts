// The naming state of one emitted module (plan sections 5.3 and 5.6): the names
// that the module owns, the names that the emitter generates, the imports that
// the module must print, and the host registry.

import type {
  CapabilityId,
  Declaration,
  DeclarationId,
  ErrorDecl,
  LocalId,
  ModuleIR,
  ServiceDecl,
  ServiceId,
  Span,
  Type,
  TypeDecl,
} from "../ir.ts";
import {
  methodOfCapability as coreMethodOfCapability,
  moduleOfId as coreModuleOfId,
  nameOfId as coreNameOfId,
} from "../ids.ts";
import { normalizeRelative, type ProjectConfig } from "../project.ts";
import { collectBinderNames } from "./walk.ts";

/** The imports from the `effect` package. */
export type EffectModule =
  | "Effect"
  | "Context"
  | "Layer"
  | "Option"
  | "Schema"
  | "Stream"
  | "Sink"
  | "Ref";

export type EmitFailureData =
  | {
    readonly tag: "unsupported";
    readonly message: string;
    readonly span?: Span;
  }
  | { readonly tag: "internal"; readonly message: string };

/** Thrown inside the emitter only. `emitModule` turns it into an `EmitError`. */
export class EmitFailure extends Error {
  constructor(readonly failure: EmitFailureData) {
    super(failure.message);
  }
}

export function internal(message: string): EmitFailure {
  return new EmitFailure({ tag: "internal", message });
}

export function unsupported(message: string, span?: Span): EmitFailure {
  return new EmitFailure(
    span === undefined
      ? { tag: "unsupported", message }
      : { tag: "unsupported", message, span },
  );
}

// ------------------------------------------------------------------ identities

/** The module part of an identity such as `type:users#User`. */
export function moduleOfId(id: string): string {
  const module = coreModuleOfId(id);
  if (module === undefined) throw internal(`malformed identity ${id}`);
  return module;
}

/** The declared name in an identity such as `type:users#User`. */
export function nameOfId(id: string): string {
  const name = coreNameOfId(id);
  if (name === undefined) throw internal(`malformed identity ${id}`);
  return name;
}

/** The text after the colon: the tag, service key, or brand token of the emitted code. */
export function tokenOfId(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

export function serviceOfCapability(capability: CapabilityId): ServiceId {
  const hash = capability.indexOf("#");
  const dot = capability.indexOf(".", hash);
  if (hash < 0 || dot < 0) {
    throw internal(`malformed capability ${capability}`);
  }
  return `service:${capability.slice(4, dot)}`;
}

export function methodOfCapability(capability: CapabilityId): string {
  const method = coreMethodOfCapability(capability);
  if (method === undefined) {
    throw internal(`malformed capability ${capability}`);
  }
  return method;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order of `deno fmt` for named imports: case-insensitive, then by code unit. */
export function compareImportNames(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}

/** Service identities of a capability list, sorted and unique. */
export function servicesOf(
  capabilities: readonly CapabilityId[],
): ServiceId[] {
  return [...new Set(capabilities.map(serviceOfCapability))].sort(compareText);
}

// ------------------------------------------------------------------ paths

function directoryOf(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/** The import specifier from one root-relative file to another. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  const from = directoryOf(fromFile);
  const to = toFile.split("/");
  let common = 0;
  while (
    common < from.length && common < to.length - 1 &&
    from[common] === to[common]
  ) {
    common += 1;
  }
  const ups = from.length - common;
  const rest = to.slice(common).join("/");
  return ups === 0 ? `./${rest}` : `${"../".repeat(ups)}${rest}`;
}

// ------------------------------------------------------------------ the scope

export interface HostBinding {
  /** The registry key: `providers` for `host:providers`. */
  readonly key: string;
  /** The name that the host module exports. */
  readonly exported: string;
  /** The name that the Effective source binds. */
  readonly local: string;
  /** The name of the assertion constant: `UsersLive$host`. */
  readonly hostName: string;
  readonly specifier: string;
}

interface ImportedName {
  readonly local: string;
  readonly typeOnly: boolean;
}

export interface ImportGroup {
  readonly specifier: string;
  readonly names: readonly {
    readonly exported: string;
    readonly local: string;
    readonly typeOnly: boolean;
  }[];
}

export class Scope {
  readonly module: string;
  /** The path of the generated file, relative to the project root. */
  readonly path: string;
  /** Every name in use: declarations, imports, locals, and allocated names. */
  private readonly taken = new Set<string>();
  /** Names of local binders by identity. */
  readonly locals = new Map<LocalId, string>();
  private readonly localDecls = new Map<DeclarationId, Declaration>();
  private readonly foreignDecls = new Map<
    DeclarationId,
    TypeDecl | ErrorDecl | ServiceDecl
  >();
  /** Names that the Effective source binds in its imports. */
  private readonly bound = new Map<DeclarationId, string>();
  /** Names that the emitter allocated for foreign declarations. */
  private readonly allocated = new Map<DeclarationId, string>();
  private readonly foreignImports = new Map<
    string,
    Map<string, ImportedName>
  >();
  readonly hosts = new Map<DeclarationId, HostBinding>();
  private readonly effectAliases = new Map<EffectModule, string>();
  private intHelper: string | undefined;
  private intSchema: string | undefined;
  private serviceName: string | undefined;
  private temporaries = 0;
  private declarationTemporaries: string[] = [];
  private readonly typeOnlyMemo = new Map<DeclarationId, boolean>();

  constructor(readonly ir: ModuleIR, readonly config: ProjectConfig) {
    this.module = ir.module;
    this.path = `${ir.module}.ts`;
    for (const declaration of ir.declarations) {
      this.localDecls.set(declaration.id, declaration);
      this.taken.add(declaration.name);
      collectBinderNames(declaration, (id, name) => {
        this.locals.set(id, name);
        this.taken.add(name);
      });
    }
    for (const imported of ir.imports) {
      for (const t of imported.types) this.foreignDecls.set(t.id, t);
      for (const e of imported.errors) this.foreignDecls.set(e.id, e);
      for (const s of imported.services) this.foreignDecls.set(s.id, s);
    }
    for (const imported of ir.imports) {
      if (imported.module === "effective:prelude") continue;
      for (const binding of imported.bindings) {
        this.taken.add(binding.name);
      }
    }
    for (const imported of ir.imports) {
      if (imported.module === "effective:prelude") continue;
      if (imported.module.startsWith("host:")) {
        this.bindHost(imported.module, imported.bindings);
        continue;
      }
      for (const binding of imported.bindings) {
        this.bound.set(binding.target, binding.name);
        this.addImport(
          moduleOfId(binding.target),
          nameOfId(binding.target),
          binding.name,
          this.isTypeOnly(binding.target),
        );
      }
    }
  }

  private bindHost(
    label: string,
    bindings: readonly {
      readonly name: string;
      readonly target: DeclarationId;
    }[],
  ): void {
    const key = label.slice("host:".length);
    const host = this.config.host.get(key);
    if (host === undefined) {
      throw unsupported(`the host module ${label} is not in the project file`);
    }
    const target = normalizeRelative(host.modulePath);
    if (target === undefined) {
      throw unsupported(`the host module path ${host.modulePath} is not valid`);
    }
    const specifier = relativeSpecifier(this.path, target);
    for (const binding of bindings) {
      if (!binding.target.startsWith("value:")) continue;
      this.hosts.set(binding.target, {
        key,
        exported: nameOfId(binding.target),
        local: binding.name,
        hostName: this.fresh(`${binding.name}$host`),
        specifier,
      });
    }
  }

  // -------------------------------------------------------------- allocation

  /** Reserves `base`, or `base$1`, `base$2`, ... when the name is taken. */
  fresh(base: string): string {
    let candidate = base;
    let n = 0;
    while (this.taken.has(candidate)) {
      n += 1;
      candidate = `${base}$${n}`;
    }
    this.taken.add(candidate);
    return candidate;
  }

  /** The next temporary `$t<n>`. The counter restarts for each top-level declaration. */
  temp(): string {
    for (;;) {
      const candidate = `$t${this.temporaries}`;
      this.temporaries += 1;
      if (!this.taken.has(candidate)) {
        this.taken.add(candidate);
        this.declarationTemporaries.push(candidate);
        return candidate;
      }
    }
  }

  /** Starts a top-level declaration: its temporaries count from `$t0` again. */
  resetTemporaries(): void {
    for (const name of this.declarationTemporaries) this.taken.delete(name);
    this.declarationTemporaries = [];
    this.temporaries = 0;
  }

  /** The name that an import from `effect` has in this module. */
  effect(module: EffectModule): string {
    let alias = this.effectAliases.get(module);
    if (alias === undefined) {
      alias = this.fresh(module);
      this.effectAliases.set(module, alias);
    }
    return alias;
  }

  /** The `int` helper function `$int`. */
  intFunction(): string {
    this.intHelper ??= this.fresh("$int");
    return this.intHelper;
  }

  /** The `int` schema `$Int`. */
  intSchemaName(): string {
    this.intSchema ??= this.fresh("$Int");
    return this.intSchema;
  }

  /** The service parameter `$s` of a `perform`. */
  serviceParameter(): string {
    this.serviceName ??= this.fresh("$s");
    return this.serviceName;
  }

  usesIntFunction(): boolean {
    return this.intHelper !== undefined;
  }

  usesIntSchema(): boolean {
    return this.intSchema !== undefined;
  }

  // -------------------------------------------------------------- declarations

  /** A type, error, or service declaration of this module or of an import. */
  typeLevelDeclaration(
    id: DeclarationId,
  ): TypeDecl | ErrorDecl | ServiceDecl | undefined {
    const local = this.localDecls.get(id);
    if (local !== undefined) {
      return local.kind === "type" || local.kind === "error" ||
          local.kind === "service"
        ? local
        : undefined;
    }
    return this.foreignDecls.get(id);
  }

  /**
   * True when the declaration has no runtime value: an alias whose definition
   * contains a function or provider type, directly or through another alias.
   */
  isTypeOnly(id: DeclarationId): boolean {
    const known = this.typeOnlyMemo.get(id);
    if (known !== undefined) return known;
    this.typeOnlyMemo.set(id, false);
    const declaration = this.typeLevelDeclaration(id);
    let result = false;
    if (
      declaration?.kind === "type" && declaration.definition.kind === "alias"
    ) {
      result = this.containsFunction(declaration.definition.type);
    }
    this.typeOnlyMemo.set(id, result);
    return result;
  }

  /** Follows type aliases until a type that is not a name. A brand and an unknown name stay. */
  resolve(type: Type): Type {
    let current = type;
    for (let depth = 0; depth < 64 && current.kind === "named"; depth++) {
      const declaration = this.typeLevelDeclaration(current.id);
      if (
        declaration?.kind !== "type" || declaration.definition.kind !== "alias"
      ) {
        return current;
      }
      current = declaration.definition.type;
    }
    return current;
  }

  containsFunction(type: Type): boolean {
    switch (type.kind) {
      case "function":
      case "effect":
      case "stream":
      case "sink":
      case "provider":
      case "ref":
        return true;
      case "primitive":
      case "literal":
        return false;
      case "named":
        return this.isTypeOnly(type.id);
      case "record":
        return type.fields.some((f) => this.containsFunction(f.type));
      case "array":
      case "option":
        return this.containsFunction(type.element);
      case "tuple":
        return type.elements.some((t) => this.containsFunction(t));
      case "union":
        return type.members.some((t) => this.containsFunction(t));
    }
  }

  /** The name that this module uses for a declaration. A foreign declaration is imported on first use. */
  nameOf(id: DeclarationId): string {
    const local = this.localDecls.get(id);
    if (local !== undefined) return local.name;
    const bound = this.bound.get(id);
    if (bound !== undefined) return bound;
    const allocated = this.allocated.get(id);
    if (allocated !== undefined) return allocated;
    const exported = nameOfId(id);
    const name = this.fresh(exported);
    this.allocated.set(id, name);
    this.addImport(moduleOfId(id), exported, name, this.isTypeOnly(id));
    return name;
  }

  hostBinding(id: DeclarationId): HostBinding | undefined {
    return this.hosts.get(id);
  }

  private addImport(
    module: string,
    exported: string,
    local: string,
    typeOnly: boolean,
  ): void {
    let names = this.foreignImports.get(module);
    if (names === undefined) {
      names = new Map();
      this.foreignImports.set(module, names);
    }
    names.set(exported, { local, typeOnly });
  }

  /** Imports of other generated modules, sorted by specifier. */
  moduleImports(): ImportGroup[] {
    const groups: ImportGroup[] = [];
    for (const [module, names] of this.foreignImports) {
      groups.push({
        specifier: relativeSpecifier(this.path, `${module}.ts`),
        names: [...names].map(([exported, imported]) => ({
          exported,
          local: imported.local,
          typeOnly: imported.typeOnly,
        })).sort((a, b) => compareImportNames(a.exported, b.exported)),
      });
    }
    return groups.sort((a, b) => compareText(a.specifier, b.specifier));
  }

  /** The imports from `effect` that the module used, sorted by exported name. */
  effectImports(): { readonly exported: string; readonly local: string }[] {
    return [...this.effectAliases]
      .map(([exported, local]) => ({ exported, local }))
      .sort((a, b) => compareImportNames(a.exported, b.exported));
  }

  /** The host imports in registry order of first appearance, sorted by specifier. */
  hostImports(): ImportGroup[] {
    const bySpecifier = new Map<string, string[]>();
    for (const host of this.hosts.values()) {
      const names = bySpecifier.get(host.specifier) ?? [];
      names.push(`${host.exported}\u0000${host.local}`);
      bySpecifier.set(host.specifier, names);
    }
    return [...bySpecifier].map(([specifier, names]) => ({
      specifier,
      names: names.sort(compareImportNames).map((n) => {
        const [exported, local] = n.split("\u0000");
        return { exported, local, typeOnly: false };
      }),
    })).sort((a, b) => compareText(a.specifier, b.specifier));
  }
}

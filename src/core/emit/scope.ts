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
import { SCOPE_CAPABILITY } from "../ir.ts";
import {
  methodOfCapability as coreMethodOfCapability,
  moduleOfId as coreModuleOfId,
  nameOfId as coreNameOfId,
  serviceOfCapability as coreServiceOfCapability,
} from "../ids.ts";
import {
  generatedPathOf,
  moduleNameOf,
  normalizeRelative,
  type ProjectConfig,
} from "../project.ts";
import { compareText } from "../util.ts";
import { collectBinderNames } from "./walk.ts";

/** The imports from the `effect` package. */
export type EffectModule =
  | "Effect"
  | "Context"
  | "Layer"
  | "Option"
  | "Schema"
  | "SchemaIssue"
  | "SchemaGetter"
  | "SchemaTransformation"
  | "Stream"
  | "Sink"
  | "Ref"
  | "Schedule"
  | "Duration"
  | "Cause"
  | "Fiber"
  | "Deferred"
  | "Exit"
  | "Scope";

interface ScopeRuntimeNames {
  readonly type: string;
  readonly make: string;
  readonly provide: string;
  readonly register: string;
  readonly close: string;
}

type EmitFailureData =
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

// ------------------------------------------------------------------ deferred types

/**
 * The Type kinds that have no schema and no runtime value: functions and the
 * effectful or handle types. The type printers throw for them, and an alias
 * that contains one is type-only.
 */
type DeferredKind =
  | "function"
  | "effect"
  | "stream"
  | "sink"
  | "schedule"
  | "provider"
  | "ref"
  | "retry-schedule"
  | "codec"
  | "schema"
  | "closeable-scope"
  | "fiber";

type DeferredType = Extract<Type, { readonly kind: DeferredKind }>;

const DEFERRED_KINDS = {
  "function": true,
  "effect": true,
  "stream": true,
  "sink": true,
  "schedule": true,
  "provider": true,
  "ref": true,
  "retry-schedule": true,
  "codec": true,
  "schema": true,
  "closeable-scope": true,
  "fiber": true,
} as const satisfies Record<DeferredKind, true>;

/**
 * True for a deferred Type kind. After this guard fails, a switch over the
 * rest of the kinds is exhaustive, so a new kind is a compile error there.
 */
export function isDeferredType(type: Type): type is DeferredType {
  return Object.hasOwn(DEFERRED_KINDS, type.kind);
}

/** True when `type` has the kind `kind`. */
function hasKind<K extends Type["kind"]>(
  type: Type,
  kind: K,
): type is Extract<Type, { readonly kind: K }> {
  return type.kind === kind;
}

/** `type` after `resolve`, when it has `kind`. Else an internal failure with `message`. */
export function resolvedAs<K extends Type["kind"]>(
  scope: TypeLookup,
  type: Type,
  kind: K,
  message: string,
): Extract<Type, { readonly kind: K }> {
  const resolved = scope.resolve(type);
  if (!hasKind(resolved, kind)) throw internal(message);
  return resolved;
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
  const service = coreServiceOfCapability(capability);
  if (service === undefined) {
    throw internal(`malformed capability ${capability}`);
  }
  return service;
}

export function methodOfCapability(capability: CapabilityId): string {
  const method = coreMethodOfCapability(capability);
  if (method === undefined) {
    throw internal(`malformed capability ${capability}`);
  }
  return method;
}

/** The order of `deno fmt` for named imports: case-insensitive, then by code unit. */
function compareImportNames(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}

/** Service identities of a capability list, sorted and unique. */
export function servicesOf(
  capabilities: readonly CapabilityId[],
): ServiceId[] {
  return [
    ...new Set(
      capabilities.filter((id) => id !== SCOPE_CAPABILITY).map(
        serviceOfCapability,
      ),
    ),
  ].sort(compareText);
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

interface HostBinding {
  /** The registry key: `providers` for `host:providers`. */
  readonly key: string;
  /** The name that the host module exports. */
  readonly exported: string;
  /** The name that the Effektive source binds. */
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

/** Names for the emitted module. Each member records the name on first use. */
export interface EmitNames {
  effect(module: EffectModule): string;
  nameOf(id: DeclarationId): string;
  encodedMirrorName(id: DeclarationId): string;
  intSchemaName(): string;
  intFunction(): string;
  unmatched(): string;
  hostCheck(): string;
  scopeRuntime(): ScopeRuntimeNames;
  serviceParameter(): string;
  fieldHelper(key: string): string;
}

export interface Temporaries {
  fresh(base: string): string;
  temp(): string;
}

/** Reads of the module IR and the config. No member records anything. */
export interface TypeLookup {
  resolve(type: Type): Type;
  typeLevelDeclaration(
    id: DeclarationId,
  ): TypeDecl | ErrorDecl | ServiceDecl | undefined;
}

/** What `emit.ts` reads after all printing. */
export interface ImportLedger {
  moduleImports(): ImportGroup[];
  effectImports(): { readonly exported: string; readonly local: string }[];
  hostImports(): ImportGroup[];
  usesIntFunction(): boolean;
  usesUnmatched(): boolean;
  usesHostCheck(): boolean;
  usesIntSchema(): boolean;
  usesScopeRuntime(): boolean;
}

/**
 * What the expression emitter, the type printers, and the field adapters read.
 * It has no import ledger and no `resetTemporaries`.
 */
export type ExprScope =
  & EmitNames
  & Temporaries
  & TypeLookup
  & Pick<Scope, "locals" | "hostBinding" | "fieldAdapters" | "fieldHelpers">;

export class Scope implements EmitNames, Temporaries, TypeLookup, ImportLedger {
  readonly module: string;
  /** The source file of the module, as its header names it. */
  readonly source: string;
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
  /** Names that the Effektive source binds in its imports. */
  private readonly bound = new Map<DeclarationId, string>();
  /** The import of each bound name that a companion module has not used yet. */
  private readonly unusedImports = new Map<DeclarationId, () => void>();
  /** Names that the emitter allocated for foreign declarations. */
  private readonly allocated = new Map<DeclarationId, string>();
  private readonly foreignImports = new Map<
    string,
    Map<string, ImportedName>
  >();
  readonly hosts = new Map<DeclarationId, HostBinding>();
  private readonly hostDeclarations = new Map<
    string,
    Map<string, ImportedName>
  >();
  private readonly effectAliases = new Map<EffectModule, string>();
  readonly fieldHelpers = new Map<string, string>();
  readonly fieldAdapters = new Map<
    string,
    {
      readonly name: string;
      readonly type: Type;
      readonly direction: "decoded" | "encoded" | "make";
    }
  >();

  fieldHelper(key: string): string {
    let name = this.fieldHelpers.get(key);
    if (name === undefined) {
      name = this.fresh(`$${key}`);
      this.fieldHelpers.set(key, name);
    }
    return name;
  }

  private intHelper: string | undefined;
  private unmatchedHelper: string | undefined;
  private hostCheckHelper: string | undefined;
  private intSchema: string | undefined;
  private serviceName: string | undefined;
  private scopeRuntimeNames: ScopeRuntimeNames | undefined;
  private temporaries = 0;
  private declarationTemporaries: string[] = [];
  private readonly typeOnlyMemo = new Map<DeclarationId, boolean>();
  private readonly encodedMirrors = new Map<DeclarationId, string>();

  constructor(readonly ir: ModuleIR, readonly config: ProjectConfig) {
    this.module = ir.module;
    this.source = ir.sources[0] ?? `${ir.module}.eff`;
    this.path = generatedPathOf(this.source);
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
      if (imported.module === "effektive:prelude") continue;
      for (const binding of imported.bindings) {
        this.taken.add(binding.name);
      }
    }
    for (const imported of ir.imports) {
      if (imported.module === "effektive:prelude") continue;
      if (imported.module.startsWith("host:")) {
        this.bindHost(imported.module, imported.bindings);
        continue;
      }
      for (const binding of imported.bindings) {
        this.bound.set(binding.target, binding.name);
        const use = () =>
          this.addImport(
            moduleOfId(binding.target),
            nameOfId(binding.target),
            binding.name,
            this.isTypeOnly(binding.target),
          );
        // A companion module prints only the imports that its declarations use.
        if (this.source.endsWith(".effi")) {
          this.unusedImports.set(binding.target, use);
        } else use();
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
      if (binding.target.startsWith("value:")) {
        this.hosts.set(binding.target, {
          key,
          exported: nameOfId(binding.target),
          local: binding.name,
          hostName: this.fresh(`${binding.name}$host`),
          specifier,
        });
      } else {
        this.bound.set(binding.target, binding.name);
        const declaration = this.typeLevelDeclaration(binding.target);
        if (declaration?.kind === "type" && declaration.opaque === true) {
          const names = this.hostDeclarations.get(specifier) ??
            new Map<string, ImportedName>();
          names.set(nameOfId(binding.target), {
            local: binding.name,
            typeOnly: true,
          });
          this.hostDeclarations.set(specifier, names);
        } else {
          // The companion module of the interface owns every other declaration.
          this.addImport(
            moduleOfId(binding.target),
            nameOfId(binding.target),
            binding.name,
            this.isTypeOnly(binding.target),
          );
        }
      }
    }
  }

  /**
   * An opaque type of an interface module lives in its host module, not in the
   * companion module: import it from there.
   */
  private importOpaque(module: string, exported: string, local: string): void {
    for (const host of this.config.host.values()) {
      const iface = normalizeRelative(host.interfacePath);
      if (iface === undefined || moduleNameOf(iface) !== module) continue;
      const target = normalizeRelative(host.modulePath);
      if (target === undefined) break;
      const specifier = relativeSpecifier(this.path, target);
      const names = this.hostDeclarations.get(specifier) ??
        new Map<string, ImportedName>();
      names.set(exported, { local, typeOnly: true });
      this.hostDeclarations.set(specifier, names);
      return;
    }
    throw unsupported(`the interface ${module} has no host module`);
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

  /** The name of the generated encoded type of a recursive alias: `NodeEncoded`. */
  encodedMirrorName(id: DeclarationId): string {
    let name = this.encodedMirrors.get(id);
    if (name === undefined) {
      name = this.fresh(`${this.nameOf(id)}Encoded`);
      this.encodedMirrors.set(id, name);
    }
    return name;
  }

  /** The `int` helper function `$int`. */
  intFunction(): string {
    this.intHelper ??= this.fresh("$int");
    return this.intHelper;
  }

  /** The helper `$unmatched` that a match calls for a value outside its type. */
  unmatched(): string {
    this.unmatchedHelper ??= this.fresh("$unmatched");
    return this.unmatchedHelper;
  }

  /** The helper `$hostCheck` that a wrapped host provider calls for a data result. */
  hostCheck(): string {
    this.hostCheckHelper ??= this.fresh("$hostCheck");
    return this.hostCheckHelper;
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

  usesUnmatched(): boolean {
    return this.unmatchedHelper !== undefined;
  }

  usesHostCheck(): boolean {
    return this.hostCheckHelper !== undefined;
  }

  usesIntSchema(): boolean {
    return this.intSchema !== undefined;
  }

  scopeRuntime(): ScopeRuntimeNames {
    this.scopeRuntimeNames ??= {
      type: this.fresh("$CloseableScope"),
      make: this.fresh("$makeScope"),
      provide: this.fresh("$provideScope"),
      register: this.fresh("$addScopeFinalizer"),
      close: this.fresh("$closeScope"),
    };
    return this.scopeRuntimeNames;
  }

  usesScopeRuntime(): boolean {
    return this.scopeRuntimeNames !== undefined;
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
   * True when the declaration has no runtime value: an opaque type, or an alias
   * whose definition contains a function, provider, or opaque type, directly or
   * through another alias.
   */
  isTypeOnly(id: DeclarationId): boolean {
    const known = this.typeOnlyMemo.get(id);
    if (known !== undefined) return known;
    this.typeOnlyMemo.set(id, false);
    const declaration = this.typeLevelDeclaration(id);
    let result = false;
    if (declaration?.kind === "type" && declaration.opaque === true) {
      // The host module declares an opaque type as a type: it has no value.
      result = true;
    } else if (
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
    const seen = new Set<DeclarationId>();
    while (current.kind === "named" && !seen.has(current.id)) {
      seen.add(current.id);
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
    if (isDeferredType(type)) return true;
    switch (type.kind) {
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
    if (id === "error:effect/SchemaError") {
      return `${this.effect("Schema")}.SchemaError`;
    }
    if (id === "error:effect/SchemaIssue") {
      return `${this.effect("SchemaIssue")}.Issue`;
    }
    const local = this.localDecls.get(id);
    if (local !== undefined) {
      if (local.kind === "type" && local.opaque === true) {
        this.importOpaque(this.module, local.name, local.name);
      }
      return local.name;
    }
    const bound = this.bound.get(id);
    if (bound !== undefined) {
      this.unusedImports.get(id)?.();
      this.unusedImports.delete(id);
      return bound;
    }
    const allocated = this.allocated.get(id);
    if (allocated !== undefined) return allocated;
    const exported = nameOfId(id);
    const name = this.fresh(exported);
    this.allocated.set(id, name);
    const foreign = this.typeLevelDeclaration(id);
    if (foreign?.kind === "type" && foreign.opaque === true) {
      this.importOpaque(moduleOfId(id), exported, name);
    } else {
      this.addImport(moduleOfId(id), exported, name, this.isTypeOnly(id));
    }
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

  /** The companion module path of each host interface module, by module name. */
  private companionPaths(): Map<string, string> {
    const paths = new Map<string, string>();
    for (const host of this.config.host.values()) {
      const path = normalizeRelative(host.interfacePath);
      if (path !== undefined) {
        paths.set(moduleNameOf(path), generatedPathOf(path));
      }
    }
    return paths;
  }

  /** Imports of other generated modules, sorted by specifier. */
  moduleImports(): ImportGroup[] {
    const groups: ImportGroup[] = [];
    const companions = this.companionPaths();
    for (const [module, names] of this.foreignImports) {
      groups.push({
        specifier: relativeSpecifier(
          this.path,
          companions.get(module) ?? `${module}.ts`,
        ),
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
    const bySpecifier = new Map<string, Map<string, ImportedName>>();
    for (const [specifier, names] of this.hostDeclarations) {
      bySpecifier.set(specifier, new Map(names));
    }
    for (const host of this.hosts.values()) {
      const names = bySpecifier.get(host.specifier) ??
        new Map<string, ImportedName>();
      names.set(host.exported, { local: host.local, typeOnly: false });
      bySpecifier.set(host.specifier, names);
    }
    return [...bySpecifier].map(([specifier, names]) => ({
      specifier,
      names: [...names].sort((a, b) => compareImportNames(a[0], b[0])).map((
        [exported, entry],
      ) => ({ exported, local: entry.local, typeOnly: entry.typeOnly })),
    })).sort((a, b) => compareText(a.specifier, b.specifier));
  }
}

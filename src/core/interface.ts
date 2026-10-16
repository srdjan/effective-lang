// Module interfaces. An interface is the `Import` payload of the IR without
// `module` and `bindings`: the exports, the types of the exported values, and
// the declarations that those exports reach (design I8). Imported declarations
// are not repeated here; they stay in the interface of their own module.
//
// The interface hash covers the content without source spans, so a comment or a
// body edit that moves a declaration does not change it. The hash is FNV-1a 64
// over canonical JSON. A later part may switch to SHA-256.
//
// The project driver `checkDeclarations` also lives here. It runs the module
// checker in topological order and gives each module the type graphs of the
// modules that it reaches.

import type { Analysis } from "./analyze.ts";
import {
  checkModuleDeclarations,
  effectIds,
  type FunctionSignature,
  isPendingMode,
  type ModeMap,
  type ModuleDeclarations,
  referencedIds,
  signatureType,
  type TypeGraph,
} from "./check.ts";
import { type Diagnostic, normalizeDiagnostics } from "./diagnostics.ts";
import { fnv1a64 } from "./hash.ts";
import type {
  DeclarationId,
  ErrorDecl,
  Import,
  ServiceDecl,
  Type,
  TypeDecl,
  ValueId,
} from "./ir.ts";
import type { Result } from "./source.ts";
import { canonicalJson, TypeTable } from "./types.ts";

/** The `Import` payload without `module` and `bindings`. */
export type InterfacePayload = Pick<
  Import,
  "exports" | "values" | "types" | "errors" | "services"
>;

export interface ModuleInterface {
  readonly module: string;
  readonly payload: InterfacePayload;
  /** FNV-1a 64 of the canonical JSON of the payload without spans. */
  readonly hash: string;
}

export type InterfaceError = {
  readonly tag: "missing-modes";
  /** Explicit functions with empty sets and no entry in the mode map, sorted. */
  readonly ids: readonly ValueId[];
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareText(a.id, b.id));
}

/** Removes every `span` key. A span depends on the position of the text, not on its meaning. */
export function stripSpans(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripSpans(item));
  const result: Record<string, unknown> = {};
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (key === "span") continue;
    result[key] = stripSpans(record[key]);
  }
  return result;
}

/** The hash of an interface payload. */
export function interfaceHash(payload: InterfacePayload): string {
  return fnv1a64(canonicalJson(stripSpans(payload)));
}

/** The identities that the exported values mention in their types and effect sets. */
function exportedValueIds(declarations: ModuleDeclarations): Set<string> {
  const ids = new Set<string>();
  for (const signature of declarations.values.values()) {
    if (!signature.exported) continue;
    switch (signature.kind) {
      case "function":
        if (signature.contract !== "explicit") break;
        for (const parameter of signature.parameters) {
          referencedIds(parameter.type.ir, ids);
        }
        if (signature.result !== undefined) {
          referencedIds(signature.result.ir, ids);
        }
        effectIds(signature.failures, signature.requirements, ids);
        break;
      case "constant":
        if (signature.type !== undefined) referencedIds(signature.type.ir, ids);
        break;
      case "provider":
        referencedIds(signature.type.ir, ids);
        break;
    }
  }
  return ids;
}

/**
 * The type graph that the exports of a module reach: the exported types, errors,
 * and services, and every private declaration of this module that they reach
 * through types, failures, and capabilities. The graph does not depend on modes.
 */
export function buildTypeGraph(declarations: ModuleDeclarations): TypeGraph {
  const typeById = new Map<string, TypeDecl>(
    declarations.types.map((d) => [d.id, d]),
  );
  const errorById = new Map<string, ErrorDecl>(
    declarations.errors.map((d) => [d.id, d]),
  );
  const serviceById = new Map<string, ServiceDecl>(
    declarations.services.map((d) => [d.id, d]),
  );
  const reached = new Set<string>();
  const pending: string[] = [];
  const add = (id: string): void => {
    if (reached.has(id)) return;
    if (!typeById.has(id) && !errorById.has(id) && !serviceById.has(id)) return;
    reached.add(id);
    pending.push(id);
  };

  for (const id of declarations.exports) add(id);
  for (const id of exportedValueIds(declarations)) add(id);

  while (pending.length > 0) {
    const id = pending.pop()!;
    const found = new Set<string>();
    const type = typeById.get(id);
    const error = errorById.get(id);
    const service = serviceById.get(id);
    if (type !== undefined) {
      referencedIds(
        type.definition.kind === "alias"
          ? type.definition.type
          : type.definition.base,
        found,
      );
    } else if (error !== undefined) {
      for (const field of error.fields) referencedIds(field.type, found);
    } else if (service !== undefined) {
      for (const method of service.methods) referencedIds(method.type, found);
    }
    for (const next of found) add(next);
  }

  return {
    types: byId(declarations.types.filter((d) => reached.has(d.id))),
    errors: byId(declarations.errors.filter((d) => reached.has(d.id))),
    services: byId(declarations.services.filter((d) => reached.has(d.id))),
  };
}

/**
 * Builds the interface of a module. Every explicit function whose sets are empty
 * needs an entry in `modes`. Without it the result is an error value, because the
 * hash would otherwise hide a pending mode.
 */
export function buildInterface(
  declarations: ModuleDeclarations,
  modes: ModeMap,
): Result<ModuleInterface, InterfaceError> {
  const functions: FunctionSignature[] = [];
  for (const signature of declarations.values.values()) {
    if (signature.kind === "function") functions.push(signature);
  }
  const missing = functions
    .filter((f) => isPendingMode(f) && !modes.has(f.id))
    .map((f) => f.id)
    .sort(compareText);
  if (missing.length > 0) {
    return { ok: false, error: { tag: "missing-modes", ids: missing } };
  }

  const values: { id: ValueId; name: string; type: Type }[] = [];
  for (const signature of declarations.values.values()) {
    if (!signature.exported) continue;
    switch (signature.kind) {
      case "function": {
        if (signature.contract !== "explicit") break;
        const type = signatureType(declarations.env.table, signature, modes);
        // Every explicit function passed the check above, so this cannot fail.
        if (!type.ok) break;
        values.push({
          id: signature.id,
          name: signature.name,
          type: type.value.ir,
        });
        break;
      }
      case "constant":
        if (signature.type !== undefined) {
          values.push({
            id: signature.id,
            name: signature.name,
            type: signature.type.ir,
          });
        }
        break;
      case "provider":
        values.push({
          id: signature.id,
          name: signature.name,
          type: signature.type.ir,
        });
        break;
    }
  }
  const graph = buildTypeGraph(declarations);
  const payload: InterfacePayload = {
    exports: declarations.exports as readonly DeclarationId[],
    values: byId(values),
    types: graph.types,
    errors: graph.errors,
    services: graph.services,
  };
  return {
    ok: true,
    value: {
      module: declarations.module,
      payload,
      hash: interfaceHash(payload),
    },
  };
}

// ------------------------------------------------------------------ the project driver

export interface ModuleCheck {
  readonly module: string;
  readonly declarations: ModuleDeclarations;
  /** An error value when the mode map lacks an entry that the hash needs. */
  readonly interface: Result<ModuleInterface, InterfaceError>;
  /** Declaration diagnostics of this module, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectCheck {
  /** The one intern table of the project. */
  readonly table: TypeTable;
  /** Per module, in topological order. */
  readonly modules: ReadonlyMap<string, ModuleCheck>;
  /** The diagnostics of the analysis and of every declaration check, sorted without duplicates. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The names of the modules that `module` reaches through imports, directly or not. */
function reachableModules(analysis: Analysis, module: string): string[] {
  const seen = new Set<string>();
  const stack = [...(analysis.project.graph.get(module) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(analysis.project.graph.get(next) ?? []));
  }
  seen.delete(module);
  return [...seen].sort(compareText);
}

/**
 * Checks the declarations of every module in topological order. A module sees
 * the type graphs of the modules that it reaches, not their syntax. The mode map
 * supplies the execution mode of functions whose sets are empty; without an
 * entry, the interface of the module is an error value. The diagnostics do not
 * depend on the mode map.
 */
export function checkDeclarations(
  analysis: Analysis,
  modes: ModeMap = new Map(),
): ProjectCheck {
  const table = new TypeTable();
  const graphs = new Map<string, TypeGraph>();
  const modules = new Map<string, ModuleCheck>();
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];
  for (const name of analysis.project.order) {
    const imported = new Map<string, TypeGraph>();
    for (const other of reachableModules(analysis, name)) {
      const graph = graphs.get(other);
      if (graph !== undefined) imported.set(other, graph);
    }
    const declarations = checkModuleDeclarations(
      analysis,
      name,
      table,
      imported,
    );
    graphs.set(name, buildTypeGraph(declarations));
    modules.set(name, {
      module: name,
      declarations,
      interface: buildInterface(declarations, modes),
      diagnostics: declarations.diagnostics,
    });
    diagnostics.push(...declarations.diagnostics);
  }
  return { table, modules, diagnostics: normalizeDiagnostics(diagnostics) };
}

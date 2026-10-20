// Module interfaces. An interface is the `Import` payload of the IR without
// `module` and `bindings`: the exports, the types of the exported values, and
// the declarations that those exports reach (design I8). The spec requires the
// complete supporting type graph, so the payload also carries the declarations
// of other modules that the exports reach. A dependent then sees them without
// an import of their module, and the hash changes when one of them changes.
//
// The interface hash covers the content without source spans, so a comment or a
// body edit that moves a declaration does not change it. The hash is FNV-1a 64
// over canonical JSON. A later part may switch to SHA-256.
//
// `reachableModules` also lives here. The project drivers in `check_project.ts`
// and `db.ts` use it to give each module the type graphs of the modules that it
// reaches.

import type { Analysis } from "./analyze.ts";
import {
  effectIds,
  type FunctionSignature,
  isPendingMode,
  type ModeMap,
  type ModuleDeclarations,
  referencedIds,
  signatureType,
  type TypeGraph,
} from "./check.ts";
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
import { canonicalJson } from "./types.ts";

/** The `Import` payload without `module` and `bindings`. */
type InterfacePayload = Pick<
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

  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
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
 * The declarations of other modules that the exports and the own type graph
 * reach, directly or through other foreign declarations. `imported` holds the
 * type graphs of the modules that this module reaches.
 */
function foreignTypeGraph(
  declarations: ModuleDeclarations,
  own: TypeGraph,
  imported: ReadonlyMap<string, TypeGraph>,
): TypeGraph {
  const foreign = new Map<string, TypeDecl | ErrorDecl | ServiceDecl>();
  for (const graph of imported.values()) {
    for (const d of graph.types) foreign.set(d.id, d);
    for (const d of graph.errors) foreign.set(d.id, d);
    for (const d of graph.services) foreign.set(d.id, d);
  }
  const reached = new Set<string>();
  const pending: string[] = [];
  const visit = (ids: ReadonlySet<string>): void => {
    for (const id of ids) {
      if (reached.has(id) || !foreign.has(id)) continue;
      reached.add(id);
      pending.push(id);
    }
  };
  visit(exportedValueIds(declarations));
  const seeds = new Set<string>();
  for (const d of own.types) {
    referencedIds(
      d.definition.kind === "alias" ? d.definition.type : d.definition.base,
      seeds,
    );
  }
  for (const d of own.errors) {
    for (const field of d.fields) referencedIds(field.type, seeds);
  }
  for (const d of own.services) {
    for (const method of d.methods) referencedIds(method.type, seeds);
  }
  visit(seeds);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const d = foreign.get(id);
    if (d === undefined) continue;
    const found = new Set<string>();
    switch (d.kind) {
      case "type":
        referencedIds(
          d.definition.kind === "alias" ? d.definition.type : d.definition.base,
          found,
        );
        break;
      case "error":
        for (const field of d.fields) referencedIds(field.type, found);
        break;
      case "service":
        for (const method of d.methods) referencedIds(method.type, found);
        break;
    }
    visit(found);
  }
  const types: TypeDecl[] = [];
  const errors: ErrorDecl[] = [];
  const services: ServiceDecl[] = [];
  for (const id of reached) {
    const d = foreign.get(id);
    if (d?.kind === "type") types.push(d);
    else if (d?.kind === "error") errors.push(d);
    else if (d?.kind === "service") services.push(d);
  }
  return { types, errors, services };
}

/**
 * Builds the interface of a module. Every explicit function whose sets are empty
 * needs an entry in `modes`. Without it the result is an error value, because the
 * hash would otherwise hide a pending mode.
 */
export function buildInterface(
  declarations: ModuleDeclarations,
  modes: ModeMap,
  imported: ReadonlyMap<string, TypeGraph> = new Map(),
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
  const foreign = foreignTypeGraph(declarations, graph, imported);
  const payload: InterfacePayload = {
    exports: declarations.exports as readonly DeclarationId[],
    values: byId(values),
    types: byId([...graph.types, ...foreign.types]),
    errors: byId([...graph.errors, ...foreign.errors]),
    services: byId([...graph.services, ...foreign.services]),
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

// ------------------------------------------------------------------ reachability

/** The names of the modules that `module` reaches through imports, directly or not. */
export function reachableModules(analysis: Analysis, module: string): string[] {
  const seen = new Set<string>();
  const stack = [...(analysis.project.graph.get(module) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(analysis.project.graph.get(next) ?? []));
  }
  seen.delete(module);
  return [...seen].sort(compareText);
}

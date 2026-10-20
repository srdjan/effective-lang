// The editor queries over a revision (LSP plan, sections 5.6 and 5.7): hover
// text, definition, and document symbols. Each function does no I/O. It reads the
// checked modules, the resolution tables, and the lazy IR of a `Revision`, which
// computes and counts the IR on first use (LSP plan 5.11), and it
// returns core data, not LSP types. `path` is the root-relative path that spans
// use as their `source`.

import type { CheckedModule, FunctionBody } from "./check_project.ts";
import { effectText } from "./check_project.ts";
import type { Revision } from "./db.ts";
import { bracketed, render } from "./emit/doc.ts";
import { EmitFailure, Scope } from "./emit/scope.ts";
import { effectTypeDoc, typeDoc } from "./emit/types.ts";
import {
  methodOfCapability,
  moduleOfId,
  nameOfId,
  serviceOfCapability,
} from "./ids.ts";
import type { ConstantDecl, FunctionDecl, ModuleIR } from "./ir.ts";
import type { DeclEntry, FileIndex } from "./index.ts";
import { parseFileFresh } from "./project.ts";
import type { Target } from "./resolve.ts";
import type { Span } from "./source.ts";
import { type NodeId, nodeSpan, type SyntaxTree } from "./syntax.ts";
import type { BodyTable } from "./tables.ts";

// ------------------------------------------------------------------ positions

interface Range {
  readonly start: number;
  readonly end: number;
}

/**
 * The position rule of hover and definition. The first pass accepts a range with
 * `start <= offset < end`. The second pass accepts a range that ends at the
 * offset, which is a cursor just after a name.
 */
function covers(range: Range, offset: number, afterEnd: boolean): boolean {
  return afterEnd
    ? range.start < range.end && range.end === offset
    : range.start <= offset && offset < range.end;
}

const PASSES: readonly boolean[] = [false, true];

function moduleAt(revision: Revision, path: string): CheckedModule | undefined {
  for (const candidate of revision.checked.modules.values()) {
    if (candidate.path === path) return candidate;
  }
  return undefined;
}

// ------------------------------------------------------------------ hover

/** The backend type of a declaration, or the reason that it is missing. */
export type HoverBackend =
  | { readonly tag: "type"; readonly text: string }
  | { readonly tag: "unavailable" };

export interface Hover {
  /** The name span on a name, else the span of the innermost node. */
  readonly span: Span;
  /** The source contract text. */
  readonly contract: string;
  /** Only on the name of a module-level function or constant. */
  readonly backend: HoverBackend | undefined;
}

/** Replaces the checker text for an error type by the hover text. */
function cleanErrors(text: string): string {
  return text.replaceAll("<error>", "unknown (error)");
}

function functionContract(
  revision: Revision,
  fn: FunctionBody,
): string {
  const table = revision.checked.table;
  const { signature } = fn;
  const parameters = signature.parameters.map((p) =>
    `${p.name}: ${table.show(p.type.ref)}`
  ).join(", ");
  return cleanErrors(
    `${signature.name}(${parameters}): ${table.show(fn.result)}${
      effectText(fn.failures, fn.requirements)
    }`,
  );
}

/** One line, as the emitter prints the declaration header, without the width limit. */
const FLAT_WIDTH = 1_000_000;

function backendOf(
  revision: Revision,
  module: CheckedModule,
  id: string,
): HoverBackend {
  const unavailable: HoverBackend = { tag: "unavailable" };
  if (!revision.emitted(module.module)?.ok) return unavailable;
  const lowered = revision.lowered(module.module);
  if (lowered === undefined || !lowered.ok) return unavailable;
  const ir: ModuleIR = lowered.value;
  const declaration = ir.declarations.find((d) => d.id === id);
  if (declaration === undefined) return unavailable;
  try {
    const scope = new Scope(ir, revision.project.config);
    if (declaration.kind === "function") {
      return { tag: "type", text: functionHeader(scope, declaration) };
    }
    if (declaration.kind === "constant") {
      return { tag: "type", text: constantType(scope, declaration) };
    }
    return unavailable;
  } catch (error) {
    if (error instanceof EmitFailure) return unavailable;
    throw error;
  }
}

/** The header of `functionDeclaration` in the emitter: parameters, then the result. */
function functionHeader(scope: Scope, d: FunctionDecl): string {
  const parameters = bracketed(
    "(",
    ")",
    d.parameters.map((p) => [p.name, ": ", typeDoc(scope, p.type)]),
    false,
  );
  const result = typeDoc(scope, d.type.result);
  const returns = d.type.execution === "effect"
    ? effectTypeDoc(scope, result, d.type.effects)
    : result;
  return render([parameters, ": ", returns], FLAT_WIDTH).text;
}

function constantType(scope: Scope, d: ConstantDecl): string {
  return render(typeDoc(scope, d.type), FLAT_WIDTH).text;
}

/**
 * The candidate whose node covers the offset with the least width. Equal widths
 * go to the node with the lower id. The first of two equal nodes wins.
 */
function innermostNode<T>(
  tree: SyntaxTree,
  candidates: Iterable<T>,
  nodeOf: (candidate: T) => NodeId,
  offset: number,
  afterEnd: boolean,
): T | undefined {
  let best: T | undefined;
  let bestNode = 0;
  let bestWidth = 0;
  for (const candidate of candidates) {
    const node = nodeOf(candidate);
    const range = { start: tree.starts[node], end: tree.ends[node] };
    if (!covers(range, offset, afterEnd)) continue;
    const width = range.end - range.start;
    if (
      best === undefined || width < bestWidth ||
      (width === bestWidth && node < bestNode)
    ) {
      best = candidate;
      bestNode = node;
      bestWidth = width;
    }
  }
  return best;
}

/** Every node of the body tables, with the table that holds its checker info. */
function* tableNodes(
  tables: Iterable<BodyTable>,
): Generator<{ readonly node: NodeId; readonly table: BodyTable }> {
  for (const table of tables) {
    for (const node of table.info.keys()) yield { node, table };
  }
}

function hoverPass(
  revision: Revision,
  module: CheckedModule,
  offset: number,
  afterEnd: boolean,
): Hover | undefined {
  const table = revision.checked.table;
  for (const fn of module.functions.values()) {
    const span = fn.signature.nameSpan;
    if (!covers(span, offset, afterEnd)) continue;
    return {
      span,
      contract: functionContract(revision, fn),
      backend: backendOf(revision, module, fn.signature.id),
    };
  }
  for (const constant of module.constants.values()) {
    const span = constant.signature.nameSpan;
    if (!covers(span, offset, afterEnd)) continue;
    return {
      span,
      contract: cleanErrors(
        `${constant.signature.name}: ${table.show(constant.type)}`,
      ),
      backend: backendOf(revision, module, constant.signature.id),
    };
  }
  const tables = [
    ...[...module.functions.values()].map((fn) => fn.table),
    ...[...module.constants.values()].map((constant) => constant.table),
  ];
  const found = innermostNode(
    module.tree,
    tableNodes(tables),
    (candidate) => candidate.node,
    offset,
    afterEnd,
  );
  if (found === undefined) return undefined;
  const info = found.table.info.get(found.node);
  if (info === undefined) return undefined;
  return {
    span: nodeSpan(module.tree, found.node),
    contract: cleanErrors(
      `${table.show(info.type)}${effectText(info.failures, info.requirements)}`,
    ),
    backend: undefined,
  };
}

/**
 * The contract text at an offset of the file `path`, and the backend type on the
 * name of a module-level function or constant. Returns undefined when no checked
 * node covers the offset.
 */
export function hoverAt(
  revision: Revision,
  path: string,
  offset: number,
): Hover | undefined {
  const module = moduleAt(revision, path);
  if (module === undefined) return undefined;
  for (const afterEnd of PASSES) {
    const found = hoverPass(revision, module, offset, afterEnd);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ------------------------------------------------------------------ definition

/** The index entry of the declaration `id`, or undefined for a malformed or unknown id. */
function declEntryOf(revision: Revision, id: string): DeclEntry | undefined {
  const module = moduleOfId(id);
  const name = nameOfId(id);
  if (module === undefined || name === undefined) return undefined;
  return revision.project.modules.get(module)?.index.byName.get(name);
}

function targetSpan(
  revision: Revision,
  module: CheckedModule,
  target: Target,
): Span | undefined {
  switch (target.kind) {
    case "type":
    case "error":
    case "service":
    case "value":
    case "provider":
      return declEntryOf(revision, target.id)?.nameSpan;
    case "cap": {
      const service = serviceOfCapability(target.id);
      const method = methodOfCapability(target.id);
      if (service === undefined || method === undefined) return undefined;
      return declEntryOf(revision, service)?.methods.get(method)?.nameSpan;
    }
    case "local":
      return revision.checked.analysis.resolutions.get(module.module)?.locals
        .get(target.id);
    case "builtin":
    case "builtin-type":
    case "field":
    case "unresolved":
      return undefined;
  }
}

/**
 * The declaration name span that the innermost resolved name at the offset
 * refers to. Returns undefined for a builtin, a field, an unresolved name, or an
 * offset with no resolved name.
 */
export function definitionAt(
  revision: Revision,
  path: string,
  offset: number,
): Span | undefined {
  const module = moduleAt(revision, path);
  if (module === undefined) return undefined;
  const resolution = revision.checked.analysis.resolutions.get(module.module);
  if (resolution === undefined) return undefined;
  const { tree } = module;
  for (const afterEnd of PASSES) {
    const best = innermostNode(
      tree,
      resolution.targets.keys(),
      (node) => node,
      offset,
      afterEnd,
    );
    if (best === undefined) continue;
    const target = resolution.targets.get(best);
    return target === undefined
      ? undefined
      : targetSpan(revision, module, target);
  }
  return undefined;
}

// ------------------------------------------------------------------ symbols

export type EditorSymbolKind =
  | "function"
  | "constant"
  | "type"
  | "error"
  | "service"
  | "method"
  | "provider";

export interface EditorSymbol {
  readonly name: string;
  readonly kind: EditorSymbolKind;
  /** The whole declaration. */
  readonly span: Span;
  readonly nameSpan: Span;
  /** The methods of a service. Empty for every other kind. */
  readonly children: readonly EditorSymbol[];
}

function symbolOf(entry: DeclEntry): EditorSymbol {
  const kind: EditorSymbolKind = entry.kind === "const"
    ? entry.isArrow ? "function" : "constant"
    : entry.kind;
  return {
    name: entry.name,
    kind,
    span: entry.span,
    nameSpan: entry.nameSpan,
    children: entry.methodList.map((method) => ({
      name: method.name,
      kind: "method",
      span: method.span,
      nameSpan: method.nameSpan,
      children: [],
    })),
  };
}

/** The index of the file `path`: from the revision when its text equals `text`, else parsed fresh. */
function indexOfFile(
  revision: Revision | undefined,
  path: string,
  text: string,
): FileIndex {
  if (revision !== undefined) {
    for (const info of revision.project.modules.values()) {
      if (info.path === path && info.tree.text === text) return info.index;
    }
  }
  return parseFileFresh(path, text).index;
}

/**
 * The declarations of the file in source order, with the methods of a service as
 * children. A declaration whose name parsed appears even when it has a syntax
 * error. The revision may be undefined, or may lack the file: the text is then
 * parsed on its own, as for a host interface file that no module imports.
 */
export function documentSymbols(
  revision: Revision | undefined,
  path: string,
  text: string,
): EditorSymbol[] {
  return indexOfFile(revision, path, text).decls.map(symbolOf);
}

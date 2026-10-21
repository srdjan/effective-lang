// The project driver of part A3b. For each module, in topological order, it runs
// the declaration checker (A3a), checks every body, solves the execution modes,
// builds the initialization graph, and builds the module interface with the
// modes. The finished interface goes to the modules that import it.
//
// Body checking order. The module-local reference graph over functions and
// constants gives strongly connected components, callees first. A component of
// one declaration without a self reference is checked once. A recursive component
// starts its pending modes at `pure` and iterates (modes.ts). The diagnostics of
// the iteration are held, and only the last round's diagnostics are published
// (design 4.6).

import type { Analysis } from "./analyze.ts";
import { analyzeProject } from "./analyze.ts";
import {
  checkModuleDeclarations,
  type ConstantSignature,
  type FunctionSignature,
  isPendingMode,
  type ModeMap,
  type ModuleDeclarations,
  signatureType,
  type TypeGraph,
  type ValueSignature,
} from "./check.ts";
import {
  type BodyEnv,
  checkConstantBody,
  checkFunctionBody,
  type ConstantRun,
  type FunctionRun,
} from "./check_expr.ts";
import {
  type Diagnostic,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
import { serviceOfCapability, shortName } from "./ids.ts";
import { arrowBody, initOf } from "./syntax_queries.ts";
import {
  buildInitializationGraph,
  type InitializationGraph,
} from "./initialization.ts";
import {
  buildInterface,
  buildTypeGraph,
  type InterfaceError,
  type ModuleInterface,
  reachableModules,
} from "./interface.ts";
import type { CapabilityId, ErrorId, Execution, ValueId } from "./ir.ts";
import { solveModeGroup, stronglyConnectedComponents } from "./modes.ts";
import type { ConfigError, ModuleInfo } from "./project.ts";
import type { Result, SourceHost } from "./source.ts";
import {
  kindOf,
  type NodeId,
  SyntaxKind,
  type SyntaxTree,
  walk,
} from "./syntax.ts";
import type { BodyTable, NodeInfo } from "./tables.ts";
import { type TypeRef, TypeTable } from "./types.ts";

// ------------------------------------------------------------------ results

/** The checked body of a module-level function. */
export interface FunctionBody {
  readonly kind: "function";
  readonly signature: FunctionSignature;
  /** The body expression of the arrow, or undefined when the source is broken. */
  readonly bodyNode: NodeId | undefined;
  readonly table: BodyTable;
  /** The info of the body expression. */
  readonly body: NodeInfo | undefined;
  /** The declared or inferred result type. */
  readonly result: TypeRef;
  /** The invocation sets: declared for an explicit contract, inferred otherwise. */
  readonly failures: readonly ErrorId[];
  readonly requirements: readonly CapabilityId[];
  /** The invocation mode, which is also the entry in the mode map. */
  readonly mode: Execution;
  /** The function type with that mode. */
  readonly type: TypeRef;
}

/** The checked initializer of a module-level constant. */
export interface ConstantBody {
  readonly kind: "constant";
  readonly signature: ConstantSignature;
  readonly initNode: NodeId | undefined;
  readonly table: BodyTable;
  readonly init: NodeInfo | undefined;
  readonly type: TypeRef;
}

interface ModuleBodies {
  /** In source order. */
  readonly functions: ReadonlyMap<ValueId, FunctionBody>;
  /** In source order. */
  readonly constants: ReadonlyMap<ValueId, ConstantBody>;
  /** The invocation mode of every function. */
  readonly modes: ModeMap;
  readonly initialization: InitializationGraph;
  /** Body, mode, and initialization diagnostics of the module, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface CheckedModule {
  readonly module: string;
  /** The root-relative path, which diagnostic spans use as their source. */
  readonly path: string;
  readonly tree: SyntaxTree;
  readonly declarations: ModuleDeclarations;
  readonly functions: ReadonlyMap<ValueId, FunctionBody>;
  readonly constants: ReadonlyMap<ValueId, ConstantBody>;
  readonly modes: ModeMap;
  readonly initialization: InitializationGraph;
  /** An error value only when the mode map lacks an entry, which cannot happen after body checking. */
  readonly interface: Result<ModuleInterface, InterfaceError>;
  /** The interface hash, when the interface exists. */
  readonly hash: string | undefined;
  /** Declaration and body diagnostics of this module, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface CheckedProject {
  readonly analysis: Analysis;
  /** The one intern table of the project. */
  readonly table: TypeTable;
  /** Per module, in topological order. */
  readonly modules: ReadonlyMap<string, CheckedModule>;
  /** All diagnostics of the project, sorted and without duplicates. */
  readonly diagnostics: readonly Diagnostic[];
}

// ------------------------------------------------------------------ one module

interface Entry {
  readonly signature: FunctionSignature | ConstantSignature;
  readonly initNode: NodeId | undefined;
  /** The body expression of a function's arrow. */
  readonly bodyNode: NodeId | undefined;
  readonly broken: boolean;
  readonly references: readonly ValueId[];
}

interface CheckArguments {
  readonly analysis: Analysis;
  readonly module: string;
  readonly declarations: ModuleDeclarations;
  /** The interfaces of the modules that this module reaches. */
  readonly interfaces: ReadonlyMap<string, ModuleInterface>;
}

type Run =
  | { readonly kind: "function"; readonly run: FunctionRun }
  | { readonly kind: "constant"; readonly run: ConstantRun };

function collectEntries(args: CheckArguments): Entry[] {
  const { analysis, module, declarations } = args;
  const info = analysis.project.modules.get(module);
  const resolution = analysis.resolutions.get(module);
  if (info === undefined || resolution === undefined) {
    throw new Error(`module ${module} is not part of the analysis`);
  }
  const tree = info.tree;
  const targets = resolution.targets;
  const local = new Set<ValueId>();
  for (const signature of declarations.values.values()) {
    if (signature.kind !== "provider") local.add(signature.id);
  }
  const entries: Entry[] = [];
  for (const signature of declarations.values.values()) {
    if (signature.kind === "provider") continue;
    const initNode = initOf(tree, signature.node, signature.nameNode);
    const bodyNode = signature.kind === "function" && initNode !== undefined &&
        kindOf(tree, initNode) === SyntaxKind.ArrowExpr
      ? arrowBody(tree, initNode)
      : undefined;
    const references = new Set<ValueId>();
    if (initNode !== undefined) {
      walk(tree, initNode, (node) => {
        const target = targets.get(node);
        if (target?.kind === "value" && local.has(target.id)) {
          references.add(target.id);
        }
      });
    }
    entries.push({
      signature,
      initNode,
      bodyNode,
      broken: info.index.byName.get(signature.name)?.broken ?? false,
      references: [...references],
    });
  }
  return entries;
}

/** Checks every body of one module and solves its execution modes. */
function checkModuleBodies(args: CheckArguments): ModuleBodies {
  const { analysis, module, declarations } = args;
  const table = declarations.env.table;
  const resolution = analysis.resolutions.get(module);
  if (resolution === undefined) {
    throw new Error(`module ${module} is not part of the analysis`);
  }

  const importedValues = new Map<ValueId, TypeRef>();
  for (const iface of args.interfaces.values()) {
    for (const value of iface.payload.values) {
      importedValues.set(value.id, table.fromIr(value.type));
    }
  }
  const methodTypes = new Map<CapabilityId, TypeRef>();
  const methodType = (capability: CapabilityId): TypeRef => {
    const cached = methodTypes.get(capability);
    if (cached !== undefined) return cached;
    let ref = declarations.methodTypes.get(capability);
    if (ref === undefined) {
      const service = serviceOfCapability(capability);
      const method = service === undefined
        ? undefined
        : declarations.env.services.get(service)?.methods.find((m) =>
          m.id === capability
        );
      ref = method === undefined
        ? table.error
        : table.fromIrFunction(method.type);
    }
    methodTypes.set(capability, ref);
    return ref;
  };

  const modes = new Map<ValueId, Execution>();
  const inferred = new Map<ValueId, TypeRef>();
  const constantTypes = new Map<ValueId, TypeRef>();
  const values = (id: ValueId): TypeRef => {
    const signature: ValueSignature | undefined = declarations.values.get(id);
    if (signature === undefined) return importedValues.get(id) ?? table.error;
    switch (signature.kind) {
      case "function": {
        if (signature.contract === "inferred") {
          return inferred.get(id) ?? table.error;
        }
        const type = signatureType(table, signature, modes);
        return type.ok ? type.value.ref : table.error;
      }
      case "constant":
        return signature.type?.ref ?? constantTypes.get(id) ?? table.error;
      case "provider":
        return signature.type.ref;
    }
  };
  const benv: BodyEnv = {
    env: declarations.env,
    values,
    methodType,
  };

  const entries = collectEntries(args);
  const position = new Map<ValueId, number>();
  entries.forEach((entry, i) => position.set(entry.signature.id, i));
  const edges = entries.map((entry) =>
    entry.references.map((id) => position.get(id)).filter((p): p is number =>
      p !== undefined
    ).sort((a, b) => a - b)
  );

  const functions = new Map<ValueId, FunctionBody>();
  const constants = new Map<ValueId, ConstantBody>();
  const diagnostics: Diagnostic[] = [];

  const runEntry = (entry: Entry): Run =>
    entry.signature.kind === "function"
      ? {
        kind: "function",
        run: checkFunctionBody(benv, entry.signature, entry.bodyNode),
      }
      : {
        kind: "constant",
        run: checkConstantBody(benv, entry.signature, entry.initNode),
      };

  /** Records the final run of a declaration and publishes its diagnostics. */
  const commit = (entry: Entry, run: Run, recursive: boolean): void => {
    if (!entry.broken) diagnostics.push(...run.run.diagnostics);
    if (run.kind === "function") {
      const signature = entry.signature as FunctionSignature;
      const result = run.run;
      modes.set(signature.id, result.mode);
      if (signature.contract === "inferred" && !recursive) {
        inferred.set(signature.id, result.type);
      }
      functions.set(signature.id, {
        kind: "function",
        signature,
        bodyNode: entry.bodyNode,
        table: result.table,
        body: result.body,
        result: result.result,
        failures: result.failures,
        requirements: result.requirements,
        mode: result.mode,
        type: result.type,
      });
    } else {
      const signature = entry.signature as ConstantSignature;
      constantTypes.set(signature.id, run.run.type);
      constants.set(signature.id, {
        kind: "constant",
        signature,
        initNode: entry.initNode,
        table: run.run.table,
        init: run.run.init,
        type: run.run.type,
      });
    }
  };

  for (const component of stronglyConnectedComponents(entries.length, edges)) {
    const members = component.map((i) => entries[i]);
    const recursive = members.length > 1 ||
      edges[component[0]].includes(component[0]);
    if (!recursive) {
      commit(members[0], runEntry(members[0]), false);
      continue;
    }
    for (const member of members) {
      const signature = member.signature;
      if (signature.kind === "function" && signature.contract === "inferred") {
        diagnostics.push(makeDiagnostic(
          "execution-mode/003",
          `\`${signature.name}\` is recursive, so it needs explicit parameter and result annotations`,
          signature.nameSpan,
        ));
      }
    }
    const pending: ValueId[] = [];
    for (const member of members) {
      const signature = member.signature;
      if (signature.kind === "function" && isPendingMode(signature)) {
        pending.push(signature.id);
      }
    }
    const solution = solveModeGroup(pending, (assumed) => {
      for (const [id, mode] of assumed) modes.set(id, mode);
      const runs = members.map(runEntry);
      const computed = new Map<ValueId, Execution>();
      runs.forEach((run, i) => {
        const signature = members[i].signature;
        if (run.kind === "function" && pending.includes(signature.id)) {
          computed.set(signature.id, run.run.mode);
        }
      });
      return { results: runs, computed };
    });
    for (const [id, mode] of solution.modes) modes.set(id, mode);
    if (!solution.settled) {
      const first = members[0].signature;
      diagnostics.push(makeDiagnostic(
        "execution-mode/004",
        `the execution modes of the recursive group with \`${first.name}\` did not settle within the round cap`,
        first.nameSpan,
      ));
    }
    members.forEach((member, i) => {
      commit(member, solution.results[i], true);
    });
  }

  const initialization = buildInitializationGraph(
    entries.map((entry) => ({
      id: entry.signature.id,
      kind: entry.signature.kind,
      references: entry.references,
    })),
  );
  const signatures = new Map<ValueId, FunctionSignature | ConstantSignature>(
    entries.map((e) => [e.signature.id, e.signature]),
  );
  for (const cycle of initialization.cycles) {
    // A cycle lists ids of `entries`, so every id has a signature.
    const members = cycle.map((id) => {
      const signature = signatures.get(id);
      if (signature === undefined) {
        throw new Error("internal: a cycle id has no signature");
      }
      return signature;
    });
    const first = members.find((m) => m.kind === "constant") ?? members[0];
    const loop = [...cycle.map(shortName), shortName(cycle[0])].join(" -> ");
    diagnostics.push(makeDiagnostic(
      "module/004",
      `module initialization cycle: ${loop}`,
      first.nameSpan,
      members.filter((m) => m !== first).map((m) => ({
        span: m.nameSpan,
        message: "also part of the cycle",
      })),
    ));
  }

  // Source order for the maps, whatever order the components ran in.
  const orderedFunctions = new Map<ValueId, FunctionBody>();
  const orderedConstants = new Map<ValueId, ConstantBody>();
  const orderedModes = new Map<ValueId, Execution>();
  for (const entry of entries) {
    const id = entry.signature.id;
    const fn = functions.get(id);
    if (fn !== undefined) {
      orderedFunctions.set(id, fn);
      orderedModes.set(id, fn.mode);
    }
    const constant = constants.get(id);
    if (constant !== undefined) orderedConstants.set(id, constant);
  }
  return {
    functions: orderedFunctions,
    constants: orderedConstants,
    modes: orderedModes,
    initialization,
    diagnostics: normalizeDiagnostics(diagnostics),
  };
}

// ------------------------------------------------------------------ the project

/** What a module sees of the modules that it reaches, among those that are checked so far. */
interface ReachedModules {
  readonly reached: readonly string[];
  readonly graphs: ReadonlyMap<string, TypeGraph>;
  readonly interfaces: ReadonlyMap<string, ModuleInterface>;
}

/** The reached modules of `name`, with the type graphs and the interfaces that exist for them. */
export function reachedModules(
  analysis: Analysis,
  name: string,
  graphs: ReadonlyMap<string, TypeGraph>,
  interfaces: ReadonlyMap<string, ModuleInterface>,
): ReachedModules {
  const reached = reachableModules(analysis, name);
  const importedGraphs = new Map<string, TypeGraph>();
  const visible = new Map<string, ModuleInterface>();
  for (const other of reached) {
    const graph = graphs.get(other);
    if (graph !== undefined) importedGraphs.set(other, graph);
    const iface = interfaces.get(other);
    if (iface !== undefined) visible.set(other, iface);
  }
  return { reached, graphs: importedGraphs, interfaces: visible };
}

/** The result of the check of one module: its checked form and its type graph. */
interface ModuleStep {
  readonly checked: CheckedModule;
  readonly graph: TypeGraph;
}

/**
 * Checks one module: its declarations, its type graph, its bodies, and its
 * interface. `checkAnalysis` and `Program` both call this step, so a check from
 * scratch and a revision of the program give the same result.
 */
export function checkModuleStep(
  analysis: Analysis,
  info: ModuleInfo,
  name: string,
  table: TypeTable,
  seen: ReachedModules,
): ModuleStep {
  const declarations = checkModuleDeclarations(
    analysis,
    name,
    table,
    seen.graphs,
  );
  const graph = buildTypeGraph(declarations);
  const bodies = checkModuleBodies({
    analysis,
    module: name,
    declarations,
    interfaces: seen.interfaces,
  });
  const built = buildInterface(declarations, bodies.modes, seen.graphs);
  return {
    graph,
    checked: {
      module: name,
      path: info.path,
      tree: info.tree,
      declarations,
      functions: bodies.functions,
      constants: bodies.constants,
      modes: bodies.modes,
      initialization: bodies.initialization,
      interface: built,
      hash: built.ok ? built.value.hash : undefined,
      diagnostics: normalizeDiagnostics([
        ...declarations.diagnostics,
        ...bodies.diagnostics,
      ]),
    },
  };
}

/**
 * Checks every module of an analyzed project in topological order. A module sees
 * the finished interfaces of the modules that it reaches, with their modes.
 */
export function checkAnalysis(analysis: Analysis): CheckedProject {
  const table = new TypeTable();
  const graphs = new Map<string, TypeGraph>();
  const interfaces = new Map<string, ModuleInterface>();
  const modules = new Map<string, CheckedModule>();
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];
  for (const name of analysis.project.order) {
    const info = analysis.project.modules.get(name);
    if (info === undefined) continue;
    const step = checkModuleStep(
      analysis,
      info,
      name,
      table,
      reachedModules(analysis, name, graphs, interfaces),
    );
    graphs.set(name, step.graph);
    if (step.checked.interface.ok) {
      interfaces.set(name, step.checked.interface.value);
    }
    diagnostics.push(...step.checked.diagnostics);
    modules.set(name, step.checked);
  }
  return {
    analysis,
    table,
    modules,
    diagnostics: normalizeDiagnostics(diagnostics),
  };
}

/**
 * Loads a project from the entry files (root-relative paths), resolves it, and
 * checks every module. A missing or malformed project file is an error value.
 * Every other problem is a diagnostic in the result.
 */
export function checkProject(
  host: SourceHost,
  root: string,
  entries: readonly string[],
): Result<CheckedProject, ConfigError> {
  const analysis = analyzeProject(host, root, entries);
  if (!analysis.ok) return analysis;
  return { ok: true, value: checkAnalysis(analysis.value) };
}

// ------------------------------------------------------------------ effect text

/** The ` fails ...` and ` uses ...` text of two sets, as the hover contract prints it. */
export function effectText(
  failures: readonly string[],
  requirements: readonly string[],
): string {
  const fails = failures.length === 0
    ? ""
    : ` fails ${failures.map(shortName).join(" | ")}`;
  const uses = requirements.length === 0
    ? ""
    : ` uses ${requirements.map(shortName).join(" | ")}`;
  return fails + uses;
}

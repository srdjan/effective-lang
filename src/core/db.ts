// The program of part A7: the state of one project across revisions, with
// memoized queries and an early cutoff at module level (design D4, section 4.4).
//
// `update` starts a new revision from a set of file changes. The revision then
// answers one query per module: the checked module, its diagnostics, its IR, its
// emitted TypeScript, its span table, and its source map.
//
// Memoization has three levels.
//
// 1. Parse memo. A file whose text equals the text of the last parse keeps its
//    syntax tree object, its parse diagnostics, and its declaration index.
// 2. Check memo. The memo key of a module holds its own text and a signature of
//    every module that it reaches. A module with an unchanged key is not checked
//    again. Its checked module, type graph, interface, IR, emitted text, span
//    table, and source map are reused. The signature of a reached module is the
//    hash of its full interface payload, which includes the spans of the
//    declarations (see the note on spans below).
// 3. Lazy queries. IR, emitted text, span table, and source map are computed on
//    first demand and stored on the memo entry of the module.
//
// The program checks the modules in the order and with the inputs of
// `checkAnalysis`, and it calls the same per-module steps, so the result of a
// revision equals the result of a check from scratch. One test compares both.
//
// One `TypeTable` lives as long as the program, so that the type references in a
// reused module stay valid. The table only grows. Its memory growth over a long
// watch session is measurement M4.
//
// Note on spans. The IR import of a module carries the interface payload of the
// imported module, and the payload carries the source spans of the declarations
// of that module. The interface hash of design I8 leaves the spans out. If the
// key used only that hash, an edit that moves an exported declaration of an
// imported module would leave stale spans in the IR of its importers. The key
// therefore uses the hash of the full payload. A body edit below the last
// exported type, error, or service keeps this hash, and so does an edit that
// keeps the length of the text above them.

import { type Analysis, analyzeProject } from "./analyze.ts";
import { checkModuleDeclarations, type TypeGraph } from "./check.ts";
import {
  type CheckedModule,
  type CheckedProject,
  checkModuleBodies,
} from "./check_project.ts";
import { type Diagnostic, normalizeDiagnostics } from "./diagnostics.ts";
import {
  buildSourceMap,
  type SourceMapError,
  type SourceMapV3,
} from "./emit/sourcemap.ts";
import {
  emitModule,
  type EmitProjectError,
  type EmittedModule,
} from "./emit/emit.ts";
import {
  buildSpanTable,
  hostImportSpans,
  type SpanTable,
} from "./emit/spans.ts";
import { fnv1a64 } from "./hash.ts";
import {
  buildInterface,
  buildTypeGraph,
  type ModuleInterface,
  reachableModules,
} from "./interface.ts";
import type { ModuleIR } from "./ir.ts";
import { type LowerError, lowerModule } from "./lower.ts";
import {
  type ConfigError,
  type FileParser,
  joinPath,
  type ParsedFile,
  parseFileFresh,
  type Project,
  type ProjectConfig,
} from "./project.ts";
import { memoryHost, type Result } from "./source.ts";
import { canonicalJson, TypeTable } from "./types.ts";

// ------------------------------------------------------------------ changes

/** A change set. Paths are relative to the project root. */
export interface ProgramChanges {
  /** Files that are new or that have new text. */
  readonly set?:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  /** Files that no longer exist. */
  readonly remove?: readonly string[];
}

// ------------------------------------------------------------------ memo entries

/** A memo entry. The key decides when it is valid. The lazy fields fill on demand. */
interface Entry {
  readonly text: string;
  readonly rest: string;
  readonly checked: CheckedModule;
  readonly graph: TypeGraph;
  readonly iface: ModuleInterface | undefined;
  /** What an importer sees of this module: the full payload hash, or the key when there is no interface. */
  readonly signature: string;
  lowered?: Result<ModuleIR, LowerError>;
  emitted?: Result<EmittedModule, EmitProjectError>;
  table?: Result<SpanTable, EmitProjectError>;
  map?: Result<SourceMapV3, EmitProjectError | SourceMapError>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function configKey(config: ProjectConfig): string {
  return JSON.stringify(
    [...config.host].sort((a, b) => compareText(a[0], b[0])).map((
      [key, host],
    ) => [key, host.interfacePath, host.modulePath]),
  );
}

// ------------------------------------------------------------------ the revision

/**
 * The state of the program after one `update`. The query methods return
 * memoized values: a module with an unchanged key returns the same objects as
 * in the revision before.
 */
export class Revision {
  constructor(
    /** The revision number: 1 for the first successful `update`. */
    readonly number: number,
    readonly project: Project,
    /** The checked project of this revision, in the shape that `lowerProject` reads. */
    readonly checked: CheckedProject,
    /** The modules that this revision checked again, in topological order. */
    readonly rechecked: readonly string[],
    private readonly entries: ReadonlyMap<string, Entry>,
    private readonly texts: ReadonlyMap<string, string>,
  ) {}

  /** All diagnostics of the project, sorted and without duplicates. */
  get diagnostics(): readonly Diagnostic[] {
    return this.checked.diagnostics;
  }

  /** The module names, imported modules before their importers. */
  moduleNames(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** The names of the `.eff` modules, in topological order. */
  effModuleNames(): readonly string[] {
    return this.moduleNames().filter((name) =>
      this.project.modules.get(name)?.mode === "eff"
    );
  }

  checkedModule(name: string): CheckedModule | undefined {
    return this.entries.get(name)?.checked;
  }

  /** The interface hash of design I8, which leaves out source spans. */
  interfaceHash(name: string): string | undefined {
    return this.entries.get(name)?.checked.hash;
  }

  /** The text of each file that the project loaded, keyed by root-relative path. */
  sourceTexts(): ReadonlyMap<string, string> {
    return this.texts;
  }

  /** The typed IR of an `.eff` module. A module with an error has an error value. */
  lowered(name: string): Result<ModuleIR, LowerError> | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (this.project.modules.get(name)?.mode !== "eff") return undefined;
    entry.lowered ??= lowerModule(this.checked, name);
    return entry.lowered;
  }

  /** The emitted TypeScript of an `.eff` module. */
  emitted(name: string): Result<EmittedModule, EmitProjectError> | undefined {
    const entry = this.entries.get(name);
    const lowered = this.lowered(name);
    if (entry === undefined || lowered === undefined) return undefined;
    if (entry.emitted === undefined) {
      entry.emitted = lowered.ok
        ? emitModule(lowered.value, { config: this.project.config })
        : {
          ok: false,
          error: { tag: "lowering", module: name, error: lowered.error },
        };
    }
    return entry.emitted;
  }

  /** The span table of the emitted module. */
  spanTable(name: string): Result<SpanTable, EmitProjectError> | undefined {
    const entry = this.entries.get(name);
    const emitted = this.emitted(name);
    if (entry === undefined || emitted === undefined) return undefined;
    if (entry.table === undefined) {
      entry.table = emitted.ok
        ? {
          ok: true,
          value: buildSpanTable(
            emitted.value,
            hostImportSpans(this.project).get(name),
          ),
        }
        : emitted;
    }
    return entry.table;
  }

  /** The version 3 source map of the emitted module. */
  sourceMap(
    name: string,
  ): Result<SourceMapV3, EmitProjectError | SourceMapError> | undefined {
    const entry = this.entries.get(name);
    const table = this.spanTable(name);
    if (entry === undefined || table === undefined) return undefined;
    if (entry.map === undefined) {
      entry.map = table.ok ? buildSourceMap(table.value, this.texts) : table;
    }
    return entry.map;
  }
}

// ------------------------------------------------------------------ the program

export class Program {
  private readonly files = new Map<string, string>();
  private readonly parses = new Map<
    string,
    { readonly text: string; readonly file: ParsedFile }
  >();
  private entries = new Map<string, Entry>();
  /** The one intern table of the program. Reused modules keep valid type references. */
  private readonly table = new TypeTable();
  private count = 0;

  /** `root` is the project directory that diagnostics and error values name. */
  constructor(private readonly root: string = "") {}

  /** The revision count so far. */
  get revisions(): number {
    return this.count;
  }

  private readonly parseFile: FileParser = (path, text) => {
    const memo = this.parses.get(path);
    if (memo !== undefined && memo.text === text) return memo.file;
    const file = parseFileFresh(path, text);
    this.parses.set(path, { text, file });
    return file;
  };

  /**
   * Applies the changes and starts a new revision. A missing or malformed
   * `effective.json` is an error value, and no revision starts. The files stay
   * changed, so a later `update` that fixes the project file succeeds.
   */
  update(changes: ProgramChanges = {}): Result<Revision, ConfigError> {
    const set = changes.set instanceof Map
      ? [...changes.set]
      : Object.entries(changes.set ?? {});
    for (const [path, text] of set) this.files.set(path, text);
    for (const path of changes.remove ?? []) this.files.delete(path);
    for (const path of [...this.parses.keys()]) {
      if (!this.files.has(path)) this.parses.delete(path);
    }

    const hostFiles = new Map<string, string>();
    for (const [path, text] of this.files) {
      hostFiles.set(joinPath(this.root, path), text);
    }
    const entryPaths = [...this.files.keys()].filter((p) => p.endsWith(".eff"))
      .sort(compareText);
    const analyzed = analyzeProject(
      memoryHost(hostFiles),
      this.root,
      entryPaths,
      this.parseFile,
    );
    if (!analyzed.ok) return analyzed;
    this.count++;
    return {
      ok: true,
      value: this.check(analyzed.value),
    };
  }

  /** The same steps and order as `checkAnalysis`, with the memo around each module. */
  private check(analysis: Analysis): Revision {
    const { project } = analysis;
    const config = configKey(project.config);
    const graphs = new Map<string, TypeGraph>();
    const interfaces = new Map<string, ModuleInterface>();
    const signatures = new Map<string, string>();
    const modules = new Map<string, CheckedModule>();
    const entries = new Map<string, Entry>();
    const rechecked: string[] = [];
    const diagnostics: Diagnostic[] = [...analysis.diagnostics];
    const texts = new Map<string, string>();

    for (const name of project.order) {
      const info = project.modules.get(name);
      if (info === undefined) continue;
      texts.set(info.path, info.tree.text);
      const reached = reachableModules(analysis, name);
      const importedGraphs = new Map<string, TypeGraph>();
      const visible = new Map<string, ModuleInterface>();
      for (const other of reached) {
        const graph = graphs.get(other);
        if (graph !== undefined) importedGraphs.set(other, graph);
        const iface = interfaces.get(other);
        if (iface !== undefined) visible.set(other, iface);
      }
      const rest = JSON.stringify([
        info.path,
        config,
        analysis.diagnostics.filter((d) => d.span.source === info.path),
        reached.map((other) => [other, signatures.get(other) ?? null]),
      ]);

      let entry = this.entries.get(name);
      if (
        entry === undefined || entry.text !== info.tree.text ||
        entry.rest !== rest
      ) {
        const declarations = checkModuleDeclarations(
          analysis,
          name,
          this.table,
          importedGraphs,
        );
        const graph = buildTypeGraph(declarations);
        const bodies = checkModuleBodies({
          analysis,
          module: name,
          declarations,
          interfaces: visible,
        });
        const built = buildInterface(
          declarations,
          bodies.modes,
          importedGraphs,
        );
        const moduleDiagnostics = normalizeDiagnostics([
          ...declarations.diagnostics,
          ...bodies.diagnostics,
        ]);
        const iface = built.ok ? built.value : undefined;
        entry = {
          text: info.tree.text,
          rest,
          graph,
          iface,
          signature: iface === undefined
            ? `key:${fnv1a64(rest)}:${fnv1a64(info.tree.text)}`
            : fnv1a64(canonicalJson(iface.payload)),
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
            hash: iface?.hash,
            diagnostics: moduleDiagnostics,
          },
        };
        rechecked.push(name);
      }
      entries.set(name, entry);
      graphs.set(name, entry.graph);
      if (entry.iface !== undefined) interfaces.set(name, entry.iface);
      signatures.set(name, entry.signature);
      modules.set(name, entry.checked);
      diagnostics.push(...entry.checked.diagnostics);
    }
    this.entries = entries;
    const checked: CheckedProject = {
      analysis,
      table: this.table,
      modules,
      diagnostics: normalizeDiagnostics(diagnostics),
    };
    return new Revision(
      this.count,
      project,
      checked,
      rechecked,
      entries,
      texts,
    );
  }
}

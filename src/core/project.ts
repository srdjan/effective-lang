// The project: `effektive.json`, module identity, the host registry, the module
// graph, import cycles, and the topological order. Plan section 5.3 states the
// rules. The core reads files only through SourceHost.

import {
  type Diagnostic,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
import { buildIndex, type FileIndex, type ImportEntry } from "./index.ts";
import { stronglyConnectedComponents } from "./modes.ts";
import { parse, type ParseResult } from "./parse.ts";
import type { ReadError, Result, SourceHost, Span } from "./source.ts";
import type { FileMode, SyntaxTree } from "./syntax.ts";
import { compareText, errorMessage, isRecord } from "./util.ts";

export const CONFIG_FILE = "effektive.json";

// ------------------------------------------------------------------ paths

/** Joins a root and a root-relative path. An empty root or "." gives the path itself. */
export function joinPath(root: string, relative: string): string {
  if (root === "" || root === ".") return relative;
  return `${root.replace(/\/+$/, "")}/${relative}`;
}

/**
 * Normalizes a relative path with POSIX separators. Removes `.` segments and
 * resolves `..` segments. Returns undefined when the path is absolute, empty, or
 * leaves the root.
 */
export function normalizeRelative(path: string): string | undefined {
  if (path.startsWith("/") || path.includes("\\")) return undefined;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The module name of a file: its root-relative path without `.eff` or `.effi`. */
export function moduleNameOf(path: string): string {
  if (path.endsWith(".effi")) return path.slice(0, -5);
  if (path.endsWith(".eff")) return path.slice(0, -4);
  return path;
}

/** The generated file of a source path: `x.eff` gives `x.ts`, `x.effi` gives `x.effi.ts`. */
export function generatedPathOf(path: string): string {
  return path.endsWith(".effi") ? `${path}.ts` : `${moduleNameOf(path)}.ts`;
}

// ------------------------------------------------------------------ configuration

interface HostModuleConfig {
  /** Root-relative path of the `.effi` interface file. */
  readonly interfacePath: string;
  /** Root-relative path of the TypeScript module that implements the interface. */
  readonly modulePath: string;
}

interface ImportRuleConfig {
  /** Glob over root-relative module names, without `.eff` or `.effi`. */
  readonly from: string;
  /** Module-name globs or `host:` specifier patterns. */
  readonly allow: readonly string[];
}

export interface ProjectConfig {
  /** Host modules by registry key. The import `host:providers` selects the key `providers`. */
  readonly host: ReadonlyMap<string, HostModuleConfig>;
  /** The first matching rule controls a module. No rules leave imports unrestricted. */
  readonly imports?: readonly ImportRuleConfig[];
}

export type ConfigError =
  | { readonly tag: "missing"; readonly path: string }
  | {
    readonly tag: "unreadable";
    readonly path: string;
    readonly message: string;
  }
  | {
    readonly tag: "malformed-json";
    readonly path: string;
    readonly message: string;
  }
  | {
    readonly tag: "invalid-shape";
    readonly path: string;
    readonly message: string;
  };

export function describeConfigError(error: ConfigError): string {
  switch (error.tag) {
    case "missing":
      return `${error.path} does not exist`;
    case "unreadable":
      return `${error.path} cannot be read: ${error.message}`;
    case "malformed-json":
      return `${error.path} is not valid JSON: ${error.message}`;
    case "invalid-shape":
      return `${error.path} is not a valid project file: ${error.message}`;
  }
}

/** The span of the quoted key `"name"` at or after `from`, or an empty span at 0. */
function keySpan(text: string, name: string, from: number): Span {
  const quoted = JSON.stringify(name);
  const at = text.indexOf(quoted, from);
  return at < 0
    ? { source: CONFIG_FILE, start: 0, end: 0 }
    : { source: CONFIG_FILE, start: at, end: at + quoted.length };
}

const TOP_KEYS: ReadonlySet<string> = new Set(["host", "imports"]);
const HOST_KEYS: ReadonlySet<string> = new Set(["interface", "module"]);
const IMPORT_RULE_KEYS: ReadonlySet<string> = new Set(["from", "allow"]);

function validModulePattern(pattern: string): boolean {
  if (pattern === "" || pattern.startsWith("/") || pattern.includes("\\")) {
    return false;
  }
  const parts = pattern.split("/");
  if (
    parts.some((part) =>
      part === "" || part === "." || part === ".." ||
      (part.includes("*") && part !== "*" && part !== "**") ||
      (part !== "*" && part !== "**" && !/^[A-Za-z0-9_.-]+$/.test(part))
    )
  ) {
    return false;
  }
  const last = parts[parts.length - 1];
  return !last.endsWith(".eff") && !last.endsWith(".effi");
}

function validTargetPattern(pattern: string): boolean {
  if (!pattern.startsWith("host:")) return validModulePattern(pattern);
  const key = pattern.slice(5);
  return key !== "" && (key === "*" || !key.includes("*"));
}

function modulePatternMatches(pattern: string, module: string): boolean {
  const patterns = pattern.split("/");
  const parts = module.split("/");
  const memo = new Map<string, boolean>();
  const matches = (patternIndex: number, partIndex: number): boolean => {
    const key = `${patternIndex}:${partIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (patternIndex === patterns.length) {
      result = partIndex === parts.length;
    } else if (patterns[patternIndex] === "**") {
      result = matches(patternIndex + 1, partIndex) ||
        (partIndex < parts.length && matches(patternIndex, partIndex + 1));
    } else {
      result = partIndex < parts.length &&
        (patterns[patternIndex] === "*" ||
          patterns[patternIndex] === parts[partIndex]) &&
        matches(patternIndex + 1, partIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matches(0, 0);
}

function targetPatternMatches(pattern: string, target: string): boolean {
  if (target.startsWith("host:")) {
    return pattern === "host:*" || pattern === target;
  }
  return !pattern.startsWith("host:") && modulePatternMatches(pattern, target);
}

function importAllowed(
  config: ProjectConfig,
  source: string,
  target: string,
): boolean {
  const rule = config.imports?.find((candidate) =>
    modulePatternMatches(candidate.from, source)
  );
  return rule === undefined ||
    rule.allow.some((pattern) => targetPatternMatches(pattern, target));
}

interface ConfigResult {
  readonly config: ProjectConfig;
  readonly diagnostics: readonly Diagnostic[];
}

/** Parses the text of `effektive.json`. Unknown keys give diagnostics. */
export function parseConfig(
  text: string,
): Result<ConfigResult, ConfigError> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: {
        tag: "malformed-json",
        path: CONFIG_FILE,
        message: errorMessage(e),
      },
    };
  }
  const invalid = (message: string): Result<ConfigResult, ConfigError> => ({
    ok: false,
    error: { tag: "invalid-shape", path: CONFIG_FILE, message },
  });
  if (!isRecord(data)) return invalid("the top level must be an object");
  const diagnostics: Diagnostic[] = [];
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.has(key)) {
      diagnostics.push(makeDiagnostic(
        "module/001",
        `unknown key \`${key}\` in ${CONFIG_FILE}`,
        keySpan(text, key, 0),
      ));
    }
  }
  const importsData = data["imports"];
  let imports: readonly ImportRuleConfig[] | undefined;
  if (importsData !== undefined) {
    if (!Array.isArray(importsData)) {
      return invalid("`imports` must be an array");
    }
    const rules: ImportRuleConfig[] = [];
    let ruleStart = keySpan(text, "imports", 0).start;
    for (let i = 0; i < importsData.length; i++) {
      const entry = importsData[i];
      if (!isRecord(entry)) {
        return invalid(`imports entry ${i + 1} must be an object`);
      }
      const from = entry["from"];
      const allow = entry["allow"];
      if (typeof from !== "string") {
        return invalid(`imports entry ${i + 1} needs a string \`from\``);
      }
      if (!validModulePattern(from)) {
        return invalid(
          `imports entry ${i + 1} has an invalid \`from\` pattern \`${from}\``,
        );
      }
      if (
        !Array.isArray(allow) ||
        !allow.every((value) => typeof value === "string")
      ) {
        return invalid(`imports entry ${i + 1} needs a string array \`allow\``);
      }
      for (const pattern of allow) {
        if (!validTargetPattern(pattern)) {
          return invalid(
            `imports entry ${
              i + 1
            } has an invalid \`allow\` pattern \`${pattern}\``,
          );
        }
      }
      const entryStart = keySpan(text, "from", ruleStart).start;
      for (const field of Object.keys(entry)) {
        if (!IMPORT_RULE_KEYS.has(field)) {
          diagnostics.push(makeDiagnostic(
            "module/001",
            `unknown key \`${field}\` in imports entry ${i + 1}`,
            keySpan(text, field, entryStart),
          ));
        }
      }
      ruleStart = entryStart + 1;
      rules.push({ from, allow });
    }
    imports = rules;
  }
  const hostData = data["host"];
  const host = new Map<string, HostModuleConfig>();
  if (hostData !== undefined) {
    if (!isRecord(hostData)) return invalid("`host` must be an object");
    const hostStart = keySpan(text, "host", 0).start;
    for (const key of Object.keys(hostData)) {
      const entry = hostData[key];
      if (!isRecord(entry)) {
        return invalid(`host entry \`${key}\` must be an object`);
      }
      const entryStart = keySpan(text, key, hostStart).start;
      for (const field of Object.keys(entry)) {
        if (!HOST_KEYS.has(field)) {
          diagnostics.push(makeDiagnostic(
            "module/001",
            `unknown key \`${field}\` in host entry \`${key}\``,
            keySpan(text, field, entryStart),
          ));
        }
      }
      const interfaceValue = entry["interface"];
      const moduleValue = entry["module"];
      if (typeof interfaceValue !== "string") {
        return invalid(`host entry \`${key}\` needs a string \`interface\``);
      }
      if (typeof moduleValue !== "string") {
        return invalid(`host entry \`${key}\` needs a string \`module\``);
      }
      const interfacePath = normalizeRelative(interfaceValue);
      const modulePath = normalizeRelative(moduleValue);
      const interfaceSpan = keySpan(text, "interface", entryStart);
      if (interfacePath === undefined || !interfacePath.endsWith(".effi")) {
        diagnostics.push(makeDiagnostic(
          "module/001",
          `the interface of host entry \`${key}\` must be a path inside the project root that ends in .effi`,
          interfaceSpan,
        ));
        continue;
      }
      if (modulePath === undefined) {
        diagnostics.push(makeDiagnostic(
          "module/001",
          `the module of host entry \`${key}\` must be a path inside the project root`,
          keySpan(text, "module", entryStart),
        ));
        continue;
      }
      host.set(key, { interfacePath, modulePath });
    }
  }
  const config: ProjectConfig = imports === undefined
    ? { host }
    : { host, imports };
  return { ok: true, value: { config, diagnostics } };
}

/** Reads and parses `effektive.json` in the project root. */
export function readConfig(
  host: SourceHost,
  root: string,
): Result<ConfigResult, ConfigError> {
  const path = joinPath(root, CONFIG_FILE);
  const read = host.readText(path);
  if (!read.ok) {
    return {
      ok: false,
      error: read.error.tag === "not-found"
        ? { tag: "missing", path }
        : { tag: "unreadable", path, message: read.error.message },
    };
  }
  return parseConfig(read.value);
}

// ------------------------------------------------------------------ modules

interface ImportLink {
  /** The import declaration in the index of the importing module. */
  readonly entry: ImportEntry;
  /** The imported module's name, or undefined when the import could not be linked. */
  readonly target: string | undefined;
  /** The `Import.module` value of the IR: the module name, or the import string for a host import. */
  readonly label: string | undefined;
  readonly isHost: boolean;
}

export interface ModuleInfo {
  /** The module name: the root-relative path without `.eff` or `.effi`. */
  readonly name: string;
  /** The root-relative path. Diagnostic spans use it as their source. */
  readonly path: string;
  readonly mode: FileMode;
  readonly tree: SyntaxTree;
  readonly parseDiagnostics: readonly Diagnostic[];
  readonly index: FileIndex;
  /** One link for each import in `index.imports`, in the same order. */
  readonly links: readonly ImportLink[];
}

export interface Project {
  readonly root: string;
  readonly config: ProjectConfig;
  /** Modules by name, in discovery order. */
  readonly modules: ReadonlyMap<string, ModuleInfo>;
  /** For each module name, the sorted names of the modules that it imports. */
  readonly graph: ReadonlyMap<string, readonly string[]>;
  /** Every module name, imported modules before their importers. */
  readonly order: readonly string[];
  /** Configuration, loading, and linking diagnostics. Parse diagnostics are in the modules. */
  readonly diagnostics: readonly Diagnostic[];
}

type LoadFailure =
  | { readonly tag: "read"; readonly error: ReadError }
  | { readonly tag: "conflict"; readonly other: string }
  | { readonly tag: "bad-name" };

/**
 * Module names become part of identities such as `value:users#getUser` and of
 * emitted error tags, so a name may not contain `#` or other special characters.
 */
const MODULE_NAME_PATTERN = /^[A-Za-z0-9_.\/-]+$/;

function describeReadError(error: ReadError): string {
  return error.tag === "not-found"
    ? "the file does not exist"
    : `the file cannot be read: ${error.message}`;
}

function emptySpan(source: string): Span {
  return { source, start: 0, end: 0 };
}

/** The parse tree, parse diagnostics, and declaration index of one file. */
export interface ParsedFile {
  readonly parsed: ParseResult;
  readonly index: FileIndex;
}

/**
 * Turns the text of a file into its parse result. The default parses every time.
 * A memoizing caller returns the earlier result when the text is equal, so that
 * an unchanged file keeps its syntax tree object.
 */
export type FileParser = (path: string, text: string) => ParsedFile;

export const parseFileFresh: FileParser = (path, text) => {
  const parsed = parse(path, text);
  return { parsed, index: buildIndex(parsed.tree) };
};

interface LoadedFile {
  readonly path: string;
  readonly name: string;
  readonly parsed: ParseResult;
  readonly index: FileIndex;
}

class Loader {
  readonly modules = new Map<string, ModuleInfo>();
  readonly diagnostics: Diagnostic[] = [];
  private readonly pathOfName = new Map<string, string>();
  private readonly failures = new Map<string, LoadFailure>();
  /** The loaded files in load order. The loop in `run` appends to it. */
  private readonly queue: LoadedFile[] = [];
  private readonly loaded = new Set<string>();

  constructor(
    private readonly host: SourceHost,
    private readonly root: string,
    private readonly config: ProjectConfig,
    private readonly parseFile: FileParser,
  ) {}

  /** Loads a file once. Returns the failure when the file cannot be used. */
  private ensure(path: string): LoadFailure | undefined {
    if (this.loaded.has(path)) return undefined;
    const failed = this.failures.get(path);
    if (failed !== undefined) return failed;
    const name = moduleNameOf(path);
    if (!MODULE_NAME_PATTERN.test(name)) {
      const failure: LoadFailure = { tag: "bad-name" };
      this.failures.set(path, failure);
      return failure;
    }
    const owner = this.pathOfName.get(name);
    if (owner !== undefined && owner !== path) {
      const failure: LoadFailure = { tag: "conflict", other: owner };
      this.failures.set(path, failure);
      return failure;
    }
    const read = this.host.readText(joinPath(this.root, path));
    if (!read.ok) {
      const failure: LoadFailure = { tag: "read", error: read.error };
      this.failures.set(path, failure);
      return failure;
    }
    const { parsed, index } = this.parseFile(path, read.value);
    this.pathOfName.set(name, path);
    this.loaded.add(path);
    this.queue.push({ path, name, parsed, index });
    return undefined;
  }

  private reportFailure(path: string, failure: LoadFailure, span: Span): void {
    if (failure.tag === "conflict") {
      this.diagnostics.push(makeDiagnostic(
        "module/001",
        `${path} and ${failure.other} have the same module name`,
        span,
      ));
    } else if (failure.tag === "bad-name") {
      this.diagnostics.push(makeDiagnostic(
        "module/001",
        `the module path ${path} may contain only letters, digits, and _ . - /`,
        span,
      ));
    } else {
      this.diagnostics.push(makeDiagnostic(
        "module/002",
        `cannot load ${path}: ${describeReadError(failure.error)}`,
        span,
      ));
    }
  }

  private reportForbidden(importer: string, target: string, span: Span): void {
    const source = moduleNameOf(importer);
    if (importAllowed(this.config, source, target)) return;
    this.diagnostics.push(makeDiagnostic(
      "module/005",
      `module \`${source}\` cannot import \`${target}\` under the project import rules`,
      span,
    ));
  }

  addEntry(raw: string): void {
    const path = normalizeRelative(raw);
    if (path === undefined) {
      this.diagnostics.push(makeDiagnostic(
        "module/001",
        `the entry path \`${raw}\` is not a path inside the project root`,
        emptySpan(raw),
      ));
      return;
    }
    if (!path.endsWith(".eff") && !path.endsWith(".effi")) {
      this.diagnostics.push(makeDiagnostic(
        "module/001",
        `the entry path \`${path}\` does not end in .eff or .effi`,
        emptySpan(path),
      ));
      return;
    }
    const failure = this.ensure(path);
    if (failure !== undefined) {
      this.reportFailure(path, failure, emptySpan(path));
    }
  }

  private linkImport(importer: string, entry: ImportEntry): ImportLink {
    const unlinked: ImportLink = {
      entry,
      target: undefined,
      label: undefined,
      isHost: false,
    };
    const specifier = entry.specifier;
    const span = entry.specifierSpan;
    if (specifier === undefined || span === undefined) return unlinked;
    const bad = (message: string): ImportLink => {
      this.diagnostics.push(makeDiagnostic("module/001", message, span));
      return unlinked;
    };
    if (specifier.startsWith("host:")) {
      const key = specifier.slice(5);
      const registered = this.config.host.get(key);
      if (registered === undefined) {
        this.diagnostics.push(makeDiagnostic(
          "module/002",
          `host module \`${key}\` is not registered in ${CONFIG_FILE}`,
          span,
        ));
        return { ...unlinked, isHost: true };
      }
      const failure = this.ensure(registered.interfacePath);
      if (failure !== undefined) {
        this.reportFailure(registered.interfacePath, failure, span);
        return { ...unlinked, isHost: true };
      }
      this.reportForbidden(importer, specifier, span);
      return {
        entry,
        target: moduleNameOf(registered.interfacePath),
        label: specifier,
        isHost: true,
      };
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return bad(
        `import \`${specifier}\` must start with ./ or ../, or use the host: prefix`,
      );
    }
    if (!specifier.endsWith(".eff")) {
      return bad(`relative import \`${specifier}\` must end in .eff`);
    }
    const dir = dirName(importer);
    const resolved = normalizeRelative(
      dir === "" ? specifier : `${dir}/${specifier}`,
    );
    if (resolved === undefined) {
      return bad(`import \`${specifier}\` leaves the project root`);
    }
    const failure = this.ensure(resolved);
    if (failure !== undefined) {
      this.reportFailure(resolved, failure, span);
      return unlinked;
    }
    const name = moduleNameOf(resolved);
    this.reportForbidden(importer, name, span);
    return { entry, target: name, label: name, isHost: false };
  }

  /** Loads every module that the entries reach and builds the module records in load order. */
  run(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const { path, name, parsed, index } = this.queue[i];
      this.modules.set(name, {
        name,
        path,
        mode: parsed.tree.mode,
        tree: parsed.tree,
        parseDiagnostics: parsed.diagnostics,
        index,
        links: index.imports.map((entry) => this.linkImport(path, entry)),
      });
    }
  }
}

// ------------------------------------------------------------------ graph

interface GraphResult {
  readonly graph: ReadonlyMap<string, readonly string[]>;
  readonly order: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Builds the graph, finds cycles with strongly connected components, and orders the modules. */
function linkModules(
  modules: ReadonlyMap<string, ModuleInfo>,
): GraphResult {
  const sorted = [...modules].sort(([a], [b]) => compareText(a, b));
  const names = sorted.map(([name]) => name);
  const graph = new Map<string, readonly string[]>();
  const targetLists: (readonly string[])[] = [];
  for (const [name, info] of sorted) {
    const targets = new Set<string>();
    for (const link of info.links) {
      if (link.target !== undefined && modules.has(link.target)) {
        targets.add(link.target);
      }
    }
    const list = [...targets].sort(compareText);
    graph.set(name, list);
    targetLists.push(list);
  }

  // Module names are sorted, so ascending indexes keep the order of `names`.
  const position = new Map<string, number>();
  names.forEach((name, i) => position.set(name, i));
  const edges = targetLists.map((targets) =>
    targets.flatMap((target) => position.get(target) ?? [])
  );
  const order: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const indexes of stronglyConnectedComponents(names.length, edges)) {
    const component = indexes.map((i) => names[i]);
    order.push(...component);
    const selfLoop = component.length === 1 &&
      targetLists[indexes[0]].includes(component[0]);
    if (component.length > 1 || selfLoop) {
      diagnostics.push(cycleDiagnostic(modules, component));
    }
  }
  return { graph, order, diagnostics };
}

function cycleDiagnostic(
  modules: ReadonlyMap<string, ModuleInfo>,
  component: readonly string[],
): Diagnostic {
  const members = new Set(component);
  const first = modules.get(component[0]);
  if (first === undefined) {
    throw new Error(
      `internal: the cycle names an unknown module ${component[0]}`,
    );
  }
  const link = first.links.find((l) =>
    l.target !== undefined && members.has(l.target) &&
    l.entry.specifierSpan !== undefined
  );
  const span = link?.entry.specifierSpan ?? emptySpan(first.path);
  const cycle = component.length === 1
    ? `${component[0]} imports itself`
    : `import cycle: ${component.join(" -> ")} -> ${component[0]}`;
  return makeDiagnostic("module/003", cycle, span);
}

// ------------------------------------------------------------------ entry

/**
 * Reads the project file, loads the entry files and every module they import,
 * builds the module graph, and orders the modules. Entry paths are relative to
 * the root. A missing or malformed project file is an error value. Other
 * problems are diagnostics in the project. The optional `parseFile` replaces
 * the parser, for memoization (part A7).
 */
export function loadProject(
  host: SourceHost,
  root: string,
  entries: readonly string[],
  parseFile: FileParser = parseFileFresh,
): Result<Project, ConfigError> {
  const configResult = readConfig(host, root);
  if (!configResult.ok) return configResult;
  const { config } = configResult.value;
  const loader = new Loader(host, root, config, parseFile);
  for (const entry of entries) loader.addEntry(entry);
  loader.run();
  const linked = linkModules(loader.modules);
  return {
    ok: true,
    value: {
      root,
      config,
      modules: loader.modules,
      graph: linked.graph,
      order: linked.order,
      diagnostics: normalizeDiagnostics([
        ...configResult.value.diagnostics,
        ...loader.diagnostics,
        ...linked.diagnostics,
      ]),
    },
  };
}

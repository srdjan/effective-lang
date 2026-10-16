// Shared helpers for the tests. Tests may use Deno APIs; the core may not.

import {
  type Diagnostic,
  DIAGNOSTIC_CODES,
  type DiagnosticCode,
} from "../src/core/diagnostics.ts";
import { parse } from "../src/core/parse.ts";
import {
  lineStarts,
  memoryHost,
  positionOf,
  type SourceHost,
} from "../src/core/source.ts";
import { analyzeProject } from "../src/core/analyze.ts";
import { checkAnalysis, checkProject } from "../src/core/check_project.ts";
import { emitProject, type EmittedModule } from "../src/core/emit/emit.ts";
import { lowerProject } from "../src/core/lower.ts";
import type { ModeMap } from "../src/core/check.ts";
import type { Execution, ValueId } from "../src/core/ir.ts";
import {
  childrenOf,
  hasProblem,
  kindName,
  kindOf,
  type NodeId,
  nodeText,
  SyntaxKind,
  type SyntaxTree,
} from "../src/core/syntax.ts";
import { TokenKind } from "../src/core/lex.ts";

export const FIXTURES = new URL("../fixtures/", import.meta.url);

export interface FixtureFile {
  /** Path relative to the fixtures directory, with `/` separators. */
  readonly path: string;
  readonly text: string;
}

/** Lists files under a fixtures subdirectory whose names match, sorted by path. */
export function listFixtures(dir: string, pattern: RegExp): FixtureFile[] {
  const result: FixtureFile[] = [];
  const walk = (relative: string) => {
    const url = new URL(relative + "/", FIXTURES);
    for (const entry of Deno.readDirSync(url)) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        walk(child);
      } else if (pattern.test(entry.name)) {
        result.push({
          path: child,
          text: Deno.readTextFileSync(new URL(child, FIXTURES)),
        });
      }
    }
  };
  walk(dir);
  return result.sort((
    a,
    b,
  ) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface Marker {
  /** One-based line that the diagnostic span must start on. */
  readonly line: number;
  readonly code: string;
}

const MARKER = /^\s*\/\/ error: (\S+)\s*$/;

/**
 * Reads error markers. A run of marker lines applies to the first line below
 * the run. A marker at the end of the file has no line below it and is a test error.
 */
export function readMarkers(text: string): Marker[] {
  const lines = text.split(/\r\n|\n|\r/);
  const markers: Marker[] = [];
  let pending: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = MARKER.exec(lines[i]);
    if (match) {
      pending.push(match[1]);
      continue;
    }
    for (const code of pending) markers.push({ line: i + 1, code });
    pending = [];
  }
  if (pending.length > 0) throw new Error("a marker has no line below it");
  return markers;
}

/** The line and code of each diagnostic, in `line code` form, sorted. */
export function actualMarkers(
  text: string,
  diagnostics: readonly Diagnostic[],
): string[] {
  const starts = lineStarts(text);
  return diagnostics
    .map((d) => `${positionOf(starts, text, d.span.start).line} ${d.code}`)
    .sort();
}

export function expectedMarkers(markers: readonly Marker[]): string[] {
  return markers.map((m) => `${m.line} ${m.code}`).sort();
}

export function modeOfFixture(path: string): "eff" | "effi" {
  return path.endsWith(".effi") ? "effi" : "eff";
}

export function parseFixture(file: FixtureFile) {
  return parse(file.path, file.text, modeOfFixture(file.path));
}

export function syntaxCodes(): DiagnosticCode[] {
  return (Object.keys(DIAGNOSTIC_CODES) as DiagnosticCode[]).filter((c) =>
    c.startsWith("syntax/")
  );
}

/**
 * Checks structural invariants of a tree. Returns a list of problems; an empty
 * list means the tree is sound. The leaves, in order, must be every token once.
 */
export function treeProblems(tree: SyntaxTree): string[] {
  const problems: string[] = [];
  const { lexed } = tree;
  let nextToken = 0;
  const seen = new Uint8Array(tree.count);

  const visit = (node: NodeId, parent: NodeId, depthGuard: number) => {
    if (depthGuard > 5000) {
      problems.push("tree too deep");
      return;
    }
    if (seen[node]) problems.push(`node ${node} appears twice`);
    seen[node] = 1;
    if (tree.parents[node] !== parent) {
      problems.push(
        `node ${node} has parent ${tree.parents[node]}, expected ${parent}`,
      );
    }
    if (tree.starts[node] > tree.ends[node]) {
      problems.push(`node ${node} has start after end`);
    }
    const kind = kindOf(tree, node);
    if (kind === SyntaxKind.Token) {
      const t = tree.tokens[node];
      if (t !== nextToken) {
        problems.push(`token leaf ${t} out of order, expected ${nextToken}`);
      }
      nextToken = t + 1;
      if (
        tree.starts[node] !== lexed.starts[t] ||
        tree.ends[node] !== lexed.ends[t]
      ) {
        problems.push(`token leaf ${t} has the wrong span`);
      }
      if (tree.childEnd[node] !== tree.childStart[node]) {
        problems.push("a token has children");
      }
      return;
    }
    if (kind === SyntaxKind.Missing && tree.starts[node] !== tree.ends[node]) {
      problems.push("a Missing node has width");
    }
    for (const child of childrenOf(tree, node)) {
      if (
        kindOf(tree, child) !== SyntaxKind.Token &&
        kindOf(tree, child) !== SyntaxKind.Missing
      ) {
        if (
          tree.starts[child] < tree.starts[node] ||
          tree.ends[child] > tree.ends[node]
        ) {
          problems.push(
            `${kindName(kindOf(tree, child))} ${tree.starts[child]}-${
              tree.ends[child]
            } escapes ` +
              `${kindName(kind)} ${tree.starts[node]}-${tree.ends[node]}`,
          );
        }
      }
      visit(child, node, depthGuard + 1);
    }
  };
  visit(tree.root, -1, 0);
  if (nextToken !== lexed.count) {
    problems.push(
      `tree holds ${nextToken} tokens, lexer produced ${lexed.count}`,
    );
  }
  for (let i = 0; i < tree.count; i++) {
    if (!seen[i]) problems.push(`node ${i} is not reachable`);
  }
  return problems;
}

export interface DeclSummary {
  readonly kind: string;
  /** The text of the declaration's first Name child, or "" when absent. */
  readonly name: string;
  readonly broken: boolean;
}

/** One entry for each child of the module that is not a token. */
export function declSummaries(tree: SyntaxTree): DeclSummary[] {
  const result: DeclSummary[] = [];
  for (const child of childrenOf(tree, tree.root)) {
    const kind = kindOf(tree, child);
    if (kind === SyntaxKind.Token) continue;
    let name = "";
    for (const grandchild of childrenOf(tree, child)) {
      if (kindOf(tree, grandchild) === SyntaxKind.Name) {
        name = nodeText(tree, grandchild);
        break;
      }
    }
    result.push({
      kind: kindName(kind),
      name,
      broken: hasProblem(tree, child),
    });
  }
  return result;
}

/** Child nodes of `node` that are not tokens or Missing nodes. */
export function nodeChildren(tree: SyntaxTree, node: NodeId): NodeId[] {
  return [...childrenOf(tree, node)].filter((c) => {
    const kind = kindOf(tree, c);
    return kind !== SyntaxKind.Token && kind !== SyntaxKind.Missing;
  });
}

/** A compact bracketed form of an expression: shows grouping and operators. */
export function sexp(tree: SyntaxTree, node: NodeId): string {
  const kind = kindOf(tree, node);
  const kids = nodeChildren(tree, node);
  switch (kind) {
    case SyntaxKind.NameExpr:
    case SyntaxKind.LiteralExpr:
    case SyntaxKind.Name:
    case SyntaxKind.QualifiedName:
      return nodeText(tree, node);
    case SyntaxKind.ParenExpr:
      return sexp(tree, kids[0]);
    case SyntaxKind.BinaryExpr: {
      const op = [...childrenOf(tree, node)].find((c) =>
        kindOf(tree, c) === SyntaxKind.Token &&
        tree.lexed.kinds[tree.tokens[c]] !== TokenKind.Newline
      );
      return `(${sexp(tree, kids[0])} ${nodeText(tree, op!)} ${
        sexp(tree, kids[1])
      })`;
    }
    case SyntaxKind.PipeExpr:
      return `(${sexp(tree, kids[0])} |> ${sexp(tree, kids[1])})`;
    case SyntaxKind.PipeStage:
      return kids.map((k) => sexp(tree, k)).join("");
    case SyntaxKind.CallExpr:
      return `${sexp(tree, kids[0])}${sexp(tree, kids[1])}`;
    case SyntaxKind.ArgList:
      return `(${kids.map((k) => sexp(tree, k)).join(", ")})`;
    case SyntaxKind.FieldExpr:
      return `${sexp(tree, kids[0])}.${sexp(tree, kids[1])}`;
    default:
      return `<${kindName(kind)}>`;
  }
}

/** Finds the first node of `kind` in pre-order. */
export function findFirst(
  tree: SyntaxTree,
  kind: SyntaxKind,
): NodeId | undefined {
  const stack: NodeId[] = [tree.root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (kindOf(tree, n) === kind) return n;
    const kids = childrenOf(tree, n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return undefined;
}

/** Finds the initializer expression of a top-level `const name = ...` declaration. */
export function constInitializer(tree: SyntaxTree, name: string): NodeId {
  for (const decl of childrenOf(tree, tree.root)) {
    if (kindOf(tree, decl) !== SyntaxKind.ConstDecl) continue;
    const kids = [...childrenOf(tree, decl)];
    const nameNode = kids.find((k) => kindOf(tree, k) === SyntaxKind.Name);
    if (nameNode === undefined || nodeText(tree, nameNode) !== name) continue;
    const initializer = kids.filter((k) => {
      const kind = kindOf(tree, k);
      return kind !== SyntaxKind.Token && kind !== SyntaxKind.Name &&
        kind !== SyntaxKind.Missing;
    }).pop();
    if (initializer === undefined) {
      throw new Error(`const ${name} has no initializer`);
    }
    return initializer;
  }
  throw new Error(`no const named ${name}`);
}

/** A host that reads files under `fixtures/`. Paths are relative to that directory. */
export function diskHost(): SourceHost {
  return {
    readText(path: string) {
      try {
        return {
          ok: true,
          value: Deno.readTextFileSync(new URL(path, FIXTURES)),
        };
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
          return { ok: false, error: { tag: "not-found", path } };
        }
        return {
          ok: false,
          error: {
            tag: "unreadable",
            path,
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    },
  };
}

/** Root-relative paths of every `.eff` file under a fixtures directory, sorted. */
export function listEffFiles(root: string): string[] {
  return listFixtures(root, /\.eff$/).map((f) => f.path.slice(root.length + 1));
}

/**
 * One error fixture case. A single file in `fixtures/errors/` is a case with one
 * file. A directory `fixtures/errors/<category>-<topic>/` with its own
 * `effective.json` is a project case.
 */
export interface ErrorCase {
  /** `errors/<name>` without a trailing slash. */
  readonly path: string;
  readonly kind: "file" | "project";
  /** The name without the directory and without the extension of a single file. */
  readonly name: string;
  /** Marked files, with paths relative to the project root (or the file name itself). */
  readonly files: readonly FixtureFile[];
}

export function listErrorCases(): ErrorCase[] {
  const cases: ErrorCase[] = [];
  const dir = new URL("errors/", FIXTURES);
  for (const entry of Deno.readDirSync(dir)) {
    const path = `errors/${entry.name}`;
    if (entry.isDirectory) {
      const files = listFixtures(path, /\.effi?$/).map((f) => ({
        path: f.path.slice(path.length + 1),
        text: f.text,
      }));
      cases.push({ path, kind: "project", name: entry.name, files });
    } else if (/\.effi?$/.test(entry.name)) {
      cases.push({
        path,
        kind: "file",
        name: entry.name.replace(/\.effi?$/, ""),
        files: [{
          path: entry.name,
          text: Deno.readTextFileSync(new URL(path, FIXTURES)),
        }],
      });
    }
  }
  return cases.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The diagnostics that a case produces. A single file whose name starts with
 * `syntax-` is only parsed. Every other case goes through the project loader, the
 * resolver, and the declaration checker. A single file runs as a one-file
 * project with an empty `effective.json`.
 */
export function diagnosticsOfCase(c: ErrorCase): Diagnostic[] {
  if (c.kind === "file" && c.name.startsWith("syntax-")) {
    return [...parseFixture(c.files[0]).diagnostics];
  }
  if (c.kind === "file") {
    const file = c.files[0];
    const host = memoryHost({ "effective.json": "{}", [file.path]: file.text });
    const result = analyzeProject(host, "", [file.path]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return [...checkAnalysis(result.value).diagnostics];
  }
  const entries = c.files.filter((f) => f.path.endsWith(".eff")).map((f) =>
    f.path
  );
  const result = analyzeProject(diskHost(), c.path, entries);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return [...checkAnalysis(result.value).diagnostics];
}

/** `path:line code` for each diagnostic, sorted. The path is the diagnostic's source. */
export function caseActual(
  c: ErrorCase,
  diagnostics: readonly Diagnostic[],
): string[] {
  const texts = new Map(c.files.map((f) => [f.path, f.text]));
  return diagnostics
    .map((d) => {
      const text = texts.get(d.span.source) ?? "";
      const line = positionOf(lineStarts(text), text, d.span.start).line;
      return `${d.span.source}:${line} ${d.code}`;
    })
    .sort();
}

export function caseExpected(c: ErrorCase): string[] {
  const result: string[] = [];
  for (const f of c.files) {
    for (const m of readMarkers(f.text)) {
      result.push(`${f.path}:${m.line} ${m.code}`);
    }
  }
  return result.sort();
}

/** The text of every file of `fixtures/examples/`, keyed by its root-relative path. */
export function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (
    const path of [
      "effective.json",
      "collections.eff",
      "log.eff",
      "main.eff",
      "pay.eff",
      "users.eff",
      "host/providers.effi",
    ]
  ) {
    files[path] = Deno.readTextFileSync(new URL(`examples/${path}`, FIXTURES));
  }
  return files;
}

/** Entry files of the examples: every `.eff` file. */
export const EXAMPLE_ENTRIES: readonly string[] = [
  "collections.eff",
  "log.eff",
  "main.eff",
  "pay.eff",
  "users.eff",
];

/** The modes that the plan names for the five examples, for the functions with empty sets. */
export const EXAMPLE_MODES: ModeMap = new Map<ValueId, Execution>([
  ["value:log#log", "effect"],
  ["value:collections#activeNames", "pure"],
  ["value:collections#total", "pure"],
  ["value:users#getUser", "effect"],
  ["value:users#rename", "effect"],
  ["value:users#displayName", "effect"],
  ["value:users#activeNames", "effect"],
  ["value:pay#findOrder", "effect"],
  ["value:pay#chargeOrder", "effect"],
  ["value:pay#markPaid", "pure"],
  ["value:pay#saveOrder", "effect"],
  ["value:pay#pay", "effect"],
  ["value:main#main", "effect"],
]);

// ------------------------------------------------------------------ emitter

/**
 * Checks, lowers, and emits a project held in memory. Every module must check
 * and lower without an error. The result maps each module name to its emitted
 * module.
 */
export function emitFiles(
  files: Record<string, string>,
  entries: readonly string[],
): ReadonlyMap<string, EmittedModule> {
  const checked = checkProject(memoryHost(files), "", entries);
  if (!checked.ok) throw new Error(JSON.stringify(checked.error));
  const project = checked.value;
  if (project.diagnostics.length > 0) {
    throw new Error(
      `diagnostics: ${project.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  const emitted = emitProject(lowerProject(project), {
    config: project.analysis.project.config,
  });
  const result = new Map<string, EmittedModule>();
  for (const [name, module] of emitted) {
    if (!module.ok) throw new Error(JSON.stringify(module.error));
    result.set(name, module.value);
  }
  return result;
}

/** The five examples, emitted in memory. */
export function emitExamples(): ReadonlyMap<string, EmittedModule> {
  return emitFiles(exampleFiles(), EXAMPLE_ENTRIES);
}

/** The files of a fixture project under `fixtures/`: root-relative path to text. */
export function projectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of listFixtures(dir, /\.(eff|effi|json)$/)) {
    files[f.path.slice(dir.length + 1)] = f.text;
  }
  return files;
}

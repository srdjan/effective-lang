// The page logic of the playground that needs no DOM (plan 5.5): the tab from
// the URL hash, the Problems list, the error count of each tab, the state of
// the TypeScript pane, and the hover texts. Fast tests cover each function.

import { lineStarts, positionOf, type Severity } from "../../src/core/mod.ts";
import {
  BACKEND_UNAVAILABLE,
  type PlaygroundHover,
  type PlaygroundResult,
} from "./compile.ts";

/** The tab that opens when the hash names no known file. */
export const DEFAULT_TAB = "main.eff";

/** `decodeURIComponent` that gives undefined for a malformed escape. */
function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * The file that a URL hash selects. The hash looks like `#users.eff` or
 * `#host%2Fproviders.effi`. The result is the decoded path when `paths`
 * contains it, else `DEFAULT_TAB`. A malformed escape gives `DEFAULT_TAB`.
 */
export function tabFromHash(hash: string, paths: readonly string[]): string {
  const path = decode(hash.startsWith("#") ? hash.slice(1) : hash);
  return path !== undefined && paths.includes(path) ? path : DEFAULT_TAB;
}

/** One entry of the Problems list. Line and column are one-based. */
export interface ProblemItem {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly column: number;
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

/**
 * Every diagnostic of every file, sorted by path, then `from`, then `to`.
 * `texts` maps a path to the text that the diagnostic offsets index. A path
 * without text gets line 1 and column 1.
 */
export function problemItems(
  result: PlaygroundResult,
  texts: Readonly<Record<string, string>>,
): ProblemItem[] {
  const items: ProblemItem[] = [];
  for (const [path, diagnostics] of Object.entries(result.diagnostics)) {
    const text = texts[path] ?? "";
    const starts = lineStarts(text);
    for (const d of diagnostics) {
      const position = positionOf(starts, text, d.from);
      items.push({
        path,
        from: d.from,
        to: d.to,
        line: position.line,
        column: position.column,
        severity: d.severity,
        code: d.code,
        message: d.message,
      });
    }
  }
  return items.sort((a, b) =>
    a.path !== b.path
      ? (a.path < b.path ? -1 : 1)
      : a.from !== b.from
      ? a.from - b.from
      : a.to - b.to
  );
}

/**
 * The number of diagnostics with severity `error` in each file. Every path of
 * `result.diagnostics` has an entry, also with count 0.
 */
export function tabCounts(result: PlaygroundResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [path, diagnostics] of Object.entries(result.diagnostics)) {
    counts[path] = diagnostics.filter((d) => d.severity === "error").length;
  }
  return counts;
}

/**
 * What the TypeScript pane shows for a file.
 * `text`: the current output. `stale`: the last good output, while the module
 * has errors. `none`: the module never produced output. `interface`: the file
 * is a host interface file (`.effi`) and has no generated code.
 */
type OutputState =
  | { readonly tag: "text"; readonly text: string }
  | { readonly tag: "stale"; readonly text: string }
  | { readonly tag: "none" }
  | { readonly tag: "interface" };

export function outputState(
  result: PlaygroundResult,
  path: string,
): OutputState {
  if (path.endsWith(".effi")) return { tag: "interface" };
  const output = result.outputs[path];
  if (output === undefined || output === null) return { tag: "none" };
  return output.stale
    ? { tag: "stale", text: output.text }
    : { tag: "text", text: output.text };
}

/** One labelled block of the hover tooltip. `code` is false for a plain message. */
export interface HoverBlock {
  readonly label: string;
  readonly text: string;
  readonly code: boolean;
}

interface HoverLines {
  /** The blocks of the tooltip: the contract, then the backend type when it exists. */
  readonly tooltip: readonly HoverBlock[];
  /** The text of the cursor line: the contract on one line. Empty without a hit. */
  readonly cursor: string;
}

/** The texts of the tooltip and of the cursor line for a hover answer. */
export function hoverLines(hit: PlaygroundHover | undefined): HoverLines {
  if (hit === undefined) return { tooltip: [], cursor: "" };
  const tooltip: HoverBlock[] = [
    { label: "Contract", text: hit.contract, code: true },
  ];
  if (hit.backend !== undefined) {
    tooltip.push({
      label: "Backend type",
      text: hit.backend,
      code: hit.backend !== BACKEND_UNAVAILABLE,
    });
  }
  return {
    tooltip,
    cursor: hit.contract.replace(/\s*\n\s*/g, " ").trim(),
  };
}

/** The extra columns that a wrapped part of a line hangs past its indent. */
export const WRAP_HANG = 2;

/**
 * The columns that each wrapped part of `line` starts at: the leading
 * whitespace of the line plus `WRAP_HANG`. A tab moves to the next multiple of
 * `tabSize`.
 */
export function wrapIndent(line: string, tabSize: number): number {
  let column = 0;
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += tabSize - (column % tabSize);
    else break;
  }
  return column + WRAP_HANG;
}

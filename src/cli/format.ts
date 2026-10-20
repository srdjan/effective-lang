// Output lines. A diagnostic prints as `path:line:column: error code: message`.
// The path is root-relative. The line and the column are one-based, and the
// column counts UTF-16 code units.

import {
  compareText,
  type Diagnostic,
  lineStarts,
  positionOf,
  type Span,
  type TscMapping,
} from "../core/mod.ts";

/** The text of a file by its root-relative path, or undefined. */
export type TextOf = (path: string) => string | undefined;

/** One line: the message of a diagnostic may have several lines, so join them. */
function oneLine(message: string): string {
  return message.split(/\r\n|\n|\r/).map((line) => line.trim()).filter((line) =>
    line !== ""
  ).join(" ");
}

class Positions {
  private readonly starts = new Map<string, Uint32Array>();

  constructor(private readonly textOf: TextOf) {}

  of(path: string, offset: number): { line: number; column: number } {
    const text = this.textOf(path);
    if (text === undefined) return { line: 1, column: 1 };
    let starts = this.starts.get(path);
    if (starts === undefined) {
      starts = lineStarts(text);
      this.starts.set(path, starts);
    }
    return positionOf(starts, text, offset);
  }
}

/** A diagnostic with its printed position. */
interface Located {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

function compareLocated(a: Located, b: Located): number {
  return compareText(a.path, b.path) || a.line - b.line ||
    a.column - b.column || compareText(a.code, b.code) ||
    compareText(a.message, b.message);
}

/** The printed position of the start of `span`, with the code and the message. */
function locate(
  positions: Positions,
  span: Span,
  code: string,
  message: string,
): Located {
  const at = positions.of(span.source, span.start);
  return { path: span.source, line: at.line, column: at.column, code, message };
}

function line(located: Located): string {
  return `${located.path}:${located.line}:${located.column}: error ${located.code}: ${
    oneLine(located.message)
  }`;
}

/** The output lines of the diagnostics, sorted by path, position, and code. */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  textOf: TextOf,
): string[] {
  const positions = new Positions(textOf);
  return diagnostics.map((d) => locate(positions, d.span, d.code, d.message))
    .sort(compareLocated).map(line);
}

/**
 * The output lines of the mapped `deno check` diagnostics. A host-boundary
 * diagnostic prints like any diagnostic. A host-module diagnostic prints at its
 * position in the host module with the code `host-boundary/001`. A source or a
 * generated diagnostic prints with the code `TS<number>`.
 */
export function formatTscMappings(
  mappings: readonly TscMapping[],
  textOf: TextOf,
): string[] {
  const positions = new Positions(textOf);
  const located: Located[] = mappings.map((mapping): Located => {
    switch (mapping.tag) {
      case "host-boundary": {
        const d = mapping.diagnostic;
        return locate(positions, d.span, d.code, d.message);
      }
      case "host-module":
        return {
          path: mapping.file,
          line: mapping.line,
          column: mapping.column,
          code: "host-boundary/001",
          message: mapping.message,
        };
      case "source":
        return locate(
          positions,
          mapping.span,
          `TS${mapping.tsCode}`,
          mapping.message,
        );
      case "generated":
        return {
          path: mapping.file,
          line: mapping.line,
          column: mapping.column,
          code: `TS${mapping.tsCode}`,
          message: mapping.message,
        };
    }
  });
  return located.sort(compareLocated).map(line);
}

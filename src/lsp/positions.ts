// LSP positions and file URIs. A position is a zero-based line and a zero-based
// UTF-16 character, the same unit as a JavaScript string index, so no encoding
// conversion is needed. Line ends follow `lineStarts`: `\n`, `\r\n`, or a lone
// `\r`. A position inside a surrogate pair is not corrected.

import { fromFileUrl, isAbsolute, toFileUrl } from "@std/path";
import { lineIndexOf, lineStarts, type Span } from "../core/mod.ts";
import type { Position, Range, TextChange } from "./protocol.ts";

/** Offset of the end of line `line`, before its terminator. */
function lineEnd(text: string, starts: Uint32Array, line: number): number {
  if (line + 1 >= starts.length) return text.length;
  let end = starts[line + 1];
  if (text.charCodeAt(end - 1) === 0x0a) end--;
  if (end > starts[line] && text.charCodeAt(end - 1) === 0x0d) end--;
  return end;
}

/**
 * Position to string offset. A character past the end of its line gives the
 * line end. A line past the last line gives the text end. A negative value
 * counts as 0.
 */
export function positionToOffset(
  text: string,
  starts: Uint32Array,
  position: Position,
): number {
  if (position.line >= starts.length) return text.length;
  const line = Math.max(0, position.line);
  const start = starts[line];
  return Math.min(
    start + Math.max(0, position.character),
    lineEnd(text, starts, line),
  );
}

/** String offset to position. An offset outside the text clamps; one inside a terminator gives the line end. */
export function offsetToPosition(
  text: string,
  starts: Uint32Array,
  offset: number,
): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const line = lineIndexOf(starts, clamped);
  const end = lineEnd(text, starts, line);
  return { line, character: Math.min(clamped, end) - starts[line] };
}

export function spanToRange(
  text: string,
  starts: Uint32Array,
  span: Span,
): Range {
  return {
    start: offsetToPosition(text, starts, span.start),
    end: offsetToPosition(text, starts, span.end),
  };
}

/**
 * Applies change events in order. A change with a range replaces that range. A
 * change without a range replaces the whole text. A range whose end lies before
 * its start counts as empty at the start.
 */
export function applyContentChanges(
  text: string,
  changes: readonly TextChange[],
): string {
  let current = text;
  for (const change of changes) {
    if (change.range === undefined) {
      current = change.text;
      continue;
    }
    const starts = lineStarts(current);
    const from = positionToOffset(current, starts, change.range.start);
    const to = Math.max(
      from,
      positionToOffset(current, starts, change.range.end),
    );
    current = current.slice(0, from) + change.text + current.slice(to);
  }
  return current;
}

/** The file path of a `file:` URI, or undefined for any other URI or a malformed one. */
export function uriToPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? fromFileUrl(url) : undefined;
  } catch {
    return undefined;
  }
}

/** The `file:` URI of an absolute path, or undefined for a relative path. */
export function pathToUri(path: string): string | undefined {
  return isAbsolute(path) ? toFileUrl(path).href : undefined;
}

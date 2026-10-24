// Diagnostic comparison for speculative edits. Rename and contract actions
// compare the diagnostics before and after an edit. A diagnostic is the same
// when its code, source, and span match, after the span of the old diagnostic
// moves through the edits. The message is not part of the key, because a
// rename changes names in messages.
import type { Diagnostic } from "./diagnostics.ts";
import type { SourceEdit } from "./source.ts";

/** The diagnostics that an edit adds and removes, by code, source, and moved span. */
export interface DiagnosticDelta {
  readonly added: readonly Diagnostic[];
  readonly removed: readonly Diagnostic[];
}

/**
 * Move one offset of `source` through `edits`. An edit moves the offset by its
 * length change when the edit ends at or before the offset. An offset inside an
 * edit does not move. An empty edit at the offset moves a start, not an end.
 */
function movedOffset(
  offset: number,
  source: string,
  edits: readonly SourceEdit[],
  isEnd: boolean,
): number {
  let shift = 0;
  for (const edit of edits) {
    if (edit.span.source !== source) continue;
    const { start, end } = edit.span;
    const passed = isEnd && start === end ? end < offset : end <= offset;
    if (passed) shift += edit.text.length - (end - start);
  }
  return offset + shift;
}

function keyOf(
  d: Diagnostic,
  edits: readonly SourceEdit[],
  move: boolean,
): string {
  const { source, start, end } = d.span;
  return JSON.stringify([
    d.code,
    source,
    move ? movedOffset(start, source, edits, false) : start,
    move ? movedOffset(end, source, edits, true) : end,
  ]);
}

function counts(keys: readonly string[]): Map<string, number> {
  const output = new Map<string, number>();
  for (const key of keys) output.set(key, (output.get(key) ?? 0) + 1);
  return output;
}

/** Keep each item whose key has no unused match in `pool`. Each match is used once. */
function unmatched(
  items: readonly Diagnostic[],
  keys: readonly string[],
  pool: Map<string, number>,
): readonly Diagnostic[] {
  return items.filter((_, i) => {
    const left = pool.get(keys[i]) ?? 0;
    if (left === 0) return true;
    pool.set(keys[i], left - 1);
    return false;
  });
}

/**
 * Compare the diagnostics before and after `edits`, as multisets. Both lists
 * keep the order of their input. Two equal diagnostics count twice.
 */
export function diagnosticDelta(
  before: readonly Diagnostic[],
  after: readonly Diagnostic[],
  edits: readonly SourceEdit[],
): DiagnosticDelta {
  const beforeKeys = before.map((d) => keyOf(d, edits, true));
  const afterKeys = after.map((d) => keyOf(d, edits, false));
  return {
    added: unmatched(after, afterKeys, counts(beforeKeys)),
    removed: unmatched(before, beforeKeys, counts(afterKeys)),
  };
}

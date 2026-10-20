// The span table (plan section 6.7, part A6b). The emitter records the
// generated range of every printed node together with the source span of the
// node. The span table answers one question: which source span does a
// generated position belong to? A `tsc` diagnostic and a source map both use
// the answer.
//
// The table is a plain sorted array plus parent links. It is pure data. The
// functions in this file are pure and synchronous.

import type { Span } from "../ir.ts";
import { lineIndexOf, lineStarts } from "../source.ts";
import type { Project } from "../project.ts";
import type { SpanRecord } from "./doc.ts";
import type { EmittedModule, HostAssertionRecord } from "./emit.ts";

/** A host assertion with the span of the Effective import that binds the provider. */
interface HostAssertionEntry extends HostAssertionRecord {
  /**
   * The span of the imported name in the `.eff` import declaration, for
   * example `UsersLive` in `import { UsersLive } from "host:providers"`.
   * Undefined when the caller supplied no import span for the name.
   */
  readonly importSpan: Span | undefined;
}

export interface SpanTable {
  readonly module: string;
  /** The generated file, relative to the project root: `users.ts`. */
  readonly path: string;
  /** The length of the generated text in UTF-16 code units. */
  readonly textLength: number;
  /** Offsets of the line starts of the generated text. */
  readonly lineStarts: Uint32Array;
  /**
   * The non-empty records, outermost first: ascending start, then descending
   * end. Of two records with one range, the outer record comes first.
   */
  readonly records: readonly SpanRecord[];
  /** For each record, the index of the smallest record that contains it, or -1. */
  readonly parents: readonly number[];
  readonly hostAssertions: readonly HostAssertionEntry[];
}

/**
 * Builds the span table of one emitted module. `importSpans` maps the name
 * that the `.eff` source binds in a host import to the span of that name. Use
 * `hostImportSpans(project).get(emitted.module)`.
 */
export function buildSpanTable(
  emitted: EmittedModule,
  importSpans: ReadonlyMap<string, Span> = new Map(),
): SpanTable {
  // The renderer lists the records in the order in which they close, so of two
  // records with one range the inner record comes first.
  const indexed = emitted.spans
    .map((record, closed) => ({ record, closed }))
    .filter(({ record }) => record.end > record.start);
  indexed.sort((a, b) =>
    a.record.start !== b.record.start
      ? a.record.start - b.record.start
      : a.record.end !== b.record.end
      ? b.record.end - a.record.end
      : b.closed - a.closed
  );
  const records = indexed.map((entry) => entry.record);
  const parents: number[] = [];
  const open: number[] = [];
  records.forEach((record, i) => {
    while (
      open.length > 0 && records[open[open.length - 1]].end <= record.start
    ) {
      open.pop();
    }
    parents.push(open.length === 0 ? -1 : open[open.length - 1]);
    open.push(i);
  });
  return {
    module: emitted.module,
    path: emitted.path,
    textLength: emitted.text.length,
    lineStarts: lineStarts(emitted.text),
    records,
    parents,
    hostAssertions: emitted.hostAssertions.map((assertion) => ({
      ...assertion,
      importSpan: importSpans.get(assertion.local),
    })),
  };
}

/**
 * The span of each imported name in the host imports of each module:
 * module name to local name to span. The `.eff` source binds the local name.
 */
export function hostImportSpans(
  project: Project,
): ReadonlyMap<string, ReadonlyMap<string, Span>> {
  const result = new Map<string, ReadonlyMap<string, Span>>();
  for (const [name, info] of project.modules) {
    const names = new Map<string, Span>();
    for (const link of info.links) {
      if (!link.isHost) continue;
      for (const imported of link.entry.names) {
        names.set(imported.name, imported.span);
      }
    }
    if (names.size > 0) result.set(name, names);
  }
  return result;
}

/**
 * The innermost record that contains the offset, or undefined. A position
 * outside every record is not mapped. The file header, the imports, the
 * helpers, the host assertions, and the blank lines between declarations lie
 * outside every record. Every position inside a declaration lies inside the
 * record of that declaration at least, so it maps to the declaration at worst.
 */
export function recordAtOffset(
  table: SpanTable,
  offset: number,
): SpanRecord | undefined {
  const records = table.records;
  // The last record that starts at or before the offset.
  let lo = 0;
  let hi = records.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // That record, or one of its ancestors, contains the offset: records nest.
  while (found >= 0 && records[found].end <= offset) {
    found = table.parents[found];
  }
  return found < 0 ? undefined : records[found];
}

/** The source span of the innermost record that contains a generated offset. */
export function mapOffset(table: SpanTable, offset: number): Span | undefined {
  return recordAtOffset(table, offset)?.span;
}

/**
 * The offset of a generated position, or undefined when the line does not
 * exist or the column lies past the end of the text. The line and the column
 * are one-based, as in `tsc` and in the diagnostic format. The column counts
 * UTF-16 code units.
 */
export function offsetOfGenerated(
  table: SpanTable,
  line: number,
  column: number,
): number | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(column)) return undefined;
  if (line < 1 || line > table.lineStarts.length || column < 1) {
    return undefined;
  }
  const offset = table.lineStarts[line - 1] + column - 1;
  return offset > table.textLength ? undefined : offset;
}

/**
 * The source span of a generated position. The line and the column are
 * one-based. Returns undefined for a position that lies outside the text or
 * outside every record.
 */
export function mapGenerated(
  table: SpanTable,
  line: number,
  column: number,
): Span | undefined {
  const offset = offsetOfGenerated(table, line, column);
  return offset === undefined ? undefined : mapOffset(table, offset);
}

/** The host assertion whose generated range contains the offset. */
export function hostAssertionAtOffset(
  table: SpanTable,
  offset: number,
): HostAssertionEntry | undefined {
  return table.hostAssertions.find((a) => offset >= a.start && offset < a.end);
}

/** The zero-based line and column of an offset in a text, for source maps. */
export function zeroBasedPosition(
  starts: Uint32Array,
  textLength: number,
  offset: number,
): { readonly line: number; readonly column: number } {
  const clamped = Math.max(0, Math.min(offset, textLength));
  const line = lineIndexOf(starts, clamped);
  return { line, column: clamped - starts[line] };
}

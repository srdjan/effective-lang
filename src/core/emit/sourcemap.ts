// Source maps (plan section 6.7, part A6b). A version 3 source map for one
// generated module, derived from its span table. The file also holds a base64
// VLQ encoder and decoder. The core has no dependencies, so it has its own.
//
// What the map says. A position of the generated text maps to the start of the
// source span of its innermost record, which is exactly what `mapOffset` of
// the span table returns. A position outside every record has no mapping. The
// map holds one segment at every record start, at every record end, and at
// the start of every generated line, because a segment does not continue past
// a line break. Consecutive segments with equal targets are merged.
//
// Source lines and columns are zero-based UTF-16 positions, as the source map
// format and JavaScript tooling expect.

import type { Result } from "../ir.ts";
import { lineIndexOf, lineStarts } from "../source.ts";
import { relativeSpecifier } from "./scope.ts";
import { recordAtOffset, type SpanTable, zeroBasedPosition } from "./spans.ts";

// ------------------------------------------------------------------ base64 VLQ

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  [...BASE64].map((char, value) => [char, value]),
);
const CONTINUATION = 32;
const DIGIT_MASK = 31;

/** Encodes one integer as base64 VLQ: the sign in the lowest bit, five bits for each digit. */
export function encodeVlq(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`cannot encode ${value} as VLQ`);
  }
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = "";
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest > 0) digit |= CONTINUATION;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

export type VlqError =
  | { readonly tag: "bad-character"; readonly index: number }
  | { readonly tag: "truncated"; readonly index: number };

/** Decodes the integers in `text`. The text holds only VLQ digits. */
export function decodeVlqList(text: string): Result<number[], VlqError> {
  const values: number[] = [];
  let acc = 0;
  let scale = 1;
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const digit = BASE64_VALUES.get(text[i]);
    if (digit === undefined) {
      return { ok: false, error: { tag: "bad-character", index: i } };
    }
    acc += (digit & DIGIT_MASK) * scale;
    if ((digit & CONTINUATION) !== 0) {
      scale *= 32;
      open = true;
      continue;
    }
    values.push(acc % 2 === 1 ? -(acc - 1) / 2 : acc / 2);
    acc = 0;
    scale = 1;
    open = false;
  }
  if (open) {
    return { ok: false, error: { tag: "truncated", index: text.length } };
  }
  return { ok: true, value: values };
}

// ------------------------------------------------------------------ the map

export interface SourceMapV3 {
  readonly version: 3;
  /** The generated file, without its directory: `users.ts`. */
  readonly file: string;
  /** The `.eff` files, relative to the directory of the map. */
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

export type SourceMapError = {
  readonly tag: "missing-source";
  readonly source: string;
};

export interface SourceMapOptions {
  /** Add the source texts as `sourcesContent`. Default: false. */
  readonly includeContent?: boolean;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The path of `source` relative to the directory of the generated file `path`. */
function relativeSource(path: string, source: string): string {
  const specifier = relativeSpecifier(path, source);
  return specifier.startsWith("./") ? specifier.slice(2) : specifier;
}

/**
 * Builds the source map of one module. `sourceTexts` maps each root-relative
 * source path to its text, for the line tables. A source that a record names
 * and that is missing from `sourceTexts` is an error value.
 */
export function buildSourceMap(
  table: SpanTable,
  sourceTexts: ReadonlyMap<string, string>,
  options: SourceMapOptions = {},
): Result<SourceMapV3, SourceMapError> {
  const sourceIndex = new Map<string, number>();
  for (const record of table.records) {
    const source = record.span.source;
    if (sourceIndex.has(source)) continue;
    if (!sourceTexts.has(source)) {
      return { ok: false, error: { tag: "missing-source", source } };
    }
    sourceIndex.set(source, sourceIndex.size);
  }
  const sources = [...sourceIndex.keys()];
  const sourceLineStarts = new Map<string, Uint32Array>();
  for (const source of sources) {
    sourceLineStarts.set(source, lineStarts(sourceTexts.get(source) ?? ""));
  }

  // Every position where the mapping can change.
  const points = new Set<number>();
  for (const record of table.records) {
    points.add(record.start);
    if (record.end < table.textLength) points.add(record.end);
  }
  for (const start of table.lineStarts) {
    if (start < table.textLength) points.add(start);
  }

  const lines: string[][] = table.lineStarts.length === 0
    ? [[]]
    : Array.from({ length: table.lineStarts.length }, () => []);
  let previousSource = 0;
  let previousLine = 0;
  let previousColumn = 0;
  let currentLine = -1;
  let previousGenerated = 0;
  let lastTarget: string | undefined;
  for (const point of [...points].sort((a, b) => a - b)) {
    const generatedLine = lineIndexOf(table.lineStarts, point);
    const generatedColumn = point - table.lineStarts[generatedLine];
    if (generatedLine !== currentLine) {
      currentLine = generatedLine;
      previousGenerated = 0;
      lastTarget = undefined;
    }
    const record = recordAtOffset(table, point);
    if (record === undefined) {
      if (lastTarget === undefined) continue;
      lines[generatedLine].push(encodeVlq(generatedColumn - previousGenerated));
      previousGenerated = generatedColumn;
      lastTarget = undefined;
      continue;
    }
    const source = record.span.source;
    const text = sourceTexts.get(source) ?? "";
    const target = zeroBasedPosition(
      sourceLineStarts.get(source) ?? new Uint32Array([0]),
      text.length,
      record.span.start,
    );
    const index = sourceIndex.get(source) ?? 0;
    const key = `${index}:${target.line}:${target.column}`;
    if (key === lastTarget) continue;
    lines[generatedLine].push(
      encodeVlq(generatedColumn - previousGenerated) +
        encodeVlq(index - previousSource) +
        encodeVlq(target.line - previousLine) +
        encodeVlq(target.column - previousColumn),
    );
    previousGenerated = generatedColumn;
    previousSource = index;
    previousLine = target.line;
    previousColumn = target.column;
    lastTarget = key;
  }

  const base = {
    version: 3 as const,
    file: fileName(table.path),
    sources: sources.map((s) => relativeSource(table.path, s)),
    names: [] as string[],
    mappings: lines.map((segments) => segments.join(",")).join(";"),
  };
  if (options.includeContent !== true) return { ok: true, value: base };
  return {
    ok: true,
    value: {
      ...base,
      sourcesContent: sources.map((s) => sourceTexts.get(s) ?? ""),
    },
  };
}

/** The text of the `.ts.map` file: JSON with two-space indentation and a final newline. */
export function serializeSourceMap(map: SourceMapV3): string {
  const ordered: Record<string, unknown> = {
    version: map.version,
    file: map.file,
    sources: map.sources,
  };
  if (map.sourcesContent !== undefined) {
    ordered.sourcesContent = map.sourcesContent;
  }
  ordered.names = map.names;
  ordered.mappings = map.mappings;
  return JSON.stringify(ordered, null, 2) + "\n";
}

// ------------------------------------------------------------------ decoding

/** One decoded segment. Positions are zero-based. A segment with no `source` ends a mapping. */
export interface MapSegment {
  readonly generatedColumn: number;
  readonly source: number | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

export type MappingsError =
  | { readonly tag: "bad-vlq"; readonly line: number; readonly error: VlqError }
  | {
    readonly tag: "bad-segment";
    readonly line: number;
    readonly fields: number;
  };

/** Decodes `mappings` into the segments of each generated line, with absolute values. */
export function decodeMappings(
  mappings: string,
): Result<MapSegment[][], MappingsError> {
  const result: MapSegment[][] = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  const lines = mappings.split(";");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const segments: MapSegment[] = [];
    let generated = 0;
    const text = lines[lineIndex];
    if (text !== "") {
      for (const part of text.split(",")) {
        const decoded = decodeVlqList(part);
        if (!decoded.ok) {
          return {
            ok: false,
            error: { tag: "bad-vlq", line: lineIndex, error: decoded.error },
          };
        }
        const fields = decoded.value;
        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
          return {
            ok: false,
            error: {
              tag: "bad-segment",
              line: lineIndex,
              fields: fields.length,
            },
          };
        }
        generated += fields[0];
        if (fields.length === 1) {
          segments.push({
            generatedColumn: generated,
            source: undefined,
            line: undefined,
            column: undefined,
          });
          continue;
        }
        source += fields[1];
        sourceLine += fields[2];
        sourceColumn += fields[3];
        segments.push({
          generatedColumn: generated,
          source,
          line: sourceLine,
          column: sourceColumn,
        });
      }
    }
    result.push(segments);
  }
  return { ok: true, value: result };
}

/**
 * The segment that covers a generated position: the last segment of the line
 * that starts at or before the column. Zero-based. Undefined when the
 * position is unmapped.
 */
export function lookupMapping(
  decoded: readonly (readonly MapSegment[])[],
  line: number,
  column: number,
): MapSegment | undefined {
  const segments = decoded[line];
  if (segments === undefined) return undefined;
  let found: MapSegment | undefined;
  for (const segment of segments) {
    if (segment.generatedColumn > column) break;
    found = segment;
  }
  return found === undefined || found.source === undefined ? undefined : found;
}

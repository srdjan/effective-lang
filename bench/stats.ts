// Statistics and plain text tables for the measurement harnesses. Every
// function is pure. The harness reports a distribution, never a best of N.

/** The summary of a list of samples. All values share the unit of the samples. */
export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p10: number;
  readonly median: number;
  readonly p90: number;
  readonly max: number;
}

/**
 * The value at fraction `q` (0 to 1) of a list that is sorted ascending. It
 * interpolates linearly between the two nearest samples.
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const a = sorted[low] ?? NaN;
  const b = sorted[high] ?? NaN;
  return a + (b - a) * (position - low);
}

export function summarize(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p10: quantile(sorted, 0.1),
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? NaN,
  };
}

/** A pair of times of one A/A run: side A, then side B. Both sides run the same build. */
export type Pair = readonly [a: number, b: number];

/**
 * The noise floor of an A/A run. The ratio A/B of an A/A pair is 1 apart from
 * noise. The floor is the 90th percentile of `|A/B - 1|`, in percent: an A/B
 * ratio inside `1 +/- floor` is called null.
 */
export interface NoiseFloor {
  /** The distribution of the ratios A/B. */
  readonly ratio: Distribution;
  /** The 90th percentile of `|A/B - 1|`, in percent. */
  readonly floorPercent: number;
}

export function noiseFloor(pairs: readonly Pair[]): NoiseFloor {
  const ratios = pairs.map(([a, b]) => a / b);
  const deviations = ratios.map((r) => Math.abs(r - 1)).sort((a, b) => a - b);
  return {
    ratio: summarize(ratios),
    floorPercent: quantile(deviations, 0.9) * 100,
  };
}

// ------------------------------------------------------------------ checksum

/**
 * A fast 53-bit string hash (cyrb53) as 14 hex digits. The checksum gate uses
 * it over emitted text. It is not a cryptographic hash.
 */
export function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}

// ------------------------------------------------------------------ tables

export function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/**
 * Renders rows as a plain text table. The first column is left aligned and
 * the others are right aligned.
 */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length))
  );
  const render = (row: readonly string[]) =>
    row.map((cell, column) =>
      column === 0
        ? cell.padEnd(widths[column] ?? 0)
        : cell.padStart(widths[column] ?? 0)
    ).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [render(header), rule, ...rows.map(render)].join("\n");
}

export function distributionCells(d: Distribution, digits: number): string[] {
  return [
    String(d.n),
    fixed(d.min, digits),
    fixed(d.p10, digits),
    fixed(d.median, digits),
    fixed(d.p90, digits),
    fixed(d.max, digits),
  ];
}

export const DISTRIBUTION_HEADER: readonly string[] = [
  "n",
  "min",
  "p10",
  "median",
  "p90",
  "max",
];

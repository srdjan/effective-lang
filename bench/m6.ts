// Measurement M6: the noise floor, with the same build on both sides.
//
// The pairs come from the interleaved A/A runs of M2 and M5. Each pair holds
// the time of side A and the time of side B for the same code. The ratio A/B
// is 1 apart from noise. This file reports the distribution of that ratio and
// the floor: the 90th percentile of `|A/B - 1|`, in percent. A later A/B
// result inside `1 +/- floor` counts as null.
//
// The floor depends on the machine, its load, and the stage. Measure it again
// when the machine changes.

import type { M2Result, StageResult } from "./m2.ts";
import type { M5Result } from "./m5.ts";
import {
  DISTRIBUTION_HEADER,
  distributionCells,
  fixed,
  noiseFloor,
  type Pair,
  table,
} from "./stats.ts";

const HEADER = ["row", ...DISTRIBUTION_HEADER, "floor %"];

function row(label: string, pairs: readonly Pair[]): string[] {
  const floor = noiseFloor(pairs);
  return [
    label,
    ...distributionCells(floor.ratio, 3),
    fixed(floor.floorPercent, 1),
  ];
}

function stageRows(prefix: string, stages: readonly StageResult[]): string[][] {
  return stages.map((s) => row(`${prefix}${s.stage}`, s.pairs));
}

/** The noise floor report of one run. `m5` is optional. */
export function formatM6(m2: M2Result, m5?: M5Result): string {
  const out: string[] = [];
  out.push("M6: noise floor, interleaved A/A runs of the same build");
  out.push(
    "Rows hold the distribution of the per-pair ratio A/B. The columns are n pairs, min, p10, median, p90, and max of the ratio.",
  );
  out.push(
    "The floor is the p90 of |A/B - 1| in percent. Call a later A/B difference below the floor null.",
  );
  out.push("The order of the two sides alternates between pairs.");
  for (const size of m2.sizes) {
    out.push("");
    out.push(`M2 size ${size.name} (${size.declarations} declarations)`);
    const rows = stageRows("", size.stages);
    for (const step of size.steps) {
      rows.push(row(`${step.kind} update`, step.update.pairs));
      rows.push(row(`${step.kind} emit`, step.emit.pairs));
    }
    out.push(table(HEADER, rows));
  }
  if (m5 !== undefined) {
    out.push("");
    out.push("M5 targets (whole process time)");
    const rows = m5.targets.map((t) => row(t.name, t.pairs));
    for (const r of m5.variants?.results ?? []) {
      rows.push(row(`${r.variant}, ${r.target}`, r.pairs));
    }
    out.push(table(HEADER, rows));
  }
  return out.join("\n");
}

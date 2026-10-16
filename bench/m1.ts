// Measurement M1: the latency of an edit through the real language server.
//
// Two server processes, A and B, run the same edit script on the same project
// in two temporary copies. They are the interleaved A/A pair of the protocol.
// For each step the script runs on both sides, and the side that goes first
// alternates. The time of a change runs from just before the write of
// `didChange` to the receipt of the matching `publishDiagnostics`. Then a hover
// on a fixed function name gives the hover round trip. The first steps of each
// edit kind are warm-ups, and the report drops them.
//
// After every step the diagnostics of the edited file must be an empty list.
// Any other list stops the run with an error value (the gate of the protocol).
// The rows pool the runs of both sides. The noise floor comes from the A/B
// pairs (see `noiseFloor` in stats.ts).

import type { Result } from "../src/core/source.ts";
import {
  type EditKind,
  loadInput,
  type LspBenchError,
  type LspInputName,
  type Session,
  Workspace,
} from "./lsp_script.ts";
import {
  DISTRIBUTION_HEADER,
  distributionCells,
  fixed,
  noiseFloor,
  type Pair,
  summarize,
  table,
} from "./stats.ts";

export interface M1InputConfig {
  readonly input: LspInputName;
  /** Discarded steps before the timed ones, for each edit kind. */
  readonly warmups: number;
  /** Timed steps for each edit kind. Each one runs on both sides. */
  readonly steps: number;
}

export interface M1Config {
  readonly seed: number;
  readonly inputs: readonly M1InputConfig[];
  /** The limit of each server request or wait, in milliseconds. */
  readonly timeoutMs: number;
}

export type M1Metric = "change" | "hover";

export interface M1Row {
  readonly input: LspInputName;
  readonly kind: EditKind;
  readonly metric: M1Metric;
  /** The time of every timed run of both sides, in milliseconds. */
  readonly samples: readonly number[];
  /** The time of side A and side B of each step, in milliseconds. */
  readonly pairs: readonly Pair[];
}

export interface M1Result {
  readonly seed: number;
  readonly inputs: readonly M1InputConfig[];
  readonly rows: readonly M1Row[];
  /** The wall time of the whole measurement, in milliseconds. */
  readonly elapsedMs: number;
}

/** One step on one side: the change time, then the hover time. */
async function stepOn(
  session: Session,
  kind: EditKind,
): Promise<Result<readonly [change: number, hover: number], LspBenchError>> {
  const change = await session.step(kind);
  if (!change.ok) return change;
  const hover = await session.hover();
  if (!hover.ok) return hover;
  return { ok: true, value: [change.value, hover.value] };
}

export async function runM1(
  config: M1Config,
): Promise<Result<M1Result, LspBenchError>> {
  const started = performance.now();
  const rows: M1Row[] = [];
  for (const entry of config.inputs) {
    const workspace = new Workspace();
    try {
      const input = loadInput(entry.input, config.seed);
      const a = await workspace.open(input, config.timeoutMs);
      if (!a.ok) return a;
      const b = await workspace.open(input, config.timeoutMs);
      if (!b.ok) return b;
      let turn = 0;
      for (const kind of input.kinds) {
        const change: Pair[] = [];
        const hover: Pair[] = [];
        for (let i = 0; i < entry.warmups + entry.steps; i++, turn++) {
          // Alternate which side goes first.
          const first = turn % 2 === 0 ? a.value : b.value;
          const second = turn % 2 === 0 ? b.value : a.value;
          const one = await stepOn(first, kind);
          if (!one.ok) return one;
          const two = await stepOn(second, kind);
          if (!two.ok) return two;
          if (i < entry.warmups) continue;
          const [onA, onB] = turn % 2 === 0 ? [one.value, two.value] : [
            two.value,
            one.value,
          ];
          change.push([onA[0], onB[0]]);
          hover.push([onA[1], onB[1]]);
        }
        for (
          const [metric, pairs] of [["change", change], [
            "hover",
            hover,
          ]] as const
        ) {
          rows.push({
            input: entry.input,
            kind,
            metric,
            samples: pairs.flatMap(([x, y]) => [x, y]),
            pairs,
          });
        }
      }
      const done = await workspace.finish();
      if (!done.ok) return done;
    } finally {
      await workspace.dispose();
    }
  }
  return {
    ok: true,
    value: {
      seed: config.seed,
      inputs: config.inputs,
      rows,
      elapsedMs: performance.now() - started,
    },
  };
}

export function formatM1(result: M1Result): string {
  const out: string[] = [];
  out.push(
    "M1: edit latency through the language server (ms), two server processes A and B",
  );
  out.push(
    "change: from just before the write of didChange to the receipt of the matching publishDiagnostics. hover: one hover round trip on a fixed function name.",
  );
  out.push(
    "n counts the runs of both sides. The floor is the p90 of |A/B - 1| in percent over the A/B step pairs of the row. Call a later A/B difference below the floor null.",
  );
  out.push(
    `Server options: writeOnSave false, debounceMs 0. Only the edited document is open. Warm-up steps are dropped. ${
      result.inputs.map((i) =>
        `${i.input}: ${i.warmups} warm-up and ${i.steps} timed steps per kind`
      ).join("; ")
    }.`,
  );
  const rows = result.rows.map((row) => [
    `${row.input} ${row.kind} ${row.metric}`,
    ...distributionCells(summarize(row.samples), 3),
    fixed(noiseFloor(row.pairs).floorPercent, 1),
  ]);
  out.push("");
  out.push(
    table(["input edit metric", ...DISTRIBUTION_HEADER, "floor %"], rows),
  );
  out.push("");
  out.push(`elapsed ${fixed(result.elapsedMs / 1000, 1)} s`);
  return out.join("\n");
}

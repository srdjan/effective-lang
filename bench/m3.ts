// Measurement M3: the work that one edit makes the server do.
//
// One server process per input runs the edit script with no hover. After each
// step the client sends `effektive/stats`. The per-step delta of the
// cumulative query counts `parses`, `checks`, `lowerings`, and `emits` shows
// the work of the flush alone. The stats also give the interface delta and the
// mode delta of the last flush. Counts are exact, so M3 has no noise floor and
// drops no warm-up step.

import type { Result } from "../src/core/source.ts";
import {
  type EditKind,
  loadInput,
  type LspBenchError,
  type LspInputName,
  type StepStats,
  Workspace,
} from "./lsp_script.ts";
import { fixed, summarize, table } from "./stats.ts";

export interface M3InputConfig {
  readonly input: LspInputName;
  /** Steps for each edit kind. */
  readonly steps: number;
}

export interface M3Config {
  readonly seed: number;
  readonly inputs: readonly M3InputConfig[];
  /** The limit of each server request or wait, in milliseconds. */
  readonly timeoutMs: number;
}

/** The counts of one step. */
export interface StepCounts {
  readonly parses: number;
  readonly checks: number;
  readonly lowerings: number;
  readonly emits: number;
  /** True when the interface delta of the flush has a module. */
  readonly interfaceChanged: boolean;
  /** True when the mode delta of the flush has a module. */
  readonly modeChanged: boolean;
}

export interface M3Row {
  readonly input: LspInputName;
  readonly kind: EditKind;
  readonly steps: readonly StepCounts[];
}

export interface M3Result {
  readonly seed: number;
  readonly inputs: readonly M3InputConfig[];
  readonly rows: readonly M3Row[];
  /** The wall time of the whole measurement, in milliseconds. */
  readonly elapsedMs: number;
}

function delta(before: StepStats, after: StepStats): StepCounts {
  return {
    parses: after.parses - before.parses,
    checks: after.checks - before.checks,
    lowerings: after.lowerings - before.lowerings,
    emits: after.emits - before.emits,
    interfaceChanged: after.interfaceChanged > 0,
    modeChanged: after.modeChanged > 0,
  };
}

export async function runM3(
  config: M3Config,
): Promise<Result<M3Result, LspBenchError>> {
  const started = performance.now();
  const rows: M3Row[] = [];
  for (const entry of config.inputs) {
    const workspace = new Workspace();
    try {
      const input = loadInput(entry.input, config.seed);
      const opened = await workspace.open(input, config.timeoutMs);
      if (!opened.ok) return opened;
      const session = opened.value;
      const baseline = await session.stats();
      if (!baseline.ok) return baseline;
      let before = baseline.value;
      for (const kind of input.kinds) {
        const steps: StepCounts[] = [];
        for (let i = 0; i < entry.steps; i++) {
          const changed = await session.step(kind);
          if (!changed.ok) return changed;
          const after = await session.stats();
          if (!after.ok) return after;
          steps.push(delta(before, after.value));
          before = after.value;
        }
        rows.push({ input: entry.input, kind, steps });
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

const COUNTS = ["parses", "checks", "lowerings", "emits"] as const;

export function formatM3(result: M3Result): string {
  const out: string[] = [];
  out.push("M3: work per edit in the language server, from effektive/stats");
  out.push(
    "Counts are exact and have no noise floor. Each cell is the median or the maximum of the per-step delta of the cumulative count. The last two columns are the fraction of steps with a module in the interface delta and in the mode delta.",
  );
  out.push(
    "No hover runs in M3, so the counts show the flush alone. Warm-up steps are not dropped, because counts do not depend on timing.",
  );
  const header = [
    "input edit",
    "n",
    ...COUNTS.flatMap((c) => [`${c} med`, `${c} max`]),
    "iface frac",
    "mode frac",
  ];
  const rows = result.rows.map((row) => {
    const fraction = (pick: (s: StepCounts) => boolean) =>
      row.steps.filter(pick).length / row.steps.length;
    return [
      `${row.input} ${row.kind}`,
      String(row.steps.length),
      ...COUNTS.flatMap((c) => {
        const d = summarize(row.steps.map((s) => s[c]));
        return [fixed(d.median, 1), fixed(d.max, 0)];
      }),
      fixed(fraction((s) => s.interfaceChanged), 2),
      fixed(fraction((s) => s.modeChanged), 2),
    ];
  });
  out.push("");
  out.push(table(header, rows));
  out.push("");
  out.push(`elapsed ${fixed(result.elapsedMs / 1000, 1)} s`);
  return out.join("\n");
}

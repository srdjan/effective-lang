// Measurement M4: the memory of the language server over a long edit script.
//
// Two server processes, A and B, run the same script on the medium project.
// The script cycles the four edit kinds: body, header, alias, mode flip. The
// side that goes first alternates. After each step the client reads
// `memory.rss` from `effective/stats`. Each row is a fresh pair of servers
// that runs N steps. The peak is sampled only at step ends, so a short peak
// inside a step is not seen.

import type { Result } from "../src/core/source.ts";
import {
  EDIT_KINDS,
  loadInput,
  type LspBenchError,
  Workspace,
} from "./lsp_script.ts";
import { fixed, table } from "./stats.ts";
import type { SizeName } from "./generate.ts";

export interface M4Config {
  readonly seed: number;
  readonly size: SizeName;
  /** The step counts N of the rows. Each row starts a fresh pair of servers. */
  readonly stepCounts: readonly number[];
  /** The limit of each server request or wait, in milliseconds. */
  readonly timeoutMs: number;
}

export interface M4Row {
  readonly steps: number;
  /** The `rss` of side A after each step, in bytes. */
  readonly samplesA: readonly number[];
  readonly samplesB: readonly number[];
  readonly peakA: number;
  readonly peakB: number;
  readonly lastA: number;
  readonly lastB: number;
}

export interface M4Result {
  readonly seed: number;
  readonly size: SizeName;
  readonly rows: readonly M4Row[];
  /** The wall time of the whole measurement, in milliseconds. */
  readonly elapsedMs: number;
}

export async function runM4(
  config: M4Config,
): Promise<Result<M4Result, LspBenchError>> {
  const started = performance.now();
  const rows: M4Row[] = [];
  for (const steps of config.stepCounts) {
    const workspace = new Workspace();
    try {
      const input = loadInput(config.size, config.seed);
      const a = await workspace.open(input, config.timeoutMs);
      if (!a.ok) return a;
      const b = await workspace.open(input, config.timeoutMs);
      if (!b.ok) return b;
      const samplesA: number[] = [];
      const samplesB: number[] = [];
      for (let i = 0; i < steps; i++) {
        const kind = EDIT_KINDS[i % EDIT_KINDS.length];
        if (kind === undefined) throw new Error("no edit kind");
        const order = i % 2 === 0
          ? [[a.value, samplesA], [b.value, samplesB]] as const
          : [[b.value, samplesB], [a.value, samplesA]] as const;
        for (const [session, samples] of order) {
          const changed = await session.step(kind);
          if (!changed.ok) return changed;
          const stats = await session.stats();
          if (!stats.ok) return stats;
          samples.push(stats.value.rss);
        }
      }
      const done = await workspace.finish();
      if (!done.ok) return done;
      rows.push({
        steps,
        samplesA,
        samplesB,
        peakA: Math.max(...samplesA),
        peakB: Math.max(...samplesB),
        lastA: samplesA[samplesA.length - 1] ?? NaN,
        lastB: samplesB[samplesB.length - 1] ?? NaN,
      });
    } finally {
      await workspace.dispose();
    }
  }
  return {
    ok: true,
    value: {
      seed: config.seed,
      size: config.size,
      rows,
      elapsedMs: performance.now() - started,
    },
  };
}

const MIB = 1024 * 1024;

export function formatM4(result: M4Result): string {
  const out: string[] = [];
  out.push(
    `M4: server memory (rss, MiB) over an edit script, size ${result.size}, two server processes A and B`,
  );
  out.push(
    "The script cycles the edit kinds body, header, alias, and mode flip. Each row starts a fresh pair of servers and runs N steps.",
  );
  out.push(
    "Note: the peak is sampled only at step ends, so a short peak inside a step is not seen.",
  );
  const rows = result.rows.map((row) => [
    String(row.steps),
    fixed(row.peakA / MIB, 1),
    fixed(row.peakB / MIB, 1),
    fixed(row.lastA / MIB, 1),
    fixed(row.lastB / MIB, 1),
  ]);
  out.push("");
  out.push(
    table(["N steps", "peak A", "peak B", "last A", "last B"], rows),
  );
  out.push("");
  out.push(`elapsed ${fixed(result.elapsedMs / 1000, 1)} s`);
  return out.join("\n");
}

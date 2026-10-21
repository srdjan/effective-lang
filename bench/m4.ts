// Measurement M4: RSS, heap, and type-table growth over a long edit script.
// Two fresh servers run the same distinct revisions, rotating between open
// documents. Step-end samples cannot reveal a short peak inside a step.

import type { Result } from "../src/core/source.ts";
import {
  EDIT_KINDS,
  loadInput,
  type LspBenchError,
  type LspInput,
  type StepStats,
  Workspace,
} from "./lsp_script.ts";
import { fixed, table } from "./stats.ts";
import type { SizeName } from "./generate.ts";

export interface M4Config {
  readonly seed: number;
  readonly size: SizeName;
  /** The step counts N of the rows. Each row starts a fresh pair of servers. */
  readonly stepCounts: readonly number[];
  /** Documents held open concurrently; defaults to three. */
  readonly openDocuments?: number;
  /** The limit of each server request or wait, in milliseconds. */
  readonly timeoutMs: number;
}

export interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly typeTableSize: number;
}

export interface M4Row {
  readonly steps: number;
  readonly documents: readonly {
    readonly path: string;
    readonly editsA: number;
    readonly editsB: number;
    /** Feature companions receive literal body edits; other companions receive comments. */
    readonly edit: "body/header/alias/flip" | "body" | "comment";
  }[];
  readonly distinctEditsA: number;
  readonly distinctEditsB: number;
  readonly baselineA: MemorySample;
  readonly baselineB: MemorySample;
  /** Complete step-end measurements, before the next document edit. */
  readonly memorySamplesA: readonly MemorySample[];
  readonly memorySamplesB: readonly MemorySample[];
  /** RSS arrays and summaries retained for existing consumers. */
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
  readonly openDocuments: number;
  readonly rows: readonly M4Row[];
  /** The wall time of the whole measurement, in milliseconds. */
  readonly elapsedMs: number;
}

/** Prefer existing feature modules so companion edits change an annotated body. */
export function sessionDocuments(
  input: LspInput,
  count: number,
): readonly string[] {
  const candidates = [...input.files.keys()].filter((path) =>
    path.endsWith(".eff") && path !== input.editPath
  ).sort((a, b) =>
    Number(/^m\d+\.eff$/.test(b)) - Number(/^m\d+\.eff$/.test(a)) ||
    a.localeCompare(b)
  );
  return [input.editPath, ...candidates].slice(0, count);
}

function memory(stats: StepStats): Result<MemorySample, LspBenchError> {
  if (stats.heapUsed === null || stats.typeTableSize === null) {
    return {
      ok: false,
      error: {
        tag: "protocol",
        message:
          "M4 requires memory.heapUsed and typeTableSize in effective/stats",
      },
    };
  }
  return {
    ok: true,
    value: {
      rss: stats.rss,
      heapUsed: stats.heapUsed,
      typeTableSize: stats.typeTableSize,
    },
  };
}

export async function runM4(
  config: M4Config,
): Promise<Result<M4Result, LspBenchError>> {
  const started = performance.now();
  const openDocuments = config.openDocuments ?? 3;
  if (
    !Number.isInteger(openDocuments) || openDocuments < 1 ||
    config.stepCounts.some((steps) => !Number.isInteger(steps) || steps < 1)
  ) {
    return {
      ok: false,
      error: {
        tag: "setup",
        message: "M4 document and step counts must be positive integers",
      },
    };
  }
  const rows: M4Row[] = [];
  for (const steps of config.stepCounts) {
    const workspace = new Workspace();
    try {
      const input = loadInput(config.size, config.seed);
      const paths = sessionDocuments(input, openDocuments);
      if (paths.length !== openDocuments) {
        return {
          ok: false,
          error: {
            tag: "setup",
            message:
              `M4 input has fewer than ${openDocuments} source documents`,
          },
        };
      }
      const a = await workspace.open(input, config.timeoutMs, paths);
      if (!a.ok) return a;
      const b = await workspace.open(input, config.timeoutMs, paths);
      if (!b.ok) return b;
      const firstA = await a.value.stats();
      if (!firstA.ok) return firstA;
      const firstB = await b.value.stats();
      if (!firstB.ok) return firstB;
      const baselineA = memory(firstA.value);
      if (!baselineA.ok) return baselineA;
      const baselineB = memory(firstB.value);
      if (!baselineB.ok) return baselineB;
      const memorySamplesA: MemorySample[] = [];
      const memorySamplesB: MemorySample[] = [];
      for (let i = 0; i < steps; i++) {
        const path = paths[i % paths.length];
        const kind = i % paths.length === 0
          ? EDIT_KINDS[Math.floor(i / paths.length) % EDIT_KINDS.length]
          : "body";
        if (kind === undefined || path === undefined) {
          throw new Error("no edit target");
        }
        const order = i % 2 === 0
          ? [[a.value, memorySamplesA], [b.value, memorySamplesB]] as const
          : [[b.value, memorySamplesB], [a.value, memorySamplesA]] as const;
        for (const [session, samples] of order) {
          const changed = await session.step(kind, path);
          if (!changed.ok) return changed;
          const stats = await session.stats();
          if (!stats.ok) return stats;
          const sample = memory(stats.value);
          if (!sample.ok) return sample;
          samples.push(sample.value);
        }
      }
      const done = await workspace.finish();
      if (!done.ok) return done;
      const samplesA = memorySamplesA.map((sample) => sample.rss);
      const samplesB = memorySamplesB.map((sample) => sample.rss);
      rows.push({
        steps,
        documents: paths.map((path) => ({
          path,
          editsA: a.value.editCounts.get(path) ?? 0,
          editsB: b.value.editCounts.get(path) ?? 0,
          edit: path === input.editPath
            ? "body/header/alias/flip"
            : /^m\d+\.eff$/.test(path)
            ? "body"
            : "comment",
        })),
        distinctEditsA: [...a.value.editCounts.values()].reduce(
          (sum, n) => sum + n,
          0,
        ),
        distinctEditsB: [...b.value.editCounts.values()].reduce(
          (sum, n) => sum + n,
          0,
        ),
        baselineA: baselineA.value,
        baselineB: baselineB.value,
        memorySamplesA,
        memorySamplesB,
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
      openDocuments,
      rows,
      elapsedMs: performance.now() - started,
    },
  };
}

const MIB = 1024 * 1024;

export function formatM4(result: M4Result): string {
  const out = [
    `M4: server memory over distinct edits, size ${result.size}, ${result.openDocuments} documents open concurrently, two server processes A and B`,
    "Edits rotate between documents. The primary cycles body, header, alias, and mode flip; companion feature modules receive body edits. Every text has a unique revision marker.",
    "Note: the peak is sampled only at step ends, so a short peak inside a step is not seen. These observations do not establish bounded memory.",
    "",
    table(
      [
        "N steps",
        "RSS peak A/B MiB",
        "RSS last A/B MiB",
        "heap last A/B MiB",
        "types start A/B",
        "types last A/B",
      ],
      result.rows.map((row) => {
        const lastA = row.memorySamplesA.at(-1) ?? row.baselineA;
        const lastB = row.memorySamplesB.at(-1) ?? row.baselineB;
        return [
          String(row.steps),
          `${fixed(row.peakA / MIB, 1)}/${fixed(row.peakB / MIB, 1)}`,
          `${fixed(row.lastA / MIB, 1)}/${fixed(row.lastB / MIB, 1)}`,
          `${fixed(lastA.heapUsed / MIB, 1)}/${fixed(lastB.heapUsed / MIB, 1)}`,
          `${row.baselineA.typeTableSize}/${row.baselineB.typeTableSize}`,
          `${lastA.typeTableSize}/${lastB.typeTableSize}`,
        ];
      }),
    ),
    "",
  ];
  for (const row of result.rows) {
    out.push(
      `${row.steps} steps: distinct edits A/B ${row.distinctEditsA}/${row.distinctEditsB}; ${
        row.documents.map((document) =>
          `${document.path} ${document.editsA}/${document.editsB} (${document.edit})`
        ).join(", ")
      }`,
    );
  }
  out.push("", `elapsed ${fixed(result.elapsedMs / 1000, 1)} s`);
  return out.join("\n");
}

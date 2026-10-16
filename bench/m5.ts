// Measurement M5: the wall time of the TypeScript check over the emitted
// code, against Effect 4.0.5.
//
// The baseline is a cold `deno check` subprocess with the configuration that
// `effective build --tsc` generates (`tscConfig` in src/cli/tsc.ts, with
// `effect` mapped to `npm:effect@4.0.5`). The harness runs it through the same
// port that the CLI uses (`denoIo().denoCheck`) and times the whole call:
// the write of the configuration, the process, and its exit.
//
// "Cold" means a new process and no type-check cache hit. `deno check` skips
// the check when it has seen the same sources before. The harness therefore
// ends one generated file with a unique comment before each sample. A control
// run of unchanged input shows the cache hit.
//
// Protocol: one discarded warm-up run per target, interleaved A/A pairs for
// the noise floor, a distribution per target, and an exit code gate. A check
// that fails gives an error value and no time.
//
// Each target gets a temporary directory. The harness removes it at the end
// and leaves nothing in the working tree.

import { denoIo } from "../src/cli/deno_io.ts";
import { tscConfig } from "../src/cli/tsc.ts";
import type { Result } from "../src/core/source.ts";
import {
  DISTRIBUTION_HEADER,
  distributionCells,
  fixed,
  noiseFloor,
  type Pair,
  summarize,
  table,
} from "./stats.ts";
import {
  exampleTarget,
  type M5Error,
  type M5SizeConfig,
  syntheticTarget,
  type Target,
  writeTarget,
} from "./m5_target.ts";
import { runVariants, type VariantOutcome } from "./m5_variants.ts";

export interface M5Config {
  readonly seed: number;
  /** Synthetic targets, besides the five examples. */
  readonly sizes: readonly M5SizeConfig[];
  /** Timed A/A pairs per target. Each pair runs two cold checks. */
  readonly pairs: number;
  readonly warmups: number;
  /** Also try the optional variants (see m5_variants.ts). */
  readonly variants: boolean;
}

export interface TargetResult {
  readonly name: string;
  /** The number of files given to the check. */
  readonly files: number;
  readonly samples: readonly number[];
  readonly pairs: readonly Pair[];
  /** The time of a repeat on unchanged input: the type-check cache hit. */
  readonly control: number;
}

export interface M5Result {
  readonly targets: readonly TargetResult[];
  /** The optional variants. Absent when the run did not ask for them. */
  readonly variants?: VariantOutcome;
}

// ------------------------------------------------------------------ the check

/** Runs `deno check` once and returns the wall time of the call in milliseconds. */
async function timeCheck(
  directory: string,
  target: Target,
): Promise<Result<number, M5Error>> {
  const io = denoIo();
  const absolute = io.fs.absolute(directory);
  const start = performance.now();
  const run = await io.denoCheck({
    cwd: absolute,
    config: tscConfig(),
    files: [...target.files.keys()].sort(),
  });
  const elapsed = performance.now() - start;
  if (!run.ok) {
    return { ok: false, error: { tag: "setup", message: run.error.message } };
  }
  if (run.value.code !== 0) {
    return {
      ok: false,
      error: {
        tag: "check-failed",
        tool: "deno check",
        target: target.name,
        code: run.value.code,
        stderr: run.value.stderr,
      },
    };
  }
  return { ok: true, value: elapsed };
}

let runCounter = 0;

async function measureTarget(
  target: Target,
  config: M5Config,
): Promise<Result<TargetResult, M5Error>> {
  const directory = Deno.makeTempDirSync({ prefix: "effective-bench-" });
  try {
    const stamp = `${Date.now()}-${Deno.pid}`;
    const cold = async (): Promise<Result<number, M5Error>> => {
      // A new comment changes the source hash, so the check cache cannot hit.
      writeTarget(directory, target, `${stamp}-${runCounter++}`);
      return await timeCheck(directory, target);
    };
    for (let w = 0; w < config.warmups; w++) {
      const run = await cold();
      if (!run.ok) return run;
    }
    const samples: number[] = [];
    const pairs: Pair[] = [];
    for (let k = 0; k < config.pairs; k++) {
      const first = await cold();
      if (!first.ok) return first;
      const second = await cold();
      if (!second.ok) return second;
      samples.push(first.value, second.value);
      // Alternate which run counts as side A.
      pairs.push(
        k % 2 === 0 ? [first.value, second.value] : [second.value, first.value],
      );
    }
    // The control: the same input again. The type-check cache answers.
    const control = await timeCheck(directory, target);
    if (!control.ok) return control;
    return {
      ok: true,
      value: {
        name: target.name,
        files: target.files.size,
        samples,
        pairs,
        control: control.value,
      },
    };
  } finally {
    try {
      Deno.removeSync(directory, { recursive: true });
    } catch {
      // The system removes the temporary directory later.
    }
  }
}

/** Runs M5 for the examples and the configured synthetic sizes. */
export async function runM5(
  config: M5Config,
): Promise<Result<M5Result, M5Error>> {
  const targets: Target[] = [];
  const examples = exampleTarget();
  if (!examples.ok) return examples;
  targets.push(examples.value);
  for (const size of config.sizes) {
    const built = syntheticTarget(size, config.seed);
    if (!built.ok) return built;
    targets.push(built.value);
  }
  const results: TargetResult[] = [];
  for (const target of targets) {
    const measured = await measureTarget(target, config);
    if (!measured.ok) return measured;
    results.push(measured.value);
  }
  if (!config.variants) return { ok: true, value: { targets: results } };
  const variants = await runVariants(targets, {
    pairs: config.pairs,
    warmups: config.warmups,
  });
  if (!variants.ok) return variants;
  return { ok: true, value: { targets: results, variants: variants.value } };
}

// ------------------------------------------------------------------ the report

export function formatM5(result: M5Result, config: M5Config): string {
  const out: string[] = [];
  out.push(
    "M5: cold `deno check` over the emitted code (milliseconds, whole process)",
  );
  out.push(
    "Configuration: the one that `effective build --tsc` generates, with effect mapped to npm:effect@4.0.5.",
  );
  out.push(
    `Each target has ${config.warmups} discarded warm-up run and ${config.pairs} timed A/A pairs of two cold runs. Rows pool both sides.`,
  );
  out.push(
    "The floor column is the p90 of |A/B - 1| over the pairs. The control column is a repeat on unchanged input.",
  );
  const rows = result.targets.map((t) => [
    `${t.name} (${t.files} files)`,
    ...distributionCells(summarize(t.samples), 0),
    fixed(noiseFloor(t.pairs).floorPercent, 1),
    fixed(t.control, 0),
  ]);
  out.push(
    table(
      ["target", ...DISTRIBUTION_HEADER, "floor %", "control"],
      rows,
    ),
  );
  if (result.variants !== undefined) {
    out.push("");
    out.push(...formatVariants(result.variants));
  }
  return out.join("\n");
}

function formatVariants(outcome: VariantOutcome): string[] {
  const out: string[] = [];
  out.push(
    "M5 variants (milliseconds). Process variants time the whole process. The warm service times one edit and the diagnostics of every file.",
  );
  if (outcome.results.length > 0) {
    out.push(
      table(
        ["variant, target", ...DISTRIBUTION_HEADER, "floor %", "first call"],
        outcome.results.map((r) => [
          `${r.variant}, ${r.target}`,
          ...distributionCells(summarize(r.samples), 0),
          fixed(noiseFloor(r.pairs).floorPercent, 1),
          r.firstCall === undefined ? "-" : fixed(r.firstCall, 0),
        ]),
      ),
    );
  }
  for (const skip of outcome.skipped) {
    out.push(`skipped: ${skip.variant}: ${skip.reason}`);
  }
  return out;
}

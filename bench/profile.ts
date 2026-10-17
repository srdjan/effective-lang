// The scale profiles of the harness. `--full` differs from `--quick` only in
// these numbers: the iteration, step, warm-up, and edit counts and the pairs.
// The sizes and their declaration counts come from `SIZES` in generate.ts and
// are the same in both.

import { SIZE_NAMES, SIZES } from "./generate.ts";
import type { M1Config } from "./m1.ts";
import type { M2Config, SizeConfig } from "./m2.ts";
import type { M3Config } from "./m3.ts";
import type { M4Config } from "./m4.ts";
import type { M5Config } from "./m5.ts";

export type ProfileName = "quick" | "full";

/** The seed of the synthetic projects. */
export const SEED = 1;

interface Scale {
  /** Timed pairs, warm-ups, and edits per kind, for each size name. */
  readonly m2: Readonly<
    Record<
      typeof SIZE_NAMES[number],
      { iterations: number; warmups: number; editsPerKind: number }
    >
  >;
  /** Timed pairs and warm-ups of each M5 target. */
  readonly m5: { readonly pairs: number; readonly warmups: number };
  /** Warm-up and timed steps per edit kind, for each M1 input. */
  readonly m1: Readonly<
    Record<
      "examples" | typeof SIZE_NAMES[number],
      { warmups: number; steps: number }
    >
  >;
  /** Steps per edit kind, for each M3 input. */
  readonly m3: Readonly<
    Record<"examples" | typeof SIZE_NAMES[number], { steps: number }>
  >;
  /** The step counts N of the M4 rows. */
  readonly m4: readonly number[];
}

const SCALES: Readonly<Record<ProfileName, Scale>> = {
  quick: {
    m2: {
      small: { iterations: 40, warmups: 3, editsPerKind: 2 },
      medium: { iterations: 25, warmups: 3, editsPerKind: 2 },
      large: { iterations: 12, warmups: 2, editsPerKind: 2 },
    },
    m5: { pairs: 2, warmups: 1 },
    m1: {
      examples: { warmups: 3, steps: 30 },
      small: { warmups: 3, steps: 30 },
      medium: { warmups: 3, steps: 30 },
      large: { warmups: 3, steps: 30 },
    },
    m3: {
      examples: { steps: 30 },
      small: { steps: 30 },
      medium: { steps: 30 },
      large: { steps: 30 },
    },
    m4: [50, 100, 200],
  },
  full: {
    m2: {
      small: { iterations: 300, warmups: 10, editsPerKind: 3 },
      medium: { iterations: 120, warmups: 8, editsPerKind: 3 },
      large: { iterations: 30, warmups: 4, editsPerKind: 3 },
    },
    m5: { pairs: 4, warmups: 2 },
    m1: {
      examples: { warmups: 5, steps: 100 },
      small: { warmups: 5, steps: 100 },
      medium: { warmups: 5, steps: 100 },
      large: { warmups: 5, steps: 100 },
    },
    m3: {
      examples: { steps: 100 },
      small: { steps: 100 },
      medium: { steps: 100 },
      large: { steps: 100 },
    },
    m4: [200, 500, 1000],
  },
};

export function m2Config(profile: ProfileName): M2Config {
  const scale = SCALES[profile].m2;
  const sizes: SizeConfig[] = SIZE_NAMES.map((name) => ({
    name,
    declarations: SIZES[name],
    ...scale[name],
  }));
  return { seed: SEED, sizes, incremental: true };
}

export function m5Config(profile: ProfileName, variants: boolean): M5Config {
  return {
    seed: SEED,
    sizes: SIZE_NAMES.map((name) => ({ name, declarations: SIZES[name] })),
    ...SCALES[profile].m5,
    variants,
  };
}

/** The time limit of each server request or wait, in milliseconds. */
export const LSP_TIMEOUT_MS = 60_000;

/** The inputs of M1 and M3: the examples, then the three synthetic sizes. */
const LSP_INPUTS = ["examples", ...SIZE_NAMES] as const;

export function m1Config(profile: ProfileName): M1Config {
  const scale = SCALES[profile].m1;
  return {
    seed: SEED,
    timeoutMs: LSP_TIMEOUT_MS,
    inputs: LSP_INPUTS.map((input) => ({ input, ...scale[input] })),
  };
}

export function m3Config(profile: ProfileName): M3Config {
  const scale = SCALES[profile].m3;
  return {
    seed: SEED,
    timeoutMs: LSP_TIMEOUT_MS,
    inputs: LSP_INPUTS.map((input) => ({ input, ...scale[input] })),
  };
}

export function m4Config(profile: ProfileName): M4Config {
  return {
    seed: SEED,
    size: "medium",
    timeoutMs: LSP_TIMEOUT_MS,
    stepCounts: SCALES[profile].m4,
  };
}

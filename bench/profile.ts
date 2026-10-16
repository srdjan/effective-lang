// The scale profiles of the harness. `--full` differs from `--quick` only in
// these numbers: the iteration counts and the pairs. The sizes and their
// declaration counts come from `SIZES` in generate.ts and are the same in both.

import { SIZE_NAMES, SIZES } from "./generate.ts";
import type { M2Config, SizeConfig } from "./m2.ts";
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
}

const SCALES: Readonly<Record<ProfileName, Scale>> = {
  quick: {
    m2: {
      small: { iterations: 40, warmups: 3, editsPerKind: 2 },
      medium: { iterations: 25, warmups: 3, editsPerKind: 2 },
      large: { iterations: 12, warmups: 2, editsPerKind: 2 },
    },
    m5: { pairs: 2, warmups: 1 },
  },
  full: {
    m2: {
      small: { iterations: 300, warmups: 10, editsPerKind: 3 },
      medium: { iterations: 120, warmups: 8, editsPerKind: 3 },
      large: { iterations: 30, warmups: 4, editsPerKind: 3 },
    },
    m5: { pairs: 4, warmups: 2 },
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

// The entry of the measurement harnesses.
//
//   deno task bench [--quick|--full] [m1|m2|m3|m4|m5|m6 ...] [--no-variants] [--json <file>]
//
// With no measurement named, the run does all six. `m6` prints the noise
// floor from the A/A pairs of M2, and of M5 when `m5` runs too. `m1`, `m3`,
// and `m4` start the language server as a subprocess. The output is plain text
// on stdout. The `--json` file holds the raw samples.

import { errorMessage } from "../src/core/mod.ts";
import { formatM1, type M1Result, runM1 } from "./m1.ts";
import { describeM2Error, formatM2, type M2Result, runM2 } from "./m2.ts";
import { formatM3, type M3Result, runM3 } from "./m3.ts";
import { formatM4, type M4Result, runM4 } from "./m4.ts";
import { describeLspBenchError } from "./lsp_script.ts";
import { formatM5, type M5Result, runM5 } from "./m5.ts";
import { describeM5Error } from "./m5_target.ts";
import { formatM6 } from "./m6.ts";
import {
  m1Config,
  m2Config,
  m3Config,
  m4Config,
  m5Config,
  type ProfileName,
} from "./profile.ts";

export type Measurement = "m1" | "m2" | "m3" | "m4" | "m5" | "m6";

const MEASUREMENTS: readonly Measurement[] = [
  "m1",
  "m2",
  "m3",
  "m4",
  "m5",
  "m6",
];

export interface Options {
  readonly profile: ProfileName;
  readonly measurements: readonly Measurement[];
  readonly variants: boolean;
  readonly json: string | undefined;
}

export const USAGE =
  `usage: deno task bench [--quick|--full] [m1|m2|m3|m4|m5|m6 ...] [--no-variants] [--json <file>]
  --quick        small scale, aimed at under one minute for each measurement (default)
  --full         larger counts of iterations, steps, warm-ups, and pairs; same sizes
  m1 .. m6       the measurements to run (default: all six)
                 m1, m3, and m4 run the language server as a subprocess
  --no-variants  skip the optional M5 variants (tsc, language service, tsgo)
  --json <file>  write the raw samples to the file
`;

export function parseOptions(
  args: readonly string[],
): { ok: true; value: Options } | { ok: false; error: string } {
  let profile: ProfileName = "quick";
  const measurements: Measurement[] = [];
  let variants = true;
  let json: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--quick" || arg === "--full") {
      profile = arg === "--full" ? "full" : "quick";
    } else if (MEASUREMENTS.some((m) => m === arg)) {
      const measurement = MEASUREMENTS.find((m) => m === arg);
      if (measurement !== undefined && !measurements.includes(measurement)) {
        measurements.push(measurement);
      }
    } else if (arg === "--no-variants") {
      variants = false;
    } else if (arg === "--json") {
      json = args[++i];
      if (json === undefined) {
        return { ok: false, error: "--json needs a file" };
      }
    } else {
      return { ok: false, error: `unknown argument ${arg}` };
    }
  }
  return {
    ok: true,
    value: {
      profile,
      measurements: measurements.length === 0 ? MEASUREMENTS : measurements,
      variants,
      json,
    },
  };
}

function header(options: Options): string {
  return [
    `effective-lang measurements, profile ${options.profile}`,
    `deno ${Deno.version.deno}, v8 ${Deno.version.v8}, typescript ${Deno.version.typescript}, ${Deno.build.target}`,
    `logical cores ${navigator.hardwareConcurrency}, timer performance.now(), single thread, not pinned`,
    "No number below is a claim. Read each number with the noise floor of its row.",
  ].join("\n");
}

export async function run(args: readonly string[]): Promise<number> {
  const parsed = parseOptions(args);
  if (!parsed.ok) {
    console.error(`bench: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const options = parsed.value;
  const wants = (m: Measurement) => options.measurements.includes(m);
  console.log(header(options));

  let m1: M1Result | undefined;
  if (wants("m1")) {
    const result = await runM1(m1Config(options.profile));
    if (!result.ok) {
      console.error(`bench: M1 failed: ${describeLspBenchError(result.error)}`);
      return 1;
    }
    m1 = result.value;
    console.log(`\n${formatM1(m1)}`);
  }

  let m2: M2Result | undefined;
  if (wants("m2") || wants("m6")) {
    const result = runM2(m2Config(options.profile));
    if (!result.ok) {
      console.error(`bench: M2 failed: ${describeM2Error(result.error)}`);
      return 1;
    }
    m2 = result.value;
    if (wants("m2")) console.log(`\n${formatM2(m2)}`);
  }

  let m3: M3Result | undefined;
  if (wants("m3")) {
    const result = await runM3(m3Config(options.profile));
    if (!result.ok) {
      console.error(`bench: M3 failed: ${describeLspBenchError(result.error)}`);
      return 1;
    }
    m3 = result.value;
    console.log(`\n${formatM3(m3)}`);
  }

  let m4: M4Result | undefined;
  if (wants("m4")) {
    const result = await runM4(m4Config(options.profile));
    if (!result.ok) {
      console.error(`bench: M4 failed: ${describeLspBenchError(result.error)}`);
      return 1;
    }
    m4 = result.value;
    console.log(`\n${formatM4(m4)}`);
  }

  let m5: M5Result | undefined;
  if (wants("m5")) {
    const config = m5Config(options.profile, options.variants);
    const result = await runM5(config);
    if (!result.ok) {
      console.error(`bench: M5 failed: ${describeM5Error(result.error)}`);
      return 1;
    }
    m5 = result.value;
    console.log(`\n${formatM5(m5, config)}`);
  }

  if (wants("m6") && m2 !== undefined) {
    console.log(`\n${formatM6(m2, m5)}`);
  }

  if (options.json !== undefined) {
    const document = {
      profile: options.profile,
      deno: Deno.version.deno,
      target: Deno.build.target,
      m1,
      m2: wants("m2") || wants("m6") ? m2 : undefined,
      m3,
      m4,
      m5,
    };
    try {
      Deno.writeTextFileSync(options.json, JSON.stringify(document, null, 1));
    } catch (e) {
      console.error(
        `bench: cannot write ${options.json}: ${errorMessage(e)}`,
      );
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}

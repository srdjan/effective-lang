// Measurement M2: the whole-module recheck time per stage, and the incremental
// path through `Program.update`.
//
// Protocol (see the measurement protocol in the goose skill):
//
// - Every run of the pipeline produces a checksum over the emitted text. The
//   gate compares the checksum of every run with the first one. A mismatch is an
//   error value, and the harness prints no time.
// - The first runs are warm-ups. They count for the gate and not for the time.
// - Each iteration runs the pipeline twice, as an interleaved A/A pair. Both
//   sides run the same code. The order alternates between iterations. The
//   distribution of the stage times pools the runs of both sides. The noise
//   floor comes from the per-pair ratios (M6, see `noiseFloor` in stats.ts).
// - The harness reports a distribution (min, p10, median, p90, max, and n), not
//   a best of N.
//
// The stages are timed with `performance.now()` inside the process. `lex` runs
// alone for the timing of the lexer. `parse` runs `parse`, which lexes again,
// so its time includes `lex`. `total` is the sum of every stage except `lex`.

import { Program, type Revision } from "../src/core/mod.ts";
import {
  checkAnalysis,
  type CheckedProject,
} from "../src/core/check_project.ts";
import { buildIndex } from "../src/core/index.ts";
import { lex } from "../src/core/lex.ts";
import type { Analysis } from "../src/core/analyze.ts";
import {
  type Diagnostic,
  normalizeDiagnostics,
} from "../src/core/diagnostics.ts";
import { emitProject, type EmittedModule } from "../src/core/emit/emit.ts";
import { lowerProject } from "../src/core/lower.ts";
import { parse } from "../src/core/parse.ts";
import {
  type FileParser,
  joinPath,
  loadProject,
  type ParsedFile,
  parseFileFresh,
} from "../src/core/project.ts";
import { resolveProject } from "../src/core/resolve.ts";
import { memoryHost, type Result } from "../src/core/source.ts";
import { validateProject } from "../src/core/validate_project.ts";
import {
  applyBodyEdit,
  applyInterfaceEdit,
  type GeneratedProject,
  generateProject,
} from "./generate.ts";
import {
  checksum,
  DISTRIBUTION_HEADER,
  distributionCells,
  fixed,
  noiseFloor,
  type Pair,
  summarize,
  table,
} from "./stats.ts";

// ------------------------------------------------------------------ types

export const STAGES = [
  "lex",
  "parse",
  "index",
  "link",
  "resolve",
  "check",
  "lower",
  "emit",
  "validate",
] as const;

export type Stage = typeof STAGES[number];

export type StageTimes = Readonly<Record<Stage, number>>;

export type M2Error =
  | { readonly tag: "config"; readonly message: string }
  | {
    readonly tag: "diagnostics";
    readonly stage: string;
    readonly count: number;
    readonly first: string;
  }
  | { readonly tag: "emit"; readonly module: string; readonly message: string }
  | {
    readonly tag: "checksum-mismatch";
    readonly where: string;
    readonly expected: string;
    readonly actual: string;
  };

export function describeM2Error(error: M2Error): string {
  switch (error.tag) {
    case "config":
      return `configuration error: ${error.message}`;
    case "diagnostics":
      return `${error.stage} gave ${error.count} diagnostics, first: ${error.first}`;
    case "emit":
      return `cannot emit ${error.module}: ${error.message}`;
    case "checksum-mismatch":
      return `checksum gate failed at ${error.where}: expected ${error.expected}, got ${error.actual}`;
  }
}

export interface SizeConfig {
  readonly name: string;
  /** The scale parameter: the number of feature declarations. */
  readonly declarations: number;
  /** Timed iterations. Each one runs an A/A pair. */
  readonly iterations: number;
  /** Discarded iterations before the timed ones. */
  readonly warmups: number;
  /** Body edits and interface edits per program in the incremental path. */
  readonly editsPerKind: number;
}

export interface M2Config {
  readonly seed: number;
  readonly sizes: readonly SizeConfig[];
  /** Run the incremental path too. */
  readonly incremental: boolean;
}

export interface StageResult {
  readonly stage: Stage | "total";
  /** The time of every timed run of both sides, in milliseconds. */
  readonly samples: readonly number[];
  /** The time of side A and side B of each pair, in milliseconds. */
  readonly pairs: readonly Pair[];
}

export type StepKind = "cold" | "body" | "interface";

export interface StepResult {
  readonly kind: StepKind;
  /** The time of `Program.update`, in milliseconds. */
  readonly update: StageResult;
  /** The time to emit every module that the revision changed, in milliseconds. */
  readonly emit: StageResult;
  /** The modules that the first step of this kind checked again. */
  readonly rechecked: readonly string[];
}

export interface SizeResult {
  readonly name: string;
  readonly declarations: number;
  readonly modules: number;
  readonly sourceBytes: number;
  readonly iterations: number;
  readonly warmups: number;
  /** The checksum of the emitted text, equal in every run. */
  readonly checksum: string;
  readonly stages: readonly StageResult[];
  readonly steps: readonly StepResult[];
}

export interface M2Result {
  readonly seed: number;
  readonly sizes: readonly SizeResult[];
}

// ------------------------------------------------------------------ prepared input

interface Prepared {
  /** `.eff` and `.effi` files, sorted by path. */
  readonly sourceFiles: readonly (readonly [string, string])[];
  readonly hostFiles: ReadonlyMap<string, string>;
  /** The `.eff` paths: the entries of the program. */
  readonly entries: readonly string[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function prepare(project: GeneratedProject): Prepared {
  const paths = [...project.sources.keys()].sort(compareText);
  const hostFiles = new Map<string, string>();
  for (const [path, text] of project.sources) {
    hostFiles.set(joinPath("", path), text);
  }
  return {
    sourceFiles: paths
      .filter((p) => p.endsWith(".eff") || p.endsWith(".effi"))
      .map((p) => [p, project.sources.get(p) ?? ""] as const),
    hostFiles,
    entries: paths.filter((p) => p.endsWith(".eff")),
  };
}

// ------------------------------------------------------------------ one pipeline run

export interface PipelineRun {
  readonly times: StageTimes;
  readonly total: number;
  readonly checksum: string;
}

function timed<T>(
  times: Record<Stage, number>,
  stage: Stage,
  work: () => T,
): T {
  const start = performance.now();
  const value = work();
  times[stage] = performance.now() - start;
  return value;
}

function firstDiagnostic(diagnostics: readonly Diagnostic[]): string {
  const d = diagnostics[0];
  return d === undefined ? "" : `${d.span.source}: ${d.code}: ${d.message}`;
}

/** Runs every stage once, from the source text to the validated TypeScript text. */
function runPipeline(input: Prepared): Result<PipelineRun, M2Error> {
  const times: Record<Stage, number> = {
    lex: 0,
    parse: 0,
    index: 0,
    link: 0,
    resolve: 0,
    check: 0,
    lower: 0,
    emit: 0,
    validate: 0,
  };

  // The token count keeps the result of the lexer alive.
  const tokens = timed(times, "lex", () => {
    let count = 0;
    for (const [path, text] of input.sourceFiles) {
      count += lex(path, text).count;
    }
    return count;
  });

  const parsed = timed(
    times,
    "parse",
    () =>
      input.sourceFiles.map(([path, text]) =>
        [path, parse(path, text)] as const
      ),
  );
  const files = new Map<string, ParsedFile>();
  timed(times, "index", () => {
    for (const [path, result] of parsed) {
      files.set(path, { parsed: result, index: buildIndex(result.tree) });
    }
  });

  // The link stage reuses the parse results: the file parser answers from the table.
  const parseFile: FileParser = (path, text) => {
    const known = files.get(path);
    return known !== undefined && known.parsed.tree.text === text
      ? known
      : parseFileFresh(path, text);
  };
  const loaded = timed(
    times,
    "link",
    () =>
      loadProject(memoryHost(input.hostFiles), "", input.entries, parseFile),
  );
  if (!loaded.ok) {
    return { ok: false, error: { tag: "config", message: loaded.error.tag } };
  }
  const project = loaded.value;

  // The same steps as `analyzeProject` after the load.
  const analysis: Analysis = timed(times, "resolve", () => {
    const resolutions = resolveProject(project);
    const diagnostics: Diagnostic[] = [...project.diagnostics];
    for (const module of project.modules.values()) {
      diagnostics.push(...module.parseDiagnostics);
    }
    for (const resolution of resolutions.values()) {
      diagnostics.push(...resolution.diagnostics);
    }
    return {
      project,
      resolutions,
      diagnostics: normalizeDiagnostics(diagnostics),
    };
  });
  if (analysis.diagnostics.length > 0) {
    return {
      ok: false,
      error: {
        tag: "diagnostics",
        stage: "resolve",
        count: analysis.diagnostics.length,
        first: firstDiagnostic(analysis.diagnostics),
      },
    };
  }

  const checked: CheckedProject = timed(
    times,
    "check",
    () => checkAnalysis(analysis),
  );
  if (checked.diagnostics.length > 0) {
    return {
      ok: false,
      error: {
        tag: "diagnostics",
        stage: "check",
        count: checked.diagnostics.length,
        first: firstDiagnostic(checked.diagnostics),
      },
    };
  }

  const lowered = timed(times, "lower", () => lowerProject(checked));
  const emittedAll = timed(
    times,
    "emit",
    () => emitProject(lowered, { config: project.config }),
  );
  const emitted: EmittedModule[] = [];
  for (const [name, result] of emittedAll) {
    if (!result.ok) {
      return {
        ok: false,
        error: { tag: "emit", module: name, message: result.error.tag },
      };
    }
    emitted.push(result.value);
  }

  const validation = timed(
    times,
    "validate",
    () => validateProject(project, lowered),
  );
  let validationCount = 0;
  for (const found of validation.values()) validationCount += found.length;
  if (validationCount > 0) {
    return {
      ok: false,
      error: {
        tag: "diagnostics",
        stage: "validate",
        count: validationCount,
        first: "",
      },
    };
  }

  const text = emitted.map((m) => `${m.path}\n${m.text}`).join("\0");
  const total = STAGES.filter((s) => s !== "lex")
    .reduce((sum, stage) => sum + times[stage], 0);
  return {
    ok: true,
    value: {
      times,
      total,
      checksum: checksum(`${tokens}|${emitted.length}|${text}`),
    },
  };
}

// ------------------------------------------------------------------ the gate

/** The first checksum seen for each key. A later different one is an error value. */
export class ChecksumGate {
  private readonly seen = new Map<string, string>();

  check(where: string, actual: string): M2Error | undefined {
    const expected = this.seen.get(where);
    if (expected === undefined) {
      this.seen.set(where, actual);
      return undefined;
    }
    return expected === actual
      ? undefined
      : { tag: "checksum-mismatch", where, expected, actual };
  }
}

// ------------------------------------------------------------------ stage runs

function measureStages(
  input: Prepared,
  config: SizeConfig,
  gate: ChecksumGate,
): Result<
  { readonly stages: readonly StageResult[]; readonly checksum: string },
  M2Error
> {
  const samples = new Map<Stage | "total", number[]>();
  const pairs = new Map<Stage | "total", Pair[]>();
  for (const stage of [...STAGES, "total" as const]) {
    samples.set(stage, []);
    pairs.set(stage, []);
  }
  let sum = "";
  const total = config.warmups + config.iterations;
  for (let k = 0; k < total; k++) {
    const timedRun = k >= config.warmups;
    // Alternate the order of the two sides so that order effects show in the floor.
    const runs: PipelineRun[] = [];
    for (let side = 0; side < 2; side++) {
      const run = runPipeline(input);
      if (!run.ok) return run;
      const failure = gate.check("pipeline", run.value.checksum);
      if (failure !== undefined) return { ok: false, error: failure };
      sum = run.value.checksum;
      runs.push(run.value);
    }
    if (!timedRun) continue;
    const first = runs[0];
    const second = runs[1];
    if (first === undefined || second === undefined) continue;
    const a = k % 2 === 0 ? first : second;
    const b = k % 2 === 0 ? second : first;
    for (const stage of STAGES) {
      samples.get(stage)?.push(first.times[stage], second.times[stage]);
      pairs.get(stage)?.push([a.times[stage], b.times[stage]]);
    }
    samples.get("total")?.push(first.total, second.total);
    pairs.get("total")?.push([a.total, b.total]);
  }
  const stages = [...STAGES, "total" as const].map((stage): StageResult => ({
    stage,
    samples: samples.get(stage) ?? [],
    pairs: pairs.get(stage) ?? [],
  }));
  return { ok: true, value: { stages, checksum: sum } };
}

// ------------------------------------------------------------------ incremental path

interface StepSample {
  readonly kind: StepKind;
  readonly update: number;
  readonly emit: number;
  readonly rechecked: readonly string[];
  readonly checksum: string;
}

/** One program and the current text of the edited module. */
interface Side {
  readonly program: Program;
  text: string;
}

function emitAll(revision: Revision): Result<string, M2Error> {
  const parts: string[] = [];
  for (const name of revision.effModuleNames()) {
    const emitted = revision.emitted(name);
    if (emitted === undefined) continue;
    if (!emitted.ok) {
      return {
        ok: false,
        error: { tag: "emit", module: name, message: emitted.error.tag },
      };
    }
    parts.push(emitted.value.text);
  }
  return { ok: true, value: parts.join("\0") };
}

function step(
  side: Side,
  kind: StepKind,
  index: number,
  project: GeneratedProject,
): Result<StepSample, M2Error> {
  let set: Map<string, string>;
  if (kind === "cold") {
    set = new Map(project.sources);
  } else {
    side.text = kind === "body"
      ? applyBodyEdit(side.text, index + 1)
      : applyInterfaceEdit(side.text);
    set = new Map([[project.edit.path, side.text]]);
  }
  const start = performance.now();
  const updated = side.program.update({ set });
  const update = performance.now() - start;
  if (!updated.ok) {
    return { ok: false, error: { tag: "config", message: updated.error.tag } };
  }
  const revision = updated.value;
  if (revision.diagnostics.length > 0) {
    return {
      ok: false,
      error: {
        tag: "diagnostics",
        stage: `update (${kind})`,
        count: revision.diagnostics.length,
        first: firstDiagnostic(revision.diagnostics),
      },
    };
  }
  const emitStart = performance.now();
  const text = emitAll(revision);
  const emit = performance.now() - emitStart;
  if (!text.ok) return text;
  return {
    ok: true,
    value: {
      kind,
      update,
      emit,
      rechecked: revision.rechecked,
      checksum: checksum(`${revision.rechecked.join(",")}|${text.value}`),
    },
  };
}

/** The step kinds of one program: a cold start, then alternating edits. */
function stepKinds(editsPerKind: number): StepKind[] {
  const kinds: StepKind[] = ["cold"];
  for (let e = 0; e < editsPerKind; e++) kinds.push("body", "interface");
  return kinds;
}

function measureSteps(
  project: GeneratedProject,
  config: SizeConfig,
  gate: ChecksumGate,
): Result<readonly StepResult[], M2Error> {
  const kinds = stepKinds(config.editsPerKind);
  const update = new Map<StepKind, { samples: number[]; pairs: Pair[] }>();
  const emit = new Map<StepKind, { samples: number[]; pairs: Pair[] }>();
  const rechecked = new Map<StepKind, readonly string[]>();
  for (const kind of kinds) {
    update.set(kind, { samples: [], pairs: [] });
    emit.set(kind, { samples: [], pairs: [] });
  }
  const total = config.warmups + config.iterations;
  for (let k = 0; k < total; k++) {
    const timedRun = k >= config.warmups;
    const sides: [Side, Side] = [
      {
        program: new Program(""),
        text: project.sources.get(project.edit.path) ?? "",
      },
      {
        program: new Program(""),
        text: project.sources.get(project.edit.path) ?? "",
      },
    ];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      if (kind === undefined) continue;
      // Run the two sides in lock step. The first side alternates.
      const order: readonly (0 | 1)[] = (k + i) % 2 === 0 ? [0, 1] : [1, 0];
      const results: [StepSample | undefined, StepSample | undefined] = [
        undefined,
        undefined,
      ];
      for (const which of order) {
        const side = sides[which];
        const result = step(side, kind, i, project);
        if (!result.ok) return result;
        const failure = gate.check(`step ${i} ${kind}`, result.value.checksum);
        if (failure !== undefined) return { ok: false, error: failure };
        results[which] = result.value;
      }
      const [a, b] = results;
      if (!timedRun || a === undefined || b === undefined) continue;
      const u = update.get(kind);
      const e = emit.get(kind);
      u?.samples.push(a.update, b.update);
      u?.pairs.push([a.update, b.update]);
      e?.samples.push(a.emit, b.emit);
      e?.pairs.push([a.emit, b.emit]);
      if (!rechecked.has(kind)) rechecked.set(kind, a.rechecked);
    }
  }
  const unique = kinds.filter((kind, i) => kinds.indexOf(kind) === i);
  return {
    ok: true,
    value: unique.map((kind): StepResult => ({
      kind,
      update: {
        stage: "total",
        samples: update.get(kind)?.samples ?? [],
        pairs: update.get(kind)?.pairs ?? [],
      },
      emit: {
        stage: "total",
        samples: emit.get(kind)?.samples ?? [],
        pairs: emit.get(kind)?.pairs ?? [],
      },
      rechecked: rechecked.get(kind) ?? [],
    })),
  };
}

// ------------------------------------------------------------------ the run

/** Runs M2 for each configured size. A failed gate gives an error value and no time. */
export function runM2(config: M2Config): Result<M2Result, M2Error> {
  const sizes: SizeResult[] = [];
  for (const size of config.sizes) {
    if (size.iterations < 1) {
      return {
        ok: false,
        error: { tag: "config", message: "iterations must be at least 1" },
      };
    }
    const project = generateProject({
      declarations: size.declarations,
      seed: config.seed,
    });
    const input = prepare(project);
    const stages = measureStages(input, size, new ChecksumGate());
    if (!stages.ok) return stages;
    const steps = config.incremental
      ? measureSteps(project, size, new ChecksumGate())
      : { ok: true, value: [] } as const;
    if (!steps.ok) return steps;
    let sourceBytes = 0;
    for (const [, text] of input.sourceFiles) sourceBytes += text.length;
    sizes.push({
      name: size.name,
      declarations: size.declarations,
      modules: input.entries.length,
      sourceBytes,
      iterations: size.iterations,
      warmups: size.warmups,
      checksum: stages.value.checksum,
      stages: stages.value.stages,
      steps: steps.value,
    });
  }
  return { ok: true, value: { seed: config.seed, sizes } };
}

// ------------------------------------------------------------------ the report

export const TOKEN_NOTE =
  "Token representation (object arrays against typed arrays): not run. " +
  "The lexer in src/core/lex.ts has only the typed-array form (Lexed.kinds, " +
  "starts, ends). The comparison needs a second lexer. It is recorded in " +
  "docs/rejected.md under the evidence gaps.";

const HEADER = ["stage", ...DISTRIBUTION_HEADER, "floor %"];

function stageRow(result: StageResult, digits: number): string[] {
  const floor = noiseFloor(result.pairs);
  return [
    result.stage,
    ...distributionCells(summarize(result.samples), digits),
    fixed(floor.floorPercent, 1),
  ];
}

function describeRechecked(names: readonly string[]): string {
  const shown = names.length > 6
    ? `${names.slice(0, 3).join(", ")}, ..., ${names.slice(-2).join(", ")}`
    : names.join(", ");
  return `${names.length} (${shown})`;
}

export function formatM2(result: M2Result): string {
  const out: string[] = [];
  out.push("M2: whole-module recheck time per stage (milliseconds)");
  out.push(
    "Each run is one pass of the stages over the whole project. The A/A pairs run the same code on both sides.",
  );
  out.push(
    "Rows pool the runs of both sides. The floor column is the noise floor of the row: the p90 of |A/B - 1| over the pairs.",
  );
  out.push(
    "parse includes lex. total is the sum of every stage except lex.",
  );
  for (const size of result.sizes) {
    out.push("");
    out.push(
      `size ${size.name}: ${size.declarations} declarations, ${size.modules} modules, ` +
        `${size.sourceBytes} source characters, seed ${result.seed}, ` +
        `${size.iterations} timed pairs after ${size.warmups} discarded, checksum ${size.checksum}`,
    );
    out.push(table(HEADER, size.stages.map((s) => stageRow(s, 3))));
    if (size.steps.length > 0) {
      out.push("");
      out.push(
        `incremental path through Program.update, size ${size.name} (milliseconds)`,
      );
      const rows: string[][] = [];
      for (const step of size.steps) {
        rows.push([
          `${step.kind} update`,
          ...stageRow(step.update, 3).slice(1),
        ]);
        rows.push([`${step.kind} emit`, ...stageRow(step.emit, 3).slice(1)]);
      }
      out.push(table(HEADER.map((h, i) => (i === 0 ? "step" : h)), rows));
      for (const step of size.steps) {
        out.push(
          `rechecked after ${step.kind}: ${describeRechecked(step.rechecked)}`,
        );
      }
    }
  }
  out.push("");
  out.push(TOKEN_NOTE);
  return out.join("\n");
}

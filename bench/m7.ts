// Measurement M7: the time of a save round through the real language server.
//
// The server runs with `writeOnSave` true on a generated project in a
// temporary directory. The server handles one message at a time, so a request
// that follows `didSave` is answered only after the save round has finished.
// M7 uses `effektive/stats` as that request. The time runs from just before
// the write of `didSave` to the receipt of the `effektive/stats` reply. The
// reply also comes after the flush that follows a round, because the server
// flushes a dirty project before it answers a request for it. So the time
// holds the round and that flush, and one stats round trip. The control row
// `stats only` is that round trip alone.
//
// Scenarios, for each preset:
//   cold       the first round after the open. A fresh server for each sample.
//   stats only the control: `effektive/stats` with no save.
//   repeat     a save with no change on disk.
//   body       the body edit is on disk, then didChange, then the timed save.
//   interface  the same with an interface edit.
//   save all   every module has a body edit on disk. didSave goes out for every
//              open module in one batch. The sample is the time until the last
//              round has finished.
//
// Two server processes, A and B, run each scenario. They are the interleaved
// A/A pair of the protocol, and the side that goes first alternates. The rows
// pool both sides. The noise floor comes from the A/B pairs (see `noiseFloor`).
// The edit, the `didChange`, and its diagnostics wait happen before the timer
// starts. After each round the generated output of the edited module must
// exist on disk, and after a body edit it must hold the new revision.

import type { Result } from "../src/core/source.ts";
import type { SizeName } from "./generate.ts";
import {
  type EditKind,
  loadInput,
  type LspBenchError,
  type LspInput,
  type Session,
  Workspace,
} from "./lsp_script.ts";
import { sessionDocuments } from "./m4.ts";
import {
  DISTRIBUTION_HEADER,
  distributionCells,
  fixed,
  noiseFloor,
  type Pair,
  summarize,
  table,
} from "./stats.ts";

export interface M7PresetConfig {
  readonly size: SizeName;
  /** Fresh server pairs for the cold scenario. */
  readonly coldPairs: number;
  /** Discarded rounds before the timed ones of a warm scenario. */
  readonly warmups: number;
  /** Timed steps for each warm scenario. Each one runs on both sides. */
  readonly steps: number;
  /** Timed "Save All" steps. Each one runs on both sides. */
  readonly saveAllSteps: number;
}

export interface M7Config {
  readonly seed: number;
  readonly presets: readonly M7PresetConfig[];
  /** The limit of each server request or wait, in milliseconds. */
  readonly timeoutMs: number;
}

export const M7_SCENARIOS = [
  "cold",
  "stats only",
  "repeat",
  "body",
  "interface",
  "save all",
] as const;

export type M7Scenario = typeof M7_SCENARIOS[number];

export interface M7Row {
  readonly size: SizeName;
  readonly scenario: M7Scenario;
  /** The number of `didSave` messages of one sample. */
  readonly saves: number;
  /** The time of every timed run of both sides, in milliseconds. */
  readonly samples: readonly number[];
  /** The time of side A and side B of each step, in milliseconds. */
  readonly pairs: readonly Pair[];
}

export interface M7Result {
  readonly seed: number;
  readonly presets: readonly M7PresetConfig[];
  readonly rows: readonly M7Row[];
  /** The wall time of the whole measurement, in milliseconds. */
  readonly elapsedMs: number;
}

/** The latency budget SV-D3 for a body edit save on the large preset, in milliseconds. */
export const SAVE_BUDGET_MS = 100;

/** The 90th percentile of the body edit rows of the large preset, if M7 ran it. */
export function bodyEditP90(result: M7Result): number | undefined {
  const row = result.rows.find((r) =>
    r.size === "large" && r.scenario === "body"
  );
  return row === undefined ? undefined : summarize(row.samples).p90;
}

/** A step on one side: its edit, then its timed save. */
type Step = (session: Session) => Promise<Result<number, LspBenchError>>;

function fail<T>(message: string): Result<T, LspBenchError> {
  return { ok: false, error: { tag: "server", message } };
}

/** The gate after a round: the generated output of the edited module is on disk. */
function checkOutput(
  session: Session,
  revision: number | undefined,
  where: string,
): Result<null, LspBenchError> {
  if (!session.hasOutput()) {
    return fail(`${where}: no generated output on disk after the save`);
  }
  if (
    revision !== undefined &&
    !(session.outputText() ?? "").includes(`n + ${revision}`)
  ) {
    return fail(
      `${where}: the generated output does not hold revision ${revision}`,
    );
  }
  return { ok: true, value: null };
}

function editStep(kind: EditKind): Step {
  return async (session) => {
    const edit = await session.editOnDisk(kind);
    if (!edit.ok) return edit;
    const time = await session.save();
    if (!time.ok) return time;
    const gate = checkOutput(
      session,
      kind === "body" ? edit.value : undefined,
      `${kind} save`,
    );
    return gate.ok ? time : gate;
  };
}

const STEPS: Readonly<Record<Exclude<M7Scenario, "cold">, Step>> = {
  "stats only": (session) => session.statsOnly(),
  repeat: async (session) => {
    const time = await session.save();
    if (!time.ok) return time;
    const gate = checkOutput(session, undefined, "repeat save");
    return gate.ok ? time : gate;
  },
  body: editStep("body"),
  interface: editStep("header"),
  "save all": async (session) => {
    const edit = await session.editAllOnDisk();
    if (!edit.ok) return edit;
    const time = await session.saveAll();
    if (!time.ok) return time;
    const gate = checkOutput(session, undefined, "save all");
    return gate.ok ? time : gate;
  },
};

/** Runs warm-ups and timed steps on two sessions. Returns the pairs. */
async function runPairs(
  a: Session,
  b: Session,
  step: Step,
  warmups: number,
  steps: number,
): Promise<Result<readonly Pair[], LspBenchError>> {
  const pairs: Pair[] = [];
  for (let turn = 0; turn < warmups + steps; turn++) {
    const first = turn % 2 === 0 ? a : b;
    const second = turn % 2 === 0 ? b : a;
    const one = await step(first);
    if (!one.ok) return one;
    const two = await step(second);
    if (!two.ok) return two;
    if (turn < warmups) continue;
    pairs.push(
      turn % 2 === 0 ? [one.value, two.value] : [two.value, one.value],
    );
  }
  return { ok: true, value: pairs };
}

function row(
  size: SizeName,
  scenario: M7Scenario,
  saves: number,
  pairs: readonly Pair[],
): M7Row {
  return {
    size,
    scenario,
    saves,
    samples: pairs.flatMap(([x, y]) => [x, y]),
    pairs,
  };
}

/** Every `.eff` module of the input, the edited one first. */
function allModules(input: LspInput): readonly string[] {
  return sessionDocuments(input, input.files.size);
}

export async function runM7(
  config: M7Config,
): Promise<Result<M7Result, LspBenchError>> {
  const started = performance.now();
  const rows: M7Row[] = [];
  const on = { writeOnSave: true } as const;
  for (const preset of config.presets) {
    const input = loadInput(preset.size, config.seed);

    // Cold: a fresh pair of servers for each pair of samples.
    const cold: Pair[] = [];
    for (let turn = 0; turn < preset.coldPairs; turn++) {
      const workspace = new Workspace();
      try {
        const a = await workspace.open(
          input,
          config.timeoutMs,
          undefined,
          on,
        );
        if (!a.ok) return a;
        const b = await workspace.open(
          input,
          config.timeoutMs,
          undefined,
          on,
        );
        if (!b.ok) return b;
        const first = turn % 2 === 0 ? a.value : b.value;
        const second = turn % 2 === 0 ? b.value : a.value;
        const one = await first.save();
        if (!one.ok) return one;
        const gateOne = checkOutput(first, undefined, "cold save");
        if (!gateOne.ok) return gateOne;
        const two = await second.save();
        if (!two.ok) return two;
        const gateTwo = checkOutput(second, undefined, "cold save");
        if (!gateTwo.ok) return gateTwo;
        cold.push(
          turn % 2 === 0 ? [one.value, two.value] : [two.value, one.value],
        );
        const done = await workspace.finish();
        if (!done.ok) return done;
      } finally {
        await workspace.dispose();
      }
    }
    rows.push(row(preset.size, "cold", 1, cold));

    // Warm scenarios on one pair of servers, with the edit target open.
    const workspace = new Workspace();
    try {
      const a = await workspace.open(input, config.timeoutMs, undefined, on);
      if (!a.ok) return a;
      const b = await workspace.open(input, config.timeoutMs, undefined, on);
      if (!b.ok) return b;
      // The first round creates the disk program. It is the cold scenario.
      for (const session of [a.value, b.value]) {
        const first = await session.save();
        if (!first.ok) return first;
      }
      for (
        const scenario of ["stats only", "repeat", "body", "interface"] as const
      ) {
        const pairs = await runPairs(
          a.value,
          b.value,
          STEPS[scenario],
          preset.warmups,
          preset.steps,
        );
        if (!pairs.ok) return pairs;
        rows.push(
          row(
            preset.size,
            scenario,
            scenario === "stats only" ? 0 : 1,
            pairs.value,
          ),
        );
      }
      const done = await workspace.finish();
      if (!done.ok) return done;
    } finally {
      await workspace.dispose();
    }

    // Save All on its own pair, with every module open.
    const all = new Workspace();
    try {
      const paths = allModules(input);
      const a = await all.open(input, config.timeoutMs, paths, on);
      if (!a.ok) return a;
      const b = await all.open(input, config.timeoutMs, paths, on);
      if (!b.ok) return b;
      for (const session of [a.value, b.value]) {
        const first = await session.save();
        if (!first.ok) return first;
      }
      const pairs = await runPairs(
        a.value,
        b.value,
        STEPS["save all"],
        1,
        preset.saveAllSteps,
      );
      if (!pairs.ok) return pairs;
      rows.push(row(preset.size, "save all", a.value.openCount, pairs.value));
      const done = await all.finish();
      if (!done.ok) return done;
    } finally {
      await all.dispose();
    }
  }
  return {
    ok: true,
    value: {
      seed: config.seed,
      presets: config.presets,
      rows,
      elapsedMs: performance.now() - started,
    },
  };
}

export function formatM7(result: M7Result): string {
  const out: string[] = [];
  out.push(
    "M7: save round latency through the language server (ms), two server processes A and B",
  );
  out.push(
    "Time: from just before the write of didSave to the receipt of the effektive/stats reply that follows it. The server handles one message at a time, so the reply comes after the round and after the flush that follows it. The row `stats only` is that round trip with no save.",
  );
  out.push(
    "Scenarios: cold is the first round after the open (a fresh server for each sample). repeat saves with no change on disk. body and interface write the edit to disk, send didChange, wait for its diagnostics, and then time the save. save all writes a body edit for every module, with every module open, sends didSave for each in one batch, and times until the last round ends. `saves` is the number of didSave messages of one sample.",
  );
  out.push(
    "n counts the runs of both sides. The floor is the p90 of |A/B - 1| in percent over the A/B pairs of the row. Call a later A/B difference below the floor null.",
  );
  out.push(
    `Server options: writeOnSave true, debounceMs 0. Warm-up rounds are dropped. ${
      result.presets.map((p) =>
        `${p.size}: ${p.coldPairs} cold pairs, ${p.warmups} warm-up and ${p.steps} timed steps per warm scenario, 1 warm-up and ${p.saveAllSteps} timed save all steps`
      ).join("; ")
    }.`,
  );
  const rows = result.rows.map((r) => [
    `${r.size} ${r.scenario}`,
    String(r.saves),
    ...distributionCells(summarize(r.samples), 3),
    fixed(noiseFloor(r.pairs).floorPercent, 1),
  ]);
  out.push("");
  out.push(
    table(
      ["preset scenario", "saves", ...DISTRIBUTION_HEADER, "floor %"],
      rows,
    ),
  );
  const p90 = bodyEditP90(result);
  out.push("");
  out.push(
    p90 === undefined
      ? `SV-D3: the large preset did not run, so the budget of ${SAVE_BUDGET_MS} ms p90 for a body edit save has no row.`
      : `SV-D3: body edit save on the large preset, p90 ${
        fixed(p90, 3)
      } ms against the budget of ${SAVE_BUDGET_MS} ms: ${
        p90 <= SAVE_BUDGET_MS ? "within" : "over"
      } the budget.`,
  );
  out.push("");
  out.push(`elapsed ${fixed(result.elapsedMs / 1000, 1)} s`);
  return out.join("\n");
}

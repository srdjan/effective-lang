// The optional variants of M5: other ways to type check the emitted code.
//
// - `tsc` cold: the TypeScript compiler of the npm package `typescript`, run
//   as a new process for each sample.
// - `ts.LanguageService` warm: the same compiler in this process. One
//   discarded call builds the program. Each sample edits one file and asks for
//   the diagnostics of every file, as an editor would after a keystroke.
// - `tsgo` cold: the native preview compiler `@typescript/native-preview`, run
//   as a new process for each sample.
//
// The variants need packages from npm. The harness installs them into a
// temporary workspace with `deno install`, and it loads `typescript` with a
// dynamic import by a computed specifier. Deno then adds no entry to
// `deno.json` or `deno.lock`, and `deno check` does not fetch the package. Run
// the bench task with `--no-lock` so that the dynamic import writes no lock
// entry either.
//
// A variant that cannot run here is skipped with its reason. A skipped variant
// is not an error. The same inputs and the same compiler options as the
// baseline apply: strict, `exactOptionalPropertyTypes`, and
// `noUncheckedIndexedAccess`, with `skipLibCheck` on as `deno check` has it.

import { type M5Error, type Target, writeTarget } from "./m5_target.ts";
import type { Result } from "../src/core/source.ts";
import type { Pair } from "./stats.ts";

/** The pinned tool versions. The first run needs network access to fetch them. */
export const TYPESCRIPT_VERSION = "5.9.3";
export const TSGO_VERSION = "7.0.0-dev.20260707.2";
export const EFFECT_VERSION = "4.0.5";

export interface VariantConfig {
  readonly pairs: number;
  readonly warmups: number;
}

export interface VariantResult {
  readonly variant: string;
  readonly target: string;
  readonly samples: readonly number[];
  readonly pairs: readonly Pair[];
  /** The first call of a warm variant, which builds the program. Absent for cold variants. */
  readonly firstCall?: number;
}

export interface Skipped {
  readonly variant: string;
  readonly reason: string;
}

export interface VariantOutcome {
  readonly results: readonly VariantResult[];
  readonly skipped: readonly Skipped[];
}

export const VARIANT_NAMES = {
  tsc: `tsc ${TYPESCRIPT_VERSION} cold process`,
  service: `ts.LanguageService ${TYPESCRIPT_VERSION} warm`,
  tsgo: `tsgo ${TSGO_VERSION} cold process`,
} as const;

// ------------------------------------------------------------------ helpers

const decoder = new TextDecoder();

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLines(text: string, count: number): string {
  return text.trim().split("\n").slice(0, count).join(" | ");
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      types: [],
    },
    include: ["./*.ts"],
  },
  null,
  2,
);

const PACKAGE_JSON = JSON.stringify(
  {
    type: "module",
    dependencies: { effect: EFFECT_VERSION },
    devDependencies: {
      typescript: TYPESCRIPT_VERSION,
      "@typescript/native-preview": TSGO_VERSION,
    },
  },
  null,
  2,
);

interface ToolRun {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly elapsed: number;
}

async function runDeno(
  args: readonly string[],
  cwd: string,
): Promise<Result<ToolRun, string>> {
  try {
    const start = performance.now();
    const output = await new Deno.Command(Deno.execPath(), {
      args: [...args],
      cwd,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: true,
      value: {
        code: output.code,
        stderr: decoder.decode(output.stderr),
        stdout: decoder.decode(output.stdout),
        elapsed: performance.now() - start,
      },
    };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the TypeScript API

/** The part of the TypeScript API that the warm variant uses. */
interface TsApi {
  readonly sys: {
    fileExists(path: string): boolean;
    readFile(path: string): string | undefined;
  };
  readonly ScriptSnapshot: { fromString(text: string): unknown };
  readConfigFile(
    path: string,
    read: (path: string) => string | undefined,
  ): { readonly config?: unknown };
  parseJsonConfigFileContent(
    json: unknown,
    host: unknown,
    basePath: string,
  ): { readonly options: unknown; readonly fileNames: readonly string[] };
  getDefaultLibFilePath(options: unknown): string;
  createLanguageService(host: unknown): {
    getSyntacticDiagnostics(file: string): readonly unknown[];
    getSemanticDiagnostics(file: string): readonly unknown[];
    dispose(): void;
  };
}

function isTsApi(value: unknown): value is TsApi {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "createLanguageService") === "function" &&
    typeof Reflect.get(value, "parseJsonConfigFileContent") === "function" &&
    typeof Reflect.get(value, "readConfigFile") === "function" &&
    typeof Reflect.get(value, "getDefaultLibFilePath") === "function" &&
    typeof Reflect.get(value, "ScriptSnapshot") === "object" &&
    typeof Reflect.get(value, "sys") === "object";
}

async function loadTypeScript(): Promise<Result<TsApi, string>> {
  // A computed specifier keeps Deno from resolving the package at check time.
  const specifier = `npm:typescript@${TYPESCRIPT_VERSION}`;
  try {
    const loaded: unknown = await import(specifier);
    const fromDefault: unknown = typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "default")
      : undefined;
    if (isTsApi(fromDefault)) return { ok: true, value: fromDefault };
    if (isTsApi(loaded)) return { ok: true, value: loaded };
    return { ok: false, error: "the module has no language service API" };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

interface Service {
  /** Edits the marked file and returns the milliseconds to get every diagnostic, or an error. */
  check(mark: string): Result<number, string>;
  dispose(): void;
}

function createService(
  ts: TsApi,
  directory: string,
  target: Target,
): Result<Service, string> {
  const configPath = `${directory}/tsconfig.json`;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    directory,
  );
  const markedPath = `${directory}/${target.marked}`;
  const original = target.files.get(target.marked) ?? "";
  const overrides = new Map<string, string>();
  const versions = new Map<string, number>();
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (file: string) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file: string) => {
      const text = overrides.get(file) ?? ts.sys.readFile(file);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => directory,
    getDefaultLibFileName: (options: unknown) =>
      ts.getDefaultLibFilePath(options),
    fileExists: (file: string) =>
      overrides.has(file) || ts.sys.fileExists(file),
    readFile: (file: string) => overrides.get(file) ?? ts.sys.readFile(file),
    directoryExists: Reflect.get(ts.sys, "directoryExists"),
    getDirectories: Reflect.get(ts.sys, "getDirectories"),
    realpath: Reflect.get(ts.sys, "realpath"),
  };
  if (parsed.fileNames.length === 0) {
    return { ok: false, error: "the configuration lists no file" };
  }
  const service = ts.createLanguageService(host);
  let version = 0;
  return {
    ok: true,
    value: {
      check(mark) {
        version++;
        overrides.set(markedPath, `${original}// bench ${mark}\n`);
        versions.set(markedPath, version);
        const start = performance.now();
        let count = 0;
        for (const file of parsed.fileNames) {
          count += service.getSyntacticDiagnostics(file).length;
          count += service.getSemanticDiagnostics(file).length;
        }
        const elapsed = performance.now() - start;
        return count === 0
          ? { ok: true, value: elapsed }
          : { ok: false, error: `${count} diagnostics` };
      },
      dispose: () => service.dispose(),
    },
  };
}

// ------------------------------------------------------------------ the run

type Sampler = (mark: string) => Promise<Result<number, string>>;

async function sampleVariant(
  sampler: Sampler,
  config: VariantConfig,
  name: string,
  target: string,
  stamp: string,
): Promise<Result<VariantResult, string>> {
  let counter = 0;
  const next = () => sampler(`${stamp}-${name}-${counter++}`);
  for (let w = 0; w < config.warmups; w++) {
    const run = await next();
    if (!run.ok) return run;
  }
  const samples: number[] = [];
  const pairs: Pair[] = [];
  for (let k = 0; k < config.pairs; k++) {
    const first = await next();
    if (!first.ok) return first;
    const second = await next();
    if (!second.ok) return second;
    samples.push(first.value, second.value);
    pairs.push(
      k % 2 === 0 ? [first.value, second.value] : [second.value, first.value],
    );
  }
  return { ok: true, value: { variant: name, target, samples, pairs } };
}

/** Runs the process variant: write the marked file, then time one process. */
function processSampler(
  directory: string,
  target: Target,
  script: string,
): Sampler {
  return async (mark) => {
    writeTarget(directory, target, mark);
    const run = await runDeno(
      ["run", "-A", "--no-lock", script, "-p", "tsconfig.json"],
      directory,
    );
    if (!run.ok) return run;
    if (run.value.code !== 0) {
      return {
        ok: false,
        error: `exit code ${run.value.code}: ${
          firstLines(run.value.stdout + run.value.stderr, 3)
        }`,
      };
    }
    return { ok: true, value: run.value.elapsed };
  };
}

/**
 * Runs every variant that works here over the targets. Creates one temporary
 * workspace and removes it at the end.
 */
export async function runVariants(
  targets: readonly Target[],
  config: VariantConfig,
): Promise<Result<VariantOutcome, M5Error>> {
  const workspace = Deno.makeTempDirSync({ prefix: "effective-bench-ws-" });
  const results: VariantResult[] = [];
  const skipped: Skipped[] = [];
  const skipAll = (reason: string): Result<VariantOutcome, M5Error> => ({
    ok: true,
    value: {
      results,
      skipped: Object.values(VARIANT_NAMES).map((variant) => ({
        variant,
        reason,
      })),
    },
  });
  try {
    Deno.writeTextFileSync(`${workspace}/package.json`, PACKAGE_JSON);
    const install = await runDeno(["install", "--no-lock"], workspace);
    if (!install.ok) {
      return skipAll(`cannot run deno install: ${install.error}`);
    }
    if (install.value.code !== 0) {
      return skipAll(
        `deno install failed (a first run needs network access): ${
          firstLines(install.value.stderr, 3)
        }`,
      );
    }
    const modules = `${workspace}/node_modules`;
    const scripts = {
      tsc: `${modules}/typescript/bin/tsc`,
      tsgo: `${modules}/@typescript/native-preview/lib/tsgo.js`,
    };
    const ts = await loadTypeScript();
    const stamp = `${Date.now()}-${Deno.pid}`;

    for (const [key, script] of Object.entries(scripts)) {
      const name = key === "tsc" ? VARIANT_NAMES.tsc : VARIANT_NAMES.tsgo;
      if (!exists(script)) {
        skipped.push({ variant: name, reason: `${script} is missing` });
      }
    }
    if (!ts.ok) {
      skipped.push({ variant: VARIANT_NAMES.service, reason: ts.error });
    }
    const failed = new Set<string>();

    for (const [index, target] of targets.entries()) {
      const directory = `${workspace}/target-${index}`;
      Deno.mkdirSync(directory, { recursive: true });
      Deno.writeTextFileSync(`${directory}/tsconfig.json`, TSCONFIG);
      writeTarget(directory, target, "initial");

      const runs: [string, string, Sampler | undefined][] = [
        [
          "tsc",
          VARIANT_NAMES.tsc,
          exists(scripts.tsc)
            ? processSampler(directory, target, scripts.tsc)
            : undefined,
        ],
        [
          "tsgo",
          VARIANT_NAMES.tsgo,
          exists(scripts.tsgo)
            ? processSampler(directory, target, scripts.tsgo)
            : undefined,
        ],
      ];
      for (const [, name, sampler] of runs) {
        if (sampler === undefined || failed.has(name)) continue;
        const measured = await sampleVariant(
          sampler,
          config,
          name,
          target.name,
          stamp,
        );
        if (measured.ok) results.push(measured.value);
        else {
          failed.add(name);
          skipped.push({
            variant: name,
            reason: `${target.name}: ${measured.error}`,
          });
        }
      }

      if (ts.ok && !failed.has(VARIANT_NAMES.service)) {
        const services = [
          createService(ts.value, directory, target),
          createService(ts.value, directory, target),
        ];
        const [a, b] = services;
        if (a === undefined || b === undefined || !a.ok || !b.ok) {
          failed.add(VARIANT_NAMES.service);
          skipped.push({
            variant: VARIANT_NAMES.service,
            reason: `${target.name}: ${
              [a, b].map((s) => (s !== undefined && !s.ok ? s.error : ""))
                .join("")
            }`,
          });
        } else {
          // The first call builds the program and loads every library file.
          const first = a.value.check(`${stamp}-first`);
          const firstB = b.value.check(`${stamp}-first`);
          if (!first.ok || !firstB.ok) {
            failed.add(VARIANT_NAMES.service);
            skipped.push({
              variant: VARIANT_NAMES.service,
              reason: `${target.name}: ${
                !first.ok ? first.error : !firstB.ok ? firstB.error : ""
              }`,
            });
          } else {
            let turn = 0;
            const sides = [a.value, b.value];
            // Each call of the sampler runs the next side. The pair order alternates.
            const sampler: Sampler = (mark) => {
              const side = sides[turn++ % 2];
              return Promise.resolve(
                side === undefined
                  ? { ok: false, error: "no side" }
                  : side.check(mark),
              );
            };
            const measured = await sampleVariant(
              sampler,
              { ...config, warmups: 0 },
              VARIANT_NAMES.service,
              target.name,
              stamp,
            );
            if (measured.ok) {
              results.push({ ...measured.value, firstCall: first.value });
            } else {
              failed.add(VARIANT_NAMES.service);
              skipped.push({
                variant: VARIANT_NAMES.service,
                reason: `${target.name}: ${measured.error}`,
              });
            }
          }
          a.value.dispose();
          b.value.dispose();
        }
      }
    }
    return { ok: true, value: { results, skipped } };
  } finally {
    try {
      Deno.removeSync(workspace, { recursive: true });
    } catch {
      // The system removes the temporary directory later.
    }
  }
}

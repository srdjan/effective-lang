// The build of the playground (plan section 8). `build(outDir)` bundles the
// page script with `deno bundle`, copies the static files, and writes
// `examples.json`. Expected failures come back as `BuildError` values.
//
// Run `deno task playground:build [outDir]`. The default output directory is
// `playground/dist` in the repository root.

import {
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type { Result } from "../src/core/source.ts";

/** The repository root, found from this file and not from the process cwd. */
export const REPOSITORY_ROOT: string = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "..",
);

/** The files of `fixtures/examples` that the page edits (plan 5.2). */
const EXAMPLE_FILES: readonly string[] = [
  "effektive.json",
  "collections.eff",
  "log.eff",
  "main.eff",
  "pay.eff",
  "users.eff",
  "host/providers.effi",
];

export interface BuildReport {
  /** Every file that the build wrote, as an absolute path. */
  readonly written: readonly string[];
  /** The size of `app.js` in bytes. */
  readonly appBytes: number;
  /** The size of `app.js` after gzip, in bytes. */
  readonly appGzipBytes: number;
}

export type BuildError =
  | { readonly tag: "unsafe-out-dir"; readonly outDir: string }
  | {
    readonly tag: "bundle-failed";
    readonly code: number;
    readonly stderr: string;
  }
  | { readonly tag: "io"; readonly message: string };

/** The size of `bytes` after gzip, from `CompressionStream`. */
async function gzipSize(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/** Lists the files below `dir` as absolute paths. */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function copyDirectory(from: string, to: string): string[] {
  Deno.mkdirSync(to, { recursive: true });
  const written: string[] = [];
  for (const entry of Deno.readDirSync(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) written.push(...copyDirectory(source, target));
    else {
      Deno.copyFileSync(source, target);
      written.push(target);
    }
  }
  return written;
}

/**
 * True when removing `outDir` can delete repository files: the root, one of its
 * parents, or a directory inside the repository other than `playground/dist`.
 */
export function isUnsafe(outDir: string): boolean {
  const fromOutDir = relative(outDir, REPOSITORY_ROOT);
  if (fromOutDir === "" || !fromOutDir.startsWith("..")) return true;
  const fromRoot = relative(REPOSITORY_ROOT, outDir);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return false;
  const dist = join("playground", "dist");
  return fromRoot !== dist && !fromRoot.startsWith(dist + SEPARATOR);
}

/**
 * Builds the playground into `outDir`. The directory is removed first. A
 * relative `outDir` is resolved against the process cwd.
 */
export async function build(
  outDir: string,
): Promise<Result<BuildReport, BuildError>> {
  const out = resolve(outDir);
  if (isUnsafe(out)) {
    return { ok: false, error: { tag: "unsafe-out-dir", outDir: out } };
  }
  try {
    Deno.removeSync(out, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return { ok: false, error: { tag: "io", message: String(error) } };
    }
  }
  try {
    Deno.mkdirSync(out, { recursive: true });
    const appPath = join(out, "app.js");
    const bundle = await new Deno.Command("deno", {
      args: [
        "bundle",
        "--platform",
        "browser",
        "--format",
        "esm",
        "--minify",
        "-o",
        appPath,
        "playground/src/app.ts",
      ],
      cwd: REPOSITORY_ROOT,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (bundle.code !== 0) {
      return {
        ok: false,
        error: {
          tag: "bundle-failed",
          code: bundle.code,
          stderr: new TextDecoder().decode(bundle.stderr),
        },
      };
    }
    const written: string[] = [appPath];
    const source = join(REPOSITORY_ROOT, "playground");
    for (const name of ["index.html", "app.css"]) {
      const target = join(out, name);
      Deno.copyFileSync(join(source, name), target);
      written.push(target);
    }
    written.push(...copyDirectory(join(source, "fonts"), join(out, "fonts")));
    const examples: Record<string, string> = {};
    for (const path of EXAMPLE_FILES) {
      examples[path] = Deno.readTextFileSync(
        join(REPOSITORY_ROOT, "fixtures", "examples", path),
      );
    }
    const examplesPath = join(out, "examples.json");
    Deno.writeTextFileSync(examplesPath, JSON.stringify(examples));
    written.push(examplesPath);
    const app = Deno.readFileSync(appPath);
    return {
      ok: true,
      value: {
        written,
        appBytes: app.byteLength,
        appGzipBytes: await gzipSize(app),
      },
    };
  } catch (error) {
    return { ok: false, error: { tag: "io", message: String(error) } };
  }
}

/** Text for a `BuildError`, for the command line. */
export function describeBuildError(error: BuildError): string {
  switch (error.tag) {
    case "unsafe-out-dir":
      return `refusing to remove ${error.outDir}: it holds repository files`;
    case "bundle-failed":
      return `deno bundle failed with exit code ${error.code}:\n${error.stderr}`;
    case "io":
      return `build failed: ${error.message}`;
  }
}

if (import.meta.main) {
  const outDir = Deno.args[0] ?? join(REPOSITORY_ROOT, "playground", "dist");
  const result = await build(outDir);
  if (!result.ok) {
    console.error(describeBuildError(result.error));
    Deno.exit(1);
  }
  const { appBytes, appGzipBytes, written } = result.value;
  console.log(`wrote ${written.length} files to ${resolve(outDir)}`);
  console.log(`app.js: ${appBytes} bytes, ${appGzipBytes} bytes after gzip`);
}

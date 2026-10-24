// The files of a project directory. The CLI reads every `.eff` and `.effi` file
// under the root, and `effektive.json` at the root. The walk skips directories
// whose names start with `.` and directories named `node_modules`.

import {
  compareText,
  CONFIG_FILE,
  joinPath,
  type Result,
} from "../core/mod.ts";
import type { CliFs } from "./io.ts";

function skippedDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** True for a root-relative path that the program reads: a source file or the project file. */
export function isSourcePath(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  const directories = parts.slice(0, -1);
  if (directories.some(skippedDirectory)) return false;
  return name.endsWith(".eff") || name.endsWith(".effi") ||
    (directories.length === 0 && name === CONFIG_FILE);
}

/** The real path of a directory, or undefined when it cannot be resolved. */
function realPath(fs: CliFs, path: string): string | undefined {
  try {
    return fs.absolute(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads the files of the project. The result maps each root-relative path to
 * its text. A file that disappears between the listing and the read is skipped.
 * A file that cannot be read gives an error value.
 */
export function readWorkspace(
  fs: CliFs,
  root: string,
  accepts: (path: string) => boolean = isSourcePath,
): Result<ReadonlyMap<string, string>, string> {
  const files = new Map<string, string>();
  let failure: string | undefined;
  const realRoot = realPath(fs, root);
  if (realRoot === undefined) {
    return { ok: false, error: `${root}: cannot be resolved` };
  }
  const rootPrefix = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
  const visited = new Set<string>();
  const visit = (relative: string): void => {
    if (failure !== undefined) return;
    const path = relative === "" ? root : joinPath(root, relative);
    // Every directory goes through this check, because a listing does not say
    // which entry is a link.
    const real = relative === "" ? realRoot : realPath(fs, path);
    if (real === undefined || visited.has(real)) return;
    if (relative !== "" && !real.startsWith(rootPrefix)) return;
    visited.add(real);
    const listed = fs.list(path);
    if (!listed.ok) {
      failure = listed.error.message;
      return;
    }
    const entries = [...listed.value].sort((a, b) =>
      compareText(a.name, b.name)
    );
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (!skippedDirectory(entry.name)) visit(child);
      } else if (accepts(child)) {
        const read = fs.readText(joinPath(root, child));
        if (read.ok) files.set(child, read.value);
        else if (read.error.tag === "unreadable") {
          failure = `${child} cannot be read: ${read.error.message}`;
          return;
        }
      }
    }
  };
  visit("");
  return failure === undefined
    ? { ok: true, value: files }
    : { ok: false, error: failure };
}

/** Local target-check inputs; generated modules are filtered after reading. */
export function isTargetPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.slice(0, -1).some(skippedDirectory)) return false;
  return /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(path) ||
    /(?:^|\/)(?:deno\.jsonc?|deno\.lock|tsconfig(?:\.[^/]+)?\.json|import[-_]map\.json|package(?:-lock)?\.json)$/
      .test(path);
}

export function readTargetInputs(
  fs: CliFs,
  root: string,
): Result<ReadonlyMap<string, string>, string> {
  const read = readWorkspace(fs, root, isTargetPath);
  if (!read.ok) return read;
  return {
    ok: true,
    value: new Map(
      [...read.value].filter(([, text]) =>
        !/^\/\/ Generated from .+\.effi? by the Effective compiler\. Do not edit\./
          .test(text)
      ),
    ),
  };
}

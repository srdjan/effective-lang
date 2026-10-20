// The files of a project directory. The CLI reads every `.eff` and `.effi` file
// under the root, and `effective.json` at the root. The walk skips directories
// whose names start with `.` and directories named `node_modules`.

import { CONFIG_FILE, joinPath, type Result } from "../core/mod.ts";
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

/**
 * Reads the files of the project. The result maps each root-relative path to
 * its text. A file that disappears between the listing and the read is skipped.
 * A file that cannot be read gives an error value.
 */
export function readWorkspace(
  fs: CliFs,
  root: string,
): Result<ReadonlyMap<string, string>, string> {
  const files = new Map<string, string>();
  let failure: string | undefined;
  const visit = (relative: string): void => {
    if (failure !== undefined) return;
    const listed = fs.list(relative === "" ? root : joinPath(root, relative));
    if (!listed.ok) {
      failure = listed.error.message;
      return;
    }
    const entries = [...listed.value].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        if (!skippedDirectory(entry.name)) visit(child);
      } else if (isSourcePath(child)) {
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

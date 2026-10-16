// A session ties one project directory to one program. Each `sync` reads the
// files of the directory, gives the program the difference, and returns the new
// revision. The session keeps the file texts so that the output can show
// one-based lines and columns.

import { type ConfigError, describeConfigError } from "../core/project.ts";
import { Program, type ProgramChanges, type Revision } from "../core/db.ts";
import {
  type BuildOptions,
  type BuildOutcome,
  buildRevision,
} from "./build.ts";
import type { CliIo } from "./io.ts";
import { readWorkspace } from "./workspace.ts";

export type SyncResult =
  /** No file changed since the last sync. */
  | { readonly tag: "unchanged" }
  /** A file could not be read. */
  | { readonly tag: "read-error"; readonly message: string }
  /** The project file is missing or invalid. */
  | {
    readonly tag: "config-error";
    readonly message: string;
    readonly error: ConfigError;
  }
  | { readonly tag: "revision"; readonly revision: Revision };

export class Session {
  private readonly program: Program;
  private known = new Map<string, string>();
  private started = false;

  constructor(
    private readonly io: CliIo,
    readonly root: string,
  ) {
    this.program = new Program(root);
  }

  /** The text of a file of the last sync, by its root-relative path. */
  readonly textOf = (path: string): string | undefined => this.known.get(path);

  /** Reads the directory. The first sync always starts a revision. */
  sync(): SyncResult {
    const read = readWorkspace(this.io.fs, this.root);
    if (!read.ok) return { tag: "read-error", message: read.error };
    const files = read.value;
    const set = new Map<string, string>();
    for (const [path, text] of files) {
      if (this.known.get(path) !== text) set.set(path, text);
    }
    const remove = [...this.known.keys()].filter((path) => !files.has(path));
    if (this.started && set.size === 0 && remove.length === 0) {
      return { tag: "unchanged" };
    }
    this.started = true;
    this.known = new Map(files);
    const changes: ProgramChanges = { set, remove };
    const updated = this.program.update(changes);
    if (!updated.ok) {
      return {
        tag: "config-error",
        message: describeConfigError(updated.error),
        error: updated.error,
      };
    }
    return { tag: "revision", revision: updated.value };
  }

  /** Builds one revision. */
  build(revision: Revision, options: BuildOptions): Promise<BuildOutcome> {
    return buildRevision(this.io, this.root, revision, this.textOf, options);
  }
}

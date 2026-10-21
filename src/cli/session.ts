// A session ties one project directory to one program. Each `sync` reads the
// files of the directory, gives the program the difference, and returns the new
// revision. The session keeps the file texts so that the output can show
// one-based lines and columns.

import {
  describeConfigError,
  diffFiles,
  Program,
  type ProgramChanges,
  type Revision,
} from "../core/mod.ts";
import {
  type BuildOptions,
  type BuildOutcome,
  buildRevision,
} from "./build.ts";
import type { CliIo } from "../host/io.ts";
import { readTargetInputs, readWorkspace } from "../host/workspace.ts";

export type SyncResult =
  /** No file changed since the last sync. */
  | { readonly tag: "unchanged" }
  /** A file could not be read. */
  | { readonly tag: "read-error"; readonly message: string }
  /** The project file is missing or invalid. */
  | { readonly tag: "config-error"; readonly message: string }
  | { readonly tag: "host-change"; readonly revision: Revision }
  | { readonly tag: "revision"; readonly revision: Revision };

export class Session {
  private readonly program: Program;
  private known = new Map<string, string>();
  private started = false;
  private targetInputs = new Map<string, string>();
  private latest: Revision | undefined;

  constructor(
    private readonly io: CliIo,
    readonly root: string,
    private readonly trackTargets = false,
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
    const { set, remove } = diffFiles(this.known, files);
    let hostChanged = false;
    if (this.trackTargets) {
      const hosts = readTargetInputs(this.io.fs, this.root);
      if (!hosts.ok) return { tag: "read-error", message: hosts.error };
      const diff = diffFiles(this.targetInputs, hosts.value);
      hostChanged = diff.set.size > 0 || diff.remove.length > 0;
      this.targetInputs = new Map(hosts.value);
    }
    if (this.started && set.size === 0 && remove.length === 0) {
      return hostChanged && this.latest !== undefined
        ? { tag: "host-change", revision: this.latest }
        : { tag: "unchanged" };
    }
    this.started = true;
    this.known = new Map(files);
    const changes: ProgramChanges = { set, remove };
    const updated = this.program.update(changes);
    if (!updated.ok) {
      this.latest = undefined;
      return {
        tag: "config-error",
        message: describeConfigError(updated.error),
      };
    }
    this.latest = updated.value;
    return { tag: "revision", revision: updated.value };
  }

  /** Builds one revision. */
  build(revision: Revision, options: BuildOptions): Promise<BuildOutcome> {
    return buildRevision(this.io, this.root, revision, this.textOf, options);
  }
}

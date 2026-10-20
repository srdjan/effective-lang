// Projects and the open-document overlay (plan 5.3 and 5.5). A project is a
// directory with `effective.json`. The set keeps one `Program` per project for
// the life of the server. The text that the program sees is the disk text of
// each file with the open documents laid over it. A flush gives the program the
// difference and then publishes diagnostics.
//
// Nothing here throws on purpose. The server wraps each handler, and that
// wrapper is the only exception boundary.

import type { CliFs } from "../host/io.ts";
import { isSourcePath, readWorkspace } from "../host/workspace.ts";
import {
  compareText,
  CONFIG_FILE,
  type ConfigError,
  describeConfigError,
  type Diagnostic as CoreDiagnostic,
  diffFiles,
  joinPath,
  lineStarts,
  Program,
  type Revision,
  type RevisionDelta,
  revisionDelta,
} from "../core/mod.ts";
import {
  applyContentChanges,
  pathToUri,
  spanToRange,
  uriToPath,
} from "./positions.ts";
import type {
  Diagnostic,
  DidChangeParams,
  DidOpenParams,
  FileEvent,
  PublishDiagnosticsParams,
} from "./protocol.ts";

/** The `type` of a `window/logMessage`. */
export type LogType = 1 | 2 | 3 | 4;

/** One open document of a project. */
interface OpenDocument {
  readonly uri: string;
  version: number;
  text: string;
}

/** The state of one project. The set owns it. Other code reads it. */
export class ProjectState {
  /** The disk texts, by root-relative path. */
  disk: ReadonlyMap<string, string> = new Map();
  /** The open documents, by root-relative path. */
  readonly open = new Map<string, OpenDocument>();
  /** The texts that the program has now, by root-relative path. */
  current: ReadonlyMap<string, string> = new Map();
  /** True when the wanted texts may differ from `current`. */
  dirty = false;
  /** True after the first `Program.update`. */
  started = false;
  /** The newest revision that `update` returned. */
  lastGood: Revision | undefined;
  /** `revisionDelta(previous good, last good)` of the newest good update. */
  lastDelta: RevisionDelta | undefined;
  /** The error of the newest update, or undefined when it succeeded. */
  configError: ConfigError | undefined;
  /** The serialized list last published per path. A path never published counts as `[]`. */
  readonly published = new Map<string, string>();
  /** The version of each open document at its last publish. */
  readonly publishedVersions = new Map<string, number>();

  readonly program: Program;

  constructor(readonly root: string) {
    this.program = new Program(root);
  }

  /** The disk texts with the open documents laid over them. */
  wanted(): Map<string, string> {
    const texts = new Map(this.disk);
    for (const [path, document] of this.open) texts.set(path, document.text);
    return texts;
  }
}

/** A document that belongs to a project. */
interface DocumentRef {
  readonly project: ProjectState;
  /** The root-relative path. */
  readonly path: string;
}

/** What a flush that ran `Program.update` produced. */
export type FlushOutcome =
  | {
    readonly tag: "revision";
    readonly revision: Revision;
    readonly delta: RevisionDelta;
  }
  | { readonly tag: "config-error"; readonly error: ConfigError };

/** The ports of the set. */
interface ProjectSetPorts {
  readonly fs: CliFs;
  /** Sends `textDocument/publishDiagnostics`. */
  publish(params: PublishDiagnosticsParams): void;
  /** Sends `window/logMessage`. */
  log(type: LogType, message: string): void;
  /** Writes a line to stderr. The set adds the line end. */
  stderr(text: string): void;
  /** Called after each flush that ran `Program.update`, after the diagnostics went out. */
  flushed(project: ProjectState, outcome: FlushOutcome): void;
}

function parentOf(dir: string): string {
  const slash = dir.lastIndexOf("/");
  return slash <= 0 ? "/" : dir.slice(0, slash);
}

/** The root-relative path of `absolute` under `root`, or undefined. */
function relativeTo(root: string, absolute: string): string | undefined {
  const prefix = root === "/" ? "/" : `${root}/`;
  return absolute.startsWith(prefix) && absolute.length > prefix.length
    ? absolute.slice(prefix.length)
    : undefined;
}

/**
 * Converts the diagnostics of a revision, grouped by root-relative path. Each
 * text is the one that the revision used, else the wanted text.
 */
function groupDiagnostics(
  diagnostics: readonly CoreDiagnostic[],
  root: string,
  textOf: (path: string) => string,
): Map<string, Diagnostic[]> {
  const starts = new Map<string, Uint32Array>();
  const rangeOf = (span: CoreDiagnostic["span"]) => {
    const text = textOf(span.source);
    let table = starts.get(span.source);
    if (table === undefined) {
      table = lineStarts(text);
      starts.set(span.source, table);
    }
    return spanToRange(text, table, span);
  };
  const groups = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const related = (d.related ?? []).flatMap((item) => {
      const uri = pathToUri(joinPath(root, item.span.source));
      return uri === undefined ? [] : [{
        location: { uri, range: rangeOf(item.span) },
        message: item.message,
      }];
    });
    const converted: Diagnostic = {
      range: rangeOf(d.span),
      severity: d.severity === "error" ? 1 : 2,
      code: d.code,
      source: "effective",
      message: d.message,
      ...(related.length > 0 ? { relatedInformation: related } : {}),
    };
    const list = groups.get(d.span.source);
    if (list === undefined) groups.set(d.span.source, [converted]);
    else list.push(converted);
  }
  return groups;
}

export class ProjectSet {
  readonly #projects = new Map<string, ProjectState>();
  /** Open documents with a project, by URI. */
  readonly #documents = new Map<string, DocumentRef>();
  /** Open documents without a project, by URI. */
  readonly #orphans = new Set<string>();
  /** URIs whose missing project the set already logged. */
  readonly #logged = new Set<string>();

  constructor(private readonly ports: ProjectSetPorts) {}

  /** The projects in the order they opened. */
  projects(): readonly ProjectState[] {
    return [...this.#projects.values()];
  }

  /** The projects that wait for a flush. */
  dirtyProjects(): readonly ProjectState[] {
    return this.projects().filter((p) => p.dirty);
  }

  /**
   * The project and path of a document, without a flush. An open document is
   * found by URI. Any other `file:` URI is found by the roots of the known
   * projects (the longest root wins).
   */
  lookup(uri: string): DocumentRef | undefined {
    const open = this.#documents.get(uri);
    if (open !== undefined) return open;
    const absolute = uriToPath(uri);
    if (absolute === undefined) return undefined;
    let best: DocumentRef | undefined;
    for (const project of this.#projects.values()) {
      const path = relativeTo(project.root, absolute);
      if (path === undefined || !isSourcePath(path)) continue;
      if (
        best === undefined || project.root.length > best.project.root.length
      ) {
        best = { project, path };
      }
    }
    return best;
  }

  /**
   * The helper for every request handler: finds the document's project and
   * flushes it first when it is dirty, so that the request never reads an old
   * revision. Returns undefined when the document has no project.
   */
  forRequest(uri: string): DocumentRef | undefined {
    const found = this.lookup(uri);
    if (found !== undefined) this.flush(found.project);
    return found;
  }

  /** Flushes every dirty project, in the order they opened. */
  flushDirty(): void {
    for (const project of this.dirtyProjects()) this.flush(project);
  }

  // ---- Notifications ------------------------------------------------------

  didOpen(params: DidOpenParams): void {
    const { uri, version, text } = params.textDocument;
    const previous = this.#documents.get(uri);
    if (previous !== undefined) {
      // A repeated open replaces the document.
      previous.project.open.delete(previous.path);
      previous.project.publishedVersions.delete(previous.path);
      this.#documents.delete(uri);
    }
    this.#orphans.delete(uri);
    const found = this.#discover(uri);
    if (found === undefined) {
      this.#orphans.add(uri);
      if (!this.#logged.has(uri)) {
        this.#logged.add(uri);
        this.ports.log(
          3,
          `${uri} is not in an Effective project; it gets no diagnostics`,
        );
      }
      return;
    }
    const { project, path } = found;
    project.open.set(path, { uri, version, text });
    project.publishedVersions.delete(path);
    project.dirty = true;
    this.#documents.set(uri, found);
  }

  didChange(params: DidChangeParams): void {
    const { uri, version } = params.textDocument;
    const found = this.#documents.get(uri);
    if (found === undefined) {
      if (!this.#orphans.has(uri)) {
        this.ports.stderr(`didChange for a document that is not open: ${uri}`);
      }
      return;
    }
    const document = found.project.open.get(found.path);
    if (document === undefined) return;
    document.text = applyContentChanges(
      document.text,
      params.contentChanges,
    );
    document.version = version;
    found.project.dirty = true;
  }

  didClose(uri: string): void {
    const found = this.#documents.get(uri);
    if (found === undefined) {
      if (!this.#orphans.delete(uri)) {
        this.ports.stderr(`didClose for a document that is not open: ${uri}`);
      }
      return;
    }
    this.#documents.delete(uri);
    const { project, path } = found;
    project.open.delete(path);
    project.publishedVersions.delete(path);
    // The watcher ignores an open document, so a save while it was open never
    // reached `disk`. Read the file again.
    this.#reread(project, path);
    project.dirty = true;
  }

  /** Reads one file of a project from disk again. A missing file leaves `disk`. */
  #reread(project: ProjectState, path: string): void {
    const absolute = joinPath(project.root, path);
    const read = this.ports.fs.readText(absolute);
    const disk = new Map(project.disk);
    if (read.ok) disk.set(path, read.value);
    else if (read.error.tag === "not-found") disk.delete(path);
    else {
      this.ports.stderr(`cannot read ${absolute}: ${read.error.message}`);
      return;
    }
    project.disk = disk;
  }

  /**
   * Watched-file events. An event counts when its path lies under a known
   * project root, passes `isSourcePath`, and is not an open document.
   */
  didChangeWatchedFiles(events: readonly FileEvent[]): void {
    for (const event of events) {
      const absolute = uriToPath(event.uri);
      if (absolute === undefined) continue;
      for (const project of this.#projects.values()) {
        const path = relativeTo(project.root, absolute);
        if (path === undefined || !isSourcePath(path)) continue;
        if (project.open.has(path)) continue;
        if (event.type === 3) {
          const disk = new Map(project.disk);
          disk.delete(path);
          project.disk = disk;
        } else {
          this.#reread(project, path);
        }
        project.dirty = true;
      }
    }
  }

  // ---- Discovery ----------------------------------------------------------

  /** Finds or opens the project of a document. */
  #discover(uri: string): DocumentRef | undefined {
    const absolute = uriToPath(uri);
    if (absolute === undefined) return undefined;
    const fs = this.ports.fs;
    let dir = parentOf(absolute);
    for (;;) {
      if (fs.kind(joinPath(dir, CONFIG_FILE)) === "file") break;
      if (dir === "/" || dir === "") return undefined;
      dir = parentOf(dir);
    }
    const path = relativeTo(dir, absolute);
    if (path === undefined || !isSourcePath(path)) return undefined;
    let project = this.#projects.get(dir);
    if (project === undefined) {
      project = new ProjectState(dir);
      const read = readWorkspace(fs, dir);
      if (read.ok) project.disk = read.value;
      else {
        this.ports.log(1, `cannot read the project ${dir}: ${read.error}`);
      }
      this.#projects.set(dir, project);
    }
    return { project, path };
  }

  // ---- Flush and publish --------------------------------------------------

  /**
   * Gives the program the difference between the wanted texts and its current
   * texts, then publishes. A flush with no text difference starts no revision.
   * It still publishes an open document that was opened or changed in version.
   */
  flush(project: ProjectState): void {
    if (!project.dirty) return;
    project.dirty = false;
    const wanted = project.wanted();
    const { set, remove } = diffFiles(project.current, wanted);
    if (project.started && set.size === 0 && remove.length === 0) {
      this.#publish(project, wanted);
      return;
    }
    project.started = true;
    const updated = project.program.update({ set, remove });
    project.current = wanted;
    let outcome: FlushOutcome;
    if (updated.ok) {
      const delta = revisionDelta(project.lastGood, updated.value);
      project.lastDelta = delta;
      project.lastGood = updated.value;
      project.configError = undefined;
      outcome = { tag: "revision", revision: updated.value, delta };
    } else {
      project.configError = updated.error;
      outcome = { tag: "config-error", error: updated.error };
    }
    this.#publish(project, wanted);
    this.ports.flushed(project, outcome);
  }

  #publish(project: ProjectState, wanted: ReadonlyMap<string, string>): void {
    const error = project.configError;
    if (error !== undefined) {
      // Other files keep the diagnostics that they have.
      const origin = { line: 0, character: 0 };
      this.#publishList(project, CONFIG_FILE, [{
        range: { start: origin, end: origin },
        severity: 1,
        code: "config",
        source: "effective",
        message: describeConfigError(error),
      }]);
      return;
    }
    const revision = project.lastGood;
    if (revision === undefined) return;
    const used = revision.sourceTexts();
    const groups = groupDiagnostics(
      revision.diagnostics,
      project.root,
      (path) => used.get(path) ?? wanted.get(path) ?? "",
    );
    const listOf = (path: string): Diagnostic[] => groups.get(path) ?? [];
    const openPaths = [...project.open.keys()].sort(compareText);
    for (const path of openPaths) {
      const document = project.open.get(path);
      if (document === undefined) continue;
      const newVersion = project.publishedVersions.get(path) !==
        document.version;
      this.#publishList(
        project,
        path,
        listOf(path),
        { uri: document.uri, version: document.version },
        newVersion,
      );
    }
    const closed = new Set([...groups.keys(), ...project.published.keys()]);
    for (const path of [...closed].sort(compareText)) {
      if (project.open.has(path)) continue;
      this.#publishList(project, path, listOf(path));
    }
  }

  /**
   * Publishes one list when `force` is set or when it differs from the list
   * last published for the path. An open document passes its own URI and
   * version. A closed file gets a URI from its path and no version.
   */
  #publishList(
    project: ProjectState,
    path: string,
    list: readonly Diagnostic[],
    open?: { readonly uri: string; readonly version: number },
    force = false,
  ): void {
    const json = JSON.stringify(list);
    if (!force && json === (project.published.get(path) ?? "[]")) return;
    const uri = open?.uri ?? pathToUri(joinPath(project.root, path));
    if (uri === undefined) return;
    project.published.set(path, json);
    if (open === undefined) {
      this.ports.publish({ uri, diagnostics: list });
      return;
    }
    project.publishedVersions.set(path, open.version);
    this.ports.publish({ uri, version: open.version, diagnostics: list });
  }
}

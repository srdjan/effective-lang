// The compile facade of the playground (plan 5.1). It keeps one `Program`
// across edits and turns a revision into plain data for the page: diagnostics
// per file, generated TypeScript per `.eff` file, and the time of the update.
//
// This file has no DOM code and no Deno API. The clock and the program come in
// through `PlaygroundPorts`, so that a test can supply a fake clock and a
// program double.
//
// Where to start. `createPlayground(files, ports)` copies `files` and compiles
// nothing. `session.start()` sends every file in one `update` and returns the
// first result. `session.update(path, text)` sends one file. When `update` runs
// before `start`, it changes the file and then sends every file, so the first
// call to the program always carries the whole project. A call that ends with
// an `internal` error leaves the project unsent, so the next call sends every
// file again.

import {
  type ConfigError,
  describeConfigError,
  errorMessage,
  hoverAt,
  Program,
  type ProgramChanges,
  type Result,
  type Revision,
  type Severity,
} from "../../src/core/mod.ts";

/** The part of `Program` that the facade uses. A test supplies a double. */
export interface ProgramPort {
  update(changes: ProgramChanges): Result<Revision, ConfigError>;
}

interface PlaygroundPorts {
  /** The clock, in milliseconds. `performance.now` fits. */
  readonly now: () => number;
  /** The program. The default is `new Program("")`. */
  readonly program?: ProgramPort;
}

/** One diagnostic of one file. Offsets are UTF-16 code units, `to` exclusive. */
export interface PlaygroundDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

/** The generated TypeScript of one `.eff` file. */
interface PlaygroundOutput {
  readonly text: string;
  /** True when the text comes from an earlier revision, because this one has errors. */
  readonly stale: boolean;
}

export interface PlaygroundResult {
  /** Every file of the revision, keyed by root-relative path. A clean file has an empty list. */
  readonly diagnostics: Readonly<
    Record<string, readonly PlaygroundDiagnostic[]>
  >;
  /** Every `.eff` file, keyed by its source path. `null` means no output ever existed. */
  readonly outputs: Readonly<Record<string, PlaygroundOutput | null>>;
  /** The time of the update and the emits, from `ports.now`. */
  readonly elapsedMs: number;
}

export type PlaygroundError =
  | { readonly tag: "config"; readonly message: string }
  | { readonly tag: "internal"; readonly message: string };

/** The answer of `hover`. The offsets are in the file that the hover names. */
export interface PlaygroundHover {
  readonly from: number;
  readonly to: number;
  readonly contract: string;
  /** The backend type text, `BACKEND_UNAVAILABLE`, or undefined. */
  readonly backend: string | undefined;
}

/** The text that the LSP shows when the module has errors. */
export const BACKEND_UNAVAILABLE =
  "backend type: not available while the module has errors";

export interface Playground {
  /** Sends every file and returns the first result. Later calls send every file again. */
  start(): Result<PlaygroundResult, PlaygroundError>;
  /** Changes one file and compiles. */
  update(
    path: string,
    text: string,
  ): Result<PlaygroundResult, PlaygroundError>;
  /** Hover on the last good revision. Undefined after an error result. */
  hover(path: string, offset: number): PlaygroundHover | undefined;
}

/** The module name of the `.eff` file `path`, as `effModuleOf` in the LSP. */
function effModulesOf(revision: Revision): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const info of revision.moduleInfos()) {
    if (info.mode === "eff") paths.set(info.path, info.name);
  }
  return paths;
}

function diagnosticsOf(
  revision: Revision,
): Record<string, PlaygroundDiagnostic[]> {
  const result: Record<string, PlaygroundDiagnostic[]> = {};
  for (const path of revision.sourceTexts().keys()) result[path] = [];
  for (const diagnostic of revision.diagnostics) {
    const path = diagnostic.span.source;
    (result[path] ??= []).push({
      from: diagnostic.span.start,
      to: diagnostic.span.end,
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    });
  }
  return result;
}

export function createPlayground(
  files: Readonly<Record<string, string>>,
  ports: PlaygroundPorts,
): Playground {
  const program: ProgramPort = ports.program ?? new Program("");
  const texts = new Map<string, string>(Object.entries(files));
  /** The text of the newest emit that succeeded, by source path. */
  const lastGoodText = new Map<string, string>();
  let sent = false;
  let lastGood: Revision | undefined;

  function run(
    changed: string | undefined,
  ): Result<PlaygroundResult, PlaygroundError> {
    lastGood = undefined;
    const started = ports.now();
    try {
      const changes: ProgramChanges = sent && changed !== undefined
        ? { set: new Map([[changed, texts.get(changed) ?? ""]]) }
        : { set: new Map(texts) };
      const updated = program.update(changes);
      sent = true;
      if (!updated.ok) {
        return {
          ok: false,
          error: { tag: "config", message: describeConfigError(updated.error) },
        };
      }
      const revision = updated.value;
      const outputs: Record<string, PlaygroundOutput | null> = {};
      for (const [path, name] of effModulesOf(revision)) {
        const emitted = revision.emitted(name);
        if (emitted !== undefined && emitted.ok) {
          lastGoodText.set(path, emitted.value.text);
          outputs[path] = { text: emitted.value.text, stale: false };
        } else {
          const text = lastGoodText.get(path);
          outputs[path] = text === undefined ? null : { text, stale: true };
        }
      }
      const diagnostics = diagnosticsOf(revision);
      lastGood = revision;
      return {
        ok: true,
        value: { diagnostics, outputs, elapsedMs: ports.now() - started },
      };
    } catch (thrown) {
      sent = false;
      return {
        ok: false,
        error: { tag: "internal", message: errorMessage(thrown) },
      };
    }
  }

  return {
    start: () => run(undefined),
    update(path, text) {
      texts.set(path, text);
      return run(path);
    },
    hover(path, offset) {
      if (lastGood === undefined) return undefined;
      const hit = hoverAt(lastGood, path, offset);
      if (hit === undefined) return undefined;
      const backend = hit.backend === undefined
        ? undefined
        : hit.backend.tag === "type"
        ? hit.backend.text
        : BACKEND_UNAVAILABLE;
      return {
        from: hit.span.start,
        to: hit.span.end,
        contract: hit.contract,
        backend,
      };
    },
  };
}

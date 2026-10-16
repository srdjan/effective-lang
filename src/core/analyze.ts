// The public entry of the front end: load the project, resolve every module, and
// collect all diagnostics. Expected failures are values; nothing throws.

import { type Diagnostic, normalizeDiagnostics } from "./diagnostics.ts";
import { type ConfigError, loadProject, type Project } from "./project.ts";
import { type ModuleResolution, resolveProject } from "./resolve.ts";
import type { Result, SourceHost } from "./source.ts";

export interface Analysis {
  readonly project: Project;
  /** Per-module resolution tables, keyed by module name, in topological order. */
  readonly resolutions: ReadonlyMap<string, ModuleResolution>;
  /** Parse, project, and resolution diagnostics, sorted and without duplicates. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Loads the project at `root` from the entry files (root-relative paths) and
 * every module that they import, then resolves every name. A missing or
 * malformed `effective.json` is an error value. All other problems are
 * diagnostics in the result.
 */
export function analyzeProject(
  host: SourceHost,
  root: string,
  entries: readonly string[],
): Result<Analysis, ConfigError> {
  const loaded = loadProject(host, root, entries);
  if (!loaded.ok) return loaded;
  const project = loaded.value;
  const resolutions = resolveProject(project);
  const diagnostics: Diagnostic[] = [...project.diagnostics];
  for (const module of project.modules.values()) {
    diagnostics.push(...module.parseDiagnostics);
  }
  for (const resolution of resolutions.values()) {
    diagnostics.push(...resolution.diagnostics);
  }
  return {
    ok: true,
    value: {
      project,
      resolutions,
      diagnostics: normalizeDiagnostics(diagnostics),
    },
  };
}

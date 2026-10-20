// The project entry of the IR validator. It validates the IR that
// `lowerProject` returns, reading source texts through the project. Part A7
// wires it to `build --validate`.
//
// This file sits outside `validate/` because it reads the project type. The
// validator itself stays independent of the checker and the lowering.

import type { Diagnostic } from "./diagnostics.ts";
import type { LowerError } from "./lower.ts";
import type { ModuleIR, Result } from "./ir.ts";
import type { Project } from "./project.ts";
import { validateModule } from "./validate/index.ts";

/** The source texts of a project, keyed by the root-relative paths that spans use. */
function projectSources(project: Project): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const info of project.modules.values()) {
    sources.set(info.path, info.tree.text);
  }
  return sources;
}

/**
 * Validates every module that lowered. The result maps a module name to its
 * validation diagnostics; an empty list means the module is valid. A module
 * whose lowering gave an error value has no IR and has no entry.
 */
export function validateProject(
  project: Project,
  lowered: ReadonlyMap<string, Result<ModuleIR, LowerError>>,
): ReadonlyMap<string, readonly Diagnostic[]> {
  const sources = projectSources(project);
  const result = new Map<string, readonly Diagnostic[]>();
  for (const [name, module] of lowered) {
    if (!module.ok) continue;
    result.set(name, validateModule(module.value, sources));
  }
  return result;
}

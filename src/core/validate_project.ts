// The project entry of the IR validator. It validates the IR that
// `lowerProject` returns, reading source texts through the project. Part A7
// wires it to `build --validate`.
//
// This file sits outside `validate/` because it reads the project type. The
// validator itself stays independent of the checker and the lowering.

import {
  type Diagnostic,
  makeDiagnostic,
  normalizeDiagnostics,
} from "./diagnostics.ts";
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
    const diagnostics = validateModule(module.value, sources);
    const recorded = module.value?.module;
    result.set(
      name,
      recorded === name ? diagnostics : normalizeDiagnostics([
        makeDiagnostic(
          "validation/001",
          `module: expected the lowered module ${name}, recorded ${recorded}`,
          { source: project.modules.get(name)?.path ?? name, start: 0, end: 0 },
        ),
        ...diagnostics,
      ]),
    );
  }
  return result;
}

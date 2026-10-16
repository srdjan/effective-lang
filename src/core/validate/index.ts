// The independent typed-IR validator (design D11). It recomputes every
// annotation of a module from the IR alone and reports each disagreement with
// its validation area. This directory imports only `../ir.ts`, `../source.ts`,
// and `../diagnostics.ts`: it shares no code with the checker, the resolver,
// or the lowering, so it can serve as a differential oracle for them.

import { type Diagnostic, normalizeDiagnostics } from "../diagnostics.ts";
import type { ModuleIR, Span } from "../ir.ts";
import { BodyValidator } from "./expr.ts";
import { AREA, Report } from "./report.ts";
import { checkSerialization } from "./serialization.ts";
import {
  buildWorld,
  checkDeclarationHeaders,
  checkImports,
  checkRecursion,
} from "./world.ts";

export { AREA } from "./report.ts";

/**
 * Validates one module. `sources` maps each source identifier to its text. An
 * empty result means the module is valid. The diagnostics are sorted and
 * without duplicates.
 */
export function validateModule(
  ir: ModuleIR,
  sources: ReadonlyMap<string, string>,
): readonly Diagnostic[] {
  const report = new Report();
  const world = buildWorld(ir);
  const ctx = { world, report };
  const fallback: Span = {
    source: ir.sources[0] ?? ir.module,
    start: 0,
    end: 0,
  };
  // A module that does not have the shape of ModuleIR makes a check throw.
  // The validator reports the shape problem and goes on with the next part.
  const guard = (path: string, span: Span, run: () => void): void => {
    try {
      run();
    } catch (e) {
      report.add(
        AREA.serialization,
        path,
        `the IR has an unexpected shape: ${
          e instanceof Error ? e.message : String(e)
        }`,
        span,
      );
    }
  };
  guard("imports", fallback, () => checkImports(ctx, ir));
  guard("declarations", fallback, () => checkDeclarationHeaders(ctx, ir));
  guard("declarations", fallback, () => checkRecursion(ctx, ir));
  ir.declarations.forEach((d, i) => {
    const path = `declarations[${i}]`;
    if (d.kind === "function") {
      guard(path, d.span, () => new BodyValidator(ctx).checkFunction(d, path));
    } else if (d.kind === "constant") {
      guard(path, d.span, () => new BodyValidator(ctx).checkConstant(d, path));
    }
  });
  guard("", fallback, () => checkSerialization(ir, sources, report));
  return normalizeDiagnostics(report.items);
}

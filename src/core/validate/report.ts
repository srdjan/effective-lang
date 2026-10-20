// The report of one validation run. The validator emits one diagnostic per
// disagreement. The code names the validation area (spec, "Equations and
// validation"). A message starts with the IR path of the node.

import { type Diagnostic, makeDiagnostic } from "../diagnostics.ts";
import type { Span } from "../source.ts";

/** The eight validation areas and their codes. */
export const AREA = {
  identity: "validation/001",
  types: "validation/002",
  contracts: "validation/003",
  execution: "validation/004",
  recovery: "validation/005",
  control: "validation/006",
  initialization: "validation/007",
  serialization: "validation/008",
} as const;

export type AreaCode = typeof AREA[keyof typeof AREA];

export class Report {
  readonly items: Diagnostic[] = [];
  /** The declarations that already have a depth report. */
  private readonly deep = new Set<string>();

  add(code: AreaCode, path: string, what: string, span: Span): void {
    this.items.push(makeDiagnostic(code, `${path}: ${what}`, span));
  }

  /**
   * Reports a type nested deeper than `limit` levels at `path`. A report names
   * the declaration of the path, the text before its first `.`, and each
   * declaration gets at most one, however many walkers or branches go past
   * the bound.
   */
  addDepth(path: string, limit: number, span: Span): void {
    const declaration = path.split(".", 1)[0];
    if (this.deep.has(declaration)) return;
    this.deep.add(declaration);
    this.add(AREA.types, path, `type nesting exceeds ${limit} levels`, span);
  }
}

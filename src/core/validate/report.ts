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

  add(code: AreaCode, path: string, what: string, span: Span): void {
    this.items.push(makeDiagnostic(code, `${path}: ${what}`, span));
  }
}

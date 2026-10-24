import { TypeScriptOutputs } from "../src/core/typescript.ts";
const outputs = new TypeScriptOutputs();
// Builds long left-deep chains and runs them through every compiler pass.

import { Program } from "../src/core/mod.ts";

export type ChainForm = "binary" | "pipeline" | "call" | "field" | "array";

export const CHAIN_FORMS: readonly ChainForm[] = [
  "binary",
  "pipeline",
  "call",
  "field",
  "array",
];

/**
 * One module with a chain of `links` links. The aliases keep the annotations
 * free of `declaration/013`. Only the binary and pipeline chains are valid at
 * any length: a call or field chain has no type that it can pass through.
 */
export function chainSource(form: ChainForm, links: number): string {
  switch (form) {
    case "binary":
      return `type I = int\nexport const x: I = ${
        Array(links + 1).fill("1").join(" + ")
      }\n`;
    case "pipeline":
      return `type I = int\nconst id = (a: I): I => a\nexport const x: I = 1${
        " |> id".repeat(links)
      }\n`;
    case "call":
      return `type I = int\nconst f = (): I => 1\nexport const x: I = f${
        "()".repeat(links)
      }\n`;
    case "field":
      return `type I = int\nconst o = { a: 1 }\nexport const x: I = o${
        ".a".repeat(links)
      }\n`;
    case "array":
      return `type I = int\ntype T = I${"[]".repeat(links)}\n`;
  }
}

/** The diagnostic codes of `source` as a module `main.eff`, from `Program.update`. */
export function diagnosticCodes(source: string): string[] {
  const revision = new Program().update({
    set: { "effektive.json": "{}", "main.eff": source },
  });
  if (!revision.ok) throw new Error(JSON.stringify(revision));
  return revision.value.diagnostics.map((d) => d.code);
}

/**
 * Runs `source` through check, lower, validate, emit, the span table, and the
 * source map. Returns the diagnostic codes of the check. A pass that throws
 * propagates. When the check has diagnostics, the later passes do not run.
 */
export function runAllPasses(source: string): string[] {
  const revision = new Program().update({
    set: { "effektive.json": "{}", "main.eff": source },
  });
  if (!revision.ok) throw new Error(JSON.stringify(revision));
  const codes = revision.value.diagnostics.map((d) => d.code);
  if (codes.length > 0) return codes;
  const lowered = revision.value.lowered("main");
  if (lowered === undefined || !lowered.ok) {
    throw new Error(JSON.stringify(lowered));
  }
  const validated = revision.value.validate(new Map([["main", lowered]]))
    .get("main");
  if (validated === undefined || validated.length > 0) {
    throw new Error(JSON.stringify(validated));
  }
  const emitted = outputs.emitted(revision.value, "main");
  if (emitted === undefined || !emitted.ok) {
    throw new Error(JSON.stringify(emitted));
  }
  const map = outputs.sourceMap(revision.value, "main");
  if (map === undefined || !map.ok) throw new Error(JSON.stringify(map));
  return codes;
}

/** `depth` nested parentheses around a binary chain of `links` links. */
export function nestedChainSource(depth: number, links: number): string {
  const chain = Array(links + 1).fill("1").join(" + ");
  return `type I = int\nexport const x: I = ${"(".repeat(depth)}${chain}${
    ")".repeat(depth)
  }\n`;
}

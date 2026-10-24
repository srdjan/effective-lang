// Inlay hints for the inferred `fails` and `uses` sets of non-exported
// functions (terse source plan, TE7). The text comes from `effectText`, the
// printer of the hover contract. Inline arrows get no hint: shortcut, an
// arrow passed as a callback would add a hint to every call site.
import { effectText } from "./check_project.ts";
import type { Revision } from "./db.ts";
import { childrenOf, kindOf, SyntaxKind } from "./syntax.ts";
import { isTypeKind } from "./syntax_queries.ts";

export interface InlayHint {
  /** The offset after the last written part of the header, before `=>`. */
  readonly position: number;
  /** Starts with a space. Holds only the inferred parts. */
  readonly label: string;
}

/**
 * The hints whose position is inside `range` (inclusive) in the file `path`.
 * A function with a diagnostic inside its span gets no hint, because the
 * inferred sets of a broken body are unreliable.
 */
export function inlayHintsAt(
  revision: Revision,
  path: string,
  range: { readonly start: number; readonly end: number },
): readonly InlayHint[] {
  const module = revision.checkedModuleAt(path);
  if (module === undefined || !path.endsWith(".eff")) return [];
  const { tree } = module;
  const index = revision.moduleInfo(module.module)?.index;
  const hints: InlayHint[] = [];
  for (const fn of module.functions.values()) {
    const { signature } = fn;
    const { written } = signature;
    if (signature.exported || (written.fails && written.uses)) continue;
    const label = effectText(
      written.fails ? [] : fn.failures,
      written.uses ? [] : fn.requirements,
    );
    if (label === "" || index?.byName.get(signature.name)?.broken !== false) {
      continue;
    }
    if (
      module.diagnostics.some((d) =>
        d.span.start >= signature.span.start && d.span.end <= signature.span.end
      )
    ) continue;
    let position = -1;
    for (const child of childrenOf(tree, signature.node)) {
      if (kindOf(tree, child) !== SyntaxKind.ArrowExpr) continue;
      for (const part of childrenOf(tree, child)) {
        const kind = kindOf(tree, part);
        if (
          kind === SyntaxKind.ParamList || kind === SyntaxKind.FailsClause ||
          kind === SyntaxKind.UsesClause || isTypeKind(kind)
        ) position = Math.max(position, tree.ends[part]);
      }
    }
    if (position < range.start || position > range.end) continue;
    hints.push({ position, label });
  }
  return hints;
}

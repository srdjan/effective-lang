// Contract edits come from checked body effect sets, never diagnostic prose.
import { Program, type Revision } from "./db.ts";
import { diagnosticDelta } from "./diagnostic_delta.ts";
import type { SourceEdit } from "./editor_rename.ts";
import { applySourceEdits } from "./editor_rename.ts";
import { EFFECT_ERROR_IDS } from "./resolve.ts";
import { childrenOf, kindOf, SyntaxKind } from "./syntax.ts";

export interface ContractAction {
  readonly title: string;
  readonly edits: readonly SourceEdit[];
}

function effectName(
  revision: Revision,
  module: string,
  id: string,
): string | undefined {
  for (const [name, effectId] of EFFECT_ERROR_IDS) {
    if (id === effectId) return name;
  }
  const namespace = revision.resolution(module)?.namespace;
  for (const [name, binding] of namespace ?? []) {
    const target = binding.target;
    if ("id" in target && target.id === id) return name;
    if (target.kind === "service") {
      for (const method of binding.service?.entry.methodList ?? []) {
        if (`cap:${target.id.slice("service:".length)}.${method.name}` === id) {
          return `${name}.${method.name}`;
        }
      }
    }
  }
  return undefined;
}

/** Missing fails/uses only, for written clauses of inline contracts with reliable bodies. */
export function contractActionsAt(
  revision: Revision,
  path: string,
  start: number,
  end = start,
): readonly ContractAction[] {
  const module = revision.checkedModuleAt(path);
  if (module === undefined || !path.endsWith(".eff")) return [];
  const output: ContractAction[] = [];
  for (const fn of module.functions.values()) {
    const { signature, body } = fn;
    if (
      signature.annotation !== "arrow" || !signature.written.result ||
      body === undefined || signature.span.end < start ||
      end < signature.span.start
    ) continue;
    const entry = revision.moduleInfo(module.module)?.index.byName.get(
      signature.name,
    );
    if (entry === undefined || entry.broken) continue;
    // Other body errors can make the inferred effect set incomplete.
    if (
      module.diagnostics.some((d) =>
        d.span.start >= signature.span.start &&
        d.span.end <= signature.span.end && d.code !== "failure-contract/001" &&
        d.code !== "requirement-contract/001"
      )
    ) continue;
    // An open set has no clause to extend, so it never misses an entry.
    const missingFailures = signature.written.fails
      ? body.failures.filter((id) => !signature.failures.includes(id))
      : [];
    const missingUses = signature.written.uses
      ? body.requirements.filter((id) => !signature.requirements.includes(id))
      : [];
    if (missingFailures.length === 0 && missingUses.length === 0) continue;
    const failureNames = missingFailures.map((id) =>
      effectName(revision, module.module, id)
    );
    const useNames = missingUses.map((id) =>
      effectName(revision, module.module, id)
    );
    if ([...failureNames, ...useNames].some((n) => n === undefined)) continue;
    const { tree } = module;
    let arrow = -1;
    for (const child of childrenOf(tree, signature.node)) {
      if (kindOf(tree, child) === SyntaxKind.ArrowExpr) arrow = child;
    }
    if (arrow < 0) continue;
    const children = [...childrenOf(tree, arrow)];
    const fails = children.find((n) =>
      kindOf(tree, n) === SyntaxKind.FailsClause
    );
    const uses = children.find((n) =>
      kindOf(tree, n) === SyntaxKind.UsesClause
    );
    const text = tree.text;
    // Reuse the parsed clauses and arrow token, preserving all existing entries.
    const token = children.find((n) =>
      text.slice(tree.starts[n], tree.ends[n]) === "=>"
    );
    if (token === undefined) continue;
    const edits: SourceEdit[] = [];
    if (failureNames.length > 0) {
      const at = fails !== undefined
        ? tree.ends[fails]
        : uses !== undefined
        ? tree.starts[uses]
        : tree.starts[token];
      edits.push({
        span: { source: path, start: at, end: at },
        text: fails !== undefined
          ? ` | ${failureNames.join(" | ")}`
          : `fails ${failureNames.join(" | ")} `,
      });
    }
    if (useNames.length > 0) {
      const at = uses !== undefined ? tree.ends[uses] : tree.starts[token];
      edits.push({
        span: { source: path, start: at, end: at },
        text: uses !== undefined
          ? ` | ${useNames.join(" | ")}`
          : `uses ${useNames.join(" | ")} `,
      });
    }
    // Merge insertions at a shared offset in language clause order.
    const merged: SourceEdit[] = [];
    for (const edit of edits) {
      const i = merged.findIndex((e) => e.span.start === edit.span.start);
      if (i < 0) merged.push(edit);
      else merged[i] = { span: edit.span, text: merged[i].text + edit.text };
    }
    const files = new Map(revision.inputs());
    files.set(path, applySourceEdits(text, merged));
    const checked = new Program(revision.root).update({ set: files });
    if (!checked.ok) continue;
    const changedFunction = checked.value.checkedModule(module.module)
      ?.functions.get(signature.id);
    if (
      changedFunction === undefined || changedFunction.body === undefined ||
      (changedFunction.signature.written.fails &&
        changedFunction.body.failures.some((id) =>
          !changedFunction.signature.failures.includes(id)
        )) ||
      (changedFunction.signature.written.uses &&
        changedFunction.body.requirements.some((id) =>
          !changedFunction.signature.requirements.includes(id)
        ))
    ) {
      continue;
    }
    const delta = diagnosticDelta(
      revision.diagnostics,
      checked.value.diagnostics,
      merged,
    );
    if (delta.added.length > 0 || delta.removed.length === 0) {
      continue;
    }
    output.push({
      title: `Add missing ${
        missingFailures.length > 0 && missingUses.length > 0
          ? "fails and uses"
          : missingFailures.length > 0
          ? "fails"
          : "uses"
      } entries`,
      edits: merged,
    });
  }
  return output;
}

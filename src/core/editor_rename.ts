import {
  BUILTIN_TYPE_NAMES,
  PRELUDE_NAMES,
  SHADOWABLE_PRELUDE_NAMES,
} from "./resolve.ts";
// Rename proves that declaration anchors remain the same after re-resolution,
// including uses of symbols that the requested rename does not edit.
import { Program, type Revision } from "./db.ts";
import { lex, TokenKind } from "./lex.ts";
import type { Result, Span } from "./source.ts";
import {
  occurrenceAt,
  sameSpan,
  symbolIndex,
  type SymbolOccurrence,
} from "./editor_index.ts";

export interface SourceEdit {
  readonly span: Span;
  readonly text: string;
}
export interface RenameTarget {
  readonly span: Span;
  readonly name: string;
}

export function prepareRenameAt(
  revision: Revision,
  path: string,
  offset: number,
): RenameTarget | undefined {
  const hit = occurrenceAt(revision, path, offset);
  if (
    hit?.declaration === undefined || !hit.declaration.source.endsWith(".eff")
  ) return undefined;
  if (
    ["field", "builtin", "builtin-type", "unresolved"].includes(hit.target.kind)
  ) return undefined;
  const occurrences = symbolIndex(revision).byIdentity.get(hit.identity) ?? [];
  if (
    occurrences.some((o) =>
      !o.span.source.endsWith(".eff") && !o.span.source.endsWith(".effi")
    )
  ) {
    return undefined;
  }
  const name = revision.sourceTexts().get(path)?.slice(
    hit.span.start,
    hit.span.end,
  );
  return name === undefined ? undefined : { span: hit.span, name };
}

export function applySourceEdits(
  text: string,
  edits: readonly SourceEdit[],
): string {
  return [...edits].sort((a, b) => b.span.start - a.span.start).reduce(
    (value, edit) =>
      value.slice(0, edit.span.start) + edit.text + value.slice(edit.span.end),
    text,
  );
}

function movedSpan(
  span: Span,
  edits: readonly SourceEdit[],
  bindingUse: boolean,
): Span {
  let shift = 0;
  for (
    const edit of edits.filter((e) => e.span.source === span.source).sort((
      a,
      b,
    ) => a.span.start - b.span.start)
  ) {
    if (sameSpan(edit.span, span)) {
      const prefix = bindingUse && edit.text.includes(": ")
        ? edit.text.lastIndexOf(": ") + 2
        : 0;
      return {
        ...span,
        start: span.start + shift + prefix,
        end: span.start + shift + edit.text.length,
      };
    }
    if (edit.span.end <= span.start) {
      shift += edit.text.length - (edit.span.end - edit.span.start);
    }
  }
  return { ...span, start: span.start + shift, end: span.end + shift };
}

export function renameAt(
  revision: Revision,
  path: string,
  offset: number,
  name: string,
): Result<readonly SourceEdit[], string> {
  const lexed = lex("<rename>", name);
  if (
    lexed.diagnostics.length > 0 || lexed.count !== 2 ||
    lexed.kinds[0] !== TokenKind.Ident || lexed.starts[0] !== 0 ||
    lexed.ends[0] !== name.length
  ) return { ok: false, error: "The new name must be a valid identifier." };
  if (
    BUILTIN_TYPE_NAMES.has(name) ||
    (PRELUDE_NAMES.has(name) && !SHADOWABLE_PRELUDE_NAMES.has(name))
  ) return { ok: false, error: "The new name is reserved." };
  const prepared = prepareRenameAt(revision, path, offset);
  const hit = occurrenceAt(revision, path, offset);
  if (prepared === undefined || hit === undefined) {
    return {
      ok: false,
      error: "This symbol cannot be renamed in Effective source.",
    };
  }
  if (prepared.name === name) return { ok: true, value: [] };
  const index = symbolIndex(revision);
  const occurrences = index.byIdentity.get(hit.identity) ?? [];
  const edits = occurrences.map((o) => ({
    span: o.span,
    text: o.shorthand ? `${prepared.name}: ${name}` : name,
  }));
  const files = new Map(revision.inputs());
  for (const [source, text] of files) {
    files.set(
      source,
      applySourceEdits(text, edits.filter((e) => e.span.source === source)),
    );
  }
  const changed = new Program(revision.project.root).update({ set: files });
  if (!changed.ok) {
    return {
      ok: false,
      error: "The rename would invalidate the project configuration.",
    };
  }
  const next = changed.value;
  const beforeAnalysis = revision.checked.analysis;
  const afterAnalysis = next.checked.analysis;
  if (afterAnalysis.diagnostics.length > beforeAnalysis.diagnostics.length) {
    return {
      ok: false,
      error: "The new name is reserved or conflicts with an existing binding.",
    };
  }
  const nextIndex = symbolIndex(next);
  const matching = (old: SymbolOccurrence): SymbolOccurrence | undefined => {
    const at = movedSpan(old.span, edits, true);
    return nextIndex.byPath.get(at.source)?.find((o) => sameSpan(at, o.span));
  };
  for (const old of index.occurrences) {
    if (old.target.kind === "field") continue;
    const current = matching(old);
    if (current === undefined) {
      return {
        ok: false,
        error: "The rename changes the meaning of a source occurrence.",
      };
    }
    if (old.declaration === undefined) {
      if (
        current.declaration !== undefined || current.identity !== old.identity
      ) return { ok: false, error: "The rename would capture another name." };
    } else if (
      !sameSpan(movedSpan(old.declaration, edits, false), current.declaration)
    ) {
      return {
        ok: false,
        error: "The rename would capture or conflict with another binding.",
      };
    }
  }
  return { ok: true, value: edits };
}

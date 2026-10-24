// LSP adaptations of the pure editor queries. Mutations verify every loaded
// source against its current overlay/disk text and return versioned edits.
import {
  completionsAt,
  contractActionsAt,
  inlayHintsAt,
  joinPath,
  lineStarts,
  prepareRenameAt,
  referencesAt,
  renameAt,
  type Result,
  type Revision,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  semanticClassifications,
  type SourceEdit,
  type Span,
} from "../core/mod.ts";
import type { ProjectState } from "./projects.ts";
import type { RequestFailure, ServerContext } from "./server.ts";
import type {
  CodeActionParams,
  EditorPositionParams,
  InlayHintParams,
  ReferencesParams,
  RenameParams,
  TextDocumentParams,
} from "./protocol.ts";
import {
  offsetToPosition,
  pathToUri,
  positionToOffset,
  spanToRange,
} from "./positions.ts";

type Answer = Result<unknown, RequestFailure>;
const answer = (value: unknown): Answer => ({ ok: true, value });
const stale = (): Answer => ({
  ok: false,
  error: {
    code: -32801,
    message:
      "The document changed; request this edit again using the current text.",
  },
});

interface Context {
  readonly project: ProjectState;
  readonly revision: Revision;
  readonly path: string;
  readonly offset: number;
  readonly text: string;
}

function contextOf(
  params: EditorPositionParams,
  ctx: ServerContext,
): Context | undefined {
  const found = ctx.projects.forRequest(params.textDocument.uri);
  if (found === undefined || found.project.configError !== undefined) {
    return undefined;
  }
  const { project, path } = found;
  const revision = project.lastGood;
  if (revision === undefined) return undefined;
  const text = revision.sourceTexts().get(path);
  const current = project.open.get(path);
  if (
    text === undefined || (current?.text ?? project.disk.get(path)) !== text ||
    params.documentVersion !== undefined &&
      current?.version !== params.documentVersion
  ) return undefined;
  return {
    project,
    revision,
    path,
    text,
    offset: positionToOffset(text, lineStarts(text), params.position),
  };
}

function freshProject(context: Context, ctx: ServerContext): boolean {
  const { project, revision } = context;
  if (project.configError !== undefined) return false;
  const config = project.open.get("effektive.json")?.text;
  const diskConfig = config === undefined
    ? ctx.fs.readText(joinPath(project.root, "effektive.json"))
    : undefined;
  const currentConfig = config ??
    (diskConfig?.ok ? diskConfig.value : undefined);
  if (
    currentConfig === undefined ||
    currentConfig !== project.current.get("effektive.json")
  ) return false;
  for (const [path, text] of revision.sourceTexts()) {
    const open = project.open.get(path);
    if (open !== undefined) { if (open.text !== text) return false; }
    else {
      const disk = ctx.fs.readText(joinPath(project.root, path));
      if (!disk.ok || disk.value !== text) return false;
    }
  }
  return true;
}

function location(context: Context, span: Span): unknown | undefined {
  const text = context.revision.sourceTexts().get(span.source);
  const uri = pathToUri(joinPath(context.project.root, span.source));
  return text === undefined || uri === undefined
    ? undefined
    : { uri, range: spanToRange(text, lineStarts(text), span) };
}

function workspaceEdit(
  context: Context,
  edits: readonly SourceEdit[],
): unknown {
  const grouped = new Map<string, SourceEdit[]>();
  for (const edit of edits) {
    const group = grouped.get(edit.span.source) ?? [];
    group.push(edit);
    grouped.set(edit.span.source, group);
  }
  return {
    documentChanges: [...grouped].map(([path, changes]) => {
      const text = context.revision.sourceTexts().get(path) ?? "";
      const starts = lineStarts(text);
      return {
        textDocument: {
          uri: pathToUri(joinPath(context.project.root, path)),
          version: context.project.open.get(path)?.version ?? null,
        },
        edits: changes.map((change) => ({
          range: spanToRange(text, starts, change.span),
          newText: change.text,
        })),
      };
    }),
  };
}

export function referencesRequest(
  params: ReferencesParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf(params, ctx);
  return answer(
    context === undefined ? [] : referencesAt(
      context.revision,
      context.path,
      context.offset,
      params.includeDeclaration,
    ).map((span) => location(context, span)).filter((loc) => loc !== undefined),
  );
}

export function prepareRenameRequest(
  params: EditorPositionParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf(params, ctx);
  if (context === undefined || !freshProject(context, ctx)) return stale();
  const prepared = prepareRenameAt(
    context.revision,
    context.path,
    context.offset,
  );
  return answer(
    prepared === undefined ? null : {
      range: spanToRange(
        context.text,
        lineStarts(context.text),
        prepared.span,
      ),
      placeholder: prepared.name,
    },
  );
}

export function renameRequest(
  params: RenameParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf(params, ctx);
  if (context === undefined || !freshProject(context, ctx)) return stale();
  const result = renameAt(
    context.revision,
    context.path,
    context.offset,
    params.newName,
  );
  return result.ok
    ? answer(workspaceEdit(context, result.value))
    : { ok: false, error: { code: -32602, message: result.error } };
}

const completionKinds = {
  variable: 6,
  function: 3,
  type: 7,
  class: 7,
  interface: 8,
  method: 2,
  property: 10,
  keyword: 14,
} as const;
export function completionRequest(
  params: EditorPositionParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf(params, ctx);
  if (context === undefined) return answer({ isIncomplete: false, items: [] });
  const starts = lineStarts(context.text);
  return answer({
    isIncomplete: false,
    items: completionsAt(context.revision, context.path, context.offset).map(
      (item) => ({
        label: item.label,
        kind: completionKinds[item.kind],
        textEdit: {
          range: spanToRange(context.text, starts, item.span),
          newText: item.label,
        },
      }),
    ),
  });
}

export function semanticTokensRequest(
  params: TextDocumentParams,
  ctx: ServerContext,
): Answer {
  const found = ctx.projects.forRequest(params.textDocument.uri);
  if (found === undefined) return answer({ data: [] });
  const { project, path } = found;
  const text = project.open.get(path)?.text ?? project.disk.get(path);
  if (text === undefined) return answer({ data: [] });
  const starts = lineStarts(text);
  const tokens = semanticClassifications(
    project.configError === undefined ? project.lastGood : undefined,
    path,
    text,
  );
  const data: number[] = [];
  let previousLine = 0, previousCharacter = 0;
  for (const token of tokens) {
    let at = token.span.start;
    while (at < token.span.end) {
      const newline = text.indexOf("\n", at);
      const end = Math.min(token.span.end, newline < 0 ? text.length : newline);
      const contentEnd = end > at && text[end - 1] === "\r" ? end - 1 : end;
      if (contentEnd > at) {
        const position = offsetToPosition(text, starts, at);
        data.push(
          position.line - previousLine,
          position.line === previousLine
            ? position.character - previousCharacter
            : position.character,
          contentEnd - at,
          SEMANTIC_TOKEN_TYPES.indexOf(token.type),
          token.modifiers.reduce(
            (bits, modifier) =>
              bits | 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier),
            0,
          ),
        );
        previousLine = position.line;
        previousCharacter = position.character;
      }
      at = end + 1;
    }
  }
  return answer({ data });
}

export function codeActionRequest(
  params: CodeActionParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf({ ...params, position: params.range.start }, ctx);
  if (context === undefined || !freshProject(context, ctx)) return answer([]);
  const end = positionToOffset(
    context.text,
    lineStarts(context.text),
    params.range.end,
  );
  return answer(
    contractActionsAt(context.revision, context.path, context.offset, end).map(
      (action) => ({
        title: action.title,
        kind: "quickfix",
        edit: workspaceEdit(context, action.edits),
      }),
    ),
  );
}

/** Kind 1 (Type): the label states an inferred contract. */
export function inlayHintRequest(
  params: InlayHintParams,
  ctx: ServerContext,
): Answer {
  const context = contextOf({ ...params, position: params.range.start }, ctx);
  if (context === undefined) return answer([]);
  const { text } = context;
  const starts = lineStarts(text);
  return answer(
    inlayHintsAt(context.revision, context.path, {
      start: context.offset,
      end: positionToOffset(text, starts, params.range.end),
    }).map((hint) => ({
      position: offsetToPosition(text, starts, hint.position),
      label: hint.label,
      kind: 1,
      paddingLeft: false,
    })),
  );
}

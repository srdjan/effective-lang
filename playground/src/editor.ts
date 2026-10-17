/// <reference lib="dom" />
// The CodeMirror parts of the playground page (plan 5.4 and 6.1): the extension
// arrays of the source editor and of the read-only TypeScript pane, the
// highlight decorations from the core lexer, the hover tooltip, the push model
// for diagnostics, and one dark theme bound to the custom properties of
// `app.css`.

import { history } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, setDiagnostics } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  hoverTooltip,
  lineNumbers,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import type { PlaygroundDiagnostic, PlaygroundHover } from "./compile.ts";
import { type HighlightKind, highlightTokens } from "./highlight.ts";
import { type HoverBlock, hoverLines } from "./model.ts";

/** The answer of the facade for a hover at an offset of the active file. */
export type HoverSource = (offset: number) => PlaygroundHover | undefined;

export interface SourceOptions {
  /** Called for each hover. The page binds it to the active file. */
  readonly hover: HoverSource;
  /** Called for each view update, with the update of the editor. */
  readonly onUpdate: (update: ViewUpdate) => void;
}

const KIND_MARKS: Readonly<Record<HighlightKind, Decoration>> = {
  keyword: Decoration.mark({ class: "pg-keyword" }),
  builtin: Decoration.mark({ class: "pg-builtin" }),
  type: Decoration.mark({ class: "pg-type" }),
  string: Decoration.mark({ class: "pg-string" }),
  number: Decoration.mark({ class: "pg-number" }),
  comment: Decoration.mark({ class: "pg-comment" }),
  operator: Decoration.mark({ class: "pg-operator" }),
};

function buildMarks(text: string): DecorationSet {
  return Decoration.set(
    highlightTokens(text).map((range) =>
      KIND_MARKS[range.kind].range(range.from, range.to)
    ),
  );
}

/** Marks the tokens of the core lexer again after each document change. */
const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarks(view.state.doc.toString());
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.decorations = buildMarks(update.state.doc.toString());
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function blockElement(block: HoverBlock): HTMLElement {
  const root = document.createElement("div");
  root.className = "pg-hover-block";
  const label = document.createElement("div");
  label.className = "pg-hover-label";
  label.textContent = block.label;
  const body = document.createElement(block.code ? "pre" : "p");
  body.className = block.code ? "pg-hover-code" : "pg-hover-note";
  body.textContent = block.text;
  root.append(label, body);
  return root;
}

function hoverExtension(source: HoverSource): Extension {
  return hoverTooltip((_view, offset): Tooltip | null => {
    const hit = source(offset);
    const lines = hoverLines(hit);
    if (hit === undefined || lines.tooltip.length === 0) return null;
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "pg-hover";
        dom.append(...lines.tooltip.map(blockElement));
        return { dom };
      },
    };
  });
}

/**
 * The theme of both panes. Every color is a custom property of `app.css`, so
 * the page owns the palette. The pane fills its host. `.cm-scroller` scrolls,
 * and the page does not.
 */
const theme: Extension = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--code-ink)",
    backgroundColor: "var(--code-bg)",
    fontSize: "16px",
  },
  "&.cm-focused": {
    outline: "3px solid var(--accent)",
    outlineOffset: "-3px",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-code)",
    lineHeight: "1.5",
  },
  ".cm-content": {
    caretColor: "var(--code-ink)",
    padding: "0.5rem 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--code-ink)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--code-selection)" },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    color: "var(--code-comment)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--code-active-line)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--code-active-line)",
    color: "var(--code-ink)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--code-selection)",
    outline: "1px solid var(--code-comment)",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "transparent",
    outline: "1px solid var(--code-error)",
  },
  ".cm-panels": {
    backgroundColor: "var(--code-raised)",
    color: "var(--code-ink)",
  },
  // A white ring gives the lift on the dark pane. The transparent border keeps
  // an edge in forced-colors mode. `overflow: hidden` clips the square bar of a
  // diagnostic to the rounded corners.
  ".cm-tooltip": {
    backgroundColor: "var(--code-raised)",
    color: "var(--code-ink)",
    border: "1px solid transparent",
    borderRadius: "4px",
    boxShadow: "0 0 0 1px oklch(1 0 0 / 0.08)",
    overflow: "hidden",
  },
  ".cm-tooltip-lint": { padding: "0", margin: "0" },
  ".cm-diagnostic-error": { borderLeft: "5px solid var(--code-error)" },
  ".cm-diagnostic-warning": { borderLeft: "5px solid var(--accent)" },
  ".cm-diagnosticSource": {
    fontSize: "0.8125rem",
    opacity: "1",
    color: "var(--code-comment)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    paddingBottom: "0",
    textDecoration: "underline wavy var(--code-error)",
    textDecorationThickness: "2px",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    paddingBottom: "0",
    textDecoration: "underline wavy var(--accent)",
    textDecorationThickness: "2px",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-active": { backgroundColor: "var(--code-selection)" },
  ".pg-keyword": { color: "var(--code-keyword)" },
  ".pg-builtin": { color: "var(--code-builtin)" },
  ".pg-type": { color: "var(--code-type)" },
  ".pg-string": { color: "var(--code-string)" },
  ".pg-number": { color: "var(--code-number)" },
  ".pg-comment": { color: "var(--code-comment)" },
  ".pg-operator": { color: "var(--code-operator)" },
  ".pg-hover": { padding: "0.5rem 0.75rem", maxWidth: "min(36rem, 90vw)" },
  ".pg-hover-block + .pg-hover-block": { marginTop: "0.5rem" },
  ".pg-hover-label": {
    fontFamily: "var(--font)",
    fontSize: "0.8125rem",
    color: "var(--code-comment)",
  },
  ".pg-hover-code, .pg-hover-note": {
    margin: "0.125rem 0 0",
    fontFamily: "var(--font-code)",
    fontSize: "0.875rem",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
}, { dark: true });

/** Colors for the tokens of the generated TypeScript, from the same palette. */
const generatedStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--code-string)",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  { tag: tags.comment, color: "var(--code-comment)" },
  { tag: [tags.typeName, tags.className], color: "var(--code-type)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--code-builtin)",
  },
  { tag: tags.operator, color: "var(--code-operator)" },
]);

/**
 * The extensions of every source state. All states of the page use this array,
 * because the extensions live in the state and `view.setState` replaces them.
 * It does not bind Tab, so that Tab leaves the editor.
 */
export function sourceExtensions(options: SourceOptions): Extension[] {
  return [
    minimalSetup,
    lineNumbers(),
    history(),
    bracketMatching(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": "Source code" }),
    highlightPlugin,
    hoverExtension(options.hover),
    theme,
    EditorView.updateListener.of(options.onUpdate),
  ];
}

/** The extensions of the read-only pane for the generated TypeScript. */
export function outputExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    javascript({ typescript: true }),
    syntaxHighlighting(generatedStyle),
    lineNumbers(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": "Generated TypeScript",
      "aria-readonly": "true",
      tabindex: "0",
    }),
    theme,
  ];
}

function toLintDiagnostics(
  list: readonly PlaygroundDiagnostic[],
  docLength: number,
): Diagnostic[] {
  return list.map((d) => {
    const from = Math.min(d.from, docLength);
    return {
      from,
      to: Math.max(from, Math.min(d.to, docLength)),
      severity: d.severity,
      message: d.message,
      source: d.code,
    };
  });
}

/**
 * Shows `list` as the diagnostics of the source view. An empty list clears
 * them. Offsets past the end of the document are clamped, because CodeMirror
 * throws a `RangeError` for them.
 */
export function showDiagnostics(
  view: EditorView,
  list: readonly PlaygroundDiagnostic[],
): void {
  view.dispatch(
    setDiagnostics(
      view.state,
      toLintDiagnostics(list, view.state.doc.length),
    ),
  );
}

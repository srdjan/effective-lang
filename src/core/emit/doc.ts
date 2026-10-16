// The printer of the emitter (plan section 6, part A6a): an indentation-aware
// text builder in the style of Wadler and Prettier. The emitter builds a `Doc`
// tree. `render` lays the tree out at a fixed width with one fixed style.
//
// A `span` node tags a part of the output with a source span. `render` returns
// the generated range of each tag. Part A6b uses this seam for the span table
// and the source map.

import type { Span } from "../ir.ts";

export type Doc =
  | string
  | readonly Doc[]
  | { readonly k: "line"; readonly soft: boolean; readonly hard: boolean }
  | { readonly k: "group"; readonly d: Doc; readonly brk: boolean }
  | { readonly k: "indent"; readonly d: Doc }
  | { readonly k: "ifbreak"; readonly broken: Doc; readonly flat: Doc }
  | { readonly k: "alt"; readonly options: readonly Doc[] }
  | { readonly k: "span"; readonly span: Span; readonly d: Doc }
  | { readonly k: "endspan"; readonly span: Span; readonly start: number };

/** A space when flat and a newline when broken. */
export const line: Doc = { k: "line", soft: false, hard: false };
/** Nothing when flat and a newline when broken. */
export const soft: Doc = { k: "line", soft: true, hard: false };
/** Always a newline. A group that contains it always breaks. */
export const hard: Doc = { k: "line", soft: false, hard: true };

export function group(d: Doc, brk = false): Doc {
  return { k: "group", d, brk };
}

export function indent(d: Doc): Doc {
  return { k: "indent", d };
}

export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { k: "ifbreak", broken, flat };
}

/**
 * A choice between layouts, as the conditional group of Prettier. The printer
 * tries each option in order and keeps the first whose first line fits. The
 * last option is printed in break mode.
 */
export function alt(options: readonly Doc[]): Doc {
  return { k: "alt", options };
}

/** Tags the output of `d` with a source span. */
export function spanned(span: Span, d: Doc): Doc {
  return { k: "span", span, d };
}

export function join(separator: Doc, docs: readonly Doc[]): Doc {
  const out: Doc[] = [];
  docs.forEach((d, i) => {
    if (i > 0) out.push(separator);
    out.push(d);
  });
  return out;
}

/** A braced statement list. An empty list prints `{}`. */
export function braces(statements: readonly Doc[]): Doc {
  if (statements.length === 0) return "{}";
  return ["{", indent([hard, join(hard, statements)]), hard, "}"];
}

/** A comma list in brackets: one line when it fits, else one item for each line with a trailing comma. */
export function bracketed(
  open: string,
  close: string,
  items: readonly Doc[],
  padded: boolean,
): Doc {
  if (items.length === 0) return open + close;
  const edge = padded ? line : soft;
  return group([
    open,
    indent([edge, join([",", line], items)]),
    ifBreak(","),
    edge,
    close,
  ]);
}

export interface SpanRecord {
  /** Offsets in UTF-16 code units of the rendered text. The end is exclusive. */
  readonly start: number;
  readonly end: number;
  readonly span: Span;
}

export interface Rendered {
  readonly text: string;
  /** In the order in which the tagged parts close. */
  readonly spans: readonly SpanRecord[];
}

const INDENT_WIDTH = 2;

type Mode = "flat" | "break";

interface Cmd {
  readonly indent: number;
  readonly mode: Mode;
  readonly doc: Doc;
}

function isText(doc: Doc): doc is string {
  return typeof doc === "string";
}

function isList(doc: Doc): doc is readonly Doc[] {
  return Array.isArray(doc);
}

/** True when `doc` holds a hard line outside an `alt`. Memoized by object identity. */
function makeHardCheck(): (doc: Doc) => boolean {
  const memo = new WeakMap<object, boolean>();
  const check = (doc: Doc): boolean => {
    if (isText(doc)) return false;
    const key: object = doc;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result = false;
    if (isList(doc)) {
      result = doc.some(check);
    } else {
      switch (doc.k) {
        case "line":
          result = doc.hard;
          break;
        case "group":
          result = doc.brk || check(doc.d);
          break;
        case "indent":
        case "span":
          result = check(doc.d);
          break;
        case "ifbreak":
          result = check(doc.broken) || check(doc.flat);
          break;
        case "alt":
          // A hard line inside an option does not force the group to break.
          result = false;
          break;
        case "endspan":
          result = false;
          break;
      }
    }
    memo.set(key, result);
    return result;
  };
  return check;
}

/** Lays out `doc` at `width` columns. */
export function render(doc: Doc, width = 80): Rendered {
  const hasHard = makeHardCheck();
  const out: string[] = [];
  const spans: SpanRecord[] = [];
  let column = 0;
  let offset = 0;
  let remeasure = false;
  const stack: Cmd[] = [{ indent: 0, mode: "break", doc }];

  const fits = (next: Cmd, rest: readonly Cmd[], room: number): boolean => {
    let restIndex = rest.length;
    const cmds: Cmd[] = [next];
    let left = room;
    while (left >= 0) {
      const cmd = cmds.pop();
      if (cmd === undefined) {
        if (restIndex === 0) return true;
        restIndex -= 1;
        cmds.push(rest[restIndex]);
        continue;
      }
      const d = cmd.doc;
      if (isText(d)) {
        left -= d.length;
      } else if (isList(d)) {
        for (let i = d.length - 1; i >= 0; i--) {
          cmds.push({ indent: cmd.indent, mode: cmd.mode, doc: d[i] });
        }
      } else {
        switch (d.k) {
          case "line":
            if (cmd.mode === "break" || d.hard) return true;
            if (!d.soft) left -= 1;
            break;
          case "group": {
            const mode: Mode = d.brk || hasHard(d.d) ? "break" : cmd.mode;
            cmds.push({ indent: cmd.indent, mode, doc: d.d });
            break;
          }
          case "indent":
          case "span":
            cmds.push({ indent: cmd.indent, mode: cmd.mode, doc: d.d });
            break;
          case "ifbreak":
            cmds.push({
              indent: cmd.indent,
              mode: cmd.mode,
              doc: cmd.mode === "break" ? d.broken : d.flat,
            });
            break;
          case "alt":
            cmds.push({
              indent: cmd.indent,
              mode: cmd.mode,
              doc: cmd.mode === "break"
                ? d.options[d.options.length - 1]
                : d.options[0],
            });
            break;
          case "endspan":
            break;
        }
      }
    }
    return false;
  };

  const write = (s: string): void => {
    out.push(s);
    column += s.length;
    offset += s.length;
  };
  const newline = (spaces: number): void => {
    out.push("\n" + " ".repeat(spaces));
    offset += 1 + spaces;
    column = spaces;
  };

  while (stack.length > 0) {
    const cmd = stack.pop();
    if (cmd === undefined) break;
    const d = cmd.doc;
    if (isText(d)) {
      write(d);
      continue;
    }
    if (isList(d)) {
      for (let i = d.length - 1; i >= 0; i--) {
        stack.push({ indent: cmd.indent, mode: cmd.mode, doc: d[i] });
      }
      continue;
    }
    switch (d.k) {
      case "line":
        if (cmd.mode === "flat" && !d.hard) {
          if (!d.soft) write(" ");
        } else {
          if (cmd.mode === "flat") remeasure = true;
          newline(cmd.indent);
        }
        break;
      case "group": {
        if (cmd.mode === "flat" && !remeasure) {
          const mode: Mode = d.brk || hasHard(d.d) ? "break" : "flat";
          stack.push({ indent: cmd.indent, mode, doc: d.d });
          break;
        }
        remeasure = false;
        const flat: Cmd = { indent: cmd.indent, mode: "flat", doc: d.d };
        const forced = d.brk || hasHard(d.d);
        if (!forced && fits(flat, stack, width - column)) {
          stack.push(flat);
        } else {
          stack.push({ indent: cmd.indent, mode: "break", doc: d.d });
        }
        break;
      }
      case "indent":
        stack.push({
          indent: cmd.indent + INDENT_WIDTH,
          mode: cmd.mode,
          doc: d.d,
        });
        break;
      case "ifbreak":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: cmd.mode === "break" ? d.broken : d.flat,
        });
        break;
      case "alt": {
        const options = d.options;
        const last = options[options.length - 1];
        if (cmd.mode === "flat" && !remeasure) {
          stack.push({ indent: cmd.indent, mode: "flat", doc: options[0] });
          break;
        }
        remeasure = false;
        const first: Cmd = {
          indent: cmd.indent,
          mode: "flat",
          doc: options[0],
        };
        if (fits(first, stack, width - column)) {
          stack.push(first);
          break;
        }
        let chosen: Cmd | undefined;
        for (let i = 1; i < options.length - 1; i++) {
          const candidate: Cmd = {
            indent: cmd.indent,
            mode: "flat",
            doc: options[i],
          };
          if (fits(candidate, stack, width - column)) {
            chosen = candidate;
            break;
          }
        }
        stack.push(
          chosen ?? { indent: cmd.indent, mode: "break", doc: last },
        );
        break;
      }
      case "span":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: { k: "endspan", span: d.span, start: offset },
        });
        stack.push({ indent: cmd.indent, mode: cmd.mode, doc: d.d });
        break;
      case "endspan":
        spans.push({ start: d.start, end: offset, span: d.span });
        break;
    }
  }
  return { text: out.join(""), spans };
}

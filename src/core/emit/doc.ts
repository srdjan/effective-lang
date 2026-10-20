// The printer of the emitter (plan section 6, part A6a): an indentation-aware
// text builder in the style of Wadler and Prettier. The emitter builds a `Doc`
// tree. `render` lays the tree out at a fixed width with one fixed style.
//
// A `span` node tags a part of the output with a source span. `render` returns
// the generated range of each tag. Part A6b builds the span table and the
// source map from these ranges. A `mark` node tags a part of the output with a
// key, for the ranges that have no source span, such as a host assertion.

import type { Span } from "../ir.ts";

export type Doc =
  | string
  | readonly Doc[]
  | {
    readonly k: "line";
    readonly soft: boolean;
    readonly hard: boolean;
    /** A hard line that a fit test passes: it measures the next line as well. */
    readonly through: boolean;
  }
  | {
    readonly k: "group";
    readonly d: Doc;
    readonly brk: boolean;
    readonly id: GroupId | undefined;
  }
  | {
    readonly k: "ifbroke";
    readonly id: GroupId;
    readonly broken: Doc;
    readonly flat: Doc;
  }
  | { readonly k: "indent"; readonly d: Doc }
  | { readonly k: "ifbreak"; readonly broken: Doc; readonly flat: Doc }
  | { readonly k: "alt"; readonly options: readonly Doc[] }
  | {
    readonly k: "iffits";
    readonly probe: Doc;
    readonly whenFits: Doc;
    readonly otherwise: Doc;
  }
  | { readonly k: "span"; readonly span: Span; readonly d: Doc }
  | { readonly k: "endspan"; readonly span: Span; readonly start: number }
  | { readonly k: "mark"; readonly key: string; readonly d: Doc }
  | { readonly k: "endmark"; readonly key: string; readonly start: number }
  | {
    readonly k: "fill";
    readonly parts: readonly Doc[];
    readonly tail: number;
  }
  | { readonly k: "fillstep"; readonly fill: FillDoc; readonly i: number }
  | { readonly k: "spanopen"; readonly span: Span; readonly id: GroupId }
  | { readonly k: "spanclose"; readonly span: Span; readonly id: GroupId };

/** The `fill` node of the `Doc` type. */
type FillDoc = Extract<Doc, { readonly k: "fill" }>;

/** Names a group, so that a later `ifBroke` can ask whether the group broke. */
export type GroupId = object;

/** A space when flat and a newline when broken. */
export const line: Doc = {
  k: "line",
  soft: false,
  hard: false,
  through: false,
};
/** Nothing when flat and a newline when broken. */
export const soft: Doc = { k: "line", soft: true, hard: false, through: false };
/** Always a newline. A group that contains it always breaks. */
export const hard: Doc = { k: "line", soft: false, hard: true, through: false };
/**
 * Always a newline, like `hard`. A fit test of an `alt` option does not stop
 * at it. The test goes on with the next line, at its indentation.
 */
export const through: Doc = {
  k: "line",
  soft: false,
  hard: true,
  through: true,
};

export function group(d: Doc, brk = false, id?: GroupId): Doc {
  return { k: "group", d, brk, id };
}

/**
 * `broken` when the group named `id` was laid out in break mode, else `flat`.
 * The group must come before this node in the output.
 */
export function ifBroke(id: GroupId, broken: Doc, flat: Doc = ""): Doc {
  return { k: "ifbroke", id, broken, flat };
}

/** Tags the output of `d` with a key. `render` returns its generated range. */
export function marked(key: string, d: Doc): Doc {
  return { k: "mark", key, d };
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

/**
 * `whenFits` when `probe` fits, else `otherwise`. The printer measures `probe`
 * in flat mode at the current position and indentation, without the text that
 * follows the node, and prints nothing for it. A `through` line in `probe`
 * restarts the measure at the indentation of the next line. The chosen branch
 * is printed in the current mode.
 */
export function ifFits(probe: Doc, whenFits: Doc, otherwise: Doc): Doc {
  return { k: "iffits", probe, whenFits, otherwise };
}

/**
 * A greedy fill: `parts` alternate content, separator, content, and so on. The
 * printer puts the next content on the current line when the separator and the
 * content fit there, else it breaks the separator. The first content stays on
 * the current line. The separators and the contents after the first sit
 * `tail` indentation levels deeper.
 */
export function fill(parts: readonly Doc[], tail: number): Doc {
  return { k: "fill", parts, tail };
}

/**
 * The two ends of a span that covers a part of a `fill` and no whole node.
 * The opening end comes first in the output, the closing end after it.
 */
export function spanEnds(span: Span): { open: Doc; close: Doc } {
  const id: GroupId = {};
  return {
    open: { k: "spanopen", span, id },
    close: { k: "spanclose", span, id },
  };
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

/** A call with one argument: `callee(arg)` when it fits, else the argument on a line of its own with a trailing comma. */
export function callWith(callee: Doc, arg: Doc): Doc {
  return [
    callee,
    group(["(", indent([soft, arg]), ifBreak(","), soft, ")"]),
  ];
}

/** Keep a declaration's value beside `=` when its opening fits. */
export function assignment(prefix: Doc, value: Doc): Doc {
  return alt([ifFits(
    [prefix, " = ", group(value, true), ";"],
    [prefix, " = ", value],
    [prefix, " =", indent([hard, value])],
  )]);
}

/** A field or parameter whose value moves below a long label. */
export function property(label: Doc, value: Doc): Doc {
  const inline: Doc = [label, ": ", value];
  return ifBreak(
    alt([ifFits(
      [label, ": ", group(value, true), ","],
      inline,
      [label, ":", indent([hard, value])],
    )]),
    inline,
  );
}

/** A member access or call that breaks before the dot when its head is wide. */
export function member(base: Doc, name: string, tail: Doc = ""): Doc {
  if (tail === "") return group([base, indent([soft, ".", name])]);
  const inline: Doc = [base, ".", name, tail];
  const afterBase = indent([hard, ".", name, tail]);
  const dot = typeof base === "string" ? base.indexOf(".") : -1;
  const broken: Doc = typeof base === "string" && dot > 0
    ? ifFits(
      base,
      [base, afterBase],
      [base.slice(0, dot), indent([hard, base.slice(dot), ".", name, tail])],
    )
    : [base, afterBase];
  return group(ifBreak(
    alt([ifFits(
      [base, ".", name, group(tail, true)],
      inline,
      broken,
    )]),
    inline,
  ));
}

export interface SpanRecord {
  /** Offsets in UTF-16 code units of the rendered text. The end is exclusive. */
  readonly start: number;
  readonly end: number;
  readonly span: Span;
}

interface MarkRecord {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

interface Rendered {
  readonly text: string;
  /** In the order in which the tagged parts close. */
  readonly spans: readonly SpanRecord[];
  /** In the order in which the marked parts close. */
  readonly marks: readonly MarkRecord[];
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
        case "mark":
          result = check(doc.d);
          break;
        case "ifbreak":
        case "ifbroke":
          result = check(doc.broken) || check(doc.flat);
          break;
        case "alt":
          // A hard line inside an option does not force the group to break.
          result = false;
          break;
        case "iffits":
          // The probe prints nothing, so only the two branches count.
          result = check(doc.whenFits) || check(doc.otherwise);
          break;
        case "fill":
          result = doc.parts.some(check);
          break;
        case "endspan":
        case "endmark":
        case "fillstep":
        case "spanopen":
        case "spanclose":
          result = false;
          break;
      }
    }
    memo.set(key, result);
    return result;
  };
  return check;
}

const sharedHardCheck = makeHardCheck();

/**
 * True when `doc` holds a hard line, or a group that must break, outside an
 * `alt`. A fit test of an `alt` option stops at such a line.
 */
export function hasHardLine(doc: Doc): boolean {
  return sharedHardCheck(doc);
}

/** Lays out `doc` at `width` columns. */
export function render(doc: Doc, width = 80): Rendered {
  const hasHard = makeHardCheck();
  const out: string[] = [];
  const spans: SpanRecord[] = [];
  const marks: MarkRecord[] = [];
  /** The groups that were laid out in break mode. */
  const broke = new Set<GroupId>();
  let column = 0;
  let offset = 0;
  let remeasure = false;
  /** The output offsets at which the open ends of fill spans were printed. */
  const openSpans = new Map<GroupId, number>();
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
            if (d.through && cmd.mode === "flat") {
              left = width - cmd.indent;
              break;
            }
            if (cmd.mode === "break" || d.hard) return true;
            if (!d.soft) left -= 1;
            break;
          case "group": {
            const mode: Mode = d.brk || hasHard(d.d) ? "break" : cmd.mode;
            cmds.push({ indent: cmd.indent, mode, doc: d.d });
            break;
          }
          case "indent":
            cmds.push({
              indent: cmd.indent + INDENT_WIDTH,
              mode: cmd.mode,
              doc: d.d,
            });
            break;
          case "span":
          case "mark":
            cmds.push({ indent: cmd.indent, mode: cmd.mode, doc: d.d });
            break;
          case "fill":
            for (let i = d.parts.length - 1; i >= 0; i--) {
              cmds.push({
                indent: i === 0
                  ? cmd.indent
                  : cmd.indent + INDENT_WIDTH * d.tail,
                mode: cmd.mode,
                doc: d.parts[i],
              });
            }
            break;
          case "fillstep":
            // A later separator of the fill may break here.
            if (d.i < d.fill.parts.length) return true;
            break;
          case "spanopen":
          case "spanclose":
            break;
          case "ifbroke":
            cmds.push({
              indent: cmd.indent,
              mode: cmd.mode,
              doc: broke.has(d.id) ? d.broken : d.flat,
            });
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
          case "iffits":
            cmds.push({
              indent: cmd.indent,
              mode: cmd.mode,
              doc: fits(
                  { indent: cmd.indent, mode: "flat", doc: d.probe },
                  [],
                  left,
                )
                ? d.whenFits
                : d.otherwise,
            });
            break;
          case "endspan":
          case "endmark":
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
          // Later groups must fit their new column, even when an outer command is flat.
          remeasure = true;
          newline(cmd.indent);
        }
        break;
      case "group": {
        if (cmd.mode === "flat" && !remeasure) {
          const mode: Mode = d.brk || hasHard(d.d) ? "break" : "flat";
          if (mode === "break" && d.id !== undefined) broke.add(d.id);
          stack.push({ indent: cmd.indent, mode, doc: d.d });
          break;
        }
        remeasure = false;
        const flat: Cmd = { indent: cmd.indent, mode: "flat", doc: d.d };
        const forced = d.brk || hasHard(d.d);
        if (!forced && fits(flat, stack, width - column)) {
          stack.push(flat);
        } else {
          if (d.id !== undefined) broke.add(d.id);
          stack.push({ indent: cmd.indent, mode: "break", doc: d.d });
        }
        break;
      }
      case "ifbroke":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: broke.has(d.id) ? d.broken : d.flat,
        });
        break;
      case "indent":
        stack.push({
          indent: cmd.indent + INDENT_WIDTH,
          mode: cmd.mode,
          doc: d.d,
        });
        break;
      case "fill": {
        if (cmd.mode === "flat" && !remeasure) {
          stack.push({ indent: cmd.indent, mode: "flat", doc: d.parts });
          break;
        }
        remeasure = false;
        if (d.parts.length === 0) break;
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: { k: "fillstep", fill: d, i: 1 },
        });
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: group(d.parts[0]),
        });
        break;
      }
      case "fillstep": {
        const parts = d.fill.parts;
        if (d.i >= parts.length) break;
        const separator = parts[d.i];
        const content = parts[d.i + 1];
        const lastContent = d.i + 1 === parts.length - 1;
        const deeper = cmd.indent + INDENT_WIDTH * d.fill.tail;
        const flatPair: Cmd = {
          indent: deeper,
          mode: "flat",
          doc: [separator, content],
        };
        const onLine = fits(flatPair, lastContent ? stack : [], width - column);
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: { k: "fillstep", fill: d.fill, i: d.i + 2 },
        });
        stack.push({ indent: deeper, mode: "break", doc: group(content) });
        stack.push({
          indent: deeper,
          mode: onLine ? "flat" : "break",
          doc: separator,
        });
        break;
      }
      case "spanopen":
        openSpans.set(d.id, offset);
        break;
      case "spanclose":
        spans.push({
          start: openSpans.get(d.id) ?? offset,
          end: offset,
          span: d.span,
        });
        break;
      case "ifbreak":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: cmd.mode === "break" ? d.broken : d.flat,
        });
        break;
      case "iffits":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: fits(
              { indent: cmd.indent, mode: "flat", doc: d.probe },
              [],
              width - column,
            )
            ? d.whenFits
            : d.otherwise,
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
      case "mark":
        stack.push({
          indent: cmd.indent,
          mode: cmd.mode,
          doc: { k: "endmark", key: d.key, start: offset },
        });
        stack.push({ indent: cmd.indent, mode: cmd.mode, doc: d.d });
        break;
      case "endmark":
        marks.push({ key: d.key, start: d.start, end: offset });
        break;
    }
  }
  return { text: out.join(""), spans, marks };
}

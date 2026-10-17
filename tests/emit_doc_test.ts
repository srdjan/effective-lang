// Tests for the layout engine of the emitter (part A6a).

import { assertEquals } from "@std/assert";
import {
  alt,
  braces,
  bracketed,
  type Doc,
  fill,
  group,
  hard,
  hasHardLine,
  ifBreak,
  ifBroke,
  ifFits,
  indent,
  join,
  line,
  marked,
  render,
  soft,
  spanEnds,
  spanned,
  through,
} from "../src/core/emit/doc.ts";

const span = (start: number, end: number) => ({ source: "m.eff", start, end });

Deno.test("a group stays on one line when it fits", () => {
  const doc = bracketed("[", "]", ["a", "b", "c"], false);
  assertEquals(render(doc, 80).text, "[a, b, c]");
});

Deno.test("a group that does not fit breaks every line and adds a trailing comma", () => {
  const doc = bracketed("{", "}", ["alpha: 1", "beta: 2"], true);
  assertEquals(render(doc, 10).text, "{\n  alpha: 1,\n  beta: 2,\n}");
  assertEquals(render(doc, 80).text, "{ alpha: 1, beta: 2 }");
});

Deno.test("a hard line breaks the enclosing group but not a sibling", () => {
  const doc: Doc = [group(["a", hard, "b"]), " ", group(["c", line, "d"])];
  assertEquals(render(doc, 80).text, "a\nb c d");
});

Deno.test("braces print one statement for each line and an empty list as {}", () => {
  assertEquals(render(braces(["x;", "y;"])).text, "{\n  x;\n  y;\n}");
  assertEquals(render(braces([])).text, "{}");
});

Deno.test("ifBreak follows the mode of the enclosing group", () => {
  const doc = group(["(", indent([soft, "a"]), ifBreak(";"), soft, ")"]);
  assertEquals(render(doc, 80).text, "(a)");
  assertEquals(render(doc, 2).text, "(\n  a;\n)");
});

Deno.test("alt keeps the first option that fits and falls back to the last", () => {
  const options = alt([
    "call(first, second)",
    ["call(first, {", indent([hard, "second"]), hard, "})"],
    ["call(", indent([hard, "first,", hard, "second,"]), hard, ")"],
  ]);
  assertEquals(render(options, 80).text, "call(first, second)");
  assertEquals(render(options, 10).text, "call(\n  first,\n  second,\n)");
  assertEquals(
    render(options, 15).text,
    "call(first, {\n  second\n})",
  );
});

Deno.test("span tags record the generated range of their content", () => {
  const doc: Doc = [
    "let ",
    spanned(span(4, 9), ["x", " = ", spanned(span(8, 9), "1")]),
    ";",
  ];
  const result = render(doc);
  assertEquals(result.text, "let x = 1;");
  assertEquals(
    result.spans.map((r) => [r.start, r.end, r.span.start, r.span.end]),
    [[8, 9, 8, 9], [4, 9, 4, 9]],
  );
});

Deno.test("join puts the separator between items only", () => {
  assertEquals(render(join(", ", ["a", "b", "c"])).text, "a, b, c");
  assertEquals(render(join(", ", [])).text, "");
});

Deno.test("ifBroke asks whether an earlier group broke", () => {
  const id = {};
  const doc: Doc = [
    "(",
    group(indent([line, "body"]), false, id),
    ")",
    ifBroke(id, " broken", " flat"),
  ];
  assertEquals(render(doc, 80).text, "( body) flat");
  assertEquals(render(doc, 5).text, "(\n  body) broken");
});

Deno.test("ifBroke counts a group that a hard line forces to break", () => {
  const id = {};
  const doc: Doc = [group(["a", hard, "b"], false, id), ifBroke(id, "!", "?")];
  assertEquals(render(doc).text, "a\nb!");
});

Deno.test("mark tags record the generated range of their content", () => {
  const doc: Doc = ["a ", marked("k", ["b", hard, "c"]), " d"];
  const result = render(doc);
  assertEquals(result.text, "a b\nc d");
  assertEquals(result.marks, [{ key: "k", start: 2, end: 5 }]);
});

// ------------------------------------------------------------------ fill and through (A6c)

Deno.test("fill puts each part on the current line while it fits, and indents the breaks", () => {
  const parts: Doc[] = ["aaa +", line, "bbb +", line, "ccc +", line, "ddd"];
  assertEquals(render(fill(parts, 1), 80).text, "aaa + bbb + ccc + ddd");
  assertEquals(render(fill(parts, 1), 13).text, "aaa + bbb +\n  ccc + ddd");
  assertEquals(render(fill(parts, 0), 13).text, "aaa + bbb +\nccc + ddd");
  assertEquals(
    render(["x = ", indent(fill(parts, 1))], 9).text,
    "x = aaa +\n    bbb +\n    ccc +\n    ddd",
  );
});

Deno.test("fill counts the text after the last part", () => {
  const parts: Doc[] = ["aaa +", line, "bbb"];
  assertEquals(render([fill(parts, 1), ";"], 10).text, "aaa + bbb;");
  assertEquals(render([fill(parts, 1), ";"], 9).text, "aaa +\n  bbb;");
});

Deno.test("fill breaks a nested fill only when its part does not fit on a line", () => {
  const inner: Doc = fill(["bb >", line, "cc"], 1);
  const doc: Doc = fill(["aa &&", line, [inner, " &&"], line, "dd"], 1);
  assertEquals(render(doc, 80).text, "aa && bb > cc && dd");
  assertEquals(render(doc, 12).text, "aa &&\n  bb > cc &&\n  dd");
  assertEquals(render(doc, 6).text, "aa &&\n  bb >\n    cc &&\n  dd");
});

Deno.test("span ends record a range that crosses the parts of a fill", () => {
  const prefix = spanEnds(span(0, 5));
  const doc: Doc = spanned(
    span(0, 9),
    fill(
      [[prefix.open, "a", " +"], line, ["b", prefix.close, " +"], line, "c"],
      1,
    ),
  );
  const result = render(doc, 80);
  assertEquals(result.text, "a + b + c");
  assertEquals(
    result.spans.map((r) => [r.start, r.end, r.span.start, r.span.end]),
    [[0, 5, 0, 5], [0, 9, 0, 9]],
  );
});

Deno.test("an alt option with a through line must fit on every line it measures", () => {
  const layout = (second: string): Doc =>
    alt([
      ["head ", second],
      ["head =", indent([through, second])],
      "fallback",
    ]);
  assertEquals(render(layout("body"), 10).text, "head body");
  assertEquals(render(layout("bodybody"), 10).text, "head =\n  bodybody");
  assertEquals(render(layout("bodybodybody"), 10).text, "fallback");
});

Deno.test("ifFits picks a branch by the width of a probe that it does not print", () => {
  const doc = ifFits("12345678", "yes", "no");
  assertEquals(render(doc, 8).text, "yes");
  assertEquals(render(doc, 7).text, "no");
  assertEquals(render(["ab", doc], 10).text, "abyes");
  assertEquals(render(["abc", doc], 10).text, "abcno");
});

Deno.test("ifFits measures the probe without the text that follows it", () => {
  const doc: Doc = [ifFits("1234", "yes", "no"), "tail"];
  assertEquals(render(doc, 4).text, "yestail");
});

Deno.test("ifFits restarts the measure at a through line, at the current indentation", () => {
  const probe: Doc = indent([through, "123456"]);
  const doc: Doc = indent([hard, "ab", ifFits(probe, "yes", "no")]);
  assertEquals(render(doc, 10).text, "\n  abyes");
  assertEquals(render(doc, 9).text, "\n  abno");
});

Deno.test("a group measures the chosen branch of an ifFits", () => {
  const doc = group([ifFits("xxxx", "a", "bbbbbbbbbb"), line, "c"]);
  assertEquals(render(doc, 5).text, "a c");
  assertEquals(render(doc, 3).text, "bbbbbbbbbb\nc");
});

Deno.test("the hard-line check looks at both branches of an ifFits and ignores the probe", () => {
  assertEquals(hasHardLine(ifFits(hard, "a", "b")), false);
  assertEquals(hasHardLine(ifFits("p", [hard], "b")), true);
  assertEquals(hasHardLine(ifFits("p", "a", [hard])), true);
  assertEquals(hasHardLine(group(["a", hard])), true);
  assertEquals(hasHardLine(alt([[hard], "b"])), false);
});

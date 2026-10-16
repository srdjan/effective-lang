// Tests for the layout engine of the emitter (part A6a).

import { assertEquals } from "@std/assert";
import {
  alt,
  braces,
  bracketed,
  type Doc,
  group,
  hard,
  ifBreak,
  ifBroke,
  indent,
  join,
  line,
  marked,
  render,
  soft,
  spanned,
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

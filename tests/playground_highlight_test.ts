// Tests for the playground highlighter: one case for each row of the table in
// plan 5.3, the position rule of the contextual words, and the order of ranges.

import { assert, assertEquals } from "@std/assert";
import {
  type HighlightKind,
  highlightTokens,
} from "../playground/src/highlight.ts";
import { exampleFiles } from "./helpers.ts";

/** The `text` slice and kind of each range, as pairs. */
function slices(text: string): [string, HighlightKind][] {
  return highlightTokens(text).map((
    r,
  ) => [text.slice(r.from, r.to), r.kind]);
}

Deno.test("the ten keyword tokens are keywords", () => {
  const text = "import export const match try catch if else true false";
  assertEquals(
    slices(text),
    text.split(" ").map((word) => [word, "keyword"]),
  );
});

Deno.test("type, error, service, and provider are keywords at the start of a line", () => {
  assertEquals(slices("type A = { x: int }\n")[0], ["type", "keyword"]);
  assertEquals(slices("error E = { id: string }\n")[0], ["error", "keyword"]);
  assertEquals(slices("service S {\n}\n")[0], ["service", "keyword"]);
  assertEquals(slices("provider P provides S\n")[0], ["provider", "keyword"]);
  assertEquals(slices("a\n  type"), [["type", "keyword"]]);
  assertEquals(slices("a type"), []);
});

Deno.test("nominal is a keyword at the start of a declaration and a name elsewhere", () => {
  assertEquals(slices("nominal U = { id: int }\n")[0], ["nominal", "keyword"]);
  assertEquals(slices("export nominal U = {}\n").slice(0, 2), [
    ["export", "keyword"],
    ["nominal", "keyword"],
  ]);
  assertEquals(slices("a nominal"), []);
  assertEquals(slices("const nominal = 1\n").map(([word]) => word), [
    "const",
    "=",
    "1",
  ]);
});

Deno.test("type, error, service, and provider are keywords after export", () => {
  assertEquals(slices("export type A = int\n").slice(0, 2), [
    ["export", "keyword"],
    ["type", "keyword"],
  ]);
  assertEquals(slices("export error E = { id: string }\n")[1], [
    "error",
    "keyword",
  ]);
  assertEquals(slices("export service S {\n}\n")[1], ["service", "keyword"]);
  assertEquals(slices("export provider P provides S\n")[1], [
    "provider",
    "keyword",
  ]);
});

Deno.test("error is a name in a pattern, and type elsewhere is a name", () => {
  const text = "UserMissing(error) => 1";
  assertEquals(slices(text), [
    ["UserMissing", "type"],
    ["=>", "operator"],
    ["1", "number"],
  ]);
  assertEquals(slices("const type = 1\n").map(([w]) => w), [
    "const",
    "=",
    "1",
  ]);
});

Deno.test("fails, uses, provides, and from are keywords anywhere", () => {
  assertEquals(
    slices("f(fails uses provides from)"),
    [
      ["fails", "keyword"],
      ["uses", "keyword"],
      ["provides", "keyword"],
      ["from", "keyword"],
    ],
  );
});

Deno.test("a prelude name is a builtin", () => {
  assertEquals(slices("fail retry provide map filter fold"), [
    ["fail", "builtin"],
    ["retry", "builtin"],
    ["provide", "builtin"],
    ["map", "builtin"],
    ["filter", "builtin"],
    ["fold", "builtin"],
  ]);
  assertEquals(slices("Some None"), [["Some", "builtin"], ["None", "builtin"]]);
});

Deno.test("a builtin type name or a capitalized name is a type", () => {
  assertEquals(slices("string int Option Ref User"), [
    ["string", "type"],
    ["int", "type"],
    ["Option", "type"],
    ["Ref", "type"],
    ["User", "type"],
  ]);
  assertEquals(slices("user"), []);
});

Deno.test("a string with an escape is one string range", () => {
  const text = 'x = "a\\"b" + 1';
  assertEquals(slices(text), [
    ["=", "operator"],
    ['"a\\"b"', "string"],
    ["+", "operator"],
    ["1", "number"],
  ]);
});

Deno.test("a number is a number", () => {
  assertEquals(slices("12 3.5"), [["12", "number"], ["3.5", "number"]]);
});

Deno.test("line and block comments are comments", () => {
  const text = "a // line\nb /* block\nspan */ c";
  assertEquals(slices(text), [
    ["// line", "comment"],
    ["/* block\nspan */", "comment"],
  ]);
});

Deno.test("operators include the pipe and the arrow", () => {
  assertEquals(slices("a |> b => c"), [
    ["|>", "operator"],
    ["=>", "operator"],
  ]);
  assertEquals(slices("a === b !== c <= d && e || f | g - h * i / j !k"), [
    ["===", "operator"],
    ["!==", "operator"],
    ["<=", "operator"],
    ["&&", "operator"],
    ["||", "operator"],
    ["|", "operator"],
    ["-", "operator"],
    ["*", "operator"],
    ["/", "operator"],
    ["!", "operator"],
  ]);
});

Deno.test("names, punctuation, newlines, whitespace, and unknown characters give no range", () => {
  assertEquals(slices("a.b(c, d): e;\n  \t\n"), []);
  assertEquals(slices("# \u0001 @"), []);
  assertEquals(highlightTokens(""), []);
});

Deno.test("ranges are sorted and do not overlap in every example file", () => {
  const files = exampleFiles();
  for (const [path, text] of Object.entries(files)) {
    const ranges = highlightTokens(text);
    assert(ranges.length > 0 || path === "effective.json", path);
    let end = 0;
    for (const r of ranges) {
      assert(r.from >= end, `${path}: overlap at ${r.from}`);
      assert(r.to > r.from, `${path}: empty range at ${r.from}`);
      end = r.to;
    }
  }
});

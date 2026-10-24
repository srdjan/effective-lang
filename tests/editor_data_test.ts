// Editor queries over a data type: tokens, symbols, definition, hover,
// completion, and rename, for its declaration, its constructor calls, and its
// constructor patterns.

import { assert, assertEquals } from "@std/assert";
import { Program, type Revision } from "../src/core/db.ts";
import { definitionAt, documentSymbols, hoverAt } from "../src/core/editor.ts";
import { completionsAt } from "../src/core/editor_completion.ts";
import { applySourceEdits, renameAt } from "../src/core/editor_rename.ts";
import { semanticClassifications } from "../src/core/editor_tokens.ts";

const TEXT = `type Text = string
export nominal Circle = { radius: Text }
export nominal Square = { side: Text }
export error Broken = { reason: Text }
export type Shape = Circle | Square
export const make = (): Shape => Circle({ radius: "r" })
export const area = (shape: Shape): Text =>
  match shape {
    Circle(c) => c.radius,
    Square(s) => s.side
  }
export const read = (c: Circle): Text => c.rad
export const guarded = (): Text fails Broken => fail(Broken({ reason: "x" }))
`;

function load(text: string): Revision {
  const result = new Program("").update({
    set: { "effektive.json": "{}", "m.eff": text },
  });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

const revision = load(TEXT);

/** The offset of the `nth` occurrence of `needle`, counting from zero, plus `delta`. */
function offsetOf(needle: string, nth = 0, delta = 0): number {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = TEXT.indexOf(needle, at + 1);
    assert(at >= 0, `missing ${needle} number ${nth}`);
  }
  return at + delta;
}

const DECLARATION = offsetOf("Circle = {");
const CALL = offsetOf("Circle({");
const PATTERN = offsetOf("Circle(c)");
const ANNOTATION = offsetOf("c: Circle");

Deno.test("semantic tokens give a data type the class kind and the word data the keyword kind", () => {
  const tokens = semanticClassifications(revision, "m.eff", TEXT);
  const at = (start: number) => tokens.find((t) => t.span.start === start);
  assertEquals(at(offsetOf("nominal Circle"))?.type, "keyword");
  assertEquals(at(DECLARATION)?.type, "class");
  assertEquals(at(DECLARATION)?.modifiers, ["declaration", "readonly"]);
  assertEquals(at(CALL)?.type, "class");
  assertEquals(at(PATTERN)?.type, "class");
  assertEquals(at(ANNOTATION + 3)?.type, "class");
  // An alias of data types stays a type, and an error stays a class.
  assertEquals(at(offsetOf("Shape ="))?.type, "type");
  assertEquals(at(offsetOf("Broken ="))?.type, "class");
});

Deno.test("semantic tokens mark a data declaration in broken text through the lexical fallback", () => {
  const text = "export nominal Fresh = { n: int }\nconst z = (\n";
  const tokens = semanticClassifications(revision, "m.eff", text);
  const at = (word: string) =>
    tokens.find((t) => t.span.start === text.indexOf(word));
  assertEquals(at("nominal")?.type, "keyword");
  assertEquals(at("Fresh")?.type, "class");
  assertEquals(at("Fresh")?.modifiers, ["declaration", "readonly"]);
});

Deno.test("document symbols give a data declaration the data kind", () => {
  const symbols = documentSymbols(revision, "m.eff", TEXT);
  assertEquals(
    symbols.slice(0, 5).map((s) => [s.name, s.kind]),
    [
      ["Text", "type"],
      ["Circle", "data"],
      ["Square", "data"],
      ["Broken", "error"],
      ["Shape", "type"],
    ],
  );
  const circle = symbols.find((s) => s.name === "Circle");
  assertEquals(circle?.nameSpan.start, DECLARATION);
});

Deno.test("definition leads from a constructor call, a pattern, and an annotation to the data declaration", () => {
  for (const offset of [CALL + 2, PATTERN + 2, ANNOTATION + 5]) {
    assertEquals(definitionAt(revision, "m.eff", offset)?.start, DECLARATION);
  }
});

Deno.test("hover on a constructor call shows the data type", () => {
  const hover = hoverAt(revision, "m.eff", CALL + 2);
  assertEquals(hover?.contract, "Circle");
});

function labels(offset: number): string[] {
  return completionsAt(revision, "m.eff", offset).map((c) => c.label);
}

Deno.test("completion offers a data type in a type position and a value position, but not after fails", () => {
  const typeAt = offsetOf("shape: Shape", 0, "shape: S".length);
  assert(labels(typeAt).includes("Square"));
  const text = TEXT.replace("fails Broken", "fails B");
  const failing = load(text);
  const failsAt = text.indexOf("fails B") + "fails B".length;
  const failure = completionsAt(failing, "m.eff", failsAt).map((c) => c.label);
  assert(failure.includes("Broken"));
  assert(!failure.includes("Circle"));
  const valueAt = offsetOf("Circle({");
  const value = completionsAt(revision, "m.eff", valueAt);
  assertEquals(value.find((c) => c.label === "Circle")?.kind, "class");
  assertEquals(value.find((c) => c.label === "Shape")?.kind, "type");
});

Deno.test("completion in a constructor pattern offers data types and errors", () => {
  for (const [prefix, expected] of [["S", "Square"], ["B", "Broken"]]) {
    const text = TEXT.replace("Square(s) =>", `${prefix}(s) =>`);
    const found = completionsAt(
      load(text),
      "m.eff",
      text.indexOf(`${prefix}(s)`) + 1,
    ).map((c) => c.label);
    assert(found.includes(expected), `${prefix} lacks ${expected}`);
  }
});

Deno.test("completion reads the fields of a data type", () => {
  assertEquals(labels(offsetOf("c.rad", 0, "c.rad".length)), ["radius"]);
});

Deno.test("rename follows a data type through its declaration, calls, patterns, and annotations", () => {
  const result = renameAt(revision, "m.eff", DECLARATION, "Disc");
  assert(result.ok, JSON.stringify(result));
  const renamed = applySourceEdits(TEXT, result.value);
  assertEquals(renamed.split("Disc").length - 1, 5);
  assert(!renamed.includes("Circle"));
  assert(renamed.includes("Disc({ radius"));
  assert(renamed.includes("Disc(c) =>"));
  assert(renamed.includes("c: Disc"));
  assert(renamed.includes("Shape = Disc | Square"));
});

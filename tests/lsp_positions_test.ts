import { assertEquals } from "@std/assert";
import { lineStarts } from "../src/core/source.ts";
import {
  applyContentChanges,
  offsetToPosition,
  pathToUri,
  positionToOffset,
  spanToRange,
  uriToPath,
} from "../src/lsp/positions.ts";

function toOffset(text: string, line: number, character: number): number {
  return positionToOffset(text, lineStarts(text), { line, character });
}

function toPosition(text: string, offset: number) {
  return offsetToPosition(text, lineStarts(text), offset);
}

Deno.test("positions: LF text", () => {
  const text = "ab\ncd\n";
  assertEquals(toOffset(text, 0, 0), 0);
  assertEquals(toOffset(text, 1, 1), 4);
  assertEquals(toOffset(text, 2, 0), 6);
  assertEquals(toPosition(text, 4), { line: 1, character: 1 });
  assertEquals(toPosition(text, 6), { line: 2, character: 0 });
});

Deno.test("positions: CRLF and lone CR are one terminator each", () => {
  const crlf = "ab\r\ncd";
  assertEquals(toOffset(crlf, 1, 0), 4);
  assertEquals(toOffset(crlf, 0, 99), 2, "clamps before the CRLF");
  assertEquals(toPosition(crlf, 4), { line: 1, character: 0 });
  assertEquals(toPosition(crlf, 3), { line: 0, character: 2 }, "inside CRLF");

  const cr = "ab\rcd\rx";
  assertEquals(toOffset(cr, 1, 1), 4);
  assertEquals(toOffset(cr, 0, 99), 2, "clamps before the lone CR");
  assertEquals(toOffset(cr, 1, 99), 5);
  assertEquals(toPosition(cr, 6), { line: 2, character: 0 });

  const mixed = "a\r\n\r\n\nb";
  assertEquals(toOffset(mixed, 1, 5), 3, "empty CRLF line");
  assertEquals(toOffset(mixed, 2, 5), 5, "empty LF line");
  assertEquals(toOffset(mixed, 3, 1), 7);
});

Deno.test("positions: surrogate pairs count as two units", () => {
  const text = "a😀b\n😀😀";
  assertEquals(toOffset(text, 0, 3), 3);
  assertEquals(toOffset(text, 0, 4), 4);
  assertEquals(toPosition(text, 4), { line: 0, character: 4 });
  assertEquals(toOffset(text, 1, 4), 9);
  assertEquals(toPosition(text, text.length), { line: 1, character: 4 });
});

Deno.test("positions: clamping in both directions", () => {
  const text = "ab\ncd";
  assertEquals(toOffset(text, 0, 50), 2, "character past line end");
  assertEquals(toOffset(text, 1, 50), 5, "character past text end");
  assertEquals(toOffset(text, 9, 0), 5, "line past the end");
  assertEquals(toOffset(text, 9, 9), 5);
  assertEquals(toPosition(text, 99), { line: 1, character: 2 });
  assertEquals(toPosition(text, -4), { line: 0, character: 0 });
  assertEquals(toOffset("", 0, 0), 0);
  assertEquals(toOffset("", 3, 3), 0);
});

Deno.test("positions: offset to position to offset round trips", () => {
  for (const text of ["", "x", "a\nb\r\nc\rd", "😀\r\né\n", "a\n\n\nb\r"]) {
    const starts = lineStarts(text);
    for (let offset = 0; offset <= text.length; offset++) {
      const position = offsetToPosition(text, starts, offset);
      const back = positionToOffset(text, starts, position);
      // An offset inside a CRLF has no position of its own and maps to the line end.
      const insideCrlf = text.charCodeAt(offset - 1) === 0x0d &&
        text.charCodeAt(offset) === 0x0a;
      assertEquals(
        back,
        insideCrlf ? offset - 1 : offset,
        `${JSON.stringify(text)}@${offset}`,
      );
    }
  }
});

Deno.test("spanToRange converts both ends", () => {
  const text = "ab\r\ncd😀ef";
  assertEquals(
    spanToRange(text, lineStarts(text), { source: "s", start: 1, end: 8 }),
    {
      start: { line: 0, character: 1 },
      end: { line: 1, character: 4 },
    },
  );
});

Deno.test("changes: insertion", () => {
  assertEquals(
    applyContentChanges("ab\ncd", [{
      range: {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 1 },
      },
      text: "XY",
    }]),
    "ab\ncXYd",
  );
});

Deno.test("changes: deletion", () => {
  assertEquals(
    applyContentChanges("ab\ncd\nef", [{
      range: {
        start: { line: 0, character: 1 },
        end: { line: 1, character: 1 },
      },
      text: "",
    }]),
    "ad\nef",
  );
});

Deno.test("changes: multi-line replacement with CRLF", () => {
  assertEquals(
    applyContentChanges("a\r\nb\r\nc\r\nd", [{
      range: {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 1 },
      },
      text: "one\ntwo",
    }]),
    "a\r\none\ntwo\r\nd",
  );
});

Deno.test("changes: a full-text change, then ranged changes in order", () => {
  assertEquals(
    applyContentChanges("old", [
      { text: "abc\ndef" },
      {
        range: {
          start: { line: 0, character: 3 },
          end: { line: 0, character: 3 },
        },
        text: "!",
      },
      {
        // Uses the text after the previous change.
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
        text: "",
      },
    ]),
    "\ndef",
  );
  assertEquals(applyContentChanges("keep", []), "keep");
});

Deno.test("changes: an emoji edit uses UTF-16 units", () => {
  assertEquals(
    applyContentChanges("a😀b", [{
      range: {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 3 },
      },
      text: "-",
    }]),
    "a-b",
  );
});

Deno.test("changes: a range past the end clamps and a reversed range is empty", () => {
  assertEquals(
    applyContentChanges("ab", [{
      range: {
        start: { line: 0, character: 1 },
        end: { line: 5, character: 5 },
      },
      text: "Z",
    }]),
    "aZ",
  );
  assertEquals(
    applyContentChanges("abc", [{
      range: {
        start: { line: 0, character: 2 },
        end: { line: 0, character: 1 },
      },
      text: "Z",
    }]),
    "abZc",
  );
});

Deno.test("uri: round trip with a space and a non-ASCII character", () => {
  const path = "/tmp/my project/héllo/main.eff";
  const uri = pathToUri(path);
  assertEquals(uri, "file:///tmp/my%20project/h%C3%A9llo/main.eff");
  assertEquals(uriToPath(uri!), path);
});

Deno.test("uri: a non-file or malformed URI gives undefined", () => {
  assertEquals(uriToPath("untitled:Untitled-1"), undefined);
  assertEquals(uriToPath("effective-generated:///a/b.ts"), undefined);
  assertEquals(uriToPath("https://example.com/a"), undefined);
  assertEquals(uriToPath("not a uri"), undefined);
  assertEquals(uriToPath(""), undefined);
  assertEquals(pathToUri("relative/path.eff"), undefined);
});

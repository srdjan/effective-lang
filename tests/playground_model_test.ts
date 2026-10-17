// Tests for the playground page model: the tab from the hash, the Problems
// list, the error counts, the output states, and the hover texts.

import { assertEquals } from "@std/assert";
import {
  BACKEND_UNAVAILABLE,
  type PlaygroundDiagnostic,
  type PlaygroundResult,
} from "../playground/src/compile.ts";
import {
  DEFAULT_TAB,
  hoverLines,
  outputState,
  problemItems,
  tabCounts,
  tabFromHash,
  WRAP_HANG,
  wrapIndent,
} from "../playground/src/model.ts";

const PATHS = ["main.eff", "users.eff", "host/providers.effi"];

function diagnostic(
  from: number,
  to: number,
  code: string,
  severity: "error" | "warning" = "error",
): PlaygroundDiagnostic {
  return { from, to, severity, code, message: `message ${code}` };
}

const RESULT: PlaygroundResult = {
  diagnostics: {
    "users.eff": [
      diagnostic(9, 12, "b/002"),
      diagnostic(4, 5, "b/001"),
      diagnostic(4, 9, "b/003", "warning"),
    ],
    "main.eff": [diagnostic(0, 1, "a/001")],
    "host/providers.effi": [],
  },
  outputs: {
    "main.eff": { text: "fresh", stale: false },
    "users.eff": { text: "old", stale: true },
    "pay.eff": null,
  },
  elapsedMs: 1,
};

Deno.test("tabFromHash reads a plain, a nested, and an encoded hash", () => {
  assertEquals(tabFromHash("#users.eff", PATHS), "users.eff");
  assertEquals(
    tabFromHash("#host/providers.effi", PATHS),
    "host/providers.effi",
  );
  assertEquals(
    tabFromHash("#host%2Fproviders.effi", PATHS),
    "host/providers.effi",
  );
});

Deno.test("tabFromHash falls back to main.eff", () => {
  assertEquals(DEFAULT_TAB, "main.eff");
  assertEquals(tabFromHash("#nowhere.eff", PATHS), "main.eff");
  assertEquals(tabFromHash("", PATHS), "main.eff");
  assertEquals(tabFromHash("#", PATHS), "main.eff");
  assertEquals(tabFromHash("#%E0%A4%A", PATHS), "main.eff");
});

Deno.test("problemItems sorts by path and position with one-based line and column", () => {
  const texts = {
    "main.eff": "x\n",
    "users.eff": "ab\ncd\nef\n",
  };
  const items = problemItems(RESULT, texts);
  assertEquals(
    items.map((i) => [i.path, i.from, i.to, i.line, i.column, i.code]),
    [
      ["main.eff", 0, 1, 1, 1, "a/001"],
      ["users.eff", 4, 5, 2, 2, "b/001"],
      ["users.eff", 4, 9, 2, 2, "b/003"],
      ["users.eff", 9, 12, 4, 1, "b/002"],
    ],
  );
  assertEquals(items[0].message, "message a/001");
  assertEquals(items[2].severity, "warning");
});

Deno.test("problemItems gives line 1 column 1 to a path without text", () => {
  const items = problemItems(RESULT, {});
  assertEquals(
    items.map((i) => [i.line, i.column]).every(([l, c]) => l === 1 && c === 1),
    true,
  );
});

Deno.test("tabCounts counts errors for each path, warnings excluded", () => {
  assertEquals(tabCounts(RESULT), {
    "users.eff": 2,
    "main.eff": 1,
    "host/providers.effi": 0,
  });
});

Deno.test("outputState covers text, stale, none, and interface", () => {
  assertEquals(outputState(RESULT, "main.eff"), { tag: "text", text: "fresh" });
  assertEquals(outputState(RESULT, "users.eff"), { tag: "stale", text: "old" });
  assertEquals(outputState(RESULT, "pay.eff"), { tag: "none" });
  assertEquals(outputState(RESULT, "unknown.eff"), { tag: "none" });
  assertEquals(outputState(RESULT, "host/providers.effi"), {
    tag: "interface",
  });
});

Deno.test("hoverLines gives labelled blocks and a one-line cursor text", () => {
  assertEquals(hoverLines(undefined), { tooltip: [], cursor: "" });
  assertEquals(
    hoverLines({ from: 0, to: 1, contract: "limit: int", backend: undefined }),
    {
      tooltip: [{ label: "Contract", text: "limit: int", code: true }],
      cursor: "limit: int",
    },
  );
  const withBackend = hoverLines({
    from: 0,
    to: 1,
    contract: "f(\n  a: int\n): int",
    backend: "(a: number): number",
  });
  assertEquals(withBackend.cursor, "f( a: int ): int");
  assertEquals(withBackend.tooltip[1], {
    label: "Backend type",
    text: "(a: number): number",
    code: true,
  });
  const unavailable = hoverLines({
    from: 0,
    to: 1,
    contract: "f(): int",
    backend: BACKEND_UNAVAILABLE,
  });
  assertEquals(unavailable.tooltip[1], {
    label: "Backend type",
    text: BACKEND_UNAVAILABLE,
    code: false,
  });
});

Deno.test("wrapIndent hangs a wrapped part past the indent of its line", () => {
  assertEquals(wrapIndent("", 4), WRAP_HANG);
  assertEquals(wrapIndent("export const main", 4), WRAP_HANG);
  assertEquals(wrapIndent("  provide(UsersLive)", 4), 2 + WRAP_HANG);
  assertEquals(wrapIndent("\tx", 4), 4 + WRAP_HANG);
  assertEquals(wrapIndent(" \tx", 4), 4 + WRAP_HANG);
  assertEquals(wrapIndent("    ", 4), 4 + WRAP_HANG);
});

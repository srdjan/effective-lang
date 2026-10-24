// The order of the printed diagnostics. `formatDiagnostics` in src/cli/format.ts
// sorts by path, then line, then column, then code, then message. The test
// "check sorts diagnostics by path, position, and code" in cli_test.ts has one
// diagnostic in each file, so it reaches only the path comparison. These tests
// reach each later tie-break, through the CLI with two diagnostics in one file
// and through `formatDiagnostics` with diagnostics in a shuffled order. The
// checker already sorts and dedupes its own list, so only the second form can
// reach a tie-break that the checker output would hide.

import { assertEquals } from "@std/assert";
import { formatDiagnostics } from "../src/cli/format.ts";
import { main } from "../src/cli/main.ts";
import { type Diagnostic, makeDiagnostic } from "../src/core/diagnostics.ts";
import { memoryIo } from "./cli_helpers.ts";

const ROOT = "/proj";

/** Runs `check` on one file and returns its output lines. */
async function checkLines(text: string): Promise<string[]> {
  const m = memoryIo({
    [`${ROOT}/effektive.json`]: "{}",
    [`${ROOT}/m.eff`]: text,
  });
  assertEquals(await main(["check", ROOT], m.io), 1);
  return m.out.join("").trimEnd().split("\n");
}

Deno.test("check prints two diagnostics of one file in line order", async () => {
  const lines = await checkLines(
    'type Int = int\nconst a: Int = "x"\ntype T = { x: Int, x: Int }\n',
  );
  assertEquals(lines, [
    "m.eff:2:16: error type-mismatch/003: the constant has type string, but Int is expected",
    "m.eff:3:20: error declaration/010: the record type already has a field named `x`",
  ]);
});

Deno.test("check prints two diagnostics of one line in column order", async () => {
  const lines = await checkLines(
    'type Int = int\nconst a = [1 + "x", 2 + "y"]\n',
  );
  assertEquals(lines, [
    "m.eff:2:12: error type-mismatch/007: the operator `+` does not accept operands of type int and string",
    "m.eff:2:21: error type-mismatch/007: the operator `+` does not accept operands of type int and string",
  ]);
});

// ------------------------------------------------------- the tie-breaks alone

const TEXT = "aaaa\nbbbb\ncccc\n";

/** A diagnostic of `m.eff` at a line and column of TEXT (both one-based). */
function at(
  code: Parameters<typeof makeDiagnostic>[0],
  message: string,
  line: number,
  column: number,
): Diagnostic {
  const offset = (line - 1) * 5 + (column - 1);
  return makeDiagnostic(code, message, {
    source: "m.eff",
    start: offset,
    end: offset + 1,
  });
}

function print(diagnostics: readonly Diagnostic[]): string[] {
  return formatDiagnostics(diagnostics, () => TEXT);
}

Deno.test("the same file sorts by line before column and code", () => {
  // The later line has the earlier column and the earlier code. Line wins.
  assertEquals(
    print([
      at("type-mismatch/003", "late", 3, 1),
      at("type-mismatch/004", "early", 1, 4),
    ]),
    [
      "m.eff:1:4: error type-mismatch/004: early",
      "m.eff:3:1: error type-mismatch/003: late",
    ],
  );
});

Deno.test("the same line sorts by column before code", () => {
  // The later column has the earlier code. Column wins.
  assertEquals(
    print([
      at("type-mismatch/003", "right", 2, 3),
      at("type-mismatch/004", "left", 2, 1),
    ]),
    [
      "m.eff:2:1: error type-mismatch/004: left",
      "m.eff:2:3: error type-mismatch/003: right",
    ],
  );
});

Deno.test("the same position sorts by code before message, in both input orders", () => {
  // The later code has the earlier message. Code wins.
  const early = at("type-mismatch/003", "b second message", 2, 2);
  const late = at("type-mismatch/004", "a first message", 2, 2);
  const expected = [
    "m.eff:2:2: error type-mismatch/003: b second message",
    "m.eff:2:2: error type-mismatch/004: a first message",
  ];
  assertEquals(print([late, early]), expected);
  assertEquals(print([early, late]), expected);
});

Deno.test("the same position and code sort by message in every input order", () => {
  const messages = ["a first", "b second", "c third"];
  const expected = messages.map((m) =>
    `m.eff:2:2: error type-mismatch/003: ${m}`
  );
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of permutations) {
    const input = order.map((i) => at("type-mismatch/003", messages[i], 2, 2));
    assertEquals(print(input), expected, order.join(","));
  }
});

Deno.test("two equal diagnostics both print", () => {
  const one = at("type-mismatch/003", "same", 1, 1);
  assertEquals(print([one, one]).length, 2);
});

Deno.test("a different path sorts before the position, in both input orders", () => {
  const second = makeDiagnostic("type-mismatch/003", "x", {
    source: "b.eff",
    start: 0,
    end: 1,
  });
  const first = makeDiagnostic("type-mismatch/003", "x", {
    source: "a.eff",
    start: 10,
    end: 11,
  });
  const expected = [
    "a.eff:3:1: error type-mismatch/003: x",
    "b.eff:1:1: error type-mismatch/003: x",
  ];
  assertEquals(formatDiagnostics([second, first], () => TEXT), expected);
  assertEquals(formatDiagnostics([first, second], () => TEXT), expected);
});

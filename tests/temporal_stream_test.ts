import { assert, assertEquals } from "@std/assert";
import { checkProject, memoryHost } from "../src/core/mod.ts";

const prefix = `type Int = int
service Source { next(n: Int): Option<[Int, Int]> }
const source = unfold(0, (n) => Source.next(n))
`;

const DEBOUNCE_RULE =
  "`debounceStream` needs a nonnegative safe integer millisecond literal";
const THROTTLE_RULE =
  '`throttleStream` needs { units: U, durationMs: M, strategy: "shape" | "enforce" } with positive safe integer literals';

function diagnosticsOf(declaration: string) {
  const source = prefix + declaration;
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    text: source.slice(d.span.start, d.span.end),
  }));
}

Deno.test("temporal stream controls accept literal windows", () => {
  assertEquals(
    diagnosticsOf(`const debounced = debounceStream(source, 0)
const shaped = throttleStream(source, { units: 1, durationMs: 1000, strategy: "shape" })
const enforced = throttleStream(source, { units: 2, durationMs: 5, strategy: "enforce" })`),
    [],
  );
});

Deno.test("debounceStream rejects delays that are not nonnegative safe integer literals", () => {
  // The delay expression is the offending node. A parenthesized or named value is not a literal.
  for (
    const [declaration, offending] of [
      ["const s = debounceStream(source, 0 - 1)", "0 - 1"],
      ["const s = debounceStream(source, 1.5)", "1.5"],
      [
        "const s = debounceStream(source, 9007199254740993)",
        "9007199254740993",
      ],
      ["const delay = 5\nconst s = debounceStream(source, delay)", "delay"],
    ]
  ) {
    assertEquals(
      diagnosticsOf(declaration),
      [{ code: "type-mismatch/010", message: DEBOUNCE_RULE, text: offending }],
      declaration,
    );
  }
});

Deno.test("debounceStream reports a unary minus as syntax and a non-Stream first argument as a type error", () => {
  assertEquals(
    diagnosticsOf("const s = debounceStream(source, -1)").map((d) => d.code),
    ["syntax/010"],
  );
  assertEquals(diagnosticsOf("const s = debounceStream(3, 5)"), [{
    code: "type-mismatch/010",
    message: "`debounceStream` needs a Stream value",
    text: "3",
  }]);
});

Deno.test("throttleStream rejects settings that are not positive safe integer literals", () => {
  for (
    const options of [
      '{ units: 0, durationMs: 1000, strategy: "shape" }',
      '{ units: 1, durationMs: 0, strategy: "shape" }',
      '{ units: 1.5, durationMs: 1000, strategy: "shape" }',
      '{ units: 1, durationMs: 1000, strategy: "drop" }',
      "{ units: 1, durationMs: 1000 }",
      '{ units: 1, durationMs: 1000, strategy: "shape", extra: 1 }',
      '{ units: 1, units: 2, strategy: "shape" }',
      '{ units: u, durationMs: 1000, strategy: "shape" }',
    ]
  ) {
    assertEquals(
      diagnosticsOf(
        `const u = 1\nconst s = throttleStream(source, ${options})`,
      ),
      [{ code: "type-mismatch/010", message: THROTTLE_RULE, text: options }],
      options,
    );
  }
  assertEquals(
    diagnosticsOf(
      'const o = { units: 1, durationMs: 1000, strategy: "shape" }\nconst s = throttleStream(source, o)',
    ),
    [{ code: "type-mismatch/010", message: THROTTLE_RULE, text: "o" }],
  );
  assertEquals(
    diagnosticsOf(
      'const s = throttleStream(3, { units: 1, durationMs: 1000, strategy: "shape" })',
    ),
    [{
      code: "type-mismatch/010",
      message: "`throttleStream` needs a Stream value",
      text: "3",
    }],
  );
});

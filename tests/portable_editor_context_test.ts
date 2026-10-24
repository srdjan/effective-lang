import { assert, assertEquals } from "@std/assert";
import {
  completionsAt,
  Program,
  semanticClassifications,
} from "../src/core/mod.ts";

Deno.test("sealed keyword completion stays at module declarations", () => {
  const cases = [
    { text: "export sea\n", expected: true },
    {
      text: "type Int = int\nconst f = (): Int => {\n  sea\n}\n",
      expected: false,
    },
    { text: "type Int = int\nconst f = (): Int =>\n  sea\n", expected: false },
    { text: "service S {\n  sea\n}\n", expected: false },
  ];
  for (const { text, expected } of cases) {
    const result = new Program("").update({
      set: { "effektive.json": "{}", "main.eff": text },
    });
    assert(result.ok, JSON.stringify(result));
    const found = completionsAt(
      result.value,
      "main.eff",
      text.indexOf("sea") + 3,
    )
      .some((item) => item.label === "sealed" && item.kind === "keyword");
    assertEquals(found, expected, text);
  }
});

Deno.test("semantic tokens classify a multiline pure function type", () => {
  const text =
    "type Int = int\nexport const apply = (callback: pure\n(value: Int)\n=> Int): Int => callback(1)\n";
  const result = new Program("").update({
    set: { "effektive.json": "{}", "main.eff": text },
  });
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.value.diagnostics, []);
  assertEquals(
    semanticClassifications(result.value, "main.eff", text).find((item) =>
      item.span.start === text.indexOf("pure")
    )?.type,
    "keyword",
  );
});

import { assertEquals } from "@std/assert";
import {
  CHAIN_FORMS,
  type ChainForm,
  chainSource,
  diagnosticCodes,
  nestedChainSource,
  runAllPasses,
} from "./chain_helpers.ts";

// A chain link costs two nesting levels, so the parser accepts 250 links and
// reports 300. The diagnostics of the 250-link chains are the type errors that
// the chains have by construction: no call or field chain has a valid type, and
// the 250-link array type is deeper than the declaration limit of 128 levels.
const SHORT_CODES: Record<ChainForm, readonly string[]> = {
  binary: [],
  pipeline: [],
  call: ["type-mismatch/008"],
  field: ["type-mismatch/006"],
  array: ["declaration/012"],
};

for (const form of CHAIN_FORMS) {
  Deno.test(`a 300-link ${form} chain is reported as too deep and does not throw`, () => {
    const codes = diagnosticCodes(chainSource(form, 300));
    const nesting = form === "array" ? ["declaration/012"] : [];
    assertEquals(codes, [...nesting, "syntax/009", "syntax/008"]);
  });

  Deno.test(`a 250-link ${form} chain passes the parser and the later passes`, () => {
    assertEquals(
      diagnosticCodes(chainSource(form, 250)),
      SHORT_CODES[form],
    );
  });
}

Deno.test("valid chains go through check, lower, validate, emit, and the source map", () => {
  assertEquals(runAllPasses(chainSource("binary", 250)), []);
  assertEquals(runAllPasses(chainSource("pipeline", 250)), []);
  assertEquals(runAllPasses(chainSource("array", 120)), []);
});

Deno.test("120 nested parentheses around a 120-link binary chain go through every pass", () => {
  assertEquals(runAllPasses(nestedChainSource(120, 120)), []);
});

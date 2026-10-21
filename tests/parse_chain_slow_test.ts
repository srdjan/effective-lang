import { assertEquals } from "@std/assert";
import type { ChainForm } from "./chain_helpers.ts";

/**
 * Runs `chain_cold_probe.ts` in a fresh process, where the stack and the
 * optimizing compiler are cold. Returns the exit code and the diagnostic codes.
 */
async function coldRun(
  form: ChainForm,
  links: number,
): Promise<{ readonly code: number; readonly out: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-lock",
      "--allow-read",
      import.meta.resolve("./chain_cold_probe.ts"),
      form,
      String(links),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    out: decoder.decode(output.stdout).trim() + decoder.decode(output.stderr),
  };
}

Deno.test("short chains pass every pass in a cold process", async () => {
  const cases: readonly [ChainForm, number, string][] = [
    ["binary", 250, "[]"],
    ["pipeline", 250, "[]"],
    ["call", 250, '["type-mismatch/008"]'],
    ["field", 250, '["type-mismatch/006"]'],
    ["array", 120, "[]"],
  ];
  for (const [form, links, expected] of cases) {
    assertEquals(await coldRun(form, links), { code: 0, out: expected }, form);
  }
});

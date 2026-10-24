import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

Deno.test("record union construction and wildcard matches pass strict checking and execute", async () => {
  const source = `type Int = int
type Text = string
type A = "a"
type B = "b"
type Missing = { kind: A, value: Int } | { other: Int }
type Optional = { kind: A, value: Int } | { kind?: B, value: Int }
type Overlap = { kind: A, value: Int } | { kind: Text, value: Text }
type Choice = { kind: A, value: Int } | { kind: B, value: Text }
nominal Tag = string
type Branded = { kind: A, value: Int } | { kind: Tag, value: Text }
type UnknownTag = { kind: A, value: Int } | { kind: unknown, value: Text }
type LongTags = { longDiscriminatorField: "aVeryLongDiscriminatorLiteralStringToForceMultilineFormatting", value: Int } | { longDiscriminatorField: "anotherVeryLongDiscriminatorLiteralStringToForceMultilineFormatting", value: Int } | { other: Int }
type PA = string
type PZ = int
type Pair = { k: PA[], v: PA } | { k: PZ[], v: PZ }
export const pair = (x: PZ): Pair => ({ k: [], v: x })
export const missing = (x: Missing): Int => match x { { kind: "a", ...a } => a.value, _ => 0 }
export const optional = (x: Optional): Int => match x { { kind: "a", ...a } => a.value, { kind: "b", ...b } => b.value, _ => 0 }
export const overlap = (x: Overlap): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }
export const branded = (x: Branded): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }
export const unknownTag = (x: UnknownTag): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }
export const brandedResult: Int | Text = branded({ kind: Tag("a"), value: "brand" })
export const a: Choice = { kind: "a", value: 1 }
export const b: Choice = { kind: "b", value: "hello" }
export const one: Int = 1
export const make = (next: () => Text): Choice => ({ kind: "b", value: next() })
export const formatted = (x: LongTags): Int => match x { { longDiscriminatorField: "aVeryLongDiscriminatorLiteralStringToForceMultilineFormatting", ...a } => a.value, { longDiscriminatorField: "anotherVeryLongDiscriminatorLiteralStringToForceMultilineFormatting", ...b } => b.value, _ => 0 }
`;
  const project = checkProject(
    memoryHost({ "effektive.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) assert(result.ok);
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    )
      .values()
  ) assertEquals(diagnostics, []);
  const emitted = emitProject(lowered, {
    config: project.value.analysis.project.config,
  });
  const main = emitted.get("main");
  assert(main?.ok);
  const formatter = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--check", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = formatter.stdin.getWriter();
  await writer.write(new TextEncoder().encode(main.value.text));
  await writer.close();
  const formatted = await formatter.output();
  assertEquals(formatted.code, 0, new TextDecoder().decode(formatted.stderr));
  const stdout = await runStrictTarget(
    emitted,
    `import { Effect } from "effect";
import { missing, optional, overlap, brandedResult, unknownTag, a, b, one, make, pair } from "./main.ts";
let calls = 0;
const made = await Effect.runPromise(make(() => Effect.sync(() => { calls++; return "once"; })));
console.log(JSON.stringify({
  missing: [missing({ kind: "a", value: one }), missing({ other: one })],
  optional: [optional({ value: one }), optional({ kind: "b", value: one })],
  overlap: [overlap({ kind: "a", value: one }), overlap({ kind: "a", value: "open" }), overlap({ kind: "other", value: "open" })],
  brandedResult,
  unknownTag: [unknownTag({ kind: "a", value: "unknown" }), unknownTag({ kind: "other", value: "unknown" })],
  a, b, made, calls, pair: pair(one),
}));`,
    "effektive-record-union-",
  );
  assertEquals(JSON.parse(stdout), {
    missing: [1, 0],
    optional: [0, 1],
    overlap: [1, "open", 0],
    brandedResult: "brand",
    unknownTag: ["unknown", 0],
    a: { kind: "a", value: 1 },
    b: { kind: "b", value: "hello" },
    made: { kind: "b", value: "once" },
    calls: 1,
    pair: { k: [], v: 1 },
  });
});

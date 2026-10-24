// Tests for the open contracts of local functions: a clause that the source
// omits is inferred from the body. A written clause closes its own set.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
} from "../src/core/check_project.ts";
import type { ValueId } from "../src/core/ir.ts";
import { memoryHost } from "../src/core/source.ts";
import { emitFiles } from "./helpers.ts";

const PRELUDE = `
type Int = int
error Stop = { code: Int }
error Other = { code: Int }
service Clock { now(): Int fails Stop }
service Meter { read(): Int }
`;

function files(text: string): Record<string, string> {
  return { "effektive.json": "{}", "m.eff": PRELUDE + text };
}

function check(text: string): CheckedProject {
  const result = checkProject(memoryHost(files(text)), "", ["m.eff"]);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function codes(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => d.code);
}

function messages(project: CheckedProject): string[] {
  return project.diagnostics.map((d) => `${d.code} ${d.message}`);
}

function fn(project: CheckedProject, name: string) {
  const body = project.modules.get("m")?.functions.get(
    `value:m#${name}` as ValueId,
  );
  assert(body !== undefined, name);
  return body;
}

function shortIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.slice(id.indexOf("#") + 1));
}

function emitted(text: string): string {
  const module = emitFiles(files(text), ["m.eff"]).get("m");
  assert(module !== undefined, "module m was not emitted");
  return module.text;
}

Deno.test("a local with a result annotation infers both effect sets", () => {
  const project = check(`
const read = (): Int => Clock.now()
export const main = (): Int fails Stop uses Clock.now => read()
`);
  assertEquals(messages(project), []);
  const read = fn(project, "read");
  assertEquals(shortIds(read.failures), ["Stop"]);
  assertEquals(shortIds(read.requirements), ["Clock.now"]);
  assertEquals(read.mode, "effect");
  assertEquals(read.signature.written, {
    result: true,
    fails: false,
    uses: false,
  });
});

Deno.test("a written clause closes its set and the other set stays open", () => {
  const project = check(`
const read = (): Int fails Stop => Clock.now()
export const main = (): Int fails Stop uses Clock.now => read()
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "read").requirements), ["Clock.now"]);

  const tooSmall = check(`
const read = (): Int fails Other => Clock.now()
export const main = (): Int fails Other | Stop uses Clock.now => read()
`);
  assertEquals(codes(tooSmall), ["failure-contract/001"]);
  assertEquals(shortIds(fn(tooSmall, "read").requirements), ["Clock.now"]);

  const onlyUses = check(`
const read = (): Int uses Clock.now => Clock.now()
export const main = (): Int fails Stop uses Clock.now => read()
`);
  assertEquals(messages(onlyUses), []);
  assertEquals(shortIds(fn(onlyUses, "read").failures), ["Stop"]);
});

Deno.test("an inline arrow with a result annotation infers its sets", () => {
  const project = check(`
export const main = (): Int fails Stop uses Clock.now => {
  const next = (k: Int): Int => Clock.now()
  next(1)
}
`);
  assertEquals(messages(project), []);
  const main = fn(project, "main");
  assertEquals(shortIds(main.failures), ["Stop"]);
  assertEquals(shortIds(main.requirements), ["Clock.now"]);

  const closed = check(`
export const main = (): Int => {
  const next = (k: Int): Int => Clock.now()
  next(1)
}
`);
  assertEquals(codes(closed), [
    "failure-contract/001",
    "requirement-contract/001",
  ]);
});

Deno.test("a catch inside an open local shrinks the inferred failure set", () => {
  const project = check(`
const raise = (): Int fails Stop | Other => Clock.now()
const safe = (): Int =>
  try { raise() } catch {
    Stop(s) => 0
  }
export const main = (): Int fails Other uses Clock.now => safe()
`);
  assertEquals(messages(project), []);
  assertEquals(shortIds(fn(project, "raise").failures), ["Other", "Stop"]);
  assertEquals(shortIds(fn(project, "safe").failures), ["Other"]);
});

Deno.test("mutual recursion takes an effect that enters at the far end", () => {
  const text = `
const ping = (n: Int): Int => if (n === 0) { 0 } else { pong(n - 1) }
const pong = (n: Int): Int => if (n === 0) { Clock.now() } else { ping(n - 1) }
export const main = (n: Int): Int fails Stop uses Clock.now => ping(n)
`;
  const project = check(text);
  assertEquals(messages(project), []);
  for (const name of ["ping", "pong"]) {
    assertEquals(shortIds(fn(project, name).failures), ["Stop"], name);
    assertEquals(shortIds(fn(project, name).requirements), ["Clock.now"], name);
    assertEquals(fn(project, name).mode, "effect", name);
  }
  const output = emitted(text);
  assertStringIncludes(
    output,
    "const ping = (n: Int): Effect.Effect<Int, Stop, Clock> =>",
  );
  assertStringIncludes(
    output,
    "const pong = (n: Int): Effect.Effect<Int, Stop, Clock> =>",
  );
});

Deno.test("a recursive local keeps pure sets when no member has an effect", () => {
  const project = check(`
const even = (n: Int): Int => if (n === 0) { 1 } else { odd(n - 1) }
const odd = (n: Int): Int => if (n === 0) { 0 } else { even(n - 1) }
`);
  assertEquals(messages(project), []);
  assertEquals(fn(project, "even").mode, "pure");
  assertEquals(fn(project, "odd").failures, []);
});

Deno.test("a recursive local needs a result annotation", () => {
  const project = check(`
const loop = (n: Int) => if (n === 0) { 0 } else { loop(n - 1) }
`);
  assertEquals(codes(project), ["execution-mode/003"]);
});

Deno.test("recursion through a callback takes the effect of the far end", () => {
  const project = check(`
const visit = (n: Int): Int =>
  if (n === 0) { Meter.read() } else { fold(traverse([n - 1], (k) => visit(k)), 0, (a, b) => a + b) }
export const main = (n: Int): Int uses Meter.read => visit(n)
`);
  assertEquals(messages(project), []);
  const visit = fn(project, "visit");
  assertEquals(shortIds(visit.requirements), ["Meter.read"]);
  assertEquals(visit.failures, []);
  assertEquals(visit.mode, "effect");
});

/** A group of `count` functions. The effect enters at the last one and travels to f1. */
function chainOf(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const call = i === count - 1
      ? "if (n === 0) { Clock.now() } else { f1(n) }"
      : `f${i + 2}(n)`;
    return `const f${i + 1} = (n: Int): Int => ${call}`;
  }).join("\n");
}

Deno.test("the round cap bounds the solution of effect sets", () => {
  const short = check(chainOf(5));
  assertEquals(codes(short), []);
  assertEquals(shortIds(fn(short, "f1").failures), ["Stop"]);
  assertEquals(shortIds(fn(short, "f1").requirements), ["Clock.now"]);
  assertEquals(codes(check(chainOf(40))), ["execution-mode/004"]);
});

Deno.test("an exported function keeps its closed contract", () => {
  const omitted = check(`export const read = (): Int => Clock.now()`);
  assertEquals(codes(omitted), [
    "failure-contract/001",
    "requirement-contract/001",
  ]);
  const empty = check(`export const double = (n: Int): Int => n * 2`);
  assertEquals(messages(empty), []);
  assertEquals(
    empty.modules.get("m")!.functions.get(
      "value:m#double" as ValueId,
    )!.signature.written,
    { result: true, fails: true, uses: true },
  );
});

Deno.test("a binding type annotation keeps the contract closed", () => {
  const project = check(`
const read: (n: Int) => Int = (n) => Clock.now()
`);
  assertEquals(codes(project), [
    "failure-contract/001",
    "requirement-contract/001",
  ]);
});

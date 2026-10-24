// The export rule (I8): the emitter exports a private type when an exported
// declaration reaches it. Each test below makes a private type reachable only
// through one child of a type kind, then checks the emitted module. The
// tests use the public entry `emitFiles`.

import { assert } from "@std/assert";
import { emitFiles } from "./helpers.ts";

function emitted(text: string): string {
  const module = emitFiles({ "effektive.json": "{}", "m.eff": text }, [
    "m.eff",
  ]).get("m");
  assert(module !== undefined, "module m was not emitted");
  return module.text;
}

function isExported(text: string, name: string): boolean {
  return new RegExp(`^export (type|class|const) ${name}\\b`, "m").test(text);
}

function isDeclaredPrivate(text: string, name: string): boolean {
  return new RegExp(`^(type|class|const) ${name}\\b`, "m").test(text);
}

function assertExported(text: string, name: string): void {
  assert(isExported(text, name), `${name} is not exported in:\n${text}`);
}

Deno.test("a private type reached only through a Ref element is exported", () => {
  const text = emitted(
    "type Int = int\ntype B = { n: Int }\nexport type A = { r: Ref<B> }\n",
  );
  assertExported(text, "B");
});

Deno.test("a private type reached only through a Fiber result is exported", () => {
  const text = emitted(
    "type Int = int\ntype B = { n: Int }\nexport const f = (x: Fiber<B, never>): Int => 1\n",
  );
  assertExported(text, "B");
});

Deno.test("a private error reached only through a Fiber failure is exported", () => {
  const text = emitted(
    "type Int = int\nerror E = {}\nexport const f = (x: Fiber<Int, E>): Int => 1\n",
  );
  assertExported(text, "E");
});

Deno.test("a private error reached only through a RetrySchedule error is exported", () => {
  const text = emitted(
    "type Int = int\nerror E = {}\nexport const p: RetrySchedule<E> = retrySchedule((e: E, attempt: Int): Option<Int> => None)\n",
  );
  assertExported(text, "E");
});

Deno.test("a private type reached only through a Codec decoded type is exported", () => {
  const text = emitted(
    "type Int = int\ntype B = { n: Int }\nexport const c: Codec<B, Int> = codec((n: Int): B => ({ n: n }), (b: B): Int => b.n)\n",
  );
  assertExported(text, "B");
});

Deno.test("a private type reached only through a Codec encoded type is exported", () => {
  const text = emitted(
    "type Int = int\ntype B = { n: Int }\nexport const c: Codec<Int, B> = codec((b: B): Int => b.n, (n: Int): B => ({ n: n }))\n",
  );
  assertExported(text, "B");
});

Deno.test("a private type reached only through a Schema make input is exported", () => {
  const text = emitted([
    "type Int = int",
    "type Text = string",
    "type M = { score?: Int }",
    "type D = { score: Int }",
    "type E = { score: Text }",
    "export service Read { parse(value: Text): Int }",
    "export service Write { print(value: Int): Text }",
    "const integer: Schema<Int> = schema()",
    "const text: Schema<Text> = schema()",
    "const shifted: Schema<Int, Text, Read.parse, Write.print> = schemaTransform(text, integer, (value: Text): Option<Int> uses Read.parse => Some(Read.parse(value)), (value: Int): Option<Text> uses Write.print => Some(Write.print(value)))",
    "export const child: Schema<D, E, Read.parse, Write.print, M> = schemaStruct({ score: schemaConstructorDefault(shifted, (): Int => 4) })",
    "",
  ].join("\n"));
  assertExported(text, "M");
});

Deno.test("a private type that no exported declaration reaches stays private", () => {
  const text = emitted(
    "type Int = int\ntype B = { n: Int }\ntype C = { n: Int }\nexport type A = { r: Ref<B> }\n",
  );
  assert(isDeclaredPrivate(text, "C"), `C is missing in:\n${text}`);
  assert(!isExported(text, "C"), `C is exported in:\n${text}`);
});

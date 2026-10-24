import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("optional error presence survives imports", async () => {
  const result = await compileStrictTarget(
    {
      "errors.eff":
        "export error Stop = { stack?: string, message?: string, name?: string }\nexport const empty = (): Stop => Stop({})\n",
      "m.eff":
        'import { Stop, empty } from "./errors.eff"\ntype Text = string\nexport const read = (): Option<Text>[] => { const value = empty(); [value.stack, value.message, value.name] }\n',
    },
    ["m.eff"],
    'import { Option } from "effect";\nimport { read } from "./m.ts";\nconsole.log(JSON.stringify(read().map(Option.getOrNull)));',
    "effektive-sensitive-import-",
  );
  assertEquals(JSON.parse(result), [null, null, null]);
});

Deno.test("sensitive schema adapters preserve defaults and directional service effects", async () => {
  const output = await compileStrictTarget(
    {
      "m.eff": `
type Int = int
type Text = string
export type D = { toString: Int }
export type E = { toString?: Text }
type M = { toString?: Int }
export service Read { parse(value: Text): Int }
export service Write { print(value: Int): Text }
const text: Schema<Text> = schema()
const integer: Schema<Int> = schema()
const shifted: Schema<Int, Text, Read.parse, Write.print> = schemaTransform(text, integer, (value: Text): Option<Int> uses Read.parse => Some(Read.parse(value)), (value: Int): Option<Text> uses Write.print => Some(Write.print(value)))
const child: Schema<D, E, Read.parse, Write.print, M> = schemaStruct({ toString: schemaConstructorDefault(schemaDefaultKey(shifted, (): Int => 7), (): Int => 9) })
export const readValue = (input: unknown): D fails SchemaError uses Read.parse => schemaDecode(child, input)
export const writeValue = (input: D): E fails SchemaError uses Write.print => schemaEncode(child, input)
export const makeValue = (): D fails SchemaIssue => schemaMake(child, {})
`,
    },
    ["m.eff"],
    `
import { Effect, Layer } from "effect";
import { Read, Write, readValue, writeValue, makeValue } from "./m.ts";
const calls: string[] = [];
const read = Layer.succeed(Read)({parse: value => Effect.sync(() => {calls.push("read"); return Number(value);})});
const write = Layer.succeed(Write)({print: value => Effect.sync(() => {calls.push("write"); return String(value);})});
const missing = await Effect.runPromise(readValue({}).pipe(Effect.provide(read)));
const present = await Effect.runPromise(readValue({toString: "3"}).pipe(Effect.provide(read)));
const made = await Effect.runPromise(makeValue());
const encoded = await Effect.runPromise(writeValue(present).pipe(Effect.provide(write)));
console.log(JSON.stringify({missing, present, made, encoded, calls}));
`,
    "effektive-sensitive-direction-",
  );
  assertEquals(JSON.parse(output), {
    missing: { toString: 7 },
    present: { toString: 3 },
    made: { toString: 9 },
    encoded: { toString: "3" },
    calls: ["read", "write"],
  });
});

Deno.test("nominal errors preserve prototype-sensitive payloads", async () => {
  const result = await compileStrictTarget(
    {
      "m.eff": `
type Text = string
export error Stop = { __proto__: { value: Text }, constructor?: Text, toString?: Text }
export const makeStop = (): Stop => Stop({ __proto__: {value: "p"}, constructor: "c", toString: "t" })
export const emptyStop = (): Stop => Stop({ __proto__: {value: "p"} })
export const read = (e: Stop): Option<Text>[] => [e.constructor, e.toString]
`,
    },
    ["m.eff"],
    `
import { Option } from "effect";
import { Stop, makeStop, emptyStop, read } from "./m.ts";
const present = makeStop(), absent = emptyStop();
console.log(JSON.stringify({nominal: [present, absent].every(e => e instanceof Stop), proto: present.__proto__.value, present: read(present).map(Option.getOrNull), absent: read(absent).map(Option.getOrNull)}));
`,
    "effektive-sensitive-error-prototype-",
  );
  assertEquals(JSON.parse(result), {
    nominal: true,
    proto: "p",
    present: ["c", "t"],
    absent: [null, null],
  });
});

Deno.test("sensitive records preserve absence, updates, nesting and one receiver evaluation", async () => {
  const output = await compileStrictTarget(
    {
      "m.eff": `
type Text = string
export type R = { __proto__?: Text, constructor?: Text, toString?: Text, valueOf?: Text, hasOwnProperty?: Text }
type Exclude = string
export const $record = (): Text => "collision"
export const $optionalField = (): Text => "collision"
export const Object = (): Text => "collision"
export const empty = (): R => ({})
export const full = (): R => ({ __proto__: "proto", constructor: "ctor", toString: "str", valueOf: "val", hasOwnProperty: "own" })
export const changed = (): R => ({ ...full(), __proto__: "changed" })
export const read = (value: R): Option<Text>[] => [value.__proto__, value.constructor, value.toString, value.valueOf, value.hasOwnProperty]
export const once = (get: () => R): Option<Text> => get().__proto__
export const nested = (): { inner: R } => ({ inner: {} })
`,
    },
    ["m.eff"],
    `
import { Effect, Option } from "effect";
import { empty, full, changed, read, once, nested } from "./m.ts";
let calls = 0;
const one = await Effect.runPromise(once(() => Effect.sync(() => { calls++; return full(); })));
console.log(JSON.stringify({ absent: read(empty()).map(Option.getOrNull), present: read(full()).map(Option.getOrNull), changed: read(changed()).map(Option.getOrNull), one: Option.getOrNull(one), calls, nested: read(nested().inner).map(Option.getOrNull) }));
`,
    "effektive-sensitive-records-",
  );
  assertEquals(JSON.parse(output), {
    absent: [null, null, null, null, null],
    present: ["proto", "ctor", "str", "val", "own"],
    changed: ["changed", "ctor", "str", "val", "own"],
    one: "proto",
    calls: 1,
    nested: [null, null, null, null, null],
  });
});

Deno.test("sensitive schema fields roundtrip with missing fields and nested defaults", async () => {
  const output = await compileStrictTarget(
    {
      "m.eff": `
type Text = string
export type R = { __proto__?: Text, constructor?: Text, toString?: Text }
export type Tree = { data: R, kids: Tree[] }
const text: Schema<Text> = schema()
export const record: Schema<R> = schemaStruct({ __proto__: schemaOptionalKey(text), constructor: schemaOptionalKey(text), toString: schemaOptionalKey(text) })
export const roundtrip: Codec<R, R> = codec((r: R): R => r, (r: R): R => r)
const tree: Schema<Tree> = schema()
export const readSchema = (input: unknown): R fails SchemaError => schemaDecode(record, input)
export const writeSchema = (input: R): R fails SchemaError => schemaEncode(record, input)
export const make = (): R fails SchemaIssue => schemaMake(record, {})
export const decodeTree = (input: unknown): Tree fails SchemaError => schemaDecode(tree, input)
export const encodeTree = (input: Tree): Tree fails SchemaError => schemaEncode(tree, input)
`,
    },
    ["m.eff"],
    `
import { Effect, Option } from "effect";
import { readSchema, writeSchema, make, decodeTree, encodeTree, roundtrip } from "./m.ts";
const present = JSON.parse('{"__proto__":"p","constructor":"c","toString":"t"}');
if (Option.isNone(roundtrip.decode({})) || Option.isNone(roundtrip.encode(await Effect.runPromise(make())))) throw new Error("codec absence");
const extra = Object.defineProperty({}, "ignored", { enumerable: true, get() { throw new Error("ignored field was evaluated"); } });
const absent = await Effect.runPromise(readSchema(extra));
const value = await Effect.runPromise(readSchema(present));
const tree = await Effect.runPromise(decodeTree(Object.freeze({data: Object.freeze({}), kids: Object.freeze([{data: Object.freeze(present), kids: []}])})));
console.log(JSON.stringify([absent, value, await Effect.runPromise(writeSchema(value)), await Effect.runPromise(make()), await Effect.runPromise(encodeTree(tree))]));
`,
    "effektive-sensitive-schema-",
  );
  const present = JSON.parse(
    '{"__proto__":"p","constructor":"c","toString":"t"}',
  );
  assertEquals(JSON.parse(output), [{}, present, present, {}, {
    data: {},
    kids: [{ data: present, kids: [] }],
  }]);
});

Deno.test("nominal errors retain supplied optional message, name and stack through recovery and schemas", async () => {
  const output = await compileStrictTarget(
    {
      "m.eff": `
type Text = string
export error Stop = { message?: Text, name?: Text, stack?: Text }
const stop: Schema<Stop> = schema()
export const empty = (): Stop => Stop({})
export const full = (): Stop => Stop({ message: "m", name: "n", stack: "s" })
export const read = (value: Stop): Option<Text>[] => [value.message, value.name, value.stack]
export const readSchema = (input: unknown): Stop fails SchemaError => schemaDecode(stop, input)
export const writeSchema = (value: Stop): Stop fails SchemaError => schemaEncode(stop, value)
export const recover = (): Option<Text>[] => try { fail(empty()) } catch { Stop(e) => read(e) }
`,
    },
    ["m.eff"],
    `
import { Effect, Option } from "effect";
import { Stop, empty, full, read, readSchema, writeSchema, recover } from "./m.ts";
const missing = empty();
const present = full();
const decoded = await Effect.runPromise(readSchema(empty()));
console.log(JSON.stringify({missing: read(missing).map(Option.getOrNull), present: read(present).map(Option.getOrNull), decoded: read(decoded).map(Option.getOrNull), nominal: [missing, present, decoded].every(e => e instanceof Stop), encoded: read(await Effect.runPromise(writeSchema(decoded))).map(Option.getOrNull), recovered: await Effect.runPromise(recover()).then(xs => xs.map(Option.getOrNull))}));
`,
    "effektive-sensitive-errors-",
  );
  assertEquals(JSON.parse(output), {
    missing: [null, null, null],
    present: ["m", "n", "s"],
    decoded: [null, null, null],
    nominal: true,
    encoded: [null, null, null],
    recovered: [null, null, null],
  });
});

Deno.test("present optional sensitive unknown fields retain undefined", async () => {
  const result = await compileStrictTarget(
    {
      "m.eff": `type Value = unknown
 type R = { __proto__?: unknown }
 export const empty = (): R => ({})
 export const full = (value: Value): R => ({__proto__: value})
 export const read = (value: R): Option<Value> => value.__proto__
 `,
    },
    ["m.eff"],
    `import { Option } from "effect";
 import { empty, full, read } from "./m.ts";
 console.log(JSON.stringify([Option.isNone(read(empty())), Option.isSome(read(full(undefined)))]));
 `,
    "effektive-sensitive-undefined-",
  );
  assertEquals(JSON.parse(result), [true, true]);
});

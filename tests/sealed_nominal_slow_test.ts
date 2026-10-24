import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("sealed nominal types preserve their runtime representation", async () => {
  const stdout = await compileStrictTarget(
    {
      "lib.eff": `
export type Int = int
export type Text = string
export type Flag = boolean
export sealed nominal Positive = Int
export sealed nominal Article = { id: Positive, title: Text }
export const positive = (value: Int): Positive => Positive(value)
export const article = (id: Positive, title: Text): Article => Article({ id, title })
export const positiveSchema: Schema<Positive> = schema()
export const decodePositive = (input: unknown): Positive fails SchemaError => schemaDecode(positiveSchema, input)
`,
      "main.eff": `
import { Int, Text, Flag, Positive, Article, positiveSchema } from "./lib.eff"
export const keep = (value: Positive): Positive => value
export const equal = (value: Positive, expected: Int): Flag => value === expected
export const title = (value: Article): Text => value.title
export const encodeValue = (value: Positive): Positive fails SchemaError => schemaEncode(positiveSchema, value)
`,
    },
    ["main.eff"],
    `import { Effect } from "effect";
import { article, decodePositive, positive } from "./lib.ts";
import { encodeValue, equal, keep, title } from "./main.ts";

const constructed = positive(2);
const decoded = await Effect.runPromise(decodePositive(3));
const encoded = await Effect.runPromise(encodeValue(decoded));
console.log(JSON.stringify({
  constructed: keep(constructed),
  decoded,
  encoded,
  equal: equal(decoded, 3),
  title: title(article(constructed, "sealed")),
}));`,
    "effektive-sealed-nominal-",
  );
  assertEquals(JSON.parse(stdout), {
    constructed: 2,
    decoded: 3,
    encoded: 3,
    equal: true,
    title: "sealed",
  });
});

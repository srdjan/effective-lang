import { assert, assertEquals } from "@std/assert";
import {
  buildSpanTable,
  checkProject,
  emitProject,
  lowerProject,
  mapOffset,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { deno, withTemporaryDirectory } from "./process_helpers.ts";

const widths = [
  40,
  46,
  47,
  48,
  49,
  50,
  51,
  52,
  60,
  62,
  63,
  64,
  65,
  66,
  70,
  74,
  75,
  76,
  80,
  96,
  120,
];
const identifier = (prefix: string, width: number): string =>
  prefix + "x".repeat(width - prefix.length);

function sources(width: number): Record<string, string> {
  const field = identifier("field", width);
  const fn = identifier("fn", width);
  const error = identifier("Error", width);
  const service = identifier("Service", width);
  const text = identifier("Text", width);
  return {
    error:
      `export error ${error} = { message: string }\nexport const read = (): Text => ${error}({ message: "ok" }).message`,
    struct:
      `export type Box = { ${field}: string }\nexport const read = (): Text => { const box: Box = { ${field}: "ok" }\n box.${field} }`,
    arrow:
      `export const ${fn} = (text: Text): Text => text\nexport const read = (): Text => ${fn}("ok")`,
    block:
      `export const ${fn} = (text: Text): Text => { const value = text\n value }\nexport const read = (): Text => ${fn}("ok")`,
    member:
      `export type Box = { ${field}: string }\nexport const read = (box: Box): Text => box.${field}`,
    service:
      `export service ${service} { read(): Text }\nexport const read = (): Text uses ${service}.read => { const value = ${service}.read()\n value }`,
    parameter:
      `type ${text} = Text\nexport const read = (value: ${text}): Text => value`,
    optional:
      `type Box = { ${field}?: string }\nexport const read = (box: Box): Option<Text> => box.${field}`,
    nested:
      `type Box = { nested: { ${field}: string } }\nexport const read = (box: Box): Text => box.nested.${field}`,
    brand: `nominal ${
      identifier("Brand", width)
    } = string\nexport const read = (text: Text): ${
      identifier("Brand", width)
    } => ${identifier("Brand", width)}(text)`,
    schemamake: `export const read = (${
      identifier("schema", width)
    }: Schema<Text>): Text fails SchemaIssue => schemaMake(${
      identifier("schema", width)
    }, "ok")`,
    longparameter: `export const read = (${
      identifier("parameter", width)
    }: Text): Text => ${identifier("parameter", width)}`,
    zero:
      `export const ${fn} = (): Text => "ok"\nexport const read = (): Text => ${fn}()`,
    ...(width === 120
      ? {
        evaluation:
          `type Box = { ${field}: string }\nexport const read = (next: () => Box): Text => next().${field}`,
      }
      : {}),
  };
}

Deno.test("extreme identifiers preserve formatting, execution and source mappings at wrapping boundaries", async () => {
  const files: Record<string, string> = { "effektive.json": "{}" };
  const cases = widths.flatMap((width) =>
    Object.entries(sources(width)).map(([kind, body]) => {
      const module = `${kind}-${width}`;
      const source = `type Text = string\n${body}\n`;
      files[`${module}.eff`] = source;
      return { kind, width, module, source };
    })
  );
  const checked = checkProject(
    memoryHost(files),
    "",
    cases.map((c) => `${c.module}.eff`),
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value);
  for (
    const diagnostics of validateProject(
      checked.value.analysis.project,
      lowered,
    ).values()
  ) {
    assertEquals(diagnostics, []);
  }
  const emitted = emitProject(lowered, {
    config: checked.value.analysis.project.config,
  });
  const imports = ['import { Effect, Option, Schema } from "effect";'];
  const runs: string[] = [];
  await withTemporaryDirectory(
    "effektive-extreme-identifiers-",
    async (dir) => {
      Deno.writeTextFileSync(
        `${dir}/deno.json`,
        JSON.stringify({
          imports: { effect: "npm:effect@4.0.5" },
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
          },
        }),
      );
      for (const [i, c] of cases.entries()) {
        const result = emitted.get(c.module);
        assert(result?.ok, JSON.stringify(result));
        const generated = result.value;
        Deno.writeTextFileSync(`${dir}/${generated.path}`, generated.text);
        const alias = `m${i}`;
        imports.push(`import * as ${alias} from "./${generated.path}";`);
        const call = c.kind === "member"
          ? `${alias}.read({ ${identifier("field", c.width)}: "ok" })`
          : c.kind === "parameter" || c.kind === "brand" ||
              c.kind === "longparameter"
          ? `${alias}.read("ok")`
          : c.kind === "optional"
          ? `Option.getOrElse(${alias}.read({ ${
            identifier("field", c.width)
          }: "ok" }), () => "missing")`
          : c.kind === "nested"
          ? `${alias}.read({ nested: { ${
            identifier("field", c.width)
          }: "ok" } })`
          : c.kind === "schemamake"
          ? `await Effect.runPromise(${alias}.read(Schema.String))`
          : c.kind === "evaluation"
          ? `await Effect.runPromise(${alias}.read(() => Effect.sync(() => { calls++; return { ${
            identifier("field", c.width)
          }: "ok" }; })))`
          : c.kind === "service"
          ? `await Effect.runPromise(Effect.provideService(${alias}.read(), ${alias}.${
            identifier("Service", c.width)
          }, { read: () => Effect.succeed("ok") }))`
          : `${alias}.read()`;
        runs.push(call);
        // Verify actual mapped tokens after the new breaks, not only span bounds.
        const table = buildSpanTable(generated);
        if (c.kind === "member") {
          const field = identifier("field", c.width);
          const offset = generated.text.lastIndexOf(`.${field}`) + 1;
          assert(offset > 0);
          const span = mapOffset(table, offset);
          assert(span);
          assertEquals(c.source.slice(span.start, span.end), `box.${field}`);
        } else if (c.kind === "service") {
          const offset = generated.text.lastIndexOf("return value;") +
            "return ".length;
          const span = mapOffset(table, offset);
          assert(span);
          assertEquals(c.source.slice(span.start, span.end), "value");
        } else if (c.kind === "arrow") {
          const body = /=>\s+text;/.exec(generated.text);
          assert(body, c.module);
          const offset = body.index + body[0].lastIndexOf("text");
          const span = mapOffset(table, offset);
          assert(span);
          assertEquals(c.source.slice(span.start, span.end), "text");
        }
      }
      const formatted = await deno(dir, [
        "fmt",
        "--check",
        ...cases.map((c) => `${c.module}.ts`),
      ]);
      assertEquals(formatted.code, 0, formatted.stderr);
      Deno.writeTextFileSync(
        `${dir}/run.ts`,
        `${imports.join("\n")}\nlet calls = 0;\nconsole.log(JSON.stringify([${
          runs.join(",\n")
        } ]));\nif (calls !== 1) throw new Error("member base ran " + calls + " times");\n`,
      );
      const target = await deno(dir, [
        "check",
        "--config",
        "deno.json",
        "run.ts",
      ]);
      assertEquals(target.code, 0, target.stderr);
      const ran = await deno(dir, ["run", "--config", "deno.json", "run.ts"]);
      assertEquals(ran.code, 0, ran.stderr);
      assertEquals(JSON.parse(ran.stdout), cases.map(() => "ok"));
    },
  );
});

import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

// The tags of the recursive alias T are literal aliases, and the aliases come
// before and after the recursive declaration.
const source = `export type A = "a"
export type T = { tag: A, next: T } | { tag: B }
export type B = "b"
const lit_a: Schema<A> = schema()
const lit_b: Schema<B> = schema()
export const t: Schema<T> = schemaRecursive((self: Schema<T>): Schema<T> =>
  schemaUnion([schemaStruct({ tag: lit_a, next: self }), schemaStruct({ tag: lit_b })]))
export const parse = (x: T): T fails SchemaError => schemaDecode(t, x)
export const make = (x: T): T fails SchemaIssue => schemaMake(t, x)
`;

Deno.test("a recursive alias with literal alias tags validates, passes strict tsc, and round-trips", async () => {
  const project = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-tag-alias-" });
  try {
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
    for (
      const result of emitProject(lowered, {
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Effect, Exit } from "effect";
import { make, parse, type T } from "./main.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const value: T = { tag: "a", next: { tag: "a", next: { tag: "b" } } };
expect(await Effect.runPromise(parse(value)), value);
expect(await Effect.runPromise(make(value)), value);
expect(await Effect.runPromise(parse({ tag: "b" } as T)), { tag: "b" });
const bad: unknown = { tag: "a", next: { tag: "c" } };
if (!Exit.isFailure(await Effect.runPromiseExit(parse(bad as T)))) throw new Error("a wrong nested tag decoded");
const missing: unknown = { tag: "a" };
if (!Exit.isFailure(await Effect.runPromiseExit(parse(missing as T)))) throw new Error("a missing next field decoded");
`,
    );
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

import { assert, assertEquals } from "@std/assert";
import { Program, serializeModule } from "../src/core/frontend.ts";
import {
  serializeSourceMap,
  TypeScriptOutputs,
} from "../src/core/typescript.ts";

/** The accepted v3 wire changes, with the v5 version and `tagged` flag. Keep spans, annotations and identities intact. */
function v4(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(v4);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const base = record.base as { kind?: unknown } | undefined;
  return Object.fromEntries(
    Object.entries(
      record.kind === "nominal" && base?.kind === "record"
        ? { ...record, tagged: true }
        : record,
    )
      .filter(([key]) =>
        !["useBinding", "releaseBinding", "groupBinding"].includes(key)
      )
      .map((
        [key, item],
      ) => [
        key,
        key === "version" && record.format === "light-functional-ir"
          ? 5
          : v4(item),
      ]),
  );
}

Deno.test("IR v4 changes only the wire version and duplicate scoped identities", () => {
  const corpus = JSON.parse(
    Deno.readTextFileSync(
      new URL("../fixtures/ir/v3-baseline.json", import.meta.url),
    ),
  );
  for (const { files, modules } of corpus) {
    const program = new Program();
    const outputs = new TypeScriptOutputs();
    const updated = program.update({ set: files });
    assert(updated.ok);
    assertEquals(updated.value.diagnostics, []);
    for (const expected of modules) {
      const ir = updated.value.lowered(expected.name);
      const emitted = outputs.emitted(updated.value, expected.name);
      const map = outputs.sourceMap(updated.value, expected.name);
      assert(ir?.ok && emitted?.ok && map?.ok);
      const text = serializeModule(ir.value);
      assert(text.ok);
      assertEquals(JSON.parse(text.value), v4(expected.ir));
      assertEquals(emitted.value, expected.emitted);
      assertEquals(serializeSourceMap(map.value), expected.map);
      assertEquals(updated.value.interfaceHash(expected.name), expected.hash);
      assertEquals(
        [...updated.value.validate(new Map([[expected.name, ir]])).values()]
          .flat(),
        [],
      );
    }
  }
});

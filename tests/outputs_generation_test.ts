import { assert, assertEquals } from "@std/assert";
import { buildSpanTable, Program } from "../src/core/mod.ts";
import type {
  EmittedModule,
  LowerError,
  Revision,
  SourceMapV3,
} from "../src/core/mod.ts";
import { generationSource } from "../src/host/generation.ts";
import type { GeneratedSource, Generation } from "../src/host/generation.ts";
import { writeGenerated } from "../src/host/outputs.ts";
import { memoryIo } from "./cli_helpers.ts";

const emitted: EmittedModule = {
  module: "m",
  path: "m.ts",
  text: "export {};\n",
  spans: [],
  hostAssertions: [],
};
const table = buildSpanTable(emitted);
const map: SourceMapV3 = {
  version: 3,
  file: "m.ts",
  sources: [],
  names: [],
  mappings: "",
};
const ready: Generation = { kind: "ready", emitted, table, map };
function source(result: Generation): GeneratedSource {
  return { generated: () => result };
}

Deno.test("generationSource adapts real revisions, unknown modules and source errors", () => {
  const updated = new Program().update({
    set: {
      "effective.json": "{}",
      "m.eff": "type I = int\nexport const x: I = 1\n",
      "bad.eff": 'type I = int\nexport const x: I = "bad"\n',
    },
  });
  assert(updated.ok);
  const input = generationSource(updated.value);
  assertEquals(input.generated("absent"), { kind: "skip" });
  assertEquals(input.generated("bad"), { kind: "skip" });
  const good = input.generated("m");
  assert(good.kind === "ready");
  const existing = updated.value.emitted("m");
  assert(existing?.ok);
  assertEquals(good.emitted, existing.value);
});

Deno.test("generationSource retains query order and classifies emit, map and absent results", () => {
  type Queries = Pick<
    Revision,
    "lowered" | "emitted" | "spanTable" | "sourceMap"
  >;
  for (
    const broken of ["emitted", "spanTable", "sourceMap", "absent"] as const
  ) {
    const calls: string[] = [];
    const lower = new Program().update({
      set: {
        "effective.json": "{}",
        "m.eff": "type I = int\nexport const x: I = 1\n",
      },
    });
    assert(lower.ok);
    const queries: Queries = {
      lowered: (name) => {
        calls.push("lower");
        return lower.value.lowered(name);
      },
      emitted: () => {
        calls.push("emit");
        return broken === "emitted"
          ? {
            ok: false,
            error: { tag: "internal", module: "m", message: "broken" },
          }
          : { ok: true, value: emitted };
      },
      spanTable: () => {
        calls.push("table");
        return broken === "spanTable"
          ? {
            ok: false,
            error: { tag: "internal", module: "m", message: "broken" },
          }
          : { ok: true, value: table };
      },
      sourceMap: () => {
        calls.push("map");
        return broken === "absent"
          ? undefined
          : broken === "sourceMap"
          ? { ok: false, error: { tag: "missing-source", source: "m.eff" } }
          : { ok: true, value: map };
      },
    };
    assertEquals(
      generationSource(queries).generated("m").kind,
      broken === "emitted" ? "emit" : broken === "absent" ? "skip" : "map",
    );
    assertEquals(calls, ["lower", "emit", "table", "map"]);
  }
});

Deno.test("writeGenerated skips absent or diagnosed modules and reports each generation failure", () => {
  const failures: readonly [Generation, string | undefined][] = [
    [{ kind: "skip" }, undefined],
    [{
      kind: "emit",
      error: { tag: "internal", module: "m", message: "broken" },
    }, "error: cannot emit m: internal"],
    [{ kind: "map" }, "error: cannot build the source map of m"],
  ];
  for (const [result, note] of failures) {
    const io = memoryIo({});
    const output = writeGenerated(
      io.io.fs,
      "/project",
      source(result),
      ["m"],
      true,
    );
    assertEquals(output.notes, note === undefined ? [] : [note]);
    assertEquals(output.failed, note !== undefined);
    assertEquals(output.generated, []);
    assertEquals(io.files.size, 0);
  }
});

Deno.test("writeGenerated reports every non-diagnostic lowering failure", () => {
  const errors: readonly [
    Exclude<LowerError, { tag: "diagnostics" }>,
    string,
  ][] = [
    [{ tag: "unknown-module", module: "m" }, "m: unknown-module"],
    [{ tag: "host-interface", module: "m" }, "m: host-interface"],
    [
      { tag: "no-interface", module: "m", imported: "dep" },
      "m imports dep, which has no interface",
    ],
    [{
      tag: "unsupported",
      module: "m",
      message: "unsupported form",
      span: { source: "m.eff", start: 0, end: 1 },
    }, "m: unsupported form"],
    [{ tag: "internal", module: "m", message: "broken" }, "m: broken"],
  ];
  for (const [error, message] of errors) {
    const io = memoryIo({});
    const output = writeGenerated(
      io.io.fs,
      "/project",
      source({ kind: "lower", error }),
      ["m"],
      true,
    );
    assertEquals(output.notes, [`error: cannot lower ${message}`]);
    assert(output.failed);
    assertEquals(output.written, []);
  }
});

Deno.test("writeGenerated continues after failure, preserves names and writes only changed files", () => {
  const io = memoryIo({});
  const input: GeneratedSource = {
    generated: (name) => name === "bad" ? { kind: "map" } : ready,
  };
  const first = writeGenerated(io.io.fs, "/project", input, ["bad", "m"], true);
  assertEquals(first.generated, ["m.ts"]);
  assertEquals(first.written, ["m.ts", "m.ts.map"]);
  assertEquals(first.tables.get("m.ts"), table);
  assert(first.failed);
  const second = writeGenerated(
    io.io.fs,
    "/project",
    source(ready),
    ["m"],
    true,
  );
  assertEquals(second.written, []);
  assertEquals(second.notes, []);
  assertEquals(second.failed, false);
});

Deno.test("writeGenerated dry runs and partial write failures retain output metadata", () => {
  const io = memoryIo({});
  const dry = writeGenerated(io.io.fs, "/project", source(ready), ["m"], false);
  assertEquals(dry.generated, ["m.ts"]);
  assertEquals(dry.written, []);
  assertEquals(io.files.size, 0);
  io.unwritable.add("/project/m.ts.map");
  const failed = writeGenerated(
    io.io.fs,
    "/project",
    source(ready),
    ["m"],
    true,
  );
  assertEquals(failed.generated, ["m.ts"]);
  assertEquals(failed.written, ["m.ts"]);
  assertEquals(failed.notes, [
    "error: cannot write m.ts.map: permission denied",
  ]);
  assert(failed.failed);
  io.unwritable.clear();
  assertEquals(
    writeGenerated(io.io.fs, "/project", source(ready), ["m"], true).written,
    ["m.ts.map"],
  );
});

Deno.test("generationSource stops after a lowering failure and keeps diagnostics silent", () => {
  for (
    const error of [
      { tag: "diagnostics", module: "m", count: 1 },
      { tag: "internal", module: "m", message: "broken" },
    ] as const
  ) {
    const unexpected = (): never => {
      throw new Error("queried after lowering failed");
    };
    const result = generationSource({
      lowered: () => ({ ok: false, error }),
      emitted: unexpected,
      spanTable: unexpected,
      sourceMap: unexpected,
    }).generated("m");
    assertEquals(
      result,
      error.tag === "diagnostics" ? { kind: "skip" } : { kind: "lower", error },
    );
  }
});

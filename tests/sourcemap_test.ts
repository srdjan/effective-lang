// Tests for part A6b: VLQ coding and source maps. A round trip decodes the
// mappings of a map and compares each generated position with the span table.

import { assert, assertEquals } from "@std/assert";
import {
  buildSourceMap,
  decodeMappings,
  decodeVlqList,
  encodeVlq,
  lookupMapping,
  serializeSourceMap,
} from "../src/core/emit/sourcemap.ts";
import {
  buildSpanTable,
  hostImportSpans,
  mapOffset,
  type SpanTable,
} from "../src/core/emit/spans.ts";
import { lineStarts, positionOf } from "../src/core/source.ts";
import {
  emitFilesWithProject,
  EXAMPLE_ENTRIES,
  exampleFiles,
  projectFiles,
} from "./helpers.ts";

// ------------------------------------------------------------------ VLQ

Deno.test("VLQ encodes the known values of the source map format", () => {
  const known: readonly (readonly [number, string])[] = [
    [0, "A"],
    [1, "C"],
    [-1, "D"],
    [15, "e"],
    [16, "gB"],
    [-16, "hB"],
    [123, "2H"],
    [-123, "3H"],
    [1023, "+/B"],
    [2 ** 31, "ggggggE"],
  ];
  for (const [value, text] of known) {
    assertEquals(encodeVlq(value), text, `encode ${value}`);
    assertEquals(decodeVlqList(text), { ok: true, value: [value] });
  }
});

Deno.test("VLQ round-trips integers, singly and in lists", () => {
  const values: number[] = [];
  for (let v = -2000; v <= 2000; v += 7) values.push(v);
  values.push(2 ** 31 - 1, -(2 ** 31), 2 ** 40, -(2 ** 40), 2 ** 50);
  for (const value of values) {
    assertEquals(decodeVlqList(encodeVlq(value)), { ok: true, value: [value] });
  }
  assertEquals(
    decodeVlqList(values.map(encodeVlq).join("")),
    { ok: true, value: values },
  );
});

Deno.test("VLQ decoding rejects a bad character and a truncated digit", () => {
  assertEquals(decodeVlqList("A!"), {
    ok: false,
    error: { tag: "bad-character", index: 1 },
  });
  // "g" has the continuation bit and nothing follows.
  assertEquals(decodeVlqList("Ag"), {
    ok: false,
    error: { tag: "truncated", index: 2 },
  });
  assertEquals(decodeVlqList(""), { ok: true, value: [] });
});

Deno.test("VLQ encoding rejects a value that is not a safe integer", () => {
  let threw = false;
  try {
    encodeVlq(1.5);
  } catch {
    threw = true;
  }
  assert(threw);
});

// ------------------------------------------------------------------ source maps

const exampleProject = emitFilesWithProject(exampleFiles(), EXAMPLE_ENTRIES);
const formsFiles = projectFiles("emit/forms");
const formsProject = emitFilesWithProject(formsFiles, [
  "forms.eff",
  "names.eff",
]);
const logFiles = projectFiles("ir");
const logProject = emitFilesWithProject(logFiles, ["example/log.eff"]);

function textsOf(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

function tableOf(
  project: typeof exampleProject,
  name: string,
): SpanTable {
  const module = project.emitted.get(name);
  assert(module !== undefined, `module ${name} was not emitted`);
  return buildSpanTable(module, hostImportSpans(project.project).get(name));
}

Deno.test("a source map has version 3, the file, the relative source, and no names", () => {
  const table = tableOf(exampleProject, "users");
  const built = buildSourceMap(table, textsOf(exampleFiles()));
  assert(built.ok);
  assertEquals(built.value.version, 3);
  assertEquals(built.value.file, "users.ts");
  assertEquals(built.value.sources, ["users.eff"]);
  assertEquals(built.value.names, []);
  assertEquals(built.value.sourcesContent, undefined);
  assert(built.value.mappings.length > 0);
});

Deno.test("sourcesContent holds the source texts when asked", () => {
  const table = tableOf(exampleProject, "users");
  const files = exampleFiles();
  const built = buildSourceMap(table, textsOf(files), { includeContent: true });
  assert(built.ok);
  assertEquals(built.value.sourcesContent, [files["users.eff"]]);
});

Deno.test("a module in a directory gets a source path relative to its map", () => {
  const table = tableOf(logProject, "example/log");
  assertEquals(table.path, "example/log.ts");
  const built = buildSourceMap(table, textsOf(logFiles));
  assert(built.ok);
  assertEquals(built.value.file, "log.ts");
  assertEquals(built.value.sources, ["log.eff"]);
});

Deno.test("a missing source text is an error value", () => {
  const table = tableOf(exampleProject, "users");
  assertEquals(buildSourceMap(table, new Map()), {
    ok: false,
    error: { tag: "missing-source", source: "users.eff" },
  });
});

/**
 * Decodes the mappings and compares them with the span table at every offset
 * of the generated text: each generated position maps back to the start line
 * and column of its innermost source span, or to nothing.
 */
function assertRoundTrip(
  table: SpanTable,
  text: string,
  files: Record<string, string>,
): void {
  const built = buildSourceMap(table, textsOf(files));
  assert(built.ok, JSON.stringify(built));
  const decoded = decodeMappings(built.value.mappings);
  assert(decoded.ok, JSON.stringify(decoded));
  assertEquals(decoded.value.length, table.lineStarts.length);
  const starts = lineStarts(text);
  for (let offset = 0; offset < text.length; offset++) {
    const generated = positionOf(starts, text, offset);
    const found = lookupMapping(
      decoded.value,
      generated.line - 1,
      generated.column - 1,
    );
    const span = mapOffset(table, offset);
    if (span === undefined) {
      assertEquals(found, undefined, `${table.path} offset ${offset}`);
      continue;
    }
    const source = files[span.source];
    const expected = positionOf(lineStarts(source), source, span.start);
    assert(found !== undefined, `${table.path} offset ${offset} is unmapped`);
    const relative = built.value.sources[found.source ?? -1];
    const directory = table.path.slice(0, table.path.lastIndexOf("/") + 1);
    assertEquals(
      [directory + relative, found.line, found.column],
      [span.source, expected.line - 1, expected.column - 1],
      `${table.path} offset ${offset}`,
    );
  }
}

Deno.test("every position of every example maps back to the start of its source span", () => {
  const files = exampleFiles();
  for (const [name, module] of exampleProject.emitted) {
    assertRoundTrip(tableOf(exampleProject, name), module.text, files);
  }
});

Deno.test("every position of the forms and of a module in a directory round-trips", () => {
  for (const [name, module] of formsProject.emitted) {
    assertRoundTrip(tableOf(formsProject, name), module.text, formsFiles);
  }
  for (const [name, module] of logProject.emitted) {
    assertRoundTrip(tableOf(logProject, name), module.text, logFiles);
  }
});

Deno.test("each recorded segment start maps to its source line and column", () => {
  // The direct form of the round trip: the segment at the start of the
  // innermost record of an expression.
  const files = exampleFiles();
  const table = tableOf(exampleProject, "users");
  const module = exampleProject.emitted.get("users");
  assert(module !== undefined);
  const built = buildSourceMap(table, textsOf(files));
  assert(built.ok);
  const decoded = decodeMappings(built.value.mappings);
  assert(decoded.ok);
  const offset = module.text.indexOf("new UserMissing");
  const generated = positionOf(lineStarts(module.text), module.text, offset);
  const found = lookupMapping(
    decoded.value,
    generated.line - 1,
    generated.column - 1,
  );
  const source = files["users.eff"];
  const start = source.indexOf("UserMissing({ id })");
  const expected = positionOf(lineStarts(source), source, start);
  assertEquals(found?.line, expected.line - 1);
  assertEquals(found?.column, expected.column - 1);
});

Deno.test("the mappings stay compact: merged segments, no empty line markers", () => {
  const table = tableOf(exampleProject, "users");
  const built = buildSourceMap(table, textsOf(exampleFiles()));
  assert(built.ok);
  const segments = built.value.mappings.split(";").flatMap((line) =>
    line === "" ? [] : line.split(",")
  );
  // Far fewer segments than characters: the map holds one per change.
  const module = exampleProject.emitted.get("users");
  assert(module !== undefined);
  assert(segments.length < module.text.length / 4);
});

Deno.test("a serialized map is JSON with a fixed key order and a final newline", () => {
  const table = tableOf(exampleProject, "users");
  const built = buildSourceMap(table, textsOf(exampleFiles()), {
    includeContent: true,
  });
  assert(built.ok);
  const text = serializeSourceMap(built.value);
  assert(text.endsWith("}\n"));
  assertEquals(JSON.parse(text), built.value);
  assertEquals(
    Object.keys(JSON.parse(text)),
    ["version", "file", "sources", "sourcesContent", "names", "mappings"],
  );
  assertEquals(serializeSourceMap(built.value), text);
});

Deno.test("a decoder rejects a malformed mappings string", () => {
  assertEquals(decodeMappings("AAAA;!"), {
    ok: false,
    error: {
      tag: "bad-vlq",
      line: 1,
      error: { tag: "bad-character", index: 0 },
    },
  });
  assertEquals(decodeMappings("AAA"), {
    ok: false,
    error: { tag: "bad-segment", line: 0, fields: 3 },
  });
});

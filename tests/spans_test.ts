// Tests for part A6b: the span table. They go through the public functions of
// src/core/emit/spans.ts on the emitted examples and forms.

import { assert, assertEquals } from "@std/assert";
import type { EmittedModule } from "../src/core/emit/emit.ts";
import {
  buildSpanTable,
  hostImportSpans,
  mapGenerated,
  mapOffset,
  offsetOfGenerated,
  recordAtOffset,
  type SpanTable,
} from "../src/core/emit/spans.ts";
import { lineStarts, positionOf, spanText } from "../src/core/source.ts";
import {
  emitFilesWithProject,
  EXAMPLE_ENTRIES,
  exampleFiles,
  projectFiles,
} from "./helpers.ts";

const examples = emitFilesWithProject(exampleFiles(), EXAMPLE_ENTRIES);
const forms = emitFilesWithProject(projectFiles("emit/forms"), [
  "forms.eff",
  "names.eff",
]);
const sources = exampleFiles();

function exampleModule(name: string): EmittedModule {
  const module = examples.emitted.get(name);
  assert(module !== undefined, `module ${name} was not emitted`);
  return module;
}

function tableOf(name: string): SpanTable {
  return buildSpanTable(
    exampleModule(name),
    hostImportSpans(examples.project).get(name),
  );
}

function offsetOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  assert(at >= 0, `the text does not contain ${needle}`);
  return at;
}

function sourceTextAt(table: SpanTable, offset: number): string | undefined {
  const span = mapOffset(table, offset);
  if (span === undefined) return undefined;
  return spanText(sources[span.source], span);
}

Deno.test("a position inside a call maps to the span of that call", () => {
  const text = exampleModule("users").text;
  const table = tableOf("users");
  assertEquals(
    sourceTextAt(table, offsetOf(text, "Users.use(($s) => $s.find(id))")),
    "Users.find(id)",
  );
  assertEquals(
    sourceTextAt(table, offsetOf(text, "new UserMissing")),
    "UserMissing({ id })",
  );
});

Deno.test("a position in the frame of a declaration maps to the whole declaration", () => {
  const text = exampleModule("users").text;
  const table = tableOf("users");
  const mapped = sourceTextAt(table, offsetOf(text, "export const getUser"));
  assert(mapped !== undefined);
  assert(mapped.startsWith("export const getUser"));
  assert(mapped.endsWith("}"));
});

Deno.test("a position outside every record is not mapped", () => {
  const main = exampleModule("main");
  const table = tableOf("main");
  // The header comment, the imports, and the blank line between them.
  assertEquals(mapOffset(table, 0), undefined);
  assertEquals(mapOffset(table, offsetOf(main.text, "import {")), undefined);
  assertEquals(mapOffset(table, offsetOf(main.text, "\n\n") + 1), undefined);
  // The host assertion has no record: the host-boundary mapping handles it.
  assertEquals(
    mapOffset(table, offsetOf(main.text, "const UsersLive$host")),
    undefined,
  );
  // Past the end of the text.
  assertEquals(mapOffset(table, main.text.length + 5), undefined);
});

Deno.test("mapGenerated takes a one-based line and column", () => {
  const text = exampleModule("users").text;
  const table = tableOf("users");
  const offset = offsetOf(text, "new UserMissing");
  const position = positionOf(lineStarts(text), text, offset);
  assertEquals(
    mapGenerated(table, position.line, position.column),
    mapOffset(table, offset),
  );
  assertEquals(
    offsetOfGenerated(table, position.line, position.column),
    offset,
  );
  assertEquals(offsetOfGenerated(table, 1, 1), 0);
  assertEquals(mapGenerated(table, 0, 1), undefined);
  assertEquals(mapGenerated(table, 1, 0), undefined);
  assertEquals(mapGenerated(table, 100000, 1), undefined);
  assertEquals(mapGenerated(table, 1, 100000), undefined);
});

/** The innermost record by brute force: the smallest range, and of equal ranges the first to close. */
function bruteForce(module: EmittedModule, offset: number) {
  let best: (typeof module.spans)[number] | undefined;
  for (const record of module.spans) {
    if (offset < record.start || offset >= record.end) continue;
    if (
      best === undefined ||
      record.end - record.start < best.end - best.start
    ) {
      best = record;
    }
  }
  return best;
}

Deno.test("the innermost record wins at every offset of every example and form", () => {
  const modules = [...examples.emitted.values(), ...forms.emitted.values()];
  for (const module of modules) {
    const table = buildSpanTable(module);
    for (let offset = 0; offset <= module.text.length; offset++) {
      const expected = bruteForce(module, offset);
      const actual = recordAtOffset(table, offset);
      assertEquals(
        actual === undefined
          ? undefined
          : [actual.start, actual.end, actual.span],
        expected === undefined
          ? undefined
          : [expected.start, expected.end, expected.span],
        `${module.path} offset ${offset}`,
      );
    }
  }
});

Deno.test("records nest: two records are disjoint or one contains the other", () => {
  for (const module of examples.emitted.values()) {
    const records = buildSpanTable(module).records;
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i];
        const b = records[j];
        const disjoint = a.end <= b.start || b.end <= a.start;
        const nested = (a.start <= b.start && b.end <= a.end) ||
          (b.start <= a.start && a.end <= b.end);
        assert(disjoint || nested, `${module.path}: ${i} and ${j} overlap`);
      }
    }
  }
});

Deno.test("the table sorts outer records before inner records", () => {
  const table = tableOf("users");
  for (let i = 0; i < table.records.length; i++) {
    const parent = table.parents[i];
    if (parent < 0) continue;
    assert(parent < i, "a parent comes before its child");
    const outer = table.records[parent];
    const inner = table.records[i];
    assert(outer.start <= inner.start && inner.end <= outer.end);
  }
});

Deno.test("hostImportSpans names the imported provider in the .eff import", () => {
  const imports = hostImportSpans(examples.project);
  assertEquals([...imports.keys()], ["main"]);
  const span = imports.get("main")?.get("UsersLive");
  assert(span !== undefined);
  assertEquals(span.source, "main.eff");
  assertEquals(spanText(sources["main.eff"], span), "UsersLive");
});

Deno.test("a host assertion records its generated range and its import span", () => {
  const main = exampleModule("main");
  const table = tableOf("main");
  assertEquals(table.hostAssertions.length, 1);
  const assertion = table.hostAssertions[0];
  assertEquals(
    main.text.slice(assertion.start, assertion.end),
    "const UsersLive$host: Layer.Layer<Users> = UsersLive;",
  );
  assertEquals(assertion.name, "UsersLive$host");
  assertEquals(assertion.local, "UsersLive");
  assertEquals(assertion.key, "providers");
  assertEquals(
    assertion.importSpan,
    hostImportSpans(examples.project).get("main")?.get("UsersLive"),
  );
  assertEquals(tableOf("users").hostAssertions, []);
});

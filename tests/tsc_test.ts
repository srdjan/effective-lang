// Tests for part A6b: the parser of `deno check` output and the mapping of a
// TypeScript diagnostic back to the Effective source. The captured output
// texts are in fixtures/host-boundary/. They show the real format of
// `deno check` 2.9.7 for the wrong host module of that fixture.

import { assert, assertEquals } from "@std/assert";
import { DIAGNOSTIC_CODES } from "../src/core/diagnostics.ts";
import {
  buildSpanTable,
  hostImportSpans,
  type SpanTable,
} from "../src/core/emit/spans.ts";
import {
  mapTscDiagnostic,
  parseDenoCheck,
  type TscDiagnostic,
} from "../src/core/emit/tsc.ts";
import { lineStarts, positionOf, spanText } from "../src/core/source.ts";
import {
  emitFilesWithProject,
  EXAMPLE_ENTRIES,
  exampleFiles,
  FIXTURES,
  hostBoundaryManifest,
} from "./helpers.ts";

const ROOT = "/work/project";
const DIRECTORY = "host-boundary/users-live-missing-method/";

function captured(name: string): string {
  return Deno.readTextFileSync(new URL(`${DIRECTORY}${name}`, FIXTURES));
}

const examples = emitFilesWithProject(exampleFiles(), EXAMPLE_ENTRIES);
const sources = exampleFiles();

function tables(): ReadonlyMap<string, SpanTable> {
  const imports = hostImportSpans(examples.project);
  const result = new Map<string, SpanTable>();
  for (const [name, module] of examples.emitted) {
    result.set(module.path, buildSpanTable(module, imports.get(name)));
  }
  return result;
}

function diagnosticAt(
  file: string,
  line: number,
  column: number,
): TscDiagnostic {
  return { file, line, column, code: 2322, message: "message", detail: "" };
}

// ------------------------------------------------------------------ parsing

Deno.test("parseDenoCheck reads the diagnostic of a captured deno check run", () => {
  const output = parseDenoCheck(captured("deno-check.txt"), ROOT);
  assertEquals(output.other, []);
  assertEquals(output.diagnostics.length, 1);
  const found = output.diagnostics[0];
  assertEquals(found.file, "main.ts");
  assertEquals(found.line, 7);
  assertEquals(found.column, 7);
  assertEquals(found.code, 2375);
  assert(
    found.message.startsWith(
      "Type 'Layer<WrongUsers, never, never>' is not assignable to type 'Layer<Users, never, never>'",
    ),
    found.message,
  );
  // The detail holds the rest of the message, the source line, and its underline.
  assert(found.detail.includes("The types of 'Service.find' are incompatible"));
  assert(found.detail.includes("const UsersLive$host: Layer.Layer<Users>"));
  assert(found.detail.includes("~~~~~~~~~~~~~~"));
});

Deno.test("parseDenoCheck reads several diagnostics and drops the summary lines", () => {
  const output = parseDenoCheck(captured("deno-check-two.txt"), ROOT);
  assertEquals(output.other, []);
  assertEquals(
    output.diagnostics.map((d) => [d.file, d.line, d.column, d.code]),
    [["main.ts", 7, 7, 2375], ["users-live.ts", 21, 14, 2322]],
  );
  assertEquals(
    output.diagnostics[1].message,
    "Type 'string' is not assignable to type 'number'.",
  );
});

Deno.test("parseDenoCheck keeps the absolute path of a file outside the root", () => {
  const output = parseDenoCheck(
    "TS2304 [ERROR]: Cannot find name 'x'.\nx\n~\n    at file:///elsewhere/a%20b.ts:3:5\n",
    ROOT,
  );
  assertEquals(output.diagnostics.map((d) => [d.file, d.line, d.column]), [
    ["/elsewhere/a b.ts", 3, 5],
  ]);
});

Deno.test("parseDenoCheck drops the note after the first location of a diagnostic", () => {
  const text = [
    "Check main.ts",
    "TS2322 [ERROR]: Type 'a' is not assignable to type 'b'.",
    "const x: b = a;",
    "      ~",
    "    at file:///work/project/main.ts:2:7",
    "",
    "  'x' is declared here.",
    "    const x: b = a;",
    "          ~",
    "    at file:///work/project/main.ts:2:7",
    "",
    "Found 1 error.",
    "",
    "error: Type checking failed.",
    "",
  ].join("\n");
  const output = parseDenoCheck(text, ROOT);
  assertEquals(output.other, []);
  assertEquals(output.diagnostics.length, 1);
  assertEquals(output.diagnostics[0].file, "main.ts");
});

Deno.test("parseDenoCheck returns the lines it cannot read as other lines", () => {
  const output = parseDenoCheck(
    'Check main.ts\nerror: Module not found "file:///work/project/x.ts".\n    at file:///work/project/main.ts:1:8\n',
    ROOT,
  );
  assertEquals(output.diagnostics, []);
  assertEquals(output.other, [
    'error: Module not found "file:///work/project/x.ts".',
    "    at file:///work/project/main.ts:1:8",
  ]);
  assertEquals(parseDenoCheck("", ROOT), { diagnostics: [], other: [] });
});

// ------------------------------------------------------------------ mapping

Deno.test("host-boundary/001 is registered in its category", () => {
  assertEquals(DIAGNOSTIC_CODES["host-boundary/001"].category, "host-boundary");
});

Deno.test("a diagnostic on a host assertion maps to host-boundary/001 on the import", () => {
  const output = parseDenoCheck(captured("deno-check.txt"), ROOT);
  const mapped = mapTscDiagnostic(output.diagnostics[0], tables());
  assert(mapped.tag === "host-boundary", JSON.stringify(mapped));
  assertEquals(mapped.tsCode, 2375);
  const diagnostic = mapped.diagnostic;
  assertEquals(diagnostic.code, "host-boundary/001");
  assertEquals(diagnostic.category, "host-boundary");
  assertEquals(diagnostic.severity, "error");
  assertEquals(diagnostic.span.source, "main.eff");
  assertEquals(spanText(sources["main.eff"], diagnostic.span), "UsersLive");
  assert(diagnostic.message.includes("providers"));
  assert(diagnostic.message.includes("TS2375"));
});

Deno.test("every position of the host assertion maps to host-boundary/001", () => {
  const table = tables().get("main.ts");
  assert(table !== undefined);
  const text = examples.emitted.get("main")?.text ?? "";
  const assertion = table.hostAssertions[0];
  const starts = lineStarts(text);
  for (let offset = assertion.start; offset < assertion.end; offset++) {
    const position = positionOf(starts, text, offset);
    const mapped = mapTscDiagnostic(
      diagnosticAt("main.ts", position.line, position.column),
      tables(),
    );
    assertEquals(mapped.tag, "host-boundary", `offset ${offset}`);
  }
});

Deno.test("a diagnostic inside a printed node maps to its source span", () => {
  const text = examples.emitted.get("users")?.text ?? "";
  const offset = text.indexOf("new UserMissing");
  const position = positionOf(lineStarts(text), text, offset);
  const mapped = mapTscDiagnostic(
    diagnosticAt("users.ts", position.line, position.column),
    tables(),
  );
  assert(mapped.tag === "source", JSON.stringify(mapped));
  assertEquals(mapped.tsCode, 2322);
  assertEquals(
    spanText(sources["users.eff"], mapped.span),
    "UserMissing({ id })",
  );
});

Deno.test("a diagnostic outside every record or in an unknown file keeps its generated position", () => {
  // Line 3 of main.ts is an import of the generated file.
  const inImports = mapTscDiagnostic(diagnosticAt("main.ts", 3, 2), tables());
  assertEquals(inImports, {
    tag: "generated",
    file: "main.ts",
    line: 3,
    column: 2,
    tsCode: 2322,
    message: "message",
  });
  const inHost = mapTscDiagnostic(
    diagnosticAt("users-live.ts", 21, 14),
    tables(),
  );
  assertEquals(inHost.tag, "generated");
  const pastEnd = mapTscDiagnostic(diagnosticAt("main.ts", 999, 1), tables());
  assertEquals(pastEnd.tag, "generated");
});

Deno.test("a host assertion without an import span is not reported as host-boundary", () => {
  const module = examples.emitted.get("main");
  assert(module !== undefined);
  const bare = new Map([["main.ts", buildSpanTable(module)]]);
  const assertion = bare.get("main.ts")?.hostAssertions[0];
  assert(assertion !== undefined);
  const position = positionOf(
    lineStarts(module.text),
    module.text,
    assertion.start,
  );
  const mapped = mapTscDiagnostic(
    diagnosticAt("main.ts", position.line, position.column),
    bare,
  );
  assertEquals(mapped.tag, "generated");
});

Deno.test("the host-boundary manifest names the import span in main.eff", () => {
  const fixtures = hostBoundaryManifest();
  assertEquals(fixtures.length, 1);
  for (const fixture of fixtures) {
    assertEquals(fixture.code, "host-boundary/001");
    const host = Deno.statSync(
      new URL(`host-boundary/${fixture.directory}/${fixture.host}`, FIXTURES),
    );
    assert(host.isFile);
    const span = hostImportSpans(examples.project).get("main")?.get(
      fixture.expected.text,
    );
    assert(span !== undefined);
    assertEquals(span.source, fixture.expected.source);
    const text = sources[fixture.expected.source];
    const position = positionOf(lineStarts(text), text, span.start);
    assertEquals(
      [position.line, position.column],
      [fixture.expected.line, fixture.expected.column],
    );
    assertEquals(spanText(text, span), fixture.expected.text);
  }
});

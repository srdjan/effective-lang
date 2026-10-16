import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_INITIALIZATION_OPTIONS,
  FileChangeType,
  narrowDidChange,
  narrowDidChangeWatchedFiles,
  narrowDidOpen,
  narrowInitializeParams,
  narrowPositionParams,
  narrowTextDocumentParams,
  SERVER_CAPABILITIES,
  TextDocumentSyncKind,
} from "../src/lsp/protocol.ts";
import {
  GENERATED_CHANGED_METHOD,
  GENERATED_SCHEME,
  GENERATED_TYPESCRIPT_METHOD,
  STATS_METHOD,
} from "../src/lsp/methods.ts";

const URI = "file:///tmp/p/main.eff";

function assertRejected(
  result: { readonly ok: boolean; readonly error?: string },
  fragment: string,
): void {
  assert(!result.ok, "expected an error");
  assert(
    typeof result.error === "string" && result.error.includes(fragment),
    `error ${JSON.stringify(result.error)} lacks ${JSON.stringify(fragment)}`,
  );
}

Deno.test("method names and capabilities", () => {
  assertEquals(GENERATED_TYPESCRIPT_METHOD, "effective/generatedTypeScript");
  assertEquals(GENERATED_CHANGED_METHOD, "effective/generatedChanged");
  assertEquals(STATS_METHOD, "effective/stats");
  assertEquals(GENERATED_SCHEME, "effective-generated");
  assertEquals(TextDocumentSyncKind.Incremental, 2);
  assertEquals(SERVER_CAPABILITIES.positionEncoding, "utf-16");
  assertEquals(SERVER_CAPABILITIES.textDocumentSync.change, 2);
  assertEquals(SERVER_CAPABILITIES.textDocumentSync.save, {
    includeText: false,
  });
});

Deno.test("initialize: valid options", () => {
  assertEquals(
    narrowInitializeParams({
      processId: 1,
      initializationOptions: { debounceMs: 50, writeOnSave: false, extra: 1 },
    }),
    {
      ok: true,
      value: { options: { debounceMs: 50, writeOnSave: false }, warnings: [] },
    },
  );
  const zero = narrowInitializeParams({
    initializationOptions: { debounceMs: 0, writeOnSave: true },
  });
  assertEquals(zero.ok && zero.value.options, DEFAULT_INITIALIZATION_OPTIONS);
});

Deno.test("initialize: missing options give the defaults and no warning", () => {
  for (const params of [{}, { initializationOptions: null }]) {
    assertEquals(narrowInitializeParams(params), {
      ok: true,
      value: { options: { debounceMs: 0, writeOnSave: true }, warnings: [] },
    });
  }
});

Deno.test("initialize: invalid option values give defaults and one warning each", () => {
  const result = narrowInitializeParams({
    initializationOptions: { debounceMs: -1, writeOnSave: "yes" },
  });
  assert(result.ok);
  assertEquals(result.value.options, { debounceMs: 0, writeOnSave: true });
  assertEquals(result.value.warnings.length, 2);
  assert(result.value.warnings[0].includes("debounceMs"));
  assert(result.value.warnings[1].includes("writeOnSave"));

  for (const bad of [Infinity, NaN, "10", null, {}]) {
    const r = narrowInitializeParams({
      initializationOptions: { debounceMs: bad },
    });
    assert(r.ok);
    assertEquals(r.value.options.debounceMs, 0);
    assertEquals(r.value.warnings.length, 1, String(bad));
  }

  const keeps = narrowInitializeParams({
    initializationOptions: { debounceMs: 25, writeOnSave: 1 },
  });
  assert(keeps.ok);
  assertEquals(keeps.value.options, { debounceMs: 25, writeOnSave: true });
  assertEquals(keeps.value.warnings.length, 1);
});

Deno.test("initialize: options that are not an object give defaults and a warning", () => {
  const result = narrowInitializeParams({ initializationOptions: "fast" });
  assert(result.ok);
  assertEquals(result.value.options, DEFAULT_INITIALIZATION_OPTIONS);
  assertEquals(result.value.warnings.length, 1);
});

Deno.test("initialize: params that are not an object are an error", () => {
  for (const params of [undefined, null, 3, [], "x"]) {
    assertRejected(narrowInitializeParams(params), "params must be an object");
  }
});

Deno.test("didOpen: valid and invalid", () => {
  assertEquals(
    narrowDidOpen({
      textDocument: {
        uri: URI,
        languageId: "effective",
        version: 1,
        text: "x",
      },
    }),
    {
      ok: true,
      value: {
        textDocument: {
          uri: URI,
          languageId: "effective",
          version: 1,
          text: "x",
        },
      },
    },
  );
  const item = { uri: URI, languageId: "effective", version: 1, text: "" };
  assertRejected(narrowDidOpen(undefined), "params");
  assertRejected(narrowDidOpen({}), "textDocument");
  assertRejected(narrowDidOpen({ textDocument: { ...item, uri: "" } }), "uri");
  assertRejected(
    narrowDidOpen({ textDocument: { ...item, version: "1" } }),
    "version",
  );
  assertRejected(
    narrowDidOpen({ textDocument: { ...item, version: 1.5 } }),
    "version",
  );
  assertRejected(narrowDidOpen({ textDocument: { ...item, text: 5 } }), "text");
  assertRejected(
    narrowDidOpen({ textDocument: { ...item, languageId: 1 } }),
    "languageId",
  );
});

Deno.test("didChange: ranged and full-text events", () => {
  const range = {
    start: { line: 0, character: 1 },
    end: { line: 2, character: 0 },
  };
  assertEquals(
    narrowDidChange({
      textDocument: { uri: URI, version: 4 },
      contentChanges: [{ range, rangeLength: 3, text: "a" }, { text: "whole" }],
    }),
    {
      ok: true,
      value: {
        textDocument: { uri: URI, version: 4 },
        contentChanges: [{ range, text: "a" }, { text: "whole" }],
      },
    },
  );
  const empty = narrowDidChange({
    textDocument: { uri: URI, version: 4 },
    contentChanges: [],
  });
  assert(empty.ok && empty.value.contentChanges.length === 0);
});

Deno.test("didChange: invalid shapes", () => {
  const document = { uri: URI, version: 1 };
  const ok = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  assertRejected(narrowDidChange(null), "params");
  assertRejected(narrowDidChange({ contentChanges: [] }), "textDocument");
  assertRejected(
    narrowDidChange({ textDocument: { uri: URI }, contentChanges: [] }),
    "version",
  );
  assertRejected(narrowDidChange({ textDocument: document }), "contentChanges");
  assertRejected(
    narrowDidChange({ textDocument: document, contentChanges: {} }),
    "contentChanges",
  );
  assertRejected(
    narrowDidChange({ textDocument: document, contentChanges: [1] }),
    "contentChanges[0]",
  );
  assertRejected(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{ range: ok }],
    }),
    "text",
  );
  assertRejected(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{ text: "", range: { start: ok.start } }],
    }),
    "contentChanges[0].range.end",
  );
  assertRejected(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{
        text: "",
        range: { start: { line: -1, character: 0 }, end: ok.end },
      }],
    }),
    "line",
  );
});

Deno.test("text document params serve didSave, didClose, documentSymbol, and the custom requests", () => {
  assertEquals(narrowTextDocumentParams({ textDocument: { uri: URI } }), {
    ok: true,
    value: { textDocument: { uri: URI } },
  });
  assertEquals(
    narrowTextDocumentParams({ textDocument: { uri: URI }, text: "saved" }),
    { ok: true, value: { textDocument: { uri: URI } } },
  );
  assertRejected(narrowTextDocumentParams(undefined), "params");
  assertRejected(narrowTextDocumentParams({}), "textDocument");
  assertRejected(narrowTextDocumentParams({ textDocument: {} }), "uri");
  assertRejected(narrowTextDocumentParams({ textDocument: { uri: 3 } }), "uri");
});

Deno.test("position params serve hover and definition", () => {
  assertEquals(
    narrowPositionParams({
      textDocument: { uri: URI },
      position: { line: 3, character: 7 },
    }),
    {
      ok: true,
      value: {
        textDocument: { uri: URI },
        position: { line: 3, character: 7 },
      },
    },
  );
  const textDocument = { uri: URI };
  assertRejected(narrowPositionParams(null), "params");
  assertRejected(
    narrowPositionParams({ position: { line: 0, character: 0 } }),
    "textDocument",
  );
  assertRejected(narrowPositionParams({ textDocument }), "position");
  assertRejected(
    narrowPositionParams({ textDocument, position: { line: 0 } }),
    "character",
  );
  assertRejected(
    narrowPositionParams({
      textDocument,
      position: { line: "0", character: 0 },
    }),
    "line",
  );
  assertRejected(
    narrowPositionParams({
      textDocument,
      position: { line: 0.5, character: 0 },
    }),
    "line",
  );
  assertRejected(
    narrowPositionParams({
      textDocument,
      position: { line: 0, character: -2 },
    }),
    "character",
  );
});

Deno.test("didChangeWatchedFiles: types 1, 2, and 3", () => {
  assertEquals(
    narrowDidChangeWatchedFiles({
      changes: [
        { uri: URI, type: FileChangeType.Created },
        { uri: URI, type: FileChangeType.Changed },
        { uri: URI, type: FileChangeType.Deleted },
      ],
    }),
    {
      ok: true,
      value: {
        changes: [
          { uri: URI, type: 1 },
          { uri: URI, type: 2 },
          { uri: URI, type: 3 },
        ],
      },
    },
  );
  assertEquals(narrowDidChangeWatchedFiles({ changes: [] }), {
    ok: true,
    value: { changes: [] },
  });
  assertRejected(narrowDidChangeWatchedFiles(undefined), "params");
  assertRejected(narrowDidChangeWatchedFiles({}), "changes");
  assertRejected(
    narrowDidChangeWatchedFiles({ changes: [null] }),
    "changes[0]",
  );
  assertRejected(
    narrowDidChangeWatchedFiles({ changes: [{ type: 1 }] }),
    "uri",
  );
  assertRejected(
    narrowDidChangeWatchedFiles({ changes: [{ uri: URI, type: 4 }] }),
    "type",
  );
  assertRejected(
    narrowDidChangeWatchedFiles({ changes: [{ uri: URI, type: "1" }] }),
    "type",
  );
});

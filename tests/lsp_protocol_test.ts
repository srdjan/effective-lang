import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_INITIALIZATION_OPTIONS,
  FileChangeType,
  narrowCodeActionParams,
  narrowDidChange,
  narrowDidChangeWatchedFiles,
  narrowDidOpen,
  narrowEditorPositionParams,
  narrowInitializeParams,
  narrowPositionParams,
  narrowReferencesParams,
  narrowRenameParams,
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
  assertEquals(GENERATED_TYPESCRIPT_METHOD, "effektive/generatedTypeScript");
  assertEquals(GENERATED_CHANGED_METHOD, "effektive/generatedChanged");
  assertEquals(STATS_METHOD, "effektive/stats");
  assertEquals(GENERATED_SCHEME, "effektive-generated");
  assertEquals(TextDocumentSyncKind.Incremental, 2);
  assertEquals(SERVER_CAPABILITIES.positionEncoding, "utf-16");
  assertEquals(SERVER_CAPABILITIES.inlayHintProvider, true);
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
        languageId: "effektive",
        version: 1,
        text: "x",
      },
    }),
    {
      ok: true,
      value: {
        textDocument: {
          uri: URI,
          languageId: "effektive",
          version: 1,
          text: "x",
        },
      },
    },
  );
  const item = { uri: URI, languageId: "effektive", version: 1, text: "" };
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

// ------------------------------------------------------------------ exact messages

// Exact error messages of the incoming-params narrowers in src/lsp/protocol.ts.
// The tests above check fragments only. A change of the message text or of the
// path text reaches a client as a JSON-RPC error (-32602), so the tests below
// pin the whole text for one case of each primitive check: object, non-empty
// string, string, integer, non-negative integer, array, and the literal set of
// a file change type. They also pin the order of the checks.

const POSITION = { line: 0, character: 0 };
const RANGE = { start: POSITION, end: POSITION };

/** Requires the exact error text of a rejected value. */
function assertError(
  result: { readonly ok: boolean; readonly error?: string },
  message: string,
): void {
  assertEquals(result.ok, false, message);
  assertEquals(result.error, message);
}

const item = (over: Record<string, unknown>) => ({
  textDocument: {
    uri: URI,
    languageId: "effektive",
    version: 1,
    text: "x",
    ...over,
  },
});

Deno.test("each primitive check of the narrowers gives its exact message", () => {
  // The params record.
  assertError(
    narrowDidOpen(3),
    "textDocument/didOpen: params must be an object",
  );
  assertError(
    narrowDidChange([]),
    "textDocument/didChange: params must be an object",
  );
  assertError(
    narrowTextDocumentParams(null),
    "request: params must be an object",
  );
  assertError(narrowPositionParams("x"), "request: params must be an object");
  assertError(
    narrowDidChangeWatchedFiles(undefined),
    "workspace/didChangeWatchedFiles: params must be an object",
  );
  assertError(
    narrowInitializeParams(7),
    "initialize: params must be an object",
  );
  // An object.
  assertError(narrowDidOpen({}), "textDocument must be an object");
  assertError(
    narrowTextDocumentParams({ textDocument: [] }),
    "textDocument must be an object",
  );
  // A non-empty string.
  assertError(
    narrowDidOpen(item({ uri: "" })),
    "textDocument.uri must be a non-empty string",
  );
  assertError(
    narrowTextDocumentParams({ textDocument: { uri: 3 } }),
    "textDocument.uri must be a non-empty string",
  );
  // A string.
  assertError(
    narrowDidOpen(item({ languageId: 1 })),
    "textDocument.languageId must be a string",
  );
  assertError(
    narrowDidOpen(item({ text: null })),
    "textDocument.text must be a string",
  );
  // An integer.
  assertError(
    narrowDidOpen(item({ version: 1.5 })),
    "textDocument.version must be an integer",
  );
  // A non-negative integer.
  assertError(
    narrowPositionParams({
      textDocument: { uri: URI },
      position: { line: -1, character: 0 },
    }),
    "position.line must be a non-negative integer",
  );
  assertError(
    narrowPositionParams({
      textDocument: { uri: URI },
      position: { line: 0, character: "0" },
    }),
    "position.character must be a non-negative integer",
  );
  // An array.
  assertError(
    narrowDidChange({
      textDocument: { uri: URI, version: 1 },
      contentChanges: {},
    }),
    "contentChanges must be an array",
  );
  assertError(
    narrowDidChangeWatchedFiles({ changes: "none" }),
    "changes must be an array",
  );
  // The literal set of a file change type.
  assertError(
    narrowDidChangeWatchedFiles({ changes: [{ uri: URI, type: 4 }] }),
    "changes[0].type must be 1, 2, or 3",
  );
});

Deno.test("an error names the path of the nested value", () => {
  const document = { uri: URI, version: 1 };
  assertError(
    narrowDidChange({ textDocument: document, contentChanges: [3] }),
    "contentChanges[0] must be an object",
  );
  assertError(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{ text: "a" }, { text: 1 }],
    }),
    "contentChanges[1].text must be a string",
  );
  assertError(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{ text: "a", range: 1 }],
    }),
    "contentChanges[0].range must be an object",
  );
  assertError(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{
        text: "a",
        range: { start: POSITION, end: { line: 1, character: 1.5 } },
      }],
    }),
    "contentChanges[0].range.end.character must be a non-negative integer",
  );
  assertError(
    narrowDidChange({
      textDocument: document,
      contentChanges: [{ text: "a", range: { start: null, end: POSITION } }],
    }),
    "contentChanges[0].range.start must be an object",
  );
  assertError(
    narrowDidChangeWatchedFiles({ changes: [null] }),
    "changes[0] must be an object",
  );
  assertError(
    narrowDidChangeWatchedFiles({ changes: [{ uri: 5, type: 1 }] }),
    "changes[0].uri must be a non-empty string",
  );
});

Deno.test("the first failing check in field order gives the message", () => {
  // Both the uri and the version are wrong: the uri comes first.
  assertError(
    narrowDidChange({
      textDocument: { uri: "", version: "x" },
      contentChanges: 1,
    }),
    "textDocument.uri must be a non-empty string",
  );
  // The version is wrong and the changes are wrong: the version comes first.
  assertError(
    narrowDidChange({
      textDocument: { uri: URI, version: "x" },
      contentChanges: 1,
    }),
    "textDocument.version must be an integer",
  );
  // The text document is wrong and the position is wrong: the document comes first.
  assertError(
    narrowPositionParams({ textDocument: { uri: "" }, position: 3 }),
    "textDocument.uri must be a non-empty string",
  );
  // The uri and the type of a change are wrong: the uri comes first.
  assertError(
    narrowDidChangeWatchedFiles({ changes: [{ uri: "", type: 9 }] }),
    "changes[0].uri must be a non-empty string",
  );
});

Deno.test("valid params ignore unknown keys, and an absent range stays absent", () => {
  const changed = narrowDidChange({
    extra: true,
    textDocument: { uri: URI, version: 2, extra: 1 },
    contentChanges: [{ text: "a" }, { text: "b", range: RANGE, extra: 1 }],
  });
  assert(changed.ok);
  assertEquals(changed.value, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: "a" }, { text: "b", range: RANGE }],
  });
  assertEquals("range" in changed.value.contentChanges[0], false);
});

Deno.test("an invalid option gives its exact warning and the default", () => {
  const result = narrowInitializeParams({
    initializationOptions: { debounceMs: -1, writeOnSave: "yes" },
  });
  assert(result.ok);
  assertEquals(result.value.warnings, [
    "initializationOptions.debounceMs must be a finite number of at least 0; using 0",
    "initializationOptions.writeOnSave must be a boolean; using true",
  ]);
  const notObject = narrowInitializeParams({ initializationOptions: 4 });
  assert(notObject.ok);
  assertEquals(notObject.value.warnings, [
    "initializationOptions must be an object; using the defaults",
  ]);
});

Deno.test("editor params check position before optional version and request fields", () => {
  const invalid = {
    textDocument: { uri: URI, version: "old" },
    position: { line: -1, character: 0 },
    context: null,
    newName: null,
  };
  for (
    const narrow of [
      narrowEditorPositionParams,
      narrowReferencesParams,
      narrowRenameParams,
    ]
  ) {
    assertError(
      narrow(invalid),
      "position.line must be a non-negative integer",
    );
    assertError(
      narrow({ ...invalid, position: POSITION }),
      "textDocument.version must be an integer",
    );
  }
  const validPosition = { textDocument: { uri: URI }, position: POSITION };
  for (const context of [undefined, null, {}, { includeDeclaration: "yes" }]) {
    assertError(
      narrowReferencesParams({ ...validPosition, context }),
      "context.includeDeclaration must be a boolean",
    );
  }
  assertError(narrowRenameParams(validPosition), "newName must be a string");
  assertError(
    narrowCodeActionParams({ textDocument: { uri: "" }, range: null }),
    "textDocument.uri must be a non-empty string",
  );
  assertError(
    narrowCodeActionParams({ textDocument: { uri: URI }, range: null }),
    "range must be an object",
  );
});

Deno.test("editor params omit absent versions and preserve explicit integer versions", () => {
  const position = { textDocument: { uri: URI }, position: POSITION };
  for (const textDocument of [{ uri: URI }, { uri: URI, version: undefined }]) {
    assertEquals(narrowEditorPositionParams({ ...position, textDocument }), {
      ok: true,
      value: position,
    });
  }
  assertEquals(
    narrowReferencesParams({
      ...position,
      textDocument: { uri: URI, version: -1 },
      context: { includeDeclaration: false, extra: true },
    }),
    {
      ok: true,
      value: { ...position, documentVersion: -1, includeDeclaration: false },
    },
  );
  assertEquals(narrowRenameParams({ ...position, newName: "" }), {
    ok: true,
    value: { ...position, newName: "" },
  });
  assertEquals(
    narrowCodeActionParams({
      textDocument: { uri: URI },
      range: RANGE,
      context: null,
    }),
    {
      ok: true,
      value: { textDocument: { uri: URI }, range: RANGE },
    },
  );
});

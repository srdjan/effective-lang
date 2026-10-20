// Exact error messages of the incoming-params narrowers in src/lsp/protocol.ts.
// tests/lsp_protocol_test.ts checks fragments only. A change of the message
// text or of the path text reaches a client as a JSON-RPC error (-32602), so
// this file pins the whole text for one case of each primitive check: object,
// non-empty string, string, integer, non-negative integer, array, and the
// literal set of a file change type. It also pins the order of the checks.

import { assert, assertEquals } from "@std/assert";
import {
  narrowDidChange,
  narrowDidChangeWatchedFiles,
  narrowDidOpen,
  narrowInitializeParams,
  narrowPositionParams,
  narrowTextDocumentParams,
} from "../src/lsp/protocol.ts";

const URI = "file:///tmp/p/main.eff";
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
    languageId: "effective",
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

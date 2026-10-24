import { assert, assertEquals } from "@std/assert";
import { lineStarts } from "../src/core/source.ts";
import { offsetToPosition } from "../src/lsp/positions.ts";
import { type Harness, makeHarness, uriOf } from "./lsp_helpers.ts";

const root = "/work/editor";
const lib =
  "type Count = int\nexport const twice = (value: Count): Count => value + value\n";
const main =
  'import { twice } from "./lib.eff"\ntype Count = int\nexport const use = (value: Count): Count => twice(value)\n';
const uri = uriOf(`${root}/m.eff`);
function harness(): Harness {
  const h = makeHarness({
    files: {
      [`${root}/effektive.json`]: "{}",
      [`${root}/lib.eff`]: lib,
      [`${root}/m.eff`]: main,
    },
  });
  h.start();
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "effektive", version: 7, text: main },
    },
  });
  return h;
}
function record(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function list(value: unknown): readonly unknown[] {
  assert(Array.isArray(value));
  return value;
}
let id = 0;
function request(h: Harness, method: string, params: unknown): unknown {
  const requestId = ++id;
  h.deliver({ jsonrpc: "2.0", id: requestId, method, params });
  const response = h.responses(requestId)[0];
  assert(response !== undefined);
  return "result" in response ? response.result : response;
}
const position = (text: string, word: string, delta = 0) =>
  offsetToPosition(text, lineStarts(text), text.indexOf(word) + delta);

Deno.test("LSP references and rename use current unsaved UTF-16 text and version every open document", () => {
  const h = harness();
  const libUri = uriOf(`${root}/lib.eff`);
  const overlay = lib.replace("export const", "/* 😀 */ export const");
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: libUri,
        languageId: "effektive",
        version: 9,
        text: overlay,
      },
    },
  });
  const params = { textDocument: { uri }, position: position(main, "twice") };
  const refs = list(
    request(h, "textDocument/references", {
      ...params,
      context: { includeDeclaration: true },
    }),
  );
  assertEquals(refs.length, 3);
  assertEquals(
    list(
      request(h, "textDocument/references", {
        ...params,
        context: { includeDeclaration: false },
      }),
    ).length,
    2,
  );
  const prepared = record(request(h, "textDocument/prepareRename", params));
  assertEquals(prepared.placeholder, "twice");
  const edited = record(
    request(h, "textDocument/rename", { ...params, newName: "double" }),
  );
  const changes = list(edited.documentChanges).map(record);
  assertEquals(changes.length, 2);
  assertEquals(changes.map((c) => record(c.textDocument).version).sort(), [
    7,
    9,
  ]);
  const libraryChange = changes.find((c) =>
    record(c.textDocument).uri === libUri
  );
  assert(libraryChange !== undefined);
  const edit = record(list(libraryChange.edits)[0]);
  assertEquals(record(record(edit.range).start).character, 22);
});

Deno.test("LSP rejects stale edit requests and ignores out-of-order document changes", () => {
  const h = harness();
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 6 },
      contentChanges: [{ text: "broken" }],
    },
  });
  const stale = record(
    request(h, "textDocument/rename", {
      textDocument: { uri, version: 6 },
      position: position(main, "twice"),
      newName: "double",
    }),
  );
  assertEquals(record(stale.error).code, -32801);
  assert(
    record(
      request(h, "textDocument/prepareRename", {
        textDocument: { uri, version: 7 },
        position: position(main, "twice"),
      }),
    ).placeholder === "twice",
  );
  h.files.set(`${root}/lib.eff`, lib + "\n");
  const disk = record(
    request(h, "textDocument/rename", {
      textDocument: { uri },
      position: position(main, "twice"),
      newName: "double",
    }),
  );
  assertEquals(record(disk.error).code, -32801);
  h.files.set(`${root}/lib.eff`, lib);
  h.files.set(`${root}/effektive.json`, "{ ");
  const config = record(
    request(h, "textDocument/rename", {
      textDocument: { uri },
      position: position(main, "twice"),
      newName: "double",
    }),
  );
  assertEquals(record(config.error).code, -32801);
});

Deno.test("LSP completion and full semantic tokens recover after malformed unsaved edits", () => {
  const h = harness();
  const text =
    "type Count = int\ntype R = { first: Count, second: Count }\nexport const read = (value: R): Count => value.fi\n// 😀 comment\n";
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 8 }, contentChanges: [{ text }] },
  });
  const completions = record(
    request(h, "textDocument/completion", {
      textDocument: { uri },
      position: position(text, "value.fi", 8),
    }),
  );
  assertEquals(list(completions.items).map((i) => record(i).label), ["first"]);
  const tokens = list(
    record(
      request(h, "textDocument/semanticTokens/full", { textDocument: { uri } }),
    ).data,
  );
  assert(tokens.length > 0 && tokens.length % 5 === 0);
  assert(tokens.every((n) => typeof n === "number" && n >= 0));
  const bad = request(h, "textDocument/rename", {
    textDocument: { uri },
    position: position(text, "first"),
    newName: "renamed",
  });
  assert("error" in record(bad));
});

Deno.test("LSP maps sealed completion to the keyword kind", () => {
  const h = harness();
  const text = "export sea\n";
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 8 }, contentChanges: [{ text }] },
  });
  const completions = record(
    request(h, "textDocument/completion", {
      textDocument: { uri },
      position: position(text, "sea", 3),
    }),
  );
  const sealed = list(completions.items).map(record).find((item) =>
    item.label === "sealed"
  );
  assertEquals(sealed?.kind, 14);
});

Deno.test("LSP missing-effect actions return validated versioned source edits", () => {
  const h = harness();
  const text =
    "type Count = int\nerror Failed = {}\nservice Clock { now(): Count fails Failed }\nexport const run = (): Count => Clock.now()\n";
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 8 }, contentChanges: [{ text }] },
  });
  const p = position(text, "export const run");
  const actions = list(
    request(h, "textDocument/codeAction", {
      textDocument: { uri },
      range: { start: p, end: p },
      context: { diagnostics: [] },
    }),
  );
  assertEquals(actions.length, 1);
  const action = record(actions[0]);
  assertEquals(action.title, "Add missing fails and uses entries");
  const changes = list(record(action.edit).documentChanges).map(record);
  assertEquals(record(changes[0].textDocument), { uri, version: 8 });
  assert(
    list(changes[0].edits).every((e) =>
      record(e).newText === "fails Failed uses Clock.now "
    ),
  );
});

Deno.test("new editor methods validate request parameters", () => {
  const h = harness();
  for (
    const [method, params] of [
      ["textDocument/rename", {
        textDocument: { uri },
        position: { line: 0, character: 0 },
        newName: 2,
      }],
      ["textDocument/references", {
        textDocument: { uri },
        position: { line: 0, character: 0 },
        context: { includeDeclaration: "yes" },
      }],
      ["textDocument/codeAction", { textDocument: { uri }, range: 3 }],
    ] as const
  ) assertEquals(record(record(request(h, method, params)).error).code, -32602);
});

Deno.test("editor edits are withheld while project configuration is invalid", () => {
  const h = harness();
  h.files.set(`${root}/effektive.json`, "{");
  h.deliver({
    jsonrpc: "2.0",
    method: "workspace/didChangeWatchedFiles",
    params: { changes: [{ uri: uriOf(`${root}/effektive.json`), type: 2 }] },
  });
  const params = {
    textDocument: { uri },
    position: position(main, "twice"),
    newName: "changed",
  };
  assertEquals(
    record(record(request(h, "textDocument/rename", params)).error).code,
    -32801,
  );
  const p = position(main, "use =");
  assertEquals(
    request(h, "textDocument/codeAction", {
      textDocument: { uri },
      range: { start: p, end: p },
      context: { diagnostics: [] },
    }),
    [],
  );
});

Deno.test("LSP answers inlay hints with UTF-16 positions", () => {
  const text =
    'import { Int, S } from "./lib.eff"\n// 😀\nconst open = (x: Int) => { S.read() + x }\nexport const shown = (x: Int): Int uses S.read => S.read() + x\n';
  const h = makeHarness({
    files: {
      [`${root}/effektive.json`]: "{}",
      [`${root}/lib.eff`]:
        "export type Int = int\nexport error Stop = {}\nexport service S { read(): Int fails Stop }\n",
      [`${root}/m.eff`]: text,
    },
  });
  h.start();
  h.deliver({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "effektive", version: 1, text },
    },
  });
  const hints = list(
    request(h, "textDocument/inlayHint", {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 4, character: 0 },
      },
    }),
  ).map(record);
  assertEquals(hints.length, 1);
  assertEquals(hints[0].label, " fails Stop uses S.read");
  assertEquals(hints[0].position, { line: 2, character: 21 });
  assertEquals(hints[0].paddingLeft, false);
});

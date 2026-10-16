// Fast tests of the language server (plan L3a), driven in process through the
// harness: lifecycle, protocol edge cases, the overlay, diagnostics, scheduling.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ErrorCodes, type ResponseMessage } from "../src/lsp/jsonrpc.ts";
import { SERVER_CAPABILITIES } from "../src/lsp/protocol.ts";
import type { PublishDiagnosticsParams } from "../src/lsp/protocol.ts";
import { type RequestHandler, withParams } from "../src/lsp/server.ts";
import {
  didChangeFull,
  didClose,
  didOpen,
  exampleFiles,
  exampleFilesAt,
  exampleUri,
  type Harness,
  makeHarness,
  notification,
  request,
  ROOT,
  uriOf,
  watched,
} from "./lsp_helpers.ts";
import { narrowTextDocumentParams } from "../src/lsp/protocol.ts";

const MAIN = exampleUri("main.eff");
const USERS = exampleUri("users.eff");
const MAIN_TEXT = exampleFiles()["main.eff"];
const USERS_TEXT = exampleFiles()["users.eff"];
/** `main.eff` with a wrong argument type: an error in the open document. */
const MAIN_BROKEN = MAIN_TEXT.replace('displayName("u1")', "displayName(1)");
/** `users.eff` without `displayName`: `main.eff` fails to import it. */
const USERS_BROKEN = USERS_TEXT.replace(
  "export const displayName",
  "export const displayNameX",
);

function started(options?: unknown): Harness {
  const h = makeHarness();
  h.start(options);
  return h;
}

function result(message: ResponseMessage): unknown {
  assert("result" in message, JSON.stringify(message));
  return message.result;
}

function errorCode(message: ResponseMessage | undefined): number {
  assert(message !== undefined && "error" in message, JSON.stringify(message));
  return message.error.code;
}

function uris(list: readonly PublishDiagnosticsParams[]): string[] {
  return list.map((p) => p.uri);
}

function summary(
  p: PublishDiagnosticsParams,
): [string, number | undefined, number] {
  return [p.uri, p.version, p.diagnostics.length];
}

/** The range of the first `needle` in `text`, as an LSP range on one line. */
function rangeOf(text: string, needle: string) {
  const offset = text.indexOf(needle);
  assert(offset >= 0, needle);
  const before = text.slice(0, offset).split("\n");
  const line = before.length - 1;
  const character = before[line].length;
  return {
    start: { line, character },
    end: { line, character: character + needle.length },
  };
}

// ---- Lifecycle --------------------------------------------------------------

Deno.test("a request before initialize gets -32002", () => {
  const h = makeHarness();
  h.deliver(request(1, "textDocument/hover", {}), request(2, "shutdown"));
  assertEquals(errorCode(h.responses(1)[0]), ErrorCodes.serverNotInitialized);
  assertEquals(errorCode(h.responses(2)[0]), ErrorCodes.serverNotInitialized);
});

Deno.test("a notification before initialize is dropped, but exit counts", () => {
  const h = makeHarness();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.sent, []);
  assertEquals(h.server.projects.projects().length, 0);
  h.deliver(notification("exit"));
  assertEquals(h.exits, [1]);
});

Deno.test("initialize returns the capabilities and the server name", () => {
  const h = makeHarness();
  h.deliver(request(1, "initialize", { capabilities: {} }));
  assertEquals(result(h.responses(1)[0]), {
    capabilities: SERVER_CAPABILITIES,
    serverInfo: { name: "effective" },
  });
  assertEquals(h.logs(), []);
});

Deno.test("a second initialize gets -32600", () => {
  const h = started();
  h.deliver(request(5, "initialize", {}));
  assertEquals(errorCode(h.responses(5)[0]), ErrorCodes.invalidRequest);
});

Deno.test("initialize with params that are not an object gets -32602", () => {
  const h = makeHarness();
  h.deliver(request(1, "initialize", 5));
  assertEquals(errorCode(h.responses(1)[0]), ErrorCodes.invalidParams);
  // The server is still uninitialized.
  h.deliver(request(2, "foo"));
  assertEquals(errorCode(h.responses(2)[0]), ErrorCodes.serverNotInitialized);
});

Deno.test("invalid option values are logged as warnings and take defaults", () => {
  const h = makeHarness();
  h.deliver(
    request(1, "initialize", {
      initializationOptions: { debounceMs: -1, writeOnSave: "yes" },
    }),
  );
  const logs = h.logs();
  assertEquals(logs.map((l) => l.type), [2, 2]);
  assertStringIncludes(logs[0].message, "debounceMs");
  assertStringIncludes(logs[1].message, "writeOnSave");
  assertEquals(h.responses(1).length, 1);
});

Deno.test("initialized and $/ notifications are ignored", () => {
  const h = started();
  h.deliver(
    notification("initialized", {}),
    notification("$/cancelRequest", { id: 3 }),
    notification("$/setTrace", { value: "off" }),
  );
  assertEquals(h.sent, []);
  assertEquals(h.stderr, []);
});

Deno.test("an unknown request gets -32601; an unknown notification is ignored", () => {
  const h = started();
  h.deliver(request(1, "foo/bar"), notification("foo/baz"));
  assertEquals(errorCode(h.responses(1)[0]), ErrorCodes.methodNotFound);
  assertEquals(h.sent.length, 1);
});

Deno.test("the requests of part L3b answer -32601 for now", () => {
  const h = started();
  const methods = [
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/documentSymbol",
    "effective/generatedTypeScript",
    "effective/stats",
  ];
  methods.forEach((method, i) => h.deliver(request(i + 1, method, {})));
  methods.forEach((_, i) =>
    assertEquals(errorCode(h.responses(i + 1)[0]), ErrorCodes.methodNotFound)
  );
});

Deno.test("shutdown returns null; later requests get -32600; later notifications are dropped", () => {
  const h = started();
  h.deliver(request(1, "shutdown"));
  assertEquals(result(h.responses(1)[0]), null);
  assert(h.server.shutdownSeen);
  h.deliver(request(2, "textDocument/hover", {}), request(3, "shutdown"));
  assertEquals(errorCode(h.responses(2)[0]), ErrorCodes.invalidRequest);
  assertEquals(errorCode(h.responses(3)[0]), ErrorCodes.invalidRequest);
  h.clearSent();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.sent, []);
  assertEquals(h.server.projects.projects().length, 0);
});

Deno.test("exit gives code 0 after shutdown and 1 before", () => {
  const before = started();
  before.deliver(notification("exit"));
  assertEquals(before.exits, [1]);
  const after = started();
  after.deliver(request(1, "shutdown"), notification("exit"));
  assertEquals(after.exits, [0]);
});

Deno.test("a frame with bad JSON gets -32700 with a null id; a bad header goes to stderr", () => {
  const h = started();
  h.server.handle({
    ok: false,
    error: { tag: "bad-json", message: "Unexpected token" },
  });
  assertEquals(h.responses(null).length, 1);
  assertEquals(errorCode(h.responses(null)[0]), ErrorCodes.parseError);
  h.clearSent();
  h.server.handle({
    ok: false,
    error: { tag: "bad-header", message: "no Content-Length" },
  });
  assertEquals(h.sent, []);
  assertEquals(h.stderr.length, 1);
  assertStringIncludes(h.stderr[0], "no Content-Length");
});

Deno.test("an invalid message gets -32600 with the id that it carries", () => {
  const h = started();
  h.deliver({ jsonrpc: "1.0", id: 7, method: "x" }, 42);
  assertEquals(errorCode(h.responses(7)[0]), ErrorCodes.invalidRequest);
  assertEquals(errorCode(h.responses(null)[0]), ErrorCodes.invalidRequest);
});

Deno.test("a response from the client is ignored", () => {
  const h = started();
  h.deliver({ jsonrpc: "2.0", id: 1, result: null });
  assertEquals(h.sent, []);
});

Deno.test("invalid params for a request give -32602; for a notification they go to stderr", () => {
  const probe = new Map<string, RequestHandler>([[
    "test/probe",
    withParams(narrowTextDocumentParams, (value) => ({
      ok: true,
      value: value.textDocument.uri,
    })),
  ]]);
  const h = makeHarness({ extraRequests: probe });
  h.start();
  h.deliver(request(1, "test/probe", { textDocument: {} }));
  assertEquals(errorCode(h.responses(1)[0]), ErrorCodes.invalidParams);
  h.deliver(request(2, "test/probe", { textDocument: { uri: "file:///x" } }));
  assertEquals(result(h.responses(2)[0]), "file:///x");
  h.clearSent();
  h.deliver(notification("textDocument/didOpen", { textDocument: 5 }));
  assertEquals(h.sent, []);
  assertEquals(h.stderr.length, 1);
  assertStringIncludes(h.stderr[0], "textDocument/didOpen");
});

Deno.test("an exception in a request handler gives -32603 and the server goes on", () => {
  const boom = new Map<string, RequestHandler>([[
    "test/boom",
    () => {
      throw new Error("kaboom");
    },
  ]]);
  const h = makeHarness({ extraRequests: boom });
  h.start();
  h.deliver(request(1, "test/boom"));
  const response = h.responses(1)[0];
  assertEquals(errorCode(response), ErrorCodes.internalError);
  assert("error" in response);
  assertEquals(response.error.message, "kaboom");
  assertStringIncludes(h.stderr.join(""), "kaboom");
  h.deliver(request(2, "shutdown"));
  assertEquals(result(h.responses(2)[0]), null);
});

Deno.test("an exception in a notification handler goes to stderr and the server goes on", () => {
  const h = started();
  h.throwOnRead.add(`${ROOT}/main.eff`);
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.sent, []);
  assertStringIncludes(h.stderr.join(""), "disk failure");
  h.deliver(request(1, "shutdown"));
  assertEquals(result(h.responses(1)[0]), null);
});

// ---- Diagnostics ------------------------------------------------------------

Deno.test("didOpen of main.eff publishes an empty list with version 1 and nothing else", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.published().map(summary), [[MAIN, 1, 0]]);
  assertEquals(h.server.projects.projects().length, 1);
});

Deno.test("a didChange that adds an error publishes the open document with the new version", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 2, MAIN_BROKEN));
  const published = h.published();
  assertEquals(published.length, 1);
  assertEquals(published[0].uri, MAIN);
  assertEquals(published[0].version, 2);
  const [diagnostic] = published[0].diagnostics;
  assertEquals(published[0].diagnostics.length, 1);
  assertEquals(diagnostic.severity, 1);
  assertEquals(diagnostic.source, "effective");
  assertStringIncludes(diagnostic.code, "/");
  assertEquals(
    diagnostic.range.start.line,
    MAIN_BROKEN.split("\n").findIndex((l) => l.includes("displayName(1)")),
  );
  // Repairing it publishes an empty list.
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 3, MAIN_TEXT));
  assertEquals(h.published().map(summary), [[MAIN, 3, 0]]);
});

Deno.test("an unchanged list is published again only for a new version", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 2, `${MAIN_TEXT}\n// note\n`));
  assertEquals(h.published().map(summary), [[MAIN, 2, 0]]);
  // Opening a second file publishes that file only: main.eff has its version and list.
  h.clearSent();
  h.deliver(didOpen(USERS, 1, USERS_TEXT));
  assertEquals(h.published().map(summary), [[USERS, 1, 0]]);
});

Deno.test("an edit of users.eff that breaks main.eff publishes main.eff, and the repair clears it once", () => {
  const h = started();
  h.deliver(didOpen(USERS, 1, USERS_TEXT));
  h.clearSent();
  h.deliver(didChangeFull(USERS, 2, USERS_BROKEN));
  const published = h.published();
  assertEquals(uris(published), [USERS, MAIN]);
  assertEquals(published[0].version, 2);
  assertEquals(published[1].version, undefined);
  assert("version" in published[0] && !("version" in published[1]));
  assert(published[1].diagnostics.length > 0);
  // The same list is not sent again.
  h.clearSent();
  h.deliver(didChangeFull(USERS, 3, `${USERS_BROKEN}\n// note\n`));
  assertEquals(uris(h.published()), [USERS]);
  // The repair publishes an empty list for main.eff, once.
  h.clearSent();
  h.deliver(didChangeFull(USERS, 4, USERS_TEXT));
  assertEquals(h.published().map(summary), [[USERS, 4, 0], [
    MAIN,
    undefined,
    0,
  ]]);
  h.clearSent();
  h.deliver(didChangeFull(USERS, 5, `${USERS_TEXT}\n// note\n`));
  assertEquals(uris(h.published()), [USERS]);
});

Deno.test("open documents are published first and sorted, then changed closed files sorted", () => {
  const h = started();
  // Open users.eff before main.eff so that the open order differs from the sorted order.
  h.deliver(didOpen(USERS, 1, USERS_TEXT), didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(uris(h.published()), [MAIN, USERS]);
  h.clearSent();
  h.deliver(
    didChangeFull(USERS, 2, USERS_BROKEN),
    didChangeFull(MAIN, 2, MAIN_BROKEN),
  );
  const published = h.published();
  assertEquals(uris(published), [MAIN, USERS]);
  assertEquals(published.map((p) => p.version), [2, 2]);
  // main.eff fails to import displayName from the broken users.eff. Its list
  // does not change when it closes, so a closed file with that list gets nothing.
  h.clearSent();
  h.deliver(didClose(MAIN));
  assertEquals(h.published(), []);
  // Closing users.eff restores the clean disk text. The list of users.eff stays
  // empty, and main.eff drops to an empty list that is published once.
  h.deliver(didClose(USERS));
  assertEquals(h.published().map(summary), [[MAIN, undefined, 0]]);
});

Deno.test("incremental edits through ranges", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  h.deliver(notification("textDocument/didChange", {
    textDocument: { uri: MAIN, version: 2 },
    contentChanges: [{ range: rangeOf(MAIN_TEXT, '"u1"'), text: "1" }],
  }));
  const found = h.server.projects.lookup(MAIN);
  assert(found !== undefined);
  assertEquals(found.project.open.get("main.eff")?.text, MAIN_BROKEN);
  const published = h.published();
  assertEquals(published.length, 1);
  assertEquals(published[0].version, 2);
  assertEquals(published[0].diagnostics.length, 1);
  // Two changes in one message apply in order.
  h.deliver(notification("textDocument/didChange", {
    textDocument: { uri: MAIN, version: 3 },
    contentChanges: [
      { range: rangeOf(MAIN_BROKEN, "(1)"), text: '("u1")' },
      { range: rangeOf(MAIN_BROKEN, "main"), text: "main" },
    ],
  }));
  assertEquals(found.project.open.get("main.eff")?.text, MAIN_TEXT);
});

Deno.test("didClose restores the disk text", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_BROKEN));
  assertEquals(h.published()[0].diagnostics.length, 1);
  h.clearSent();
  h.deliver(didClose(MAIN));
  // The disk text is clean: one empty list for the closed file.
  assertEquals(h.published().map(summary), [[MAIN, undefined, 0]]);
  const found = h.server.projects.lookup(MAIN);
  assert(found !== undefined);
  assertEquals(found.project.current.get("main.eff"), MAIN_TEXT);
  assertEquals(found.project.open.size, 0);
});

Deno.test("didClose of a file that is not on disk removes it from the program", () => {
  const h = started();
  const extra = exampleUri("extra.eff");
  const broken = 'export const x = (): number => "s"\n';
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.deliver(didOpen(extra, 1, broken));
  const found = h.server.projects.lookup(extra);
  assert(found !== undefined);
  assert(found.project.current.has("extra.eff"));
  assertEquals(h.published().at(-1)?.uri, extra);
  assert((h.published().at(-1)?.diagnostics.length ?? 0) > 0);
  h.clearSent();
  h.deliver(didClose(extra));
  assert(!found.project.current.has("extra.eff"));
  assertEquals(h.published().map(summary), [[extra, undefined, 0]]);
});

Deno.test("didChange and didClose for a document that is not open go to stderr", () => {
  const h = started();
  h.deliver(didChangeFull(MAIN, 2, MAIN_TEXT), didClose(MAIN));
  assertEquals(h.sent, []);
  assertEquals(h.stderr.length, 2);
  assertStringIncludes(h.stderr[0], "didChange");
  assertStringIncludes(h.stderr[1], "didClose");
});

// ---- Watched files ----------------------------------------------------------

Deno.test("watched files: create, change, and delete", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  const path = `${ROOT}/extra.eff`;
  const extra = uriOf(path);
  const broken = 'export const x = (): number => "s"\n';
  h.files.set(path, broken);
  h.deliver(watched({ uri: extra, type: 1 }));
  const created = h.published();
  assertEquals(uris(created), [extra]);
  assert(!("version" in created[0]));
  assert(created[0].diagnostics.length > 0);
  h.clearSent();
  h.files.set(path, "export const x = (): number => 1\n");
  h.deliver(watched({ uri: extra, type: 2 }));
  assertEquals(h.published().map(summary), [[extra, undefined, 0]]);
  h.clearSent();
  h.files.set(path, broken);
  h.deliver(watched({ uri: extra, type: 2 }));
  assertEquals(h.published().length, 1);
  h.clearSent();
  h.files.delete(path);
  h.deliver(watched({ uri: extra, type: 3 }));
  assertEquals(h.published().map(summary), [[extra, undefined, 0]]);
  // A change event for a file that is gone counts as a delete.
  h.files.set(path, broken);
  h.deliver(watched({ uri: extra, type: 1 }));
  h.clearSent();
  h.files.delete(path);
  h.deliver(watched({ uri: extra, type: 2 }));
  assertEquals(h.published().map(summary), [[extra, undefined, 0]]);
});

Deno.test("a watched event for an open document is ignored", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  h.files.set(`${ROOT}/main.eff`, MAIN_BROKEN);
  h.deliver(watched({ uri: MAIN, type: 2 }));
  assertEquals(h.sent, []);
  const found = h.server.projects.lookup(MAIN);
  assert(found !== undefined);
  assertEquals(found.project.current.get("main.eff"), MAIN_TEXT);
});

Deno.test("watched events outside known projects or outside source paths are ignored", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.clearSent();
  h.files.set("/elsewhere/a.eff", "export const a = (): number => 1\n");
  h.files.set(`${ROOT}/notes.txt`, "text");
  h.files.set(`${ROOT}/.cache/hidden.eff`, "this is not valid");
  h.deliver(watched(
    { uri: uriOf("/elsewhere/a.eff"), type: 1 },
    { uri: uriOf(`${ROOT}/notes.txt`), type: 1 },
    { uri: uriOf(`${ROOT}/.cache/hidden.eff`), type: 1 },
    { uri: "untitled:Untitled-1", type: 1 },
  ));
  assertEquals(h.sent, []);
  assertEquals(h.server.projects.projects().length, 1);
});

// ---- Configuration errors ---------------------------------------------------

Deno.test("a configuration error is published on effective.json and cleared later", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  const found = h.server.projects.lookup(MAIN);
  assert(found !== undefined);
  const good = found.project.lastGood;
  assert(good !== undefined);
  const config = uriOf(`${ROOT}/effective.json`);
  const goodConfig = h.files.get(`${ROOT}/effective.json`) ?? "";
  h.clearSent();

  h.files.set(`${ROOT}/effective.json`, "{");
  h.deliver(watched({ uri: config, type: 2 }));
  const published = h.published();
  assertEquals(published.length, 1);
  assertEquals(published[0].uri, config);
  assert(!("version" in published[0]));
  assertEquals(published[0].diagnostics.length, 1);
  assertEquals(published[0].diagnostics[0].severity, 1);
  assertEquals(published[0].diagnostics[0].code, "config");
  assertEquals(published[0].diagnostics[0].range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
  assertStringIncludes(published[0].diagnostics[0].message, "not valid JSON");
  // The last good revision stays.
  assert(found.project.lastGood === good);
  assert(found.project.configError !== undefined);

  // An edit during the error is held until the next good update.
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 2, MAIN_BROKEN));
  assertEquals(h.published(), []);
  assert(found.project.lastGood === good);

  h.files.set(`${ROOT}/effective.json`, goodConfig);
  h.deliver(watched({ uri: config, type: 2 }));
  assertEquals(h.published().map(summary), [
    [MAIN, 2, 1],
    [config, undefined, 0],
  ]);
  assert(found.project.configError === undefined);
  assert(found.project.lastGood !== good);
  assert(found.project.lastDelta !== undefined);
});

// ---- Projects ---------------------------------------------------------------

Deno.test("a document outside any project gets no diagnostics and one log message", () => {
  const h = makeHarness({
    files: { ...exampleFilesAt(ROOT), "/other/a.eff": "export const a = 1\n" },
  });
  h.start();
  const other = uriOf("/other/a.eff");
  h.deliver(didOpen(other, 1, 'export const a = (): number => "s"\n'));
  assertEquals(h.published(), []);
  const logs = h.logs();
  assertEquals(logs.length, 1);
  assertEquals(logs[0].type, 3);
  assertStringIncludes(logs[0].message, other);
  // More messages for the document are silent. A new open logs nothing again.
  h.deliver(didChangeFull(other, 2, "x"), didClose(other));
  h.deliver(didOpen(other, 3, "x"));
  assertEquals(h.logs().length, 1);
  assertEquals(h.stderr, []);
  assertEquals(h.server.projects.projects().length, 0);
});

Deno.test("a path in a hidden directory gets no project", () => {
  const h = makeHarness({
    files: {
      ...exampleFilesAt(ROOT),
      [`${ROOT}/.hidden/a.eff`]: "export const a = 1\n",
    },
  });
  h.start();
  h.deliver(didOpen(uriOf(`${ROOT}/.hidden/a.eff`), 1, "x"));
  assertEquals(h.published(), []);
  assertEquals(h.logs().length, 1);
  assertEquals(h.server.projects.projects().length, 0);
});

Deno.test("a document in a subdirectory finds the project above it", () => {
  const h = makeHarness({
    files: {
      ...exampleFilesAt(ROOT),
      [`${ROOT}/sub/deep/z.eff`]: "export const z = (): number => 1\n",
    },
  });
  h.start();
  h.deliver(
    didOpen(
      uriOf(`${ROOT}/sub/deep/z.eff`),
      1,
      "export const z = (): number => 1\n",
    ),
  );
  assertEquals(h.published().map(summary), [[
    uriOf(`${ROOT}/sub/deep/z.eff`),
    1,
    0,
  ]]);
  assertEquals(h.server.projects.projects().map((p) => p.root), [ROOT]);
});

Deno.test("two projects side by side stay separate", () => {
  const second = "/work/second";
  const h = makeHarness({
    files: {
      ...exampleFilesAt(ROOT),
      [`${second}/effective.json`]: "{}",
      [`${second}/a.eff`]: "export const a = (): number => 1\n",
    },
  });
  h.start();
  const a = uriOf(`${second}/a.eff`);
  h.deliver(
    didOpen(MAIN, 1, MAIN_TEXT),
    didOpen(a, 1, "export const a = (): number => 1\n"),
  );
  assertEquals(h.published().map(summary), [[MAIN, 1, 0], [a, 1, 0]]);
  assertEquals(h.server.projects.projects().map((p) => p.root), [ROOT, second]);
  // An error in one project leaves the other alone.
  h.clearSent();
  h.deliver(didChangeFull(a, 2, 'export const a = (): number => "s"\n'));
  const published = h.published();
  assertEquals(uris(published), [a]);
  assert(published[0].diagnostics.length > 0);
  const main = h.server.projects.lookup(MAIN);
  const other = h.server.projects.lookup(a);
  assert(main !== undefined && other !== undefined);
  assert(main.project.program !== other.project.program);
  assertEquals(main.project.lastGood?.diagnostics.length, 0);
});

// ---- Scheduling -------------------------------------------------------------

Deno.test("debounceMs 0 flushes in afterBatch with no timer", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.published().length, 1);
  assertEquals(h.timers.length, 0);
});

Deno.test("two messages in one batch give one flush", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), didChangeFull(MAIN, 2, MAIN_BROKEN));
  const published = h.published();
  assertEquals(published.length, 1);
  assertEquals(published[0].version, 2);
  const found = h.server.projects.lookup(MAIN);
  assertEquals(found?.project.lastGood?.number, 1);
});

Deno.test("a positive debounceMs schedules one timer and a second batch replaces it", () => {
  const h = started({ debounceMs: 40 });
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.published(), []);
  assertEquals(h.timers.map((t) => [t.ms, t.cancelled]), [[40, false]]);
  h.deliver(didChangeFull(MAIN, 2, MAIN_BROKEN));
  assertEquals(h.timers.map((t) => [t.ms, t.cancelled]), [[40, true], [
    40,
    false,
  ]]);
  assertEquals(h.published(), []);
  h.runTimers();
  const published = h.published();
  assertEquals(published.length, 1);
  assertEquals(published[0].version, 2);
  // A batch with nothing dirty schedules nothing.
  h.deliver(notification("$/cancelRequest", { id: 1 }));
  assertEquals(h.timers.length, 2);
});

Deno.test("a request flushes the project of its document first", () => {
  let revision: number | undefined;
  const probe = new Map<string, RequestHandler>([[
    "test/probe",
    withParams(narrowTextDocumentParams, (value, ctx) => {
      const found = ctx.projects.forRequest(value.textDocument.uri);
      revision = found?.project.lastGood?.number;
      return { ok: true, value: revision ?? null };
    }),
  ]]);
  const h = makeHarness({ extraRequests: probe });
  h.start({ debounceMs: 500 });
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  assertEquals(h.published(), []);
  h.deliver(request(1, "test/probe", { textDocument: { uri: MAIN } }));
  assertEquals(result(h.responses(1)[0]), 1);
  assertEquals(h.published().map(summary), [[MAIN, 1, 0]]);
  // The pending timer then finds nothing to do.
  h.runTimers();
  assertEquals(h.published().length, 1);
});

Deno.test("shutdown cancels a pending flush", () => {
  const h = started({ debounceMs: 40 });
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.deliver(request(1, "shutdown"));
  assertEquals(h.timers.map((t) => t.cancelled), [true]);
  h.runTimers();
  assertEquals(h.published(), []);
});

Deno.test("related spans become relatedInformation with a file URI", () => {
  const h = started();
  const dup = exampleUri("dup.eff");
  const text =
    "export const a = (): number => 1\nexport const a = (): number => 2\n";
  h.deliver(didOpen(dup, 1, text));
  const [published] = h.published();
  assertEquals(published.uri, dup);
  const withRelated = published.diagnostics.find((d) =>
    d.relatedInformation !== undefined
  );
  assert(withRelated !== undefined, JSON.stringify(published));
  assertEquals(withRelated.relatedInformation?.[0].location.uri, dup);
  assertEquals(
    withRelated.relatedInformation?.[0].message,
    "first declared here",
  );
  assertEquals(
    withRelated.relatedInformation?.[0].location.range.start.line,
    0,
  );
});

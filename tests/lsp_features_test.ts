// Fast tests of the language features (plan L3b), driven in process through the
// harness on the examples: hover, definition, document symbols, generated
// TypeScript, save, and stats.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ResponseMessage } from "../src/lsp/jsonrpc.ts";
import type {
  DocumentSymbol,
  GeneratedTypeScriptResult,
  Hover,
  Location,
  Position,
  Range,
  StatsResult,
} from "../src/lsp/protocol.ts";
import {
  didChangeFull,
  didClose,
  didOpen,
  exampleFiles,
  exampleFilesAt,
  exampleUri,
  type Harness,
  HARNESS_MEMORY,
  makeHarness,
  notification,
  request,
  ROOT,
  uriOf,
  watched,
} from "./lsp_helpers.ts";

const MAIN = exampleUri("main.eff");
const USERS = exampleUri("users.eff");
const PROVIDERS = exampleUri("host/providers.effi");
const MAIN_TEXT = exampleFiles()["main.eff"];
const USERS_TEXT = exampleFiles()["users.eff"];
const PROVIDERS_TEXT = exampleFiles()["host/providers.effi"];
const MAIN_BROKEN = MAIN_TEXT.replace('displayName("u1")', "displayName(1)");
const USERS_BROKEN = USERS_TEXT.replace("Users.save(renamed)", "Users.save(1)");

function started(options?: unknown): Harness {
  const h = makeHarness();
  h.start(options);
  return h;
}

function result(message: ResponseMessage | undefined): unknown {
  assert(message !== undefined && "result" in message, JSON.stringify(message));
  return message.result;
}

/** The position of the first `needle` in `text`, plus `within` characters. */
function at(text: string, needle: string, within = 0): Position {
  const offset = text.indexOf(needle);
  assert(offset >= 0, needle);
  const before = text.slice(0, offset).split("\n");
  const line = before.length - 1;
  return { line, character: before[line].length + within };
}

function rangeOf(text: string, needle: string): Range {
  const start = at(text, needle);
  return {
    start,
    end: { line: start.line, character: start.character + needle.length },
  };
}

function position(uri: string, where: Position) {
  return { textDocument: { uri }, position: where };
}

function hoverOf(h: Harness, id: number): Hover | null {
  return result(h.responses(id)[0]) as Hover | null;
}

// ---- Hover ------------------------------------------------------------------

Deno.test("hover on a function name has the contract, the backend type, and the name range", () => {
  const h = started();
  h.deliver(
    didOpen(USERS, 1, USERS_TEXT),
    request(
      1,
      "textDocument/hover",
      position(USERS, at(USERS_TEXT, "rename", 2)),
    ),
  );
  const hover = hoverOf(h, 1);
  assert(hover !== null);
  assertEquals(hover.range, rangeOf(USERS_TEXT, "rename"));
  assertEquals(hover.contents.kind, "markdown");
  const [contract, backend] = hover.contents.value.split("\n\n");
  assertEquals(
    contract,
    "```effective\nrename(id: string, name: string): User fails " +
      "StoreUnavailable | UserMissing uses Users.find | Users.save\n```",
  );
  assert(backend.startsWith("```typescript\n(id: string, name: string): "));
  assert(backend.endsWith("\n```"));
});

Deno.test("hover on an expression has only the contract block", () => {
  const h = started();
  h.deliver(
    didOpen(USERS, 1, USERS_TEXT),
    request(
      1,
      "textDocument/hover",
      position(USERS, at(USERS_TEXT, "getUser(id)", 1)),
    ),
  );
  const hover = hoverOf(h, 1);
  assert(hover !== null);
  assert(hover.contents.value.startsWith("```effective\n"));
  assert(!hover.contents.value.includes("typescript"));
  assert(!hover.contents.value.includes("backend type"));
});

Deno.test("hover in a module with errors shows the unavailable line", () => {
  const h = started();
  h.deliver(
    didOpen(USERS, 1, USERS_BROKEN),
    request(
      1,
      "textDocument/hover",
      position(USERS, at(USERS_BROKEN, "rename")),
    ),
  );
  const hover = hoverOf(h, 1);
  assert(hover !== null);
  assertStringIncludes(hover.contents.value, "```effective\nrename(");
  assert(
    hover.contents.value.endsWith(
      "\n\nbackend type: not available while the module has errors",
    ),
    hover.contents.value,
  );
});

Deno.test("hover in a document with no project is null", () => {
  const h = started();
  const orphan = uriOf("/elsewhere/a.eff");
  h.deliver(
    didOpen(orphan, 1, "export const a = (): int => 1\n"),
    request(
      1,
      "textDocument/hover",
      position(orphan, { line: 0, character: 14 }),
    ),
    request(
      2,
      "textDocument/hover",
      position(USERS, { line: 0, character: 0 }),
    ),
  );
  assertEquals(result(h.responses(1)[0]), null);
  assertEquals(result(h.responses(2)[0]), null);
});

Deno.test("hover on a dirty project answers from the new text", () => {
  const h = started();
  const renamed = USERS_TEXT.replace(
    "export const rename ",
    "export const renameTo ",
  );
  h.deliver(didOpen(USERS, 1, USERS_TEXT));
  h.clearSent();
  h.deliver(
    didChangeFull(USERS, 2, renamed),
    request(1, "textDocument/hover", position(USERS, at(renamed, "renameTo"))),
  );
  const hover = hoverOf(h, 1);
  assert(hover !== null);
  assertStringIncludes(hover.contents.value, "renameTo(id: string");
  assertEquals(hover.range, rangeOf(renamed, "renameTo"));
});

Deno.test("hover where no node lies is null", () => {
  const h = started();
  h.deliver(
    didOpen(USERS, 1, USERS_TEXT),
    request(
      1,
      "textDocument/hover",
      position(USERS, { line: 4, character: 0 }),
    ),
  );
  // Line 4 is the closing brace of the type declaration: no checked node.
  assertEquals(result(h.responses(1)[0]), null);
});

// ---- Definition -------------------------------------------------------------

Deno.test("definition goes from main.eff into users.eff", () => {
  const h = started();
  h.deliver(
    didOpen(MAIN, 1, MAIN_TEXT),
    request(
      1,
      "textDocument/definition",
      position(MAIN, at(MAIN_TEXT, 'displayName("u1")', 3)),
    ),
  );
  const location = result(h.responses(1)[0]) as Location | null;
  assertEquals(location, {
    uri: USERS,
    range: rangeOf(USERS_TEXT, "displayName"),
  });
});

Deno.test("definition goes into a host interface file", () => {
  const h = started();
  h.deliver(
    didOpen(MAIN, 1, MAIN_TEXT),
    request(
      1,
      "textDocument/definition",
      position(MAIN, at(MAIN_TEXT, "UsersLive, ", 2)),
    ),
  );
  assertEquals(result(h.responses(1)[0]), {
    uri: PROVIDERS,
    range: rangeOf(PROVIDERS_TEXT, "UsersLive"),
  });
});

Deno.test("definition on a builtin is null", () => {
  const h = started();
  h.deliver(
    didOpen(MAIN, 1, MAIN_TEXT),
    request(
      1,
      "textDocument/definition",
      position(MAIN, at(MAIN_TEXT, "provide(", 2)),
    ),
  );
  assertEquals(result(h.responses(1)[0]), null);
});

// ---- Document symbols -------------------------------------------------------

function symbolsOf(h: Harness, id: number): DocumentSymbol[] {
  const value = result(h.responses(id)[0]);
  assert(Array.isArray(value), JSON.stringify(value));
  return value as DocumentSymbol[];
}

Deno.test("document symbols have kinds, ranges, and service methods", () => {
  const h = started();
  h.deliver(
    didOpen(USERS, 1, USERS_TEXT),
    request(1, "textDocument/documentSymbol", { textDocument: { uri: USERS } }),
  );
  const symbols = symbolsOf(h, 1);
  assertEquals(
    symbols.map((s) => [s.name, s.kind]),
    [
      ["User", 23],
      ["UserMissing", 5],
      ["StoreUnavailable", 5],
      ["Users", 11],
      ["getUser", 12],
      ["rename", 12],
      ["displayName", 12],
      ["activeNames", 12],
    ],
  );
  const rename = symbols[5];
  assertEquals(rename.selectionRange, rangeOf(USERS_TEXT, "rename"));
  assertEquals(rename.range.start.line, rename.selectionRange.start.line);
  assert(rename.range.end.line > rename.range.start.line);
  assertEquals(rename.children, undefined);
  const users = symbols[3];
  assertEquals(
    users.children?.map((c) => [c.name, c.kind]),
    [["find", 6], ["save", 6], ["all", 6]],
  );
  assertEquals(
    users.children?.[1].selectionRange,
    rangeOf(USERS_TEXT, "save"),
  );
});

Deno.test("document symbols of a closed file come from the disk text", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.deliver(
    request(1, "textDocument/documentSymbol", { textDocument: { uri: USERS } }),
  );
  assertEquals(symbolsOf(h, 1).length, 8);
});

Deno.test("document symbols of a host file that no module imports", () => {
  const other = exampleUri("host/other.effi");
  const text =
    'import { Users } from "../users.eff"\nexport provider OtherLive provides Users\n';
  const h = makeHarness({
    files: { ...exampleFilesAt(ROOT), [`${ROOT}/host/other.effi`]: text },
  });
  h.start();
  h.deliver(
    didOpen(other, 1, text),
    request(1, "textDocument/documentSymbol", { textDocument: { uri: other } }),
    request(
      2,
      "textDocument/hover",
      position(other, { line: 1, character: 18 }),
    ),
  );
  const symbols = symbolsOf(h, 1);
  assertEquals(symbols.map((s) => [s.name, s.kind]), [["OtherLive", 13]]);
  assertEquals(symbols[0].selectionRange, rangeOf(text, "OtherLive"));
  assertEquals(result(h.responses(2)[0]), null);
});

Deno.test("document symbols before the first good revision", () => {
  const h = makeHarness({
    files: { ...exampleFilesAt(ROOT), [`${ROOT}/effective.json`]: "{" },
  });
  h.start();
  h.deliver(
    didOpen(MAIN, 1, MAIN_TEXT),
    request(1, "textDocument/documentSymbol", { textDocument: { uri: MAIN } }),
    request(2, "textDocument/hover", position(MAIN, at(MAIN_TEXT, "main", 1))),
    request(3, "effective/generatedTypeScript", {
      textDocument: { uri: MAIN },
    }),
  );
  const found = h.server.projects.lookup(MAIN);
  assert(found !== undefined && found.project.lastGood === undefined);
  assertEquals(symbolsOf(h, 1).map((s) => s.name), ["main"]);
  assertEquals(result(h.responses(2)[0]), null);
  assertEquals(result(h.responses(3)[0]), null);
});

// ---- Generated TypeScript ---------------------------------------------------

function generated(h: Harness, id: number, uri = MAIN) {
  h.deliver(
    request(id, "effective/generatedTypeScript", { textDocument: { uri } }),
  );
  return result(h.responses(id)[0]) as GeneratedTypeScriptResult | null;
}

Deno.test("generated TypeScript is fresh, then stale after a breaking edit", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  const fresh = generated(h, 1);
  assert(fresh !== null);
  assertEquals(fresh.stale, false);
  assertStringIncludes(fresh.text, "export");
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 2, MAIN_BROKEN));
  assertEquals(h.notifications("effective/generatedChanged"), [{ uri: MAIN }]);
  assertEquals(generated(h, 2), { text: fresh.text, stale: true });
  // A second broken edit changes nothing for the client.
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 3, MAIN_BROKEN + "\n"));
  assertEquals(h.notifications("effective/generatedChanged"), []);
  // The fix flips the stale flag back once, with the same text.
  h.deliver(didChangeFull(MAIN, 4, MAIN_TEXT));
  assertEquals(h.notifications("effective/generatedChanged"), [{ uri: MAIN }]);
  assertEquals(generated(h, 3), { text: fresh.text, stale: false });
});

Deno.test("generatedChanged follows a text change, not an equal text", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  const fresh = generated(h, 1);
  assert(fresh !== null);
  h.clearSent();
  // A trailing blank line leaves the generated text equal.
  h.deliver(didChangeFull(MAIN, 2, MAIN_TEXT + "\n\n"));
  assertEquals(h.published().length, 1);
  assertEquals(h.notifications("effective/generatedChanged"), []);
  h.deliver(didChangeFull(MAIN, 3, MAIN_TEXT.replace('"u1"', '"u2"')));
  assertEquals(h.notifications("effective/generatedChanged"), [{ uri: MAIN }]);
  const changed = generated(h, 2);
  assert(changed !== null && changed.text !== fresh.text && !changed.stale);
  // The client now has the new text: the same edit again sends nothing.
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 4, MAIN_TEXT.replace('"u1"', '"u2"') + "\n"));
  assertEquals(h.notifications("effective/generatedChanged"), []);
});

Deno.test("a module that never emitted gives null, and a later fix sends a notification", () => {
  const bad = exampleUri("bad.eff");
  const broken = 'export const x = (): int => "s"\n';
  const h = started();
  h.deliver(didOpen(bad, 1, broken));
  assertEquals(generated(h, 1, bad), null);
  h.clearSent();
  h.deliver(didChangeFull(bad, 2, broken + "\n"));
  assertEquals(h.notifications("effective/generatedChanged"), []);
  h.deliver(didChangeFull(bad, 3, "export const x = (): int => 1\n"));
  assertEquals(h.notifications("effective/generatedChanged"), [{ uri: bad }]);
  const fixed = generated(h, 2, bad);
  assert(fixed !== null && !fixed.stale);
});

Deno.test("only subscribed modules send generatedChanged, and a configuration error sends none", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), didOpen(USERS, 1, USERS_TEXT));
  h.clearSent();
  h.deliver(didChangeFull(MAIN, 2, MAIN_TEXT.replace('"u1"', '"u2"')));
  assertEquals(h.notifications("effective/generatedChanged"), []);
  assert(generated(h, 1) !== null);
  h.clearSent();
  h.files.set(`${ROOT}/effective.json`, "{");
  h.deliver(watched({ uri: uriOf(`${ROOT}/effective.json`), type: 2 }));
  assertEquals(h.notifications("effective/generatedChanged"), []);
  // The module of a file that is not `.eff` is never subscribed.
  assertEquals(generated(h, 2, PROVIDERS), null);
});

// ---- Save -------------------------------------------------------------------

const MAIN_TS = `${ROOT}/main.ts`;

function save(uri: string): unknown {
  return notification("textDocument/didSave", { textDocument: { uri } });
}

Deno.test("didSave writes the saved module and its map only", () => {
  const h = started();
  const before = new Set(h.files.keys());
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), save(MAIN));
  const added = [...h.files.keys()].filter((path) => !before.has(path)).sort();
  assertEquals(added, [MAIN_TS, `${MAIN_TS}.map`]);
  assertEquals(h.logs(), []);
  const emitted = generated(h, 1);
  assertEquals(h.files.get(MAIN_TS), emitted?.text);
});

Deno.test("didSave writes nothing when writeOnSave is false", () => {
  const h = started({ writeOnSave: false });
  const before = new Set(h.files.keys());
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), save(MAIN));
  assertEquals(new Set(h.files.keys()), before);
});

Deno.test("didSave of a module with an error keeps the old files", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), save(MAIN));
  const old = h.files.get(MAIN_TS);
  const oldMap = h.files.get(`${MAIN_TS}.map`);
  assert(old !== undefined && oldMap !== undefined);
  h.deliver(didChangeFull(MAIN, 2, MAIN_BROKEN), save(MAIN));
  assertEquals(h.files.get(MAIN_TS), old);
  assertEquals(h.files.get(`${MAIN_TS}.map`), oldMap);
  assertEquals(h.logs(), []);
});

Deno.test("didSave of a new module with an error writes nothing", () => {
  const h = started();
  const before = new Set(h.files.keys());
  h.deliver(didOpen(MAIN, 1, MAIN_BROKEN), save(MAIN));
  assertEquals(new Set(h.files.keys()), before);
});

Deno.test("didSave of a host interface file writes nothing", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), didOpen(PROVIDERS, 1, PROVIDERS_TEXT));
  const before = new Set(h.files.keys());
  h.deliver(save(PROVIDERS));
  assertEquals(new Set(h.files.keys()), before);
});

Deno.test("didSave during a configuration error writes nothing", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  h.files.set(`${ROOT}/effective.json`, "{");
  h.deliver(watched({ uri: uriOf(`${ROOT}/effective.json`), type: 2 }));
  const before = new Set(h.files.keys());
  h.deliver(save(MAIN));
  assertEquals(new Set(h.files.keys()), before);
});

Deno.test("a write failure on save goes to window/logMessage with type 1", () => {
  const h = started();
  h.unwritable.add(MAIN_TS);
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), save(MAIN));
  const logs = h.logs().filter((l) => l.type === 1);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0].message, "cannot write main.ts");
  // The map was still written.
  assert(h.files.has(`${MAIN_TS}.map`));
});

Deno.test("didSave of a closed document still writes", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), didClose(MAIN), save(MAIN));
  assert(h.files.has(MAIN_TS));
});

// ---- Stats ------------------------------------------------------------------

function stats(h: Harness, id: number, uri = MAIN): StatsResult | null {
  h.deliver(request(id, "effective/stats", { textDocument: { uri } }));
  return result(h.responses(id)[0]) as StatsResult | null;
}

Deno.test("stats has the revision, the counts, the delta, and the memory", () => {
  const h = started();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT), didOpen(USERS, 1, USERS_TEXT));
  const first = stats(h, 1);
  assert(first !== null);
  assertEquals(first.revision, 1);
  assert(first.rechecked.includes("main") && first.rechecked.includes("users"));
  assert(first.counts.parses > 0 && first.counts.checks > 0);
  assertEquals(first.memory, HARNESS_MEMORY);
  assert(first.delta.interfaceChanged.includes("users"));

  // A body edit: the checks grow, and no interface changes.
  h.deliver(
    didChangeFull(USERS, 2, USERS_TEXT.replace('"Guest"', '"Visitor"')),
  );
  const body = stats(h, 2);
  assert(body !== null);
  assertEquals(body.revision, 2);
  assert(body.counts.parses > first.counts.parses);
  assert(body.counts.checks > first.counts.checks);
  assertEquals(body.rechecked, ["users"]);
  assertEquals(body.delta, { interfaceChanged: [], modeChanged: [] });

  // An interface edit in users.eff.
  h.deliver(
    didChangeFull(
      USERS,
      3,
      USERS_TEXT.replace(
        "export const activeNames",
        "export const activeLogins",
      ),
    ),
  );
  const header = stats(h, 3);
  assert(header !== null);
  assertEquals(header.revision, 3);
  assertEquals(header.delta.interfaceChanged, ["users"]);
  // The mode map has a new function id, so the mode map differs too (plan 5.11).
  assertEquals(header.delta.modeChanged, ["users"]);
  assert(header.counts.checks > body.counts.checks);
});

Deno.test("stats before the first good revision, and with no project", () => {
  const h = makeHarness({
    files: { ...exampleFilesAt(ROOT), [`${ROOT}/effective.json`]: "{" },
  });
  h.start();
  h.deliver(didOpen(MAIN, 1, MAIN_TEXT));
  const early = stats(h, 1);
  assert(early !== null);
  assertEquals(early.revision, 0);
  assertEquals(early.rechecked, []);
  assertEquals(early.delta, { interfaceChanged: [], modeChanged: [] });
  assertEquals(early.memory, HARNESS_MEMORY);
  assertEquals(stats(h, 2, uriOf("/elsewhere/a.eff")), null);
});

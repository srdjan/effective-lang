// Tests for the editor queries: hover, definition, and document symbols. They
// run over the five examples, loaded into a `Program`, and over small projects
// in memory.

import { assert, assertEquals } from "@std/assert";
import { Program, type Revision } from "../src/core/db.ts";
import { definitionAt, documentSymbols, hoverAt } from "../src/core/editor.ts";
import type { Span } from "../src/core/source.ts";
import { exampleFiles, FIXTURES } from "./helpers.ts";

type Files = Record<string, string>;

function load(files: Files): Revision {
  const result = new Program("").update({ set: files });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** A single module `m.eff` with an empty project file. */
function loadModule(text: string): Revision {
  return load({ "effektive.json": "{}", "m.eff": text });
}

const FILES = exampleFiles();
const examples = load(FILES);

/** The offset of `needle` in `text`, plus `delta`. The needle must occur. */
function offsetOf(text: string, needle: string, delta = 0): number {
  const at = text.indexOf(needle);
  assert(at >= 0, `missing ${needle}`);
  return at + delta;
}

/** The span of the first occurrence of `needle` in the file. */
function spanOf(path: string, needle: string): Span {
  const at = offsetOf(FILES[path], needle);
  return { source: path, start: at, end: at + needle.length };
}

const USERS = "users.eff";
const USERS_TEXT = FILES[USERS];

/** The span of the name `User` in the declaration `export type User = {`. */
const USER_TYPE_SPAN: Span = (() => {
  const at = offsetOf(USERS_TEXT, "User = {");
  return { source: USERS, start: at, end: at + "User".length };
})();

// ------------------------------------------------------------------ hover: contract

Deno.test("hover on a function name prints parameter types, failures, and requirements", () => {
  const hover = hoverAt(examples, USERS, offsetOf(USERS_TEXT, "rename", 2));
  assert(hover !== undefined);
  assertEquals(
    hover.contract,
    "rename(id: UserId, name: Name): User fails StoreUnavailable | UserMissing uses Users.find | Users.save",
  );
  assertEquals(hover.span, spanOf(USERS, "rename"));
  const getUser = hoverAt(examples, USERS, offsetOf(USERS_TEXT, "getUser", 1));
  assert(getUser !== undefined);
  assertEquals(
    getUser.contract,
    "getUser(id: UserId): User fails StoreUnavailable | UserMissing uses Users.find",
  );
  const pure = hoverAt(
    examples,
    "collections.eff",
    offsetOf(FILES["collections.eff"], "total", 1),
  );
  assert(pure !== undefined);
  assertEquals(pure.contract, "total(amounts: Amount[]): Amount");
});

Deno.test("hover on a constant name prints name: type", () => {
  const text = "export const limit: Int = 3\n\ntype Int = int\n";
  const revision = loadModule(text);
  const hover = hoverAt(revision, "m.eff", offsetOf(text, "limit", 1));
  assert(hover !== undefined);
  assertEquals(hover.contract, "limit: Int");
  assertEquals(hover.span, { source: "m.eff", start: 13, end: 18 });
  assertEquals(hover.backend, { tag: "type", text: "Int" });
});

Deno.test("hover on an expression prints its type and sets, and has no backend", () => {
  const call = offsetOf(USERS_TEXT, "getUser(id)\n  const renamed");
  const callee = hoverAt(examples, USERS, call + 2);
  assert(callee !== undefined);
  assertEquals(
    callee.contract,
    "(UserId) => User fails StoreUnavailable | UserMissing uses Users.find",
  );
  assertEquals(callee.backend, undefined);
  assertEquals(callee.span, { source: USERS, start: call, end: call + 7 });
  const argument = hoverAt(examples, USERS, call + 9);
  assert(argument !== undefined);
  assertEquals(argument.contract, "UserId");
  assertEquals(hoverAt(examples, USERS, 0), undefined);
  assertEquals(hoverAt(examples, "nowhere.eff", 0), undefined);
});

Deno.test("hover prints unknown (error) where the checker prints <error>", () => {
  const text = "export const g = (): Int => nope\n\ntype Int = int\n";
  const revision = loadModule(text);
  assert(revision.diagnostics.length > 0);
  const hover = hoverAt(revision, "m.eff", offsetOf(text, "nope", 1));
  assert(hover !== undefined);
  assertEquals(hover.contract, "unknown (error)");
  assertEquals(hover.backend, undefined);
  // The checker text itself has the marker, so the replacement is what matters.
  const table = revision.types;
  assertEquals(table.show(table.error), "<error>");
});

Deno.test("the cursor just after a name selects that name", () => {
  const end = offsetOf(USERS_TEXT, "rename") + "rename".length;
  const hover = hoverAt(examples, USERS, end);
  assert(hover !== undefined);
  assertEquals(hover.span, spanOf(USERS, "rename"));
  assert(hover.contract.startsWith("rename("));
  // A range that starts at the offset wins over a range that ends there.
  const start = hoverAt(examples, USERS, offsetOf(USERS_TEXT, "rename"));
  assert(start !== undefined);
  assertEquals(start.span, spanOf(USERS, "rename"));
});

// ------------------------------------------------------------------ hover: backend

/**
 * The header of a function in a golden file, in a normal form. The text runs from
 * the first `(` after `const <name> =` up to the ` =>` that starts the body. The
 * normal form collapses each run of white space to one space, removes the space
 * after `(` or `<` and before `)` or `>`, and removes a trailing comma before `)`
 * or `>`. The printer may break the header over several lines, and the hover
 * prints it on one line.
 */
function goldenHeader(golden: string, name: string): string {
  const declaration = golden.indexOf(`const ${name} = (`);
  assert(declaration >= 0, `missing ${name} in the golden file`);
  const open = golden.indexOf("(", declaration);
  const end = golden.indexOf(" =>", open);
  return golden.slice(open, end)
    .replace(/\s+/g, " ")
    .replace(/([(<]) /g, "$1")
    .replace(/ ([)>])/g, "$1")
    .replace(/,([)>])/g, "$1");
}

Deno.test("the backend line of each explicit-contract function in users.eff equals its golden header", () => {
  const golden = Deno.readTextFileSync(
    new URL("golden/users.ts", FIXTURES),
  );
  for (const name of ["getUser", "rename", "displayName", "activeNames"]) {
    const hover = hoverAt(examples, USERS, offsetOf(USERS_TEXT, name, 1));
    assert(hover !== undefined, name);
    assert(hover.backend !== undefined, name);
    assertEquals(hover.backend.tag, "type", name);
    if (hover.backend.tag !== "type") continue;
    assertEquals(hover.backend.text, goldenHeader(golden, name), name);
  }
});

Deno.test("the backend header of rename has the parameter names and the Effect type", () => {
  const hover = hoverAt(examples, USERS, offsetOf(USERS_TEXT, "rename", 1));
  assertEquals(hover?.backend, {
    tag: "type",
    text:
      "(id: UserId, name: Name): Effect.Effect<User, StoreUnavailable | UserMissing, Users>",
  });
});

Deno.test("the backend type of a pure function is its plain result type", () => {
  const hover = hoverAt(
    examples,
    "collections.eff",
    offsetOf(FILES["collections.eff"], "total", 1),
  );
  assertEquals(hover?.backend, {
    tag: "type",
    text: "(amounts: ReadonlyArray<Amount>): Amount",
  });
});

Deno.test("an inferred contract prints its backend header from the lowered type", () => {
  const text = "const bump = (n: Int) => n + 1\n\ntype Int = int\n";
  const revision = loadModule(text);
  assertEquals(revision.diagnostics, []);
  const hover = hoverAt(revision, "m.eff", offsetOf(text, "bump", 1));
  assertEquals(hover?.contract, "bump(n: Int): int");
  assertEquals(hover?.backend, {
    tag: "type",
    text: "(n: Int): number",
  });
});

Deno.test("the backend type is unavailable when the module has an error", () => {
  const text = "export const g = (): Int => nope\n\ntype Int = int\n";
  const revision = loadModule(text);
  const hover = hoverAt(revision, "m.eff", offsetOf(text, "g ="));
  assert(hover !== undefined);
  assert(hover.contract.startsWith("g()"));
  assertEquals(hover.backend, { tag: "unavailable" });
});

// ------------------------------------------------------------------ definition

Deno.test("definition of a local goes to the binding", () => {
  const use = offsetOf(USERS_TEXT, "Users.save(renamed)", "Users.save(".length);
  assertEquals(
    definitionAt(examples, USERS, use + 2),
    spanOf(USERS, "renamed"),
  );
});

Deno.test("definition of a parameter goes to the parameter name", () => {
  const at = offsetOf(USERS_TEXT, "getUser(id)\n  const renamed", 9);
  const found = definitionAt(examples, USERS, at);
  assertEquals(found?.source, USERS);
  const start = found?.start ?? -1;
  assertEquals(USERS_TEXT.slice(start, start + 7), "id: Use");
  assertEquals(found?.end, start + 2);
});

Deno.test("definition of a value in the same module goes to its name", () => {
  const at = offsetOf(USERS_TEXT, "getUser(id)\n  const renamed", 2);
  assertEquals(definitionAt(examples, USERS, at), spanOf(USERS, "getUser"));
});

Deno.test("definition of an imported value goes to the other module", () => {
  const main = FILES["main.eff"];
  const at = offsetOf(main, 'displayName("u1")', 3);
  assertEquals(
    definitionAt(examples, "main.eff", at),
    spanOf(USERS, "displayName"),
  );
  // The imported name in the import list goes there too.
  const imported = offsetOf(main, "displayName", 3);
  assertEquals(
    definitionAt(examples, "main.eff", imported),
    spanOf(USERS, "displayName"),
  );
});

Deno.test("definition of a type goes to the type declaration", () => {
  const at = offsetOf(
    USERS_TEXT,
    "(id: UserId): User\n  fails",
    "(id: UserId): ".length + 1,
  );
  assertEquals(definitionAt(examples, USERS, at), USER_TYPE_SPAN);
});

Deno.test("definition of an error goes to the error declaration", () => {
  const at = offsetOf(USERS_TEXT, "fail(UserMissing(", "fail(".length + 2);
  assertEquals(
    definitionAt(examples, USERS, at),
    spanOf(USERS, "UserMissing"),
  );
});

Deno.test("definition of a service goes to the service declaration", () => {
  const at = offsetOf(
    USERS_TEXT,
    "uses Users.find =>\n  match",
    "uses ".length + 1,
  );
  assertEquals(definitionAt(examples, USERS, at), spanOf(USERS, "Users"));
});

Deno.test("definition of a capability goes to the method of the service", () => {
  const at = offsetOf(
    USERS_TEXT,
    "match Users.find(id)",
    "match Users.".length + 1,
  );
  const expected = spanOf(USERS, "find(id: UserId)");
  assertEquals(definitionAt(examples, USERS, at), {
    ...expected,
    end: expected.start + "find".length,
  });
  // The same holds for a name in a uses clause.
  const clause = offsetOf(
    USERS_TEXT,
    "uses Users.find =>",
    "uses Users.".length + 1,
  );
  assertEquals(definitionAt(examples, USERS, clause), {
    ...expected,
    end: expected.start + "find".length,
  });
});

Deno.test("definition of a host provider goes into the interface file", () => {
  const main = FILES["main.eff"];
  const at = offsetOf(main, "provide(UsersLive", "provide(".length + 2);
  const found = definitionAt(examples, "main.eff", at);
  const host = FILES["host/providers.effi"];
  const name = host.indexOf("UsersLive");
  assertEquals(found, {
    source: "host/providers.effi",
    start: name,
    end: name + "UsersLive".length,
  });
});

Deno.test("definition of a builtin, a field, or nothing is undefined", () => {
  const collections = FILES["collections.eff"];
  assertEquals(
    definitionAt(examples, "collections.eff", offsetOf(collections, "map(", 1)),
    undefined,
  );
  assertEquals(
    definitionAt(
      examples,
      "collections.eff",
      offsetOf(collections, "user.name", "user.".length + 1),
    ),
    undefined,
  );
  assertEquals(definitionAt(examples, USERS, 0), undefined);
  assertEquals(definitionAt(examples, "nowhere.eff", 0), undefined);
});

Deno.test("definition accepts a cursor just after a name", () => {
  const call = offsetOf(USERS_TEXT, "getUser(id)\n  const renamed");
  // The offset of `(`: the name ends there.
  assertEquals(
    definitionAt(examples, USERS, call + "getUser".length),
    spanOf(USERS, "getUser"),
  );
  // Past the end of the name and its parenthesis, the offset is on the argument.
  assertEquals(
    definitionAt(examples, USERS, call + "getUser(".length)?.end,
    (definitionAt(examples, USERS, call + "getUser(".length)?.start ?? 0) + 2,
  );
});

// ------------------------------------------------------------------ document symbols

Deno.test("documentSymbols lists the declarations in source order with their kinds", () => {
  const symbols = documentSymbols(examples, USERS, USERS_TEXT);
  assertEquals(
    symbols.map((s) => [s.name, s.kind]),
    [
      ["UserId", "type"],
      ["Name", "type"],
      ["User", "type"],
      ["UserMissing", "error"],
      ["StoreUnavailable", "error"],
      ["Users", "service"],
      ["getUser", "function"],
      ["rename", "function"],
      ["displayName", "function"],
      ["activeNames", "function"],
    ],
  );
  const service = symbols.find((s) => s.name === "Users");
  assertEquals(
    service?.children.map((c) => [c.name, c.kind]),
    [["find", "method"], ["save", "method"], ["all", "method"]],
  );
  const user = symbols.find((s) => s.name === "User");
  assertEquals(user?.nameSpan, USER_TYPE_SPAN);
  assert((user?.span.end ?? 0) > USER_TYPE_SPAN.end);
  assertEquals(
    symbols.every((s) => s.kind === "service" || s.children.length === 0),
    true,
  );
});

Deno.test("documentSymbols marks a non-arrow const as a constant and a provider as a provider", () => {
  const text =
    "export const limit: Int = 3\nexport const f = (): Int => limit\n\ntype Int = int\n";
  const symbols = documentSymbols(loadModule(text), "m.eff", text);
  assertEquals(symbols.map((s) => [s.name, s.kind]), [
    ["limit", "constant"],
    ["f", "function"],
    ["Int", "type"],
  ]);
  const host = FILES["host/providers.effi"];
  assertEquals(
    documentSymbols(examples, "host/providers.effi", host).map((
      s,
    ) => [s.name, s.kind]),
    [["UsersLive", "provider"]],
  );
});

Deno.test("documentSymbols keeps a declaration with a syntax error when its name parsed", () => {
  const text =
    "export const ok = (): Int => 1\ntype Int = int\nexport const broken = (\n";
  const revision = loadModule(text);
  assert(revision.diagnostics.some((d) => d.code.startsWith("syntax/")));
  const symbols = documentSymbols(revision, "m.eff", text);
  assertEquals(symbols.map((s) => [s.name, s.kind]), [
    ["ok", "function"],
    ["Int", "type"],
    // The arrow did not parse, so the index sees a plain const.
    ["broken", "constant"],
  ]);
});

Deno.test("documentSymbols parses the text of a file that the revision lacks or holds with other text", () => {
  const host = FILES["host/providers.effi"];
  // No revision at all: an .effi file that no module imports.
  assertEquals(
    documentSymbols(undefined, "lonely.effi", host).map((s) => s.name),
    ["UsersLive"],
  );
  // The revision holds the file with other text: the open text wins.
  const newer = USERS_TEXT +
    "\ntype Int = int\nexport const extra = (): Int => 1\n";
  const symbols = documentSymbols(examples, USERS, newer);
  assertEquals(symbols[symbols.length - 1].name, "extra");
  // A file that the revision lacks.
  assertEquals(
    documentSymbols(examples, "new.eff", "type T = int\n").map((s) => s.name),
    ["T"],
  );
});

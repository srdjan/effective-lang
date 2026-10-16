import { assert, assertEquals } from "@std/assert";
import { KEYWORDS } from "../src/core/lex.ts";
import {
  GENERATED_CHANGED_METHOD,
  GENERATED_SCHEME,
  GENERATED_TYPESCRIPT_METHOD,
} from "../src/lsp/methods.ts";

const CLIENT = new URL("../editors/vscode/", import.meta.url);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(relative: string): Json {
  const parsed: unknown = JSON.parse(
    Deno.readTextFileSync(new URL(relative, CLIENT)),
  );
  assert(isRecord(parsed), `${relative} must hold a JSON object`);
  return parsed;
}

function field(value: unknown, key: string): unknown {
  assert(isRecord(value), `expected an object that holds "${key}"`);
  return value[key];
}

function list(value: unknown): readonly unknown[] {
  assert(Array.isArray(value), "expected an array");
  return value;
}

/** Collects every `match` regular expression text of a grammar, at any depth. */
function collectMatches(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectMatches);
  if (!isRecord(value)) return [];
  const own = typeof value.match === "string" ? [value.match] : [];
  return own.concat(Object.values(value).flatMap(collectMatches));
}

Deno.test("package.json contributes the effective language and grammar", () => {
  const pkg = readJson("package.json");
  assertEquals(pkg.name, "effective-vscode");
  assertEquals(pkg.main, "./extension.js");
  const contributes = field(pkg, "contributes");

  const languages = list(field(contributes, "languages"));
  assertEquals(languages.length, 1);
  assertEquals(field(languages[0], "id"), "effective");
  assertEquals(field(languages[0], "extensions"), [".eff", ".effi"]);
  assertEquals(field(languages[0], "aliases"), ["Effective"]);
  assertEquals(
    field(languages[0], "configuration"),
    "./language-configuration.json",
  );

  const grammars = list(field(contributes, "grammars"));
  assertEquals(grammars.length, 1);
  assertEquals(field(grammars[0], "scopeName"), "source.effective");
  assertEquals(
    field(grammars[0], "path"),
    "./syntaxes/effective.tmLanguage.json",
  );
  assertEquals(field(grammars[0], "language"), "effective");
});

Deno.test("package.json contributes the command and the four settings", () => {
  const contributes = field(readJson("package.json"), "contributes");

  const commands = list(field(contributes, "commands"));
  assertEquals(commands.length, 1);
  assertEquals(
    field(commands[0], "command"),
    "effective.showGeneratedTypeScript",
  );
  assertEquals(
    field(commands[0], "title"),
    "Effective: Show Generated TypeScript",
  );

  const menus = field(contributes, "menus");
  for (const place of ["editor/title", "commandPalette"]) {
    const entries = list(field(menus, place));
    assertEquals(entries.length, 1);
    assertEquals(field(entries[0], "when"), "editorLangId == effective");
  }

  const properties = field(field(contributes, "configuration"), "properties");
  assert(isRecord(properties));
  assertEquals(Object.keys(properties).sort(), [
    "effective.debounceMs",
    "effective.server.deno",
    "effective.server.repository",
    "effective.writeOnSave",
  ]);
  assertEquals(field(properties["effective.server.deno"], "default"), "deno");
  assertEquals(
    field(properties["effective.server.repository"], "default"),
    "",
  );
  assertEquals(field(properties["effective.writeOnSave"], "default"), true);
  assertEquals(field(properties["effective.debounceMs"], "default"), 0);
  assertEquals(field(properties["effective.debounceMs"], "minimum"), 0);
});

Deno.test("package.json activates on the language and the command", () => {
  const events = list(field(readJson("package.json"), "activationEvents"));
  assert(events.includes("onLanguage:effective"));
  assert(events.includes("onCommand:effective.showGeneratedTypeScript"));
});

Deno.test("the grammar names the scope and every lexer keyword", () => {
  const grammar = readJson("syntaxes/effective.tmLanguage.json");
  assertEquals(grammar.scopeName, "source.effective");
  const words = [
    ...KEYWORDS.keys(),
    // Contextual words of the parser and the prelude names.
    "type",
    "error",
    "service",
    "provider",
    "provides",
    "fails",
    "uses",
    "from",
    "map",
    "filter",
    "fold",
    "retry",
    "provide",
    "fail",
    "some",
    "none",
  ];
  const matchers = collectMatches(grammar).map((match) => new RegExp(match));
  for (const token of [...words, "|>", "=>"]) {
    assert(
      matchers.some((matcher) => matcher.exec(token)?.[0] === token),
      `the grammar must match the whole token "${token}"`,
    );
  }
});

Deno.test("extension.js uses the method names and scheme of the server", () => {
  const source = Deno.readTextFileSync(new URL("extension.js", CLIENT));
  for (
    const value of [
      GENERATED_TYPESCRIPT_METHOD,
      GENERATED_CHANGED_METHOD,
      GENERATED_SCHEME,
    ]
  ) {
    assert(
      source.includes(`"${value}"`),
      `extension.js must hold the string literal "${value}"`,
    );
  }
});

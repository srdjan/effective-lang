// Tests for the declaration index and the content hash.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fnv1a64 } from "../src/core/hash.ts";
import { buildIndex, type DeclEntry } from "../src/core/index.ts";
import { parse } from "../src/core/parse.ts";
import { FIXTURES } from "./helpers.ts";

function indexOf(text: string, path = "m.eff") {
  return buildIndex(parse(path, text).tree);
}

function decl(text: string, name: string): DeclEntry {
  const entry = indexOf(text).byName.get(name);
  assert(entry !== undefined, `no declaration ${name}`);
  return entry;
}

function sliceOf(text: string, span: { start: number; end: number }): string {
  return text.slice(span.start, span.end);
}

Deno.test("fnv1a64 matches the published FNV-1a 64-bit vectors", () => {
  assertEquals(fnv1a64(""), "cbf29ce484222325");
  assertEquals(fnv1a64("a"), "af63dc4c8601ec8c");
  assertEquals(fnv1a64("foobar"), "85944171f73967e8");
});

Deno.test("fnv1a64 hashes UTF-16 code units, so a surrogate pair is two units", () => {
  assertNotEquals(fnv1a64("\u{1F600}"), fnv1a64("\u{1F601}"));
  assertEquals(fnv1a64("\u{1F600}"), fnv1a64("😀"));
});

Deno.test("the index lists the declarations of users.eff with kind and export flag", () => {
  const text = Deno.readTextFileSync(new URL("examples/users.eff", FIXTURES));
  const index = indexOf(text, "users.eff");
  assertEquals(
    index.decls.map((d) => `${d.kind} ${d.name} ${d.exported}`),
    [
      "type UserId true",
      "type Name true",
      "type User true",
      "error UserMissing true",
      "error StoreUnavailable true",
      "service Users true",
      "const getUser true",
      "const rename true",
      "const displayName true",
      "const activeNames true",
    ],
  );
  const users = index.byName.get("Users")!;
  assertEquals([...users.methods.keys()], ["find", "save", "all"]);
  assertEquals(users.methodList.length, 3);
});

Deno.test("a private declaration is not exported", () => {
  const index = indexOf(
    "const a = (): int => 1\nexport const b = (): int => 2\n",
  );
  assertEquals(index.byName.get("a")!.exported, false);
  assertEquals(index.byName.get("b")!.exported, true);
});

Deno.test("for a const arrow the header holds the signature and the body follows =>", () => {
  const text =
    "export const f = (x: int): int\n  fails E\n  uses S.m => x + 1\n";
  const d = decl(text, "f");
  assertEquals(d.isArrow, true);
  assertEquals(
    sliceOf(text, d.headerSpan),
    "export const f = (x: int): int\n  fails E\n  uses S.m",
  );
  assertEquals(sliceOf(text, d.bodySpan), "x + 1");
  assertEquals(sliceOf(text, d.nameSpan), "f");
});

Deno.test("a block body keeps its braces in the body span", () => {
  const text = "const f = (): int => {\n  1\n}\n";
  assertEquals(sliceOf(text, decl(text, "f").bodySpan), "{\n  1\n}");
});

Deno.test("a body edit changes the body hash and keeps the header hash", () => {
  const before = "export const f = (x: int): int => x + 1\n";
  const after = "export const f = (x: int): int => x + 2\n";
  const a = decl(before, "f");
  const b = decl(after, "f");
  assertEquals(a.headerHash, b.headerHash);
  assertNotEquals(a.bodyHash, b.bodyHash);
});

Deno.test("a signature edit changes the header hash and keeps the body hash", () => {
  const a = decl("const f = (x: int): int => x\n", "f");
  const b = decl("const f = (x: int): number => x\n", "f");
  assertNotEquals(a.headerHash, b.headerHash);
  assertEquals(a.bodyHash, b.bodyHash);
});

Deno.test("a non-arrow const and a type split at the equals sign", () => {
  const text =
    "const k: int = 3\ntype T = { a: int }\nerror E = { b: string }\n";
  const k = decl(text, "k");
  assertEquals(k.isArrow, false);
  assertEquals(sliceOf(text, k.headerSpan), "const k: int =");
  assertEquals(sliceOf(text, k.bodySpan), "3");
  assertEquals(sliceOf(text, decl(text, "T").bodySpan), "{ a: int }");
  assertEquals(sliceOf(text, decl(text, "E").bodySpan), "{ b: string }");
});

Deno.test("a service header is its name and its body is the brace block", () => {
  const text = "export service S {\n  a(): int\n  b(x: int): int fails E\n}\n";
  const s = decl(text, "S");
  assertEquals(sliceOf(text, s.headerSpan), "export service S");
  assertEquals(
    sliceOf(text, s.bodySpan),
    "{\n  a(): int\n  b(x: int): int fails E\n}",
  );
  assertEquals(
    sliceOf(text, s.methods.get("b")!.span),
    "b(x: int): int fails E",
  );
});

Deno.test("a provider in an interface file has no body", () => {
  const text = 'import { U } from "./u.eff"\nexport provider P provides U\n';
  const index = indexOf(text, "h.effi");
  const p = index.byName.get("P")!;
  assertEquals(p.kind, "provider");
  assertEquals(sliceOf(text, p.headerSpan), "export provider P provides U");
  assertEquals(p.bodySpan.start, p.bodySpan.end);
});

Deno.test("an import entry holds its names and its decoded specifier", () => {
  const text = 'import { a, b } from "./lib.eff"\nimport { c } from "host:x"\n';
  const imports = indexOf(text).imports;
  assertEquals(imports.length, 2);
  assertEquals(imports[0].names.map((n) => n.name), ["a", "b"]);
  assertEquals(imports[0].specifier, "./lib.eff");
  assertEquals(imports[1].specifier, "host:x");
  assertEquals(sliceOf(text, imports[0].specifierSpan!), '"./lib.eff"');
});

Deno.test("broken declarations are indexed when their name parsed", () => {
  const text =
    "const ok = (): int => 1\nconst broken = (: int =>\nconst after = (): int => 2\n";
  const index = indexOf(text);
  assertEquals(index.decls.map((d) => d.name), ["ok", "broken", "after"]);
  assertEquals(index.byName.get("ok")!.broken, false);
  assertEquals(index.byName.get("broken")!.broken, true);
  assertEquals(index.byName.get("after")!.broken, false);
});

Deno.test("a repeated name keeps the first entry in byName and both in decls", () => {
  const index = indexOf("const a = (): int => 1\nconst a = (): int => 2\n");
  assertEquals(index.decls.length, 2);
  assertEquals(index.byName.get("a")!.node, index.decls[0].node);
});

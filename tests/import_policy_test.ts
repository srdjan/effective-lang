import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkProject, Program } from "../src/core/mod.ts";
import { memoryHost } from "../src/core/source.ts";
import {
  didChangeFull,
  didOpen,
  type Harness,
  makeHarness,
  ROOT,
  uriOf,
  watched,
} from "./lsp_helpers.ts";

type Files = Readonly<Record<string, string>>;

const CLOCK_INTERFACE = `
export type Int = int
export service Clock { now(): Int }
`;

function config(
  imports?: readonly {
    readonly from: string;
    readonly allow: readonly string[];
  }[],
): string {
  return JSON.stringify({
    host: {
      clock: { interface: "./platform/clock.effi", module: "./clock.ts" },
    },
    ...(imports === undefined ? {} : { imports }),
  });
}

function diagnostics(files: Files, entries: readonly string[]) {
  const result = checkProject(memoryHost(files), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value.diagnostics;
}

function latestPublished(harness: Harness, uri: string) {
  return harness.published().filter((published) => published.uri === uri).at(
    -1,
  );
}

Deno.test("import rules allow listed paths and reject direct forbidden edges", () => {
  const files = {
    "effective.json": config([
      { from: "domain/**", allow: ["domain/**"] },
      { from: "feature/**", allow: ["domain/**", "feature/**"] },
      {
        from: "adapter/*",
        allow: ["domain/**", "feature/**", "platform/**", "host:*"],
      },
    ]),
    "domain/model.eff": "export type Id = int\n",
    "feature/read.eff": [
      'import { Id } from "../domain/model.eff"',
      "export const read: Id = 1",
      "",
    ].join("\n"),
    "platform/clock.effi": CLOCK_INTERFACE,
    "adapter/clock.eff": 'import { Clock } from "host:clock"\n',
    "domain/bad.eff": [
      'import { Clock } from "host:clock"',
      'import { read } from "../feature/read.eff"',
      "",
    ].join("\n"),
  };
  const found = diagnostics(files, [
    "feature/read.eff",
    "adapter/clock.eff",
    "domain/bad.eff",
  ]);
  assertEquals(found.map((diagnostic) => diagnostic.code), [
    "module/005",
    "module/005",
  ]);
  const text = files["domain/bad.eff"];
  assertEquals(
    found.map((diagnostic) =>
      text.slice(
        diagnostic.span.start,
        diagnostic.span.end,
      )
    ),
    ['"host:clock"', '"../feature/read.eff"'],
  );
});

Deno.test("the first matching import rule controls the source module", () => {
  const found = diagnostics({
    "effective.json": config([
      { from: "feature/**", allow: ["domain/**"] },
      { from: "feature/special", allow: ["host:*"] },
    ]),
    "platform/clock.effi": CLOCK_INTERFACE,
    "feature/special.eff": 'import { Clock } from "host:clock"\n',
  }, ["feature/special.eff"]);
  assertEquals(found.map((diagnostic) => diagnostic.code), ["module/005"]);
});

Deno.test("one star matches one segment and two stars match descendants", () => {
  const found = diagnostics({
    "effective.json": config([
      { from: "adapter/*", allow: ["host:*"] },
      { from: "adapter/**", allow: [] },
    ]),
    "platform/clock.effi": CLOCK_INTERFACE,
    "adapter/shallow.eff": 'import { Clock } from "host:clock"\n',
    "adapter/deep/clock.eff": 'import { Clock } from "host:clock"\n',
  }, ["adapter/shallow.eff", "adapter/deep/clock.eff"]);
  assertEquals(found.map((diagnostic) => diagnostic.code), ["module/005"]);
  assertEquals(found[0].span.source, "adapter/deep/clock.eff");
});

Deno.test("allowed cyclic imports keep the module cycle diagnostic", () => {
  const found = diagnostics({
    "effective.json": config([{ from: "**", allow: ["**"] }]),
    "a.eff": [
      'import { b } from "./b.eff"',
      "type Int = int",
      "export const a = (): Int => b()",
      "",
    ].join("\n"),
    "b.eff": [
      'import { a } from "./a.eff"',
      "type Int = int",
      "export const b = (): Int => a()",
      "",
    ].join("\n"),
  }, ["a.eff"]);
  assertEquals(
    found.filter((diagnostic) => diagnostic.code.startsWith("module/"))
      .map((diagnostic) => diagnostic.code),
    ["module/003"],
  );
});

Deno.test("an absent policy and an unmatched source preserve unrestricted imports", () => {
  const files = {
    "platform/clock.effi": CLOCK_INTERFACE,
    "loose/main.eff": 'import { Clock } from "host:clock"\n',
  };
  assertEquals(
    diagnostics({ "effective.json": config(), ...files }, ["loose/main.eff"]),
    [],
  );
  assertEquals(
    diagnostics({
      "effective.json": config([
        { from: "domain/**", allow: ["domain/**"] },
      ]),
      ...files,
    }, ["loose/main.eff"]),
    [],
  );
});

Deno.test("import rules reject malformed configuration and glob patterns", () => {
  const malformed: readonly unknown[] = [
    { imports: {} },
    { imports: [{}] },
    { imports: [{ from: 1, allow: [] }] },
    { imports: [{ from: "domain/**", allow: "domain/**" }] },
    { imports: [{ from: "domain/***", allow: ["domain/**"] }] },
    { imports: [{ from: "domain//**", allow: ["domain/**"] }] },
    { imports: [{ from: "domain/**", allow: ["host:**"] }] },
    { imports: [{ from: "domain/main.eff", allow: ["domain/**"] }] },
  ];
  for (const value of malformed) {
    const result = checkProject(
      memoryHost({ "effective.json": JSON.stringify(value) }),
      "",
      [],
    );
    assert(!result.ok, JSON.stringify(value));
    assertEquals(result.error.tag, "invalid-shape");
  }
});

Deno.test("a configuration edit invalidates cached import diagnostics", () => {
  const allowed = config([
    { from: "feature/**", allow: ["domain/model"] },
  ]);
  const forbidden = config([
    { from: "feature/**", allow: ["feature/**"] },
  ]);
  const program = new Program("");
  const first = program.update({
    set: {
      "effective.json": allowed,
      "domain/model.eff": "export type Id = int\n",
      "feature/read.eff": 'import { Id } from "../domain/model.eff"\n',
    },
  });
  assert(first.ok);
  assertEquals(first.value.diagnostics, []);
  const second = program.update({ set: { "effective.json": forbidden } });
  assert(second.ok);
  assertEquals(second.value.diagnostics.map((item) => item.code), [
    "module/005",
  ]);
  assert(second.value.rechecked.includes("feature/read"));
  const third = program.update({ set: { "effective.json": allowed } });
  assert(third.ok);
  assertEquals(third.value.diagnostics, []);
});

Deno.test("the language server republishes policy diagnostics after configuration edits", () => {
  const main = `${ROOT}/feature/read.eff`;
  const mainUri = uriOf(main);
  const allowed = config([
    { from: "feature/**", allow: ["domain/model"] },
  ]);
  const forbidden = config([
    { from: "feature/**", allow: ["feature/**"] },
  ]);
  const text = 'import { Id } from "../domain/model.eff"\n';
  const harness = makeHarness({
    files: {
      [`${ROOT}/effective.json`]: allowed,
      [`${ROOT}/domain/model.eff`]: "export type Id = int\n",
      [main]: text,
      [`${ROOT}/platform/clock.effi`]: CLOCK_INTERFACE,
    },
  });
  harness.start({ writeOnSave: false });
  harness.deliver(didOpen(mainUri, 1, text));
  assertEquals(latestPublished(harness, mainUri)?.diagnostics, []);

  harness.files.set(`${ROOT}/effective.json`, forbidden);
  harness.deliver(watched({
    uri: uriOf(`${ROOT}/effective.json`),
    type: 2,
  }));
  const denied = latestPublished(harness, mainUri)?.diagnostics ?? [];
  assertEquals(denied.map((item) => item.code), ["module/005"]);
  assertStringIncludes(denied[0].message, "domain/model");

  harness.files.set(`${ROOT}/effective.json`, allowed);
  harness.deliver(watched({
    uri: uriOf(`${ROOT}/effective.json`),
    type: 2,
  }));
  assertEquals(latestPublished(harness, mainUri)?.diagnostics, []);
});

Deno.test("the language server republishes policy diagnostics after import edits", () => {
  const main = `${ROOT}/domain/main.eff`;
  const mainUri = uriOf(main);
  const clean = "type Int = int\nexport const answer: Int = 1\n";
  const forbidden = 'import { other } from "../other.eff"\n' + clean;
  const harness = makeHarness({
    files: {
      [`${ROOT}/effective.json`]: config([
        { from: "domain/**", allow: ["domain/**"] },
      ]),
      [main]: clean,
      [`${ROOT}/other.eff`]: "type Int = int\nexport const other: Int = 1\n",
      [`${ROOT}/platform/clock.effi`]: CLOCK_INTERFACE,
    },
  });
  harness.start({ writeOnSave: false });
  harness.deliver(didOpen(mainUri, 1, clean));
  assertEquals(latestPublished(harness, mainUri)?.diagnostics, []);

  harness.deliver(didChangeFull(mainUri, 2, forbidden));
  assertEquals(
    latestPublished(harness, mainUri)?.diagnostics.map((item) => item.code),
    ["module/005"],
  );
  harness.deliver(didChangeFull(mainUri, 3, clean));
  assertEquals(latestPublished(harness, mainUri)?.diagnostics, []);
});

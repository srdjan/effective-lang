// Tests driven by the files under fixtures/.

import { assert, assertEquals } from "@std/assert";
import {
  DIAGNOSTIC_CODES,
  type DiagnosticCode,
  registeredCodes,
} from "../src/core/diagnostics.ts";
import { parse } from "../src/core/parse.ts";
import { printTree } from "../src/core/syntax.ts";
import {
  actualMarkers,
  declSummaries,
  type DeclSummary,
  expectedMarkers,
  type FixtureFile,
  listFixtures,
  modeOfFixture,
  parseFixture,
  readMarkers,
  syntaxCodes,
  treeProblems,
} from "./helpers.ts";

const VALID = [
  ...listFixtures("examples", /\.effi?$/),
  ...listFixtures("ir", /\.effi?$/),
  ...listFixtures("parse", /^ok-.*\.effi?$/),
];
const ERRORS = listFixtures("errors", /\.effi?$/);
const RECOVERY = listFixtures("parse", /^recovery-.*\.eff$/);
const EVERYTHING = [...VALID, ...ERRORS, ...RECOVERY];

Deno.test("fixtures exist in every group", () => {
  assert(VALID.length >= 8, `valid fixtures: ${VALID.length}`);
  assert(ERRORS.length >= syntaxCodes().length - 1);
  assert(RECOVERY.length >= 3);
  const names = VALID.map((f) => f.path);
  for (
    const required of [
      "examples/collections.eff",
      "examples/log.eff",
      "examples/main.eff",
      "examples/pay.eff",
      "examples/users.eff",
      "examples/host/providers.effi",
      "ir/example/log.eff",
    ]
  ) {
    assert(names.includes(required), required);
  }
});

Deno.test("the host interface fixture has exactly the two lines of the plan", () => {
  const providers = VALID.find((f) =>
    f.path === "examples/host/providers.effi"
  )!;
  assertEquals(
    providers.text,
    'import { Users } from "../users.eff"\nexport provider UsersLive provides Users\n',
  );
});

for (const file of VALID) {
  Deno.test(`valid fixture parses with no diagnostics: ${file.path}`, () => {
    const result = parseFixture(file);
    assertEquals(
      result.diagnostics.map((d) => `${d.span.start} ${d.code} ${d.message}`),
      [],
    );
  });
}

for (const file of EVERYTHING) {
  Deno.test(`round trip is byte-equal and the tree is sound: ${file.path}`, () => {
    const result = parseFixture(file);
    assertEquals(printTree(result.tree), file.text);
    assertEquals(treeProblems(result.tree), []);
  });
}

for (const file of [...ERRORS, ...RECOVERY]) {
  Deno.test(`diagnostics match the markers exactly: ${file.path}`, () => {
    const result = parseFixture(file);
    assertEquals(
      actualMarkers(file.text, result.diagnostics),
      expectedMarkers(readMarkers(file.text)),
      result.diagnostics.map((d) => `${d.span.start} ${d.code} ${d.message}`)
        .join("\n"),
    );
  });
}

for (const code of syntaxCodes()) {
  Deno.test(`${code} is produced by an error fixture`, () => {
    const fixtures = ERRORS.filter((f) =>
      readMarkers(f.text).some((m) => m.code === code)
    );
    assert(fixtures.length > 0, `no error fixture marks ${code}`);
    for (const fixture of fixtures) {
      const produced = parseFixture(fixture).diagnostics.filter((d) =>
        d.code === code
      );
      assert(produced.length > 0, `${fixture.path} does not produce ${code}`);
    }
  });
}

Deno.test("every registered code has at least one error fixture", () => {
  const marked = new Set<string>();
  for (const f of ERRORS) {
    for (const m of readMarkers(f.text)) marked.add(m.code);
  }
  for (const code of registeredCodes()) {
    assert(marked.has(code), `${code} has no error fixture`);
  }
});

Deno.test("every marker in an error fixture names a registered code", () => {
  for (const f of ERRORS) {
    for (const m of readMarkers(f.text)) {
      assert(
        m.code in DIAGNOSTIC_CODES,
        `${f.path}: ${m.code} is not registered`,
      );
    }
  }
});

Deno.test("error fixtures are named syntax-*.eff, or .effi for host-file errors", () => {
  for (const f of ERRORS) {
    assert(/^errors\/syntax-[a-z-]+\.effi?$/.test(f.path), f.path);
  }
});

function summary(kind: string, name: string, broken: boolean): DeclSummary {
  return { kind, name, broken };
}

Deno.test("recovery: declarations after a broken one still parse cleanly", () => {
  const byPath = new Map<string, FixtureFile>(RECOVERY.map((f) => [f.path, f]));
  const parsed = (path: string) =>
    declSummaries(parseFixture(byPath.get(path)!).tree);

  assertEquals(parsed("parse/recovery-after-broken-declaration.eff"), [
    summary("ConstDecl", "first", false),
    summary("ConstDecl", "unfinished", true),
    summary("ConstDecl", "second", false),
    summary("ConstDecl", "unclosedCall", true),
    summary("ConstDecl", "third", false),
    summary("TypeDecl", "NoType", true),
    summary("TypeDecl", "Fourth", false),
    summary("Error", "", true),
    summary("ConstDecl", "fifth", false),
    summary("ImportDecl", "a", true),
    summary("ConstDecl", "sixth", false),
    summary("ServiceDecl", "Broken", true),
    summary("ConstDecl", "seventh", false),
  ]);

  assertEquals(parsed("parse/recovery-unclosed-block.eff"), [
    summary("ConstDecl", "outer", true),
    summary("ConstDecl", "after", false),
    summary("ConstDecl", "alsoAfter", false),
  ]);

  assertEquals(parsed("parse/recovery-in-block.eff"), [
    summary("ConstDecl", "f", true),
    summary("ConstDecl", "next", false),
  ]);

  assertEquals(parsed("parse/recovery-in-lists.eff"), [
    summary("ConstDecl", "m", true),
    summary("ConstDecl", "r", true),
    summary("ConstDecl", "call", true),
    summary("ConstDecl", "after", false),
  ]);
});

Deno.test("recovery inside a block keeps the items on both sides of the broken item", () => {
  const file = RECOVERY.find((f) => f.path === "parse/recovery-in-block.eff")!;
  const result = parseFixture(file);
  // The block holds: const a, the broken const b, const c, the junk line x y z, and c.
  const text = printTree(result.tree);
  assertEquals(text, file.text);
  assertEquals(result.diagnostics.length, 2);
});

Deno.test("parsing every prefix of every fixture never throws and always round-trips", () => {
  for (const file of EVERYTHING) {
    const mode = modeOfFixture(file.path);
    const step = Math.max(1, Math.floor(file.text.length / 250));
    for (let n = 0; n <= file.text.length; n += step) {
      const prefix = file.text.slice(0, n);
      const result = parse(file.path, prefix, mode);
      if (printTree(result.tree) !== prefix) {
        throw new Error(
          `${file.path}: prefix of ${n} units does not round-trip`,
        );
      }
      const problems = treeProblems(result.tree);
      if (problems.length > 0) {
        throw new Error(`${file.path}: prefix of ${n} units: ${problems[0]}`);
      }
    }
  }
});

Deno.test("deleting one character anywhere keeps the tree sound", () => {
  for (const file of VALID) {
    const mode = modeOfFixture(file.path);
    const step = Math.max(1, Math.floor(file.text.length / 120));
    for (let i = 0; i < file.text.length; i += step) {
      const mutated = file.text.slice(0, i) + file.text.slice(i + 1);
      const result = parse(file.path, mutated, mode);
      if (printTree(result.tree) !== mutated) {
        throw new Error(
          `${file.path}: deleting offset ${i} does not round-trip`,
        );
      }
      const problems = treeProblems(result.tree);
      if (problems.length > 0) {
        throw new Error(`${file.path}: deleting offset ${i}: ${problems[0]}`);
      }
    }
  }
});

Deno.test("seeded random edits keep the parser total, lossless, and sound", () => {
  let state = 0x2545f491;
  const next = (bound: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % bound;
  };
  const vocabulary = [
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    ",",
    ":",
    ";",
    "\n",
    " ",
    "=>",
    "|>",
    "|",
    "...",
    "?",
    "=",
    "const ",
    "export ",
    "type ",
    "error ",
    "service ",
    "provider ",
    "import ",
    "match ",
    "try ",
    "catch ",
    "if ",
    "else ",
    "fails ",
    "uses ",
    "x",
    "1",
    '"s"',
    "//",
    "/*",
    "-",
    "@",
  ];
  const sources = EVERYTHING.filter((f) => f.text.length > 0);
  for (let i = 0; i < 600; i++) {
    const file = sources[next(sources.length)];
    let text = file.text;
    for (let edit = 1 + next(3); edit > 0; edit--) {
      const at = next(text.length + 1);
      if (next(2) === 0) {
        text = text.slice(0, at) + vocabulary[next(vocabulary.length)] +
          text.slice(at);
      } else {
        text = text.slice(0, at) + text.slice(at + 1 + next(12));
      }
    }
    const result = parse(file.path, text, modeOfFixture(file.path));
    if (printTree(result.tree) !== text) {
      throw new Error(
        `iteration ${i}: no round trip of ${JSON.stringify(text)}`,
      );
    }
    const problems = treeProblems(result.tree);
    if (problems.length > 0) {
      throw new Error(
        `iteration ${i}: ${problems[0]} for ${JSON.stringify(text)}`,
      );
    }
  }
});

Deno.test("code type guard: the registry keys are the diagnostic code type", () => {
  const code: DiagnosticCode = "syntax/001";
  assert(code in DIAGNOSTIC_CODES);
});

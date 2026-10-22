// Fast tests of the command-line tool. They run `main` in process with the
// in-memory doubles of cli_helpers.ts. Nothing touches the file system.

import { assert, assertEquals } from "@std/assert";
import { parseArgs } from "../src/cli/args.ts";
import { debounceBatches } from "../src/host/events.ts";
import { formatDiagnostics } from "../src/cli/format.ts";
import { main } from "../src/cli/main.ts";
import { isSourcePath } from "../src/host/workspace.ts";
import { makeDiagnostic } from "../src/core/diagnostics.ts";
import { exampleFiles, FIXTURES } from "./helpers.ts";
import { memoryIo, under } from "./cli_helpers.ts";

const ROOT = "/proj";
const NO_FILES: Readonly<Record<string, string>> = {};

async function run(
  args: readonly string[],
  files: Readonly<Record<string, string>>,
  setup?: (m: ReturnType<typeof memoryIo>) => void,
) {
  const m = memoryIo(files);
  setup?.(m);
  const code = await main(args, m.io);
  return { code, stdout: m.out.join(""), stderr: m.err.join(""), m };
}

function errorFixture(name: string): string {
  return Deno.readTextFileSync(new URL(`errors/${name}`, FIXTURES));
}

// ------------------------------------------------------------------ arguments

Deno.test("parseArgs reads the commands, the root, and the flags", () => {
  assertEquals(parseArgs(["check"]), {
    ok: true,
    value: { kind: "check", root: "." },
  });
  assertEquals(parseArgs(["check", "p"]), {
    ok: true,
    value: { kind: "check", root: "p" },
  });
  assertEquals(parseArgs(["build", "--tsc", "p", "--validate"]), {
    ok: true,
    value: { kind: "build", root: "p", tsc: true, validate: true },
  });
  assertEquals(parseArgs(["watch", "--tsc"]), {
    ok: true,
    value: { kind: "watch", root: ".", tsc: true },
  });
});

Deno.test("parseArgs rejects an unknown command, an unknown flag, and extra arguments", () => {
  for (
    const args of [
      [],
      ["nope"],
      ["check", "--tsc"],
      ["watch", "--validate"],
      ["build", "--nope"],
      ["build", "a", "b"],
    ]
  ) {
    assertEquals(parseArgs(args).ok, false, args.join(" "));
  }
});

// ------------------------------------------------------------------ check

Deno.test("check on the examples prints no diagnostic and exits 0", async () => {
  const r = await run(["check", ROOT], under(ROOT, exampleFiles()));
  assertEquals(r.code, 0);
  assertEquals(r.stdout, "");
  assertEquals(r.stderr, "5 modules, 0 diagnostics\n");
});

Deno.test("check writes no file", async () => {
  const files = under(ROOT, exampleFiles());
  const r = await run(["check", ROOT], files);
  assertEquals(r.code, 0);
  assertEquals(new Set(r.m.files.keys()), new Set(Object.keys(files)));
});

Deno.test("check uses the current directory as the default root", async () => {
  const r = await run(["check"], under(".", exampleFiles()));
  assertEquals(r.code, 0);
});

Deno.test("check prints one line per diagnostic, with a one-based line and column", async () => {
  const r = await run(["check", ROOT], {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/m.eff`]: errorFixture("type-mismatch-argument-count.eff"),
  });
  assertEquals(r.code, 1);
  assertEquals(
    r.stdout,
    "m.eff:5:3: error type-mismatch/004: the function takes 1 argument, but 2 are given\n",
  );
  assertEquals(r.stderr, "1 module, 1 diagnostic\n");
});

Deno.test("check sorts diagnostics by path, position, and code", async () => {
  const r = await run(["check", ROOT], {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/b.eff`]: errorFixture("syntax-unterminated-string.eff"),
    [`${ROOT}/a.eff`]: errorFixture("type-mismatch-argument-count.eff"),
    [`${ROOT}/sub/c.eff`]: errorFixture("syntax-unterminated-string.eff"),
  });
  assertEquals(r.code, 1);
  const paths = r.stdout.trim().split("\n").map((l) => l.split(":")[0]);
  assertEquals(paths, ["a.eff", "b.eff", "sub/c.eff"]);
});

Deno.test("a column counts UTF-16 code units", () => {
  const text = 'const s = "\u{1F600}" + 1\n';
  const offset = text.indexOf("1");
  const lines = formatDiagnostics(
    [makeDiagnostic("type-mismatch/004", "x", {
      source: "m.eff",
      start: offset,
      end: offset + 1,
    })],
    () => text,
  );
  // "const s = " is 10 units, the quote is 1, the emoji is 2, the quote is 1, " + " is 3.
  assertEquals(lines, ["m.eff:1:18: error type-mismatch/004: x"]);
});

Deno.test("a multi-line message prints on one line", () => {
  const lines = formatDiagnostics(
    [makeDiagnostic("type-mismatch/004", "first\n  second", {
      source: "m.eff",
      start: 0,
      end: 0,
    })],
    () => "x",
  );
  assertEquals(lines, ["m.eff:1:1: error type-mismatch/004: first second"]);
});

Deno.test("the walk finds .eff files in subdirectories and skips dot directories and node_modules", async () => {
  const bad = errorFixture("syntax-unterminated-string.eff");
  const r = await run(["check", ROOT], {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/ok.eff`]: "export const one: Int = 1\n\ntype Int = int\n",
    [`${ROOT}/deep/er/bad.eff`]: bad,
    [`${ROOT}/.hidden/bad.eff`]: bad,
    [`${ROOT}/node_modules/pkg/bad.eff`]: bad,
    [`${ROOT}/deep/.cache/bad.eff`]: bad,
  });
  assertEquals(r.code, 1);
  const paths = r.stdout.trim().split("\n").map((l) => l.split(":")[0]);
  assertEquals(paths, ["deep/er/bad.eff"]);
  // Only ok.eff and deep/er/bad.eff are modules.
  assertEquals(r.stderr, "2 modules, 1 diagnostic\n");
});

Deno.test("isSourcePath accepts sources and the project file, and skips hidden and vendored directories", () => {
  assert(isSourcePath("a.eff"));
  assert(isSourcePath("host/p.effi"));
  assert(isSourcePath("effective.json"));
  assert(!isSourcePath("sub/effective.json"));
  assert(!isSourcePath("a.ts"));
  assert(!isSourcePath(".x/a.eff"));
  assert(!isSourcePath("a/node_modules/b.eff"));
});

// ------------------------------------------------------------------ usage errors

Deno.test("usage and configuration errors exit 2", async () => {
  const good = under(ROOT, exampleFiles());
  const cases: [string, readonly string[], Readonly<Record<string, string>>][] =
    [
      ["no command", [], NO_FILES],
      ["unknown command", ["nope"], good],
      ["unknown flag", ["check", ROOT, "--tsc"], good],
      ["missing root", ["check", "/nowhere"], good],
      ["missing project file", ["check", ROOT], { [`${ROOT}/a.eff`]: "" }],
      ["malformed project file", ["check", ROOT], {
        [`${ROOT}/effective.json`]: "{",
      }],
      ["invalid project file", ["build", ROOT], {
        [`${ROOT}/effective.json`]: "[]",
      }],
    ];
  for (const [title, args, files] of cases) {
    const r = await run(args, files);
    assertEquals(r.code, 2, title);
    assertEquals(r.stdout, "", title);
    assert(r.stderr.length > 0, title);
  }
});

Deno.test("a configuration error names the file and the reason", async () => {
  const r = await run(["check", ROOT], { [`${ROOT}/effective.json`]: "{" });
  assert(
    r.stderr.startsWith("effective: effective.json is not valid JSON"),
    r.stderr,
  );
  const missing = await run(["check", ROOT], { [`${ROOT}/a.eff`]: "" });
  assertEquals(
    missing.stderr,
    "effective: /proj/effective.json does not exist\n",
  );
});

Deno.test("help prints the usage and exits 0", async () => {
  const r = await run(["--help"], NO_FILES);
  assertEquals(r.code, 0);
  assert(r.stdout.startsWith("usage: effective"));
});

// ------------------------------------------------------------------ build

Deno.test("build writes each .ts and .ts.map next to its source", async () => {
  const r = await run(["build", ROOT], under(ROOT, exampleFiles()));
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.stdout, "");
  for (const name of ["collections", "log", "main", "pay", "users"]) {
    const golden = Deno.readTextFileSync(
      new URL(`golden/${name}.ts`, FIXTURES),
    );
    assertEquals(r.m.files.get(`${ROOT}/${name}.ts`), golden);
    const map = r.m.files.get(`${ROOT}/${name}.ts.map`);
    assert(map !== undefined, name);
    assertEquals(JSON.parse(map).file, `${name}.ts`);
  }
  assertEquals(r.stderr, "5 modules, 0 diagnostics, wrote 10 files\n");
});

Deno.test("build writes no host interface file and a second build writes nothing", async () => {
  const first = await run(["build", ROOT], under(ROOT, exampleFiles()));
  assertEquals(first.m.files.has(`${ROOT}/host/providers.ts`), false);
  const again = memoryIo(Object.fromEntries(first.m.files));
  const code = await main(["build", ROOT], again.io);
  assertEquals(code, 0);
  assertEquals(again.err.join(""), "5 modules, 0 diagnostics\n");
});

Deno.test("build writes nothing for a module with an error and keeps its last good file", async () => {
  const files = {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/good.eff`]: "export const one = (): Int => 1\n\ntype Int = int\n",
    [`${ROOT}/bad.eff`]: errorFixture("type-mismatch-argument-count.eff"),
    [`${ROOT}/bad.ts`]: "// the last good file\n",
    [`${ROOT}/bad.ts.map`]: "last good map\n",
  };
  const r = await run(["build", ROOT], files);
  assertEquals(r.code, 1);
  assertEquals(r.m.files.get(`${ROOT}/bad.ts`), "// the last good file\n");
  assertEquals(r.m.files.get(`${ROOT}/bad.ts.map`), "last good map\n");
  assert(r.m.files.has(`${ROOT}/good.ts`));
  assert(r.m.files.has(`${ROOT}/good.ts.map`));
  assertEquals(
    r.stdout,
    "bad.eff:5:3: error type-mismatch/004: the function takes 1 argument, but 2 are given\n",
  );
});

Deno.test("a file that cannot be written gives a note and exit 1", async () => {
  const r = await run(["build", ROOT], under(ROOT, exampleFiles()), (m) => {
    m.unwritable.add(`${ROOT}/pay.ts`);
  });
  assertEquals(r.code, 1);
  assert(
    r.stderr.includes("error: cannot write pay.ts: permission denied"),
    r.stderr,
  );
});

// ------------------------------------------------------------------ build --validate

Deno.test("build --validate on the examples reports nothing", async () => {
  const r = await run(
    ["build", ROOT, "--validate"],
    under(ROOT, exampleFiles()),
  );
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.stdout, "");
});

Deno.test("build --validate accepts a retry pipeline with an effectful left value", async () => {
  const files = {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/m.eff`]: [
      "service S { mk(): () => Int }",
      "export const f = (): Int uses S.mk => S.mk() |> retry({ times: 2 })",
      "",
      "type Int = int",
      "",
    ].join("\n"),
    [`${ROOT}/ok.eff`]: "export const one = (): Int => 1\n\ntype Int = int\n",
  };
  const without = await run(["build", ROOT], files);
  assertEquals(without.code, 0, without.stderr);
  const r = await run(["build", ROOT, "--validate"], files);
  assertEquals(r.code, 0, r.stdout);
  assertEquals(r.stdout, "");
  assert(r.m.files.has(`${ROOT}/m.ts`));
  assert(r.m.files.has(`${ROOT}/ok.ts`));
});

// ------------------------------------------------------------------ build --tsc

const HOST_BOUNDARY_OUTPUT = Deno.readTextFileSync(
  new URL(
    "host-boundary/users-live-missing-method/deno-check-two.txt",
    FIXTURES,
  ),
).replaceAll("file:///work/project/", `file://${ROOT}/`);

Deno.test("build --tsc runs deno check over the generated files and the host module", async () => {
  const r = await run(["build", ROOT, "--tsc"], under(ROOT, exampleFiles()));
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.m.checks.length, 1);
  const request = r.m.checks[0];
  assertEquals(request.cwd, ROOT);
  assertEquals([...request.files].sort(), [
    "collections.ts",
    "log.ts",
    "main.ts",
    "pay.ts",
    "users-live.ts",
    "users.ts",
  ]);
  const config = JSON.parse(request.config);
  assertEquals(config.imports, {
    effect: "npm:effect@4.0.5",
    "@effect/platform-node": "npm:@effect/platform-node@4.0.5",
  });
  assertEquals(config.compilerOptions, {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  });
});

Deno.test("build --tsc prints a host-boundary diagnostic at the import and a host-module diagnostic in the host file", async () => {
  const r = await run(
    ["build", ROOT, "--tsc"],
    under(ROOT, exampleFiles()),
    (m) => {
      m.denoCheckStderr = HOST_BOUNDARY_OUTPUT;
      m.denoCheckCode = 1;
    },
  );
  assertEquals(r.code, 1);
  const lines = r.stdout.trim().split("\n");
  assertEquals(lines.length, 2, r.stdout);
  assert(
    lines[0].startsWith(
      'main.eff:2:10: error host-boundary/001: The host module "providers" does not match its declaration file for UsersLive: TS2375 ',
    ),
    lines[0],
  );
  assertEquals(
    lines[1],
    "users-live.ts:21:14: error host-boundary/001: Type 'string' is not assignable to type 'number'.",
  );
  assertEquals(r.stderr, "5 modules, 2 diagnostics, wrote 10 files\n");
});

Deno.test("build --tsc prints a source error at the .eff position and a generated error at the generated position", async () => {
  // Line 10, column 39 of main.ts is the call `displayName("u1")`, which comes
  // from line 6, column 28 of main.eff. Line 1 is the header, outside every record.
  const output = [
    "TS2322 [ERROR]: Type 'a' is not assignable to type 'b'.",
    '  displayName("u1")',
    "  ~",
    `    at file://${ROOT}/main.ts:10:39`,
    "",
    "TS2304 [ERROR]: Cannot find name 'q'.",
    "  q;",
    "  ~",
    `    at file://${ROOT}/main.ts:1:1`,
    "",
    "error: Type checking failed.",
    "",
  ].join("\n");
  const r = await run(
    ["build", ROOT, "--tsc"],
    under(ROOT, exampleFiles()),
    (m) => {
      m.denoCheckStderr = output;
      m.denoCheckCode = 1;
    },
  );
  assertEquals(r.code, 1);
  assertEquals(r.stdout.trim().split("\n"), [
    "main.eff:6:28: error TS2322: Type 'a' is not assignable to type 'b'.",
    "main.ts:1:1: error TS2304: Cannot find name 'q'.",
  ]);
});

Deno.test("build --tsc sends output that is not a diagnostic to stderr", async () => {
  const output = 'error: Module not found "file:///proj/gone.ts".\n';
  const r = await run(
    ["build", ROOT, "--tsc"],
    under(ROOT, exampleFiles()),
    (m) => {
      m.denoCheckStderr = output;
      m.denoCheckCode = 1;
    },
  );
  assertEquals(r.code, 1);
  assertEquals(r.stdout, "");
  assert(r.stderr.includes("error: Module not found"), r.stderr);
});

Deno.test("build --tsc skips deno check when the build has an error", async () => {
  const files = {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/bad.eff`]: errorFixture("type-mismatch-argument-count.eff"),
  };
  const r = await run(["build", ROOT, "--tsc"], files);
  assertEquals(r.code, 1);
  assertEquals(r.m.checks.length, 0);
  assert(r.stderr.includes("deno check skipped"), r.stderr);
});

// ------------------------------------------------------------------ watch

Deno.test("watch builds once, then rebuilds for each event and prints the rechecked modules", async () => {
  const files = under(ROOT, exampleFiles());
  const m = memoryIo(files);
  const users = `${ROOT}/users.eff`;
  const original = files[users];
  m.script = [
    // A body edit: only users is checked again.
    () => {
      m.files.set(users, original.replace('"Guest"', '"Visitor"'));
    },
    // No change: nothing prints.
    () => {},
    // An interface edit: users, the host interface, and main are checked again.
    () => {
      m.files.set(
        users,
        original.replace(
          "fails StoreUnavailable\n  uses Users.all",
          "fails StoreUnavailable | UserMissing\n  uses Users.all",
        ),
      );
    },
    // A syntax error prints a diagnostic and the loop goes on.
    () => {
      m.files.set(`${ROOT}/pay.eff`, "const broken = (\n");
    },
  ];
  const code = await main(["watch", ROOT], m.io);
  assertEquals(code, 0);
  const err = m.err.join("");
  const rechecked = err.split("\n").filter((l) => l.startsWith("rechecked: "));
  assertEquals(rechecked, [
    "rechecked: collections, users, host/providers, log, main, pay",
    "rechecked: users",
    "rechecked: users, host/providers, main",
    "rechecked: pay",
  ]);
  assert(err.includes(`watching ${ROOT}`));
  assertEquals(
    m.out.join(""),
    "pay.eff:1:17: error syntax/008: expected an expression, found end of file\n",
  );
  // The last edit of users.eff restored the original text, so the last build wrote it.
  assert(m.files.get(`${ROOT}/users.ts`)?.includes('"Guest"'));
});

Deno.test("watch goes on after a broken project file", async () => {
  const files = under(ROOT, exampleFiles());
  const m = memoryIo(files);
  const config = files[`${ROOT}/effective.json`];
  m.script = [
    () => {
      m.files.set(`${ROOT}/effective.json`, "{");
    },
    () => {
      m.files.set(`${ROOT}/effective.json`, config);
    },
  ];
  const code = await main(["watch", ROOT], m.io);
  assertEquals(code, 0);
  const err = m.err.join("");
  assert(err.includes("error: effective.json is not valid JSON"), err);
  const rechecked = err.split("\n").filter((l) => l.startsWith("rechecked: "));
  // The fix brings back the same keys, so the program checks nothing again.
  assertEquals(rechecked, [
    "rechecked: collections, users, host/providers, log, main, pay",
    "rechecked: none",
  ]);
});

Deno.test("watch exits 2 when the project cannot start", async () => {
  const m = memoryIo({ [`${ROOT}/a.eff`]: "" });
  m.script = [() => {}];
  const code = await main(["watch", ROOT], m.io);
  assertEquals(code, 2);
});

Deno.test("watch --tsc runs deno check after each build without errors", async () => {
  const files = under(ROOT, exampleFiles());
  const m = memoryIo(files);
  m.script = [() => {
    m.files.set(`${ROOT}/users.eff`, files[`${ROOT}/users.eff`] + "\n");
  }];
  const code = await main(["watch", ROOT, "--tsc"], m.io);
  assertEquals(code, 0);
  assertEquals(m.checks.length, 2);
});

// ------------------------------------------------------------------ debounce

async function* timed(
  steps: readonly (readonly [number, readonly string[]])[],
): AsyncGenerator<readonly string[]> {
  for (const [wait, paths] of steps) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    yield paths;
  }
}

async function collect(source: AsyncIterable<readonly string[]>) {
  const batches: (readonly string[])[] = [];
  for await (const batch of source) batches.push(batch);
  return batches;
}

Deno.test("debounceBatches joins events that arrive close together", async () => {
  const batches = await collect(
    debounceBatches(
      timed([[1, ["b.eff"]], [2, ["a.eff", "b.eff"]], [80, ["c.eff"]]]),
      30,
    ),
  );
  assertEquals(batches, [["a.eff", "b.eff"], ["c.eff"]]);
});

Deno.test("debounceBatches ends when the source ends", async () => {
  assertEquals(await collect(debounceBatches(timed([]), 10)), []);
});

Deno.test("an unexpected throw is an internal error with exit code 3", async () => {
  const m = memoryIo({ [`${ROOT}/effective.json`]: "{}" });
  const io = {
    ...m.io,
    fs: {
      ...m.io.fs,
      kind: (): never => {
        throw new Error("boom");
      },
    },
  };
  const code = await main(["check", ROOT], io);
  assertEquals(code, 3);
  assertEquals(m.err, ["effective: internal error: boom\n"]);
  assertEquals(m.out, []);
});

// Pins the current behavior, kept by N1: the CLI has no ownership filter, so `build` writes the outputs of a nested project.
Deno.test("build writes the outputs of a module that a nested effective.json owns", async () => {
  const mod = (name: string): string =>
    `type I = int\nexport const ${name}: I = 1\n`;
  const r = await run(["build", ROOT], {
    [`${ROOT}/effective.json`]: "{}",
    [`${ROOT}/a.eff`]: mod("a"),
    [`${ROOT}/inner/effective.json`]: "{}",
    [`${ROOT}/inner/m.eff`]: mod("m"),
  });
  assertEquals(r.code, 0, r.stderr);
  assert(r.m.files.has(`${ROOT}/inner/m.ts`));
  assert(r.m.files.has(`${ROOT}/inner/m.ts.map`));
  assert(r.m.files.has(`${ROOT}/a.ts`));
});

// Slow tests of the command-line tool. Each test starts the real CLI as a
// subprocess with `deno task effective`, as the README shows. Tests that write
// files work in a temporary directory. Nothing is written under fixtures/.

import { assert, assertEquals } from "@std/assert";
import { decodeMappings } from "../src/core/emit/sourcemap.ts";
import { tscConfig } from "../src/cli/tsc.ts";
import { COMPANION_FILES, copyDirectory, FIXTURES } from "./helpers.ts";
import { deno, type Run, withTemporaryDirectory } from "./process_helpers.ts";

const REPOSITORY = new URL("../", import.meta.url).pathname;

async function effective(args: readonly string[]): Promise<Run> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["task", "effective", ...args],
    cwd: REPOSITORY,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function withTemporary<T>(body: (dir: string) => Promise<T>): Promise<T> {
  return withTemporaryDirectory("effective-cli-", body);
}

const MODULES = ["collections", "log", "main", "pay", "users"];

Deno.test("check on fixtures/examples prints nothing and exits 0", async () => {
  const run = await effective(["check", "fixtures/examples"]);
  assertEquals(run.code, 0, run.stderr);
  assertEquals(run.stdout, "");
  assert(run.stderr.includes("6 modules, 0 diagnostics"), run.stderr);
  // The check wrote nothing next to the fixtures.
  for (const name of MODULES) {
    assertEquals(
      Deno.statSync(new URL(`examples/${name}.eff`, FIXTURES)).isFile,
      true,
    );
    let exists = true;
    try {
      Deno.statSync(new URL(`examples/${name}.ts`, FIXTURES));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${name}.ts appeared in fixtures/examples`);
  }
});

Deno.test("check on an error project prints the exact diagnostic line and exits 1", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.copyFileSync(
      new URL("errors/type-mismatch-argument-count.eff", FIXTURES),
      `${dir}/m.eff`,
    );
    const run = await effective(["check", dir]);
    assertEquals(run.code, 1, run.stderr);
    assertEquals(
      run.stdout,
      "m.eff:5:3: error type-mismatch/004: the function takes 1 argument, but 2 are given\n",
    );
    assert(run.stderr.includes("1 module, 1 diagnostic"), run.stderr);
  });
});

Deno.test("a usage error exits 2 and prints nothing on stdout", async () => {
  const unknown = await effective(["nope"]);
  assertEquals(unknown.code, 2);
  assertEquals(unknown.stdout, "");
  assert(unknown.stderr.includes("unknown command `nope`"), unknown.stderr);
  const missing = await effective(["check", "fixtures/does-not-exist"]);
  assertEquals(missing.code, 2);
  const flag = await effective(["check", "fixtures/examples", "--tsc"]);
  assertEquals(flag.code, 2);
});

Deno.test("an invalid effective.json exits 2", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{");
    const run = await effective(["check", dir]);
    assertEquals(run.code, 2);
    assert(run.stderr.includes("effective.json is not valid JSON"), run.stderr);
  });
});

Deno.test("build --tsc --validate writes the golden files and the source maps, and exits 0", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    const run = await effective(["build", dir, "--tsc", "--validate"]);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.stdout, "");
    for (const name of MODULES) {
      assertEquals(
        Deno.readTextFileSync(`${dir}/${name}.ts`),
        Deno.readTextFileSync(new URL(`golden/${name}.ts`, FIXTURES)),
        name,
      );
      const map: unknown = JSON.parse(
        Deno.readTextFileSync(`${dir}/${name}.ts.map`),
      );
      assert(typeof map === "object" && map !== null && "mappings" in map);
      assert(typeof map.mappings === "string");
      assertEquals("version" in map && map.version, 3);
      assert(decodeMappings(map.mappings).ok, name);
    }
    // The CLI left no other file in the project directory.
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names, [
      "collections.eff",
      "collections.ts",
      "collections.ts.map",
      "effective.json",
      "host",
      "log.eff",
      "log.ts",
      "log.ts.map",
      "main.eff",
      "main.ts",
      "main.ts.map",
      "pay.eff",
      "pay.ts",
      "pay.ts.map",
      "users-live.ts",
      "users.eff",
      "users.ts",
      "users.ts.map",
    ]);
  });
});

Deno.test("build --tsc checks the companion module of a host interface, and deno fmt accepts it unchanged", async () => {
  await withTemporary(async (dir) => {
    const files = {
      ...COMPANION_FILES,
      "host.ts": [
        'import { Effect, Layer } from "effect";',
        'import { Boom, Store } from "./host.effi.ts";',
        "",
        "export { Boom, Store };",
        "export type Conn = { readonly name: string };",
        "export const StoreLive = Layer.succeed(",
        "  Store,",
        "  Store.of({",
        '    open: () => Effect.succeed({ name: "c" }),',
        '    fetch: (_c, id) => Effect.succeed({ _tag: "domain#Item" as const, id }),',
        "    token: () =>",
        "      Effect.succeed({",
        '        _tag: "host#Token" as const,',
        '        id: "a",',
        '        handle: "h",',
        "      }),",
        "  }),",
        ");",
        "",
      ].join("\n"),
    };
    for (const [path, text] of Object.entries(files)) {
      Deno.writeTextFileSync(`${dir}/${path}`, text);
    }
    const run = await effective(["build", dir, "--tsc"]);
    assertEquals(run.code, 0, `${run.stdout}${run.stderr}`);
    assert(run.stderr.includes("3 modules, 0 diagnostics"), run.stderr);
    assertEquals(
      Deno.readTextFileSync(`${dir}/host.effi.ts`).split("\n", 1)[0],
      "// Generated from host.effi by the Effective compiler. Do not edit.",
    );
    const map: unknown = JSON.parse(
      Deno.readTextFileSync(`${dir}/host.effi.ts.map`),
    );
    assert(typeof map === "object" && map !== null && "sources" in map);
    assertEquals(map.sources, ["host.effi"]);
    const fmt = await deno(dir, ["fmt", "--check", "host.effi.ts"]);
    assertEquals(fmt.code, 0, `deno fmt --check failed:\n${fmt.stderr}`);
  });
});

Deno.test("build --tsc maps a wrong host module to the import in the .eff file", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    Deno.copyFileSync(
      new URL(
        "host-boundary/users-live-missing-method/users-live.ts",
        FIXTURES,
      ),
      `${dir}/users-live.ts`,
    );
    const run = await effective(["build", dir, "--tsc"]);
    assertEquals(run.code, 1, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assertEquals(lines.length, 1, run.stdout);
    assert(
      lines[0].startsWith(
        'main.eff:2:10: error host-boundary/001: The host module "providers" does not match its declaration file for UsersLive: TS2375',
      ),
      lines[0],
    );
  });
});

Deno.test("build --validate --tsc accepts an effectful retry pipeline", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      "service Jobs { next(): () => Int }\n" +
        "export const run = (): Int uses Jobs.next => Jobs.next() |> retry({ times: 1 })\n" +
        "\ntype Int = int\n",
    );
    const checked = await effective(["check", dir]);
    assertEquals(checked.code, 0, checked.stdout);
    assertEquals(checked.stdout, "");
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assertEquals(built.stdout, "");
    assert(built.stderr.includes("1 module, 0 diagnostics"), built.stderr);
  });
});

Deno.test("build --validate --tsc accepts a custom retry schedule", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "error Stop = {}",
        "service Jobs { next(): Int fails Stop }",
        "export const policy: RetrySchedule<Stop> = retrySchedule((error: Stop, attempt: Int): Option<Int> =>",
        "  if (attempt < 2) { Some(0) } else { None })",
        "export const run = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })",
        "type Int = int",
      ].join("\n"),
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stdout + built.stderr);
  });
});

Deno.test("build --validate --tsc accepts stored Effect values", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "error Stop = {}",
        "service Counter { next(): Int fails Stop }",
        "export const make = (): Effect<Int, Stop, Counter.next> => defer(() => Counter.next())",
        "export const use = (stored: Effect<Int, Stop, Counter.next>): Int fails Stop uses Counter.next => run(stored)",
        "",
        "type Int = int",
        "",
      ].join("\n"),
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stdout + built.stderr);
  });
});

Deno.test("build --validate --tsc accepts array and tuple literals", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      "service S { read(): Int }\n" +
        'export const pair = (): [Int, Text] => [1, "a"]\n' +
        "export const blank = (): Int[] => []\n" +
        "export const loaded = (): Int[] uses S.read => [S.read(), 2]\n" +
        "\ntype Int = int\ntype Text = string\n",
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assertEquals(built.stdout, "");
    const emitted = Deno.readTextFileSync(`${dir}/main.ts`);
    assert(emitted.includes("readonly [Int, Text]"));
    assert(emitted.includes('[1, "a"]'));
    assert(emitted.includes("return [yield* S.use(($s) => $s.read()), 2]"));
  });
});

Deno.test("build --validate --tsc accepts sequential traverse", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("emit/traverse/", FIXTURES), dir);
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assertEquals(built.stdout, "");
    assert(
      Deno.readTextFileSync(`${dir}/traverse.ts`).includes("Effect.forEach"),
    );
  });
});

Deno.test("build --validate --tsc accepts scoped operation records", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "service Files { open(): { read: () => Text, close: () => void } }",
        "export const load = (): Text uses Files.open =>",
        "  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())",
        "",
        "type Text = string",
        "",
      ].join("\n"),
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stderr);
    assert(
      Deno.readTextFileSync(`${dir}/main.ts`).includes(
        "Effect.acquireUseRelease",
      ),
    );
  });
});

Deno.test("build --validate --tsc accepts bounded traversal", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      "export const f = (): Int[] => traverse([1, 2], (n) => n + 1, { concurrency: 2 })\n" +
        "\ntype Int = int\n",
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stderr);
    assert(Deno.readTextFileSync(`${dir}/main.ts`).includes("concurrency: 2"));
  });
});

Deno.test("build --validate --tsc accepts an incremental stream and sink", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "service Source { next(state: Int): Option<[Int, Int]> }",
        "service Consumer { accept(value: Int): void }",
        "const stream = unfold(0, (state) => Source.next(state))",
        "const sink = sinkForEach((value: Int) => Consumer.accept(value))",
        "export const main = (): void uses Source.next | Consumer.accept => runStream(stream, sink)",
        "",
        "type Int = int",
        "",
      ].join("\n"),
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stderr);
    assert(Deno.readTextFileSync(`${dir}/main.ts`).includes("Stream.unfold"));
  });
});

Deno.test("a typed FileSystem host adapter builds and maps package failures", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("host-adapter-files/", FIXTURES), dir);
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stderr);
    Deno.writeTextFileSync(`${dir}/deno.json`, tscConfig());
    Deno.writeTextFileSync(`${dir}/sample.txt`, "hello from Effect\n");
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `
import { Effect } from "effect";
import { main } from "./main.ts";
const value = await Effect.runPromise(main("./sample.txt"));
const missing = await Effect.runPromise(Effect.flip(main("./missing.txt")));
const invalid = await Effect.runPromise(Effect.flip(main("")));
console.log(JSON.stringify({ value, missing: missing._tag, invalid: invalid.message }));
`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "--config",
        "deno.json",
        "--check",
        "run.ts",
      ],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    const result = JSON.parse(new TextDecoder().decode(output.stdout).trim());
    assertEquals(result, {
      value: "hello from Effect\n",
      missing: "files#FileReadError",
      invalid: "invalid path",
    });
  });
});

Deno.test("opaque host handles pass only through borrowed scoped methods", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(
      `${dir}/effective.json`,
      JSON.stringify({
        host: { files: { interface: "./host.effi", module: "./host.ts" } },
      }),
    );
    Deno.writeTextFileSync(
      `${dir}/host.effi`,
      [
        "export opaque type Handle",
        "export type Text = string",
        "export service Files {",
        "  open(): Handle",
        "  read(borrow handle: Handle): Text",
        "  close(borrow handle: Handle): void",
        "}",
        "",
      ].join("\n"),
    );
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        'import { Handle, Text, Files } from "host:files"',
        "const readBorrowed = (borrow handle: Handle): Text uses Files.read => Files.read(handle)",
        "export const load = (): Text uses Files.open | Files.read | Files.close =>",
        "  withResource(() => Files.open(), (handle) => readBorrowed(handle), (handle) => Files.close(handle))",
        "",
      ].join("\n"),
    );
    Deno.writeTextFileSync(
      `${dir}/host.ts`,
      `
import { Context, Effect } from "effect";
export type Handle = { readonly value: string };
export type Text = string;
export let closes = 0;
export class Files extends Context.Service<Files, {
  readonly open: () => Effect.Effect<Handle>;
  readonly read: (handle: Handle) => Effect.Effect<Text>;
  readonly close: (handle: Handle) => Effect.Effect<void>;
}>()("host#Files") {}
`,
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stdout + built.stderr);
    Deno.writeTextFileSync(`${dir}/deno.json`, tscConfig());
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `
import { Effect, Layer } from "effect";
import { Files } from "./host.ts";
import { load } from "./main.ts";
let closes = 0;
const Live = Layer.succeed(Files)({
  open: () => Effect.succeed({ value: "hello" }),
  read: (handle) => Effect.succeed(handle.value),
  close: () => Effect.sync(() => { closes++; }),
});
const value = await Effect.runPromise(load().pipe(Effect.provide(Live)));
console.log(JSON.stringify({ value, closes }));
`,
    );
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", "deno.json", "--check", "run.ts"],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(run.stdout).trim()), {
      value: "hello",
      closes: 1,
    });
  });
});

Deno.test("watch rebuilds when a source changes and prints the rechecked modules", async () => {
  await withTemporary(async (dir) => {
    copyDirectory(new URL("examples/", FIXTURES), dir);
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run=deno",
        `${REPOSITORY}src/cli/main.ts`,
        "watch",
        dir,
      ],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const decoder = new TextDecoder();
    let log = "";
    const reading = (async () => {
      for await (const chunk of child.stderr) log += decoder.decode(chunk);
    })();
    const draining = child.stdout.pipeTo(new WritableStream());
    const until = async (needle: string, from = 0): Promise<number> => {
      for (let i = 0; i < 400; i++) {
        const at = log.indexOf(needle, from);
        if (at >= 0) return at + needle.length;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no "${needle}" in:\n${log}`);
    };
    try {
      const started = await until("watching");
      const users = `${dir}/users.eff`;
      Deno.writeTextFileSync(
        users,
        Deno.readTextFileSync(users).replace('"Guest"', '"Visitor"'),
      );
      const after = await until("rechecked: users\n", started);
      await until("wrote 2 files", after);
      assert(Deno.readTextFileSync(`${dir}/users.ts`).includes("Visitor"));
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await reading;
      await draining;
    }
  });
});

Deno.test("build --validate accepts an inline record type 100 levels deep", async () => {
  await withTemporary(async (dir) => {
    const record = (leaf: string) =>
      "{ a: ".repeat(100) + leaf + " }".repeat(100);
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/m.eff`,
      `export const f = (x: ${record("Num")}): Int => 1\n` +
        `export const g = (y: ${record("Int")}): Int => f(y)\n` +
        "\ntype Int = int\ntype Num = number\n",
    );
    const run = await effective(["build", dir, "--validate"]);
    assertEquals(run.code, 0, run.stderr);
    assert(!run.stderr.includes("validation/"), run.stderr);
  });
});

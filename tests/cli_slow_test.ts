// Slow tests of the command-line tool. Each test starts the real CLI as a
// subprocess with `deno task effective`, as the README shows. Tests that write
// files work in a temporary directory. Nothing is written under fixtures/.

import { assert, assertEquals } from "@std/assert";
import { decodeMappings } from "../src/core/emit/sourcemap.ts";
import { FIXTURES } from "./helpers.ts";

const REPOSITORY = new URL("../", import.meta.url).pathname;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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

function copyDirectory(from: URL, to: string): void {
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    const source = new URL(entry.name + (entry.isDirectory ? "/" : ""), from);
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) copyDirectory(source, target);
    else Deno.copyFileSync(source, target);
  }
}

async function withTemporary<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix: "effective-cli-" });
  try {
    return await body(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

const MODULES = ["collections", "log", "main", "pay", "users"];

Deno.test("check on fixtures/examples prints nothing and exits 0", async () => {
  const run = await effective(["check", "fixtures/examples"]);
  assertEquals(run.code, 0, run.stderr);
  assertEquals(run.stdout, "");
  assert(run.stderr.includes("5 modules, 0 diagnostics"), run.stderr);
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
      "service Jobs { next(): () => int }\n" +
        "export const run = (): int uses Jobs.next => Jobs.next() |> retry({ times: 1 })\n",
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

Deno.test("build --validate --tsc accepts stored Effect values", async () => {
  await withTemporary(async (dir) => {
    Deno.writeTextFileSync(`${dir}/effective.json`, "{}");
    Deno.writeTextFileSync(
      `${dir}/main.eff`,
      [
        "error Stop = {}",
        "service Counter { next(): int fails Stop }",
        "export const make = (): Effect<int, Stop, Counter.next> => defer(() => Counter.next())",
        "export const use = (stored: Effect<int, Stop, Counter.next>): int fails Stop uses Counter.next => run(stored)",
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
      "service S { read(): int }\n" +
        'export const pair = (): [int, string] => [1, "a"]\n' +
        "export const blank = (): int[] => []\n" +
        "export const loaded = (): int[] uses S.read => [S.read(), 2]\n",
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assertEquals(built.stdout, "");
    const emitted = Deno.readTextFileSync(`${dir}/main.ts`);
    assert(emitted.includes("readonly [number, string]"));
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
        "service Files { open(): { read: () => string, close: () => void } }",
        "export const load = (): string uses Files.open =>",
        "  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())",
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
      "export const f = (): int[] => traverse([1, 2], (n) => n + 1, { concurrency: 2 })\n",
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
        "service Source { next(state: int): Option<[int, int]> }",
        "service Consumer { accept(value: int): void }",
        "const stream = unfold(0, (state) => Source.next(state))",
        "const sink = sinkForEach((value: int) => Consumer.accept(value))",
        "export const main = (): void uses Source.next | Consumer.accept => runStream(stream, sink)",
        "",
      ].join("\n"),
    );
    const built = await effective(["build", dir, "--validate", "--tsc"]);
    assertEquals(built.code, 0, built.stderr);
    assert(Deno.readTextFileSync(`${dir}/main.ts`).includes("Stream.unfold"));
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
      `export const f = (x: ${record("number")}): int => 1\n` +
        `export const g = (y: ${record("int")}): int => f(y)\n`,
    );
    const run = await effective(["build", dir, "--validate"]);
    assertEquals(run.code, 0, run.stderr);
    assert(!run.stderr.includes("validation/"), run.stderr);
  });
});

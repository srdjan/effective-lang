// Tests for part A5: the independent IR validator. The tests run through the
// public entries `validateModule` and `validateProject`. Differential tests
// lower the fixture programs and require zero diagnostics. Mutation tests
// change one fact of a lowered IR and require the diagnostic of its area.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { describeCode, registeredCodes } from "../src/core/diagnostics.ts";
import type { Execution, Field, ModuleIR, Type } from "../src/core/ir.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { fits, same, type TypeEnv } from "../src/core/validate/typing.ts";
import { validateProject } from "../src/core/validate_project.ts";
import { buildFixtures } from "../scripts/validate_fixtures.ts";
import {
  diskHost,
  EXAMPLE_ENTRIES,
  FIXTURES,
  validationManifest,
} from "./helpers.ts";

// ------------------------------------------------------------------ helpers

type Obj = Record<string, unknown>;

function segments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}

function at(root: unknown, path: string): unknown {
  let current = root;
  for (const key of segments(path)) {
    current = typeof key === "number"
      ? (current as unknown[])[key]
      : (current as Obj)[key];
  }
  return current;
}

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  assert(last !== undefined);
  let parent = root;
  for (const key of parts) {
    parent = typeof key === "number"
      ? (parent as unknown[])[key]
      : (parent as Obj)[key];
  }
  if (typeof last === "number") (parent as unknown[])[last] = value;
  else (parent as Obj)[last] = value;
}

function copy<T>(value: T): T {
  const result: unknown = JSON.parse(JSON.stringify(value));
  return result as T;
}

interface Lowered {
  readonly modules: ReadonlyMap<string, ModuleIR>;
  readonly sources: ReadonlyMap<string, string>;
}

function lowerDisk(root: string, entries: readonly string[]): Lowered {
  const checked = checkProject(diskHost(), root, entries);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const modules = new Map<string, ModuleIR>();
  for (const [name, result] of lowerProject(checked.value)) {
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    modules.set(name, result.value);
  }
  const sources = new Map<string, string>();
  for (const info of checked.value.analysis.project.modules.values()) {
    sources.set(info.path, info.tree.text);
  }
  return { modules, sources };
}

const EXAMPLES = lowerDisk("examples", EXAMPLE_ENTRIES);
const FORMS = lowerDisk("emit/forms", ["forms.eff", "names.eff"]);

function lowerText(
  text: string,
): { ir: ModuleIR; sources: Map<string, string> } {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const result = lowerProject(checked.value).get("m");
  assert(result?.ok === true);
  return { ir: result.value, sources: new Map([["m.eff", text]]) };
}

Deno.test("Effect construction and execution validate independently", () => {
  const lowered = lowerText(`
error Stop = {}
service Counter { next(): int fails Stop }
const make = (): Effect<int, Stop, Counter.next> =>
  defer(() => Counter.next())
const use = (stored: Effect<int, Stop, Counter.next>): int fails Stop uses Counter.next =>
  run(stored)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const mutated = copy(lowered.ir);
  const make = mutated.declarations.find((d) => d.name === "make");
  assert(make?.kind === "function" && make.body.kind === "defer");
  setAt(make, "body.type.effects.requirements", []);
  assert(codesOf(mutated, lowered.sources).includes("validation/002"));
  const changedFailure = copy(lowered.ir);
  const changedMake = changedFailure.declarations.find((d) =>
    d.name === "make"
  );
  assert(changedMake?.kind === "function" && changedMake.body.kind === "defer");
  setAt(changedMake, "body.type.effects.failures", []);
  assert(codesOf(changedFailure, lowered.sources).includes("validation/002"));
});

Deno.test("run as a pipeline stage validates locally", () => {
  const lowered = lowerText(
    "const f = (stored: Effect<int>): int => stored |> run",
  );
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
});

Deno.test("with-resource validation rejects scoped escape and channel mutation", () => {
  const lowered = lowerText(`
error Stop = {}
service Files { open(): { read: () => string fails Stop, close: () => void } }
const load = (): string fails Stop uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrongId = copy(lowered.ir);
  const one = wrongId.declarations.find((d) => d.name === "load");
  assert(one?.kind === "function" && one.body.kind === "with-resource");
  (one.body as { useBinding: string }).useBinding = "local:m#missing";
  assert(codesOf(wrongId, lowered.sources).includes("validation/006"));

  const escaped = copy(lowered.ir);
  const two = escaped.declarations.find((d) => d.name === "load");
  assert(two?.kind === "function" && two.body.kind === "with-resource");
  const use = two.body.use;
  assert(use.kind === "closure" && use.body.kind === "call");
  const operation = use.body.callee;
  assert(operation.kind === "get" && operation.record.kind === "reference");
  (use as { body: typeof operation.record }).body = operation.record;
  assert(codesOf(escaped, lowered.sources).includes("validation/006"));

  const muted = copy(lowered.ir);
  const three = muted.declarations.find((d) => d.name === "load");
  assert(three?.kind === "function" && three.body.kind === "with-resource");
  (three.body as unknown as { effects: { failures: string[] } }).effects
    .failures = [];
  assert(codesOf(muted, lowered.sources).includes("validation/003"));
});

Deno.test("bounded traversal validation rejects a mutated concurrency bound", () => {
  const lowered = lowerText(
    "const f = (): int[] => traverse([1, 2], (n) => n, { concurrency: 2 })",
  );
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const changed = copy(lowered.ir);
  const functionDecl = changed.declarations.find((d) => d.name === "f");
  assert(
    functionDecl?.kind === "function" && functionDecl.body.kind === "call",
  );
  const options = functionDecl.body.arguments[2];
  assert(
    options?.kind === "record" && options.fields[0]?.value.kind === "literal",
  );
  (options.fields[0].value as { value: number }).value = 0;
  assert(codesOf(changed, lowered.sources).includes("validation/006"));
});

Deno.test("stream validation recomputes deferred and active channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Source { next(state: int): Option<[int, int]> fails Stop }
service Consumer { accept(value: int): void fails Stop }
const numbers = unfold(0, (state) => Source.next(state))
const sink = sinkForEach((value: int) => Consumer.accept(value))
const main = (): void fails Stop uses Source.next | Consumer.accept => runStream(numbers, sink)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const missingDeferred = copy(lowered.ir);
  const numbers = missingDeferred.declarations.find((d) =>
    d.name === "numbers"
  );
  assert(numbers?.kind === "constant" && numbers.value.kind === "unfold");
  (numbers.value.type as unknown as { effects: { failures: string[] } }).effects
    .failures = [];
  assert(codesOf(missingDeferred, lowered.sources).includes("validation/002"));

  const missingActive = copy(lowered.ir);
  const main = missingActive.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "run-stream");
  (main.body as unknown as { effects: { requirements: string[] } }).effects
    .requirements = [];
  assert(codesOf(missingActive, lowered.sources).includes("validation/003"));
});

function codesOf(ir: unknown, sources: ReadonlyMap<string, string>): string[] {
  return [
    ...new Set(validateModule(ir as ModuleIR, sources).map((d) => d.code)),
  ].sort();
}

/** The index of a declaration by name. */
function decl(ir: unknown, name: string): number {
  const found = (at(ir, "declarations") as Obj[]).findIndex((d) =>
    d.name === name
  );
  assert(found >= 0, `no declaration ${name}`);
  return found;
}

const STRING: Type = { kind: "primitive", name: "string" };
const INT: Type = { kind: "primitive", name: "int" };
const NO_EFFECTS = { failures: [], requirements: [] };

/** A fresh copy of a lowered module with one mutation applied. */
function mutated(
  from: Lowered,
  module: string,
  change: (ir: unknown, base: (name: string) => string) => void,
): string[] {
  const ir = copy(from.modules.get(module));
  assert(ir !== undefined);
  change(ir, (name) => `declarations[${decl(ir, name)}]`);
  return codesOf(ir, from.sources);
}

// ------------------------------------------------------------------ registry

Deno.test("the validation category registers one code for each of the eight areas", () => {
  const codes = registeredCodes().filter((c) => c.startsWith("validation/"));
  assertEquals(codes, [
    "validation/001",
    "validation/002",
    "validation/003",
    "validation/004",
    "validation/005",
    "validation/006",
    "validation/007",
    "validation/008",
  ]);
  const names = [
    "Identity",
    "Types",
    "Contracts",
    "Execution",
    "Recovery",
    "Control",
    "Initialization",
    "Serialization",
  ];
  codes.forEach((code, i) => {
    assert(describeCode(code).startsWith(`${names[i]}:`), code);
  });
});

// ------------------------------------------------------------------ independence

Deno.test("src/core/validate imports only ir.ts, source.ts, diagnostics.ts, and its own files", () => {
  const directory = new URL("../src/core/validate/", import.meta.url);
  const own = new Set<string>();
  for (const entry of Deno.readDirSync(directory)) {
    assert(entry.isFile, `unexpected entry ${entry.name}`);
    own.add(`./${entry.name}`);
  }
  const allowed = new Set(["../ir.ts", "../source.ts", "../diagnostics.ts"]);
  const pattern =
    /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let checked = 0;
  for (const entry of Deno.readDirSync(directory)) {
    const text = Deno.readTextFileSync(new URL(entry.name, directory));
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      assert(
        own.has(specifier) || allowed.has(specifier),
        `${entry.name} imports ${specifier}`,
      );
      checked++;
    }
  }
  assert(checked > 10, `only ${checked} imports found`);
  assert(own.size >= 5);
});

// ------------------------------------------------------------------ differential

Deno.test("the five examples validate with zero diagnostics", () => {
  const checked = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(checked.ok);
  const lowered = lowerProject(checked.value);
  const report = validateProject(checked.value.analysis.project, lowered);
  assertEquals([...report.keys()].sort(), [
    "collections",
    "log",
    "main",
    "pay",
    "users",
  ]);
  for (const [name, diagnostics] of report) {
    assertEquals(
      diagnostics.map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

Deno.test("the emitter forms and the log example validate with zero diagnostics", () => {
  for (const [name, ir] of FORMS.modules) {
    assertEquals(
      validateModule(ir, FORMS.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
  const log = lowerDisk("ir", ["example/log.eff"]);
  for (const [name, ir] of log.modules) {
    assertEquals(
      validateModule(ir, log.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

function lowerFiles(
  files: Record<string, string>,
  entries: readonly string[],
): Lowered {
  const checked = checkProject(memoryHost(files), "", entries);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const modules = new Map<string, ModuleIR>();
  for (const [name, result] of lowerProject(checked.value)) {
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    modules.set(name, result.value);
  }
  const sources = new Map<string, string>();
  for (const info of checked.value.analysis.project.modules.values()) {
    sources.set(info.path, info.tree.text);
  }
  return { modules, sources };
}

const EXTRA_PROGRAMS: Readonly<Record<string, Record<string, string>>> = {
  "incremental stream and sink": {
    "effective.json": "{}",
    "m.eff": `
service Source { next(state: int): Option<[int, int]> }
service Consumer { accept(value: int): void }
const source = unfold(0, (state) => Source.next(state))
const mapped = mapEffect(source, (value) => value + 1)
const sink = sinkForEach((value: int) => Consumer.accept(value))
export const main = (): void uses Source.next | Consumer.accept => runStream(mapped, sink)
`,
  },
  "bounded traversal": {
    "effective.json": "{}",
    "m.eff": `
error Stop = {}
service S { step(n: int): int fails Stop }
export const f = (): int[] fails Stop uses S.step =>
  traverse([1, 2], (n) => S.step(n), { concurrency: 2 })
`,
  },
  "scoped operation records": {
    "effective.json": "{}",
    "m.eff": `
error Stop = {}
service Files { open(): { read: () => string fails Stop, close: () => void } }
export const load = (): string fails Stop uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
`,
  },
  "block-local functions, optional fields, and boolean operators": {
    "effective.json": "{}",
    "m.eff": `
type P = { name: string, age?: int }
export const f = (p: P, xs: int[]): int => {
  const double = (n: int): int => n * 2
  const g = (n: int) => double(n) + 1
  const total = xs |> map((x) => g(x)) |> fold(0, (a, b) => a + b)
  const nm = match p.age { Some(a) => a, None => 0 }
  if (nm > 3 && total < 100 || false) { total } else { nm }
}
`,
  },
  "error unions in try and match": {
    "effective.json": "{}",
    "m.eff": `
error A = { a: string }
error B = { b: int }
service S { go(): int fails A | B }
export const f = (): string uses S.go =>
  try { S.go() + 1
 "x" } catch { A(e) => e.a, B(e) => "b" }
export const h = (e: A | B): string => match e { A(x) => x.a, B(y) => "b" }
`,
  },
  "options, equality, and mixed arithmetic": {
    "effective.json": "{}",
    "m.eff": `
export const f = (x: int): Option<int> => Some(x + 1)
export const g = (): Option<string> => None
export const h = (o: Option<int>): int => match o { Some(v) => v, None => 0 }
export const eqs = (a: string, b: string): boolean => a === b || a !== "x"
export const mixed = (a: int, b: number): number => a + b / 2
export const strs = (a: string): string => a + "s"
`,
  },
  "pipeline stages that call, perform, and fail": {
    "effective.json": "{}",
    "m.eff": `
error E = { m: string }
error F = { x: int }
service S {
  all(): int[] fails E
  one(n: int): int
}
const inc = (n: int): int => n + 1
export const f = (): int[] fails E uses S.all => S.all() |> map(inc)
export const g = (n: int): int uses S.one => n |> S.one |> inc
export const k = (): int fails F => F({ x: 1 }) |> fail
`,
  },
};

for (const [title, files] of Object.entries(EXTRA_PROGRAMS)) {
  Deno.test(`extra program validates with zero diagnostics: ${title}`, () => {
    const lowered = lowerFiles(files, ["m.eff"]);
    for (const [name, ir] of lowered.modules) {
      assertEquals(
        validateModule(ir, lowered.sources).map((d) =>
          `${d.code} ${d.message}`
        ),
        [],
        name,
      );
    }
  });
}

Deno.test("a retry stage with an effectful left value validates locally", () => {
  const { ir, sources } = lowerText(
    [
      "service S {",
      "  mk(): () => int",
      "  n(): int",
      "}",
      "const plus = (x: int, y: int): int => x + y",
      "export const f = (): int uses S.mk => S.mk() |> retry({ times: 2 })",
      "export const g = (): int uses S.mk => retry(S.mk(), { times: 2 })",
      "export const h = (): int uses S.mk | S.n => S.mk() |> retry({ times: 2 }) |> plus(S.n())",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const f = ir.declarations[decl(ir, "f")];
  assert(f.kind === "function" && f.body.kind === "block");
  assertEquals(f.body.result.effects.requirements, []);
  assertEquals(f.body.effects.requirements, ["cap:m#S.mk"]);
  const wrong = copy(ir);
  setAt(
    wrong,
    `declarations[${decl(wrong, "f")}].body.result.effects.requirements`,
    ["cap:m#S.mk"],
  );
  assertEquals(codesOf(wrong, sources), ["validation/003"]);
});

Deno.test("array and contextual tuple literals validate with ordered element effects", () => {
  const { ir, sources } = lowerText(
    [
      "service S { read(): int }",
      "const inferred = [1, 2]",
      "export const numbers = (): int[] => inferred",
      'export const pair = (): [int, string] => [1, "a"]',
      "export const blank = (): int[] => []",
      "export const nested = (): int[][] => [[1, 2], [3]]",
      "export const loaded = (): int[] uses S.read => [S.read(), 2]",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const pair = ir.declarations[decl(ir, "pair")];
  assert(pair.kind === "function" && pair.body.kind === "tuple");
  assertEquals(pair.body.elements.length, 2);
  const source = sources.get("m.eff");
  assert(source !== undefined);
  assertEquals(
    source.slice(pair.body.span.start, pair.body.span.end),
    '[1, "a"]',
  );
  const loaded = ir.declarations[decl(ir, "loaded")];
  assert(loaded.kind === "function" && loaded.body.kind === "array");
  assertEquals(loaded.body.elements[0].kind, "perform");
  assertEquals(loaded.body.effects.requirements, ["cap:m#S.read"]);
});

Deno.test("traverse validates callback effects in direct and pipeline calls", () => {
  const { ir, sources } = lowerText(
    [
      "service S {",
      "  all(): int[]",
      "  step(n: int): int",
      "}",
      "export const direct = (xs: int[]): int[] uses S.step => traverse(xs, (n) => S.step(n))",
      "export const piped = (xs: int[]): int[] uses S.step => xs |> traverse((n) => S.step(n))",
      "export const loaded = (): int[] uses S.all | S.step => S.all() |> traverse((n) => S.step(n))",
      "export const pure = (xs: int[]): int[] => traverse(xs, (n) => n + 1)",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const direct = ir.declarations[decl(ir, "direct")];
  assert(direct.kind === "function" && direct.body.kind === "call");
  assertEquals(direct.body.effects.requirements, ["cap:m#S.step"]);
  const wrong = copy(ir);
  setAt(
    wrong,
    `declarations[${decl(wrong, "direct")}].body.effects.requirements`,
    [],
  );
  assertEquals(codesOf(wrong, sources), ["validation/003"]);
});

Deno.test("a provider with acquisition failures validates with zero diagnostics", () => {
  const lowered = lowerFiles({
    "effective.json": JSON.stringify({
      host: {
        providers: { interface: "./host/providers.effi", module: "./live.ts" },
      },
    }),
    "host/providers.effi":
      'import { Db, Down } from "../db.eff"\nexport provider DbLive provides Db fails Down\n',
    "db.eff":
      "export error Down = { why: string }\nexport service Db { q(): int fails Down }\n",
    "m.eff":
      'import { Db, Down } from "./db.eff"\nimport { DbLive } from "host:providers"\nexport const g = (): int fails Down => provide(DbLive, () => Db.q())\nexport const h = (): int fails Down => DbLive |> provide(() => Db.q())\n',
  }, ["db.eff", "m.eff"]);
  assertEquals(lowered.modules.size, 2);
  for (const [name, ir] of lowered.modules) {
    assertEquals(
      validateModule(ir, lowered.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

Deno.test("a provider from a host module carries the service it provides", () => {
  // m imports only the provider L. The interface of host:p carries the
  // service S of s.eff, so the capability in the provider type resolves.
  const lowered = lowerFiles({
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): int }\n",
    "m.eff":
      'import { L } from "host:p"\nexport const g = (): int => provide(L, () => 1)\n',
  }, ["s.eff", "m.eff"]);
  const m = lowered.modules.get("m");
  assert(m !== undefined);
  assertEquals(
    validateModule(m, lowered.sources).map((d) => `${d.code} ${d.message}`),
    [],
  );
});

Deno.test("log.ir.json validates with the source text of log.eff under log.lft", () => {
  const ir: ModuleIR = JSON.parse(
    Deno.readTextFileSync(new URL("ir/example/log.ir.json", FIXTURES)),
  );
  const text = Deno.readTextFileSync(new URL("ir/example/log.eff", FIXTURES));
  assertEquals(
    validateModule(ir, new Map([["log.lft", text]])).map((d) =>
      `${d.code} ${d.message}`
    ),
    [],
  );
});

Deno.test("validateProject skips a module whose lowering gave an error value", () => {
  const checked = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(checked.ok);
  const lowered = new Map(lowerProject(checked.value));
  lowered.set("log", {
    ok: false,
    error: { tag: "unknown-module", module: "log" },
  });
  const report = validateProject(checked.value.analysis.project, lowered);
  assertEquals(report.has("log"), false);
  assertEquals(report.get("main")?.length, 0);
});

// ------------------------------------------------------------------ mutation fixtures

Deno.test("the manifest lists at least eight mutation fixtures and every area", () => {
  const manifest = validationManifest();
  assert(manifest.length >= 8, `only ${manifest.length} fixtures`);
  for (
    const code of registeredCodes().filter((c) => c.startsWith("validation/"))
  ) {
    assert(manifest.some((f) => f.code === code), `no fixture for ${code}`);
  }
});

for (const fixture of validationManifest()) {
  Deno.test(`mutation fixture ${fixture.file} is rejected with ${fixture.code}`, () => {
    const ir: ModuleIR = JSON.parse(
      Deno.readTextFileSync(new URL(`validate/${fixture.file}`, FIXTURES)),
    );
    const sources = new Map<string, string>();
    for (const [id, path] of Object.entries(fixture.sources)) {
      sources.set(id, Deno.readTextFileSync(new URL(path, FIXTURES)));
    }
    const diagnostics = validateModule(ir, sources);
    assertEquals(
      [...new Set(diagnostics.map((d) => d.code))],
      [fixture.code],
      diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"),
    );
    assert(
      diagnostics.some((d) => d.message.startsWith(`${fixture.path}:`)),
      `no message starts with ${fixture.path}: ${
        diagnostics.map((d) => d.message).join("\n")
      }`,
    );
  });
}

Deno.test("the mutation fixtures on disk equal the regenerated fixtures", () => {
  const built = buildFixtures();
  const names = [...built.files.keys()].sort();
  const onDisk: string[] = [];
  for (const entry of Deno.readDirSync(new URL("validate/", FIXTURES))) {
    if (entry.isFile) onDisk.push(entry.name);
  }
  assertEquals(onDisk.sort(), names);
  for (const [name, text] of built.files) {
    assertEquals(
      Deno.readTextFileSync(new URL(`validate/${name}`, FIXTURES)),
      text,
      `${name} is stale; run deno task validate:update`,
    );
  }
});

// ------------------------------------------------------------------ identity

Deno.test("identity: an import binding must target an exported identity", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir) => setAt(ir, "imports[0].bindings[0].target", "value:users#nope"),
    ),
    ["validation/001"],
  );
});

Deno.test("identity: an import payload must declare each exported identity", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir) =>
        (at(ir, "imports[0].exports") as string[]).push("value:users#ghost"),
    ),
    ["validation/001"],
  );
});

Deno.test("identity: a named type must resolve", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) =>
      setAt(
        ir,
        `${base("brand")}.body.brand`,
        "type:forms#Nope",
      )),
    ["validation/001"],
  );
});

Deno.test("identity: two parameters of one function cannot share a local identity", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("mul");
      setAt(ir, `${f}.parameters[1].id`, at(ir, `${f}.parameters[0].id`));
    }),
    ["validation/001"],
  );
});

Deno.test("identity: a local is out of scope after its match arm", () => {
  const { ir, sources } = lowerText(
    "export const f = (o: Option<int>, p: int): int => match o { Some(x) => x, None => p }",
  );
  const copyIr = copy(ir);
  const f = decl(copyIr, "f");
  const arms = `declarations[${f}].body.arms`;
  // The None arm now refers to the binding x of the Some arm.
  setAt(
    copyIr,
    `${arms}[1].body.target`,
    at(copyIr, `${arms}[0].pattern.binding.id`),
  );
  assert(codesOf(copyIr, sources).includes("validation/001"));
});

Deno.test("identity: a builtin may appear only as a callee", () => {
  const codes = mutated(EXAMPLES, "collections", (ir, base) => {
    const f = base("total");
    const id = at(ir, `${f}.body.result.callee.target`);
    // The accumulator argument becomes a reference to the builtin.
    setAt(ir, `${f}.body.result.arguments[1]`, {
      kind: "reference",
      target: id,
      type: at(ir, `${f}.body.result.callee.type`),
      execution: "pure",
      effects: NO_EFFECTS,
      span: at(ir, `${f}.body.result.arguments[1].span`),
    });
  });
  assert(codes.includes("validation/001"));
});

// ------------------------------------------------------------------ types

Deno.test("types: the result type of an operator is recomputed", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("mul")}.body.type`, {
          kind: "primitive",
          name: "number",
        }),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mul")}.body.operator`, "&&"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a condition must be boolean", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("cond")}.body.condition`, {
          kind: "literal",
          value: 1,
          type: INT,
          execution: "pure",
          effects: NO_EFFECTS,
          span: at(ir, `${base("cond")}.body.condition.span`),
        }),
    ),
    ["validation/002"],
  );
});

Deno.test("types: both branches fit the recorded type of an if", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("cond")}.body.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a field read has the field type, wrapped in Option when optional", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("nick")}.body.type`, STRING),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("nick")}.body.field`, "missing"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a record update names a field of the base", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("prof")}.body.fields[0].name`, "bogus"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a brand construction needs a brand and a value of its base", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("brand")}.body.brand`, "type:forms#Status"),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("brand");
      setAt(ir, `${f}.body.value`, {
        kind: "literal",
        value: 1,
        type: INT,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${f}.body.value.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: a pattern must belong to the subject", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("extent2")}.body.arms[0].pattern.value`, "triangle"),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("lookup");
      setAt(ir, `${f}.body.arms[1].pattern`, {
        kind: "literal",
        value: 1,
        span: at(ir, `${f}.body.arms[1].pattern.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: a call has the argument count and the argument types of its callee", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("hoist");
      const left = `${f}.body.left`;
      // Store.count() gets an extra argument.
      (at(ir, `${left}.arguments`) as unknown[]).push({
        kind: "literal",
        value: 1,
        type: INT,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${left}.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: fail has the type never", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mkEmpty")}.body.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a function parameter type equals its declared parameter type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mul")}.type.parameters[0]`, STRING),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a recursive type is rejected", () => {
  const { ir, sources } = lowerText(
    "type A = { n: int }\nexport const f = (a: A): int => a.n",
  );
  const copyIr = copy(ir);
  setAt(copyIr, "declarations[0].definition.type.fields[0].type", {
    kind: "named",
    id: "type:m#A",
  });
  assert(codesOf(copyIr, sources).includes("validation/002"));
});

Deno.test("types: a pattern binding has the element type of its subject", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("lookup")}.body.arms[0].pattern.binding.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a block binding holds a value of its type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("blockF")}.body.steps[0].binding.type`, STRING),
    ),
    ["validation/002"],
  );
});

Deno.test("types: every arm of a match fits the recorded type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("lit")}.body.type`, STRING),
    ),
    ["validation/002"],
  );
});

// ------------------------------------------------------------------ contracts

Deno.test("contracts: recorded sets equal the recomputed sets", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("hoist")}.body.effects.requirements`, []),
    ),
    ["validation/003"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("hoist")}.body.effects.failures`, [
          "error:forms#Other",
        ]),
    ),
    ["validation/003"],
  );
});

Deno.test("contracts: provide removes the supplied capabilities", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir, base) =>
        setAt(ir, `${base("main")}.body.effects.requirements`, [
          "cap:users#Users.find",
        ]),
    ),
    ["validation/003"],
  );
});

Deno.test("contracts: an inferred function records exactly its body sets", () => {
  const { ir, sources } = lowerText(
    "service S { go(): int }\nconst inc = (x: int) => x + S.go()\nexport const f = (x: int): int uses S.go => inc(x)",
  );
  assertEquals(codesOf(ir, sources), []);
  const copyIr = copy(ir);
  const f = decl(copyIr, "inc");
  assertEquals(at(copyIr, `declarations[${f}].contract`), "inferred");
  setAt(copyIr, `declarations[${f}].type.effects.requirements`, []);
  assert(codesOf(copyIr, sources).includes("validation/003"));
});

// ------------------------------------------------------------------ execution

Deno.test("execution: a closure type keeps the mode of its body", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(
          ir,
          `${base("mkBox")}.body.fields[0].value.type.execution`,
          "effect",
        ),
    ),
    ["validation/004"],
  );
});

Deno.test("execution: a builtin callback is pure", () => {
  const codes = mutated(FORMS, "forms", (ir, base) => {
    const f = base("fnArg");
    const closure = `${f}.body.steps[0].value`;
    void closure;
    const call = `${f}.body.result`;
    setAt(ir, `${call}.arguments[1].type.execution`, "effect");
  });
  assert(codes.includes("validation/004"), codes.join());
});

Deno.test("execution: a prelude callback with an effect mode is rejected", () => {
  const codes = mutated(
    EXAMPLES,
    "collections",
    (ir) =>
      setAt(ir, "imports[0].values[0].type.parameters[1].execution", "effect"),
  );
  assert(codes.includes("validation/004"), codes.join());
});

Deno.test("execution: constructing a closure is pure", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("mkBox")}.body.fields[0].value.execution`, "effect"),
    ),
    ["validation/004"],
  );
});

// ------------------------------------------------------------------ recovery

Deno.test("recovery: a tag with two handlers is rejected", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("lookup2");
      setAt(ir, `${f}.body.handlers[1].error`, "error:forms#NotFound");
      setAt(ir, `${f}.body.handlers[1].binding.type`, {
        kind: "named",
        id: "error:forms#NotFound",
      });
    }),
    ["validation/005"],
  );
});

Deno.test("recovery: handler results fit the recorded type of the catch", () => {
  const codes = mutated(
    FORMS,
    "forms",
    (ir, base) => setAt(ir, `${base("caught")}.body.type`, INT),
  );
  assert(codes.includes("validation/005"), codes.join());
});

// ------------------------------------------------------------------ control

Deno.test("control: a retry count is a finite nonnegative safe integer", () => {
  for (const times of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(
      mutated(
        FORMS,
        "forms",
        (ir, base) => setAt(ir, `${base("retried")}.body.times`, times),
      ),
      ["validation/006"],
      String(times),
    );
  }
});

Deno.test("control: the provider of provide has a provider type", () => {
  assertEquals(
    mutated(EXAMPLES, "main", (ir, base) => {
      const f = base("main");
      setAt(ir, `${f}.body.provider`, {
        kind: "literal",
        value: "UsersLive",
        type: STRING,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${f}.body.provider.span`),
      });
    }),
    ["validation/006"],
  );
});

// ------------------------------------------------------------------ serialization

Deno.test("serialization: a duplicate in an effect set is rejected, and only once as a set problem", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "log",
      (ir, base) =>
        setAt(ir, `${base("log")}.body.effects.failures`, [
          "error:log#ConsoleUnavailable",
          "error:log#ConsoleUnavailable",
        ]),
    ),
    ["validation/008"],
  );
});

Deno.test("serialization: the source texts must be supplied", () => {
  const ir = EXAMPLES.modules.get("log");
  assert(ir !== undefined);
  assertEquals(codesOf(ir, new Map()), ["validation/008"]);
});

Deno.test("serialization: a span stops at the end of its text", () => {
  const ir = copy(EXAMPLES.modules.get("log"));
  const text = EXAMPLES.sources.get("log.eff") ?? "";
  const f = decl(ir, "log");
  setAt(ir, `declarations[${f}].body.span.end`, text.length);
  assertEquals(codesOf(ir, EXAMPLES.sources), []);
  setAt(ir, `declarations[${f}].body.span.end`, text.length + 1);
  assertEquals(codesOf(ir, EXAMPLES.sources), ["validation/008"]);
  setAt(ir, `declarations[${f}].body.span.start`, -1);
  assertEquals(codesOf(ir, EXAMPLES.sources), ["validation/008"]);
});

Deno.test("serialization: a literal must be finite", () => {
  const { ir, sources } = lowerText("export const f = (): int => 1");
  const copyIr = copy(ir);
  const f = decl(copyIr, "f");
  setAt(copyIr, `declarations[${f}].body.value`, Number.POSITIVE_INFINITY);
  assert(codesOf(copyIr, sources).includes("validation/008"));
});

Deno.test("an IR with a wrong shape gives a diagnostic and not an exception", () => {
  const ir = copy(EXAMPLES.modules.get("log"));
  setAt(ir, "declarations[2].body.arguments", null);
  assert(codesOf(ir, EXAMPLES.sources).includes("validation/008"));
});

Deno.test("a wrong shape in a declaration header or an import gives a diagnostic", () => {
  const nullDeclaration = copy(EXAMPLES.modules.get("log"));
  setAt(nullDeclaration, "declarations[0]", null);
  assertEquals(codesOf(nullDeclaration, EXAMPLES.sources), ["validation/008"]);
  const users = EXAMPLES.modules.get("users");
  const service = users?.declarations.findIndex((d) => d.kind === "service");
  assert(service !== undefined && service >= 0);
  const noMethods = copy(users);
  setAt(noMethods, `declarations[${service}].methods`, undefined);
  assertEquals(codesOf(noMethods, EXAMPLES.sources), ["validation/008"]);
});

// ------------------------------------------------------------------ type compatibility

const ENV: TypeEnv = {
  aliases: new Map<string, Type>([
    ["type:m#Alias", { kind: "primitive", name: "string" }],
    ["type:m#Status", {
      kind: "union",
      members: [
        { kind: "literal", value: "pending" },
        { kind: "literal", value: "paid" },
      ],
    }],
  ]),
  brands: new Map<string, Type>([["type:m#Id", STRING]]),
  errors: new Map<string, readonly Field[]>(),
};

function fn(
  execution: Execution,
  parameters: Type[],
  result: Type,
  failures: string[] = [],
): Type {
  return {
    kind: "function",
    execution,
    parameters,
    result,
    effects: {
      failures: failures as never[],
      requirements: [],
    },
  };
}

function lit(value: string | number | boolean): Type {
  return { kind: "literal", value };
}

const NUMBER: Type = { kind: "primitive", name: "number" };
const NEVER: Type = { kind: "primitive", name: "never" };
const UNKNOWN: Type = { kind: "primitive", name: "unknown" };

Deno.test("compatibility: primitives, literals, aliases, and brands", () => {
  assert(fits(ENV, INT, NUMBER));
  assert(!fits(ENV, NUMBER, INT));
  assert(fits(ENV, lit(1), INT));
  assert(!fits(ENV, lit(1.5), INT));
  assert(fits(ENV, lit(1.5), NUMBER));
  assert(fits(ENV, lit("a"), STRING));
  assert(!fits(ENV, lit("a"), INT));
  assert(fits(ENV, { kind: "named", id: "type:m#Alias" }, STRING));
  assert(fits(ENV, STRING, { kind: "named", id: "type:m#Alias" }));
  assert(fits(ENV, lit("paid"), { kind: "named", id: "type:m#Status" }));
  assert(!fits(ENV, lit("late"), { kind: "named", id: "type:m#Status" }));
  const id: Type = { kind: "named", id: "type:m#Id" };
  assert(fits(ENV, id, id));
  assert(!fits(ENV, STRING, id));
  assert(!fits(ENV, id, STRING));
});

Deno.test("compatibility: never fits everything and unknown is not a top type", () => {
  assert(fits(ENV, NEVER, INT));
  assert(fits(ENV, NEVER, UNKNOWN));
  assert(!fits(ENV, INT, UNKNOWN));
  assert(fits(ENV, UNKNOWN, UNKNOWN));
  assert(!fits(ENV, UNKNOWN, INT));
});

Deno.test("compatibility: records need equal field names and flags, in any order", () => {
  const rec = (...fields: [string, Type, boolean?][]): Type => ({
    kind: "record",
    fields: fields.map(([name, type, optional]) => ({
      name,
      type,
      optional: optional ?? false,
    })),
  });
  assert(
    fits(
      ENV,
      rec(["a", INT], ["b", STRING]),
      rec(["b", STRING], ["a", NUMBER]),
    ),
  );
  assert(!fits(ENV, rec(["a", INT], ["b", STRING]), rec(["a", INT])));
  assert(!fits(ENV, rec(["a", INT]), rec(["a", INT, true])));
  assert(!fits(ENV, rec(["a", INT]), rec(["b", INT])));
});

Deno.test("compatibility: arrays, options, tuples, and unions are covariant", () => {
  assert(
    fits(ENV, { kind: "array", element: INT }, {
      kind: "array",
      element: NUMBER,
    }),
  );
  assert(
    !fits(ENV, { kind: "array", element: NUMBER }, {
      kind: "array",
      element: INT,
    }),
  );
  assert(
    fits(ENV, { kind: "option", element: NEVER }, {
      kind: "option",
      element: INT,
    }),
  );
  assert(fits(
    ENV,
    { kind: "tuple", elements: [INT, lit("a")] },
    { kind: "tuple", elements: [NUMBER, STRING] },
  ));
  assert(
    !fits(
      ENV,
      { kind: "tuple", elements: [INT] },
      { kind: "tuple", elements: [INT, INT] },
    ),
  );
  const either: Type = { kind: "union", members: [INT, STRING] };
  assert(fits(ENV, INT, either));
  assert(
    fits(ENV, either, { kind: "union", members: [NUMBER, STRING, NEVER] }),
  );
  assert(!fits(ENV, either, INT));
});

Deno.test("compatibility: functions are contravariant in parameters and covariant in results", () => {
  assert(fits(ENV, fn("pure", [NUMBER], INT), fn("pure", [INT], NUMBER)));
  assert(!fits(ENV, fn("pure", [INT], INT), fn("pure", [NUMBER], INT)));
  assert(!fits(ENV, fn("pure", [], NUMBER), fn("pure", [], INT)));
  assert(!fits(ENV, fn("pure", [INT], INT), fn("pure", [], INT)));
});

Deno.test("compatibility: effect sets must be subsets", () => {
  assert(
    fits(ENV, fn("effect", [], INT), fn("effect", [], INT, ["error:m#E"])),
  );
  assert(
    !fits(ENV, fn("effect", [], INT, ["error:m#E"]), fn("effect", [], INT)),
  );
});

Deno.test("compatibility: the lift applies only at the top of a value position", () => {
  const pure = fn("pure", [INT], INT);
  const effect = fn("effect", [INT], INT);
  assert(fits(ENV, pure, effect), "top of a value");
  assert(!fits(ENV, effect, pure), "an effect function never fits a pure type");
  const arrayOf = (t: Type): Type => ({ kind: "array", element: t });
  assert(!fits(ENV, arrayOf(pure), arrayOf(effect)), "array element");
  const option = (t: Type): Type => ({ kind: "option", element: t });
  assert(!fits(ENV, option(pure), option(effect)), "option element");
  const record = (t: Type): Type => ({
    kind: "record",
    fields: [{ name: "run", type: t, optional: false }],
  });
  assert(!fits(ENV, record(pure), record(effect)), "record field");
  assert(
    !fits(ENV, fn("pure", [pure], INT), fn("pure", [effect], INT)),
    "a function parameter",
  );
  assert(
    !fits(ENV, fn("pure", [], pure), fn("pure", [], effect)),
    "a function result",
  );
  assert(
    !fits(ENV, { kind: "union", members: [pure] }, effect),
    "a union member",
  );
  assert(same(ENV, pure, pure));
  assert(!same(ENV, pure, effect));
});

Deno.test("a field read and a record update through a record brand validate", () => {
  const lowered = lowerText(`
type UserId = Brand<string>
type User = Brand<{ id: UserId, name: string, active: boolean, nickname?: string }>
const nameOf = (user: User): string => user.name
const nick = (user: User): string =>
  match user.nickname {
    Some(n) => n,
    None => "none"
  }
const activate = (user: User): User => ({ ...user, active: true })
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const mutated = copy(lowered.ir);
  const nameOf = mutated.declarations.find((d) => d.name === "nameOf");
  assert(nameOf?.kind === "function" && nameOf.body.kind === "get");
  setAt(nameOf, "body.field", "missing");
  assertEquals(codesOf(mutated, lowered.sources), ["validation/002"]);
});

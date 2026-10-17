// Tests for part A6a: the Effect-TS emitter. The tests run through the public
// entries `emitModule` and `emitProject` and compare the emitted text.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { emitModule, emitProject } from "../src/core/emit/emit.ts";
import { relativeSpecifier } from "../src/core/emit/scope.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import {
  emitExamples,
  emitFiles,
  EXAMPLE_ENTRIES,
  FIXTURES,
  projectFiles,
} from "./helpers.ts";

function oneModule(text: string): string {
  const files = { "effective.json": "{}", "m.eff": text };
  const emitted = emitFiles(files, ["m.eff"]).get("m");
  assert(emitted !== undefined, "module m was not emitted");
  return emitted.text;
}

function indexOfOrFail(text: string, needle: string): number {
  const at = text.indexOf(needle);
  assert(at >= 0, `the text does not contain ${needle}`);
  return at;
}

Deno.test("withResource emits acquireUseRelease with suspended callbacks", () => {
  const output = oneModule(`
service Files { open(): { read: () => string, close: () => void } }
export const load = (): string uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
`);
  assertStringIncludes(output, "Effect.acquireUseRelease(");
  assertStringIncludes(output, "Effect.suspend(() =>");
  assertStringIncludes(output, "file.read()");
  assertStringIncludes(output, "file.close()");
});

Deno.test("bounded traverse passes the concurrency literal to Effect.forEach", () => {
  const output = oneModule(
    `const f = (): int[] => traverse([1, 2], (n) => n + 1, { concurrency: 2 })`,
  );
  assertStringIncludes(output, "Effect.forEach([1, 2]");
  assertStringIncludes(output, "concurrency: 2");
});

Deno.test("stream operations emit the Effect 4 Stream and Sink APIs", () => {
  const output = oneModule(`
service Source { next(state: int): Option<[int, int]> }
service Consumer { accept(value: int): void }
const source = unfold(0, (state) => Source.next(state))
const mapped = mapEffect(source, (value) => value + 1)
const sink = sinkForEach((value: int) => Consumer.accept(value))
export const main = (): void uses Source.next | Consumer.accept => runStream(mapped, sink)
`);
  assertStringIncludes(output, "Stream.unfold(");
  assertStringIncludes(output, "Option.getOrUndefined");
  assertStringIncludes(output, "Stream.mapEffect(");
  assertStringIncludes(output, "Sink.forEach(");
  assertStringIncludes(output, "Stream.run(mapped, sink)");
});

Deno.test("defer stores an Effect and run executes it in an effect function", () => {
  const output = oneModule(`
error Stop = {}
service Counter { next(): int fails Stop }
export const make = (): Effect<int, Stop, Counter.next> =>
  defer(() => Counter.next())
export const twice = (stored: Effect<int, Stop, Counter.next>): int fails Stop uses Counter.next => {
  const first = run(stored)
  const second = run(stored)
  first + second
}
`);
  assertStringIncludes(output, "Effect.suspend(");
  assertStringIncludes(output, "yield* stored");
  assertStringIncludes(output, "Effect.Effect<number, Stop, Counter>");
});

// ------------------------------------------------------------------ golden

Deno.test("each example emits exactly its golden file", () => {
  const emitted = emitExamples();
  assertEquals([...emitted.keys()].sort(), [
    "collections",
    "log",
    "main",
    "pay",
    "users",
  ]);
  for (const [name, module] of emitted) {
    const golden = Deno.readTextFileSync(
      new URL(`golden/${name}.ts`, FIXTURES),
    );
    assertEquals(module.text, golden, `golden file ${name}.ts differs`);
    assertEquals(module.path, `${name}.ts`);
  }
});

Deno.test("traverse emits exactly its golden file", () => {
  const emitted = emitFiles(
    projectFiles("emit/traverse"),
    ["traverse.eff"],
  ).get("traverse");
  assert(emitted !== undefined);
  assertEquals(
    emitted.text,
    Deno.readTextFileSync(new URL("golden/traverse.ts", FIXTURES)),
  );
});

Deno.test("emitting twice gives identical text", () => {
  const first = emitExamples();
  const second = emitExamples();
  for (const [name, module] of first) {
    assertEquals(second.get(name)?.text, module.text);
  }
  const forms = projectFiles("emit/forms");
  assertEquals(
    emitFiles(forms, ["forms.eff"]).get("forms")?.text,
    emitFiles(forms, ["forms.eff"]).get("forms")?.text,
  );
});

Deno.test("a record brand emits field reads and updates that keep the brand", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), [
    "nominal-records.eff",
  ]).get("nominal-records");
  assert(emitted !== undefined, "module nominal-records was not emitted");
  const text = emitted.text;
  assertStringIncludes(text, '.pipe(Schema.brand("nominal-records#User"))');
  assertStringIncludes(text, "(user: User): string => user.name;");
  // An optional field read through the brand becomes an Option.
  assertStringIncludes(text, "Option.fromUndefinedOr(user.nickname)");
  // The update is a plain spread; it keeps the brand in the TypeScript type.
  assertStringIncludes(text, "({ ...user, active: true })");
  assertStringIncludes(text, "User.make({ id: UserId.make(");
});

// ------------------------------------------------------------------ names

Deno.test("a module that declares generated names still emits valid names", () => {
  const emitted = emitFiles(projectFiles("emit/forms"), ["names.eff"]).get(
    "names",
  );
  assert(emitted !== undefined, "module names was not emitted");
  const text = emitted.text;
  // The helper takes the next free name and leaves the source names alone.
  assertStringIncludes(
    text,
    "const f = ($t0: number, $int: number): number =>",
  );
  assertStringIncludes(text, "$int$1($t0 + $int)");
  assertStringIncludes(text, "const $int$1 = (value: number): number =>");
  // The `Option` import gets an alias, and the parameter keeps its name.
  assertStringIncludes(text, "Option as Option$1");
  assertStringIncludes(text, "(Option: Option$1.Option<number>)");
  assertStringIncludes(text, "Option$1.match(Option, {");
  // The selector temporary skips the taken name.
  assertStringIncludes(text, '(($t1) => $t1 === "a" ? 1 : 2)($t0)');
  // A declaration named `Schema` or `Effect` moves the matching import.
  assertStringIncludes(text, "Schema as Schema$1");
  assertStringIncludes(text, "const Schema = Schema$1.Struct(");
  assertStringIncludes(text, "Effect as Effect$1");
  assertStringIncludes(text, "Effect$1.Effect<number, never, Env>");
  // The service parameter skips the taken name `$s`.
  assertStringIncludes(text, "Env.use(($s$1) => $s$1.get($s))");
});

// ------------------------------------------------------------------ order

Deno.test("a type used before its definition is emitted after it", () => {
  const text = oneModule(`
export type Outer = { inner: Inner }
error Boom = { reason: Reason }
type Reason = "a" | "b"
type Inner = { n: int }
export const make = (n: int): Outer => ({ inner: { n } })
`);
  assert(
    indexOfOrFail(text, "const Inner =") < indexOfOrFail(text, "const Outer ="),
  );
  assert(
    indexOfOrFail(text, "const Reason =") < indexOfOrFail(text, "class Boom"),
  );
});

Deno.test("a constant that calls a later function is emitted after the function and its inputs", () => {
  const text = oneModule(`
export const answer: int = twice(base)
const twice = (x: int): int => x * 2
const base: int = 21
`);
  const twice = indexOfOrFail(text, "const twice =");
  const base = indexOfOrFail(text, "const base:");
  const answer = indexOfOrFail(text, "const answer:");
  assert(twice < base, "functions come before constants");
  assert(base < answer, "a constant comes after its eager dependency");
});

Deno.test("a module with an initialization cycle has no IR to emit", () => {
  const checked = checkProject(
    memoryHost({
      "effective.json": "{}",
      "m.eff": "const a: int = b\nconst b: int = a\n",
    }),
    "",
    ["m.eff"],
  );
  assert(checked.ok);
  // The checker reports the cycle, so the module has no IR.
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered !== undefined && !lowered.ok);
});

// ------------------------------------------------------------------ annotations

Deno.test("every const in a body carries a type annotation", () => {
  const sources = [
    ...[...emitExamples().values()].map((m) => m.text),
    emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get("forms")?.text ??
      "",
  ];
  let seen = 0;
  for (const text of sources) {
    for (const line of text.split("\n")) {
      if (!/^\s+const /.test(line)) continue;
      seen += 1;
      assert(/^\s+const [^\s:=]+: \S/.test(line), `no annotation: ${line}`);
    }
  }
  assert(seen >= 10, `only ${seen} body consts were checked`);
});

Deno.test("a module constant and a host assertion carry a type annotation", () => {
  const text = oneModule("export const answer: int = 21\n");
  assertStringIncludes(text, "export const answer: number = 21;");
  const main = emitExamples().get("main")?.text ?? "";
  assertStringIncludes(
    main,
    "const UsersLive$host: Layer.Layer<Users> = UsersLive;",
  );
});

// ------------------------------------------------------------------ imports

Deno.test("specifiers are relative to the generated file", () => {
  assertEquals(relativeSpecifier("main.ts", "users.ts"), "./users.ts");
  assertEquals(relativeSpecifier("a/b.ts", "c.ts"), "../c.ts");
  assertEquals(relativeSpecifier("a/b.ts", "a/c.ts"), "./c.ts");
  assertEquals(relativeSpecifier("a/b/c.ts", "x/y.ts"), "../../x/y.ts");
  assertEquals(relativeSpecifier("a.ts", "impl/live.ts"), "./impl/live.ts");
});

Deno.test("imports and host modules are rewritten relative to a nested module", () => {
  const emitted = emitFiles({
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./impl/live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): int }\n",
    "sub/m.eff": [
      'import { S } from "../s.eff"',
      'import { L } from "host:p"',
      "export const g = (): int => provide(L, () => S.f())",
      "",
    ].join("\n"),
  }, ["s.eff", "sub/m.eff"]);
  const text = emitted.get("sub/m")?.text ?? "";
  assertEquals(emitted.get("sub/m")?.path, "sub/m.ts");
  assertStringIncludes(text, 'from "../s.ts";');
  assertStringIncludes(text, 'import { L } from "../impl/live.ts";');
  assertStringIncludes(text, "const L$host: Layer.Layer<S> = L;");
  assertStringIncludes(
    text,
    "Effect.provide(Effect.suspend(() => S.use(($s) => $s.f())), L$host)",
  );
});

// ------------------------------------------------------------------ forms

Deno.test("the forms fixture emits the plan's control forms", () => {
  const text = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get("forms")
    ?.text ?? "";
  // One Effect.catchTags call with all handlers, never a chain of catchTag.
  assertStringIncludes(text, "Effect.catchTags({");
  assert(!text.includes("catchTag("));
  // Parentheses by parent position.
  assertStringIncludes(
    text,
    "return $int((yield* Store.use(($s) => $s.count())) + n);",
  );
  assertStringIncludes(
    text,
    "const n: number = yield* Store.use(($s) => $s.count());",
  );
  assertStringIncludes(text, "(yield* lookup(id)).name");
  // A leaf with an effectful child hoists it inside a nested Effect.gen.
  assertStringIncludes(text, "const $t0: number = yield* f(x);");
  assertStringIncludes(text, "return yield* f($t0);");
  // A pure child that comes before an effectful child keeps its place.
  assertStringIncludes(text, "const $t0: number = add(x, 1);");
  assertStringIncludes(
    text,
    "const $t1: number = yield* Store.use(($s) => $s.count());",
  );
  assertStringIncludes(text, "return yield* pair($t0, $t1);");
  // A pure function fits an effect function slot through a wrapper.
  assertStringIncludes(text, "Effect.succeed(addOne($t0))");
  // The optional field read.
  assertStringIncludes(text, "Option.fromUndefinedOr(p.nickname)");
  // Brand construction.
  assertStringIncludes(text, "Id.make(s)");
});

// ------------------------------------------------------------------ formatting

Deno.test("an arrow chain that is too long moves below the equals sign", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "export const adder =\n  (n: number): (a: number) => Effect.Effect<number> => (x: number) =>\n    Effect.succeed($int(x + n));",
  );
  // A short chain stays on one line.
  const short = oneModule(
    "type F = (x: int) => int\nexport const f = (n: int): F => (x) => x\n",
  );
  assertStringIncludes(
    short,
    "export const f = (n: number): F => (x: number) => Effect.succeed(x);",
  );
});

Deno.test("a match with three arms prints one flat chain of conditionals", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "        : $t0 === 2\n        ? Effect.succeed(2000000000)\n        : $t0 === 3\n        ? Effect.succeed(3000000000)\n        : Effect.succeed(4000000000))(",
  );
});

Deno.test("a long binary expression breaks after an operator, and a short one stays on one line", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  // An arrow body: the lines after the first keep the indentation of the first.
  assertStringIncludes(
    forms.text,
    "): boolean =>\n  alphaValueNumberOne > betaValueNumberTwo &&\n  betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n  alphaValueNumberOne < 1000;",
  );
  // A conditional test: the lines after the first sit one level deeper than `?`.
  assertStringIncludes(
    forms.text,
    '): string =>\n  alphaValueNumberOne > betaValueNumberTwo &&\n    betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n    alphaValueNumberOne < 1000\n    ? "a"\n    : "b";',
  );
  // After `return`, the lines after the first sit one level deeper.
  assertStringIncludes(
    forms.text,
    "  return first && alphaValueNumberOne > betaValueNumberTwo &&\n    betaValueNumberTwo > gammaValueNumberThree && gammaValueNumberThree > 0 &&\n    alphaValueNumberOne < 1000;",
  );
  // A sum of int values: each `$int` call breaks its argument list.
  assertStringIncludes(
    forms.text,
    "          $int(alphaValueNumberOne + betaValueNumberTwo) +\n            gammaValueNumberThree,\n        ) + alphaValueNumberOne,",
  );
  // A short expression is unchanged.
  assertStringIncludes(forms.text, "export const arith = ");
  assertStringIncludes(
    forms.text,
    "$int($int($int(a * b) + a) - b)",
  );
});

Deno.test("an arrow chain whose first parameter list breaks puts each next head on a line of its own", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    "  gammaValueNumberThree: number,\n): WideG =>\n(gammaValueNumberThree: number, delta: number) =>\n  Effect.succeed(alphaValueNumberOne);",
  );
  // A later head that breaks does the same, and the body stays on its line.
  assertStringIncludes(
    forms.text,
    "export const wideChainLate = (z: number): WideH =>\n(\n  alphaValueNumberOne: number,",
  );
  // In a call argument the arguments break, and the heads align with the first.
  assertStringIncludes(
    forms.text,
    "    ) =>\n    (q: number) =>\n      $int(",
  );
  // A chain that fits below the equals sign keeps its heads on one line.
  assertStringIncludes(
    forms.text,
    "export const adder =\n  (n: number): (a: number) => Effect.Effect<number> => (x: number) =>\n    Effect.succeed($int(x + n));",
  );
});

Deno.test("an else-if chain prints every ? and : at one indentation level", () => {
  const forms = emitFiles(projectFiles("emit/forms"), ["forms.eff"]).get(
    "forms",
  );
  assert(forms !== undefined);
  assertStringIncludes(
    forms.text,
    '    : betaValueNumberTwo > gammaValueNumberThree\n    ? "bbbbbbbbbbbbbbbbbbbbbbb"\n    : gammaValueNumberThree > 100000 && alphaValueNumberOne < 10000000 &&\n        betaValueNumberTwo > 100\n    ? "c"\n    : "d";',
  );
});

// ------------------------------------------------------------------ spans and results

Deno.test("span records lie inside the text and cover each declaration", () => {
  const module = emitExamples().get("pay");
  assert(module !== undefined);
  assert(module.spans.length > 20);
  for (const record of module.spans) {
    assert(record.start >= 0 && record.start <= record.end);
    assert(record.end <= module.text.length);
  }
  const functionSpans = module.spans.filter((r) =>
    module.text.slice(r.start, r.end).startsWith("export const pay =")
  );
  assertEquals(functionSpans.length, 1);
});

Deno.test("a flattened run of binary operations keeps one span record for each operation", () => {
  const source =
    'export const f = (a: string, b: string, c: string): string => a + "-" + b + "-" + c\n';
  const files = { "effective.json": "{}", "m.eff": source };
  const module = emitFiles(files, ["m.eff"]).get("m");
  assert(module !== undefined);
  const pairs = module.spans
    .filter((r) => module.text.slice(r.start, r.end).includes(" + "))
    .map((r) => [
      module.text.slice(r.start, r.end),
      source.slice(r.span.start, r.span.end),
    ]);
  assertEquals(pairs, [
    ['a + "-"', 'a + "-"'],
    ['a + "-" + b', 'a + "-" + b'],
    ['a + "-" + b + "-"', 'a + "-" + b + "-"'],
    ['a + "-" + b + "-" + c', 'a + "-" + b + "-" + c'],
    [
      'export const f = (a: string, b: string, c: string): string =>\n  a + "-" + b + "-" + c;',
      source.trimEnd(),
    ],
  ]);
});

Deno.test("emitProject reports a module that did not lower", () => {
  const checked = checkProject(
    memoryHost({
      "effective.json": "{}",
      "m.eff": 'export const x: int = "no"\n',
    }),
    "",
    ["m.eff"],
  );
  assert(checked.ok);
  const emitted = emitProject(lowerProject(checked.value), {
    config: checked.value.analysis.project.config,
  });
  const result = emitted.get("m");
  assert(result !== undefined && !result.ok);
  assertEquals(result.error.tag, "lowering");
});

Deno.test("emitModule returns an error value for a host module that the project file lacks", () => {
  const files = {
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): int }\n",
    "m.eff":
      'import { L } from "host:p"\nexport const g = (): int => provide(L, () => 1)\n',
  };
  const checked = checkProject(memoryHost(files), "", ["s.eff", "m.eff"]);
  assert(checked.ok);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered !== undefined && lowered.ok);
  const result = emitModule(lowered.value, {
    config: { host: new Map() },
  });
  assert(!result.ok);
  assertEquals(result.error.tag, "unsupported");
});

Deno.test("the example list stays in step with the helper", () => {
  assertEquals(EXAMPLE_ENTRIES.length, 5);
});

Deno.test("the emitted module lists the range of each host assertion", () => {
  const main = emitExamples().get("main");
  assert(main !== undefined);
  assertEquals(main.hostAssertions.length, 1);
  const found = main.hostAssertions[0];
  assertEquals(
    main.text.slice(found.start, found.end),
    "const UsersLive$host: Layer.Layer<Users> = UsersLive;",
  );
  assertEquals(
    [found.name, found.local, found.exported, found.key],
    ["UsersLive$host", "UsersLive", "UsersLive", "providers"],
  );
  assertEquals(emitExamples().get("users")?.hostAssertions, []);
});

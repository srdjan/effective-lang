import { assert, assertEquals } from "@std/assert";
import {
  applySourceEdits,
  completionsAt,
  definitionAt,
  inlayHintsAt,
  Program,
  referencesAt,
  renameAt,
  semanticClassifications,
  sourceHoverAt,
} from "../src/core/frontend.ts";
import { TypeScriptOutputs } from "../src/core/typescript.ts";

export function checked(text: string, clean = true) {
  const updated = new Program().update({
    set: { "effektive.json": "{}", "m.eff": text },
  });
  assert(updated.ok);
  if (clean) assertEquals(updated.value.diagnostics, []);
  return updated.value;
}

/** Equivalence keeps all types/effects, dropping only spans and hygienic local identities. */
export function normalized(
  value: unknown,
  locals = new Map<string, string>(),
): unknown {
  if (typeof value === "string" && value.startsWith("local:")) {
    if (!locals.has(value)) locals.set(value, `local:${locals.size}`);
    return locals.get(value);
  }
  if (Array.isArray(value)) return value.map((v) => normalized(v, locals));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([k]) => k !== "span").map((
      [k, v],
    ) => [k, normalized(v, locals)]),
  );
}

export function equivalent(short: string, explicit: string) {
  const first = checked(short), second = checked(explicit);
  const a = first.lowered("m"), b = second.lowered("m");
  assert(a?.ok && b?.ok);
  assertEquals([...first.validate(new Map([["m", a]])).values()].flat(), []);
  assertEquals([...second.validate(new Map([["m", b]])).values()].flat(), []);
  assertEquals(normalized(a.value), normalized(b.value));
  const outputs = new TypeScriptOutputs();
  assert(outputs.emitted(first, "m")?.ok && outputs.emitted(second, "m")?.ok);
  return first;
}

Deno.test("bare lambdas preserve contextual checking, nesting, shadowing, and pipeline lowering", () => {
  const text = `type Int = int
const values: Int[] = [1, 2]
const nested: pure (x: Int) => pure (y: Int) => Int = x => y => x + y
export const run = (): Int[] => values |> filter(value => value > 1) |> map(value => { const inner = map(values, value => value + 1); value + 1 })
`;
  equivalent(text, text.replaceAll(/\b(x|y|value) =>/g, "($1) =>"));
});

Deno.test("bare lambdas keep missing-context, recursive, and exported contract requirements", () => {
  for (
    const text of [
      "const id = value => value",
      "export const id = value => value",
      "const recur = value => recur(value)",
    ]
  ) {
    const bare = checked(text, false),
      explicit = checked(text.replace("value =>", "(value) =>"), false);
    assert(bare.diagnostics.length > 0);
    assertEquals(
      bare.diagnostics.map((d) => [d.code, d.message]),
      explicit.diagnostics.map((d) => [d.code, d.message]),
    );
  }
  for (
    const text of ["const id = value: Int => value", "const id = a, b => a"]
  ) assert(checked(text, false).diagnostics.length > 0);
});

Deno.test("bare lambda locals support references, rename, hover, completion, tokens and recovery", () => {
  for (const spelling of ["value => value + 1", "(value) => value + 1"]) {
    const text =
      `type Int = int\nconst items: Int[] = [1]\nconst run = (): Int[] => map(items, ${spelling})\n`;
    const revision = checked(text);
    const declaration = text.indexOf("value");
    const use = text.lastIndexOf("value");
    assertEquals(referencesAt(revision, "m.eff", use).length, 2);
    assertEquals(definitionAt(revision, "m.eff", use)?.start, declaration);
    assertEquals(sourceHoverAt(revision, "m.eff", use)?.contract, "Int");
    assert(
      completionsAt(revision, "m.eff", use).some((c) => c.label === "value"),
    );
    assert(semanticClassifications(revision, "m.eff", text).length > 0);
    assertEquals(
      inlayHintsAt(revision, "m.eff", { start: 0, end: text.length }),
      [],
    );
    const renamed = renameAt(revision, "m.eff", declaration, "item");
    assert(renamed.ok);
    checked(applySourceEdits(text, renamed.value));
    checked(text.slice(0, use), false);
  }
});

Deno.test("Option fallback matches the explicit branches, including None, never, aliases and context", () => {
  const header =
    `type Int = int\ntype Maybe = Option<Int>\nerror Missing = {}\n`;
  for (
    const [expression, expansion] of [
      ["input ?? 2", "match input { Some(value) => value, None => 2 }"],
      [
        "input ?? fail(Missing({}))",
        "match input { Some(value) => value, None => fail(Missing({})) }",
      ],
      ["None ?? 2", "match None { Some(value) => value, None => 2 }"],
    ]
  ) {
    // The synthesized binding name is intentionally private; use the same hygienic spelling in the expansion.
    const short = checked(
      header +
        `export const run = (input: Maybe): Int fails Missing => ${expression}`,
    );
    const a = short.lowered("m");
    assert(a?.ok);
    const fn = a.value.declarations.find((d) => d.name === "run");
    assert(fn?.kind === "function" && fn.body.kind === "match");
    const pattern = fn.body.arms[0].pattern;
    assert(pattern.kind === "some");
    equivalent(
      header +
        `export const run = (input: Maybe): Int fails Missing => ${expression}`,
      header +
        `export const run = (input: Maybe): Int fails Missing => ${
          expansion.replaceAll("value", pattern.binding.name)
        }`,
    );
  }
  checked(
    header +
      "export const chain = (first: Option<Maybe>, second: Maybe): Int => (first ?? second) ?? 3",
  );
  checked(
    header +
      "export const right = (first: Maybe, second: Maybe): Int => first ?? second ?? 3",
  );
  checked(
    `type Pair = [int, int]\nexport const tuple = (): Pair => None ?? [1, 2]`,
  );
});

Deno.test("Option fallback precedence is below logic, above pipelines, and requires explicit logical grouping", () => {
  const prefix = "type Bool = boolean\n";
  for (
    const expression of [
      "Some(true) ?? false || true",
      "Some(true) ?? false && true",
      "true || Some(true) ?? false",
    ]
  ) {
    assert(
      checked(prefix + `const run = () => ${expression}`, false).diagnostics
        .some((d) => d.code === "syntax/015"),
    );
  }
  checked(
    prefix + "export const run = (): Bool => Some(true) ?? (false || true)",
  );
  checked(
    "type Int = int\nexport const run = (): Int[] => (Some([1]) ?? [2]) |> map(value => value + 1)",
  );
  for (const expression of ["1 ?? 2", "null ?? 2", "fail(Missing({})) ?? 2"]) {
    assert(
      checked(`error Missing = {}\nconst run = () => ${expression}`, false)
        .diagnostics.length > 0,
    );
  }
});

Deno.test("Option fallback records effects and keeps synthesized bindings out of source editor symbols", () => {
  const text = `type Int = int
service Store { find(): Option<Int>; fallback(): Int }
export const run = (): Int uses Store.find | Store.fallback => Store.find() ?? Store.fallback()
`;
  const revision = checked(text);
  const lowered = revision.lowered("m");
  assert(lowered?.ok);
  assertEquals(
    [...revision.validate(new Map([["m", lowered]])).values()].flat(),
    [],
  );
  const offset = text.lastIndexOf("fallback");
  assert(referencesAt(revision, "m.eff", offset).length === 3);
  assert(
    !completionsAt(revision, "m.eff", offset).some((c) =>
      c.label.startsWith("$option")
    ),
  );
  assert(
    semanticClassifications(revision, "m.eff", text).some((c) =>
      text.slice(c.span.start, c.span.end) === "??" && c.type === "operator"
    ),
  );
  checked(text.slice(0, text.indexOf("??") + 2), false);
});

Deno.test("record destructuring lowers to one capture and ordered ordinary field reads", () => {
  const short = `type Int = int
type Article = { id: Int, revision: Int, optional?: Int }
export const read = (article: Article): Int => { const { id, revision: expectedRevision }: Article = article; id + expectedRevision }
`;
  const revision = checked(short);
  const ir = revision.lowered("m");
  assert(ir?.ok);
  const fn = ir.value.declarations.find((d) => d.name === "read");
  assert(
    fn?.kind === "function" && fn.body.kind === "block" &&
      fn.body.steps[0].kind === "bind",
  );
  const captured = fn.body.steps[0].binding.name;
  equivalent(
    short,
    short.replace(
      "const { id, revision: expectedRevision }: Article = article",
      `const ${captured}: Article = article; const id = ${captured}.id; const expectedRevision = ${captured}.revision`,
    ),
  );
  checked(
    `type Int = int\ntype A = { id: Int, optional?: Int }\nexport const read = (value: A): Option<Int> => { const { id, optional } = value; optional }`,
  );
  checked(
    `type Int = int\ntype U = { id: Int, a: Int } | { id: Int, b: Int }\nexport const read = (value: U): Int => { const { id } = value; id }`,
  );
  checked(
    `type Int = int\ntype Weird = { __proto__: Int, constructor: Int, toString: Int }\nexport const read = (value: Weird): Int => { const { __proto__, constructor: ctor, toString } = value; __proto__ + ctor + toString }`,
  );
});

Deno.test("record destructuring rejects unsupported shapes, duplicates and scoped operation extraction", () => {
  for (
    const binding of [
      "{}",
      "{ id, id: second }",
      "{ id, revision: id }",
      "{ id: { nested } }",
      "{ id = 1 }",
      "{ ...rest }",
      "[id]",
    ]
  ) {
    assert(
      checked(
        `type Int = int\nconst read = (value: { id: Int, revision: Int }) => { const ${binding} = value; 1 }`,
        false,
      ).diagnostics.length > 0,
      binding,
    );
  }
  assert(checked("const { id } = { id: 1 }", false).diagnostics.length > 0);
  const escaped = checked(
    `type Int = int
service Files { open(): { read: () => Int, close: () => void } }
const read = () => withResource(() => Files.open(), file => { const { read } = file; read() }, file => file.close())
`,
    false,
  );
  assert(
    escaped.diagnostics.some((d) => d.message.includes("direct receiver")),
  );
});

Deno.test("destructured names support shorthand rename expansion, field completion, tokens and scopes", () => {
  const text =
    `type Int = int\ntype Article = { id: Int, revision: Int, optional?: Int }\nexport const read = (article: Article): Int => { const { id, revision: expectedRevision } = article; id + expectedRevision }`;
  const revision = checked(text);
  const binding = text.indexOf("{ id, revision");
  const id = binding + 2;
  const renamed = renameAt(revision, "m.eff", id, "articleId");
  assert(renamed.ok, JSON.stringify(renamed));
  const changed = applySourceEdits(text, renamed.value);
  assert(changed.includes("{ id: articleId, revision: expectedRevision }"));
  checked(changed);
  assertEquals(referencesAt(revision, "m.eff", id).length, 2);
  assertEquals(sourceHoverAt(revision, "m.eff", id)?.contract, "Int");
  assertEquals(
    definitionAt(revision, "m.eff", text.lastIndexOf("expectedRevision"))
      ?.start,
    text.indexOf("expectedRevision"),
  );
  const incomplete = text.replace("revision: expectedRevision", "");
  const recovered = checked(incomplete, false);
  const offset = incomplete.indexOf(",  }") + 2;
  const completions = completionsAt(recovered, "m.eff", offset);
  assert(
    completions.some((c) => c.label === "revision"),
    JSON.stringify(completions),
  );
  assert(!completions.some((c) => c.label === "id"));
  const tokens = semanticClassifications(revision, "m.eff", text);
  assert(
    tokens.some((t) =>
      t.span.start === text.indexOf("revision: expected") &&
      t.type === "property"
    ),
  );
  assert(
    !completionsAt(revision, "m.eff", text.indexOf("article;")).some((c) =>
      c.label === "expectedRevision"
    ),
  );
});

Deno.test("resource expressions match explicit callbacks, preserve empty-channel execution, and accept acquisition blocks", () => {
  const prefix =
    `type Int = int\nservice Jobs { open(): { read: () => Int, close: () => void } }\n`;
  equivalent(
    prefix +
      "export const run = (): Int uses Jobs.open => using (job = Jobs.open()) { job.read() } finally { job.close() }",
    prefix +
      "export const run = (): Int uses Jobs.open => withResource(() => Jobs.open(), job => { job.read() }, job => { job.close() })",
  );
  const revision = equivalent(
    prefix +
      "export const run = (): Int uses Jobs.open => using (job = { const temporary = 1; Jobs.open() }) { job.read() } finally { job.close() }",
    prefix +
      "export const run = (): Int uses Jobs.open => withResource(() => { const temporary = 1; Jobs.open() }, job => { job.read() }, job => { job.close() })",
  );
  assert(
    revision.checkedModule("m")?.functions.get("value:m#run")?.mode !== "pure",
  );
  const empty = checked(
    "type Int = int\nconst run = () => using (job = ({ read: () => 1, close: () => {} })) { job.read() } finally { job.close() }",
  );
  const ir = empty.lowered("m");
  assert(ir?.ok);
  const fn = ir.value.declarations.find((d) => d.name === "run");
  assert(fn?.kind === "function" && fn.type.execution === "effect");
  checked(
    "type Int = int\nconst using = (input: Int): Int => input\nexport const run = (): Int => using(1)",
  );
});

Deno.test("resource expressions retain scopes, data-only results, finalizer contracts and nested capture rejection", () => {
  const prefix =
    "type Int = int\nservice Jobs { open(): { read: () => Int, close: () => void } }\n";
  for (
    const expression of [
      "using (job = job.read()) { 1 } finally {}",
      "using (job = Jobs.open()) { const local = 1; job.read() } finally { local }",
      "using (job = Jobs.open()) { job } finally { job.close() }",
      "using (job = Jobs.open()) { job.read() } finally { 1 }",
      "using (job = Jobs.open()) { const captured = () => job.read(); captured() } finally { job.close() }",
      "using (outer = Jobs.open()) { using (inner = Jobs.open()) { outer.read() } finally { inner.close() } } finally { outer.close() }",
      "using (outer = Jobs.open()) { using (inner = outer.read()) { 1 } finally {} } finally { outer.close() }",
      "using (job = Jobs.open()) { const { read } = job; read() } finally { job.close() }",
      "using (job = Jobs.open()) { job.read() }",
    ]
  ) {
    assert(
      checked(prefix + `const run = () => ${expression}`, false).diagnostics
        .length > 0,
      expression,
    );
  }
  checked(
    prefix +
      "const run = () => using (outer = Jobs.open()) { using (inner = Jobs.open()) { inner.read() } finally { inner.close() } } finally { outer.close() }",
  );
});

Deno.test("resource expressions share one source identity across two scopes and distinct IR parameters", () => {
  const text =
    "type Int = int\nservice Jobs { open(): { read: () => Int, close: () => void } }\nexport const run = (): Int uses Jobs.open => using (job = Jobs.open()) { job.read() } finally { job.close() }";
  const revision = checked(text);
  const binding = text.indexOf("job =");
  assertEquals(referencesAt(revision, "m.eff", binding).length, 3);
  const renamed = renameAt(revision, "m.eff", binding, "resource");
  assert(renamed.ok, JSON.stringify(renamed));
  checked(applySourceEdits(text, renamed.value));
  for (const offset of [text.indexOf("job.read"), text.indexOf("job.close")]) {
    assertEquals(definitionAt(revision, "m.eff", offset)?.start, binding);
    assert(
      completionsAt(revision, "m.eff", offset).some((c) => c.label === "job"),
    );
    assert(sourceHoverAt(revision, "m.eff", offset)?.contract.includes("read"));
  }
  assert(
    !completionsAt(revision, "m.eff", text.indexOf("Jobs.open()", binding))
      .some((c) => c.label === "job"),
  );
  const ir = revision.lowered("m");
  assert(ir?.ok);
  assertEquals(
    [...revision.validate(new Map([["m", ir]])).values()].flat(),
    [],
  );
  const fn = ir.value.declarations.find((d) => d.name === "run");
  assert(fn?.kind === "function" && fn.body.kind === "with-resource");
  assert(fn.body.use.parameters[0].id !== fn.body.release.parameters[0].id);
  const tokens = semanticClassifications(revision, "m.eff", text);
  for (const word of ["using", "finally"]) {
    assert(
      tokens.some((t) =>
        text.slice(t.span.start, t.span.end) === word && t.type === "keyword"
      ),
    );
  }
  for (const end of [binding, text.indexOf("finally"), text.length - 1]) {
    checked(text.slice(0, end), false);
  }
});

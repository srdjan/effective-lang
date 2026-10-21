import { contractActionsAt } from "../src/core/editor_actions.ts";
import { completionsAt } from "../src/core/editor_completion.ts";
import { semanticClassifications } from "../src/core/editor_tokens.ts";
import {
  applySourceEdits,
  prepareRenameAt,
  renameAt,
} from "../src/core/editor_rename.ts";
import { assert, assertEquals } from "@std/assert";
import { Program } from "../src/core/db.ts";
import {
  occurrenceAt,
  referencesAt,
  symbolIndex,
} from "../src/core/editor_index.ts";

const library = `export type Int = int
export error Stop = {}
export service S { read(): Int fails Stop }
export const value = (arg: Int): Int => arg
`;
const consumer = `import { Int, Stop, S, value } from "./lib.eff"
export const use = (arg: Int): Int fails Stop uses S.read => { const other = value(arg); S.read() + other }
`;

Deno.test("revision index shares declaration identities across imports, locals, types and capabilities", () => {
  const program = new Program("");
  const loaded = program.update({
    set: { "effective.json": "{}", "lib.eff": library, "m.eff": consumer },
  });
  assert(loaded.ok);
  assertEquals(loaded.value.diagnostics, []);
  const revision = loaded.value;
  for (const name of ["Int", "Stop", "S", "value"]) {
    const refs = referencesAt(revision, "m.eff", consumer.indexOf(name));
    assert(refs.some((s) => s.source === "lib.eff"), name);
    assert(refs.some((s) => s.source === "m.eff"), name);
  }
  assertEquals(referencesAt(revision, "m.eff", consumer.indexOf("read")), [
    {
      source: "lib.eff",
      start: library.indexOf("read"),
      end: library.indexOf("read") + 4,
    },
    ...[consumer.indexOf("read"), consumer.lastIndexOf("read")].map(
      (start) => ({ source: "m.eff", start, end: start + 4 }),
    ),
  ]);
  assertEquals(
    referencesAt(revision, "m.eff", consumer.indexOf("arg"), false).length,
    1,
  );
  assertEquals(symbolIndex(revision), symbolIndex(revision));
});

Deno.test("indices are revision scoped and recover resolvable symbols from malformed source", () => {
  const program = new Program("");
  const first = program.update({
    set: {
      "effective.json": "{}",
      "m.eff":
        "type Int = int\nconst a = (x: Int): Int => x\nconst broken = (\n",
    },
  });
  assert(first.ok);
  const text = first.value.sourceTexts().get("m.eff") ?? "";
  assertEquals(
    referencesAt(first.value, "m.eff", text.indexOf("x:")).length,
    2,
  );
  const next = program.update({ set: { "m.eff": text.replaceAll("x", "y") } });
  assert(next.ok);
  assert(symbolIndex(first.value) !== symbolIndex(next.value));
  assertEquals(
    occurrenceAt(first.value, "m.eff", text.indexOf("x:"))?.target.kind,
    "local",
  );
  assertEquals(
    occurrenceAt(next.value, "m.eff", text.indexOf("x:"))?.identity.includes(
      "/y",
    ),
    true,
  );
});

Deno.test("rename follows identities across modules and expands shorthand without changing field names", () => {
  const text =
    "type Int = int\nexport const old = (x: Int): { x: Int } => ({ x })\n";
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(loaded.ok);
  const result = renameAt(loaded.value, "m.eff", text.indexOf("x:"), "fresh");
  assert(result.ok, JSON.stringify(result));
  assertEquals(
    applySourceEdits(text, result.value),
    text.replace("(x:", "(fresh:").replace("({ x })", "({ x: fresh })"),
  );
  const multiple = new Program("").update({
    set: { "effective.json": "{}", "lib.eff": library, "m.eff": consumer },
  });
  assert(multiple.ok);
  const renamed = renameAt(
    multiple.value,
    "m.eff",
    consumer.indexOf("value"),
    "calculate",
  );
  assert(renamed.ok, JSON.stringify(renamed));
  assertEquals(renamed.value.length, 3);
});

Deno.test("rename rejects capture, conflicts, reserved names, structural fields and host origins", () => {
  const text =
    "type Int = int\nconst a = (x: Int): Int => { const other = 2; x + other }\n";
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(loaded.ok);
  for (const name of ["other", "class", "fail", "int", "Number", "bad-name"]) {
    assertEquals(
      renameAt(loaded.value, "m.eff", text.indexOf("x:"), name).ok,
      false,
      name,
    );
  }
  const fields = new Program("").update({
    set: {
      "effective.json": "{}",
      "m.eff":
        "type R = { value: int }\nconst f = (r: R): R => ({value: r.value})\n",
    },
  });
  assert(fields.ok);
  assertEquals(prepareRenameAt(fields.value, "m.eff", 15), undefined);
  const host = new Program("").update({
    set: {
      "effective.json": JSON.stringify({
        host: { native: { interface: "./native.effi", module: "./native.ts" } },
      }),
      "native.effi": "export type Int = int\n",
      "m.eff":
        'import { Int } from "host:native"\nconst f = (n: Int): Int => n\n',
    },
  });
  assert(host.ok);
  assertEquals(prepareRenameAt(host.value, "m.eff", 10), undefined);
});

Deno.test("completion respects prefix, context, local scopes and incomplete member access", () => {
  const text = `type Int = int
 type R = { first: Int, second: Int }
 service S { read(): Int }
 const other = (): Int => 1
 const f = (outer: R): Int => { const local = 1; outer.fi }
 const g = (): Int => S.re
 `;
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(loaded.ok);
  assertEquals(
    completionsAt(loaded.value, "m.eff", text.indexOf("outer.fi") + 8).map(
      (c) => c.label,
    ),
    ["first"],
  );
  assertEquals(
    completionsAt(loaded.value, "m.eff", text.indexOf("S.re") + 4).map((c) =>
      c.label
    ),
    ["read"],
  );
  const inBody = completionsAt(loaded.value, "m.eff", text.indexOf("outer.fi"));
  assert(inBody.some((c) => c.label === "local"));
  assert(inBody.some((c) => c.label === "outer"));
  assert(
    !completionsAt(loaded.value, "m.eff", text.indexOf("S.re")).some((c) =>
      c.label === "local"
    ),
  );
  assert(
    completionsAt(loaded.value, "m.eff", text.indexOf("outer: R") + 8).some(
      (c) => c.label === "R",
    ),
  );
});

Deno.test("semantic classifications retain UTF-16 spans and lexical fallback on broken or stale text", () => {
  const text =
    "// 😀 comment\ntype Int = int\nconst f = (value: Int): Int => value + 1\nconst broken = (\n";
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(loaded.ok);
  const tokens = semanticClassifications(loaded.value, "m.eff", text);
  const at = (word: string) =>
    tokens.find((t) => t.span.start === text.indexOf(word));
  assertEquals(at("value")?.type, "parameter");
  assertEquals(at("Int")?.modifiers, ["declaration", "readonly"]);
  assertEquals(tokens[0].span.end, 13);
  const fresh = "type New = string\nconst z = (\n";
  assertEquals(
    semanticClassifications(loaded.value, "m.eff", fresh).find((t) =>
      t.span.start === fresh.indexOf("New")
    )?.type,
    "type",
  );
});

Deno.test("contract actions derive and validate missing effects while preserving existing entries", () => {
  for (
    const text of [
      "type Int = int\nerror Stop = {}\nconst f = (): Int => fail(Stop({}))\n",
      "type Int = int\nservice Clock { now(): Int }\nconst f = (): Int => Clock.now()\n",
      "type Int = int\nerror First = {}\nerror Second = {}\nservice Clock { now(): Int fails Second }\nconst f = (): Int fails First => Clock.now()\n",
    ]
  ) {
    const loaded = new Program("").update({
      set: { "effective.json": "{}", "m.eff": text },
    });
    assert(loaded.ok);
    const actions = contractActionsAt(
      loaded.value,
      "m.eff",
      text.indexOf("const f"),
    );
    assertEquals(actions.length, 1, JSON.stringify(loaded.value.diagnostics));
    const next = applySourceEdits(text, actions[0].edits);
    const checked = new Program("").update({
      set: { "effective.json": "{}", "m.eff": next },
    });
    assert(checked.ok);
    assertEquals(checked.value.diagnostics, [], next);
    if (text.includes("fails First")) {
      assert(next.includes("fails First | Second"), next);
    }
  }
  const broken = "type Int = int\nconst f = (): Int => unknownName()\n";
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": broken },
  });
  assert(loaded.ok);
  assertEquals(contractActionsAt(loaded.value, "m.eff", 0, broken.length), []);
});

Deno.test("references separate same-named local scopes and capability rename preserves service contracts", () => {
  const text = `type Int = int
 export service S { read(): Int }
 export const first = (x: Int): Int => x
 export const second = (x: Int): Int => x
 export const third = (): Int uses S.read => S.read()
 `;
  const loaded = new Program("").update({
    set: { "effective.json": "{}", "m.eff": text },
  });
  assert(loaded.ok);
  assertEquals(
    referencesAt(loaded.value, "m.eff", text.indexOf("x:")).length,
    2,
  );
  const method = renameAt(loaded.value, "m.eff", text.indexOf("read"), "load");
  assert(method.ok, JSON.stringify(method));
  assertEquals(method.value.length, 3);
  const file = applySourceEdits(text, method.value);
  const next = new Program("").update({
    set: { "effective.json": "{}", "m.eff": file },
  });
  assert(next.ok);
  assertEquals(next.value.diagnostics, []);
  const modules = new Program("").update({
    set: { "effective.json": "{}", "lib.eff": library, "m.eff": consumer },
  });
  assert(modules.ok);
  assertEquals(
    renameAt(modules.value, "lib.eff", library.indexOf("value ="), "arg").ok,
    false,
  );
});

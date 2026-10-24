import { assert, assertEquals } from "@std/assert";
import { lowerProject, Program, validateProject } from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { checkModule } from "./helpers.ts";

const HEAD = "type Int = int\ntype Text = string\n";

function check(text: string) {
  return checkModule(HEAD + text);
}

function valid(text: string) {
  const checked = check(text);
  assertEquals(checked.diagnostics, []);
  const lowered = lowerProject(checked);
  for (const result of lowered.values()) assert(result.ok);
  for (
    const diagnostics of validateProject(checked.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  return { checked, lowered };
}

for (
  const other of [
    "{ other: Int }",
    '{ kind?: "a", value: Int }',
    "{ kind: Text, value: Int }",
  ]
) {
  Deno.test(`record matching requires a wildcard for ${other}`, () => {
    const type = `type T = { kind: "a", value: Int } | ${other}\n`;
    const partial = check(
      type +
        'const read = (x: T): Int => match x { { kind: "a" } => 1 }',
    );
    assertEquals(partial.diagnostics.map((d) => d.code), ["pattern/001"]);
    assert(partial.diagnostics[0].message.includes("needs _"));
    valid(
      type +
        'const read = (x: T): Int => match x { { kind: "a" } => 1, _ => 0 }',
    );
  });
}

Deno.test("record matching retains overlapping open and optional members", () => {
  valid(`
type T = { kind: "a", value: Int } | { kind: Text, value: Text } | { kind?: "a", value: Int }
const read = (x: T): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }
type Open = { kind: Text, value: Int }
const open = (x: Open): Int => match x { { kind: "unknown", ...a } => a.value, _ => 0 }
`);
  const rejected = check(`
type T = { kind: "a", value: Int } | { kind: Text, value: Text }
const read = (x: T): Int => match x { { kind: "a", ...a } => a.value, _ => 0 }
`);
  assert(rejected.diagnostics.some((d) => d.code === "type-mismatch/003"));
});

Deno.test("record matching retains erased brands and unknown discriminators", () => {
  for (const tag of ["Tag", "Nested", "Alias", "unknown"]) {
    const prelude = `
type Tag = string
type Nested = Tag
type Alias = Tag | "other"
type T = { kind: "a", value: Int } | { kind: ${tag}, value: Text }
`;
    const rejected = check(
      prelude +
        'const read = (x: T): Int => match x { { kind: "a", ...a } => a.value, _ => 0 }',
    );
    assert(rejected.diagnostics.some((d) => d.code === "type-mismatch/003"));
    valid(
      prelude +
        'const read = (x: T): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }',
    );
  }
});

for (const tag of ["Text", "Tag", "unknown"]) {
  Deno.test(`the validator independently rejects an undersized ${tag} record binding`, () => {
    const text = `
type Tag = string
type T = { kind: "a", value: Int } | { kind: ${tag}, value: Text }
const read = (x: T): Int | Text => match x { { kind: "a", ...a } => a.value, _ => 0 }
`;
    const { lowered } = valid(text);
    const result = lowered.get("m");
    assert(result?.ok);
    const declaration = result.value.declarations.find((d) =>
      d.kind === "function" && d.name === "read"
    );
    assert(declaration?.kind === "function");
    assert(declaration.body.kind === "match");
    const body = declaration.body;
    const pattern = body.arms[0].pattern;
    assert(pattern.kind === "tag" && pattern.binding !== null);
    const binding = pattern.binding;
    const forged = {
      ...result.value,
      declarations: result.value.declarations.map((d) =>
        d !== declaration ? d : {
          ...d,
          body: {
            ...body,
            arms: body.arms.map((arm, i) =>
              i !== 0 ? arm : {
                ...arm,
                pattern: {
                  ...pattern,
                  binding: {
                    ...binding,
                    type: {
                      kind: "record" as const,
                      fields: [
                        {
                          name: "kind",
                          type: { kind: "literal" as const, value: "a" },
                          optional: false,
                        },
                        {
                          name: "value",
                          type: {
                            kind: "named" as const,
                            id: "type:m#Int" as const,
                          },
                          optional: false,
                        },
                      ],
                    },
                  },
                },
              }
            ),
          },
        }
      ),
    };
    const diagnostics = validateModule(
      forged,
      new Map([["m.eff", HEAD + text]]),
    );
    assert(diagnostics.some((d) => d.message.includes("binding.type")));
  });
}

Deno.test("record construction selects union members by literal values and alias tags", () => {
  for (const reverse of [false, true]) {
    const branches = ["{ kind: A, value: Int }", "{ kind: B, value: Text }"];
    if (reverse) branches.reverse();
    valid(`
type A = "a"
type B = "b"
type T = ${branches.join(" | ")}
const a: T = { kind: "a", value: 1 }
const b: T = { kind: ("b"), value: "hello" }
const make = (next: () => Text): T => ({ kind: "b", value: next() })
`);
    const rejected = check(`
type T = ${branches.join(" | ")}
type A = "a"
type B = "b"
const bad: T = { kind: "b", value: 1 }
`);
    assert(rejected.diagnostics.length > 0);
  }
});

const FILES = (text: string) => ({ "effektive.json": "{}", "main.eff": text });

Deno.test("union member order does not depend on the revision history", () => {
  const history = "type N = int\ntype Q = { k: N[], v: N }\n";
  const program = `type N = int
type S = string
type U = { k: S[], v: S } | { k: N[], v: N }
export const f = (x: N): U => ({ k: [], v: x })
`;
  const incremental = new Program("");
  const first = incremental.update({ set: FILES(history) });
  assert(first.ok, JSON.stringify(first));
  const second = incremental.update({ set: FILES(program) });
  assert(second.ok, JSON.stringify(second));
  const fresh = new Program("").update({ set: FILES(program) });
  assert(fresh.ok, JSON.stringify(fresh));
  assertEquals(fresh.value.diagnostics, []);
  assertEquals(second.value.diagnostics, fresh.value.diagnostics);
});

const AZ = "type A = string\ntype Z = int\ntype B = boolean\n";
const MEMBER_A = "{ k: A[], v: A }";
const MEMBER_Z = "{ k: Z[], v: Z }";

for (
  const [name, members] of [
    ["string member first", `${MEMBER_A} | ${MEMBER_Z}`],
    ["int member first", `${MEMBER_Z} | ${MEMBER_A}`],
  ]
) {
  Deno.test(`a record literal picks the union member by the type of a name field (${name})`, () => {
    valid(
      `${AZ}type U = ${members}
export const f = (x: Z): U => ({ k: [], v: x })
export const g = (v: Z): U => ({ k: [], v })
export const h = (x: A): U => ({ k: [], v: (x) })
`,
    );
  });

  Deno.test(`a name field of a type that fits no member keeps the canonical first member (${name})`, () => {
    const checked = check(
      `${AZ}type U = ${members}
export const f = (x: B): U => ({ k: [], v: x })
`,
    );
    assertEquals(checked.diagnostics.map((d) => d.message), [
      "the field `v` has type B, but A is expected",
    ]);
  });
}

// One table of guarded-recursion cases, run through the checker and through the
// independent validator. The two implementations stay separate. Only the case
// data is shared. The checker runs each source. The validator cannot see a
// rejected source, because the checker stops it before lowering. So the
// validator lowers an accepted seed source and forges the rejected shape.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import type { Field, ModuleIR, Type } from "../src/core/ir.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import { validateModule } from "../src/core/validate/index.ts";

/** Replaces one value inside a type declaration of the seed module. */
interface Forge {
  readonly declaration: string;
  readonly path: readonly (string | number)[];
  readonly value: Type | Field;
}

interface GuardedCase {
  readonly name: string;
  /** The checker input. */
  readonly source: string;
  /** The checker accepts the source and the validator accepts its lowering. */
  readonly accepted: boolean;
  /** An accepted source that the validator lowers before it applies `forge`. */
  readonly seed?: string;
  readonly forge?: readonly Forge[];
}

const TAGS = `type A = "a"\ntype B = "b"\n`;
const SEED = `${TAGS}type T = { tag: A, next: T } | { tag: B }`;
const T_ID = "type:m#T";
const literal = (value: string): Type => ({ kind: "literal", value });
const named = (id: `type:${string}`): Type => ({ kind: "named", id });
const primitive = (name: "int" | "string"): Type => ({
  kind: "primitive",
  name,
});
const aliasType = (declaration: string, value: Type): Forge => ({
  declaration,
  path: ["definition", "type"],
  value,
});

const CASES: readonly GuardedCase[] = [
  {
    name: "inline tags",
    source: `type T = { tag: "a", next: T } | { tag: "b" }`,
    accepted: true,
  },
  {
    name: "tag aliases before the recursive alias",
    source: SEED,
    accepted: true,
  },
  {
    name: "tag aliases after the recursive alias",
    source:
      `type T = { tag: A, next: T } | { tag: B }\ntype A = "a"\ntype B = "b"`,
    accepted: true,
  },
  {
    name: "an alias of a tag alias",
    source:
      `type T = { tag: A2, next: T } | { tag: B }\ntype A2 = A\ntype A = "a"\ntype B = "b"`,
    accepted: true,
  },
  {
    name: "aliased and inline tags mix",
    source: `type A = "a"\ntype T = { tag: A, next: T } | { tag: "b" }`,
    accepted: true,
  },
  {
    name: "two tag aliases hold one value",
    source:
      `type A = "a"\ntype B = "a"\ntype T = { tag: A, next: T } | { tag: B }`,
    accepted: false,
    seed: SEED,
    forge: [aliasType("B", literal("a"))],
  },
  {
    name: "an aliased tag repeats an inline tag",
    source: `type A = "a"\ntype T = { tag: A, next: T } | { tag: "a" }`,
    accepted: false,
    seed: `type A = "a"\ntype T = { tag: A, next: T } | { tag: "b" }`,
    forge: [aliasType("A", literal("b"))],
  },
  {
    name: "every branch recurses, so no branch is terminal",
    source: `${TAGS}type T = { tag: A, next: T } | { tag: B, next: T }`,
    accepted: false,
    seed: SEED,
    forge: [{
      declaration: "T",
      path: ["definition", "type", "members", 1, "fields", 1],
      value: { name: "next", type: named(T_ID), optional: false },
    }],
  },
  {
    name: "a union of literals is not one tag value",
    source:
      `type A = "a" | "c"\ntype B = "b"\ntype T = { tag: A, next: T } | { tag: B }`,
    accepted: false,
    seed: SEED,
    forge: [aliasType("A", {
      kind: "union",
      members: [literal("a"), literal("c")],
    })],
  },
  {
    name: "a non-literal tag alias is not a discriminant",
    source:
      `type A = string\ntype B = "b"\ntype T = { tag: A, next: T } | { tag: B }`,
    accepted: false,
    seed: SEED,
    forge: [aliasType("A", primitive("string"))],
  },
  {
    name: "the tag aliases form a cycle",
    source: `type A = B\ntype B = A\ntype T = { tag: A, next: T } | { tag: B }`,
    accepted: false,
    seed: SEED,
    forge: [
      aliasType("A", named("type:m#B")),
      aliasType("B", named("type:m#A")),
    ],
  },
  {
    name: "an untagged union",
    source: `type T = { value: int, next: T } | { value: string }`,
    accepted: false,
    seed: `type T = { tag: "a", next: T } | { tag: "b" }`,
    forge: [
      {
        declaration: "T",
        path: ["definition", "type", "members", 0, "fields", 0, "type"],
        value: primitive("int"),
      },
      {
        declaration: "T",
        path: ["definition", "type", "members", 1, "fields", 0, "type"],
        value: primitive("string"),
      },
    ],
  },
  {
    name: "a record that contains itself",
    source: `type T = { next: T }`,
    accepted: false,
    seed: `type T = { tag: "a", next: T } | { tag: "b" }`,
    forge: [aliasType("T", {
      kind: "record",
      fields: [{ name: "next", type: named(T_ID), optional: false }],
    })],
  },
];

function lowerSource(text: string): ModuleIR {
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, text);
  assertEquals(checked.value.diagnostics.map((d) => d.code), [], text);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered?.ok === true, text);
  return structuredClone(lowered.value);
}

function validationCodes(ir: ModuleIR, source: string): string[] {
  const codes = validateModule(ir, new Map([["m.eff", source]])).map((d) =>
    d.code
  );
  return [...new Set(codes)].sort();
}

function objectAt(value: unknown): object {
  assert(typeof value === "object" && value !== null);
  return value;
}

function applyForge(ir: ModuleIR, forge: Forge): void {
  const found = ir.declarations.find((d) => d.name === forge.declaration);
  assert(found?.kind === "type", forge.declaration);
  const keys = [...forge.path];
  const last = keys.pop();
  assert(last !== undefined);
  let parent: object = found;
  for (const key of keys) parent = objectAt(Reflect.get(parent, key));
  Reflect.set(parent, last, structuredClone(forge.value));
}

Deno.test("the checker accepts guarded recursion only for distinct literal tags and a terminal branch", () => {
  for (const c of CASES) {
    const checked = checkProject(
      memoryHost({ "effektive.json": "{}", "m.eff": c.source }),
      "",
      ["m.eff"],
    );
    assert(checked.ok, c.name);
    const codes = new Set(checked.value.diagnostics.map((d) => d.code));
    assertEquals(
      codes,
      c.accepted ? new Set() : new Set(["declaration/007"]),
      c.name,
    );
  }
});

Deno.test("the validator accepts guarded recursion only for distinct literal tags and a terminal branch", () => {
  for (const c of CASES) {
    if (c.accepted) {
      assertEquals(
        validationCodes(lowerSource(c.source), c.source),
        [],
        c.name,
      );
      continue;
    }
    assert(c.seed !== undefined && c.forge !== undefined, c.name);
    const ir = lowerSource(c.seed);
    assertEquals(validationCodes(ir, c.seed), [], `${c.name}: seed`);
    for (const forge of c.forge) applyForge(ir, forge);
    assertEquals(validationCodes(ir, c.seed), ["validation/002"], c.name);
  }
});

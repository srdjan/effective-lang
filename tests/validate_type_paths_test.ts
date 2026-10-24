// The IR paths and the visit order of the three validator type walkers in
// src/core/validate/world.ts: `checkTypeIds`, `checkRecordFields`, and
// `checkRecursion`. Each walker reaches every child type of every Type kind.
// A diagnostic names the child by an IR path suffix such as `.fields[0].type`.
// These tests put a probe type in each child slot and require the exact
// suffix. They also pin the order of diagnostics for the kinds that check
// something besides their children.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { Effects, ModuleIR, Span, Type } from "../src/core/ir.ts";
import { Report } from "../src/core/validate/report.ts";
import { typeChildren } from "../src/core/validate/type_children.ts";
import {
  buildWorld,
  checkRecordFields,
  checkRecursion,
  checkTypeIds,
} from "../src/core/validate/world.ts";

const SPAN: Span = { source: "m.eff", start: 0, end: 0 };
const NONE: Effects = { failures: [], requirements: [] };
const INT: Type = { kind: "primitive", name: "int" };
const MISSING: Type = { kind: "named", id: "type:m#Missing" };
const SELF: Type = { kind: "named", id: "type:m#A" };
const DUPLICATE: Type = {
  kind: "record",
  fields: [
    { name: "a", type: INT, optional: false },
    { name: "a", type: INT, optional: false },
  ],
};

/** One child slot of a Type kind: the IR path suffix and a type with `probe` in it. */
interface Slot {
  readonly suffix: string;
  readonly build: (probe: Type) => Type;
}

const field = (name: string, type: Type) => ({ name, type, optional: false });
const schema = (decoded: Type, encoded: Type, makeInput?: Type): Type => ({
  kind: "schema",
  decoded,
  encoded,
  decodeRequirements: [],
  encodeRequirements: [],
  ...(makeInput === undefined ? {} : { makeInput }),
});
const fn = (parameters: Type[], result: Type): Type => ({
  kind: "function",
  execution: "pure",
  parameters,
  result,
  effects: NONE,
});

/** Every child slot of every Type kind that has children, in walk order. */
const SLOTS: readonly Slot[] = [
  {
    suffix: ".fields[0].type",
    build: (p) => ({
      kind: "record",
      fields: [field("a", p), field("b", INT)],
    }),
  },
  {
    suffix: ".fields[1].type",
    build: (p) => ({
      kind: "record",
      fields: [field("a", INT), field("b", p)],
    }),
  },
  { suffix: ".element", build: (p) => ({ kind: "array", element: p }) },
  { suffix: ".element", build: (p) => ({ kind: "option", element: p }) },
  { suffix: ".element", build: (p) => ({ kind: "ref", element: p }) },
  {
    suffix: ".error",
    build: (p) => ({ kind: "retry-schedule", error: p }),
  },
  {
    suffix: ".decoded",
    build: (p) => ({ kind: "codec", decoded: p, encoded: INT }),
  },
  {
    suffix: ".encoded",
    build: (p) => ({ kind: "codec", decoded: INT, encoded: p }),
  },
  { suffix: ".decoded", build: (p) => schema(p, INT) },
  { suffix: ".encoded", build: (p) => schema(INT, p) },
  { suffix: ".makeInput", build: (p) => schema(INT, INT, p) },
  {
    suffix: ".result",
    build: (p) => ({ kind: "fiber", result: p, failures: [] }),
  },
  {
    suffix: ".result",
    build: (p) => ({ kind: "effect", result: p, effects: NONE }),
  },
  {
    suffix: ".element",
    build: (p) => ({ kind: "stream", element: p, effects: NONE }),
  },
  {
    suffix: ".output",
    build: (p) => ({ kind: "schedule", output: p, input: INT, effects: NONE }),
  },
  {
    suffix: ".input",
    build: (p) => ({ kind: "schedule", output: INT, input: p, effects: NONE }),
  },
  {
    suffix: ".input",
    build: (p) => ({ kind: "sink", input: p, result: INT, effects: NONE }),
  },
  {
    suffix: ".result",
    build: (p) => ({ kind: "sink", input: INT, result: p, effects: NONE }),
  },
  {
    suffix: ".leftover",
    build: (p) => ({
      kind: "sink",
      input: INT,
      result: INT,
      leftover: p,
      effects: NONE,
    }),
  },
  {
    suffix: ".elements[0]",
    build: (p) => ({ kind: "tuple", elements: [p, INT] }),
  },
  {
    suffix: ".elements[1]",
    build: (p) => ({ kind: "tuple", elements: [INT, p] }),
  },
  {
    suffix: ".members[0]",
    build: (p) => ({ kind: "union", members: [p, INT] }),
  },
  {
    suffix: ".members[1]",
    build: (p) => ({ kind: "union", members: [INT, p] }),
  },
  { suffix: ".parameters[0]", build: (p) => fn([p, INT], INT) },
  { suffix: ".parameters[1]", build: (p) => fn([INT, p], INT) },
  { suffix: ".result", build: (p) => fn([], p) },
];

function lowerBase(): ModuleIR {
  // A bare name is a transparent alias, so `A` keeps an `alias` definition.
  const source = "export type Base = int\nexport type A = Base\n";
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": source }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  return structuredClone(lowered.value);
}

/** Runs one walker on its own report and returns `code path: message` lines. */
function alone(
  module: ModuleIR,
  run: (ctx: { world: ReturnType<typeof buildWorld>; report: Report }) => void,
): string[] {
  const report = new Report();
  run({ world: buildWorld(module), report });
  return report.items.map((d) => `${d.code} ${d.message}`);
}

const ROOT = "p";

Deno.test("checkTypeIds names each child slot by its IR path suffix", () => {
  const module = lowerBase();
  for (const slot of SLOTS) {
    const type = slot.build(MISSING);
    const found = alone(module, (ctx) => checkTypeIds(ctx, type, ROOT, SPAN))
      .filter((line) => line.includes("type:m#Missing"));
    assertEquals(
      found,
      [`validation/001 ${ROOT}${slot.suffix}: the type type:m#Missing is not declared`],
      `${type.kind} ${slot.suffix}`,
    );
  }
});

Deno.test("checkRecordFields names each child slot by its IR path suffix", () => {
  const module = lowerBase();
  for (const slot of SLOTS) {
    const type = slot.build(DUPLICATE);
    // A record slot holds the probe next to an int, so the probe stays the only duplicate.
    assertEquals(
      alone(module, (ctx) => checkRecordFields(ctx, type, ROOT, SPAN)),
      [`validation/002 ${ROOT}${slot.suffix}.fields[1]: the field a appears twice`],
      `${type.kind} ${slot.suffix}`,
    );
  }
});

Deno.test("checkRecursion reaches each child slot", () => {
  for (const slot of SLOTS) {
    const module = lowerBase();
    const declaration = module.declarations.find((d) => d.name === "A");
    assert(
      declaration?.kind === "type" && declaration.definition.kind === "alias",
    );
    (declaration.definition as { type: Type }).type = slot.build(SELF);
    assertEquals(
      alone(module, (ctx) => checkRecursion(ctx, module)),
      [
        `validation/002 declarations[${
          module.declarations.indexOf(declaration)
        }]: the type type:m#A refers to itself; version 0 has no recursive types`,
      ],
      `${slot.build(INT).kind} ${slot.suffix}`,
    );
  }
});

Deno.test("leaf kinds have no child for any walker", () => {
  const module = lowerBase();
  const leaves: Type[] = [
    INT,
    { kind: "literal", value: "x" },
    { kind: "closeable-scope" },
    {
      kind: "provider",
      provides: [],
      acquisition: { execution: "pure", effects: NONE },
    },
  ];
  for (const type of leaves) {
    assertEquals(
      alone(module, (ctx) => {
        checkTypeIds(ctx, type, ROOT, SPAN);
        checkRecordFields(ctx, type, ROOT, SPAN);
      }),
      [],
      type.kind,
    );
  }
});

Deno.test("checkTypeIds orders a kind's own check against its children", () => {
  const module = lowerBase();
  const missing = "the type type:m#Missing is not declared";
  const lines = (type: Type) =>
    alone(module, (ctx) => checkTypeIds(ctx, type, ROOT, SPAN));
  // A function reports a borrow mismatch first, then its children, then its effects.
  assertEquals(
    lines({
      kind: "function",
      execution: "pure",
      parameters: [MISSING],
      borrows: [true, false],
      result: MISSING,
      effects: { failures: ["error:m#Gone"], requirements: [] },
    }),
    [
      `validation/001 ${ROOT}: borrow flags must match function parameters`,
      `validation/001 ${ROOT}.parameters[0]: ${missing}`,
      `validation/001 ${ROOT}.result: ${missing}`,
      `validation/001 ${ROOT}.effects.failures[0]: the failure error:m#Gone is not a declared error`,
      `validation/002 ${ROOT}: a pure function type must have empty failure and requirement rows`,
    ],
  );
  // A retry schedule reports its child first, then the declared error rule.
  assertEquals(lines({ kind: "retry-schedule", error: MISSING }), [
    `validation/001 ${ROOT}.error: ${missing}`,
    `validation/001 ${ROOT}: a retry schedule needs a declared error type`,
  ]);
  // A schema reports its children first, then data-only, then its requirements.
  assertEquals(
    lines({
      kind: "schema",
      decoded: MISSING,
      encoded: INT,
      decodeRequirements: ["cap:m#Gone"],
      encodeRequirements: [],
    }),
    [
      `validation/001 ${ROOT}.decoded: ${missing}`,
      `validation/001 ${ROOT}: Schema decoded and encoded types must be data only`,
      `validation/001 ${ROOT}.decodeRequirements.requirements[0]: the requirement cap:m#Gone is not a declared service method`,
    ],
  );
  // A fiber and an effect report their children before their effect sets.
  assertEquals(
    lines({ kind: "fiber", result: MISSING, failures: ["error:m#Gone"] }),
    [
      `validation/001 ${ROOT}.result: ${missing}`,
      `validation/001 ${ROOT}.effects.failures[0]: the failure error:m#Gone is not a declared error`,
    ],
  );
});

Deno.test("typeChildren gives each child slot once with its IR path suffix", () => {
  for (const slot of SLOTS) {
    const type = slot.build(MISSING);
    const children = typeChildren(type);
    assertEquals(
      children.filter((c) => c.type === MISSING).map((c) => c.suffix),
      [slot.suffix],
      `${type.kind} ${slot.suffix}`,
    );
    // The filler children are the int types of the other slots.
    assert(
      children.every((c) => c.type === MISSING || c.type === INT),
      `${type.kind} ${slot.suffix}`,
    );
  }
});

Deno.test("typeChildren gives no child for a leaf kind", () => {
  const leaves: Type[] = [
    INT,
    { kind: "literal", value: "x" },
    MISSING,
    { kind: "closeable-scope" },
    {
      kind: "provider",
      provides: [],
      acquisition: { execution: "pure", effects: NONE },
    },
  ];
  for (const type of leaves) assertEquals(typeChildren(type), [], type.kind);
});

// The depth bound of the validator type walkers (decision D3). Three walkers
// in src/core/validate/world.ts visit every type of a declaration: the
// identity check (`checkTypeIds`), the duplicate field check
// (`checkRecordFields`), and the recursion check (`checkRecursion`). Each
// walker accepts a node at depth 1536, the documented `MAX_DEPTH` of
// src/core/validate/typing.ts. At depth 1537 a walker stops that branch and
// reports `validation/002` "type nesting exceeds 1536 levels" at the IR path
// of the node. The validator reports at most one such diagnostic for each
// declaration. The depth of a node is the count of type wrappers above it:
// the root type has depth 0.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { ModuleIR, Type } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { Report } from "../src/core/validate/report.ts";
import {
  buildWorld,
  checkRecordFields,
  checkRecursion,
  checkTypeIds,
} from "../src/core/validate/world.ts";

const LIMIT = 1536;
const BOUND = "type nesting exceeds 1536 levels";
const MISSING: Type = { kind: "named", id: "type:m#Missing" };
const INT: Type = { kind: "primitive", name: "int" };
const DUPLICATE: Type = {
  kind: "record",
  fields: [
    { name: "a", type: INT, optional: false },
    { name: "a", type: INT, optional: false },
  ],
};

const BASE = "export type A = int\nexport type B = int\n";

function lowerBase(): ModuleIR {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": BASE }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  return structuredClone(lowered.value);
}

/** The IR index of the declaration named `name`. */
function indexOf(module: ModuleIR, name: string): number {
  const index = module.declarations.findIndex((d) => d.name === name);
  assert(index >= 0, name);
  return index;
}

/** Replaces the aliased type of the type declaration `name`. */
function setAlias(module: ModuleIR, name: string, type: Type): void {
  const declaration = module.declarations[indexOf(module, name)];
  assert(
    declaration.kind === "type" && declaration.definition.kind === "alias",
    name,
  );
  (declaration.definition as { type: Type }).type = type;
}

/** `leaf` below `levels` array wrappers: the leaf has depth `levels`. */
function nested(levels: number, leaf: Type): Type {
  let type = leaf;
  for (let i = 0; i < levels; i++) type = { kind: "array", element: type };
  return type;
}

/** The IR path of the leaf of `nested(levels, ...)` in the alias `name`. */
function leafPath(module: ModuleIR, name: string, levels: number): string {
  return `declarations[${indexOf(module, name)}].definition.type${
    ".element".repeat(levels)
  }`;
}

function validate(module: ModuleIR) {
  return validateModule(module, new Map([["m.eff", BASE]]));
}

function depthReports(module: ModuleIR) {
  return validate(module).filter((d) => d.message.endsWith(BOUND));
}

// ------------------------------------------------------------------ identity

Deno.test("an unknown id at depth 1536 is still found and gives no depth report", () => {
  const module = lowerBase();
  setAlias(module, "A", nested(LIMIT, MISSING));
  const found = validate(module);
  assertEquals(found.filter((d) => d.message.endsWith(BOUND)), []);
  assertEquals(
    found.filter((d) => d.message.includes("type:m#Missing")).map((d) => [
      d.code,
      d.message,
    ]),
    [[
      "validation/001",
      `${
        leafPath(module, "A", LIMIT)
      }: the type type:m#Missing is not declared`,
    ]],
  );
});

Deno.test("a type at depth 1537 gives one depth report and no deeper report", () => {
  const module = lowerBase();
  setAlias(module, "A", nested(LIMIT + 1, MISSING));
  const found = validate(module);
  assertEquals(
    found.filter((d) => d.message.endsWith(BOUND)).map((d) => [
      d.code,
      d.message,
    ]),
    [["validation/002", `${leafPath(module, "A", LIMIT + 1)}: ${BOUND}`]],
  );
  // The branch stops at the bound, so the unknown id below it stays unseen.
  assertEquals(found.filter((d) => d.message.includes("type:m#Missing")), []);
});

// ------------------------------------------------------------- duplicate field

// A record has children, and a child of a record at depth 1536 has depth 1537.
// So the deepest record with all its fields inside the bound is at depth 1535,
// and its two `a` fields are at depth 1536.
Deno.test("a duplicate field at depth 1536 is still found and gives no depth report", () => {
  const module = lowerBase();
  setAlias(module, "A", nested(LIMIT - 1, DUPLICATE));
  const found = validate(module);
  assertEquals(found.filter((d) => d.message.endsWith(BOUND)), []);
  assertEquals(
    found.filter((d) => d.message.includes("appears twice")).map((d) =>
      d.message
    ),
    [
      `${
        leafPath(module, "A", LIMIT - 1)
      }.fields[1]: the field a appears twice`,
    ],
  );
});

Deno.test("a duplicate field at depth 1537 gives one depth report", () => {
  const module = lowerBase();
  setAlias(module, "A", nested(LIMIT + 1, DUPLICATE));
  const found = validate(module);
  assertEquals(found.filter((d) => d.message.endsWith(BOUND)).length, 1);
  assertEquals(found.filter((d) => d.message.includes("appears twice")), []);
});

// ------------------------------------------------------------------ recursion

/** The alias `A` whose definition reaches `A` at depth `levels`. */
function cycleAt(levels: number): ModuleIR {
  const module = lowerBase();
  setAlias(module, "A", nested(levels, { kind: "named", id: "type:m#A" }));
  return module;
}

Deno.test("a cycle at depth 1536 is still found and gives no depth report", () => {
  const module = cycleAt(LIMIT);
  const found = validate(module);
  assertEquals(found.filter((d) => d.message.endsWith(BOUND)), []);
  assertEquals(
    found.filter((d) => d.message.includes("refers to itself")).map((d) =>
      d.message
    ),
    [
      `declarations[${
        indexOf(module, "A")
      }]: the type type:m#A refers to itself; version 0 has no recursive types`,
    ],
  );
});

Deno.test("a cycle at depth 1537 gives one depth report", () => {
  const found = validate(cycleAt(LIMIT + 1));
  assertEquals(found.filter((d) => d.message.endsWith(BOUND)).length, 1);
  assertEquals(found.filter((d) => d.message.includes("refers to itself")), []);
});

// ------------------------------------------------------------ each walker alone

/** Runs one walker on its own report, so another walker cannot hide its result. */
function alone(
  module: ModuleIR,
  run: (ctx: { world: ReturnType<typeof buildWorld>; report: Report }) => void,
): string[] {
  const report = new Report();
  run({ world: buildWorld(module), report });
  return report.items.map((d) => `${d.code} ${d.message}`);
}

Deno.test("each walker reports the bound on its own at depth 1537 and not at 1536", () => {
  const index = indexOf(lowerBase(), "A");
  const at = `declarations[${index}].definition.type`;
  const span = { source: "m.eff", start: 0, end: 0 };
  for (const levels of [LIMIT, LIMIT + 1]) {
    const type = nested(levels, INT);
    const module = lowerBase();
    const expected = levels > LIMIT
      ? [`validation/002 ${at}${".element".repeat(levels)}: ${BOUND}`]
      : [];
    assertEquals(
      alone(module, (ctx) => checkTypeIds(ctx, type, at, span)),
      expected,
      `identity walker at ${levels}`,
    );
    assertEquals(
      alone(module, (ctx) => checkRecordFields(ctx, type, at, span)),
      expected,
      `field walker at ${levels}`,
    );
    const cyclic = cycleAt(levels);
    assertEquals(
      alone(cyclic, (ctx) => checkRecursion(ctx, cyclic)),
      levels > LIMIT ? [`validation/002 declarations[${index}]: ${BOUND}`] : [
        `validation/002 declarations[${index}]: the type type:m#A refers to itself; version 0 has no recursive types`,
      ],
      `recursion walker at ${levels}`,
    );
  }
});

// -------------------------------------------------------------- one per declaration

Deno.test("two deep branches in one declaration give one depth report", () => {
  const module = lowerBase();
  setAlias(module, "A", {
    kind: "record",
    fields: [
      { name: "left", type: nested(LIMIT + 1, INT), optional: false },
      { name: "right", type: nested(LIMIT + 2, INT), optional: false },
    ],
  });
  assertEquals(depthReports(module).length, 1);
});

Deno.test("each declaration with a deep type gives its own depth report", () => {
  const module = lowerBase();
  setAlias(module, "A", nested(LIMIT + 1, INT));
  setAlias(module, "B", nested(LIMIT + 1, INT));
  const found = depthReports(module);
  assertEquals(found.length, 2);
  assertEquals(
    found.map((d) => d.message.slice(0, d.message.indexOf("."))).sort(),
    [
      `declarations[${indexOf(module, "A")}]`,
      `declarations[${indexOf(module, "B")}]`,
    ].sort(),
  );
});

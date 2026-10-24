// Tests for the IR shape table of the emitter (src/core/emit/shape.ts). A
// reflective walker finds the sub-expressions of every node of the example IR
// and of the emit fixtures. The table must find the same nodes. The test also
// pins the leaf kinds and the deferred children of the kinds that the table
// lists with a `deferred` row.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type {
  Annotation,
  Expr,
  ModuleIR,
  Parameter,
  Type,
} from "../src/core/ir.ts";
import {
  childrenOf,
  evaluatedChildren,
  isLeafExpr,
  type LeafKind,
} from "../src/core/emit/shape.ts";
import { walkExpr } from "../src/core/emit/walk.ts";
import { EXAMPLE_ENTRIES, exampleFiles, projectFiles } from "./helpers.ts";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpr(value: unknown): value is Expr {
  return isObj(value) && "kind" in value && "type" in value &&
    "effects" in value && "span" in value;
}

const SKIPPED = new Set(["type", "effects", "span"]);

/** The nearest Expr descendants of a node, found by reflection, in property order. */
function reflectiveChildren(node: Expr): Expr[] {
  const found: Expr[] = [];
  const descend = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(descend);
    else if (isExpr(value)) found.push(value);
    else if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (!SKIPPED.has(key)) descend(child);
      }
    }
  };
  for (const [key, child] of Object.entries(node)) {
    if (!SKIPPED.has(key)) descend(child);
  }
  return found;
}

function lowerOk(files: Record<string, string>, entries: readonly string[]) {
  const checked = checkProject(memoryHost(files), "", entries);
  assert(checked.ok);
  const modules: ModuleIR[] = [];
  for (const result of lowerProject(checked.value).values()) {
    assert(result.ok);
    modules.push(result.value);
  }
  return modules;
}

function irOfExamplesAndEmitFixtures(): ModuleIR[] {
  const modules = lowerOk(exampleFiles(), EXAMPLE_ENTRIES);
  for (const dir of ["emit/groups", "emit/schedules", "emit/scopes"]) {
    const files = projectFiles(dir);
    const entries = Object.keys(files).filter((f) => f.endsWith(".eff"));
    const host = "host.effi" in files
      ? {
        host: { boundary: { interface: "./host.effi", module: "./host.ts" } },
      }
      : {};
    modules.push(
      ...lowerOk({ ...files, "effektive.json": JSON.stringify(host) }, entries),
    );
  }
  return modules;
}

Deno.test("childrenOf finds the nodes that a reflective walk finds", () => {
  let nodes = 0;
  for (const ir of irOfExamplesAndEmitFixtures()) {
    for (const declaration of ir.declarations) {
      const root = declaration.kind === "function"
        ? declaration.body
        : declaration.kind === "constant"
        ? declaration.value
        : undefined;
      if (root === undefined) continue;
      walkExpr(root, (node) => {
        const typed = childrenOf(node);
        const reflected = reflectiveChildren(node);
        assertEquals(typed.length, reflected.length, node.kind);
        for (const child of reflected) {
          assert(typed.includes(child), `${node.kind} lacks ${child.kind}`);
        }
        nodes += 1;
      });
    }
  }
  assert(nodes > 300, `${nodes} nodes compared`);
});

// ------------------------------------------------------------------ forged nodes

const SPAN = { source: "shape.eff", start: 0, end: 0 };
const UNIT: Type = { kind: "primitive", name: "unit" };
const A: Annotation = {
  type: UNIT,
  execution: "pure",
  effects: { failures: [], requirements: [] },
  span: SPAN,
};

function lit(value: number): Expr {
  return { ...A, kind: "literal", value };
}

const PARAMETER: Parameter = {
  id: "local:p",
  name: "p",
  type: UNIT,
  span: SPAN,
};

Deno.test("evaluatedChildren omits the deferred children of a leaf", () => {
  const [a, b, c] = [1, 2, 3].map((value) => ({
    ...A,
    kind: "closure" as const,
    parameters: [],
    body: lit(value),
  }));
  const cases: readonly [Expr, readonly Expr[], readonly Expr[]][] = [
    [{ ...A, kind: "with-fiber", job: a, use: b }, [a], [
      a,
      b,
    ]],
    [{ ...A, kind: "fold-effect-stream", stream: a, seed: b, update: c }, [
      a,
      b,
    ], [a, b, c]],
    [{ ...A, kind: "retry", job: a, times: 1 }, [], [a]],
    [{ ...A, kind: "provide", provider: a, job: b }, [], [a, b]],
    [{ ...A, kind: "retry-with-schedule", job: a, options: b }, [], [a, b]],
    [
      {
        ...A,
        kind: "with-resource",
        acquire: a,
        use: b,
        release: c,
      },
      [],
      [a, b, c],
    ],
    [
      {
        ...A,
        kind: "catch",
        body: a,
        handlers: [{
          error: "error:t#E",
          binding: PARAMETER,
          body: b,
          span: SPAN,
        }],
      },
      [],
      [a, b],
    ],
  ];
  for (const [node, evaluated, all] of cases) {
    assert(isLeafExpr(node), node.kind);
    assertEquals(evaluatedChildren(node), evaluated, node.kind);
    assertEquals(childrenOf(node), all, node.kind);
  }
});

Deno.test("a structural node has no evaluated children, and a call has all", () => {
  const [a, b] = [lit(1), lit(2)];
  const conditional: Expr = {
    ...A,
    kind: "if",
    condition: a,
    then: b,
    else: b,
  };
  assert(!isLeafExpr(conditional));
  assertEquals(evaluatedChildren(conditional), []);
  assertEquals(childrenOf(conditional), [a, b, b]);
  const call: Expr = { ...A, kind: "call", callee: a, arguments: [b] };
  assert(!isLeafExpr(call));
  assertEquals(evaluatedChildren(call), [a, b]);
});

Deno.test("the table marks the 34 leaf kinds", () => {
  const kinds = new Set<string>();
  for (const ir of irOfExamplesAndEmitFixtures()) {
    for (const declaration of ir.declarations) {
      const root = declaration.kind === "function"
        ? declaration.body
        : declaration.kind === "constant"
        ? declaration.value
        : undefined;
      if (root === undefined) continue;
      walkExpr(root, (node) => {
        if (isLeafExpr(node)) kinds.add(node.kind);
      });
    }
  }
  // The fixtures reach part of the 34 kinds. Each reached kind is in the list.
  const LEAVES = {
    "schema-make": true,
    "schema-decode": true,
    "schema-encode": true,
    "perform": true,
    "fail": true,
    "retry": true,
    "retry-with-schedule": true,
    "with-fiber": true,
    "join-fiber": true,
    "interrupt-fiber": true,
    "provide": true,
    "run": true,
    "partition-all": true,
    "validate-all": true,
    "all-results": true,
    "scoped": true,
    "fork-scoped": true,
    "make-scope": true,
    "provide-scope": true,
    "add-scope-finalizer": true,
    "close-scope": true,
    "catch": true,
    "with-resource": true,
    "run-stream": true,
    "fold-stream": true,
    "fold-effect-stream": true,
    "collect-stream": true,
    "head-stream": true,
    "last-stream": true,
    "drain-stream": true,
    "make-ref": true,
    "get-ref": true,
    "set-ref": true,
    "update-ref": true,
  } satisfies Record<LeafKind, true>;

  assert(kinds.size > 5, `${kinds.size} leaf kinds reached`);
  assertEquals(Object.keys(LEAVES).length, 34);
  for (const kind of kinds) assert(Object.hasOwn(LEAVES, kind), kind);
});

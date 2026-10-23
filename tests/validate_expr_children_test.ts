// Differential test for `exprChildren`, the typed child enumeration of the
// validator (src/core/validate/expr.ts). An independent reflective walker in
// this file finds the nearest Expr descendants of a node. Both must give the
// same nodes for every node of every fixture IR. The fixtures reach only part
// of the Expr kinds, so the test adds one synthetic node for each kind.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type {
  Annotation,
  Expr,
  ModuleIR,
  Parameter,
  Pattern,
  Type,
} from "../src/core/ir.ts";
import { exprChildren } from "../src/core/validate/expr.ts";
import { FIXTURES } from "./helpers.ts";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ reflective walker

/** An Expr is an object with the four annotation keys. */
function isExpr(value: unknown): value is Expr {
  return isObj(value) && "kind" in value && "type" in value &&
    "effects" in value && "span" in value;
}

const SKIPPED = new Set(["type", "effects", "span"]);

/**
 * The nearest Expr descendants of a node, found by reflection. It reads every
 * property except the annotation keys and stops at the first Expr below each
 * property. The order is the property order, not the evaluation order.
 */
function reflectiveChildren(node: Expr): Expr[] {
  const found: Expr[] = [];
  const descend = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(descend);
    } else if (isExpr(value)) {
      found.push(value);
    } else if (isObj(value)) {
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

/** Every Expr below a value, parents first, found by reflection. */
function allExprs(root: unknown, into: Expr[]): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isExpr(value)) {
      into.push(value);
      reflectiveChildren(value).forEach(visit);
    } else if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (!SKIPPED.has(key)) visit(child);
      }
    }
  };
  visit(root);
}

/** The nodes of a list as a map from node identity to the number of times it occurs. */
function identityCounts(nodes: readonly Expr[]): Map<Expr, number> {
  const counts = new Map<Expr, number>();
  for (const node of nodes) counts.set(node, (counts.get(node) ?? 0) + 1);
  return counts;
}

function assertSameChildren(node: Expr, label: string): void {
  const typed = exprChildren(node);
  const reflected = reflectiveChildren(node);
  assertEquals(typed.length, reflected.length, `${label}: ${node.kind}`);
  const wanted = identityCounts(reflected);
  for (const [child, count] of identityCounts(typed)) {
    assertEquals(
      wanted.get(child),
      count,
      `${label}: ${node.kind} child ${child.kind}`,
    );
  }
}

// ------------------------------------------------------------------ fixture IR

interface Unit {
  readonly label: string;
  readonly files: Record<string, string>;
  readonly entries: readonly string[];
}

/**
 * Directories whose files form one project without an `effective.json`. The
 * emit tests add a configuration for them, and so does this test.
 */
const BUNDLES = new Set([
  "emit/groups",
  "emit/schedules",
  "emit/scopes",
  "emit/sinks",
]);

const SOURCE_FILE = /\.(eff|effi|json)$/;

function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of Deno.readDirSync(new URL(relative + "/", FIXTURES))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory) walk(child);
      else if (SOURCE_FILE.test(entry.name)) {
        files[child.slice(dir.length + 1)] = Deno.readTextFileSync(
          new URL(child, FIXTURES),
        );
      }
    }
  };
  walk(dir);
  return files;
}

function entriesOf(files: Record<string, string>): string[] {
  return Object.keys(files).filter((path) => path.endsWith(".eff")).sort();
}

/** The fixture directories as projects, found by the rules in the comments. */
function fixtureUnits(): Unit[] {
  const units: Unit[] = [];
  const walk = (dir: string): void => {
    const names = [...Deno.readDirSync(new URL(dir + "/", FIXTURES))];
    if (names.some((e) => e.isFile && e.name === "effective.json")) {
      const files = readTree(dir);
      units.push({ label: dir, files, entries: entriesOf(files) });
      return;
    }
    if (BUNDLES.has(dir)) {
      const files = readTree(dir);
      const host = "host.effi" in files
        ? {
          host: { boundary: { interface: "./host.effi", module: "./host.ts" } },
        }
        : {};
      units.push({
        label: dir,
        files: { ...files, "effective.json": JSON.stringify(host) },
        entries: entriesOf(files),
      });
      return;
    }
    for (const entry of names) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory) walk(child);
      else if (entry.name.endsWith(".eff")) {
        units.push({
          label: child,
          files: {
            "effective.json": "{}",
            [entry.name]: Deno.readTextFileSync(new URL(child, FIXTURES)),
          },
          entries: [entry.name],
        });
      }
    }
  };
  for (const entry of Deno.readDirSync(FIXTURES)) {
    if (entry.isDirectory) walk(entry.name);
  }
  return units;
}

/** The IR of every fixture module that checks and lowers without diagnostics. */
function fixtureModules(): { label: string; ir: ModuleIR }[] {
  const modules: { label: string; ir: ModuleIR }[] = [];
  for (const unit of fixtureUnits()) {
    const checked = checkProject(memoryHost(unit.files), "", unit.entries);
    if (!checked.ok) continue;
    for (const [name, result] of lowerProject(checked.value)) {
      if (result.ok) {
        modules.push({ label: `${unit.label}:${name}`, ir: result.value });
      }
    }
  }
  return modules;
}

// ------------------------------------------------------------------ synthetic nodes

const SPAN = { source: "synthetic.eff", start: 0, end: 0 };
const UNIT: Type = { kind: "primitive", name: "unit" };
const ANNOTATION: Annotation = {
  type: UNIT,
  execution: "pure",
  effects: { failures: [], requirements: [] },
  span: SPAN,
};

let counter = 0;

/** A new leaf expression. Each call makes a distinct object. */
function leaf(): Expr {
  counter += 1;
  return { ...ANNOTATION, kind: "literal", value: counter };
}

function parameter(name: string): Parameter {
  return { id: `local:${name}`, name, type: UNIT, span: SPAN };
}

const WILDCARD: Pattern = { kind: "wildcard", span: SPAN };

/**
 * One node of each Expr kind. Every child is a distinct leaf. The record type
 * makes the compiler reject a missing or an extra kind. A new Expr kind needs
 * a line here, and so a new case for exprChildren.
 */
function syntheticNodes(): Record<Expr["kind"], Expr> {
  const a = ANNOTATION;
  return {
    literal: { ...a, kind: "literal", value: 1 },
    null: { ...a, kind: "null" },
    reference: { ...a, kind: "reference", target: "local:x" },
    record: {
      ...a,
      kind: "record",
      fields: [{ name: "a", value: leaf() }, { name: "b", value: leaf() }],
    },
    array: { ...a, kind: "array", elements: [leaf(), leaf()] },
    tuple: { ...a, kind: "tuple", elements: [leaf(), leaf()] },
    get: { ...a, kind: "get", record: leaf(), field: "a" },
    update: {
      ...a,
      kind: "update",
      record: leaf(),
      fields: [{ name: "a", value: leaf() }, { name: "b", value: leaf() }],
    },
    brand: { ...a, kind: "brand", brand: "type:t#B", value: leaf() },
    data: { ...a, kind: "data", data: "type:t#D", value: leaf() },
    unbrand: { ...a, kind: "unbrand", value: leaf() },
    some: { ...a, kind: "some", value: leaf() },
    none: { ...a, kind: "none" },
    error: {
      ...a,
      kind: "error",
      error: "error:t#E",
      fields: [{ name: "a", value: leaf() }],
    },
    closure: {
      ...a,
      kind: "closure",
      parameters: [parameter("p")],
      body: leaf(),
    },
    call: { ...a, kind: "call", callee: leaf(), arguments: [leaf(), leaf()] },
    defer: { ...a, kind: "defer", job: leaf() },
    run: { ...a, kind: "run", value: leaf() },
    scoped: { ...a, kind: "scoped", value: leaf() },
    "fork-scoped": { ...a, kind: "fork-scoped", job: leaf() },
    "make-scope": { ...a, kind: "make-scope" },
    "provide-scope": {
      ...a,
      kind: "provide-scope",
      owner: leaf(),
      job: leaf(),
    },
    "add-scope-finalizer": {
      ...a,
      kind: "add-scope-finalizer",
      owner: leaf(),
      job: leaf(),
    },
    "close-scope": { ...a, kind: "close-scope", owner: leaf() },
    "with-resource": {
      ...a,
      kind: "with-resource",
      acquire: leaf(),
      use: leaf(),
      release: leaf(),
      useBinding: "local:u",
      releaseBinding: "local:r",
    },
    unfold: { ...a, kind: "unfold", seed: leaf(), next: leaf() },
    "map-effect": {
      ...a,
      kind: "map-effect",
      stream: leaf(),
      transform: leaf(),
      concurrency: undefined,
    },
    "map-stream": {
      ...a,
      kind: "map-stream",
      stream: leaf(),
      transform: leaf(),
    },
    "map-groups": {
      ...a,
      kind: "map-groups",
      stream: leaf(),
      key: leaf(),
      use: leaf(),
      bufferSize: 1,
      groupBinding: "local:g",
    },
    "scan-stream": {
      ...a,
      kind: "scan-stream",
      stream: leaf(),
      seed: leaf(),
      update: leaf(),
    },
    "map-accum-stream": {
      ...a,
      kind: "map-accum-stream",
      stream: leaf(),
      seed: leaf(),
      update: leaf(),
    },
    "fold-stream": {
      ...a,
      kind: "fold-stream",
      stream: leaf(),
      seed: leaf(),
      update: leaf(),
    },
    "fold-effect-stream": {
      ...a,
      kind: "fold-effect-stream",
      stream: leaf(),
      seed: leaf(),
      update: leaf(),
    },
    "collect-stream": { ...a, kind: "collect-stream", stream: leaf() },
    "head-stream": { ...a, kind: "head-stream", stream: leaf() },
    "last-stream": { ...a, kind: "last-stream", stream: leaf() },
    "drain-stream": { ...a, kind: "drain-stream", stream: leaf() },
    "flat-map-streams": {
      ...a,
      kind: "flat-map-streams",
      stream: leaf(),
      transform: leaf(),
      concurrency: 2,
    },
    "switch-map-streams": {
      ...a,
      kind: "switch-map-streams",
      stream: leaf(),
      transform: leaf(),
    },
    "catch-stream": {
      ...a,
      kind: "catch-stream",
      stream: leaf(),
      recover: leaf(),
    },
    "retry-stream": {
      ...a,
      kind: "retry-stream",
      stream: leaf(),
      policy: leaf(),
    },
    "debounce-stream": {
      ...a,
      kind: "debounce-stream",
      stream: leaf(),
      delayMs: 1,
    },
    "throttle-stream": {
      ...a,
      kind: "throttle-stream",
      stream: leaf(),
      units: 1,
      durationMs: 1,
      strategy: "shape",
    },
    "take-stream": {
      ...a,
      kind: "take-stream",
      stream: leaf(),
      count: leaf(),
    },
    "drop-stream": {
      ...a,
      kind: "drop-stream",
      stream: leaf(),
      count: leaf(),
    },
    "drop-while-stream": {
      ...a,
      kind: "drop-while-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "filter-stream": {
      ...a,
      kind: "filter-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "filter-effect-stream": {
      ...a,
      kind: "filter-effect-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "take-while-effect-stream": {
      ...a,
      kind: "take-while-effect-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "take-until-effect-stream": {
      ...a,
      kind: "take-until-effect-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "drop-while-effect-stream": {
      ...a,
      kind: "drop-while-effect-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "take-while-stream": {
      ...a,
      kind: "take-while-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "take-until-stream": {
      ...a,
      kind: "take-until-stream",
      stream: leaf(),
      predicate: leaf(),
    },
    "partition-all": {
      ...a,
      kind: "partition-all",
      jobs: leaf(),
      concurrency: undefined,
    },
    "validate-all": {
      ...a,
      kind: "validate-all",
      jobs: leaf(),
      onErrors: leaf(),
      concurrency: undefined,
    },
    "all-results": {
      ...a,
      kind: "all-results",
      jobs: leaf(),
      concurrency: "unbounded",
    },
    "sink-for-each": { ...a, kind: "sink-for-each", consume: leaf() },
    "take-sink": { ...a, kind: "take-sink", count: 1 },
    "transduce-stream": {
      ...a,
      kind: "transduce-stream",
      stream: leaf(),
      sink: leaf(),
    },
    "aggregate-stream": {
      ...a,
      kind: "aggregate-stream",
      stream: leaf(),
      sink: leaf(),
    },
    "aggregate-within-stream": {
      ...a,
      kind: "aggregate-within-stream",
      stream: leaf(),
      sink: leaf(),
      schedule: leaf(),
    },
    "schedule-from-step": {
      ...a,
      kind: "schedule-from-step",
      initial: leaf(),
      decide: leaf(),
    },
    "schedule-recurs": { ...a, kind: "schedule-recurs", times: leaf() },
    "schedule-spaced": { ...a, kind: "schedule-spaced", delayMillis: leaf() },
    "schedule-map": {
      ...a,
      kind: "schedule-map",
      schedule: leaf(),
      transform: leaf(),
    },
    "schedule-max": {
      ...a,
      kind: "schedule-max",
      left: leaf(),
      right: leaf(),
    },
    "schedule-min": {
      ...a,
      kind: "schedule-min",
      left: leaf(),
      right: leaf(),
    },
    "schedule-concat": {
      ...a,
      kind: "schedule-concat",
      left: leaf(),
      right: leaf(),
    },
    "run-stream": {
      ...a,
      kind: "run-stream",
      stream: leaf(),
      sink: leaf(),
    },
    "buffer-stream": {
      ...a,
      kind: "buffer-stream",
      stream: leaf(),
      capacity: 1,
    },
    "merge-streams": {
      ...a,
      kind: "merge-streams",
      left: leaf(),
      right: leaf(),
    },
    "zip-streams": {
      ...a,
      kind: "zip-streams",
      left: leaf(),
      right: leaf(),
    },
    "concat-streams": {
      ...a,
      kind: "concat-streams",
      left: leaf(),
      right: leaf(),
    },
    race: { ...a, kind: "race", left: leaf(), right: leaf() },
    "make-ref": { ...a, kind: "make-ref", value: leaf() },
    "get-ref": { ...a, kind: "get-ref", ref: leaf() },
    "set-ref": { ...a, kind: "set-ref", ref: leaf(), value: leaf() },
    "update-ref": {
      ...a,
      kind: "update-ref",
      ref: leaf(),
      transform: leaf(),
    },
    layer: { ...a, kind: "layer", service: "service:t#S", acquire: leaf() },
    "merge-layers": {
      ...a,
      kind: "merge-layers",
      left: leaf(),
      right: leaf(),
    },
    "retry-schedule": { ...a, kind: "retry-schedule", step: leaf() },
    "retry-with-schedule": {
      ...a,
      kind: "retry-with-schedule",
      job: leaf(),
      options: leaf(),
    },
    codec: { ...a, kind: "codec", decode: leaf(), encode: leaf() },
    schema: {
      ...a,
      kind: "schema",
      op: "struct",
      arguments: [leaf(), leaf()],
    },
    "schema-decode": {
      ...a,
      kind: "schema-decode",
      schema: leaf(),
      input: leaf(),
    },
    "schema-encode": {
      ...a,
      kind: "schema-encode",
      schema: leaf(),
      input: leaf(),
    },
    "schema-make": {
      ...a,
      kind: "schema-make",
      schema: leaf(),
      input: leaf(),
    },
    decode: { ...a, kind: "decode", codec: leaf(), input: leaf() },
    encode: { ...a, kind: "encode", codec: leaf(), input: leaf() },
    "with-fiber": {
      ...a,
      kind: "with-fiber",
      job: leaf(),
      use: leaf(),
      useBinding: "local:f",
    },
    "join-fiber": { ...a, kind: "join-fiber", fiber: leaf() },
    "interrupt-fiber": { ...a, kind: "interrupt-fiber", fiber: leaf() },
    perform: {
      ...a,
      kind: "perform",
      capability: "cap:t#S.m",
      arguments: [leaf(), leaf()],
    },
    block: {
      ...a,
      kind: "block",
      steps: [
        { kind: "bind", binding: parameter("b"), value: leaf() },
        { kind: "evaluate", value: leaf() },
      ],
      result: leaf(),
    },
    if: {
      ...a,
      kind: "if",
      condition: leaf(),
      then: leaf(),
      else: leaf(),
    },
    match: {
      ...a,
      kind: "match",
      subject: leaf(),
      arms: [
        { pattern: WILDCARD, body: leaf() },
        { pattern: WILDCARD, body: leaf() },
      ],
    },
    fail: { ...a, kind: "fail", error: leaf() },
    catch: {
      ...a,
      kind: "catch",
      body: leaf(),
      handlers: [{
        error: "error:t#E",
        binding: parameter("h"),
        body: leaf(),
        span: SPAN,
      }],
    },
    retry: { ...a, kind: "retry", job: leaf(), times: 1 },
    provide: { ...a, kind: "provide", provider: leaf(), job: leaf() },
    binary: {
      ...a,
      kind: "binary",
      operator: "+",
      left: leaf(),
      right: leaf(),
    },
  };
}

// ------------------------------------------------------------------ tests

const MODULES = fixtureModules();

Deno.test("exprChildren equals a reflective walk on every node of every fixture IR", () => {
  assert(MODULES.length > 20, `${MODULES.length} fixture modules lowered`);
  let nodes = 0;
  for (const { label, ir } of MODULES) {
    const all: Expr[] = [];
    allExprs(ir, all);
    for (const node of all) {
      assertSameChildren(node, label);
      nodes += 1;
    }
  }
  assert(nodes > 1000, `${nodes} nodes compared`);
});

Deno.test("exprChildren equals a reflective walk on a synthetic node of every Expr kind", () => {
  const synthetic = syntheticNodes();
  const kinds = Object.keys(synthetic);
  // The plan counts 101 kinds in the Expr union of src/core/ir.ts.
  assertEquals(kinds.length, 101);
  for (const [kind, node] of Object.entries(synthetic)) {
    assertEquals(node.kind, kind);
    assertSameChildren(node, "synthetic");
  }
  // Leaf kinds have no child. The other kinds have at least one.
  const leaves = new Set([
    "literal",
    "null",
    "reference",
    "none",
    "make-scope",
    "take-sink",
  ]);
  for (const [kind, node] of Object.entries(synthetic)) {
    assertEquals(exprChildren(node).length === 0, leaves.has(kind), kind);
  }
});

Deno.test("the fixtures and the synthetic nodes together reach every Expr kind", () => {
  const reached = new Set<string>();
  for (const { ir } of MODULES) {
    const all: Expr[] = [];
    allExprs(ir, all);
    for (const node of all) reached.add(node.kind);
  }
  const synthetic = new Set(Object.keys(syntheticNodes()));
  assertEquals(new Set([...reached, ...synthetic]).size, 101);
  for (const kind of reached) assert(synthetic.has(kind), kind);
});

// Tests for the failure results of lowering and emission. Twelve sites throw
// `unsupported`. The checker or the parser excludes all of them, so no source
// program reaches one, and these tests forge the input: a changed CheckedProject for `lowerModule`, and changed IR for
// `emitModule`.
// The same file tests the other results of the two entry points: `no-interface`,
// `internal`, and the rethrow of a foreign error.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type CheckedProject,
  checkProject,
} from "../src/core/check_project.ts";
import type { Expr, ModuleIR, Type } from "../src/core/ir.ts";
import { lowerModule, lowerProject } from "../src/core/lower.ts";
import { type EmitContext, emitModule } from "../src/core/emit/emit.ts";
import { walkExpr } from "../src/core/emit/walk.ts";
import type { ProjectConfig } from "../src/core/project.ts";
import { memoryHost } from "../src/core/source.ts";

type Obj = Record<string, unknown>;

// ------------------------------------------------------------------ helpers

function check(files: Record<string, string>): CheckedProject {
  const entries = Object.keys(files).filter((f) => f.endsWith(".eff"));
  const result = checkProject(
    memoryHost({ "effektive.json": "{}", ...files }),
    "",
    entries,
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/** Checks one module with no diagnostics and lowers it. */
function lowerOk(text: string): {
  readonly checked: CheckedProject;
  readonly ir: ModuleIR;
} {
  const checked = check({ "main.eff": text });
  assertEquals(checked.diagnostics, []);
  const lowered = lowerProject(checked).get("main");
  assert(lowered?.ok, JSON.stringify(lowered));
  return { checked, ir: lowered.value };
}

/** The project with every diagnostic removed, so that the lowering runs. */
function withoutDiagnostics(checked: CheckedProject): CheckedProject {
  return {
    ...checked,
    diagnostics: [],
    modules: new Map(
      [...checked.modules].map((
        [name, m],
      ) => [name, { ...m, diagnostics: [] }]),
    ),
  };
}

const NO_CONFIG: EmitContext = { config: { host: new Map() } };

function emitError(ir: ModuleIR, context: EmitContext = NO_CONFIG) {
  const result = emitModule(ir, context);
  assert(!result.ok, "the emission should fail");
  return result.error;
}

function declarationOf(ir: ModuleIR, name: string) {
  const found = ir.declarations.find((d) => d.name === name);
  assert(found !== undefined, name);
  return found;
}

function rootOf(ir: ModuleIR, name: string): Expr {
  const d = declarationOf(ir, name);
  assert(d.kind === "function" || d.kind === "constant", name);
  return d.kind === "function" ? d.body : d.value;
}

/** The first expression below `root` that satisfies `test`. */
function find(root: Expr, test: (e: Expr) => boolean): Expr {
  let found: Expr | undefined;
  walkExpr(root, (e) => {
    if (found === undefined && test(e)) found = e;
  });
  assert(found !== undefined, "no expression matches");
  return found;
}

/** Replaces the fields of a node. The IR types are read-only, so the edit goes through an object. */
function assign(node: Expr, fields: Obj): void {
  Object.assign(node, fields);
}

const INT: Type = { kind: "primitive", name: "int" };
const FUNCTION: Type = {
  kind: "function",
  execution: "pure",
  parameters: [INT],
  result: INT,
  effects: { failures: [], requirements: [] },
};

// ------------------------------------------------------------------ checker: error construction by a pipeline

Deno.test("a pipeline into an error constructor is a checker error", () => {
  // The direct form `Stop({ ... })` needs a record literal (check_expr.ts
  // errorConstruction). A pipeline stage has no record literal of its own, so
  // both stage forms get type-mismatch/010 on the stage when the piped value fits.
  const message =
    "the error `Stop` needs a record literal such as Stop({ field: value })";
  const head = "error Stop = { code: int }\ntype R = { code: int }\n" +
    "const r: R = { code: 1 }\n";
  const cases: readonly (readonly [string, string])[] = [
    ["({ code: 1 }) |> Stop()", "Stop()"],
    ["({ code: 1 }) |> Stop", "Stop"],
    ["r |> Stop()", "Stop()"],
    ["r |> Stop", "Stop"],
  ];
  for (const [expression, stage] of cases) {
    const text = `${head}const mk = (): Stop => ${expression}\n`;
    const checked = check({ "main.eff": text });
    const found = checked.diagnostics.filter((d) =>
      d.code === "type-mismatch/010"
    );
    assertEquals(found.length, 1, expression);
    assertEquals(found[0].message, message, expression);
    assertEquals(text.slice(found[0].span.start, found[0].span.end), stage);
    assertEquals(checked.diagnostics.length, 1, expression);
  }
});

Deno.test("a piped value that does not fit an error constructor gets only its type report", () => {
  // As in the direct form `Stop(1)`, the type report is the only diagnostic.
  for (const value of ["1", "({ code: 1, x: 2 })"]) {
    for (const stage of ["Stop()", "Stop"]) {
      const text = "error Stop = { code: int }\n" +
        `const mk = (): Stop => ${value} |> ${stage}\n`;
      const checked = check({ "main.eff": text });
      assertEquals(
        checked.diagnostics.map((d) => d.code),
        ["type-mismatch/003"],
        `${value} |> ${stage}`,
      );
    }
  }
});

Deno.test("a wrong-arity pipeline into an error constructor keeps its arity diagnostic", () => {
  const text = "error Stop = { code: int }\n" +
    "const mk = (): Stop => ({ code: 1 }) |> Stop({ code: 2 })\n";
  const checked = check({ "main.eff": text });
  assertEquals(checked.diagnostics.map((d) => d.code), ["type-mismatch/004"]);
});

// ------------------------------------------------------------------ lowering: forged CheckedProject

Deno.test("a record spread after a field lowers to an unsupported error when the diagnostics are forged away", () => {
  // The parser (parse.ts:1360, syntax/014) and the checker (check_expr.ts:6383,
  // type-mismatch/005) reject the program. Removing the diagnostics reaches
  // the lowering of the tree.
  const text = "type R = { a: int, b: int }\n" +
    "const base: R = { a: 1, b: 2 }\n" +
    "const mk = (): R => ({ a: 1, ...base })\n";
  const checked = check({ "main.eff": text });
  assert(checked.diagnostics.length > 0);
  assert(!lowerModule(checked, "main").ok);
  const forged = lowerModule(withoutDiagnostics(checked), "main");
  assert(!forged.ok);
  assert(forged.error.tag === "unsupported", JSON.stringify(forged.error));
  assertEquals(
    forged.error.message,
    "a record spread must come first in a record",
  );
  assert(
    text.slice(forged.error.span.start, forged.error.span.end).includes(
      "...base",
    ),
  );
});

Deno.test("a pipeline into an error constructor lowers to an unsupported error when the diagnostics are forged away", () => {
  // The checker rejects the program (type-mismatch/010). Removing the
  // diagnostics reaches the lowering of the error construction.
  const text = "error Stop = { code: int }\n" +
    "const mk = (): Stop => ({ code: 1 }) |> Stop()\n";
  const checked = check({ "main.eff": text });
  assert(checked.diagnostics.length > 0);
  assert(!lowerModule(checked, "main").ok);
  const forged = lowerModule(withoutDiagnostics(checked), "main");
  assert(!forged.ok);
  assert(forged.error.tag === "unsupported", JSON.stringify(forged.error));
  assertEquals(
    forged.error.message,
    "an error is constructed from a record literal; this argument is not one",
  );
  assertEquals(
    text.slice(forged.error.span.start, forged.error.span.end),
    "Stop()",
  );
});

Deno.test("an imported module without an interface gives no-interface", () => {
  const checked = check({
    "lib.eff": "export type Int = int\n",
    "main.eff": 'import { Int } from "./lib.eff"\nconst x: Int = 1\n',
  });
  assertEquals(checked.diagnostics, []);
  const lib = checked.modules.get("lib");
  assert(lib !== undefined);
  const forged: CheckedProject = {
    ...checked,
    modules: new Map(
      [...checked.modules].map(([name, m]) => [
        name,
        name === "lib"
          ? {
            ...m,
            interface: {
              ok: false as const,
              error: { tag: "missing-modes" as const, ids: [] },
            },
          }
          : m,
      ]),
    ),
  };
  const result = lowerModule(forged, "main");
  assert(!result.ok);
  assertEquals(result.error, {
    tag: "no-interface",
    module: "main",
    imported: "lib",
  });
  // The unforged project lowers.
  assert(lowerModule(checked, "main").ok);
});

Deno.test("a missing target table entry gives an internal lowering error", () => {
  const checked = check({
    "main.eff": "type Int = int\nconst a: Int = 1\nconst b = (): Int => a\n",
  });
  assertEquals(checked.diagnostics, []);
  const resolution = checked.analysis.resolutions.get("main");
  assert(resolution !== undefined);
  const forged: CheckedProject = {
    ...checked,
    analysis: {
      ...checked.analysis,
      resolutions: new Map([
        ["main", { ...resolution, targets: new Map() }],
      ]),
    },
  };
  const result = lowerModule(forged, "main");
  assert(!result.ok);
  assert(result.error.tag === "internal", JSON.stringify(result.error));
  assertEquals(result.error.module, "main");
  assert(result.error.message.length > 0);
});

Deno.test("lowerModule rethrows an error that is not a lowering failure", () => {
  const checked = check({
    "main.eff": "type Int = int\nconst a: Int = 1\n",
  });
  const forged: CheckedProject = {
    ...checked,
    table: new Proxy(checked.table, {
      get(target, key, receiver) {
        if (key === "toIr" || key === "toIrFunction") {
          return () => {
            throw new RangeError("foreign");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    }),
  };
  assertThrows(() => lowerModule(forged, "main"), RangeError, "foreign");
});

// ------------------------------------------------------------------ emission: no source program fails

Deno.test("an effect-mode branch with a pure function type emits with a wrap", () => {
  // Decision D6. The block of the then branch is effect-mode and has a pure
  // function type, and the if has an effect function type. The emitter gives
  // the slot type to the branch, so the pure function is wrapped and no
  // `unsupported` result remains (emit/expr.ts fit).
  const text = `type Int = int
error Stop = {}
service Gate { pick(): Int fails Stop }
const pure = (n: Int): Int => n + 1
const other = (n: Int): Int => n + 2
const choose = (): ((n: Int) => Int fails Stop) fails Stop uses Gate.pick =>
  if (Gate.pick() > 0) { Gate.pick(); pure } else { other }
`;
  const { ir } = lowerOk(text);
  const result = emitModule(ir, NO_CONFIG);
  assert(result.ok, JSON.stringify(result));
  assert(result.value.text.includes("Effect.succeed(pure("));
  assert(!result.value.text.includes("return pure;"));
});

// ------------------------------------------------------------------ emission: forged IR

Deno.test("a builtin that is not a callee gives an unsupported emission error", () => {
  // The resolver rejects a builtin value (resolve.ts:863, unknown-name/004), and
  // the validator rejects it (validation/001).
  const { ir } = lowerOk(
    "type Int = int\nconst xs: Int[] = [1]\nconst ys = xs |> map((n) => n + 1)\n",
  );
  const forged = structuredClone(ir);
  const call = find(
    rootOf(forged, "ys"),
    (e) => e.kind === "call" && e.callee.kind === "reference",
  );
  assert(call.kind === "call");
  const declaration = declarationOf(forged, "ys");
  assert(declaration.kind === "constant");
  Object.assign(declaration, { value: call.callee });
  const error = emitError(forged);
  assert(error.tag === "unsupported");
  assertEquals(error.span, undefined);
  assert(
    /^the builtin value:main#\$builtin\/map\/[0-9a-f]+ is not in callee position$/
      .test(error.message),
    error.message,
  );
});

Deno.test("a builtin with no emission form gives an unsupported emission error", () => {
  // The checker makes builtin facts only for map, filter, fold, all, and
  // traverse (check_expr.ts:5732, 6070). The last two are effects and never
  // reach the pure call path.
  const { ir } = lowerOk(
    "type Int = int\nconst xs: Int[] = [1]\nconst ys = xs |> map((n) => n + 1)\n",
  );
  const forged = structuredClone(ir);
  const call = find(
    rootOf(forged, "ys"),
    (e) => e.kind === "call" && e.callee.kind === "reference",
  );
  assert(call.kind === "call" && call.callee.kind === "reference");
  Object.assign(call.callee, {
    target: call.callee.target.replace("/map/", "/sort/"),
  });
  const error = emitError(forged);
  assert(error.tag === "unsupported");
  assertEquals(error.message, "the builtin sort has no emission form");
  assert(error.span !== undefined);
});

const OPTION_MATCH = `type Int = int
const f = (t: Option<Int>): Int => match t { Some(x) => x, _ => 2 }
`;

function forgedMatch(arms: (arms: Obj[]) => Obj[]): ModuleIR {
  const { ir } = lowerOk(OPTION_MATCH);
  const forged = structuredClone(ir);
  const match = rootOf(forged, "f");
  assert(match.kind === "match");
  const [some, wildcard] = match.arms;
  const literalArm: Obj = {
    pattern: { kind: "literal", value: 1, span: some.pattern.span },
    body: some.body,
  };
  Object.assign(match, {
    arms: arms([{ ...some }, { ...wildcard }, literalArm]),
  });
  return forged;
}

Deno.test("a Some pattern in a match that is not an option match gives an unsupported emission error", () => {
  // The checker rejects it (check_expr.ts:7174, pattern/003). The last arm
  // decides the binding first, so the Some arm comes last.
  const error = emitError(forgedMatch(([some, , literal]) => [literal, some]));
  assert(error.tag === "unsupported");
  assertEquals(
    error.message,
    "a Some pattern in a match that is not an option match",
  );
});

Deno.test("an option test in a match that is not an option match gives an unsupported emission error", () => {
  // The Some arm comes before the last arm, so the arm test fails first.
  const error = emitError(
    forgedMatch(([some, wildcard, literal]) => [some, literal, wildcard]),
  );
  assert(error.tag === "unsupported");
  assertEquals(
    error.message,
    "an option pattern in a match that is not an option match",
  );
});

Deno.test("constants that depend on each other give an unsupported emission error", () => {
  // The checker rejects a cycle (check_project.ts:403, module/004). A constant
  // that names itself is skipped by the ordering, so the cycle has two members.
  const { ir } = lowerOk(
    "type Int = int\nconst a: Int = 1\nconst b: Int = a\n",
  );
  const forged = structuredClone(ir);
  const a = declarationOf(forged, "a");
  const b = declarationOf(forged, "b");
  assert(a.kind === "constant" && b.kind === "constant");
  const toA = structuredClone(b.value);
  assert(toA.kind === "reference");
  const toB = structuredClone(toA);
  Object.assign(toB, { target: b.id });
  Object.assign(a, { value: toB });
  const error = emitError(forged);
  assert(error.tag === "unsupported");
  assertEquals(error.message, "the constant a depends on itself");
  assert(error.span !== undefined);
});

const HOST_FILES = {
  "effektive.json": JSON.stringify({
    host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
  }),
  "host/p.effi": 'import { S } from "../s.eff"\nexport provider L provides S\n',
  "s.eff": "export service S { f(): Int }\ntype Int = int\n",
  "m.eff":
    'import { L } from "host:p"\nexport const g = (): Int => provide(L, () => 1)\ntype Int = int\n',
};

function hostProject() {
  const checked = checkProject(memoryHost(HOST_FILES), "", ["s.eff", "m.eff"]);
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered?.ok);
  return { ir: lowered.value, config: checked.value.analysis.project.config };
}

Deno.test("a host binding that is not a provider gives an unsupported emission error", () => {
  // A host interface file holds only providers: parse.ts:747 rejects a const
  // (syntax/012). The forged import gives the provider a function type.
  const { ir, config } = hostProject();
  assert(emitModule(ir, { config }).ok);
  const forged = structuredClone(ir);
  const host = forged.imports.find((i) => i.module.startsWith("host:"));
  assert(host !== undefined && host.values.length > 0);
  Object.assign(host.values[0], { type: FUNCTION });
  const error = emitError(forged, { config });
  assert(error.tag === "unsupported");
  assertEquals(error.message, "the host binding L is not a provider");
});

Deno.test("a host module that the project file lacks gives an unsupported emission error", () => {
  // project.ts:418 reports it as module/002 when the program is checked.
  const { ir } = hostProject();
  const error = emitError(ir, { config: { host: new Map() } });
  assert(error.tag === "unsupported");
  assertEquals(
    error.message,
    "the host module host:p is not in the project file",
  );
});

Deno.test("a host module path outside the project root gives an unsupported emission error", () => {
  // project.ts:184-198 drops such an entry and reports module/001.
  const { ir } = hostProject();
  const config: ProjectConfig = {
    host: new Map([["p", {
      interfacePath: "host/p.effi",
      modulePath: "/live.ts",
    }]]),
  };
  const error = emitError(ir, { config });
  assert(error.tag === "unsupported");
  assertEquals(error.message, "the host module path /live.ts is not valid");
});

Deno.test("a Schema of a function type gives an unsupported emission error", () => {
  // check.ts:774 and check_expr.ts:1737 require data-only Schema types
  // (type-mismatch/010). schemaDoc fails for the descriptor of a constant.
  const { ir } = lowerOk(
    "type Int = int\nconst s: Schema<Int> = schema()\n",
  );
  const valueForged = structuredClone(ir);
  const value = rootOf(valueForged, "s");
  assert(value.kind === "schema" && value.type.kind === "schema");
  assign(value, { type: { ...value.type, decoded: FUNCTION } });
  const fromValue = emitError(valueForged);
  assert(fromValue.tag === "unsupported");
  assertEquals(
    fromValue.message,
    "a deferred or function type has no schema",
  );
});

Deno.test("a recursive type with a function field gives an unsupported emission error", () => {
  // The encoded mirror of a recursive type declaration needs a schema for each
  // field (encodedTypeDoc). The checker rejects such a type unless it is data
  // only (check.ts:1436-1446, declaration/007).
  const { ir } = lowerOk(
    "type Int = int\ntype Tree = { score: Int, children: Tree[] }\n",
  );
  const forged = structuredClone(ir);
  const tree = declarationOf(forged, "Tree");
  assert(tree.kind === "type" && tree.definition.kind === "nominal");
  assert(tree.definition.base.kind === "record");
  Object.assign(tree.definition.base.fields[0], { type: FUNCTION });
  const error = emitError(forged);
  assert(error.tag === "unsupported");
  assertEquals(error.message, "a deferred or function type has no schema");
});

// ------------------------------------------------------------------ emission: the throw-to-Result conversion

Deno.test("emitModule converts an internal failure and rethrows a foreign error", () => {
  const { ir } = lowerOk(
    "type Int = int\nconst a: Int = 1\nconst b = (): Int => a\n",
  );
  // An unbound local is an internal invariant failure.
  const forged = structuredClone(ir);
  const body = rootOf(forged, "b");
  assign(body, { kind: "reference", target: "local:main#ghost" });
  const error = emitError(forged);
  assertEquals(error.tag, "internal");
  assertEquals(error.module, "main");
  assert(error.message.includes("local:main#ghost"), error.message);
  // A value that is not a ModuleIR makes the code throw a TypeError. The
  // conversion does not catch it.
  const broken = { ...ir, declarations: undefined } as unknown as ModuleIR;
  assertThrows(() => emitModule(broken, NO_CONFIG), TypeError);
});

Deno.test("emitModule keeps the span of an unsupported failure and omits an absent span", () => {
  // The two shapes of the conversion at emit/emit.ts:185-209. `fit` throws with
  // a span (tested above); an unknown host module throws without one.
  const { ir } = hostProject();
  const error = emitError(ir, { config: { host: new Map() } });
  assert(error.tag === "unsupported");
  assert(!("span" in error));
});

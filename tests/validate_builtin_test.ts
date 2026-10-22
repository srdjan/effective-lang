// Prelude payloads are untrusted. Identity validation and call classification
// intentionally read different fields, including when those fields disagree.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { FunctionType, ModuleIR, Type } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";

const SOURCE = `type Int = int
const probe = () => map([1], (n) => n + 1)
`;
const SOURCES = new Map([["m.eff", SOURCE]]);

function lower(source: string): ModuleIR {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": source }),
    "",
    ["m.eff"],
  );
  assert(checked.ok);
  assertEquals(checked.value.diagnostics, []);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered?.ok);
  assertEquals(validateModule(lowered.value, new Map([["m.eff", source]])), []);
  return lowered.value;
}

function forgedName(id: string, name: unknown): ModuleIR {
  const ir = lower(SOURCE);
  const old = ir.imports[0].values[0].id;
  const renamed = JSON.parse(
    JSON.stringify(ir),
    (_key, value) => value === old ? id : value,
  ) as ModuleIR;
  const probe = renamed.declarations.find((d) =>
    d.kind === "function" && d.name === "probe"
  );
  assert(probe?.kind === "function" && probe.body.kind === "call");
  const call = probe.body;
  const callback = call.arguments[1];
  assert(callback.kind === "closure" && callback.type.kind === "function");
  return {
    ...renamed,
    imports: renamed.imports.map((imp) => ({
      ...imp,
      values: imp.values.map((v) => ({ ...v, name: name as string })),
    })),
    declarations: renamed.declarations.map((d) =>
      d === probe
        ? {
          ...probe,
          body: {
            ...call,
            arguments: [call.arguments[0], {
              ...callback,
              type: { ...callback.type, execution: "effect" },
            }],
          },
        }
        : d
    ),
  };
}

Deno.test("malformed builtin ids retain callback rules from the recorded name", () => {
  const identity =
    "imports[0].values[0].id: a builtin identity has the form value:m#$builtin/<name>/<hash>, recorded value:m#bad";
  const mode =
    "declarations[1].body.arguments[1].type.execution: expected pure, recorded effect";
  const purity =
    "declarations[1].body.arguments[1]: a builtin callback is pure with empty failure and requirement sets";
  const fit =
    "declarations[1].body.arguments[1]: the argument has type (int) => int [effect], which does not fit the parameter (int) => int [pure]";
  for (const name of ["$builtin/map/abc", "$builtin/mystery/abc", "x//y"]) {
    const diagnostics = validateModule(
      forgedName("value:m#bad", name),
      SOURCES,
    );
    assertEquals(diagnostics.map((d) => [d.code, d.message]), [
      ["validation/001", identity],
      ["validation/004", mode],
      ["validation/004", purity],
    ], name);
  }
  assertEquals(
    validateModule(forgedName("value:m#bad", "map"), SOURCES).map((
      d,
    ) => [d.code, d.message]),
    [
      ["validation/001", identity],
      ["validation/002", fit],
      ["validation/004", mode],
    ],
  );
  assertEquals(
    validateModule(forgedName("value:m#bad", "$builtin/traverse/abc"), SOURCES)
      .map((d) => [d.code, d.message]),
    [
      ["validation/001", identity],
      [
        "validation/003",
        "declarations[1].body: traverse must invoke the callback with its declared failures and requirements",
      ],
      ["validation/002", fit],
      ["validation/004", mode],
    ],
  );
});

Deno.test("non-string builtin names report their shape error at the call", () => {
  for (const name of [12, {}, []]) {
    const diagnostics = validateModule(
      forgedName("value:m#bad", name),
      SOURCES,
    );
    const shape = diagnostics.filter((d) => d.code === "validation/008");
    assertEquals(shape.map((d) => d.message), [
      "declarations[1]: the IR has an unexpected shape: this.ctx.world.builtins.get(...)?.split is not a function",
    ]);
  }
});

Deno.test("builtin import payloads pin shape errors for every builtin name", () => {
  const int: Type = { kind: "primitive", name: "int" };
  const bool: Type = { kind: "primitive", name: "boolean" };
  const array: Type = { kind: "array", element: int };
  const quiet = { failures: [], requirements: [] };
  const unary: FunctionType = {
    kind: "function",
    parameters: [int],
    result: int,
    execution: "pure",
    effects: quiet,
  };
  const base: FunctionType = {
    ...unary,
    parameters: [array, unary],
    result: array,
  };
  const cases: readonly [string, string, Type, string, string][] = [
    [
      "map",
      "map([1], (n) => n + 1)",
      { ...base, parameters: [] },
      "validation/002",
      "the builtin map has an invalid parameter count 0",
    ],
    [
      "filter",
      "filter([1], (n) => n > 0)",
      { ...base, parameters: [array, { ...unary, result: int }] },
      "validation/002",
      "the builtin filter returns the array type with a boolean predicate",
    ],
    [
      "fold",
      "fold([1], 0, (sum, n) => sum + n)",
      {
        ...base,
        parameters: [array, int, {
          ...unary,
          parameters: [int, int],
          result: bool,
        }],
        result: int,
      },
      "validation/002",
      "the builtin fold does not keep one accumulator type",
    ],
    [
      "all",
      "all([defer(() => 1)], { concurrency: 2 })",
      { ...base, execution: "effect", parameters: [int] },
      "validation/002",
      "the builtin all takes a tuple, record, or array of Effects",
    ],
    [
      "traverse",
      "traverse([1], (n) => n + 1, { concurrency: 2 })",
      { ...base, execution: "effect" },
      "validation/003",
      "traverse invokes an effect callback and carries its failures and requirements",
    ],
    [
      "all",
      "all([defer(() => 1)], { concurrency: 2 })",
      {
        ...base,
        execution: "effect",
        parameters: [{
          kind: "array",
          element: { kind: "effect", result: int, effects: quiet },
        }, bool],
      },
      "validation/002",
      "the builtin all requires a concurrency options record",
    ],
    [
      "traverse",
      "traverse([1], (n) => n + 1, { concurrency: 2 })",
      {
        ...base,
        execution: "effect",
        parameters: [array, { ...unary, execution: "effect" }, bool],
      },
      "validation/002",
      "the builtin traverse requires a concurrency options record as its third parameter",
    ],
  ];
  for (const [name, expression, type, code, message] of cases) {
    const source = `const probe = () => ${expression}\n`;
    const ir = lower(source);
    const imp = ir.imports[0];
    assert(imp.values[0].id.includes(`/${name}/`));
    const forged = {
      ...ir,
      imports: [{ ...imp, values: [{ ...imp.values[0], type }] }],
    };
    const diagnostics = validateModule(forged, new Map([["m.eff", source]]));
    assert(
      diagnostics.some((d) =>
        d.code === code && d.message === `imports[0].values[0].type: ${message}`
      ),
      JSON.stringify(diagnostics),
    );
  }
});

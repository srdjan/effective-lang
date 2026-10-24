import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import type {
  CheckedProject,
  Expr,
  LowerError,
  ModuleIR,
  Result,
} from "../src/core/mod.ts";

function lowered(text: string) {
  const project = checkProject(
    memoryHost({ "effektive.json": "{}", "main.eff": text }),
    "",
    ["main.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const modules = lowerProject(project.value);
  const main = modules.get("main");
  assert(main?.ok, JSON.stringify(main));
  return { project: project.value, main: main.value };
}

function assertMutable(
  value: unknown,
): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
}

function validation(project: CheckedProject, module: ModuleIR) {
  const modules = new Map<string, Result<ModuleIR, LowerError>>([
    ["main", { ok: true, value: module }],
  ]);
  return validateProject(project.analysis.project, modules).get("main") ?? [];
}

function findExpression(
  expression: Expr,
  kind: Expr["kind"],
): Expr | undefined {
  if (expression.kind === kind) return expression;
  switch (expression.kind) {
    case "closure":
      return findExpression(expression.body, kind);
    case "block":
      for (const step of expression.steps) {
        const found = findExpression(step.value, kind);
        if (found !== undefined) return found;
      }
      return findExpression(expression.result, kind);
    case "call":
      return findExpression(expression.callee, kind) ??
        expression.arguments.map((item) => findExpression(item, kind)).find(
          (item) => item !== undefined,
        );
    case "defer":
    case "fork-scoped":
      return findExpression(expression.job, kind);
    case "run":
    case "scoped":
      return findExpression(expression.value, kind);
    case "provide":
      return findExpression(expression.provider, kind) ??
        findExpression(expression.job, kind);
    default:
      return undefined;
  }
}

Deno.test("validator rejects a pure function type with a nonempty row", () => {
  const base = lowered(`
type Int = int
error Stop = {}
export const apply = (callback: pure () => Int): Int => callback()
`);
  const module = structuredClone(base.main);
  const apply = module.declarations.find((declaration) =>
    declaration.kind === "function" && declaration.name === "apply"
  );
  assert(apply?.kind === "function");
  const callback = apply.type.parameters[0];
  assert(callback?.kind === "function");
  const effects: unknown = callback.effects;
  assertMutable(effects);
  effects.failures = ["error:main#Stop"];

  const diagnostics = validation(base.project, module);
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "validation/002" &&
      diagnostic.message.includes("pure function type")
    ),
    JSON.stringify(diagnostics),
  );
});

Deno.test("validator rejects empty-row run and provide nodes relabeled pure", () => {
  const base = lowered(`
type Int = int
service Clock { now(): Int }
const clock = layer(Clock, () => ({ now: () => 1 }))
export const ran = (): Int => run(defer(() => 1))
export const provided = (): Int => provide(clock, () => Clock.now())
`);
  for (
    const [name, kind] of [["ran", "run"], ["provided", "provide"]] as const
  ) {
    const module = structuredClone(base.main);
    const declaration = module.declarations.find((item) =>
      item.kind === "function" && item.name === name
    );
    assert(declaration?.kind === "function");
    const expression = findExpression(declaration.body, kind);
    assert(expression !== undefined, `${name} has no ${kind} expression`);
    const annotation: unknown = expression;
    assertMutable(annotation);
    annotation.execution = "pure";
    const diagnostics = validation(base.project, module);
    assert(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "validation/004" &&
        diagnostic.message.includes("expected effect, recorded pure")
      ),
      `${name}: ${JSON.stringify(diagnostics)}`,
    );
  }
});

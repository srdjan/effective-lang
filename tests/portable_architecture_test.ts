import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

type Files = Readonly<Record<string, string>>;

function check(files: Files, entries: readonly string[]) {
  const result = checkProject(memoryHost(files), "", entries);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function validated(files: Files, entries: readonly string[]) {
  const project = check(files, entries);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  return lowered;
}

function codes(files: Files, entries: readonly string[]): string[] {
  return check(files, entries).diagnostics.map((diagnostic) => diagnostic.code);
}

const CONFIG = { "effektive.json": "{}" };

Deno.test("nominal visibility blocks imports but updates keep the nominal type", () => {
  assertEquals(
    codes({
      ...CONFIG,
      "domain.eff": `
type Int = int
nominal PrivateScore = Int
export nominal Score = { value: Int }
export const initial: Score = Score({ value: 1 })
`,
      "main.eff": `
import { PrivateScore, Score, initial } from "./domain.eff"
export const changed: Score = { ...initial, value: 2 }
`,
    }, ["main.eff"]),
    ["unknown-name/002"],
  );

  const lowered = validated({
    ...CONFIG,
    "domain.eff": `
type Int = int
export nominal Score = { value: Int }
export const initial: Score = Score({ value: 1 })
`,
    "main.eff": `
import { Score, initial } from "./domain.eff"
export const changed: Score = { ...initial, value: 2 }
`,
  }, ["main.eff"]);
  const module = lowered.get("main");
  assert(module?.ok);
  const changed = module.value.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "changed"
  );
  assert(changed?.kind === "constant" && changed.value.kind === "update");
  assertEquals(changed.value.type, {
    kind: "named",
    id: "type:domain#Score",
  });
});

Deno.test("public nominal values permit arithmetic, widening, and schema decoding", () => {
  const lowered = validated({
    ...CONFIG,
    "domain.eff": `
export nominal Positive = int
export type Int = int
export const one: Positive = Positive(1)
export const two: Positive = Positive(2)
`,
    "main.eff": `
import { Positive, Int, one, two } from "./domain.eff"
const positiveSchema: Schema<Positive> = schema()
export const arithmetic: Positive = one - two
export const widened: Int = one
export const decoded = (input: unknown): Positive fails SchemaError =>
  schemaDecode(positiveSchema, input)
`,
  }, ["main.eff"]);
  const module = lowered.get("main");
  assert(module?.ok);
  const declarations = new Map(
    module.value.declarations.map((declaration) => [
      declaration.name,
      declaration,
    ]),
  );
  const arithmetic = declarations.get("arithmetic");
  assert(
    arithmetic?.kind === "constant" && arithmetic.value.kind === "binary",
  );
  assertEquals(arithmetic.value.type, {
    kind: "named",
    id: "type:domain#Positive",
  });
  const widened = declarations.get("widened");
  assert(widened?.kind === "constant");
  assertEquals(widened.value.type, {
    kind: "named",
    id: "type:domain#Positive",
  });
  const decoded = declarations.get("decoded");
  assert(decoded?.kind === "function" && decoded.body.kind === "schema-decode");
  assertEquals(decoded.body.type, {
    kind: "named",
    id: "type:domain#Positive",
  });
});

Deno.test("an exported alias hides its nominal constructor but does not seal record updates", () => {
  const domain = `
type Int = int
nominal Internal = { value: Int }
export type Proof = Internal
export const initial: Proof = Internal({ value: 1 })
`;
  validated({
    ...CONFIG,
    "domain.eff": domain,
    "main.eff": `
import { Proof, initial } from "./domain.eff"
export const changed: Proof = { ...initial, value: 0 }
`,
  }, ["main.eff"]);
  assertEquals(
    codes({
      ...CONFIG,
      "domain.eff": domain,
      "main.eff": `
import { Proof } from "./domain.eff"
export const forged: Proof = Proof({ value: 0 })
`,
    }, ["main.eff"]),
    ["type-mismatch/010"],
  );
});

Deno.test("running an empty-channel deferred value remains effectful", () => {
  const lowered = validated({
    ...CONFIG,
    "main.eff": `
type Int = int
export const runEmpty = (): Int => run(defer(() => 1))
`,
  }, ["main.eff"]);
  const module = lowered.get("main");
  assert(module?.ok);
  const runEmpty = module.value.declarations.find((declaration) =>
    declaration.kind === "function" && declaration.name === "runEmpty"
  );
  assert(runEmpty?.kind === "function");
  assertEquals(runEmpty.type.execution, "effect");
  assertEquals(runEmpty.type.effects, { failures: [], requirements: [] });
});

Deno.test("imported effects cannot run in an initializer", () => {
  assertEquals(
    codes({
      ...CONFIG,
      "jobs.eff": `
export type Int = int
export const runEmpty = (): Int => run(defer(() => 1))
`,
      "main.eff": `
import { Int, runEmpty } from "./jobs.eff"
export const initialized: Int = runEmpty()
`,
    }, ["main.eff"]),
    ["execution-mode/002"],
  );
});

Deno.test("fully provided effects keep effect mode after discharging requirements", () => {
  const lowered = validated({
    ...CONFIG,
    "main.eff": `
type Int = int
service Clock { now(): Int }
const supplied = layer(Clock, () => ({ now: () => 1 }))
export const closed = (): Int => provide(supplied, () => Clock.now())
`,
  }, ["main.eff"]);
  const module = lowered.get("main");
  assert(module?.ok);
  const closed = module.value.declarations.find((declaration) =>
    declaration.kind === "function" && declaration.name === "closed"
  );
  assert(closed?.kind === "function");
  assertEquals(closed.type.execution, "effect");
  assertEquals(closed.type.effects, { failures: [], requirements: [] });
});

Deno.test("unmarked function parameters retain effect execution", () => {
  assertEquals(
    codes({
      ...CONFIG,
      "main.eff": `
type Int = int
export const apply = (values: Int[], callback: (value: Int) => Int): Int[] =>
  map(values, callback)
`,
    }, ["main.eff"]),
    ["execution-mode/001"],
  );
});

Deno.test("two source layers select implementations of one service identity", () => {
  validated({
    ...CONFIG,
    "clock.eff": `
export type Int = int
export service Clock { now(): Int }
`,
    "fixed.eff": `
import { Clock } from "./clock.eff"
export const FixedClock: Layer<Clock> = layer(Clock, () => ({ now: () => 1 }))
`,
    "moving.eff": `
import { Clock } from "./clock.eff"
export const MovingClock: Layer<Clock> = layer(Clock, () => ({ now: () => 2 }))
`,
    "main.eff": `
import { Int, Clock } from "./clock.eff"
import { FixedClock } from "./fixed.eff"
import { MovingClock } from "./moving.eff"
export const fixed = (): Int => provide(FixedClock, () => Clock.now())
export const moving = (): Int => provide(MovingClock, () => Clock.now())
`,
  }, ["main.eff"]);
});

const HOST_CONFIG = JSON.stringify({
  host: { clock: { interface: "./clock.effi", module: "./clock.ts" } },
});
const HOST_IMPORT_FILES = {
  "clock.effi": `
export type Int = int
export service Clock { now(): Int }
export provider ClockLive provides Clock
`,
  "domain.eff": `
import { Int, Clock, ClockLive } from "host:clock"
export const current = (): Int => provide(ClockLive, () => Clock.now())
`,
};

Deno.test("host registration enables an otherwise unrestricted domain import", () => {
  validated({
    "effektive.json": HOST_CONFIG,
    ...HOST_IMPORT_FILES,
  }, ["domain.eff"]);
  assertEquals(
    codes({
      ...CONFIG,
      ...HOST_IMPORT_FILES,
    }, ["domain.eff"]),
    ["module/002"],
  );
});

Deno.test("module cycles are separate from dependency direction", () => {
  assertEquals(
    codes({
      "effektive.json": HOST_CONFIG,
      "contracts.eff": `
import { ClockLive } from "host:clock"
export type Int = int
export service Clock { now(): Int }
`,
      "clock.effi": `
import { Clock } from "./contracts.eff"
export provider ClockLive provides Clock
`,
    }, ["contracts.eff"]),
    ["module/003"],
  );
});

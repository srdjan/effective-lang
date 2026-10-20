// Tests for the stage effect sets of `x |> stage` in src/core/lower.ts. The
// stage sets are the sets of the stage arguments plus the stage invocation.
// They exclude the effects of the left value, which the lowering evaluates in
// its own binding. A stage with an effect-free left value does not use this
// code, so each left value here calls a service method. Each test runs through
// the public entries `checkProject`, `lowerProject`, and `validateModule`.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import type { Effects, Expr } from "../src/core/ir.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import { validateModule } from "../src/core/validate/index.ts";

const CFG_LIMIT: Effects = { failures: [], requirements: ["cap:m#Cfg.limit"] };

/** Lowers a program that has the function `probe` with a one-stage pipeline. */
function lowerProbe(text: string) {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.message), []);
  const lowered = lowerProject(checked.value).get("m");
  assert(lowered?.ok === true, JSON.stringify(lowered));
  const ir = lowered.value;
  assertEquals(validateModule(ir, new Map([["m.eff", text]])), []);
  const declaration = ir.declarations.find((d) =>
    d.kind === "function" && d.name === "probe"
  );
  assert(declaration?.kind === "function");
  const body: Expr = declaration.body;
  assert(body.kind === "block");
  assertEquals(body.steps.length, 1);
  const [step] = body.steps;
  assert(step.kind === "bind");
  // The left value runs in its own binding and carries the service call.
  assertEquals(step.value.effects, CFG_LIMIT);
  assertEquals(body.effects.requirements.includes("cap:m#Cfg.limit"), true);
  return { body, stage: body.result };
}

Deno.test("a retrySchedule stage keeps only its own sets", () => {
  const { stage } = lowerProbe(`type Int = int
error Stop = {}
service Cfg { limit(): Int }
const makeStep = () => { Cfg.limit(); ((e: Stop, attempt: Int): Option<Int> => None) }
const probe = () => makeStep() |> retrySchedule
`);
  assertEquals(stage.kind, "retry-schedule");
  assertEquals(stage.execution, "pure");
  assertEquals(stage.effects, { failures: [], requirements: [] });
});

Deno.test("a retry stage with a schedule adds the job invocation and excludes the left value", () => {
  const { body, stage } = lowerProbe(`type Int = int
error Stop = {}
service Cfg { limit(): Int }
service Jobs { next(): Int fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((e: Stop, attempt: Int): Option<Int> => None)
const makeJob = () => { Cfg.limit(); (() => Jobs.next()) }
const probe = () => makeJob() |> retry({ schedule: policy })
`);
  assertEquals(stage.kind, "retry-with-schedule");
  assertEquals(stage.execution, "effect");
  assertEquals(stage.effects, {
    failures: ["error:m#Stop"],
    requirements: ["cap:m#Jobs.next"],
  });
  assertEquals(body.effects, {
    failures: ["error:m#Stop"],
    requirements: ["cap:m#Cfg.limit", "cap:m#Jobs.next"],
  });
});

Deno.test("a defer stage keeps only its own sets", () => {
  const { stage } = lowerProbe(`type Int = int
service Cfg { limit(): Int }
const makeJob = () => { Cfg.limit(); (() => 1) }
const probe = () => makeJob() |> defer
`);
  assertEquals(stage.kind, "defer");
  assertEquals(stage.execution, "pure");
  assertEquals(stage.effects, { failures: [], requirements: [] });
});

Deno.test("a run stage adds the invocation of the Effect value", () => {
  const { stage } = lowerProbe(`type Int = int
error Stop = {}
service Cfg { limit(): Int }
service Jobs { next(): Int fails Stop }
const makeEffect = () => { Cfg.limit(); defer(() => Jobs.next()) }
const probe = () => makeEffect() |> run
`);
  assertEquals(stage.kind, "run");
  assertEquals(stage.execution, "effect");
  assertEquals(stage.effects, {
    failures: ["error:m#Stop"],
    requirements: ["cap:m#Jobs.next"],
  });
});

Deno.test("a provide stage adds the provider acquisition and removes the provided methods", () => {
  const { stage } = lowerProbe(`type Int = int
error Stop = {}
service Cfg { limit(): Int }
service Src { next(): Int fails Stop }
service First { one(): Int }
const makeLayer = (): Layer<First, Stop, Src.next> uses Cfg.limit => { Cfg.limit(); layer(First, () => { const v = Src.next(); ({ one: () => v }) }) }
const probe = () => makeLayer() |> provide(() => First.one())
`);
  assertEquals(stage.kind, "provide");
  assertEquals(stage.execution, "effect");
  // First.one is provided by the layer, so only the acquisition sets remain.
  assertEquals(stage.effects, {
    failures: ["error:m#Stop"],
    requirements: ["cap:m#Src.next"],
  });
});

const CODEC_PRELUDE = `type Int = int
const shift: Codec<Int, Int> = codec((n: Int): Int => n + 1, (n: Int): Int => n - 1)
`;

Deno.test("codec, decode, encode, and schema builtins reject a pipeline stage, so the lowering arm for them is dead", () => {
  const programs = [
    {
      builtin: "codec",
      text:
        `type Int = int\nconst probe = (n: Int) => ((n: Int): Int => n + 1) |> codec((n: Int): Int => n - 1)\n`,
    },
    {
      builtin: "decode",
      text:
        `${CODEC_PRELUDE}const probe = (input: unknown) => shift |> decode(input)\n`,
    },
    {
      builtin: "encode",
      text: `${CODEC_PRELUDE}const probe = (n: Int) => shift |> encode(n)\n`,
    },
    {
      builtin: "schemaArray",
      text:
        `type Int = int\nconst item: Schema<Int> = schema()\nconst probe = () => item |> schemaArray\n`,
    },
  ];
  for (const { builtin, text } of programs) {
    const checked = checkProject(
      memoryHost({ "effective.json": "{}", "m.eff": text }),
      "",
      ["m.eff"],
    );
    assert(checked.ok, JSON.stringify(checked));
    assertEquals(
      checked.value.diagnostics.map((d) => `${d.code} ${d.message}`),
      [`type-mismatch/010 \`${builtin}\` requires direct call syntax`],
    );
    // The lowering refuses a module with a diagnostic, so the arm never runs.
    const lowered = lowerProject(checked.value).get("m");
    assert(lowered?.ok === false);
    assertEquals(lowered.error.tag, "diagnostics");
  }
});

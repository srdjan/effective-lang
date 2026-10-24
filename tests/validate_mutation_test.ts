// Mutation tests for the independent IR validator. Each case lowers an
// accepted source, checks that the validator reports nothing, changes one fact
// of a copy of the IR, and requires the exact validation code, the IR path of
// the operation, and a fragment of the rule message. A mutation is coherent: it
// replaces a whole argument expression, or it changes a closure and its
// function type together, so the validator reaches the operation rule and not
// only the annotation check of a child.
//
// Cases that other tests already cover are not repeated here:
//   scheduleFromStep recorded output differs from the decision callback
//     -> validate_test.ts "Schedule validation rederives state, deferred
//        channels, and aggregation input" (custom value.type.output)
//   a null member in Schema data where the rule forbids it
//     -> schema_validator_forged_test.ts "validator keeps null data distinct
//        from unit and numeric annotations"
//   an encodingStrategy literal outside the accepted set
//     -> schema_validator_forged_test.ts "validator rejects malformed default
//        strategies and erased static encoder services"
//   mapGroups, aggregateWithinStream, and Schedule composition with a whole
//   channel set emptied -> validate_test.ts "mapGroups validation recomputes
//        bounds, binding identity, key types, and channels", "Schedule
//        validation rederives state, deferred channels, and aggregation input",
//        and "Schedule composition validation rederives input, output, and
//        channels". The cases below remove one member of a set of two.

import { assert, assertEquals } from "@std/assert";
import type { Diagnostic } from "../src/core/diagnostics.ts";
import type { ModuleIR } from "../src/core/ir.ts";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

// ------------------------------------------------------------------ helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}

function child(parent: unknown, key: string | number): unknown {
  if (typeof key === "number") {
    assert(Array.isArray(parent), `not an array at [${key}]`);
    return parent[key];
  }
  assert(isRecord(parent), `not an object at ${key}`);
  return parent[key];
}

function at(root: unknown, path: string): unknown {
  let current = root;
  for (const key of segments(path)) current = child(current, key);
  return current;
}

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  assert(last !== undefined, "empty path");
  const parent = parts.reduce(child, root);
  if (typeof last === "number") {
    assert(Array.isArray(parent), `not an array before [${last}]`);
    parent[last] = value;
  } else {
    assert(isRecord(parent), `not an object before ${last}`);
    parent[last] = value;
  }
}

const NONE = { failures: [], requirements: [] };
const INT = { kind: "primitive", name: "int" };
const STRING = { kind: "primitive", name: "string" };

/** A valid literal expression of the wrong type, at the span of the node it replaces. */
function literalAt(old: unknown, value: string | number | boolean): unknown {
  const type = typeof value === "string"
    ? STRING
    : typeof value === "number"
    ? INT
    : { kind: "primitive", name: "boolean" };
  return {
    kind: "literal",
    value,
    type,
    execution: "pure",
    effects: NONE,
    span: child(old, "span"),
  };
}

interface Lowered {
  readonly ir: ModuleIR;
  readonly sources: ReadonlyMap<string, string>;
}

function lowerText(text: string): Lowered {
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const result = lowerProject(checked.value).get("m");
  assert(result?.ok === true, JSON.stringify(result));
  return { ir: result.value, sources: new Map([["m.eff", text]]) };
}

function declarationIndex(ir: ModuleIR, name: string): number {
  const index = ir.declarations.findIndex((d) => d.name === name);
  assert(index >= 0, `no declaration named ${name}`);
  return index;
}

/** One expected diagnostic. The path is relative to the declaration ("" is the declaration). */
interface Expected {
  readonly code: string;
  readonly path: string;
  readonly fragment: string;
}

interface Mutation {
  readonly label: string;
  readonly declaration: string;
  /** Each edit sets the value at a path below the declaration. */
  readonly edits: readonly (readonly [
    path: string,
    value: (declaration: unknown) => unknown,
  ])[];
  readonly expected: readonly Expected[];
}

function show(diagnostics: readonly Diagnostic[]): string {
  return JSON.stringify(diagnostics.map((d) => [d.code, d.message]), null, 1);
}

function runMutations(
  lowered: Lowered,
  mutations: readonly Mutation[],
): void {
  assertEquals(
    validateModule(lowered.ir, lowered.sources),
    [],
    "the unchanged IR validates",
  );
  for (const mutation of mutations) {
    const ir = structuredClone(lowered.ir);
    const index = declarationIndex(ir, mutation.declaration);
    const declaration = ir.declarations[index];
    for (const [path, value] of mutation.edits) {
      setAt(declaration, path, value(declaration));
    }
    const found = validateModule(ir, lowered.sources);
    for (const expected of mutation.expected) {
      const prefix = `declarations[${index}]${
        expected.path === ""
          ? ""
          : expected.path.startsWith("[")
          ? expected.path
          : `.${expected.path}`
      }:`;
      assert(
        found.some((d) =>
          d.code === expected.code && d.message.startsWith(`${prefix} `) &&
          d.message.includes(expected.fragment)
        ),
        `${mutation.label}: expected ${expected.code} at ${prefix} with ${
          JSON.stringify(expected.fragment)
        }, got ${show(found)}`,
      );
    }
  }
}

// ----------------------------------------------------------------- sources

const SCHEDULES = `
type Int = int
type Text = string
type Millis = number
error Stop = {}
error LeftStop = {}
error RightStop = {}
service Policy {
  choose(input: Option<Int[]>, attempt: Int): Int fails Stop
  label(output: Int): Int fails Stop
}
service LeftPolicy { next(): Int fails LeftStop }
service RightPolicy { next(): Int fails RightStop }

const simple: Schedule<Int> = scheduleRecurs(3)
const timer: Schedule<Int, unknown> = scheduleSpaced(1000)

const custom: Schedule<Int, Option<Int[]>, Stop, Policy.choose> =
  scheduleFromStep(
    (): Int fails Stop uses Policy.choose => Policy.choose(None, 0),
    (state: Int, meta: ScheduleInput<Option<Int[]>>): ScheduleDecision<Int, Int> fails Stop uses Policy.choose =>
      if (meta.attempt > 2) {
        { kind: "Done", output: state }
      } else {
        {
          kind: "Continue",
          state: state + 1,
          output: Policy.choose(meta.input, meta.attempt),
          delayMillis: 0
        }
      }
  )

const mapped: Schedule<Int, Option<Int[]>, Stop, Policy.choose | Policy.label> =
  scheduleMap(custom, (meta: ScheduleMetadata<Int, Option<Int[]>>): Int fails Stop uses Policy.label =>
    Policy.label(meta.output))

const left: Schedule<Int, Option<Int[]>, LeftStop, LeftPolicy.next> =
  scheduleFromStep(
    (): Int => 0,
    (state: Int, meta: ScheduleInput<Option<Int[]>>): ScheduleDecision<Int, Int> fails LeftStop uses LeftPolicy.next =>
      ({ kind: "Continue", state: state + 1, output: LeftPolicy.next(), delayMillis: 1 })
  )

const right: Schedule<Text, unknown, RightStop, RightPolicy.next> =
  scheduleFromStep(
    (): Int => 0,
    (state: Int, meta: ScheduleInput<unknown>): ScheduleDecision<Int, Text> fails RightStop uses RightPolicy.next =>
      if (state < 1) {
        { kind: "Continue", state: state + 1, output: "right", delayMillis: RightPolicy.next() }
      } else {
        { kind: "Done", output: "done" }
      }
  )

const slowest: Schedule<Millis, Option<Int[]>, LeftStop | RightStop, LeftPolicy.next | RightPolicy.next> =
  scheduleMax(left, right)
const fastest: Schedule<Millis, Option<Int[]>, LeftStop | RightStop, LeftPolicy.next | RightPolicy.next> =
  scheduleMin(left, right)
const sequential: Schedule<Int | Text, Option<Int[]>, LeftStop | RightStop, LeftPolicy.next | RightPolicy.next> =
  scheduleConcat(left, right)
const batches = (source: Stream<Int>): Stream<Int[], LeftStop | RightStop, LeftPolicy.next | RightPolicy.next> =>
  aggregateWithinStream(source, takeSink(2), slowest)
`;

// ---------------------------------------------------------------- schedules

Deno.test("Schedule constructor validation rejects a wrong argument, callback shape, state, and recorded output", () => {
  const lowered = lowerText(SCHEDULES);
  const callbackShape = "scheduleFromStep needs inline state and decision";
  const typing =
    "scheduleFromStep needs ScheduleInput and ScheduleDecision<State, Output>";
  runMutations(lowered, [
    {
      label: "scheduleRecurs with a string count",
      declaration: "simple",
      edits: [["value.times", (d) => literalAt(at(d, "value.times"), "3")]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "invalid schedule argument",
      }],
    },
    {
      label: "scheduleSpaced with a string delay",
      declaration: "timer",
      edits: [[
        "value.delayMillis",
        (d) => literalAt(at(d, "value.delayMillis"), "1000"),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "invalid schedule argument",
      }],
    },
    {
      label: "scheduleRecurs output changed from int",
      declaration: "simple",
      edits: [["value.type.output", () => STRING]],
      expected: [{
        code: "validation/002",
        path: "value.type",
        fragment: "expected Schedule<int, unknown,",
      }],
    },
    {
      label: "scheduleMap recorded output differs from the callback result",
      declaration: "mapped",
      edits: [["value.type.output", () => STRING]],
      expected: [{
        code: "validation/002",
        path: "value.type",
        fragment: "recorded Schedule<string,",
      }],
    },
    {
      label: "scheduleFromStep factory takes one parameter",
      declaration: "custom",
      edits: [
        [
          "value.initial.parameters",
          (d) => [{
            id: "local:m#custom/extra",
            name: "extra",
            type: INT,
          }, ...asArray(at(d, "value.initial.parameters"))],
        ],
        ["value.initial.type.parameters", () => [INT]],
      ],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: callbackShape,
      }],
    },
    {
      label: "scheduleFromStep decision callback takes one parameter",
      declaration: "custom",
      edits: [
        [
          "value.decide.parameters",
          (d) => asArray(at(d, "value.decide.parameters")).slice(0, 1),
        ],
        [
          "value.decide.type.parameters",
          (d) => asArray(at(d, "value.decide.type.parameters")).slice(0, 1),
        ],
      ],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: callbackShape,
      }],
    },
    {
      label: "scheduleFromStep factory state differs from the decision state",
      declaration: "custom",
      edits: [
        ["value.decide.parameters[0].type", () => STRING],
        [
          "value.decide.type.parameters",
          (d) => [
            STRING,
            ...asArray(at(d, "value.decide.type.parameters")).slice(1),
          ],
        ],
      ],
      expected: [{ code: "validation/002", path: "value", fragment: typing }],
    },
  ]);
});

function asArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "not an array");
  return value;
}

// ---------------------------------------------------------- channel erasure

Deno.test("channel erasure: a Schedule composition type that loses one failure or requirement is rejected", () => {
  const lowered = lowerText(SCHEDULES);
  const cases: Mutation[] = [];
  for (const name of ["slowest", "fastest", "sequential"]) {
    cases.push(
      {
        label: `${name} loses RightStop`,
        declaration: name,
        edits: [[
          "value.type.effects.failures",
          () => ["error:m#LeftStop"],
        ]],
        expected: [{
          code: "validation/002",
          path: "value.type",
          fragment: "expected Schedule<",
        }],
      },
      {
        label: `${name} loses RightPolicy.next`,
        declaration: name,
        edits: [[
          "value.type.effects.requirements",
          () => ["cap:m#LeftPolicy.next"],
        ]],
        expected: [{
          code: "validation/002",
          path: "value.type",
          fragment: "expected Schedule<",
        }],
      },
    );
  }
  cases.push({
    label: "scheduleMap loses Policy.label",
    declaration: "mapped",
    edits: [[
      "value.type.effects.requirements",
      () => ["cap:m#Policy.choose"],
    ]],
    expected: [{
      code: "validation/002",
      path: "value.type",
      fragment: "expected Schedule<",
    }],
  });
  runMutations(lowered, cases);
});

Deno.test("channel erasure: aggregateWithinStream loses one failure or requirement and keeps the Schedule evidence", () => {
  const lowered = lowerText(SCHEDULES);
  runMutations(lowered, [
    {
      label: "aggregateWithinStream loses RightStop",
      declaration: "batches",
      edits: [[
        "body.type.effects.failures",
        () => ["error:m#LeftStop"],
      ]],
      expected: [{
        code: "validation/002",
        path: "body.type",
        fragment: "expected Stream<",
      }],
    },
    {
      label: "aggregateWithinStream loses LeftPolicy.next",
      declaration: "batches",
      edits: [[
        "body.type.effects.requirements",
        () => ["cap:m#RightPolicy.next"],
      ]],
      expected: [{
        code: "validation/002",
        path: "body.type",
        fragment: "expected Stream<",
      }],
    },
  ]);
});

Deno.test("channel erasure: mapGroups loses one failure or requirement and keeps the callback evidence", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
error Other = {}
service Work { run(): void fails Other; value(key: Int): Int fails Stop }
const used = (source: Stream<Int, Stop, Work.value>): Stream<Int, Stop | Other, Work.value | Work.run> =>
 mapGroups(source, (n) => n, (key, group) => { Work.run(); headStream(group); Work.value(key) }, { bufferSize: 1 })
`);
  runMutations(lowered, [
    {
      label: "mapGroups loses Other",
      declaration: "used",
      edits: [["body.type.effects.failures", () => ["error:m#Stop"]]],
      expected: [{
        code: "validation/002",
        path: "body.type",
        fragment: "expected Stream<",
      }],
    },
    {
      label: "mapGroups loses Work.run",
      declaration: "used",
      edits: [[
        "body.type.effects.requirements",
        () => ["cap:m#Work.value"],
      ]],
      expected: [{
        code: "validation/002",
        path: "body.type",
        fragment: "expected Stream<",
      }],
    },
  ]);
});

// ------------------------------------------------------------ add finalizer

Deno.test("addScopeFinalizer validation recomputes its requirements from the finalizer job", () => {
  const lowered = lowerText(`
service Audit { release(): void }
const register = (owner: CloseableScope): void uses Audit.release =>
  addScopeFinalizer(owner, defer(() => Audit.release()))
`);
  // The call effects and the function contract lose the release requirement
  // together. The job type and the callback evidence stay. Only the
  // recomputation from the job finds the loss: it reports the call effects,
  // and it reports the body requirement that the function contract omits.
  runMutations(lowered, [{
    label: "finalizer requirement removed from the call and the contract",
    declaration: "register",
    edits: [
      ["body.effects.requirements", () => []],
      ["type.effects.requirements", () => []],
    ],
    expected: [
      {
        code: "validation/003",
        path: "body.effects.requirements",
        fragment: "expected [cap:m#Audit.release], recorded []",
      },
      {
        code: "validation/003",
        path: "body",
        fragment:
          "the body requires [cap:m#Audit.release], which the declared requirements [] do not list",
      },
    ],
  }]);
});

// ------------------------------------------------------------------- Schema

Deno.test("Schema issue operations reject a wrong argument expression", () => {
  const lowered = lowerText(`
type Int = int
const integer: Schema<Int> = schema()
const invalid = schemaInvalid("x")
const keyed = schemaAt("k", schemaInvalid("x"))
const both = schemaBoth(integer, schemaInvalid("a"), schemaInvalid("b"))
`);
  runMutations(lowered, [
    {
      label: "schemaInvalid with an int message",
      declaration: "invalid",
      edits: [[
        "value.arguments[0]",
        (d) => literalAt(at(d, "value.arguments[0]"), 1),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaInvalid needs a string message",
      }],
    },
    {
      label: "schemaInvalid with a second argument",
      declaration: "invalid",
      edits: [[
        "value.arguments",
        (d) => [
          ...asArray(at(d, "value.arguments")),
          literalAt(at(d, "value.arguments[0]"), "extra"),
        ],
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaInvalid needs a string message",
      }],
    },
    {
      label: "schemaAt with a boolean key",
      declaration: "keyed",
      edits: [[
        "value.arguments[0]",
        (d) => literalAt(at(d, "value.arguments[0]"), true),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaAt needs a key and a SchemaIssue",
      }],
    },
    {
      label: "schemaAt with a string in place of the issue",
      declaration: "keyed",
      edits: [[
        "value.arguments[1]",
        (d) => literalAt(at(d, "value.arguments[1]"), "issue"),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaAt needs a key and a SchemaIssue",
      }],
    },
    {
      label: "schemaBoth with a string in place of the Schema",
      declaration: "both",
      edits: [[
        "value.arguments[0]",
        (d) => literalAt(at(d, "value.arguments[0]"), "integer"),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaBoth needs a Schema and two issues",
      }],
    },
    {
      label: "schemaBoth with a string in place of the second issue",
      declaration: "both",
      edits: [[
        "value.arguments[2]",
        (d) => literalAt(at(d, "value.arguments[2]"), "issue"),
      ]],
      expected: [{
        code: "validation/002",
        path: "value",
        fragment: "schemaBoth needs a Schema and two issues",
      }],
    },
  ]);
});

// ----------------------------------------------------------- null equality

Deno.test("equality of two nullable operands without a null operand is rejected", () => {
  const lowered = lowerText(`
type Int = int
type Text = string
type Bool = boolean
type Nullable = Text | null
type Count = Int | null
const same = (x: Nullable, y: Nullable): Bool => x === null
const different = (x: Nullable, y: Count): Bool => x !== null
`);
  const nullable = { kind: "named", id: "type:m#Nullable" };
  const count = { kind: "named", id: "type:m#Count" };
  const reference =
    (name: string, id: string, type: unknown) => (d: unknown) => ({
      kind: "reference",
      target: `local:m#${name}/${id}`,
      type,
      execution: "pure",
      effects: NONE,
      span: child(at(d, "body.right"), "span"),
    });
  const rule = "does not accept operands of type";
  runMutations(lowered, [
    {
      label: "x === y with equal nullable unions",
      declaration: "same",
      edits: [["body.right", reference("same", "y", nullable)]],
      expected: [{ code: "validation/002", path: "body", fragment: rule }],
    },
    {
      label: "x !== y with different nullable unions",
      declaration: "different",
      edits: [["body.right", reference("different", "y", count)]],
      expected: [{ code: "validation/002", path: "body", fragment: rule }],
    },
  ]);
});

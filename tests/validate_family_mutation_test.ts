// Family mutations for the independent validator. Each test lowers a valid
// program with `lowerProject`, changes one node of the IR in memory, and
// requires the validator to report a specific code at the IR path of that
// node, with a fragment of the message. The families are the Stream operators
// and the Schema constructors. Their guard branches had no test before.
//
// The committed fixtures under fixtures/validate stay untouched: the mutations
// happen here, in memory. A mutation may also make a parent node disagree with
// its child, so the tests require the expected diagnostic and ignore extra ones.

import { assert, assertEquals } from "@std/assert";
import { checkProject, lowerProject, memoryHost } from "../src/core/mod.ts";
import type { ModuleIR } from "../src/core/ir.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { assertValidation } from "./schema_diagnostics.ts";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ programs

const STREAMS = `type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
service Inner { next(n: Int): Option<[Int, Int]> fails Stop }
service Recovery { next(n: Int): Option<[Int, Int]> fails Stop }
service Accum { add(total: Int, n: Int): Int fails Stop }
service Gate { allow(n: Int): Bool fails Stop }
service Consumer { accept(n: Int): void fails Stop }

const source = unfold(0, (n) => Source.next(n))
const other = unfold(0, (n) => Source.next(n))
const policy: RetrySchedule<Stop> = retrySchedule((_: Stop, attempt: Int): Option<Int> => None)

const pull = (n: Int): Option<[Int, Int]> fails Stop uses Source.next => Source.next(n)
const isSmall = (n: Int): Bool => n < 3
const plusOne = (n: Int): Int => n + 1
const addUp = (total: Int, n: Int): Int => total + n
const addEffect = (total: Int, n: Int): Int fails Stop uses Accum.add => Accum.add(total, n)
const bump = (n: Int): Int fails Stop uses Accum.add => Accum.add(n, 1)
const accumulate = (total: Int, n: Int): [Int, Bool[]] => [total + n, [n < 3]]
const expand = (n: Int): Stream<Int, Stop, Inner.next> => unfold(n, (m) => Inner.next(m))
const recover = (_: Stop): Stream<Int, Stop, Recovery.next> => unfold(9, (n) => Recovery.next(n))
const allowed = (n: Int): Bool fails Stop uses Gate.allow => Gate.allow(n)
const accept = (value: Int): void fails Stop uses Consumer.accept => Consumer.accept(value)

const mapped: Stream<Int, Stop, Source.next> = mapStream(source, (n) => n + 1)
const mappedEffect: Stream<Int, Stop, Source.next | Accum.add> = mapEffect(source, (n) => Accum.add(n, 1))
const scanned: Stream<Int, Stop, Source.next> = scanStream(source, 0, (total, n) => total + n)
const accumulated: Stream<Bool, Stop, Source.next> =
  mapAccumStream(source, 0, (total, n): [Int, Bool[]] => [total + n, [n < 3]])
const flatMapped: Stream<Int, Stop, Source.next | Inner.next> =
  flatMapStreams(source, (n) => unfold(n, (m) => Inner.next(m)))
const switched: Stream<Int, Stop, Source.next | Inner.next> =
  switchMapStreams(source, (n) => unfold(n, (m) => Inner.next(m)))
const recovered: Stream<Int, Stop, Source.next | Recovery.next> =
  catchStream(source, (_) => unfold(9, (n) => Recovery.next(n)))
const dropped: Stream<Int, Stop, Source.next> = dropWhileStream(source, (n) => n < 3)
const filtered: Stream<Int, Stop, Source.next> = filterStream(source, (n) => n < 3)
const takenWhile: Stream<Int, Stop, Source.next> = takeWhileStream(source, (n) => n < 3)
const takenUntil: Stream<Int, Stop, Source.next> = takeUntilStream(source, (n) => n === 3)
const filteredEffect: Stream<Int, Stop, Source.next | Gate.allow> =
  filterEffectStream(source, (n) => Gate.allow(n))
const takenWhileEffect: Stream<Int, Stop, Source.next | Gate.allow> =
  takeWhileEffectStream(source, (n) => Gate.allow(n))
const takenUntilEffect: Stream<Int, Stop, Source.next | Gate.allow> =
  takeUntilEffectStream(source, (n) => Gate.allow(n))
const droppedEffect: Stream<Int, Stop, Source.next | Gate.allow> =
  dropWhileEffectStream(source, (n) => Gate.allow(n))
const taken = (count: Int): Stream<Int, Stop, Source.next> => takeStream(source, count)
const skipped = (count: Int): Stream<Int, Stop, Source.next> => dropStream(source, count)
const retried = retryStream(source, policy)
const debounced = debounceStream(source, 0)
const throttled = throttleStream(source, { units: 1, durationMs: 100, strategy: "enforce" })
const buffered = bufferStream(source, { capacity: 2 })
const merged = mergeStreams(source, other)
const zipped = zipStreams(source, other)
const concatenated = concatStreams(source, other)
const consumer = sinkForEach((value: Int) => Consumer.accept(value))

type Pairs = Sink<Int, Int[], never, never, Int>
const pairs: Pairs = takeSink(2)
const batches: Stream<Int[], Stop, Source.next> = transduceStream(source, pairs)
const aggregated: Stream<Int[], Stop, Source.next> = aggregateStream(source, pairs)

const folded = (): Int fails Stop uses Source.next =>
  foldStream(source, 0, (total, n) => total + n)
const foldedEffect = (): Int fails Stop uses Source.next | Accum.add =>
  foldEffectStream(source, 0, (total, n) => Accum.add(total, n))
const collected = (): Int[] fails Stop uses Source.next => collectStream(source)
const headed = (): Option<Int> fails Stop uses Source.next => headStream(source)
const lasted = (): Option<Int> fails Stop uses Source.next => lastStream(source)
const drained = (): void fails Stop uses Source.next => drainStream(source)
const ran = (): void fails Stop uses Source.next | Consumer.accept => runStream(source, consumer)
`;

const SCHEMAS = `type Text = string
type Int = int
type Nil = null
type Nullable = Text | Nil
type Short = { name: Text }
type Long = { name: Text, score: Int }
type Shape = Short | Long
type Tree = { score: Int, children: Tree[] }
type TreeInput = { score?: Int, children?: TreeInput[] }
error Other = {}

const text: Schema<Text> = schema()
const integer: Schema<Int> = schema()
const short: Schema<Short> = schema()
const long: Schema<Long> = schema()
const exact: SchemaOptional<Text> = schemaOptionalKey(text)
const exactInt: SchemaOptional<Int> = schemaOptionalKey(integer)

const message: SchemaIssue = schemaInvalid("blocked")
const located: SchemaIssue = schemaAt("name", schemaInvalid("blocked"))
const both: SchemaIssue = schemaBoth(text, schemaInvalid("left"), schemaInvalid("right"))

const listed: Schema<Int[]> = schemaArray(integer)
const nulls: SchemaOptional<Text, Nullable> = schemaNullToMissingKey(text)
const optionFrom: SchemaEncodedOptional<Option<Text>, Text> = schemaOptionFromOptionalKey(text)
const defaulted: SchemaEncodedOptional<Text> = schemaDefaultKey(text, (): Text => "x")
const defaultedNull: SchemaEncodedOptional<Text, Nullable> = schemaDefaultNullKey(text, (): Text => "x")
const defaultedEncoded: SchemaEncodedOptional<Text> = schemaDefaultEncodedKey(text, (): Text => "x")
const withDefault: SchemaConstructorDefault<Int> = schemaConstructorDefault(integer, (): Int => 4)
const structured: Schema<Short> = schemaStruct({ name: text })
const unioned: Schema<Shape> = schemaUnion([short, long])
const transformed: Schema<Int, Text> = schemaTransform(
  text,
  integer,
  (value: Text): Option<Int> => if (value === "one") { Some(1) } else { None },
  (value: Int): Option<Text> => if (value === 1) { Some("one") } else { None }
)
const optionalTransform: SchemaOptional<Int> = schemaOptionalTransform(
  exactInt,
  exactInt,
  (value: Option<Int>): Option<Int> => value,
  (value: Option<Int>): Option<Int> => value
)
const required: SchemaDecodedOptional<Text> = schemaOptionalFromRequired(
  text,
  exact,
  (value: Text): Option<Text> => if (value === "") { None } else { Some(value) },
  (value: Option<Text>): Text => match value { Some(name) => name, None => "" }
)
const recursive: Schema<Tree, Tree, never, never, TreeInput> = schemaRecursive(
  (self: Schema<Tree, Tree, never, never, TreeInput>): Schema<Tree, Tree, never, never, TreeInput> =>
    schemaStruct({
      score: schemaConstructorDefault(integer, (): Int => 4),
      children: schemaConstructorDefault(schemaArray(self), (): TreeInput[] => [])
    })
)
`;

interface Program {
  readonly sources: ReadonlyMap<string, string>;
  /** A fresh copy of the valid IR. */
  forge(): ModuleIR;
}

function lowerProgram(text: string): Program {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": text }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const lowered = [...lowerProject(checked.value).values()][0];
  assert(lowered?.ok, JSON.stringify(lowered));
  const valid = lowered.value;
  return {
    sources: new Map([["main.eff", text]]),
    forge: () => structuredClone(valid),
  };
}

const STREAM_PROGRAM = lowerProgram(STREAMS);
const SCHEMA_PROGRAM = lowerProgram(SCHEMAS);

// ------------------------------------------------------------------ IR editing

function segments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}

/** The value at a path below `root`, for example `arguments[0].elements[1]`. */
function at(root: unknown, path: string): unknown {
  let current = root;
  for (const key of segments(path)) {
    if (typeof key === "number") {
      assert(Array.isArray(current), `${path}: not an array at ${key}`);
      current = current[key];
    } else {
      assert(isObj(current), `${path}: not an object at ${key}`);
      current = current[key];
    }
  }
  return current;
}

function objectAt(root: unknown, path: string): Obj {
  const found = at(root, path);
  assert(isObj(found), `${path}: not an object`);
  return found;
}

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  assert(last !== undefined, "empty path");
  const parent = parts.length === 0 ? root : at(root, pathOf(parts));
  if (typeof last === "number") {
    assert(Array.isArray(parent), `${path}: parent is not an array`);
    parent[last] = value;
  } else {
    assert(isObj(parent), `${path}: parent is not an object`);
    parent[last] = value;
  }
}

function pathOf(parts: readonly (string | number)[]): string {
  return parts.map((p) => typeof p === "number" ? `[${p}]` : `.${p}`).join("")
    .replace(/^\./, "");
}

interface Root {
  /** The IR path of the declaration root, `declarations[i].value` or `.body`. */
  readonly path: string;
  readonly node: Obj;
}

/** The expression at the root of the named constant or function. */
function rootOf(ir: ModuleIR, name: string): Root {
  const index = ir.declarations.findIndex((d) => d.name === name);
  assert(index >= 0, `no declaration named ${name}`);
  const declaration = ir.declarations[index];
  assert(
    declaration.kind === "constant" || declaration.kind === "function",
    name,
  );
  const field = declaration.kind === "constant" ? "value" : "body";
  const node = at(declaration, field);
  assert(isObj(node), name);
  return { path: `declarations[${index}].${field}`, node };
}

const NO_EFFECTS = { failures: [], requirements: [] };
const INT_TYPE = { kind: "primitive", name: "int" };
const STRING_TYPE = { kind: "primitive", name: "string" };

function literal(value: string | number, type: unknown, span: unknown): Obj {
  return {
    kind: "literal",
    value,
    type,
    execution: "pure",
    effects: NO_EFFECTS,
    span,
  };
}

/** A pure expression that is not a Stream, a Sink, a Schema, or a function. */
function wrongValue(kind: "int" | "string", span: unknown): Obj {
  return kind === "int"
    ? literal(1, INT_TYPE, span)
    : literal("x", STRING_TYPE, span);
}

/**
 * A reference to the module function `helper`. It takes the place of an inline
 * closure. The helper has the same signature as the closure it replaces.
 */
function referenceTo(ir: ModuleIR, helper: string, span: unknown): Obj {
  const declaration = ir.declarations.find((d) => d.name === helper);
  assert(declaration?.kind === "function", `no function ${helper}`);
  return {
    kind: "reference",
    target: declaration.id,
    type: declaration.type,
    execution: "pure",
    effects: NO_EFFECTS,
    span,
  };
}

/**
 * The same value, evaluated after an effect. The result keeps its type, and
 * the block records the execution mode "effect".
 */
function impure(value: Obj): Obj {
  const span = value.span;
  return {
    kind: "block",
    steps: [{
      kind: "evaluate",
      value: {
        kind: "make-ref",
        value: literal(0, INT_TYPE, span),
        type: { kind: "ref", element: INT_TYPE },
        execution: "effect",
        effects: NO_EFFECTS,
        span,
      },
    }],
    result: value,
    type: value.type,
    execution: "effect",
    effects: value.effects,
    span,
  };
}

// ------------------------------------------------------------------ Stream families

/** An operator, the IR kind at the root of its declaration, and its operands. */
type Case = readonly [declaration: string, kind: string];

/** Declaration, IR kind, callback field, helper function, message fragment. */
type ClosureRow = readonly [
  ...Case,
  field: string,
  helper: string,
  fragment: string,
];
const CLOSURE_ROWS: readonly ClosureRow[] = [
  ["source", "unfold", "next", "pull", "unfold requires an inline closure"],
  [
    "mapped",
    "map-stream",
    "transform",
    "plusOne",
    "mapStream requires an inline closure",
  ],
  [
    "mappedEffect",
    "map-effect",
    "transform",
    "bump",
    "mapEffect requires an inline closure",
  ],
  [
    "scanned",
    "scan-stream",
    "update",
    "addUp",
    "scanStream requires an inline closure",
  ],
  [
    "accumulated",
    "map-accum-stream",
    "update",
    "accumulate",
    "mapAccumStream requires an inline closure",
  ],
  [
    "folded",
    "fold-stream",
    "update",
    "addUp",
    "foldStream requires an inline closure",
  ],
  [
    "foldedEffect",
    "fold-effect-stream",
    "update",
    "addEffect",
    "foldEffectStream requires an inline closure",
  ],
  [
    "flatMapped",
    "flat-map-streams",
    "transform",
    "expand",
    "flatMapStreams requires an inline closure",
  ],
  [
    "switched",
    "switch-map-streams",
    "transform",
    "expand",
    "switchMapStreams requires an inline closure",
  ],
  [
    "recovered",
    "catch-stream",
    "recover",
    "recover",
    "catchStream requires an inline closure",
  ],
  [
    "dropped",
    "drop-while-stream",
    "predicate",
    "isSmall",
    "dropWhileStream requires an inline closure",
  ],
  [
    "filtered",
    "filter-stream",
    "predicate",
    "isSmall",
    "filterStream requires an inline closure",
  ],
  [
    "takenWhile",
    "take-while-stream",
    "predicate",
    "isSmall",
    "takeWhileStream requires an inline closure",
  ],
  [
    "takenUntil",
    "take-until-stream",
    "predicate",
    "isSmall",
    "takeUntilStream requires an inline closure",
  ],
  [
    "filteredEffect",
    "filter-effect-stream",
    "predicate",
    "allowed",
    "effectful stream predicate requires an inline closure",
  ],
  [
    "takenWhileEffect",
    "take-while-effect-stream",
    "predicate",
    "allowed",
    "effectful stream predicate requires an inline closure",
  ],
  [
    "takenUntilEffect",
    "take-until-effect-stream",
    "predicate",
    "allowed",
    "effectful stream predicate requires an inline closure",
  ],
  [
    "droppedEffect",
    "drop-while-effect-stream",
    "predicate",
    "allowed",
    "effectful stream predicate requires an inline closure",
  ],
  [
    "consumer",
    "sink-for-each",
    "consume",
    "accept",
    "sinkForEach requires an inline closure",
  ],
];

Deno.test("the valid stream and Schema programs validate without diagnostics", () => {
  assertEquals(
    validateModule(STREAM_PROGRAM.forge(), STREAM_PROGRAM.sources),
    [],
  );
  assertEquals(
    validateModule(SCHEMA_PROGRAM.forge(), SCHEMA_PROGRAM.sources),
    [],
  );
});

Deno.test("a stream callback that is a reference instead of an inline closure is rejected", () => {
  for (const [declaration, kind, field, helper, fragment] of CLOSURE_ROWS) {
    const ir = STREAM_PROGRAM.forge();
    const root = rootOf(ir, declaration);
    assertEquals(root.node.kind, kind, declaration);
    const closure = objectAt(root.node, field);
    assertEquals(closure.kind, "closure", `${declaration}.${field}`);
    root.node[field] = referenceTo(ir, helper, closure.span);
    assertValidation(
      validateModule(ir, STREAM_PROGRAM.sources),
      "validation/006",
      `${root.path}.${field}`,
      fragment,
      `${declaration}.${field}`,
    );
  }
});

/** Replacement values for an operand. "type" replaces the recorded type. */
type Wrong = "int" | "string" | "type";

/** Declaration, IR kind, operand field, replacement, message fragment. */
type OperandRow = readonly [
  ...Case,
  field: string,
  wrong: Wrong,
  fragment: string,
];
const OPERAND_ROWS: readonly OperandRow[] = [
  [
    "source",
    "unfold",
    "next",
    "int",
    "unfold needs a callback accepting the state",
  ],
  [
    "mapped",
    "map-stream",
    "stream",
    "int",
    "mapStream needs a Stream and a pure element callback",
  ],
  [
    "mappedEffect",
    "map-effect",
    "stream",
    "int",
    "mapEffect needs a Stream and an element callback",
  ],
  [
    "scanned",
    "scan-stream",
    "stream",
    "int",
    "scanStream needs a Stream and a pure state update callback",
  ],
  [
    "accumulated",
    "map-accum-stream",
    "stream",
    "int",
    "mapAccumStream needs a Stream and a pure callback returning [State, Output[]]",
  ],
  [
    "folded",
    "fold-stream",
    "stream",
    "int",
    "foldStream needs a Stream and a pure state update callback",
  ],
  [
    "foldedEffect",
    "fold-effect-stream",
    "stream",
    "int",
    "foldEffectStream needs a Stream and a compatible state update callback",
  ],
  [
    "collected",
    "collect-stream",
    "stream",
    "int",
    "collectStream needs a Stream value",
  ],
  ["headed", "head-stream", "stream", "int", "headStream needs a Stream value"],
  ["lasted", "last-stream", "stream", "int", "lastStream needs a Stream value"],
  [
    "drained",
    "drain-stream",
    "stream",
    "int",
    "drainStream needs a Stream value",
  ],
  [
    "flatMapped",
    "flat-map-streams",
    "stream",
    "int",
    "flatMapStreams needs a Stream and a pure callback returning a Stream",
  ],
  [
    "switched",
    "switch-map-streams",
    "stream",
    "int",
    "switchMapStreams needs a Stream and a pure callback returning a Stream",
  ],
  [
    "recovered",
    "catch-stream",
    "stream",
    "int",
    "catchStream needs a Stream and a pure error callback returning a Stream",
  ],
  [
    "retried",
    "retry-stream",
    "stream",
    "int",
    "retryStream needs a Stream and a RetrySchedule",
  ],
  [
    "retried",
    "retry-stream",
    "policy",
    "int",
    "retryStream needs a Stream and a RetrySchedule",
  ],
  [
    "debounced",
    "debounce-stream",
    "stream",
    "int",
    "debounceStream needs a Stream",
  ],
  [
    "throttled",
    "throttle-stream",
    "stream",
    "int",
    "throttleStream needs a Stream",
  ],
  [
    "taken",
    "take-stream",
    "stream",
    "int",
    "takeStream needs a Stream value and an Int count",
  ],
  [
    "taken",
    "take-stream",
    "count",
    "string",
    "takeStream needs a Stream value and an Int count",
  ],
  [
    "skipped",
    "drop-stream",
    "stream",
    "int",
    "dropStream needs a Stream value and an Int count",
  ],
  [
    "skipped",
    "drop-stream",
    "count",
    "string",
    "dropStream needs a Stream value and an Int count",
  ],
  [
    "dropped",
    "drop-while-stream",
    "stream",
    "int",
    "dropWhileStream needs a Stream and a pure boolean predicate",
  ],
  [
    "filtered",
    "filter-stream",
    "stream",
    "int",
    "filterStream needs a Stream and a pure boolean predicate",
  ],
  [
    "takenWhile",
    "take-while-stream",
    "stream",
    "int",
    "takeWhileStream needs a Stream and a pure boolean predicate",
  ],
  [
    "takenUntil",
    "take-until-stream",
    "stream",
    "int",
    "takeUntilStream needs a Stream and a pure boolean predicate",
  ],
  [
    "filteredEffect",
    "filter-effect-stream",
    "stream",
    "int",
    "effectful stream predicate needs a Stream and a boolean callback",
  ],
  [
    "takenWhileEffect",
    "take-while-effect-stream",
    "stream",
    "int",
    "effectful stream predicate needs a Stream and a boolean callback",
  ],
  [
    "takenUntilEffect",
    "take-until-effect-stream",
    "stream",
    "int",
    "effectful stream predicate needs a Stream and a boolean callback",
  ],
  [
    "droppedEffect",
    "drop-while-effect-stream",
    "stream",
    "int",
    "effectful stream predicate needs a Stream and a boolean callback",
  ],
  [
    "consumer",
    "sink-for-each",
    "consume",
    "int",
    "sinkForEach needs a one-argument void callback",
  ],
  ["pairs", "take-sink", "type", "type", "takeSink needs a Sink annotation"],
  [
    "buffered",
    "buffer-stream",
    "stream",
    "int",
    "bufferStream needs a Stream value",
  ],
  [
    "merged",
    "merge-streams",
    "left",
    "int",
    "mergeStreams needs two Stream values",
  ],
  [
    "merged",
    "merge-streams",
    "right",
    "int",
    "mergeStreams needs two Stream values",
  ],
  [
    "zipped",
    "zip-streams",
    "left",
    "int",
    "zipStreams needs two Stream values",
  ],
  [
    "zipped",
    "zip-streams",
    "right",
    "int",
    "zipStreams needs two Stream values",
  ],
  [
    "concatenated",
    "concat-streams",
    "left",
    "int",
    "concatStreams needs two Stream values",
  ],
  [
    "concatenated",
    "concat-streams",
    "right",
    "int",
    "concatStreams needs two Stream values",
  ],
  [
    "batches",
    "transduce-stream",
    "stream",
    "int",
    "transduceStream needs compatible input and replayable Sink leftovers",
  ],
  [
    "batches",
    "transduce-stream",
    "sink",
    "int",
    "transduceStream needs compatible input and replayable Sink leftovers",
  ],
  [
    "aggregated",
    "aggregate-stream",
    "stream",
    "int",
    "aggregateStream needs compatible input and replayable Sink leftovers",
  ],
  [
    "aggregated",
    "aggregate-stream",
    "sink",
    "int",
    "aggregateStream needs compatible input and replayable Sink leftovers",
  ],
  [
    "ran",
    "run-stream",
    "stream",
    "int",
    "runStream needs compatible Stream and Sink values",
  ],
  [
    "ran",
    "run-stream",
    "sink",
    "int",
    "runStream needs compatible Stream and Sink values",
  ],
];

Deno.test("a stream operator with a non-stream operand is rejected", () => {
  for (const [declaration, kind, field, wrong, fragment] of OPERAND_ROWS) {
    const ir = STREAM_PROGRAM.forge();
    const root = rootOf(ir, declaration);
    assertEquals(root.node.kind, kind, declaration);
    // The path of the diagnostic is the operator node, except for the callbacks
    // of unfold, which the validator names directly.
    const operand = at(root.node, field);
    const path = kind === "unfold" ? `${root.path}.${field}` : root.path;
    if (wrong === "type") {
      root.node.type = INT_TYPE;
    } else {
      assert(isObj(operand), `${declaration}.${field}`);
      root.node[field] = wrongValue(wrong, operand.span);
    }
    assertValidation(
      validateModule(ir, STREAM_PROGRAM.sources),
      "validation/002",
      path,
      fragment,
      `${declaration}.${field}`,
    );
  }
});

Deno.test("an unfold callback that does not return an Option pair is rejected", () => {
  const ir = STREAM_PROGRAM.forge();
  const root = rootOf(ir, "source");
  assertEquals(root.node.kind, "unfold");
  setAt(root.node, "next.type.result", INT_TYPE);
  assertValidation(
    validateModule(ir, STREAM_PROGRAM.sources),
    "validation/002",
    `${root.path}.next`,
    "unfold callback must return Option<[Element, State]>",
    "unfold result",
  );
});

/** Declaration, IR kind, field of the seed, count, or policy, message fragment. */
type ImpureRow = readonly [...Case, field: string, fragment: string];
const IMPURE_ROWS: readonly ImpureRow[] = [
  ["scanned", "scan-stream", "seed", "scanStream seed must be pure"],
  [
    "accumulated",
    "map-accum-stream",
    "seed",
    "mapAccumStream seed must be pure",
  ],
  ["folded", "fold-stream", "seed", "foldStream seed must be pure"],
  [
    "foldedEffect",
    "fold-effect-stream",
    "seed",
    "foldEffectStream seed must be pure",
  ],
  ["taken", "take-stream", "count", "takeStream count must be pure"],
  ["skipped", "drop-stream", "count", "dropStream count must be pure"],
  ["retried", "retry-stream", "policy", "retryStream policy must be pure"],
];

Deno.test("a stream seed, count, or policy that is not pure is rejected", () => {
  for (const [declaration, kind, field, fragment] of IMPURE_ROWS) {
    const ir = STREAM_PROGRAM.forge();
    const root = rootOf(ir, declaration);
    assertEquals(root.node.kind, kind, declaration);
    root.node[field] = impure(objectAt(root.node, field));
    assertValidation(
      validateModule(ir, STREAM_PROGRAM.sources),
      "validation/004",
      `${root.path}.${field}`,
      fragment,
      `${declaration}.${field}`,
    );
  }
});

// ------------------------------------------------------------------ Schema families

/**
 * Declaration, op, path of the replaced node below the Schema node, and message
 * fragment. The optional last path names a recorded type that changes with the
 * replaced node. A record or tuple argument then stays consistent in itself, and
 * the Schema rule decides.
 */
type SchemaArgRow = readonly [
  declaration: string,
  op: string,
  path: string,
  wrong: "int" | "string",
  fragment: string,
  retype?: string,
];
const SCHEMA_ARGUMENT_ROWS: readonly SchemaArgRow[] = [
  [
    "message",
    "invalid",
    "arguments[0]",
    "int",
    "schemaInvalid needs a string message",
  ],
  [
    "located",
    "at",
    "arguments[1]",
    "int",
    "schemaAt needs a key and a SchemaIssue",
  ],
  [
    "both",
    "both",
    "arguments[0]",
    "int",
    "schemaBoth needs a Schema and two issues",
  ],
  ["listed", "array", "arguments[0]", "int", "schemaArray needs one Schema"],
  [
    "exact",
    "optional-key",
    "arguments[0]",
    "int",
    "schemaOptionalKey needs one ordinary Schema",
  ],
  [
    "nulls",
    "null-to-missing-key",
    "arguments[0]",
    "int",
    "schemaNullToMissingKey needs one ordinary Schema",
  ],
  [
    "optionFrom",
    "option-from-optional-key",
    "arguments[0]",
    "int",
    "schemaOptionFromOptionalKey needs one ordinary Schema",
  ],
  [
    "defaulted",
    "default-key",
    "arguments[0]",
    "int",
    "schemaDefaultKey needs a callback",
  ],
  [
    "defaultedNull",
    "default-null-key",
    "arguments[0]",
    "int",
    "schemaDefaultNullKey needs a callback",
  ],
  [
    "defaultedEncoded",
    "default-encoded-key",
    "arguments[0]",
    "int",
    "schemaDefaultEncodedKey needs a callback",
  ],
  [
    "withDefault",
    "constructor-default",
    "arguments[0]",
    "int",
    "schemaConstructorDefault needs an inline make-input callback",
  ],
  [
    "structured",
    "struct",
    "arguments[0]",
    "int",
    "schemaStruct needs required Schema fields",
  ],
  [
    "structured",
    "struct",
    "arguments[0].fields[0].value",
    "int",
    "schemaStruct field is not a Schema or optional descriptor",
    "arguments[0].type.fields[0].type",
  ],
  [
    "unioned",
    "union",
    "arguments[0]",
    "int",
    "schemaUnion needs an inline tuple of branches",
  ],
  [
    "unioned",
    "union",
    "arguments[0].elements[0]",
    "int",
    "schemaUnion branches must be ordinary Schema values",
    "arguments[0].type.elements[0]",
  ],
  [
    "transformed",
    "transform",
    "arguments[0]",
    "int",
    "schemaTransform callback types or failure channels do not match",
  ],
  [
    "transformed",
    "transform",
    "arguments[1]",
    "int",
    "schemaTransform callback types or failure channels do not match",
  ],
  [
    "optionalTransform",
    "optional-transform",
    "arguments[0]",
    "int",
    "schemaOptionalTransform needs directional Option callbacks",
  ],
  [
    "optionalTransform",
    "optional-transform",
    "arguments[1]",
    "int",
    "schemaOptionalTransform needs directional Option callbacks",
  ],
  [
    "required",
    "optional-from-required",
    "arguments[0]",
    "int",
    "schemaOptionalFromRequired needs required-to-optional callbacks",
  ],
  [
    "required",
    "optional-from-required",
    "arguments[1]",
    "int",
    "schemaOptionalFromRequired needs required-to-optional callbacks",
  ],
  [
    "recursive",
    "recursive",
    "arguments[0]",
    "int",
    "schemaRecursive needs a pure body",
  ],
];

Deno.test("a Schema constructor with a non-Schema argument is rejected", () => {
  for (
    const [declaration, op, path, wrong, fragment, retype]
      of SCHEMA_ARGUMENT_ROWS
  ) {
    const ir = SCHEMA_PROGRAM.forge();
    const root = rootOf(ir, declaration);
    assertEquals(root.node.kind, "schema", declaration);
    assertEquals(root.node.op, op, declaration);
    const argument = objectAt(root.node, path);
    setAt(root.node, path, wrongValue(wrong, argument.span));
    if (retype !== undefined) setAt(root.node, retype, INT_TYPE);
    assertValidation(
      validateModule(ir, SCHEMA_PROGRAM.sources),
      "validation/002",
      root.path,
      fragment,
      `${declaration}: ${path}`,
    );
  }
});

Deno.test("a Schema identity descriptor with a non-Schema type is rejected", () => {
  const ir = SCHEMA_PROGRAM.forge();
  const root = rootOf(ir, "text");
  assertEquals(root.node.op, "identity");
  root.node.type = INT_TYPE;
  assertValidation(
    validateModule(ir, SCHEMA_PROGRAM.sources),
    "validation/002",
    root.path,
    "schema() needs an identity data Schema",
    "identity descriptor",
  );
});

/** Declaration, op, index of the callback argument, message fragment. */
type CallbackRow = readonly [
  declaration: string,
  op: string,
  index: number,
  fragment: string,
];
const CALLBACK_ROWS: readonly CallbackRow[] = [
  [
    "withDefault",
    "constructor-default",
    1,
    "schemaConstructorDefault needs an inline make-input callback",
  ],
  ["defaulted", "default-key", 1, "schemaDefaultKey needs a callback"],
  [
    "defaultedNull",
    "default-null-key",
    1,
    "schemaDefaultNullKey needs a callback",
  ],
  [
    "defaultedEncoded",
    "default-encoded-key",
    1,
    "schemaDefaultEncodedKey needs a callback",
  ],
  [
    "transformed",
    "transform",
    2,
    "schemaTransform callback types or failure channels do not match",
  ],
  [
    "transformed",
    "transform",
    3,
    "schemaTransform callback types or failure channels do not match",
  ],
  [
    "optionalTransform",
    "optional-transform",
    2,
    "schemaOptionalTransform needs directional Option callbacks",
  ],
  [
    "optionalTransform",
    "optional-transform",
    3,
    "schemaOptionalTransform needs directional Option callbacks",
  ],
  [
    "required",
    "optional-from-required",
    2,
    "schemaOptionalFromRequired needs required-to-optional callbacks",
  ],
  [
    "required",
    "optional-from-required",
    3,
    "schemaOptionalFromRequired needs required-to-optional callbacks",
  ],
  ["recursive", "recursive", 0, "schemaRecursive needs a pure body"],
];

Deno.test("a Schema callback that fails with another error is rejected", () => {
  for (const [declaration, op, index, fragment] of CALLBACK_ROWS) {
    const ir = SCHEMA_PROGRAM.forge();
    const other = ir.declarations.find((d) =>
      d.kind === "error" && d.name === "Other"
    );
    assert(other?.kind === "error");
    const root = rootOf(ir, declaration);
    assertEquals(root.node.op, op, declaration);
    const callback = objectAt(root.node, `arguments[${index}]`);
    assertEquals(callback.kind, "closure", `${declaration}[${index}]`);
    const type = objectAt(callback, "type");
    assertEquals(type.kind, "function", `${declaration}[${index}]`);
    type.execution = "effect";
    type.effects = { failures: [other.id], requirements: [] };
    assertValidation(
      validateModule(ir, SCHEMA_PROGRAM.sources),
      "validation/002",
      root.path,
      fragment,
      `${declaration}: arguments[${index}]`,
    );
  }
});

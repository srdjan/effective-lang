// Tests for part A5: the independent IR validator. The tests run through the
// public entries `validateModule` and `validateProject`. Differential tests
// lower the fixture programs and require zero diagnostics. Mutation tests
// change one fact of a lowered IR and require the diagnostic of its area.

import { assert, assertEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { describeCode, registeredCodes } from "../src/core/diagnostics.ts";
import type { Execution, Field, ModuleIR, Type } from "../src/core/ir.ts";
import { lowerProject } from "../src/core/lower.ts";
import { memoryHost } from "../src/core/source.ts";
import { validateModule } from "../src/core/validate/index.ts";
import { fits, same, type TypeEnv } from "../src/core/validate/typing.ts";
import { validateProject } from "../src/core/validate_project.ts";
import { buildFixtures } from "../scripts/validate_fixtures.ts";
import {
  diskHost,
  EXAMPLE_ENTRIES,
  FIXTURES,
  validationManifest,
} from "./helpers.ts";

// ------------------------------------------------------------------ helpers

type Obj = Record<string, unknown>;

function segments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}

function at(root: unknown, path: string): unknown {
  let current = root;
  for (const key of segments(path)) {
    current = typeof key === "number"
      ? (current as unknown[])[key]
      : (current as Obj)[key];
  }
  return current;
}

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  assert(last !== undefined);
  let parent = root;
  for (const key of parts) {
    parent = typeof key === "number"
      ? (parent as unknown[])[key]
      : (parent as Obj)[key];
  }
  if (typeof last === "number") (parent as unknown[])[last] = value;
  else (parent as Obj)[last] = value;
}

function copy<T>(value: T): T {
  const result: unknown = JSON.parse(JSON.stringify(value));
  return result as T;
}

interface Lowered {
  readonly modules: ReadonlyMap<string, ModuleIR>;
  readonly sources: ReadonlyMap<string, string>;
}

function lowerDisk(root: string, entries: readonly string[]): Lowered {
  const checked = checkProject(diskHost(), root, entries);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const modules = new Map<string, ModuleIR>();
  for (const [name, result] of lowerProject(checked.value)) {
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    modules.set(name, result.value);
  }
  const sources = new Map<string, string>();
  for (const info of checked.value.analysis.project.modules.values()) {
    sources.set(info.path, info.tree.text);
  }
  return { modules, sources };
}

const EXAMPLES = lowerDisk("examples", EXAMPLE_ENTRIES);
const FORMS = lowerDisk("emit/forms", ["forms.eff", "names.eff"]);

function lowerText(
  text: string,
): { ir: ModuleIR; sources: Map<string, string> } {
  const checked = checkProject(
    memoryHost({ "effective.json": "{}", "m.eff": text }),
    "",
    ["m.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const result = lowerProject(checked.value).get("m");
  assert(result?.ok === true);
  return { ir: result.value, sources: new Map([["m.eff", text]]) };
}

Deno.test("Effect construction and execution validate independently", () => {
  const lowered = lowerText(`
error Stop = {}
service Counter { next(): Int fails Stop }
const make = (): Effect<Int, Stop, Counter.next> =>
  defer(() => Counter.next())
const use = (stored: Effect<Int, Stop, Counter.next>): Int fails Stop uses Counter.next =>
  run(stored)
type Int = int
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const mutated = copy(lowered.ir);
  const make = mutated.declarations.find((d) => d.name === "make");
  assert(make?.kind === "function" && make.body.kind === "defer");
  setAt(make, "body.type.effects.requirements", []);
  assert(codesOf(mutated, lowered.sources).includes("validation/002"));
  const changedFailure = copy(lowered.ir);
  const changedMake = changedFailure.declarations.find((d) =>
    d.name === "make"
  );
  assert(changedMake?.kind === "function" && changedMake.body.kind === "defer");
  setAt(changedMake, "body.type.effects.failures", []);
  assert(codesOf(changedFailure, lowered.sources).includes("validation/002"));
});

Deno.test("run as a pipeline stage validates locally", () => {
  const lowered = lowerText(
    "const f = (stored: Effect<Int>): Int => stored |> run\ntype Int = int",
  );
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
});

Deno.test("stream buffering validates its bound and merged deferred channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Source { next(state: Int): Option<[Int, Int]> fails Stop }
const first = unfold(0, (state) => Source.next(state))
const second = unfold(10, (state) => Source.next(state))
const merged = mergeStreams(bufferStream(first, { capacity: 2 }), second)
type Int = int
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrong = copy(lowered.ir);
  const merged = wrong.declarations.find((d) => d.name === "merged");
  assert(merged?.kind === "constant" && merged.value.kind === "merge-streams");
  const buffered = merged.value.left;
  assert(buffered.kind === "buffer-stream");
  (buffered as { capacity: number }).capacity = 0;
  assert(codesOf(wrong, lowered.sources).includes("validation/006"));
});

Deno.test("stream zipping validates paired elements and deferred channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Left { next(n: Int): Option<[Int, Int]> fails Stop }
service Right { next(n: Int): Option<[Text, Int]> }
const left = unfold(0, (n) => Left.next(n))
const right = unfold(0, (n) => Right.next(n))
const zipped = zipStreams(left, right)
type Int = int
type Text = string
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrong = copy(lowered.ir);
  const zipped = wrong.declarations.find((d) => d.name === "zipped");
  assert(zipped?.kind === "constant" && zipped.value.kind === "zip-streams");
  setAt(zipped, "value.type.effects.failures", []);
  assert(codesOf(wrong, lowered.sources).includes("validation/002"));
});

Deno.test("stream concatenation validates element union and deferred channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Left { next(n: Int): Option<[Int, Int]> fails Stop }
service Right { next(n: Int): Option<[Text, Int]> }
const left = unfold(0, (n) => Left.next(n))
const right = unfold(0, (n) => Right.next(n))
const combined = concatStreams(left, right)
type Int = int
type Text = string
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrong = copy(lowered.ir);
  const combined = wrong.declarations.find((d) => d.name === "combined");
  assert(
    combined?.kind === "constant" && combined.value.kind === "concat-streams",
  );
  setAt(combined, "value.type.effects.failures", []);
  assert(codesOf(wrong, lowered.sources).includes("validation/002"));
});

Deno.test("stream flat mapping validates inner deferred channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Outer { next(n: Int): Option<[Int, Int]> }
service Inner { next(n: Int): Option<[Text, Int]> fails Stop }
const outer = unfold(0, (n) => Outer.next(n))
const nested = flatMapStreams(outer, (n) => unfold(n, (m) => Inner.next(m)))
type Int = int
type Text = string
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrong = copy(lowered.ir);
  const nested = wrong.declarations.find((d) => d.name === "nested");
  assert(
    nested?.kind === "constant" && nested.value.kind === "flat-map-streams",
  );
  setAt(nested, "value.type.effects.failures", []);
  assert(codesOf(wrong, lowered.sources).includes("validation/002"));
});

Deno.test("race validates its result and deferred effect channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Source { next(): Int fails Stop }
const choice = race(defer(() => Source.next()), defer(() => 2))
type Int = int
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrong = copy(lowered.ir);
  const choice = wrong.declarations.find((d) => d.name === "choice");
  assert(choice?.kind === "constant" && choice.value.kind === "race");
  (choice.value.type as unknown as { effects: { failures: string[] } }).effects
    .failures = [];
  assert(codesOf(wrong, lowered.sources).includes("validation/002"));
});

Deno.test("reference operations validate atomic pure updates", () => {
  const lowered = lowerText(`
type Int = int
const count = (): Int => {
  const ref = makeRef(0)
  updateRef(ref, (n) => n + 1)
  getRef(ref)
}
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
});

Deno.test("source Layers validate acquisition and disjoint service sets", () => {
  const lowered = lowerText(`
service First { one(): Int }
service Second { two(): Int }
const first = layer(First, () => ({ one: () => 1 }))
const second = layer(Second, () => ({ two: () => 2 }))
const both: Layer<First | Second> = mergeLayers(first, second)
type Int = int
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const overlap = copy(lowered.ir);
  const both = overlap.declarations.find((d) => d.name === "both");
  assert(both?.kind === "constant" && both.value.kind === "merge-layers");
  (both.value as { right: unknown }).right = both.value.left;
  assert(codesOf(overlap, lowered.sources).includes("validation/006"));
});

Deno.test("with-resource validation rejects scoped escape and channel mutation", () => {
  const lowered = lowerText(`
error Stop = {}
service Files { open(): { read: () => Text fails Stop, close: () => void } }
const load = (): Text fails Stop uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
type Text = string
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const wrongId = copy(lowered.ir);
  const one = wrongId.declarations.find((d) => d.name === "load");
  assert(one?.kind === "function" && one.body.kind === "with-resource");
  (one.body as { useBinding: string }).useBinding = "local:m#missing";
  assert(codesOf(wrongId, lowered.sources).includes("validation/006"));

  const escaped = copy(lowered.ir);
  const two = escaped.declarations.find((d) => d.name === "load");
  assert(two?.kind === "function" && two.body.kind === "with-resource");
  const use = two.body.use;
  assert(use.kind === "closure" && use.body.kind === "call");
  const operation = use.body.callee;
  assert(operation.kind === "get" && operation.record.kind === "reference");
  (use as { body: typeof operation.record }).body = operation.record;
  assert(codesOf(escaped, lowered.sources).includes("validation/006"));

  const muted = copy(lowered.ir);
  const three = muted.declarations.find((d) => d.name === "load");
  assert(three?.kind === "function" && three.body.kind === "with-resource");
  (three.body as unknown as { effects: { failures: string[] } }).effects
    .failures = [];
  assert(codesOf(muted, lowered.sources).includes("validation/003"));
});

Deno.test("bounded traversal validation rejects a mutated concurrency bound", () => {
  const lowered = lowerText(
    "const f = (): Int[] => traverse([1, 2], (n) => n, { concurrency: 2 })\ntype Int = int",
  );
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const changed = copy(lowered.ir);
  const functionDecl = changed.declarations.find((d) => d.name === "f");
  assert(
    functionDecl?.kind === "function" && functionDecl.body.kind === "call",
  );
  const options = functionDecl.body.arguments[2];
  assert(
    options?.kind === "record" && options.fields[0]?.value.kind === "literal",
  );
  (options.fields[0].value as { value: number }).value = 0;
  assert(codesOf(changed, lowered.sources).includes("validation/006"));
});

Deno.test("unbounded traversal validation rejects a different string", () => {
  const lowered = lowerText(
    'const f = (): Int[] => traverse([1, 2], (n) => n, { concurrency: "unbounded" })\ntype Int = int',
  );
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const changed = copy(lowered.ir);
  const functionDecl = changed.declarations.find((d) => d.name === "f");
  assert(
    functionDecl?.kind === "function" && functionDecl.body.kind === "call",
  );
  const options = functionDecl.body.arguments[2];
  assert(
    options?.kind === "record" && options.fields[0]?.value.kind === "literal",
  );
  (options.fields[0].value as { value: string }).value = "infinite";
  assert(codesOf(changed, lowered.sources).includes("validation/006"));
});

Deno.test("all validates heterogeneous shape and literal concurrency", () => {
  const lowered = lowerText(`
type Int = int
type Text = string
type Jobs = [Effect<Int>, Effect<Text>]
const jobs: Jobs = [defer(() => 1), defer(() => "ok")]
const collect = (): [Int, Text] => all(jobs, { concurrency: "unbounded" })
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const changed = copy(lowered.ir);
  const functionDecl = changed.declarations.find((d) => d.name === "collect");
  assert(
    functionDecl?.kind === "function" && functionDecl.body.kind === "call",
  );
  const options = functionDecl.body.arguments[1];
  assert(
    options?.kind === "record" && options.fields[0]?.value.kind === "literal",
  );
  (options.fields[0].value as { value: string }).value = "infinite";
  assert(codesOf(changed, lowered.sources).includes("validation/006"));
  const wrongResult = copy(lowered.ir);
  const wrongFunction = wrongResult.declarations.find((d) =>
    d.name === "collect"
  );
  assert(
    wrongFunction?.kind === "function" && wrongFunction.body.kind === "call",
  );
  (wrongFunction.body as { type: Type }).type = {
    kind: "tuple",
    elements: [
      { kind: "primitive", name: "string" },
      { kind: "primitive", name: "int" },
    ],
  };
  assert(codesOf(wrongResult, lowered.sources).includes("validation/002"));
});

Deno.test("partitionAll validates its result and concurrency", () => {
  const lowered = lowerText(`
type Int = int
error Stop = { n: Int }
service Jobs { run(n: Int): Int fails Stop }
const jobs: Effect<Int, Stop, Jobs.run>[] = [defer(() => Jobs.run(0)), defer(() => Jobs.run(1))]
const result = (): [Int[], Stop[]] uses Jobs.run => partitionAll(jobs, { concurrency: 2 })
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const invalidBound = copy(lowered.ir);
  const boundFunction = invalidBound.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    boundFunction?.kind === "function" &&
      boundFunction.body.kind === "partition-all",
  );
  setAt(boundFunction, "body.concurrency", 0);
  assert(codesOf(invalidBound, lowered.sources).includes("validation/006"));

  const invalidResult = copy(lowered.ir);
  const resultFunction = invalidResult.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    resultFunction?.kind === "function" &&
      resultFunction.body.kind === "partition-all",
  );
  setAt(resultFunction, "body.type.elements[1].element", {
    kind: "primitive",
    name: "never",
  });
  assert(codesOf(invalidResult, lowered.sources).includes("validation/002"));
});

Deno.test("validateAll validates its nominal wrapper and concurrency", () => {
  const lowered = lowerText(`
type Int = int
error Stop = { n: Int }
error Problems = { errors: Stop[] }
service Jobs { run(n: Int): Int fails Stop }
const jobs: Effect<Int, Stop, Jobs.run>[] = [defer(() => Jobs.run(0)), defer(() => Jobs.run(1))]
const result = (): Int[] fails Problems uses Jobs.run =>
  validateAll(jobs, (errors) => Problems({ errors }), { concurrency: 2 })
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const invalidBound = copy(lowered.ir);
  const boundFunction = invalidBound.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    boundFunction?.kind === "function" &&
      boundFunction.body.kind === "validate-all",
  );
  setAt(boundFunction, "body.concurrency", 0);
  assert(codesOf(invalidBound, lowered.sources).includes("validation/006"));

  const invalidWrapper = copy(lowered.ir);
  const wrapperFunction = invalidWrapper.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    wrapperFunction?.kind === "function" &&
      wrapperFunction.body.kind === "validate-all",
  );
  setAt(wrapperFunction, "body.onErrors.type.result", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(invalidWrapper, lowered.sources).includes("validation/002"));
});

Deno.test("allResults validates tagged outcomes and literal concurrency", () => {
  const lowered = lowerText(`
type Int = int
error Stop = { n: Int }
service Jobs { run(n: Int): Int fails Stop }
type Outcome = { _tag: "Success", success: Int } | { _tag: "Failure", failure: Stop }
const jobs: Effect<Int, Stop, Jobs.run>[] = [defer(() => Jobs.run(0)), defer(() => Jobs.run(1))]
const result = (): Outcome[] uses Jobs.run => allResults(jobs, { concurrency: 2 })
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const invalidBound = copy(lowered.ir);
  const boundFunction = invalidBound.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    boundFunction?.kind === "function" &&
      boundFunction.body.kind === "all-results",
  );
  setAt(boundFunction, "body.concurrency", 0);
  assert(codesOf(invalidBound, lowered.sources).includes("validation/006"));

  const invalidResult = copy(lowered.ir);
  const resultFunction = invalidResult.declarations.find((d) =>
    d.name === "result"
  );
  assert(
    resultFunction?.kind === "function" &&
      resultFunction.body.kind === "all-results",
  );
  setAt(resultFunction, "body.type.element", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(invalidResult, lowered.sources).includes("validation/002"));
});

Deno.test("takeStream validates the count and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const limited = (count: Int): Stream<Int, Stop, Source.next> => takeStream(source, count)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const invalidCount = copy(lowered.ir);
  const countFunction = invalidCount.declarations.find((d) =>
    d.name === "limited"
  );
  assert(
    countFunction?.kind === "function" &&
      countFunction.body.kind === "take-stream",
  );
  setAt(countFunction, "body.count.type", {
    kind: "primitive",
    name: "string",
  });
  assert(codesOf(invalidCount, lowered.sources).includes("validation/002"));

  const invalidChannel = copy(lowered.ir);
  const channelFunction = invalidChannel.declarations.find((d) =>
    d.name === "limited"
  );
  assert(
    channelFunction?.kind === "function" &&
      channelFunction.body.kind === "take-stream",
  );
  setAt(channelFunction, "body.type.effects.failures", []);
  assert(codesOf(invalidChannel, lowered.sources).includes("validation/002"));
});

Deno.test("dropStream validates the count and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const limited = (count: Int): Stream<Int, Stop, Source.next> => dropStream(source, count)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const invalidCount = copy(lowered.ir);
  const countFunction = invalidCount.declarations.find((d) =>
    d.name === "limited"
  );
  assert(
    countFunction?.kind === "function" &&
      countFunction.body.kind === "drop-stream",
  );
  setAt(countFunction, "body.count.type", {
    kind: "primitive",
    name: "string",
  });
  assert(codesOf(invalidCount, lowered.sources).includes("validation/002"));

  const invalidChannel = copy(lowered.ir);
  const channelFunction = invalidChannel.declarations.find((d) =>
    d.name === "limited"
  );
  assert(
    channelFunction?.kind === "function" &&
      channelFunction.body.kind === "drop-stream",
  );
  setAt(channelFunction, "body.type.effects.failures", []);
  assert(codesOf(invalidChannel, lowered.sources).includes("validation/002"));
});

Deno.test("takeWhileStream validates predicate and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeWhileStream(source, (n) => n < 3)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongPredicate = copy(lowered.ir);
  const predicate = wrongPredicate.declarations.find((d) =>
    d.name === "prefix"
  );
  assert(
    predicate?.kind === "constant" &&
      predicate.value.kind === "take-while-stream",
  );
  setAt(predicate, "value.predicate.type.result", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(wrongPredicate, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const prefix = wrongChannel.declarations.find((d) => d.name === "prefix");
  assert(
    prefix?.kind === "constant" && prefix.value.kind === "take-while-stream",
  );
  setAt(prefix, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));
});

Deno.test("dropWhileStream validates predicate and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = dropWhileStream(source, (n) => n < 3)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongPredicate = copy(lowered.ir);
  const predicate = wrongPredicate.declarations.find((d) =>
    d.name === "prefix"
  );
  assert(
    predicate?.kind === "constant" &&
      predicate.value.kind === "drop-while-stream",
  );
  setAt(predicate, "value.predicate.type.result", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(wrongPredicate, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const prefix = wrongChannel.declarations.find((d) => d.name === "prefix");
  assert(
    prefix?.kind === "constant" && prefix.value.kind === "drop-while-stream",
  );
  setAt(prefix, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));
});

Deno.test("takeUntilStream validates predicate and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = takeUntilStream(source, (n) => n === 3)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongPredicate = copy(lowered.ir);
  const predicate = wrongPredicate.declarations.find((d) =>
    d.name === "prefix"
  );
  assert(
    predicate?.kind === "constant" &&
      predicate.value.kind === "take-until-stream",
  );
  setAt(predicate, "value.predicate.type.result", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(wrongPredicate, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const prefix = wrongChannel.declarations.find((d) => d.name === "prefix");
  assert(
    prefix?.kind === "constant" && prefix.value.kind === "take-until-stream",
  );
  setAt(prefix, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));
});

Deno.test("filterStream validates predicate and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const prefix: Stream<Int, Stop, Source.next> = filterStream(source, (n) => n < 3)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongPredicate = copy(lowered.ir);
  const predicate = wrongPredicate.declarations.find((d) =>
    d.name === "prefix"
  );
  assert(
    predicate?.kind === "constant" &&
      predicate.value.kind === "filter-stream",
  );
  setAt(predicate, "value.predicate.type.result", {
    kind: "primitive",
    name: "int",
  });
  assert(codesOf(wrongPredicate, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const prefix = wrongChannel.declarations.find((d) => d.name === "prefix");
  assert(
    prefix?.kind === "constant" && prefix.value.kind === "filter-stream",
  );
  setAt(prefix, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));
});

Deno.test("mapStream validates the transformed element and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const mapped: Stream<Bool, Stop, Source.next> = mapStream(source, (n) => n < 3)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const mapped = wrongElement.declarations.find((d) => d.name === "mapped");
  assert(mapped?.kind === "constant" && mapped.value.kind === "map-stream");
  setAt(mapped, "value.type.element", { kind: "primitive", name: "int" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "mapped");
  assert(channel?.kind === "constant" && channel.value.kind === "map-stream");
  setAt(channel, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));
});

Deno.test("scanStream validates the state and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const scanned: Stream<Int, Stop, Source.next> =
  scanStream(source, 0, (total, n) => total + n)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const scanned = wrongElement.declarations.find((d) => d.name === "scanned");
  assert(scanned?.kind === "constant" && scanned.value.kind === "scan-stream");
  setAt(scanned, "value.type.element", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "scanned");
  assert(channel?.kind === "constant" && channel.value.kind === "scan-stream");
  setAt(channel, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));

  const wrongUpdate = copy(lowered.ir);
  const update = wrongUpdate.declarations.find((d) => d.name === "scanned");
  assert(update?.kind === "constant" && update.value.kind === "scan-stream");
  setAt(update, "value.update.type.result", {
    kind: "primitive",
    name: "boolean",
  });
  assert(codesOf(wrongUpdate, lowered.sources).includes("validation/002"));
});

Deno.test("mapAccumStream validates state, outputs, and deferred channels", () => {
  const lowered = lowerText(`
type Int = int
type Bool = boolean
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const mapped: Stream<Bool, Stop, Source.next> =
  mapAccumStream(source, 0, (total, n): [Int, Bool[]] => [total + n, [n < 3]])
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const mapped = wrongElement.declarations.find((d) => d.name === "mapped");
  assert(
    mapped?.kind === "constant" && mapped.value.kind === "map-accum-stream",
  );
  setAt(mapped, "value.type.element", { kind: "primitive", name: "int" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "mapped");
  assert(
    channel?.kind === "constant" && channel.value.kind === "map-accum-stream",
  );
  setAt(channel, "value.type.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/002"));

  const wrongUpdate = copy(lowered.ir);
  const update = wrongUpdate.declarations.find((d) => d.name === "mapped");
  assert(
    update?.kind === "constant" && update.value.kind === "map-accum-stream",
  );
  setAt(update, "value.update.type.result", {
    kind: "primitive",
    name: "boolean",
  });
  assert(codesOf(wrongUpdate, lowered.sources).includes("validation/002"));
});

Deno.test("foldStream validates its final state and active channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int fails Stop uses Source.next =>
  foldStream(source, 0, (total, n) => total + n)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongResult = copy(lowered.ir);
  const main = wrongResult.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "fold-stream");
  setAt(main, "body.type", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongResult, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "main");
  assert(channel?.kind === "function" && channel.body.kind === "fold-stream");
  setAt(channel, "body.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/003"));

  const wrongUpdate = copy(lowered.ir);
  const update = wrongUpdate.declarations.find((d) => d.name === "main");
  assert(update?.kind === "function" && update.body.kind === "fold-stream");
  setAt(update, "body.update.type.result", {
    kind: "primitive",
    name: "boolean",
  });
  assert(codesOf(wrongUpdate, lowered.sources).includes("validation/002"));
});

Deno.test("foldEffectStream validates combined active channels", () => {
  const lowered = lowerText(`
type Int = int
error SourceStop = {}
error UpdateStop = {}
service Source { next(n: Int): Option<[Int, Int]> fails SourceStop }
service Accum { add(total: Int, n: Int): Int fails UpdateStop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int fails SourceStop | UpdateStop uses Source.next | Accum.add =>
  foldEffectStream(source, 0, (total, n) => Accum.add(total, n))
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongResult = copy(lowered.ir);
  const main = wrongResult.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "fold-effect-stream");
  setAt(main, "body.type", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongResult, lowered.sources).includes("validation/002"));

  const wrongFailure = copy(lowered.ir);
  const failure = wrongFailure.declarations.find((d) => d.name === "main");
  assert(
    failure?.kind === "function" && failure.body.kind === "fold-effect-stream",
  );
  setAt(failure, "body.effects.failures", []);
  assert(codesOf(wrongFailure, lowered.sources).includes("validation/003"));

  const wrongRequirement = copy(lowered.ir);
  const requirement = wrongRequirement.declarations.find((d) =>
    d.name === "main"
  );
  assert(
    requirement?.kind === "function" &&
      requirement.body.kind === "fold-effect-stream",
  );
  setAt(requirement, "body.effects.requirements", []);
  assert(codesOf(wrongRequirement, lowered.sources).includes("validation/003"));
});

Deno.test("collectStream validates its array result and active channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Int[] fails Stop uses Source.next => collectStream(source)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const main = wrongElement.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "collect-stream");
  setAt(main, "body.type.element", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "main");
  assert(
    channel?.kind === "function" && channel.body.kind === "collect-stream",
  );
  setAt(channel, "body.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/003"));

  const wrongRequirement = copy(lowered.ir);
  const requirement = wrongRequirement.declarations.find((d) =>
    d.name === "main"
  );
  assert(
    requirement?.kind === "function" &&
      requirement.body.kind === "collect-stream",
  );
  setAt(requirement, "body.effects.requirements", []);
  assert(codesOf(wrongRequirement, lowered.sources).includes("validation/003"));
});

Deno.test("headStream validates its Option result and active channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> fails Stop uses Source.next => headStream(source)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const main = wrongElement.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "head-stream");
  setAt(main, "body.type.element", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "main");
  assert(
    channel?.kind === "function" && channel.body.kind === "head-stream",
  );
  setAt(channel, "body.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/003"));

  const wrongRequirement = copy(lowered.ir);
  const requirement = wrongRequirement.declarations.find((d) =>
    d.name === "main"
  );
  assert(
    requirement?.kind === "function" &&
      requirement.body.kind === "head-stream",
  );
  setAt(requirement, "body.effects.requirements", []);
  assert(codesOf(wrongRequirement, lowered.sources).includes("validation/003"));
});

Deno.test("lastStream validates its Option result and active channels", () => {
  const lowered = lowerText(`
type Int = int
error Stop = {}
service Source { next(n: Int): Option<[Int, Int]> fails Stop }
const source = unfold(0, (n) => Source.next(n))
const main = (): Option<Int> fails Stop uses Source.next => lastStream(source)
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);

  const wrongElement = copy(lowered.ir);
  const main = wrongElement.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "last-stream");
  setAt(main, "body.type.element", { kind: "primitive", name: "boolean" });
  assert(codesOf(wrongElement, lowered.sources).includes("validation/002"));

  const wrongChannel = copy(lowered.ir);
  const channel = wrongChannel.declarations.find((d) => d.name === "main");
  assert(
    channel?.kind === "function" && channel.body.kind === "last-stream",
  );
  setAt(channel, "body.effects.failures", []);
  assert(codesOf(wrongChannel, lowered.sources).includes("validation/003"));

  const wrongRequirement = copy(lowered.ir);
  const requirement = wrongRequirement.declarations.find((d) =>
    d.name === "main"
  );
  assert(
    requirement?.kind === "function" &&
      requirement.body.kind === "last-stream",
  );
  setAt(requirement, "body.effects.requirements", []);
  assert(codesOf(wrongRequirement, lowered.sources).includes("validation/003"));
});

Deno.test("stream validation recomputes deferred and active channels", () => {
  const lowered = lowerText(`
error Stop = {}
service Source { next(state: Int): Option<[Int, Int]> fails Stop }
service Consumer { accept(value: Int): void fails Stop }
const numbers = unfold(0, (state) => Source.next(state))
const sink = sinkForEach((value: Int) => Consumer.accept(value))
const main = (): void fails Stop uses Source.next | Consumer.accept => runStream(numbers, sink)
type Int = int
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const missingDeferred = copy(lowered.ir);
  const numbers = missingDeferred.declarations.find((d) =>
    d.name === "numbers"
  );
  assert(numbers?.kind === "constant" && numbers.value.kind === "unfold");
  (numbers.value.type as unknown as { effects: { failures: string[] } }).effects
    .failures = [];
  assert(codesOf(missingDeferred, lowered.sources).includes("validation/002"));

  const missingActive = copy(lowered.ir);
  const main = missingActive.declarations.find((d) => d.name === "main");
  assert(main?.kind === "function" && main.body.kind === "run-stream");
  (main.body as unknown as { effects: { requirements: string[] } }).effects
    .requirements = [];
  assert(codesOf(missingActive, lowered.sources).includes("validation/003"));
});

function codesOf(ir: unknown, sources: ReadonlyMap<string, string>): string[] {
  return [
    ...new Set(validateModule(ir as ModuleIR, sources).map((d) => d.code)),
  ].sort();
}

Deno.test("version 1 IR is rejected with the required wire version", () => {
  const lowered = lowerText("type Count = int\nconst one = (): Count => 1");
  const previous = copy(lowered.ir) as unknown as { version: number };
  previous.version = 1;
  const diagnostics = validateModule(
    previous as unknown as ModuleIR,
    lowered.sources,
  );
  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.code === "validation/008" &&
      diagnostic.message.includes("light-functional-ir version 2") &&
      diagnostic.message.includes("version 1")
    ),
  );
});

/** The index of a declaration by name. */
function decl(ir: unknown, name: string): number {
  const found = (at(ir, "declarations") as Obj[]).findIndex((d) =>
    d.name === name
  );
  assert(found >= 0, `no declaration ${name}`);
  return found;
}

const STRING: Type = { kind: "primitive", name: "string" };
const INT: Type = { kind: "primitive", name: "int" };
const NO_EFFECTS = { failures: [], requirements: [] };

/** A fresh copy of a lowered module with one mutation applied. */
function mutated(
  from: Lowered,
  module: string,
  change: (ir: unknown, base: (name: string) => string) => void,
): string[] {
  const ir = copy(from.modules.get(module));
  assert(ir !== undefined);
  change(ir, (name) => `declarations[${decl(ir, name)}]`);
  return codesOf(ir, from.sources);
}

// ------------------------------------------------------------------ registry

Deno.test("the validation category registers one code for each of the eight areas", () => {
  const codes = registeredCodes().filter((c) => c.startsWith("validation/"));
  assertEquals(codes, [
    "validation/001",
    "validation/002",
    "validation/003",
    "validation/004",
    "validation/005",
    "validation/006",
    "validation/007",
    "validation/008",
  ]);
  const names = [
    "Identity",
    "Types",
    "Contracts",
    "Execution",
    "Recovery",
    "Control",
    "Initialization",
    "Serialization",
  ];
  codes.forEach((code, i) => {
    assert(describeCode(code).startsWith(`${names[i]}:`), code);
  });
});

// ------------------------------------------------------------------ independence

Deno.test("src/core/validate imports only ir.ts, source.ts, diagnostics.ts, and its own files", () => {
  const directory = new URL("../src/core/validate/", import.meta.url);
  const own = new Set<string>();
  for (const entry of Deno.readDirSync(directory)) {
    assert(entry.isFile, `unexpected entry ${entry.name}`);
    own.add(`./${entry.name}`);
  }
  const allowed = new Set(["../ir.ts", "../source.ts", "../diagnostics.ts"]);
  const pattern =
    /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let checked = 0;
  for (const entry of Deno.readDirSync(directory)) {
    const text = Deno.readTextFileSync(new URL(entry.name, directory));
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      assert(
        own.has(specifier) || allowed.has(specifier),
        `${entry.name} imports ${specifier}`,
      );
      checked++;
    }
  }
  assert(checked > 10, `only ${checked} imports found`);
  assert(own.size >= 5);
});

// ------------------------------------------------------------------ differential

Deno.test("the five examples validate with zero diagnostics", () => {
  const checked = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(checked.ok);
  const lowered = lowerProject(checked.value);
  const report = validateProject(checked.value.analysis.project, lowered);
  assertEquals([...report.keys()].sort(), [
    "collections",
    "log",
    "main",
    "pay",
    "users",
  ]);
  for (const [name, diagnostics] of report) {
    assertEquals(
      diagnostics.map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

Deno.test("the emitter forms and the log example validate with zero diagnostics", () => {
  for (const [name, ir] of FORMS.modules) {
    assertEquals(
      validateModule(ir, FORMS.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
  const log = lowerDisk("ir", ["example/log.eff"]);
  for (const [name, ir] of log.modules) {
    assertEquals(
      validateModule(ir, log.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

function lowerFiles(
  files: Record<string, string>,
  entries: readonly string[],
): Lowered {
  const checked = checkProject(memoryHost(files), "", entries);
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const modules = new Map<string, ModuleIR>();
  for (const [name, result] of lowerProject(checked.value)) {
    assert(result.ok, `${name}: ${JSON.stringify(result)}`);
    modules.set(name, result.value);
  }
  const sources = new Map<string, string>();
  for (const info of checked.value.analysis.project.modules.values()) {
    sources.set(info.path, info.tree.text);
  }
  return { modules, sources };
}

const EXTRA_PROGRAMS: Readonly<Record<string, Record<string, string>>> = {
  "incremental stream and sink": {
    "effective.json": "{}",
    "m.eff": `
service Source { next(state: Int): Option<[Int, Int]> }
service Consumer { accept(value: Int): void }
const source = unfold(0, (state) => Source.next(state))
const mapped = mapEffect(source, (value) => value + 1)
const sink = sinkForEach((value: Int) => Consumer.accept(value))
export const main = (): void uses Source.next | Consumer.accept => runStream(mapped, sink)
type Int = int
`,
  },
  "bounded traversal": {
    "effective.json": "{}",
    "m.eff": `
error Stop = {}
service S { step(n: Int): Int fails Stop }
export const f = (): Int[] fails Stop uses S.step =>
  traverse([1, 2], (n) => S.step(n), { concurrency: 2 })
type Int = int
`,
  },
  "scoped operation records": {
    "effective.json": "{}",
    "m.eff": `
error Stop = {}
service Files { open(): { read: () => Text fails Stop, close: () => void } }
export const load = (): Text fails Stop uses Files.open =>
  withResource(() => Files.open(), (file) => file.read(), (file) => file.close())
type Text = string
`,
  },
  "block-local functions, optional fields, and boolean operators": {
    "effective.json": "{}",
    "m.eff": `
type P = { name: string, age?: int }
export const f = (p: P, xs: Int[]): Int => {
  const double = (n: Int): Int => n * 2
  const g = (n: Int) => double(n) + 1
  const total = xs |> map((x) => g(x)) |> fold(0, (a, b) => a + b)
  const nm = match p.age { Some(a) => a, None => 0 }
  if (nm > 3 && total < 100 || false) { total } else { nm }
}
type Int = int
`,
  },
  "error unions in try and match": {
    "effective.json": "{}",
    "m.eff": `
error A = { a: string }
error B = { b: int }
service S { go(): Int fails A | B }
export const f = (): Text uses S.go =>
  try { S.go() + 1
 "x" } catch { A(e) => e.a, B(e) => "b" }
export const h = (e: A | B): Text => match e { A(x) => x.a, B(y) => "b" }
type Int = int
type Text = string
`,
  },
  "options, equality, and mixed arithmetic": {
    "effective.json": "{}",
    "m.eff": `
export const f = (x: Int): Option<Int> => Some(x + 1)
export const g = (): Option<Text> => None
export const h = (o: Option<Int>): Int => match o { Some(v) => v, None => 0 }
export const eqs = (a: Text, b: Text): Bool => a === b || a !== "x"
export const mixed = (a: Int, b: Num): Num => a + b / 2
export const strs = (a: Text): Text => a + "s"
type Int = int
type Num = number
type Text = string
type Bool = boolean
`,
  },
  "pipeline stages that call, perform, and fail": {
    "effective.json": "{}",
    "m.eff": `
error E = { m: string }
error F = { x: int }
service S {
  all(): Int[] fails E
  one(n: Int): Int
}
const inc = (n: Int): Int => n + 1
export const f = (): Int[] fails E uses S.all => S.all() |> map(inc)
export const g = (n: Int): Int uses S.one => n |> S.one |> inc
export const k = (): Int fails F => F({ x: 1 }) |> fail
type Int = int
`,
  },
};

for (const [title, files] of Object.entries(EXTRA_PROGRAMS)) {
  Deno.test(`extra program validates with zero diagnostics: ${title}`, () => {
    const lowered = lowerFiles(files, ["m.eff"]);
    for (const [name, ir] of lowered.modules) {
      assertEquals(
        validateModule(ir, lowered.sources).map((d) =>
          `${d.code} ${d.message}`
        ),
        [],
        name,
      );
    }
  });
}

Deno.test("a retry stage with an effectful left value validates locally", () => {
  const { ir, sources } = lowerText(
    [
      "service S {",
      "  mk(): () => Int",
      "  n(): Int",
      "}",
      "const plus = (x: Int, y: Int): Int => x + y",
      "export const f = (): Int uses S.mk => S.mk() |> retry({ times: 2 })",
      "export const g = (): Int uses S.mk => retry(S.mk(), { times: 2 })",
      "export const h = (): Int uses S.mk | S.n => S.mk() |> retry({ times: 2 }) |> plus(S.n())",
      "type Int = int",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const f = ir.declarations[decl(ir, "f")];
  assert(f.kind === "function" && f.body.kind === "block");
  assertEquals(f.body.result.effects.requirements, []);
  assertEquals(f.body.effects.requirements, ["cap:m#S.mk"]);
  const wrong = copy(ir);
  setAt(
    wrong,
    `declarations[${decl(wrong, "f")}].body.result.effects.requirements`,
    ["cap:m#S.mk"],
  );
  assertEquals(codesOf(wrong, sources), ["validation/003"]);
});

Deno.test("retry schedule validates its deferred failure channel", () => {
  const { ir, sources } = lowerText(`
error Stop = {}
service Jobs { next(): Int fails Stop }
const policy: RetrySchedule<Stop> = retrySchedule((error: Stop, attempt: Int): Option<Int> =>
  if (attempt < 2) { Some(0) } else { None })
export const run = (): Int fails Stop uses Jobs.next => retry(() => Jobs.next(), { schedule: policy })
type Int = int
`);
  assertEquals(validateModule(ir, sources), []);
  const wrong = copy(ir);
  const run = wrong.declarations[decl(wrong, "run")];
  assert(run.kind === "function");
  setAt(wrong, `declarations[${decl(wrong, "run")}].body.effects.failures`, []);
  assertEquals(codesOf(wrong, sources), ["validation/003"]);
});

Deno.test("codec validator rejects an effectful transformation in IR", () => {
  const { ir, sources } = lowerText(`
type Int = int
export const shift: Codec<Int, Int> = codec((n: Int): Int => n + 1, (n: Int): Int => n - 1)
`);
  assertEquals(validateModule(ir, sources), []);
  const wrong = copy(ir);
  const shift = wrong.declarations[decl(wrong, "shift")];
  assert(shift.kind === "constant" && shift.value.kind === "codec");
  setAt(
    wrong,
    `declarations[${decl(wrong, "shift")}].value.decode.type.execution`,
    "effect",
  );
  assert(codesOf(wrong, sources).includes("validation/006"));
});

Deno.test("scoped fiber validator checks join failures and handle identity", () => {
  const { ir, sources } = lowerText(`
error Stop = {}
service Jobs { next(): Int fails Stop }
export const run = (): Int fails Stop uses Jobs.next =>
  withFiber(defer(() => Jobs.next()), (fiber) => joinFiber(fiber))
type Int = int
`);
  assertEquals(validateModule(ir, sources), []);
  const wrong = copy(ir);
  const run = wrong.declarations[decl(wrong, "run")];
  assert(run.kind === "function" && run.body.kind === "with-fiber");
  setAt(
    wrong,
    `declarations[${decl(wrong, "run")}].body.useBinding`,
    "local:m#unknown",
  );
  assert(codesOf(wrong, sources).includes("validation/006"));
});

Deno.test("scoped fiber validation checks the reserved scope requirement", () => {
  const { ir, sources } = lowerText(`
const job = defer(() => forkScoped(defer(() => 1)))
export const main = (): void => scoped(job)
`);
  assertEquals(validateModule(ir, sources), []);
  const missing = copy(ir);
  const job = missing.declarations[decl(missing, "job")];
  assert(
    job.kind === "constant" && job.value.kind === "defer" &&
      job.value.job.kind === "closure" &&
      job.value.job.body.kind === "fork-scoped",
  );
  setAt(job, "value.job.body.effects.requirements", []);
  assert(codesOf(missing, sources).includes("validation/003"));
  const leaked = copy(ir);
  const main = leaked.declarations[decl(leaked, "main")];
  assert(main.kind === "function" && main.body.kind === "scoped");
  setAt(main, "body.effects.requirements", ["cap:effect/Scope"]);
  assert(codesOf(leaked, sources).includes("validation/003"));
});

Deno.test("borrowed host handle validation rejects a lost qualifier", () => {
  const files = {
    "effective.json": JSON.stringify({
      host: { files: { interface: "./host.effi", module: "./host.ts" } },
    }),
    "host.effi": `
export opaque type Handle
export type Text = string
export service Files {
  open(): Handle
  read(borrow handle: Handle): Text
  close(borrow handle: Handle): void
}
`,
    "main.eff": `
import { Handle, Text, Files } from "host:files"
const readBorrowed = (borrow handle: Handle): Text uses Files.read => Files.read(handle)
export const load = (): Text uses Files.open | Files.read | Files.close =>
  withResource(() => Files.open(), (handle) => readBorrowed(handle), (handle) => Files.close(handle))
`,
  };
  const checked = checkProject(memoryHost(files), "", ["main.eff"]);
  assert(checked.ok);
  assertEquals(checked.value.diagnostics.map((d) => d.code), []);
  const result = lowerProject(checked.value).get("main");
  assert(result?.ok === true);
  const sources = new Map([["main.eff", files["main.eff"]], [
    "host.effi",
    files["host.effi"],
  ]]);
  assertEquals(validateModule(result.value, sources), []);
  const wrong = copy(result.value);
  const service = wrong.imports[0].services.find((s) => s.name === "Files");
  assert(service !== undefined);
  const read = service.methods.find((m) => m.name === "read");
  assert(read?.borrows?.[0] === true);
  setAt(wrong, "imports[0].services[0].methods[1].borrows[0]", false);
  assert(codesOf(wrong, sources).includes("validation/006"));
});

Deno.test("array and contextual tuple literals validate with ordered element effects", () => {
  const { ir, sources } = lowerText(
    [
      "service S { read(): Int }",
      "const inferred = [1, 2]",
      "export const numbers = (): Int[] => inferred",
      'export const pair = (): [Int, Text] => [1, "a"]',
      "export const blank = (): Int[] => []",
      "export const nested = (): Int[][] => [[1, 2], [3]]",
      "export const loaded = (): Int[] uses S.read => [S.read(), 2]",
      "type Int = int",
      "type Text = string",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const pair = ir.declarations[decl(ir, "pair")];
  assert(pair.kind === "function" && pair.body.kind === "tuple");
  assertEquals(pair.body.elements.length, 2);
  const source = sources.get("m.eff");
  assert(source !== undefined);
  assertEquals(
    source.slice(pair.body.span.start, pair.body.span.end),
    '[1, "a"]',
  );
  const loaded = ir.declarations[decl(ir, "loaded")];
  assert(loaded.kind === "function" && loaded.body.kind === "array");
  assertEquals(loaded.body.elements[0].kind, "perform");
  assertEquals(loaded.body.effects.requirements, ["cap:m#S.read"]);
});

Deno.test("traverse validates callback effects in direct and pipeline calls", () => {
  const { ir, sources } = lowerText(
    [
      "service S {",
      "  all(): Int[]",
      "  step(n: Int): Int",
      "}",
      "export const direct = (xs: Int[]): Int[] uses S.step => traverse(xs, (n) => S.step(n))",
      "export const piped = (xs: Int[]): Int[] uses S.step => xs |> traverse((n) => S.step(n))",
      "export const loaded = (): Int[] uses S.all | S.step => S.all() |> traverse((n) => S.step(n))",
      "export const pure = (xs: Int[]): Int[] => traverse(xs, (n) => n + 1)",
      "type Int = int",
      "",
    ].join("\n"),
  );
  assertEquals(validateModule(ir, sources), []);
  const direct = ir.declarations[decl(ir, "direct")];
  assert(direct.kind === "function" && direct.body.kind === "call");
  assertEquals(direct.body.effects.requirements, ["cap:m#S.step"]);
  const wrong = copy(ir);
  setAt(
    wrong,
    `declarations[${decl(wrong, "direct")}].body.effects.requirements`,
    [],
  );
  assertEquals(codesOf(wrong, sources), ["validation/003"]);
});

Deno.test("a provider with acquisition failures validates with zero diagnostics", () => {
  const lowered = lowerFiles({
    "effective.json": JSON.stringify({
      host: {
        providers: { interface: "./host/providers.effi", module: "./live.ts" },
      },
    }),
    "host/providers.effi":
      'import { Db, Down } from "../db.eff"\nexport provider DbLive provides Db fails Down\n',
    "db.eff":
      "export error Down = { why: string }\nexport service Db { q(): Int fails Down }\ntype Int = int\n",
    "m.eff":
      'import { Db, Down } from "./db.eff"\nimport { DbLive } from "host:providers"\nexport const g = (): Int fails Down => provide(DbLive, () => Db.q())\nexport const h = (): Int fails Down => DbLive |> provide(() => Db.q())\ntype Int = int\n',
  }, ["db.eff", "m.eff"]);
  assertEquals(lowered.modules.size, 2);
  for (const [name, ir] of lowered.modules) {
    assertEquals(
      validateModule(ir, lowered.sources).map((d) => `${d.code} ${d.message}`),
      [],
      name,
    );
  }
});

Deno.test("a provider from a host module carries the service it provides", () => {
  // m imports only the provider L. The interface of host:p carries the
  // service S of s.eff, so the capability in the provider type resolves.
  const lowered = lowerFiles({
    "effective.json": JSON.stringify({
      host: { p: { interface: "./host/p.effi", module: "./live.ts" } },
    }),
    "host/p.effi":
      'import { S } from "../s.eff"\nexport provider L provides S\n',
    "s.eff": "export service S { f(): Int }\ntype Int = int\n",
    "m.eff":
      'import { L } from "host:p"\nexport const g = (): Int => provide(L, () => 1)\ntype Int = int\n',
  }, ["s.eff", "m.eff"]);
  const m = lowered.modules.get("m");
  assert(m !== undefined);
  assertEquals(
    validateModule(m, lowered.sources).map((d) => `${d.code} ${d.message}`),
    [],
  );
});

Deno.test("log.ir.json validates with the source text of log.eff under log.lft", () => {
  const ir: ModuleIR = JSON.parse(
    Deno.readTextFileSync(new URL("ir/example/log.ir.json", FIXTURES)),
  );
  const text = Deno.readTextFileSync(new URL("ir/example/log.eff", FIXTURES));
  assertEquals(
    validateModule(ir, new Map([["log.lft", text]])).map((d) =>
      `${d.code} ${d.message}`
    ),
    [],
  );
});

Deno.test("validateProject skips a module whose lowering gave an error value", () => {
  const checked = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  assert(checked.ok);
  const lowered = new Map(lowerProject(checked.value));
  lowered.set("log", {
    ok: false,
    error: { tag: "unknown-module", module: "log" },
  });
  const report = validateProject(checked.value.analysis.project, lowered);
  assertEquals(report.has("log"), false);
  assertEquals(report.get("main")?.length, 0);
});

// ------------------------------------------------------------------ mutation fixtures

Deno.test("the manifest lists at least eight mutation fixtures and every area", () => {
  const manifest = validationManifest();
  assert(manifest.length >= 8, `only ${manifest.length} fixtures`);
  for (
    const code of registeredCodes().filter((c) => c.startsWith("validation/"))
  ) {
    assert(manifest.some((f) => f.code === code), `no fixture for ${code}`);
  }
});

for (const fixture of validationManifest()) {
  Deno.test(`mutation fixture ${fixture.file} is rejected with ${fixture.code}`, () => {
    const ir: ModuleIR = JSON.parse(
      Deno.readTextFileSync(new URL(`validate/${fixture.file}`, FIXTURES)),
    );
    const sources = new Map<string, string>();
    for (const [id, path] of Object.entries(fixture.sources)) {
      sources.set(id, Deno.readTextFileSync(new URL(path, FIXTURES)));
    }
    const diagnostics = validateModule(ir, sources);
    assertEquals(
      [...new Set(diagnostics.map((d) => d.code))],
      [fixture.code],
      diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"),
    );
    assert(
      diagnostics.some((d) => d.message.startsWith(`${fixture.path}:`)),
      `no message starts with ${fixture.path}: ${
        diagnostics.map((d) => d.message).join("\n")
      }`,
    );
  });
}

Deno.test("the mutation fixtures on disk equal the regenerated fixtures", () => {
  const built = buildFixtures();
  const names = [...built.files.keys()].sort();
  const onDisk: string[] = [];
  for (const entry of Deno.readDirSync(new URL("validate/", FIXTURES))) {
    if (entry.isFile) onDisk.push(entry.name);
  }
  assertEquals(onDisk.sort(), names);
  for (const [name, text] of built.files) {
    assertEquals(
      Deno.readTextFileSync(new URL(`validate/${name}`, FIXTURES)),
      text,
      `${name} is stale; run deno task validate:update`,
    );
  }
});

// ------------------------------------------------------------------ identity

Deno.test("identity: an import binding must target an exported identity", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir) => setAt(ir, "imports[0].bindings[0].target", "value:users#nope"),
    ),
    ["validation/001"],
  );
});

Deno.test("identity: an import payload must declare each exported identity", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir) =>
        (at(ir, "imports[0].exports") as string[]).push("value:users#ghost"),
    ),
    ["validation/001"],
  );
});

Deno.test("identity: a named type must resolve", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) =>
      setAt(
        ir,
        `${base("brand")}.body.brand`,
        "type:forms#Nope",
      )),
    ["validation/001"],
  );
});

Deno.test("identity: two parameters of one function cannot share a local identity", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("mul");
      setAt(ir, `${f}.parameters[1].id`, at(ir, `${f}.parameters[0].id`));
    }),
    ["validation/001"],
  );
});

Deno.test("identity: a local is out of scope after its match arm", () => {
  const { ir, sources } = lowerText(
    "export const f = (o: Option<Int>, p: Int): Int => match o { Some(x) => x, None => p }\ntype Int = int",
  );
  const copyIr = copy(ir);
  const f = decl(copyIr, "f");
  const arms = `declarations[${f}].body.arms`;
  // The None arm now refers to the binding x of the Some arm.
  setAt(
    copyIr,
    `${arms}[1].body.target`,
    at(copyIr, `${arms}[0].pattern.binding.id`),
  );
  assert(codesOf(copyIr, sources).includes("validation/001"));
});

Deno.test("identity: a builtin may appear only as a callee", () => {
  const codes = mutated(EXAMPLES, "collections", (ir, base) => {
    const f = base("total");
    const id = at(ir, `${f}.body.result.callee.target`);
    // The accumulator argument becomes a reference to the builtin.
    setAt(ir, `${f}.body.result.arguments[1]`, {
      kind: "reference",
      target: id,
      type: at(ir, `${f}.body.result.callee.type`),
      execution: "pure",
      effects: NO_EFFECTS,
      span: at(ir, `${f}.body.result.arguments[1].span`),
    });
  });
  assert(codes.includes("validation/001"));
});

// ------------------------------------------------------------------ types

Deno.test("types: the result type of an operator is recomputed", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("mul")}.body.type`, {
          kind: "primitive",
          name: "number",
        }),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mul")}.body.operator`, "&&"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: two values of one numeric brand compare, add, and subtract", () => {
  const lowered = lowerText(`
type Count = Brand<int>
type Price = Brand<number>
const sum = (a: Count, b: Count): Count => a + b
const diff = (a: Price, b: Price): Price => a - b
const below = (a: Count, b: Count): Bool => a < b
type Int = int
type Num = number
type Text = string
type Bool = boolean
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const changed = copy(lowered.ir);
  const sum = changed.declarations.find((d) => d.name === "sum");
  assert(sum?.kind === "function" && sum.body.kind === "binary");
  setAt(sum, "body.type", INT);
  assertEquals(codesOf(changed, lowered.sources), ["validation/002"]);
});

Deno.test("types: a condition must be boolean", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("cond")}.body.condition`, {
          kind: "literal",
          value: 1,
          type: INT,
          execution: "pure",
          effects: NO_EFFECTS,
          span: at(ir, `${base("cond")}.body.condition.span`),
        }),
    ),
    ["validation/002"],
  );
});

Deno.test("types: both branches fit the recorded type of an if", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("cond")}.body.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a field read has the field type, wrapped in Option when optional", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("nick")}.body.type`, STRING),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("nick")}.body.field`, "missing"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a record update names a field of the base", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("prof")}.body.fields[0].name`, "bogus"),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a brand construction needs a brand and a value of its base", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("brand")}.body.brand`, "type:forms#Status"),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("brand");
      setAt(ir, `${f}.body.value`, {
        kind: "literal",
        value: 1,
        type: INT,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${f}.body.value.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: a pattern must belong to the subject", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("extent2")}.body.arms[0].pattern.value`, "triangle"),
    ),
    ["validation/002"],
  );
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("lookup");
      setAt(ir, `${f}.body.arms[1].pattern`, {
        kind: "literal",
        value: 1,
        span: at(ir, `${f}.body.arms[1].pattern.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: a call has the argument count and the argument types of its callee", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("hoist");
      const left = `${f}.body.left`;
      // Store.count() gets an extra argument.
      (at(ir, `${left}.arguments`) as unknown[]).push({
        kind: "literal",
        value: 1,
        type: INT,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${left}.span`),
      });
    }),
    ["validation/002"],
  );
});

Deno.test("types: fail has the type never", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mkEmpty")}.body.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a function parameter type equals its declared parameter type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("mul")}.type.parameters[0]`, STRING),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a recursive type is rejected", () => {
  const { ir, sources } = lowerText(
    "type A = { n: int }\nexport const f = (a: A): Int => a.n\ntype Int = int",
  );
  const copyIr = copy(ir);
  setAt(copyIr, "declarations[0].definition.type.fields[0].type", {
    kind: "named",
    id: "type:m#A",
  });
  assert(codesOf(copyIr, sources).includes("validation/002"));
});

Deno.test("types: a pattern binding has the element type of its subject", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("lookup")}.body.arms[0].pattern.binding.type`, INT),
    ),
    ["validation/002"],
  );
});

Deno.test("types: a block binding holds a value of its type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("blockF")}.body.steps[0].binding.type`, STRING),
    ),
    ["validation/002"],
  );
});

Deno.test("types: every arm of a match fits the recorded type", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("lit")}.body.type`, STRING),
    ),
    ["validation/002"],
  );
});

// ------------------------------------------------------------------ contracts

Deno.test("contracts: recorded sets equal the recomputed sets", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) => setAt(ir, `${base("hoist")}.body.effects.requirements`, []),
    ),
    ["validation/003"],
  );
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("hoist")}.body.effects.failures`, [
          "error:forms#Other",
        ]),
    ),
    ["validation/003"],
  );
});

Deno.test("contracts: provide removes the supplied capabilities", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "main",
      (ir, base) =>
        setAt(ir, `${base("main")}.body.effects.requirements`, [
          "cap:users#Users.find",
        ]),
    ),
    ["validation/003"],
  );
});

Deno.test("contracts: an inferred function records exactly its body sets", () => {
  const { ir, sources } = lowerText(
    "service S { go(): Int }\nconst inc = (x: Int) => x + S.go()\nexport const f = (x: Int): Int uses S.go => inc(x)\ntype Int = int",
  );
  assertEquals(codesOf(ir, sources), []);
  const copyIr = copy(ir);
  const f = decl(copyIr, "inc");
  assertEquals(at(copyIr, `declarations[${f}].contract`), "inferred");
  setAt(copyIr, `declarations[${f}].type.effects.requirements`, []);
  assert(codesOf(copyIr, sources).includes("validation/003"));
});

// ------------------------------------------------------------------ execution

Deno.test("execution: a closure type keeps the mode of its body", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(
          ir,
          `${base("mkBox")}.body.fields[0].value.type.execution`,
          "effect",
        ),
    ),
    ["validation/004"],
  );
});

Deno.test("execution: a builtin callback is pure", () => {
  const codes = mutated(FORMS, "forms", (ir, base) => {
    const f = base("fnArg");
    const closure = `${f}.body.steps[0].value`;
    void closure;
    const call = `${f}.body.result`;
    setAt(ir, `${call}.arguments[1].type.execution`, "effect");
  });
  assert(codes.includes("validation/004"), codes.join());
});

Deno.test("execution: a prelude callback with an effect mode is rejected", () => {
  const codes = mutated(
    EXAMPLES,
    "collections",
    (ir) =>
      setAt(ir, "imports[0].values[0].type.parameters[1].execution", "effect"),
  );
  assert(codes.includes("validation/004"), codes.join());
});

Deno.test("execution: constructing a closure is pure", () => {
  assertEquals(
    mutated(
      FORMS,
      "forms",
      (ir, base) =>
        setAt(ir, `${base("mkBox")}.body.fields[0].value.execution`, "effect"),
    ),
    ["validation/004"],
  );
});

// ------------------------------------------------------------------ recovery

Deno.test("recovery: a tag with two handlers is rejected", () => {
  assertEquals(
    mutated(FORMS, "forms", (ir, base) => {
      const f = base("lookup2");
      setAt(ir, `${f}.body.handlers[1].error`, "error:forms#NotFound");
      setAt(ir, `${f}.body.handlers[1].binding.type`, {
        kind: "named",
        id: "error:forms#NotFound",
      });
    }),
    ["validation/005"],
  );
});

Deno.test("recovery: handler results fit the recorded type of the catch", () => {
  const codes = mutated(
    FORMS,
    "forms",
    (ir, base) => setAt(ir, `${base("caught")}.body.type`, INT),
  );
  assert(codes.includes("validation/005"), codes.join());
});

// ------------------------------------------------------------------ control

Deno.test("control: a retry count is a finite nonnegative safe integer", () => {
  for (const times of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(
      mutated(
        FORMS,
        "forms",
        (ir, base) => setAt(ir, `${base("retried")}.body.times`, times),
      ),
      ["validation/006"],
      String(times),
    );
  }
});

Deno.test("control: the provider of provide has a provider type", () => {
  assertEquals(
    mutated(EXAMPLES, "main", (ir, base) => {
      const f = base("main");
      setAt(ir, `${f}.body.provider`, {
        kind: "literal",
        value: "UsersLive",
        type: STRING,
        execution: "pure",
        effects: NO_EFFECTS,
        span: at(ir, `${f}.body.provider.span`),
      });
    }),
    ["validation/006"],
  );
});

// ------------------------------------------------------------------ serialization

Deno.test("serialization: a duplicate in an effect set is rejected, and only once as a set problem", () => {
  assertEquals(
    mutated(
      EXAMPLES,
      "log",
      (ir, base) =>
        setAt(ir, `${base("log")}.body.effects.failures`, [
          "error:log#ConsoleUnavailable",
          "error:log#ConsoleUnavailable",
        ]),
    ),
    ["validation/008"],
  );
});

Deno.test("serialization: the source texts must be supplied", () => {
  const ir = EXAMPLES.modules.get("log");
  assert(ir !== undefined);
  assertEquals(codesOf(ir, new Map()), ["validation/008"]);
});

Deno.test("serialization: a span stops at the end of its text", () => {
  const ir = copy(EXAMPLES.modules.get("log"));
  const text = EXAMPLES.sources.get("log.eff") ?? "";
  const f = decl(ir, "log");
  setAt(ir, `declarations[${f}].body.span.end`, text.length);
  assertEquals(codesOf(ir, EXAMPLES.sources), []);
  setAt(ir, `declarations[${f}].body.span.end`, text.length + 1);
  assertEquals(codesOf(ir, EXAMPLES.sources), ["validation/008"]);
  setAt(ir, `declarations[${f}].body.span.start`, -1);
  assertEquals(codesOf(ir, EXAMPLES.sources), ["validation/008"]);
});

Deno.test("serialization: a literal must be finite", () => {
  const { ir, sources } = lowerText(
    "export const f = (): Int => 1\ntype Int = int",
  );
  const copyIr = copy(ir);
  const f = decl(copyIr, "f");
  setAt(copyIr, `declarations[${f}].body.value`, Number.POSITIVE_INFINITY);
  assert(codesOf(copyIr, sources).includes("validation/008"));
});

Deno.test("an IR with a wrong shape gives a diagnostic and not an exception", () => {
  const ir = copy(EXAMPLES.modules.get("log"));
  setAt(ir, `declarations[${decl(ir, "log")}].body.arguments`, null);
  assert(codesOf(ir, EXAMPLES.sources).includes("validation/008"));
});

Deno.test("a wrong shape in a declaration header or an import gives a diagnostic", () => {
  const nullDeclaration = copy(EXAMPLES.modules.get("log"));
  setAt(nullDeclaration, "declarations[0]", null);
  assertEquals(codesOf(nullDeclaration, EXAMPLES.sources), ["validation/008"]);
  const users = EXAMPLES.modules.get("users");
  const service = users?.declarations.findIndex((d) => d.kind === "service");
  assert(service !== undefined && service >= 0);
  const noMethods = copy(users);
  setAt(noMethods, `declarations[${service}].methods`, undefined);
  assertEquals(codesOf(noMethods, EXAMPLES.sources), ["validation/008"]);
});

// ------------------------------------------------------------------ type compatibility

const ENV: TypeEnv = {
  aliases: new Map<string, Type>([
    ["type:m#Alias", { kind: "primitive", name: "string" }],
    ["type:m#Status", {
      kind: "union",
      members: [
        { kind: "literal", value: "pending" },
        { kind: "literal", value: "paid" },
      ],
    }],
  ]),
  brands: new Map<string, Type>([["type:m#Id", STRING]]),
  errors: new Map<string, readonly Field[]>(),
};

function fn(
  execution: Execution,
  parameters: Type[],
  result: Type,
  failures: string[] = [],
): Type {
  return {
    kind: "function",
    execution,
    parameters,
    result,
    effects: {
      failures: failures as never[],
      requirements: [],
    },
  };
}

function lit(value: string | number | boolean): Type {
  return { kind: "literal", value };
}

const NUMBER: Type = { kind: "primitive", name: "number" };
const NEVER: Type = { kind: "primitive", name: "never" };
const UNKNOWN: Type = { kind: "primitive", name: "unknown" };

Deno.test("compatibility: primitives, literals, aliases, and brands", () => {
  assert(fits(ENV, INT, NUMBER));
  assert(!fits(ENV, NUMBER, INT));
  assert(fits(ENV, lit(1), INT));
  assert(!fits(ENV, lit(1.5), INT));
  assert(fits(ENV, lit(1.5), NUMBER));
  assert(fits(ENV, lit("a"), STRING));
  assert(!fits(ENV, lit("a"), INT));
  assert(fits(ENV, { kind: "named", id: "type:m#Alias" }, STRING));
  assert(fits(ENV, STRING, { kind: "named", id: "type:m#Alias" }));
  assert(fits(ENV, lit("paid"), { kind: "named", id: "type:m#Status" }));
  assert(!fits(ENV, lit("late"), { kind: "named", id: "type:m#Status" }));
  const id: Type = { kind: "named", id: "type:m#Id" };
  assert(fits(ENV, id, id));
  assert(!fits(ENV, STRING, id));
  assert(!fits(ENV, id, STRING));
});

Deno.test("compatibility: never fits everything and unknown is not a top type", () => {
  assert(fits(ENV, NEVER, INT));
  assert(fits(ENV, NEVER, UNKNOWN));
  assert(!fits(ENV, INT, UNKNOWN));
  assert(fits(ENV, UNKNOWN, UNKNOWN));
  assert(!fits(ENV, UNKNOWN, INT));
});

Deno.test("compatibility: records need equal field names and flags, in any order", () => {
  const rec = (...fields: [string, Type, boolean?][]): Type => ({
    kind: "record",
    fields: fields.map(([name, type, optional]) => ({
      name,
      type,
      optional: optional ?? false,
    })),
  });
  assert(
    fits(
      ENV,
      rec(["a", INT], ["b", STRING]),
      rec(["b", STRING], ["a", NUMBER]),
    ),
  );
  assert(!fits(ENV, rec(["a", INT], ["b", STRING]), rec(["a", INT])));
  assert(!fits(ENV, rec(["a", INT]), rec(["a", INT, true])));
  assert(!fits(ENV, rec(["a", INT]), rec(["b", INT])));
});

Deno.test("compatibility: arrays, options, tuples, and unions are covariant", () => {
  assert(
    fits(ENV, { kind: "array", element: INT }, {
      kind: "array",
      element: NUMBER,
    }),
  );
  assert(
    !fits(ENV, { kind: "array", element: NUMBER }, {
      kind: "array",
      element: INT,
    }),
  );
  assert(
    fits(ENV, { kind: "option", element: NEVER }, {
      kind: "option",
      element: INT,
    }),
  );
  assert(fits(
    ENV,
    { kind: "tuple", elements: [INT, lit("a")] },
    { kind: "tuple", elements: [NUMBER, STRING] },
  ));
  assert(
    !fits(
      ENV,
      { kind: "tuple", elements: [INT] },
      { kind: "tuple", elements: [INT, INT] },
    ),
  );
  const either: Type = { kind: "union", members: [INT, STRING] };
  assert(fits(ENV, INT, either));
  assert(
    fits(ENV, either, { kind: "union", members: [NUMBER, STRING, NEVER] }),
  );
  assert(!fits(ENV, either, INT));
});

Deno.test("compatibility: functions are contravariant in parameters and covariant in results", () => {
  assert(fits(ENV, fn("pure", [NUMBER], INT), fn("pure", [INT], NUMBER)));
  assert(!fits(ENV, fn("pure", [INT], INT), fn("pure", [NUMBER], INT)));
  assert(!fits(ENV, fn("pure", [], NUMBER), fn("pure", [], INT)));
  assert(!fits(ENV, fn("pure", [INT], INT), fn("pure", [], INT)));
});

Deno.test("compatibility: effect sets must be subsets", () => {
  assert(
    fits(ENV, fn("effect", [], INT), fn("effect", [], INT, ["error:m#E"])),
  );
  assert(
    !fits(ENV, fn("effect", [], INT, ["error:m#E"]), fn("effect", [], INT)),
  );
});

Deno.test("compatibility: the lift applies only at the top of a value position", () => {
  const pure = fn("pure", [INT], INT);
  const effect = fn("effect", [INT], INT);
  assert(fits(ENV, pure, effect), "top of a value");
  assert(!fits(ENV, effect, pure), "an effect function never fits a pure type");
  const arrayOf = (t: Type): Type => ({ kind: "array", element: t });
  assert(!fits(ENV, arrayOf(pure), arrayOf(effect)), "array element");
  const option = (t: Type): Type => ({ kind: "option", element: t });
  assert(!fits(ENV, option(pure), option(effect)), "option element");
  const record = (t: Type): Type => ({
    kind: "record",
    fields: [{ name: "run", type: t, optional: false }],
  });
  assert(!fits(ENV, record(pure), record(effect)), "record field");
  assert(
    !fits(ENV, fn("pure", [pure], INT), fn("pure", [effect], INT)),
    "a function parameter",
  );
  assert(
    !fits(ENV, fn("pure", [], pure), fn("pure", [], effect)),
    "a function result",
  );
  assert(
    !fits(ENV, { kind: "union", members: [pure] }, effect),
    "a union member",
  );
  assert(same(ENV, pure, pure));
  assert(!same(ENV, pure, effect));
});

Deno.test("a field read and a record update through a record brand validate", () => {
  const lowered = lowerText(`
type UserId = Brand<string>
type User = Brand<{ id: UserId, name: string, active: boolean, nickname?: string }>
const nameOf = (user: User): Text => user.name
const nick = (user: User): Text =>
  match user.nickname {
    Some(n) => n,
    None => "none"
  }
const activate = (user: User): User => ({ ...user, active: true })
type Text = string
`);
  assertEquals(codesOf(lowered.ir, lowered.sources), []);
  const mutated = copy(lowered.ir);
  const nameOf = mutated.declarations.find((d) => d.name === "nameOf");
  assert(nameOf?.kind === "function" && nameOf.body.kind === "get");
  setAt(nameOf, "body.field", "missing");
  assertEquals(codesOf(mutated, lowered.sources), ["validation/002"]);
});

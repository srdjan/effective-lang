import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { runStrictTarget } from "./target_helpers.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-constructor-recursive.eff", import.meta.url),
);

Deno.test("recursive constructors retain partial input, paths and cancellation across imports", async () => {
  const imported =
    `import { tree, Tree, TreeInput, Read, Write } from "./main.eff"
export const forest: Schema<Tree[], Tree[], Read.next, Write.previous, TreeInput[]> = schemaArray(tree)
export const root: Schema<{ root: Tree }, { root: Tree }, Read.next, Write.previous, { root?: TreeInput }> =
  schemaStruct({ root: schemaConstructorDefault(tree, (): TreeInput => ({})) })
`;
  const project = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": fixture,
      "imported.eff": imported,
    }),
    "",
    ["main.eff", "imported.eff"],
  );
  assert(project.ok, JSON.stringify(project));
  assertEquals(project.value.diagnostics, []);
  const lowered = lowerProject(project.value);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(
      project.value.analysis.project,
      lowered,
    ).values()
  ) assertEquals(diagnostics, []);
  await runStrictTarget(
    emitProject(lowered, { config: project.value.analysis.project.config }),
    `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, tree, node, choice, waiting, makeTree, makeNode, makeChoice, readTree, writeTree } from "./main.ts";
import { forest, root } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const input: typeof tree["~type.make.in"] = { children: [{}, { score: 8, children: [{}] }] };
const expected = { score: 4, children: [{ score: 4, children: [] }, { score: 8, children: [{ score: 4, children: [] }] }] };
const make: Effect.Effect<typeof tree.Type, SchemaIssue.Issue> = makeTree(input);
expect(await Effect.runPromise(make), expected);
expect(await Effect.runPromise(makeTree({})), { score: 4, children: [] });
expect(await Effect.runPromise(makeTree(input)), expected);
expect(await Effect.runPromise(forest.makeEffect([{}, { children: [{}] }])), [{ score: 4, children: [] }, { score: 4, children: [{ score: 4, children: [] }] }]);
expect(await Effect.runPromise(root.makeEffect({})), { root: { score: 4, children: [] } });
expect(await Effect.runPromise(makeNode({ next: { next: {} } })), { score: 4, next: { score: 4, next: { score: 4 } } });
expect(await Effect.runPromise(makeChoice({ kind: "more", next: { kind: "more" } })), { kind: "more", next: { kind: "more", next: { kind: "end" } } });
// @ts-expect-error Nested decoded records still require complete fields.
const invalidD: typeof tree.Type = { score: 4, children: [{}] };
// @ts-expect-error Wire data has the same complete shape as D.
const invalidE: typeof tree.Encoded = { score: 4, children: [{}] };
// @ts-expect-error Recursive M retains the integer field type.
const invalidM: typeof tree["~type.make.in"] = { children: [{ score: "4" }] };
// @ts-expect-error Tagged make input still requires a terminal discriminator.
const invalidTag: Parameters<typeof makeChoice>[0] = { kind: "more", next: {} };
void invalidD; void invalidE; void invalidM; void invalidTag; void node; void choice;
let defaults = 0;
const fresh = waiting(Effect.sync(() => ++defaults));
expect(defaults, 0);
expect(await Effect.runPromise(fresh.makeEffect({ children: [{}, { children: [{}] }] })), { score: 1, children: [{ score: 2, children: [] }, { score: 3, children: [{ score: 4, children: [] }] }] });
expect(await Effect.runPromise(fresh.makeEffect({})), { score: 5, children: [] });
const calls: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => { calls.push("read:" + value); return value + 1; }) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => { calls.push("write:" + value); return value - 1; }) });
const wire = { score: 1, children: [{ score: 2, children: [] }] };
const decoded = await Effect.runPromise(readTree(wire).pipe(Effect.provide(read)));
expect(decoded, { score: 2, children: [{ score: 3, children: [] }] });
expect(await Effect.runPromise(writeTree(decoded).pipe(Effect.provide(write))), wire);
expect(calls, ["read:1", "read:2", "write:2", "write:3"]);
const missing = await Effect.runPromiseExit(readTree({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing) || !(Option.getOrUndefined(Cause.findErrorOption(missing.cause)) instanceof Schema.SchemaError)) throw new Error("wire decoding applied constructor defaults");
for (const schema of [tree, waiting(Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" })))]) {
  const effect = schema === tree ? schema.makeEffect({ score: 1, children: [{ score: 0.5 }] }) : schema.makeEffect({ score: 1, children: [{}] });
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("nested constructor failure lost");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!SchemaIssue.isIssue(issue)) throw new Error("constructor changed failure channel");
  const message = SchemaIssue.makeFormatterDefault()(issue);
  if (!message.includes("children") || !message.includes("score") || !message.includes("0")) throw new Error("recursive path lost: " + message);
}
const defect = await Effect.runPromiseExit(waiting(Effect.die("blocked")).makeEffect({ children: [{}], score: 1 }));
if (!Exit.isFailure(defect) || !Cause.hasDies(defect.cause) || Option.isSome(Cause.findErrorOption(defect.cause))) throw new Error("constructor translated defect");
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const schema = waiting(pending);
  const fiber = yield* Effect.forkChild(schema.makeEffect({ score: 1, children: [{}] }));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("recursive default cleanup outlived interruption");
}));
`,
    "effective-constructor-recursive-",
  );
});

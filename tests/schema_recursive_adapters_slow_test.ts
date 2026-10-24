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
  new URL("../fixtures/emit/schema-recursive-adapters.eff", import.meta.url),
);

Deno.test("recursive field adapters preserve wire behavior, construction and cancellation across imports", async () => {
  const imported =
    `import { tree, Tree, WireTree, Input, Read, Write, Defaults, node, Node, WireNode, NodeInput, Text } from "./main.eff"
export const forest: Schema<Tree[],WireTree[],Read.parse | Defaults.children,Write.print,Input[]> = schemaArray(tree)
export const linkedNode: Schema<Node,WireNode,Read.parse,Write.print,NodeInput> = node
`;
  const incompatible = checkProject(
    memoryHost({
      "effektive.json": "{}",
      "main.eff": fixture,
      "imported.eff": imported + `
type OtherWire = { score: Text, next?: OtherWire | null }
const bad: Schema<Node,OtherWire,Read.parse,Write.print,NodeInput> = node`,
    }),
    "",
    ["imported.eff"],
  );
  assert(incompatible.ok);
  // The imported recursive alias keeps its identity: the other wire type fails.
  const [mismatch, ...others] = incompatible.value.diagnostics;
  assertEquals(others, []);
  assertEquals(mismatch?.code, "type-mismatch/003");
  assertEquals(mismatch?.span.source, "imported.eff");
  assert(
    mismatch?.message.includes(
      "but Schema<Node, OtherWire, Read.parse, Write.print, NodeInput> is expected",
    ),
    mismatch?.message,
  );
  const project = checkProject(
    memoryHost({
      "effektive.json": "{}",
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
import { tree, encoded, node, nullTree, bridge, requiredBridge, Read, Write, Defaults, makeTree, readTree, writeTree } from "./main.ts";
import { forest, linkedNode } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.sync(() => { calls.push("read:" + value); return Number(value); }) });
const write = Layer.succeed(Write)({ print: (value) => Effect.sync(() => { calls.push("write:" + value); return String(value); }) });
const defaults = Layer.succeed(Defaults)({ children: () => Effect.sync(() => { calls.push("default"); return []; }) });
const input: typeof tree["~type.make.in"] = { children: [{}, { children: [{}] }] };
const expected = { score: 4, children: [{ score: 4, children: [] }, { score: 4, children: [{ score: 4, children: [] }] }] };
for (const schema of [tree, encoded, nullTree(Effect.die("wire default must not run"))]) {
  const made: Effect.Effect<typeof tree.Type, SchemaIssue.Issue> = schema.makeEffect(input);
  expect(await Effect.runPromise(made), expected);
}
expect(await Effect.runPromise(makeTree({})), { score: 4, children: [] });
expect(await Effect.runPromise(forest.makeEffect([{}])), [{ score: 4, children: [] }]);
expect(await Effect.runPromise(node.makeEffect({ next: { next: {} } })), { score: 4, next: { score: 4, next: { score: 4 } } });
for (const schema of [bridge, requiredBridge]) {
  expect(await Effect.runPromise(schema.makeEffect({ children: [{}] })), { children: [{ children: [] }] });
}
expect(await Effect.runPromise(linkedNode.makeEffect({ next: {} })), { score: 4, next: { score: 4 } });
expect(calls, []);
const wire: typeof tree.Encoded = { score: "1", children: [{ score: "2" }] };
const decoded = { score: 1, children: [{ score: 2, children: [] }] };
expect(await Effect.runPromise(readTree(wire).pipe(Effect.provide(read), Effect.provide(defaults))), decoded);
expect(await Effect.runPromise(writeTree(decoded).pipe(Effect.provide(write))), { score: "1", children: [{ score: "2", children: [] }] });
expect(calls, ["read:1", "read:2", "default", "write:1", "write:2"]);
calls.length = 0;
expect(await Effect.runPromise(Schema.decodeUnknownEffect(encoded)(wire).pipe(Effect.provide(read))), decoded);
expect(await Effect.runPromise(Schema.encodeEffect(encoded)(decoded).pipe(Effect.provide(write))), { score: "1" });
expect(calls, ["read:1", "read:2", "write:1", "write:2"]);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(node)({ score: "1", next: { score: "2", next: null } }).pipe(Effect.provide(read))), { score: 1, next: { score: 2 } });
expect(await Effect.runPromise(Schema.encodeEffect(node)({ score: 1, next: { score: 2 } }).pipe(Effect.provide(write))), { score: "1", next: { score: "2" } });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(bridge)({ children: [{}] })), { children: [{}] });
expect(await Effect.runPromise(Schema.decodeUnknownEffect(requiredBridge)({ children: [] })), { children: [] });
if (!Exit.isFailure(await Effect.runPromiseExit(Schema.decodeUnknownEffect(requiredBridge)({})))) throw new Error("required wire guard lost");
// @ts-expect-error Decoded recursive children stay required.
const invalidD: typeof tree.Type = { score: 1, children: [{ score: 2 }] };
// @ts-expect-error Encoded recursive scores are strings.
const invalidE: typeof tree.Encoded = { score: "1", children: [{ score: 2 }] };
// @ts-expect-error Make retains numeric recursive scores.
const invalidM: typeof tree["~type.make.in"] = { children: [{ score: "2" }] };
void invalidD; void invalidE; void invalidM;
const badMake = await Effect.runPromiseExit(tree.makeEffect({ children: [{ score: 0.5 }] }));
if (!Exit.isFailure(badMake)) throw new Error("invalid nested make accepted");
const makeIssue = Option.getOrUndefined(Cause.findErrorOption(badMake.cause));
if (!SchemaIssue.isIssue(makeIssue) || !SchemaIssue.makeFormatterDefault()(makeIssue).includes("children")) throw new Error("make path lost");
const badWire = await Effect.runPromiseExit(readTree({ score: "1", children: [{ score: 2 }] }).pipe(Effect.provide(read), Effect.provide(defaults)));
if (!Exit.isFailure(badWire)) throw new Error("invalid wire score accepted");
const wireIssue = Option.getOrUndefined(Cause.findErrorOption(badWire.cause));
if (!(wireIssue instanceof Schema.SchemaError) || !wireIssue.message.includes("children") || !wireIssue.message.includes("score")) throw new Error("wire path lost");
let fresh = 0;
const nullable = nullTree(Effect.sync(() => { fresh++; return []; }));
const missing = { score: "1", children: [{ score: "2", children: null }] };
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullable)(missing).pipe(Effect.provide(read))), decoded);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(nullable)(missing).pipe(Effect.provide(read))), decoded);
expect(fresh, 2);
for (const pending of [Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked" })), Effect.die("defect")]) {
  const exit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(nullTree(pending))(missing).pipe(Effect.provide(read)));
  if (!Exit.isFailure(exit)) throw new Error("wire default failure lost");
  const issue = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!Cause.hasDies(exit.cause) && (!(issue instanceof Schema.SchemaError) || !issue.message.includes("children"))) throw new Error("default path lost");
}
await Effect.runPromise(Effect.gen(function*() {
  const entered = yield* Deferred.make<void>();
  let released = false;
  const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
  const fiber = yield* Effect.forkChild(Schema.decodeUnknownEffect(nullTree(pending))(missing).pipe(Effect.provide(read)));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  if (!released) throw new Error("recursive wire default cleanup outlived interruption");
}));
`,
    "effective-recursive-adapters-",
  );
});

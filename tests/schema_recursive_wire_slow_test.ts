import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-recursive-wire.eff", import.meta.url),
);

Deno.test("recursive wire shapes compile across imports with directional services and cleanup", async () => {
  const imported =
    `import { tree, Tree, WireTree, TreeInput, Read, Write } from "./main.eff"
export const forest: Schema<Tree[], WireTree[], Read.parse, Write.print, TreeInput[]> = schemaArray(tree)
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
  const dir = Deno.makeTempDirSync({ prefix: "effective-recursive-wire-" });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      }),
    );
    for (
      const result of emitProject(lowered, {
        config: project.value.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaIssue } from "effect";
import { Read, Write, tree, node, choice, makeTree, makeNode, makeChoice, readTree, writeTree, readNode, writeNode, readChoice, writeChoice } from "./main.ts";
import { forest } from "./imported.ts";
const expect = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
const calls: string[] = [];
const read = Layer.succeed(Read)({ parse: (value) => Effect.suspend(() => {
  calls.push("read:" + value);
  return value === "bad" ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked decode" })) : Effect.succeed(Number(value));
}) });
const write = Layer.succeed(Write)({ print: (value) => Effect.suspend(() => {
  calls.push("write:" + value);
  return value === 9 ? Effect.fail(new SchemaIssue.InvalidValue({ message: "blocked encode" })) : Effect.succeed(String(value));
}) });
const wire: typeof tree.Encoded = { score: "1", children: [{ score: "2", children: [] }] };
const decoded: typeof tree.Type = { score: 1, children: [{ score: 2, children: [] }] };
const decode: Effect.Effect<typeof tree.Type, Schema.SchemaError> = readTree(wire).pipe(Effect.provide(read));
const encode: Effect.Effect<typeof tree.Encoded, Schema.SchemaError> = writeTree(decoded).pipe(Effect.provide(write));
expect(calls, []);
expect(await Effect.runPromise(decode), decoded);
expect(await Effect.runPromise(encode), wire);
expect(await Effect.runPromise(decode), decoded);
expect(calls, ["read:1", "read:2", "write:1", "write:2", "read:1", "read:2"]);
const input: typeof tree["~type.make.in"] = { children: [{}] };
const make: Effect.Effect<typeof tree.Type, SchemaIssue.Issue> = makeTree(input);
expect(await Effect.runPromise(make), { score: 4, children: [{ score: 4, children: [] }] });
expect(await Effect.runPromise(forest.makeEffect([{}, { children: [{}] }])), [{ score: 4, children: [] }, { score: 4, children: [{ score: 4, children: [] }] }]);
expect(calls.length, 6);
expect(await Effect.runPromise(Schema.decodeUnknownEffect(forest)([wire]).pipe(Effect.provide(read))), [decoded]);
expect(await Effect.runPromise(Schema.encodeEffect(forest)([decoded]).pipe(Effect.provide(write))), [wire]);
expect(await Effect.runPromise(readNode({ next: {} }).pipe(Effect.provide(read))), { score: 8, next: { score: 8 } });
expect(await Effect.runPromise(writeNode({ score: 8, next: { score: 8 } }).pipe(Effect.provide(write))), { score: "8", next: { score: "8" } });
expect(await Effect.runPromise(makeNode({ score: 2, next: { score: 3 } })), { score: 2, next: { score: 3 } });
const wireChoice: typeof choice.Encoded = { kind: "more", score: "2", next: { kind: "more", score: "3", next: { kind: "end" } } };
const decodedChoice = await Effect.runPromise(readChoice(wireChoice).pipe(Effect.provide(read)));
expect(decodedChoice, { kind: "more", score: 2, next: { kind: "more", score: 3, next: { kind: "end" } } });
expect(await Effect.runPromise(writeChoice(decodedChoice).pipe(Effect.provide(write))), wireChoice);
expect(await Effect.runPromise(makeChoice({ kind: "more", next: { kind: "more" } })), { kind: "more", score: 4, next: { kind: "more", score: 4, next: { kind: "end" } } });
const missing = await Effect.runPromiseExit(readTree({}).pipe(Effect.provide(read)));
if (!Exit.isFailure(missing)) throw new Error("wire decode used constructor defaults");
const operations: ReadonlyArray<Effect.Effect<unknown, Schema.SchemaError>> = [
  readTree({ score: "1", children: [{ score: "bad", children: [] }] }).pipe(Effect.provide(read)),
  writeTree({ score: 1, children: [{ score: 9, children: [] }] }).pipe(Effect.provide(write)),
];
for (const operation of operations) {
  const exit = await Effect.runPromiseExit(operation);
  if (!Exit.isFailure(exit)) throw new Error("recursive wire failure lost");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("children") || !error.message.includes("score") || !error.message.includes("0")) throw new Error("wire issue path lost");
}
// @ts-expect-error Encoded self references keep string fields.
const wrongWire: typeof tree.Encoded = { score: "1", children: [{ score: 2, children: [] }] };
// @ts-expect-error Decoded self references keep numeric fields.
const wrongDecoded: Parameters<typeof writeTree>[0] = { score: 1, children: [{ score: "2", children: [] }] };
// @ts-expect-error Make input uses decoded types at every self reference.
const wrongMake: typeof tree["~type.make.in"] = { children: [{ score: "2" }] };
// @ts-expect-error Decoding defaults do not make constructor fields optional.
const wrongNode: Parameters<typeof makeNode>[0] = { next: {} };
void wrongWire; void wrongDecoded; void wrongMake; void wrongNode; void node;
for (const direction of ["read", "write"] as const) {
  const defect: Effect.Effect<unknown, Schema.SchemaError> = direction === "read" ? readTree(wire).pipe(Effect.provide(Layer.succeed(Read)({ parse: () => Effect.die("defect") }))) : writeTree(decoded).pipe(Effect.provide(Layer.succeed(Write)({ print: () => Effect.die("defect") })));
  const exit = await Effect.runPromiseExit(Effect.asVoid(defect));
  if (!Exit.isFailure(exit) || !Cause.hasDies(exit.cause) || Option.isSome(Cause.findErrorOption(exit.cause))) throw new Error("wire defect translated");
  await Effect.runPromise(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>();
    let released = false;
    const pending = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { released = true; })));
    const operation: Effect.Effect<unknown, Schema.SchemaError> = direction === "read" ? readTree(wire).pipe(Effect.provide(Layer.succeed(Read)({ parse: (value) => value === "2" ? pending : Effect.succeed(Number(value)) }))) : writeTree(decoded).pipe(Effect.provide(Layer.succeed(Write)({ print: (value) => value === 2 ? pending : Effect.succeed(String(value)) })));
    const fiber = yield* Effect.forkChild(Effect.asVoid(operation));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    if (!released) throw new Error("nested wire cleanup outlived interruption");
  }));
}
`,
    );
    for (const command of ["check", "run"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [command, "--no-lock", "run.ts"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stderr) +
          new TextDecoder().decode(result.stdout),
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

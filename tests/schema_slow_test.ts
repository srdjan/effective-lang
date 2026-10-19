import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
import { validateModule } from "../src/core/validate/index.ts";

const fixture = Deno.readTextFileSync(
  new URL("../fixtures/emit/schema-composition.eff", import.meta.url),
);

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

/**
 * Emits the source, checks the strict target, runs `run.ts` against it, and
 * returns the JSON that `run.ts` prints. The source must have no diagnostics.
 */
async function compileAndRun(source: string, run: string): Promise<unknown> {
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-identity-" });
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
        config: project.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(`${dir}/run.ts`, run);
    const decoder = new TextDecoder();
    let stdout = "";
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
        decoder.decode(result.stderr) + decoder.decode(result.stdout),
      );
      stdout = decoder.decode(result.stdout);
    }
    return JSON.parse(stdout);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("schema composition and guarded recursion compile and run with separate services", async () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-schema-source-" });
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
        config: project.analysis.project.config,
      }).values()
    ) {
      assert(result.ok, JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { Read, Write, readErrorMessage, readOrDefault, readTree, tree, writeTree } from "./main.ts";

const events: string[] = [];
const read = Layer.succeed(Read)({ next: (value) => Effect.sync(() => {
  events.push("read:" + value);
  return value === 9 ? Option.none() : Option.some(value + 1);
}) });
const write = Layer.succeed(Write)({ previous: (value) => Effect.sync(() => {
  events.push("write:" + value);
  return Option.some(value - 1);
}) });
if (events.length !== 0 || tree === undefined) throw new Error("eager Schema construction");
const input = { value: 1, children: [{ value: 2, children: [] }] };
const decoded = await Effect.runPromise(readTree(input).pipe(Effect.provide(read)));
if (JSON.stringify(decoded) !== JSON.stringify({ value: 2, children: [{ value: 3, children: [] }] })) throw new Error("nested decode");
const encoded = await Effect.runPromise(writeTree(decoded).pipe(Effect.provide(write)));
if (JSON.stringify(encoded) !== JSON.stringify(input)) throw new Error("nested encode");
await Effect.runPromise(readTree(input).pipe(Effect.provide(read)));
if (events.join(",") !== "read:1,read:2,write:2,write:3,read:1,read:2") throw new Error("service direction or replay");
for (const bad of [
  { value: 1, children: [{ value: "bad", children: [] }] },
  { value: 1, children: [{ value: 9, children: [] }] },
]) {
  const exit = await Effect.runPromiseExit(readTree(bad).pipe(Effect.provide(read)));
  if (!Exit.isFailure(exit)) throw new Error("expected SchemaError");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof Schema.SchemaError) || !error.message.includes("children")) throw new Error("lost nested issue");
}
const recovered = await Effect.runPromise(readOrDefault({ value: "bad", children: [] }).pipe(Effect.provide(read)));
if (JSON.stringify(recovered) !== JSON.stringify({ value: 0, children: [] })) throw new Error("SchemaError catch");
const message = await Effect.runPromise(readErrorMessage({ value: 1, children: [{ value: "bad", children: [] }] }).pipe(Effect.provide(read)));
if (!message.includes("children")) throw new Error("SchemaError message");
const defect = Layer.succeed(Read)({ next: () => Effect.die("defect") });
const died = await Effect.runPromiseExit(readTree(input).pipe(Effect.provide(defect)));
if (!Exit.isFailure(died) || !Cause.hasDies(died.cause) || Option.isSome(Cause.findErrorOption(died.cause))) throw new Error("defect translated");
const blocked = Layer.succeed(Read)({ next: () => Effect.never });
const fiber = Effect.runFork(readTree(input).pipe(Effect.provide(blocked)));
await Effect.runPromise(Fiber.interrupt(fiber));
const interrupted = await Effect.runPromise(Fiber.await(fiber));
if (!Exit.isFailure(interrupted) || !Cause.hasInterrupts(interrupted.cause)) throw new Error("interruption translated");
`,
    );
    for (
      const args of [["check", "--no-lock", "run.ts"], [
        "run",
        "--no-lock",
        "run.ts",
      ]]
    ) {
      const result = await new Deno.Command(Deno.execPath(), {
        args,
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

Deno.test("schema callbacks, encode input, and unguarded recursion are rejected", () => {
  const prefix = `type Int = int
type Flag = boolean
type Tree = { value: Int, children: Tree[] }
service Read { next(value: Int): Option<Int> }
service Write { previous(value: Int): Option<Int> }
const integer: Schema<Int> = schema()
`;
  const cases = [
    ["type Loop = Loop", "declaration/007"],
    ["type Loop = { next: Loop }", "declaration/007"],
    ["type A = { children: B[] }\ntype B = A", "declaration/007"],
    ["type Fn = () => Int\ntype Invalid = Schema<Fn>", "type-mismatch/010"],
    [
      "const bad = schemaTransform(integer, integer, (n: Int): Option<Flag> => Some(true), (n: Int): Option<Int> => Some(n))",
      "type-mismatch/003",
    ],
    [
      "const bad: Schema<Tree> = schemaRecursive((self: Schema<Tree>): Schema<Tree> => self)",
      "type-mismatch/010",
    ],
    [
      "const bad: Schema<Tree> = schemaRecursive((self: Schema<Tree>): Schema<Tree> => schemaStruct({ value: integer, children: self }))",
      "type-mismatch/010",
    ],
    [
      'const bad = schemaTransform(integer, integer, (n: Int): Option<Int> fails SchemaError => fail(SchemaError({ message: "x" })), (n: Int): Option<Int> => Some(n))',
      "type-mismatch/010",
    ],
    [
      'const bad: Schema<Int> = schema()\nconst wrong = schemaEncode(bad, "text")',
      "type-mismatch/003",
    ],
  ] as const;
  for (const [source, code] of cases) {
    const diagnostics = checked(`${prefix}\n${source}`).diagnostics;
    assert(
      diagnostics.some((diagnostic) => diagnostic.code === code),
      `${source}: ${JSON.stringify(diagnostics)}`,
    );
  }
  const deferred = checked(
    `type Fn = () => int\ntype Tree = { callback: Fn, children: Tree[] }`,
  );
  assert(
    deferred.diagnostics.some((diagnostic) =>
      diagnostic.code === "declaration/007"
    ),
  );
  assertEquals(
    checked(
      "type Int = int\nconst schema = (value: Int): Int => value\nconst result: Int = schema(1)",
    ).diagnostics,
    [],
  );
});

Deno.test("independent validation rejects forged schema channels and self use", () => {
  const project = checked(fixture);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  const result = [...lowered.values()][0];
  assert(result.ok, JSON.stringify(result));
  const sources = new Map([["main.eff", fixture]]);
  const channel = structuredClone(result.value);
  const shifted = channel.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "shifted"
  );
  assert(shifted?.kind === "constant");
  assert(shifted.value.type.kind === "schema");
  Object.assign(shifted.value.type, { decodeRequirements: [] });
  assert(
    validateModule(channel, sources).some((diagnostic) =>
      diagnostic.message.includes("type") ||
      diagnostic.message.includes("requirement")
    ),
  );

  const immediate = structuredClone(result.value);
  const tree = immediate.declarations.find((declaration) =>
    declaration.kind === "constant" && declaration.name === "tree"
  );
  assert(tree?.kind === "constant" && tree.value.kind === "schema");
  const callback = tree.value.arguments[0];
  assert(callback?.kind === "closure" && callback.body.kind === "schema");
  const record = callback.body.arguments[0];
  assert(record?.kind === "record");
  const children = record.fields.find((field) => field.name === "children");
  assert(children !== undefined);
  Object.assign(children, {
    value: {
      kind: "reference",
      target: callback.parameters[0].id,
      type: callback.parameters[0].type,
      execution: "pure",
      effects: { failures: [], requirements: [] },
      span: children.value.span,
    },
  });
  assert(
    validateModule(immediate, sources).some((diagnostic) =>
      diagnostic.message.includes("schemaRecursive needs")
    ),
  );
});

const identitySource = `type Int = int
export type UserId = Brand<string>
export error Stop = { reason: string }
export type Wrapper = { stop: Stop, id: UserId }
export type Tree =
  { tag: "branch", id: UserId, ids: UserId[], note?: UserId, kids: Tree[] } |
  { tag: "leaf", id: UserId }
export type Node = { error: Stop, kids: Node[] }

export const userId: Schema<UserId> = schema()
export const stop: Schema<Stop> = schema()
export const wrapper: Schema<Wrapper> = schema()
export const tree: Schema<Tree> = schema()
export const node: Schema<Node> = schema()
export const nodeCodec: Codec<Node, Node> = codec(
  (value: Node): Node => value,
  (value: Node): Node => value
)

export const readUserId = (input: unknown): UserId fails SchemaError => schemaDecode(userId, input)
export const writeUserId = (value: UserId): UserId fails SchemaError => schemaEncode(userId, value)
export const readStop = (input: unknown): Stop fails SchemaError => schemaDecode(stop, input)
export const writeStop = (value: Stop): Stop fails SchemaError => schemaEncode(stop, value)
export const readWrapper = (input: unknown): Wrapper fails SchemaError => schemaDecode(wrapper, input)
export const readTree = (input: unknown): Tree fails SchemaError => schemaDecode(tree, input)
export const writeTree = (value: Tree): Tree fails SchemaError => schemaEncode(tree, value)
export const readNode = (input: unknown): Node fails SchemaError => schemaDecode(node, input)
`;

Deno.test("identity Schemas over brands, errors, and recursive aliases pass strict checking and roundtrip", async () => {
  const output = await compileAndRun(
    identitySource,
    `import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  nodeCodec, readNode, readStop, readTree, readUserId, readWrapper, Stop,
  writeStop, writeTree, writeUserId,
} from "./main.ts";
const run = <A>(effect: Effect.Effect<A, Schema.SchemaError>) => Effect.runPromiseExit(effect);
const failed = (exit: Exit.Exit<unknown, Schema.SchemaError>) =>
  Exit.isFailure(exit) && Cause.findErrorOption(exit.cause).pipe(Option.exists((e) => e instanceof Schema.SchemaError));

const brand = await run(readUserId("u1"));
const brandBad = await run(readUserId(1));
const brandWrite = Exit.isSuccess(brand) ? await Effect.runPromise(writeUserId(brand.value)) : undefined;

const instance = new Stop({ reason: "x" });
const stopRead = await run(readStop(instance));
const stopWire = await run(readStop({ _tag: "main#Stop", reason: "x" }));
const stopWrite = await Effect.runPromise(writeStop(instance));
const wrapped = await run(readWrapper({ stop: instance, id: "w" }));
const wrappedWire = await run(readWrapper({ stop: { _tag: "main#Stop", reason: "x" }, id: "w" }));

const sample: unknown = {
  tag: "branch", id: "a", ids: ["b", "c"], note: "d",
  kids: [{ tag: "leaf", id: "e" }, { tag: "branch", id: "f", ids: [], kids: [] }],
};
const treeRead = await run(readTree(sample));
const treeBad = await run(readTree({ tag: "leaf", id: 1 }));
const treeBadElement = await run(readTree({ tag: "branch", id: "a", ids: ["b", 2], kids: [] }));
const treeBadOptional = await run(readTree({ tag: "branch", id: "a", ids: [], note: 3, kids: [] }));
const treeWritten = Exit.isSuccess(treeRead) ? await Effect.runPromise(writeTree(treeRead.value)) : undefined;

const nodeRead = await run(readNode({ error: instance, kids: [{ error: instance, kids: [] }] }));
const nodeWire = await run(readNode({ error: { _tag: "main#Stop", reason: "x" }, kids: [] }));
const codecWire = nodeCodec.decode({ error: { _tag: "main#Stop", reason: "x" }, kids: [{ error: { _tag: "main#Stop", reason: "y" }, kids: [] }] });

console.log(JSON.stringify({
  brand: Exit.isSuccess(brand) ? brand.value : "failure",
  brandBad: failed(brandBad),
  brandWrite,
  stopRead: Exit.isSuccess(stopRead) && stopRead.value === instance,
  stopWire: failed(stopWire),
  stopWrite: stopWrite === instance,
  wrapped: Exit.isSuccess(wrapped) && wrapped.value.stop === instance && wrapped.value.id === "w",
  wrappedWire: failed(wrappedWire),
  treeRead: Exit.isSuccess(treeRead) ? JSON.stringify(treeRead.value) === JSON.stringify(sample) : false,
  treeBad: failed(treeBad),
  treeBadElement: failed(treeBadElement),
  treeBadOptional: failed(treeBadOptional),
  treeWritten: JSON.stringify(treeWritten) === JSON.stringify(sample),
  nodeRead: Exit.isSuccess(nodeRead) && nodeRead.value.kids[0]?.error === instance,
  nodeWire: failed(nodeWire),
  codecWire: Option.isSome(codecWire),
}));
`,
  );
  assertEquals(output, {
    brand: "u1",
    brandBad: true,
    brandWrite: "u1",
    stopRead: true,
    stopWire: true,
    stopWrite: true,
    wrapped: true,
    wrappedWire: true,
    treeRead: true,
    treeBad: true,
    treeBadElement: true,
    treeBadOptional: true,
    treeWritten: true,
    nodeRead: true,
    nodeWire: true,
    codecWire: true,
  });
});

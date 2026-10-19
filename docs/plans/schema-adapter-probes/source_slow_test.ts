// deno test --no-lock --allow-all docs/plans/schema-adapter-probes/source_slow_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../../../src/core/mod.ts";

const files = Object.fromEntries(
  ["effective.json", "contracts.eff", "host.effi", "main.eff"].map((
    name,
  ) => [name, Deno.readTextFileSync(new URL(name, import.meta.url))]),
);

function checked(source: Record<string, string>, entry = "main.eff") {
  const result = checkProject(memoryHost(source), "", [entry]);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("Schema and guarded recursion are accepted while unsupported forms retain diagnostics", () => {
  const probes = {
    effectfulCodec: `type Int = int
service Lookup { read(value: Int): Int }
const bad = codec((value: Int): Int uses Lookup.read => Lookup.read(value), (value: Int): Int => value)`,
    recursive: `type Tree = { value: int, children: Tree[] }`,
    schemaObject: `type Int = int
type Full = Schema<Int>`,
    unguarded: `type Loop = { next: Loop }`,
    packageImport: `import { make } from "effect/http-api/HttpApi"
const api = make("audit")`,
  };
  for (const [name, text] of Object.entries(probes)) {
    const project = checked({ "effective.json": "{}", "main.eff": text });
    const diagnostics = project.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
    }));
    console.log(name, JSON.stringify(diagnostics));
    if (name === "recursive" || name === "schemaObject") {
      assertEquals(diagnostics, []);
      continue;
    }
    assert(diagnostics.length > 0);
    assert(
      diagnostics.some((d) =>
        name === "effectfulCodec"
          ? d.code === "execution-mode/001"
          : name === "packageImport"
          ? d.code.startsWith("module/")
          : d.code === "declaration/007"
      ),
    );
  }

  const missingRequirement = checked({
    ...files,
    "main.eff": files["main.eff"].replaceAll(" uses Policy.allow", ""),
  });
  assert(
    missingRequirement.diagnostics.some((d) =>
      d.code === "requirement-contract/001"
    ),
  );
  console.log(
    "provider requirement",
    JSON.stringify(
      missingRequirement.diagnostics.map((d) => ({
        code: d.code,
        message: d.message,
      })),
    ),
  );
  const escaped = checked({
    ...files,
    "main.eff": `
import { CursorLive, Cursor } from "host:adapter"
import { Int, AdapterError } from "./contracts.eff"
type Later = () => Int fails AdapterError uses Cursor.push
export const escape = (): Later => provide(CursorLive, () =>
  withResource(() => Cursor.open(), (session) => () => Cursor.push(session, ""), (session) => Cursor.close(session)))
`,
  });
  assert(escaped.diagnostics.some((d) => d.message.includes("data only")));
  assert(escaped.diagnostics.some((d) => d.message.includes("borrow")));
  console.log(
    "session escape",
    JSON.stringify(
      escaped.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    ),
  );

  const hostConst = checked({
    "effective.json": "{}",
    "test.effi": "export const schema = 1",
  }, "test.effi");
  assert(hostConst.diagnostics.some((d) => d.code === "syntax/012"));
});

Deno.test("typed adapters run real package APIs locally and retain failure, requirement and lifetime contracts", () => {
  const project = checked(files);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
  const dir = Deno.makeTempDirSync({
    prefix: "effective-schema-adapter-audit-",
  });
  const decoder = new TextDecoder();
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
    Deno.copyFileSync(
      new URL("adapter.ts", import.meta.url),
      `${dir}/adapter.ts`,
    );
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { AdapterError, Policy } from "./contracts.ts";
import { ai, cursor, cursorChunks, decodeLookup, http, metric, rpc, sql, tree } from "./main.ts";
import * as adapter from "./adapter.ts";
const allowed = Layer.succeed(Policy)({ allow: () => Effect.void });
const denied = Layer.succeed(Policy)({ allow: () => Effect.fail(new AdapterError({ operation: "policy" })) });
const run = <A>(job: Effect.Effect<A, AdapterError, Policy>) => Effect.runPromise(job.pipe(Effect.provide(allowed)));
const failure = <A>(name: string, job: Effect.Effect<A, AdapterError, Policy>) => Effect.runPromise(Effect.exit(job).pipe(Effect.provide(allowed), Effect.map((exit) => {
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure: " + name);
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (!(error instanceof AdapterError)) throw new Error("lost AdapterError");
  return error.operation;
})));
const decoded = await run(decodeLookup(7));
const invalid = await failure("decode", decodeLookup("bad"));
const lookupFailure = await failure("lookup", decodeLookup(-1));
const treeCount = await run(tree('{"value":1,"children":[{"value":2,"children":[]}]}'));
const treeFailure = await failure("tree", tree('{"value":1,"children":[{"value":"bad","children":[]}]}'));
const httpValue = await run(http('{"n":7}'));
const httpFailure = await failure("http", http('{"n":"bad"}'));
const sqlValue = await run(sql("ok"));
const sqlSuccess = adapter.sqlTrace.splice(0);
const sqlFailure = await failure("sql", sql("fail"));
const sqlFailed = adapter.sqlTrace.splice(0);
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(sql("wait").pipe(Effect.provide(allowed)));
  yield* Deferred.await(adapter.sqlReady);
  yield* Fiber.interrupt(fiber);
}).pipe(Effect.timeout("5 seconds")));
const sqlInterrupted = adapter.sqlTrace.splice(0);
const rpcValue = await run(rpc('{"n":7}\\n'));
const rpcFailure = await failure("rpc", rpc('{"n":"bad"}\\n'));
const aiValue = await run(ai("hello"));
const metrics = [await run(metric()), await run(metric())];
const cursorValue = await Effect.runPromise(cursorChunks('{"n":', '7}\\n'));
const malformedFrames = await Effect.runPromise(cursor('bad\\n'));
const cursorFailure = await failure("cursor", cursor("x".repeat(65)));
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(cursor("wait"));
  yield* Deferred.await(adapter.cursorReady);
  yield* Fiber.interrupt(fiber);
}).pipe(Effect.timeout("5 seconds")));
const refused = await Effect.runPromiseExit(http('{"n":7}').pipe(Effect.provide(denied)));
if (Exit.isSuccess(refused)) throw new Error("provider dependency was ignored");
const policyFailure = Option.getOrUndefined(Cause.findErrorOption(refused.cause));
console.log(JSON.stringify({ decoded, invalid, lookupFailure, lookups: adapter.lookups, treeCount, treeFailure,
  httpValue, httpFailure, sqlValue, sqlFailure, sqlSuccess, sqlFailed, sqlInterrupted,
  sqlParameters: adapter.sqlParameters.filter((values) => values.length > 0),
  rpcValue, rpcFailure, aiValue, metrics, cursorValue, malformedFrames, cursorFailure, cursorCloses: adapter.cursorCloses,
  api: adapter.api.identifier, rpc: adapter.procedure._tag,
  policyFailure: policyFailure instanceof AdapterError ? policyFailure.operation : "lost",
}));
`,
    );
    const invoke = (command: string) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          command,
          "--no-lock",
          "--config",
          `${dir}/deno.json`,
          `${dir}/run.ts`,
        ],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
    const typecheck = invoke("check");
    assert(typecheck.success, decoder.decode(typecheck.stderr));
    const runtime = invoke("run");
    assert(runtime.success, decoder.decode(runtime.stderr));
    assertEquals(JSON.parse(decoder.decode(runtime.stdout)), {
      decoded: 17,
      invalid: "decode",
      lookupFailure: "lookup",
      lookups: 2,
      treeCount: 2,
      treeFailure: "tree",
      httpValue: 7,
      httpFailure: "http",
      sqlValue: 7,
      sqlFailure: "sql",
      sqlSuccess: ["lease", "BEGIN", "select ? as n", "COMMIT", "release"],
      sqlFailed: ["lease", "BEGIN", "select ? as n", "ROLLBACK", "release"],
      sqlInterrupted: [
        "lease",
        "BEGIN",
        "select ? as n",
        "ROLLBACK",
        "release",
      ],
      sqlParameters: [[7], [7], [7]],
      rpcValue: 8,
      rpcFailure: "rpc",
      aiValue: "local model",
      metrics: [1, 2],
      cursorValue: 1,
      malformedFrames: 0,
      cursorFailure: "cursor",
      cursorCloses: 4,
      api: "audit",
      rpc: "increment",
      policyFailure: "policy",
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// Compiler probes, including strict checking and execution of emitted source:
// deno test --no-lock --allow-all docs/plans/scope-probes/source_slow_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../../../src/core/mod.ts";

function checked(source: string) {
  const result = checkProject(
    memoryHost({
      "effective.json": "{}",
      "main.eff": source,
    }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("raw scope spelling and escaping close authorities remain rejected", () => {
  const probes = {
    raw: `export const open = (): Scope => makeScope()`,
    unscoped: `export const open = (): void => forkScoped(defer(() => 1))`,
    resource: `
service Files { open(): { close: () => void } }
type Close = () => void
export const open = (): Close uses Files.open =>
  withResource(() => Files.open(), (file) => () => file.close(), (file) => file.close())
`,
    fiber: `type Close = () => void
export const open = (): Close =>
  withFiber(defer(() => 1), (fiber) => () => interruptFiber(fiber))`,
  };
  for (const [name, source] of Object.entries(probes)) {
    const diagnostics = checked(source).diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
    }));
    console.log(name, JSON.stringify(diagnostics));
    assert(diagnostics.length > 0);
    assert(
      diagnostics.some((d) =>
        name === "raw"
          ? d.code === "unknown-name/001"
          : name === "unscoped"
          ? d.code === "requirement-contract/001"
          : d.message.includes("data only")
      ),
    );
  }
});

Deno.test("lexical source matches explicit close at the block boundary", () => {
  const source = Deno.readTextFileSync(new URL("lexical.eff", import.meta.url));
  const project = checked(source);
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) {
    assertEquals(diagnostics, []);
  }
  const result = emitProject(lowered, {
    config: project.analysis.project.config,
  }).get("main");
  assert(result?.ok, JSON.stringify(result));
  const dir = Deno.makeTempDirSync({ prefix: "effective-scope-audit-" });
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
      }),
    );
    Deno.writeTextFileSync(`${dir}/main.ts`, result.value.text);
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `
import { Deferred, Effect, Layer } from "effect";
import { Child, Trace, main } from "./main.ts";
const events: string[] = [];
const ready = Deferred.makeUnsafe<void>();
const child = Layer.succeed(Child)({
  run: () => Effect.acquireUseRelease(
    Effect.sync(() => { events.push("start"); }),
    () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
    () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { events.push("release"); }))),
  ),
  wait: () => Deferred.await(ready),
});
const trace = Layer.succeed(Trace)({
  record: (value: string) => Effect.sync(() => { events.push(value); }),
});
await Effect.runPromise(main().pipe(Effect.provide(Layer.merge(child, trace)), Effect.timeout("5 seconds")));
console.log(JSON.stringify(events));
`,
    );
    const typecheck = new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        `${dir}/run.ts`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assert(typecheck.success, new TextDecoder().decode(typecheck.stderr));
    const run = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        `${dir}/run.ts`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assert(run.success, new TextDecoder().decode(run.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(run.stdout)), [
      "start",
      "body",
      "release",
      "closed",
    ]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

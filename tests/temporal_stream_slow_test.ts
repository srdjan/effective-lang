// A throttleStream "shape" window delays the next element instead of dropping
// it. The test compiles an Effective program, runs it under TestClock, and uses
// Deferred handshakes. No wall-clock time passes.

import { assertEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
} from "../src/core/mod.ts";
import { runScript } from "./process_helpers.ts";

const DENO_CONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
    imports: { effect: "npm:effect@4.0.5" },
  },
  null,
  2,
);

const SOURCE = [
  "type Int = int",
  "export service Source { next(n: Int): Option<[Int, Int]> }",
  "export service Sink { push(n: Int): Int }",
  "const source = unfold(0, (n) => Source.next(n))",
  'const shaped = throttleStream(source, { units: 1, durationMs: 1000, strategy: "shape" })',
  "const delivered = mapEffect(shaped, (n) => Sink.push(n), { concurrency: 1 })",
  "export const shapeRun = (): void uses Source.next | Sink.push => drainStream(delivered)",
  "",
].join("\n");

const SCRIPT = `
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { Sink, Source, shapeRun } from "./main.ts";

const delivered: number[] = [];
const program = Effect.gen(function* () {
  const arrived = [
    yield* Deferred.make<void>(),
    yield* Deferred.make<void>(),
    yield* Deferred.make<void>(),
  ];
  const Live = Layer.mergeAll(
    Layer.succeed(Source)({
      next: (n) => Effect.succeed(
        n < 3 ? Option.some([n + 1, n + 1] as readonly [number, number]) : Option.none(),
      ),
    }),
    Layer.succeed(Sink)({
      push: (n) => Effect.sync(() => { delivered.push(n); }).pipe(
        Effect.andThen(Deferred.succeed(arrived[n - 1]!, undefined)),
        Effect.as(n),
      ),
    }),
  );
  const fiber = yield* shapeRun().pipe(Effect.provide(Live), Effect.forkChild);
  yield* Deferred.await(arrived[0]!);
  const initial = [...delivered];
  yield* TestClock.adjust(999);
  const beforeWindow = [...delivered];
  yield* TestClock.adjust(1);
  yield* Deferred.await(arrived[1]!);
  const afterWindow = [...delivered];
  yield* TestClock.adjust(999);
  const beforeSecondWindow = [...delivered];
  yield* TestClock.adjust(1);
  yield* Deferred.await(arrived[2]!);
  yield* Fiber.join(fiber);
  return { initial, beforeWindow, afterWindow, beforeSecondWindow, final: [...delivered] };
});
const result = await Effect.runPromise(
  program.pipe(Effect.provide(TestClock.layer()), Effect.timeout("5 seconds")),
);
console.log(JSON.stringify(result));
`;

Deno.test("throttleStream shape delays the next element until the window elapses", async () => {
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", "main.eff": SOURCE }),
    "",
    ["main.eff"],
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const dir = Deno.makeTempDirSync({ prefix: "effective-temporal-" });
  try {
    const emitted = emitProject(lowerProject(checked.value), {
      config: checked.value.analysis.project.config,
    });
    for (const result of emitted.values()) {
      if (!result.ok) throw new Error(JSON.stringify(result));
      Deno.writeTextFileSync(`${dir}/${result.value.path}`, result.value.text);
    }
    Deno.writeTextFileSync(`${dir}/deno.json`, DENO_CONFIG);
    assertEquals(await runScript(dir, SCRIPT), {
      initial: [1],
      beforeWindow: [1],
      afterWindow: [1, 2],
      beforeSecondWindow: [1, 2],
      final: [1, 2, 3],
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

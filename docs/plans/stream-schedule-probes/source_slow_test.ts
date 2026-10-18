// deno test --no-lock --allow-all docs/plans/stream-schedule-probes/source_slow_test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../../../src/core/mod.ts";

function checked(source: string) {
  const result = checkProject(
    memoryHost({ "effective.json": "{}", "main.eff": source }),
    "",
    ["main.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function emitted(source: string): string {
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
  const result = emitProject(lowered, {
    config: project.analysis.project.config,
  }).get("main");
  assert(result?.ok, JSON.stringify(result));
  return result.value.text;
}

Deno.test("general stream and schedule source boundaries have concrete diagnostics", () => {
  const probes = {
    grouping: `type Int = int
const grouped = groupByKey(unfold(0, (n): Option<[Int, Int]> => None), (n: Int): Int => n)`,
    aggregation: `type Int = int
const sink = takeSink(2)
const batches = transduceStream(unfold(0, (n): Option<[Int, Int]> => None), sink)`,
    leftovers: `type Int = int
type WithLeftovers = Sink<Int, Int[], never, never, Int>`,
    schedule: `type Text = string
type General = Schedule<Text, Text>`,
    effectfulPolicy: `type Int = int
error Stop = {}
service Policy { delay(attempt: Int): Option<Int> }
const policy = retrySchedule((_: Stop, attempt: Int): Option<Int> uses Policy.delay => Policy.delay(attempt))`,
  };
  for (const [name, source] of Object.entries(probes)) {
    const diagnostics = checked(source).diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
    }));
    console.log(name, JSON.stringify(diagnostics));
    assert(diagnostics.length > 0);
    if (name === "effectfulPolicy") {
      assert(
        diagnostics.some((d) =>
          d.code === "execution-mode/001" && d.message.includes("must be pure")
        ),
      );
    } else if (name !== "leftovers") {
      assert(diagnostics.some((d) => d.code === "unknown-name/001"));
    } else {
      assert(diagnostics.some((d) => d.code === "syntax/008"));
    }
  }
});

Deno.test("native compositions cover selected stop traces and retry delays; target checks expose two boundaries", () => {
  const source = Deno.readTextFileSync(
    new URL("compositions.eff", import.meta.url),
  );
  const outputSource = emitted(source);
  const dir = Deno.makeTempDirSync({
    prefix: "effective-stream-schedule-audit-",
  });
  const decoder = new TextDecoder();
  const command = (...args: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        args[0],
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        ...args.slice(1),
      ],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
  try {
    Deno.writeTextFileSync(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { effect: "npm:effect@4.0.5" },
        compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
      }),
    );
    Deno.writeTextFileSync(`${dir}/main.ts`, outputSource);
    Deno.writeTextFileSync(
      `${dir}/run.ts`,
      `
import { Cause, Deferred, Duration, Effect, Layer, Option, Pull, Schedule, Stream } from "effect";
import { combined, RetryError, Signal, SignalError, Source, SourceError, stopped } from "./main.ts";

type Mode = "signal-success" | "signal-failure" | "source-success" | "source-failure";
async function consume(mode: Mode, native: boolean) {
  const signalStarted = Deferred.makeUnsafe<void>();
  const prefixSeen = Deferred.makeUnsafe<void>();
  const pendingStarted = Deferred.makeUnsafe<void>();
  const values: number[] = [];
  let pendingRelease = 0;
  let signalRelease = 0;
  let pulls = 0;
  const sourceLive = Layer.succeed(Source)({
    next: (state) => Effect.suspend(() => {
      pulls++;
      if (state === 0) return Deferred.await(signalStarted).pipe(
        Effect.as(Option.some([1, 1] as const)),
      );
      return Deferred.await(prefixSeen).pipe(Effect.andThen(Effect.suspend(() => {
        if (mode === "source-success") return Effect.succeed(Option.none());
        if (mode === "source-failure") return Effect.fail(new SourceError({}));
        return Effect.acquireUseRelease(
          Deferred.succeed(pendingStarted, undefined),
          () => Effect.never,
          () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { pendingRelease++; }))),
        );
      })));
    }),
  });
  const signalLive = Layer.succeed(Signal)({
    wait: () => Effect.acquireUseRelease(
      Deferred.succeed(signalStarted, undefined),
      () => mode === "source-success" || mode === "source-failure" ? Effect.never :
        Deferred.await(pendingStarted).pipe(Effect.andThen(
          mode === "signal-failure" ? Effect.fail(new SignalError({})) : Effect.void,
        )),
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => { signalRelease++; }))),
    ),
  });
  const expected = Stream.unfold(0, (state) => Source.use((source) => source.next(state)).pipe(
    Effect.map(Option.getOrUndefined),
  )).pipe(Stream.interruptWhen(Signal.use((signal) => signal.wait())));
  const stream = native ? stopped : expected;
  const exit = await Effect.runPromiseExit(Stream.runForEach(stream, (value) => Effect.sync(() => {
    values.push(value);
  }).pipe(Effect.andThen(Deferred.succeed(prefixSeen, undefined)))).pipe(
    Effect.provide(Layer.merge(sourceLive, signalLive)), Effect.timeout("5 seconds"),
  ));
  const error = exit._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  const outcome = error === undefined ? exit._tag : error._tag;
  return { mode, values, outcome, pendingRelease, signalRelease, pulls };
}

const results = [];
for (const mode of ["signal-success", "signal-failure", "source-success", "source-failure"] as const) {
  results.push({ actual: await consume(mode, true), expected: await consume(mode, false) });
}
// Reuse the same emitted Stream with fresh service layers.
results.push({ actual: await consume("signal-success", true), expected: await consume("signal-success", false) });

async function demand(native: boolean) {
  let pulls = 0;
  const signalStarted = Deferred.makeUnsafe<void>();
  const sourceLive = Layer.succeed(Source)({
    next: (state) => Effect.suspend(() => {
      pulls++;
      return state === 0 ? Deferred.await(signalStarted).pipe(Effect.as(Option.some([1, 1] as const))) : Effect.never;
    }),
  });
  const signalLive = Layer.succeed(Signal)({
    wait: () => Deferred.succeed(signalStarted, undefined).pipe(Effect.andThen(Effect.never)),
  });
  const expected = Stream.unfold(0, (state) => Source.use((source) => source.next(state)).pipe(
    Effect.map(Option.getOrUndefined),
  )).pipe(Stream.interruptWhen(Signal.use((signal) => signal.wait())));
  const exit = await Effect.runPromiseExit(Stream.runForEach(native ? stopped : expected, () => Effect.yieldNow.pipe(
    Effect.andThen(Effect.fail("consumer-stop")),
  )).pipe(
    Effect.provide(Layer.merge(sourceLive, signalLive)), Effect.timeout("5 seconds"),
  ));
  if (exit._tag !== "Failure" || Option.getOrUndefined(Cause.findErrorOption(exit.cause)) !== "consumer-stop") {
    throw new Error("unexpected consumer exit");
  }
  return pulls;
}

const backoff = Schedule.recurs(3).pipe(Schedule.addDelay((metadata) => Effect.succeed(metadata.attempt * 5)));
const expectedPolicy = Schedule.max([backoff, Schedule.spaced(10)]);
const delays = (policy: Schedule.Schedule<unknown, RetryError>) => Effect.gen(function* () {
  const step = yield* Schedule.toStep(policy);
  const values: number[] = [];
  for (let i = 0; i < 5; i++) {
    const delay = yield* Pull.matchEffect(step(i * 100, new RetryError({})), {
      onSuccess: ([, duration]) => Effect.succeed(Duration.toMillis(duration)),
      onDone: () => Effect.succeed(undefined),
      onFailure: Effect.failCause,
    });
    if (delay === undefined) return values;
    values.push(delay);
  }
  throw new Error("policy did not stop");
});
console.log(JSON.stringify({ results, demand: { composed: await demand(true), direct: await demand(false) }, delays: await Effect.runPromise(delays(combined)), expectedDelays: await Effect.runPromise(delays(expectedPolicy)) }));
`,
    );
    const typecheck = command("check", `${dir}/run.ts`);
    assert(typecheck.success, decoder.decode(typecheck.stderr));
    const run = command("run", `${dir}/run.ts`);
    assert(run.success, decoder.decode(run.stderr));
    const output = JSON.parse(decoder.decode(run.stdout));
    for (const pair of output.results) {
      assertEquals(pair.actual, pair.expected);
      const mode = pair.actual.mode;
      assertEquals(pair.actual.values, [1]);
      assertEquals(
        pair.actual.outcome,
        mode === "signal-failure"
          ? "main#SignalError"
          : mode === "source-failure"
          ? "main#SourceError"
          : "Success",
      );
      assertEquals(pair.actual.signalRelease, 1);
      assertEquals(
        pair.actual.pendingRelease,
        mode.startsWith("signal-") ? 1 : 0,
      );
      assertEquals(pair.actual.pulls, 2);
    }
    assertEquals(output.delays, [10, 10, 15]);
    assertEquals(output.delays, output.expectedDelays);
    assertEquals(output.demand, { composed: 1, direct: 1 });

    Deno.writeTextFileSync(
      `${dir}/leftovers.ts`,
      `
import { Sink } from "effect";
import type { PairSink } from "./main.ts";
const pairs: PairSink = Sink.take<number>(2);
void pairs;
`,
    );
    const rejected = command("check", `${dir}/leftovers.ts`);
    assert(!rejected.success);
    const diagnostic = decoder.decode(rejected.stderr);
    console.log(diagnostic);
    assertStringIncludes(diagnostic, "TS2375");
    assertStringIncludes(diagnostic, "never");

    Deno.writeTextFileSync(
      `${dir}/inline.ts`,
      emitted(
        Deno.readTextFileSync(new URL("inline-marker.eff", import.meta.url)),
      ),
    );
    const widened = command("check", `${dir}/inline.ts`);
    assert(!widened.success);
    const widening = decoder.decode(widened.stderr);
    console.log(widening);
    assertStringIncludes(widening, "TS2375");
    assertStringIncludes(widening, "Target requires 2 element(s)");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

import { assertEquals } from "@std/assert";
import { compileStrictTarget } from "./target_helpers.ts";

Deno.test("bare lambdas compile strictly and run collection pipelines and nested callbacks", async () => {
  const stdout = await compileStrictTarget(
    {
      "m.eff": `type Int = int
export const result: Int[] = [1, 2, 3] |> filter(value => value > 1) |> map(value => value + 1)
const nested: pure (x: Int) => pure (y: Int) => Int = x => y => x + y
export const sum: Int = nested(2)(3)
`,
    },
    ["m.eff"],
    `import { result, sum } from "./m.ts";\nconsole.log(JSON.stringify({result, sum}));`,
    "effektive-bare-lambda-",
  );
  assertEquals(JSON.parse(stdout), { result: [3, 4], sum: 5 });
});

Deno.test("Option fallback evaluates the subject once and fallback lazily, including right-associative chains", async () => {
  const stdout = await compileStrictTarget(
    {
      "m.eff": `type Int = int
service Store { find(): Option<Int>; fallback(): Int }
export const run = (): Int uses Store.find | Store.fallback => Store.find() ?? Store.fallback()
export const chain = (): Int => None ?? None ?? 7
`,
    },
    ["m.eff"],
    `import { Effect, Option } from "effect";
import { Store, run, chain } from "./m.ts";
let reads = 0, fallbacks = 0;
const test = (present: boolean) => Effect.runPromise(Effect.provideService(run(), Store, { find: () => Effect.sync(() => { reads++; return present ? Option.some(3) : Option.none(); }), fallback: () => Effect.sync(() => { fallbacks++; return 5; }) }));
const present = await test(true), absent = await test(false);
console.log(JSON.stringify({present, absent, reads, fallbacks, chain: chain()}));`,
    "effektive-option-fallback-",
  );
  assertEquals(JSON.parse(stdout), {
    present: 3,
    absent: 5,
    reads: 2,
    fallbacks: 1,
    chain: 7,
  });
});

Deno.test("record destructuring evaluates once, reads fields in order, and preserves own optional fields", async () => {
  const stdout = await compileStrictTarget(
    {
      "m.eff": `type Int = int
export type Article = { id: Int, revision: Int, name?: Int }
export const read = (subject: pure () => Article): Int => { const { revision: expectedRevision, id } = subject(); id + expectedRevision }
export const optional = (article: Article): Option<Int> => { const { name: optional } = article; optional }
`,
    },
    ["m.eff"],
    `import { Option } from "effect";
import { type Article, read, optional } from "./m.ts";
const order: string[] = [];
const article: Article = { get id() { order.push("id"); return 2; }, get revision() { order.push("revision"); return 3; } };
const result = read(() => { order.push("subject"); return article; });
const inherited: Article = Object.assign(Object.create({ name: 9 }), { id: 1, revision: 2 });
console.log(JSON.stringify({result, order, inherited: Option.isNone(optional(inherited)), own: Option.getOrElse(optional({ id: 1, revision: 2, name: 8 }), () => 0)}));`,
    "effektive-record-binding-",
  );
  assertEquals(JSON.parse(stdout), {
    result: 5,
    order: ["subject", "revision", "id"],
    inherited: true,
    own: 8,
  });
});

Deno.test("using/finally releases exactly once across success, failures, defects, and interruption", async () => {
  const stdout = await compileStrictTarget(
    {
      "m.eff": `export error Stop = {}
export service Jobs { open(): { run: () => Text fails Stop, wait: () => void, close: () => void fails Stop } fails Stop }
export const run = (): Text fails Stop uses Jobs.open => using (job = Jobs.open()) { job.run() } finally { job.close() }
export const wait = (): void fails Stop uses Jobs.open => using (job = Jobs.open()) { job.wait() } finally { job.close() }
type Text = string
`,
    },
    ["m.eff"],
    `import { Deferred, Effect, Exit, Fiber } from "effect";
import { Jobs, Stop, run, wait } from "./m.ts";
const events: string[] = [];
let mode = "success";
const started = Deferred.makeUnsafe<void>();
const service = {
  open: () => Effect.gen(function* () {
    events.push("acquire");
    if (mode === "acquire") return yield* Effect.fail(new Stop({}));
    return {
      run: () => Effect.gen(function* () {
        events.push("use");
        if (mode === "use") return yield* Effect.fail(new Stop({}));
        if (mode === "defect") return yield* Effect.die("defect");
        return "ok";
      }),
      wait: () => Effect.gen(function* () { events.push("wait"); yield* Deferred.succeed(started, undefined); yield* Effect.never; }),
      close: () => Effect.gen(function* () { events.push("release"); if (mode === "release") yield* Effect.fail(new Stop({})); }),
    };
  }),
};
const results = [];
for (const scenario of ["success", "acquire", "use", "defect", "release"]) {
  mode = scenario; events.length = 0;
  const result = await Effect.runPromiseExit(Effect.provideService(run(), Jobs, service));
  results.push({scenario, success: Exit.isSuccess(result), events: [...events]});
}
mode = "interrupt"; events.length = 0;
await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(Effect.provideService(wait(), Jobs, service));
  yield* Deferred.await(started);
  yield* Fiber.interrupt(fiber);
}));
console.log(JSON.stringify({results, interrupted: events}));`,
    "effektive-using-finally-",
  );
  assertEquals(JSON.parse(stdout), {
    results: [
      {
        scenario: "success",
        success: true,
        events: ["acquire", "use", "release"],
      },
      { scenario: "acquire", success: false, events: ["acquire"] },
      {
        scenario: "use",
        success: false,
        events: ["acquire", "use", "release"],
      },
      {
        scenario: "defect",
        success: false,
        events: ["acquire", "use", "release"],
      },
      {
        scenario: "release",
        success: false,
        events: ["acquire", "use", "release"],
      },
    ],
    interrupted: ["acquire", "wait", "release"],
  });
});

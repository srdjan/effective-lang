// deno test --no-lock docs/plans/schedule-probes/composition.ts
import { assertEquals } from "@std/assert";
import { Cause, Duration, Effect, Pull, Schedule } from "npm:effect@4.0.5";

Deno.test("max and min output their selected delay and complete with zero", async () => {
  const limited = (count: number, delay: number) =>
    Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<unknown>) =>
        meta.attempt <= count
          ? Effect.succeed([delay, Duration.millis(delay)] as [
            number,
            Duration.Duration,
          ])
          : Cause.done(delay + 100)
      ),
    );
  const trace = (policy: Schedule.Schedule<Duration.Duration>) =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(policy);
      const output: number[] = [];
      for (let index = 0; index < 5; index++) {
        const decision = yield* Pull.matchEffect(step(index * 100, undefined), {
          onSuccess: ([value, delay]) =>
            Effect.succeed([
              Duration.toMillis(value),
              Duration.toMillis(delay),
            ]),
          onDone: (value) => Effect.succeed(Duration.toMillis(value)),
          onFailure: Effect.failCause,
        });
        if (typeof decision === "number") {
          return { steps: output, done: decision };
        }
        output.push(decision[0], decision[1]);
      }
      throw new Error("schedule did not complete");
    });
  const short = limited(1, 10);
  const long = limited(3, 20);
  assertEquals(await Effect.runPromise(trace(Schedule.max([short, long]))), {
    steps: [20, 20],
    done: 0,
  });
  assertEquals(await Effect.runPromise(trace(Schedule.min([short, long]))), {
    steps: [10, 10, 20, 20, 20, 20],
    done: 0,
  });
});

Deno.test("concat starts the right phase on the input that ended the left", async () => {
  const left = Schedule.fromStepWithMetadata(Effect.succeed(
    (meta: Schedule.InputMetadata<string>) =>
      meta.attempt === 1
        ? Effect.succeed([`left:${meta.input}`, Duration.millis(10)] as [
          string,
          Duration.Duration,
        ])
        : Cause.done("left-end"),
  ));
  const right = Schedule.fromStepWithMetadata(Effect.succeed(
    (meta: Schedule.InputMetadata<string>) =>
      meta.attempt === 1
        ? Effect.succeed([`right:${meta.input}`, Duration.millis(20)] as [
          string,
          Duration.Duration,
        ])
        : Cause.done("right-end"),
  ));
  const run = Effect.gen(function* () {
    const step = yield* Schedule.toStep(Schedule.concat(left, right));
    const first = yield* step(0, "a");
    const second = yield* step(100, "b");
    const done = yield* Pull.matchEffect(step(200, "c"), {
      onSuccess: () => Effect.succeed("unexpected recurrence"),
      onDone: Effect.succeed,
      onFailure: Effect.failCause,
    });
    return { first, second, done };
  });
  assertEquals(await Effect.runPromise(run), {
    first: ["left:a", Duration.millis(10)],
    second: ["right:b", Duration.millis(20)],
    done: "right-end",
  });
  assertEquals(await Effect.runPromise(run), {
    first: ["left:a", Duration.millis(10)],
    second: ["right:b", Duration.millis(20)],
    done: "right-end",
  });
});

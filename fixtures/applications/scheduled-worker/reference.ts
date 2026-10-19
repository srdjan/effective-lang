import { Cause, Duration, Effect, Option, Schedule } from "effect";
import {
  type JobFailure,
  Jobs,
  type Policy,
  type Report,
} from "./contracts.ts";

/** Native reference for valid policies, independent of the source loop. */
export const nativeWorker = (policy: Policy) =>
  Effect.suspend(() => {
    let completed = 0;
    let last: Option.Option<number> = Option.none();
    const report = (): Report => ({ completed, last });
    if (policy.runs === 0) return Effect.succeed(report());
    const retry = Schedule.fromStepWithMetadata(Effect.succeed(
      (meta: Schedule.InputMetadata<JobFailure>) =>
        meta.input.kind === "Transient" && meta.attempt <= policy.retries
          ? Effect.succeed(
            [meta.attempt, Duration.millis(policy.retryMillis)] as [
              number,
              Duration.Duration,
            ],
          )
          : Cause.done(meta.attempt),
    ));
    const attempt = Effect.acquireUseRelease(
      Jobs.use((jobs) => jobs.open()),
      (id) => Jobs.use((jobs) => jobs.execute(id)),
      (id) => Jobs.use((jobs) => jobs.close(id)),
    ).pipe(
      Effect.retry(retry),
      Effect.tap((value) =>
        Effect.sync(() => {
          completed++;
          last = Option.some(value);
        })
      ),
    );
    const repetition = Schedule.max([
      Schedule.recurs(policy.runs - 1),
      Schedule.spaced(Duration.millis(policy.delayMillis)),
    ]);
    return Effect.repeat(attempt, repetition).pipe(Effect.map(report));
  });

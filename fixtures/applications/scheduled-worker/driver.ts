import { Duration, Effect, Layer } from "effect";
import { Clock, type JobFailure, Jobs } from "./contracts.ts";

export interface DriverOptions {
  readonly open?: (id: number) => Effect.Effect<void, JobFailure>;
  readonly execute?: (id: number) => Effect.Effect<number, JobFailure>;
  readonly close?: (id: number) => Effect.Effect<void>;
  readonly wait?: (millis: number) => Effect.Effect<void>;
}

/** Recording in-memory job resources and a clock driver; source owns orchestration. */
export function makeDriver(options: DriverOptions = {}) {
  const events: string[] = [];
  const active = new Set<number>();
  let opened = 0;
  let attempts = 0;
  const jobs = Layer.succeed(Jobs)({
    open: () =>
      Effect.gen(function* () {
        const id = ++opened;
        events.push(`open:${id}`);
        yield* options.open?.(id) ?? Effect.void;
        active.add(id);
        events.push(`acquired:${id}`);
        return id;
      }),
    execute: (id) =>
      Effect.suspend(() => {
        if (!active.has(id)) return Effect.die("job resource is closed");
        attempts++;
        events.push(`execute:${id}`);
        return options.execute?.(id) ?? Effect.succeed(id * 10);
      }),
    close: (id) =>
      Effect.suspend(() => {
        events.push(`close:${id}`);
        return (options.close?.(id) ?? Effect.void).pipe(
          Effect.ensuring(Effect.sync(() => {
            active.delete(id);
            events.push(`released:${id}`);
          })),
        );
      }),
  });
  const clock = Layer.succeed(Clock)({
    wait: (millis) =>
      Effect.suspend(() => {
        events.push(`wait:${millis}`);
        return (options.wait?.(millis) ?? Effect.sleep(Duration.millis(millis)))
          .pipe(
            Effect.ensuring(Effect.sync(() => {
              events.push(`wait-closed:${millis}`);
            })),
          );
      }),
  });
  return {
    layer: Layer.merge(jobs, clock),
    events,
    active,
    get opened() {
      return opened;
    },
    get attempts() {
      return attempts;
    },
  };
}

import { Effect, Layer, Option } from "effect";
import {
  Input,
  type InputFailure,
  type Item,
  Output,
  type OutputFailure,
  type Processed,
  Transform,
  type TransformFailure,
} from "./contracts.ts";

export type Session = "input" | "output";
export interface DriverOptions {
  readonly items?: ReadonlyArray<Item>;
  readonly openInput?: () => Effect.Effect<void, InputFailure>;
  readonly openOutput?: () => Effect.Effect<void, OutputFailure>;
  readonly next?: (index: number) => Effect.Effect<void, InputFailure>;
  readonly transform?: (item: Item) => Effect.Effect<number, TransformFailure>;
  readonly write?: (
    batch: ReadonlyArray<Processed>,
  ) => Effect.Effect<void, OutputFailure>;
  readonly close?: (session: Session) => Effect.Effect<void>;
}
export const sampleItems = (count: number): ReadonlyArray<Item> =>
  Array.from(
    { length: count },
    (_, index) => ({ id: index + 1, value: index + 1 }),
  );

/** Primitive recording operations; source owns the complete stream pipeline. */
export function makeDriver(options: DriverOptions = {}) {
  const items = options.items ?? sampleItems(5);
  const events: string[] = [];
  const activeSessions = new Set<Session>();
  const activeTransforms = new Set<number>();
  const activeOperations = new Set<string>();
  const pulls: number[] = [];
  const completed: number[] = [];
  const batches: ReadonlyArray<Processed>[] = [];
  let opened = 0;
  let maximumTransforms = 0;
  const open = <E>(session: Session, effect: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      events.push(`open:${session}`);
      yield* effect;
      activeSessions.add(session);
      const id = ++opened;
      events.push(`opened:${session}:${id}`);
      return id;
    });
  const close = (session: Session) =>
    Effect.suspend(() => {
      events.push(`close:${session}`);
      return (options.close?.(session) ?? Effect.void).pipe(
        Effect.ensuring(Effect.sync(() => {
          activeSessions.delete(session);
          events.push(`closed:${session}`);
        })),
      );
    });
  const operation = <A, E>(
    name: string,
    session: Session,
    effect: Effect.Effect<A, E>,
  ) =>
    Effect.suspend(() => {
      if (!activeSessions.has(session)) {
        return Effect.die(`closed ${session} session`);
      }
      activeOperations.add(name);
      events.push(name);
      return effect.pipe(Effect.ensuring(Effect.sync(() => {
        activeOperations.delete(name);
        events.push(`done:${name}`);
      })));
    });
  const input = Layer.succeed(Input)({
    open: () =>
      Effect.suspend(() => open("input", options.openInput?.() ?? Effect.void)),
    next: (_session, index) =>
      operation(
        `pull:${index}`,
        "input",
        Effect.gen(function* () {
          pulls.push(index);
          yield* options.next?.(index) ?? Effect.void;
          const item = items[index];
          return item === undefined
            ? Option.none()
            : Option.some([item, index + 1] as const);
        }),
      ),
    close: () => close("input"),
  });
  const transform = Layer.succeed(Transform)({
    apply: (item) =>
      Effect.suspend(() => {
        activeTransforms.add(item.id);
        maximumTransforms = Math.max(maximumTransforms, activeTransforms.size);
        events.push(`transform:${item.id}`);
        return (options.transform?.(item) ?? Effect.succeed(item.value * 10))
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed.push(item.id);
              })
            ),
            Effect.ensuring(Effect.sync(() => {
              activeTransforms.delete(item.id);
              events.push(`transformed:${item.id}`);
            })),
          );
      }),
  });
  const output = Layer.succeed(Output)({
    open: () =>
      Effect.suspend(() =>
        open("output", options.openOutput?.() ?? Effect.void)
      ),
    write: (_session, batch) =>
      operation(
        `write:${batch.map((item) => item.id).join(",")}`,
        "output",
        Effect.suspend(() =>
          (options.write?.(batch) ?? Effect.void).pipe(
            Effect.andThen(Effect.sync(() => {
              batches.push([...batch]);
            })),
          )
        ),
      ),
    close: () => close("output"),
  });
  return {
    layer: Layer.mergeAll(input, transform, output),
    events,
    activeSessions,
    activeTransforms,
    activeOperations,
    pulls,
    completed,
    batches,
    get maximumTransforms() {
      return maximumTransforms;
    },
    get opened() {
      return opened;
    },
  };
}

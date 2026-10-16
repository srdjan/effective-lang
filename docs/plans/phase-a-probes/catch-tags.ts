import { Effect, Schema } from "effect";

export class A extends Schema.TaggedError<A>()("m#A", { x: Schema.String }) {}
export class B extends Schema.TaggedError<B>()("m#B", { y: Schema.String }) {}
export class C extends Schema.TaggedError<C>()("m#C", { z: Schema.String }) {}

declare const body: Effect.Effect<string, A | B | C>;

// Chained catchTag: handler for A fails with B, which the second catchTag then catches.
export const chained: Effect.Effect<string, B | C> = body.pipe(
  Effect.catchTag("m#A", (_a) => Effect.fail(new B({ y: "from A" }))),
  Effect.catchTag("m#B", (_b) => Effect.succeed("handled B")),
);

// Single-pass catchTags: handler failures are not re-caught.
export const single: Effect.Effect<string, B | C> = body.pipe(
  Effect.catchTags({
    "m#A": (_a) => Effect.fail(new B({ y: "from A" })),
    "m#B": (_b) => Effect.succeed("handled B"),
  }),
);

// catchTag with an array of tags, if supported.
export const multi: Effect.Effect<string, C> = body.pipe(
  Effect.catchTag(["m#A", "m#B"], (_e) => Effect.succeed("either")),
);

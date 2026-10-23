// Unsound host code: each data result has a wrong tag through a cast, and
// `total` returns a number that is not an integer.
import { Effect, Layer, Option, Stream } from "effect";
import { Clock, Pings, Row, Rows } from "./contracts.ts";
import { Auth } from "./host.effi.ts";

export const AuthLive = Layer.succeed(Auth)({
  token: () => Effect.succeed({ _tag: "host#Nope", id: "t" } as never),
});

const wrong = { _tag: "contracts#Nope", id: "x" } as never;

const RowsOnly = Layer.effect(Rows)(
  Effect.gen(function* () {
    const clock = yield* Clock;
    return {
      get: () => Effect.succeed(wrong),
      find: () => Effect.succeed(Option.some(wrong)),
      list: () => Effect.succeed([Row.make({ id: "r" }), wrong]),
      watch: () =>
        Effect.succeed(Stream.fromArray([Row.make({ id: "s1" }), wrong])),
      summary: () => Effect.succeed({ count: 2, first: wrong }),
      total: () => Effect.map(clock.now(), () => 1.5),
    };
  }),
);

export const RowsLive = Layer.merge(
  RowsOnly,
  Layer.succeed(Pings)({ ping: () => Effect.succeed("pong") }),
);

import { Effect, Layer, Option, Stream } from "effect";
import { Boom, Clock, Gap, Pings, Row, Rows } from "./contracts.ts";
import { Auth, Token } from "./host.effi.ts";

export const AuthLive = Layer.succeed(Auth)({
  token: () => Effect.succeed(Token.make({ id: "t" })),
});

const RowsOnly = Layer.effect(Rows)(
  Effect.gen(function* () {
    const clock = yield* Clock;
    return {
      get: (key, version) =>
        key === "boom"
          ? Effect.fail(new Boom({}))
          : Effect.succeed(Row.make({ id: `${key}${version}` })),
      find: (key) => Effect.succeed(Option.some(Row.make({ id: key }))),
      list: () =>
        Effect.succeed([Row.make({ id: "r" }), Gap.make({ id: "g" })]),
      watch: () =>
        Effect.succeed(Stream.fromArray([
          Row.make({ id: "s1" }),
          Gap.make({ id: "s2" }),
          Row.make({ id: "s3" }),
        ])),
      summary: () =>
        Effect.succeed({ count: 2, first: Row.make({ id: "first" }) }),
      total: () => clock.now(),
    };
  }),
);

export const RowsLive = Layer.merge(
  RowsOnly,
  Layer.succeed(Pings)({ ping: () => Effect.succeed("pong") }),
);

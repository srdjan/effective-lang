// Host module for the provider UsersLive in host/providers.effi.
// It keeps the users in memory. The store starts with one active and one inactive user.

import { Effect, Layer, Option } from "effect";
import { type User, Users } from "./users.ts";

const store = new Map<string, User>([
  ["u1", { id: "u1", name: "Ada", active: true }],
  ["u2", { id: "u2", name: "Grace", active: false }],
]);

export const UsersLive: Layer.Layer<Users> = Layer.succeed(Users)({
  find: (id) => Effect.succeed(Option.fromNullishOr(store.get(id))),
  save: (user) =>
    Effect.sync(() => {
      store.set(user.id, user);
    }),
  all: () => Effect.sync(() => [...store.values()]),
});

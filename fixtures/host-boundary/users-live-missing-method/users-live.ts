// A wrong host module for the provider UsersLive in host/providers.effi.
// The registry says that UsersLive provides Users. This module provides a
// service with another shape: the method find takes a number, and the method
// all is missing. Part A6b uses it to test the host-boundary mapping.

import { Context, Effect, Layer, Option } from "effect";
import type { StoreUnavailable, User } from "./users.ts";

class WrongUsers extends Context.Service<WrongUsers, {
  readonly find: (
    a: number,
  ) => Effect.Effect<Option.Option<User>, StoreUnavailable>;
  readonly save: (a: User) => Effect.Effect<void, StoreUnavailable>;
}>()("users#Users") {}

export const UsersLive = Layer.succeed(WrongUsers)({
  find: () => Effect.succeed(Option.none()),
  save: () => Effect.void,
});

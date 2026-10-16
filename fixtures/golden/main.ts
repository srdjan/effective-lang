// Generated from main.eff by the Effective compiler. Do not edit.

import { Effect, Layer } from "effect";
import { displayName, StoreUnavailable, Users } from "./users.ts";
import { UsersLive } from "./users-live.ts";

const UsersLive$host: Layer.Layer<Users> = UsersLive;

export const main = (): Effect.Effect<string, StoreUnavailable> =>
  Effect.provide(Effect.suspend(() => displayName("u1")), UsersLive$host);
//# sourceMappingURL=main.ts.map

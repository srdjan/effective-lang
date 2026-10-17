// Generated from users.eff by the Effective compiler. Do not edit.

import { Context, Effect, Option, Schema } from "effect";

export const UserId = Schema.String;
export type UserId = typeof UserId.Type;

export const Name = Schema.String;
export type Name = typeof Name.Type;

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  active: Schema.Boolean,
});
export type User = typeof User.Type;

export class UserMissing extends Schema.TaggedError<UserMissing>()(
  "users#UserMissing",
  { id: Schema.String },
) {}

export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "users#StoreUnavailable",
  { message: Schema.String },
) {}

export class Users extends Context.Service<Users, {
  readonly find: (a: UserId) => Effect.Effect<
    Option.Option<User>,
    StoreUnavailable
  >;
  readonly save: (a: User) => Effect.Effect<void, StoreUnavailable>;
  readonly all: () => Effect.Effect<ReadonlyArray<User>, StoreUnavailable>;
}>()("users#Users") {}

export const getUser = (id: UserId): Effect.Effect<
  User,
  StoreUnavailable | UserMissing,
  Users
> =>
  Effect.gen(function* () {
    return yield* Option.match(yield* Users.use(($s) => $s.find(id)), {
      onNone: () => Effect.fail(new UserMissing({ id })),
      onSome: (user) => Effect.succeed(user),
    });
  });

export const rename = (id: UserId, name: Name): Effect.Effect<
  User,
  StoreUnavailable | UserMissing,
  Users
> =>
  Effect.gen(function* () {
    const user: User = yield* getUser(id);
    const renamed: User = { ...user, name };
    yield* Users.use(($s) => $s.save(renamed));
    return renamed;
  });

export const displayName = (id: UserId): Effect.Effect<
  Name,
  StoreUnavailable,
  Users
> =>
  Effect.gen(function* () {
    return (yield* getUser(id)).name;
  }).pipe(
    Effect.catchTags({
      "users#UserMissing": (error) => Effect.succeed("Guest"),
    }),
  );

export const activeNames = (): Effect.Effect<
  ReadonlyArray<Name>,
  StoreUnavailable,
  Users
> =>
  Effect.gen(function* () {
    const $p1: ReadonlyArray<User> = yield* Users.use(($s) => $s.all());
    const $p2: ReadonlyArray<User> = $p1.filter((user) => user.active);
    return $p2.map((user) => user.name);
  });
//# sourceMappingURL=users.ts.map

// Probe: the Phase A emission scheme (plan section 6) under effect@4.0.5 strict.
import { Context, Effect, Layer, Option, Schema } from "effect";

const $int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");
  return value;
};

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
  readonly find: (
    id: string,
  ) => Effect.Effect<Option.Option<User>, StoreUnavailable>;
  readonly save: (user: User) => Effect.Effect<void, StoreUnavailable>;
  readonly all: () => Effect.Effect<ReadonlyArray<User>, StoreUnavailable>;
}>()("users#Users") {}

// getUser: match on option in effect mode; subject inGen, arms asEffect, yielded once.
// Probes yield* on a union of two Effect types.
export const getUser = (
  id: string,
): Effect.Effect<User, UserMissing | StoreUnavailable, Users> =>
  Effect.gen(function* () {
    return yield* Option.match(yield* Users.use(($s) => $s.find(id)), {
      onNone: () => Effect.fail(new UserMissing({ id })),
      onSome: (user) => Effect.succeed(user),
    });
  });

// rename: block body in effect mode.
export const rename = (
  id: string,
  name: string,
): Effect.Effect<User, UserMissing | StoreUnavailable, Users> =>
  Effect.gen(function* () {
    const user = yield* getUser(id);
    const renamed: User = { ...user, name };
    yield* Users.use(($s) => $s.save(renamed));
    return renamed;
  });

// displayName: catch leaf, tag with '#', body = get over an effectful child.
export const displayName = (
  id: string,
): Effect.Effect<string, StoreUnavailable, Users> =>
  Effect.gen(function* () {
    return (yield* getUser(id)).name;
  }).pipe(
    Effect.catchTag("users#UserMissing", (error) => Effect.succeed("Guest")),
  );

// activeNames: pipeline lowered to bindings; builtins as array methods.
export const activeNames = (): Effect.Effect<
  ReadonlyArray<string>,
  StoreUnavailable,
  Users
> =>
  Effect.gen(function* () {
    const $t0 = yield* Users.use(($s) => $s.all());
    const $t1 = $t0.filter((user) => user.active);
    return $t1.map((user) => user.name);
  });

// Host assertion and provide.
declare const UsersLiveImpl: Layer.Layer<Users>;
const UsersLive$host: Layer.Layer<Users> = UsersLiveImpl;
export const main = (): Effect.Effect<string, StoreUnavailable> =>
  Effect.provide(Effect.suspend(() => displayName("u1")), UsersLive$host);

// Leaf with an effectful child: hoisted inside a nested Effect.gen inside a generator.
export const nested = (
  id: string,
): Effect.Effect<void, UserMissing | StoreUnavailable, Users> =>
  Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const $t0 = yield* getUser(id);
      return yield* Users.use(($s) => $s.save($t0));
    });
  });

// if in effect mode: only the selected branch yields; && short-circuit with yields.
export const cond = (
  id: string,
  flag: boolean,
): Effect.Effect<string, UserMissing | StoreUnavailable, Users> =>
  Effect.gen(function* () {
    return flag ? (yield* getUser(id)).name : yield* displayName(id);
  });
export const andThen = (
  a: Effect.Effect<boolean>,
  b: Effect.Effect<boolean>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    return (yield* a) && (yield* b);
  });

// Selector match on a tagged record union: IIFE arms over the narrowed subject.
const Circle = Schema.Struct({
  kind: Schema.Literal("circle"),
  radius: Schema.Number,
});
const Square = Schema.Struct({
  kind: Schema.Literal("square"),
  side: Schema.Number,
});
export const Shape = Schema.Union([Circle, Square]);
export type Shape = typeof Shape.Type;
export const extent = (shape: Shape): number =>
  (($t0) =>
    $t0.kind === "circle"
      ? ((circle) => circle.radius)($t0)
      : ((square) => square.side)($t0))(shape);

export const extentE = (shape: Effect.Effect<Shape>): Effect.Effect<number> =>
  Effect.gen(function* () {
    return yield* (($t0) =>
      $t0.kind === "circle"
        ? Effect.succeed(((circle) => circle.radius)($t0))
        : Effect.gen(function* () {
          return ((square) => square.side)($t0);
        }))(yield* shape);
  });

// int helper with yielded operands; pure lift into an effectful contract.
export const sum = (
  a: Effect.Effect<number>,
  b: Effect.Effect<number>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    return $int((yield* a) + (yield* b));
  });
export const lifted = (x: number): Effect.Effect<number, UserMissing, Users> =>
  Effect.succeed($int(x + 1));

// retry leaf as an evaluate step.
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()(
  "pay#PaymentDeclined",
  { reason: Schema.String },
) {}
export class Payments extends Context.Service<Payments, {
  readonly charge: (amount: number) => Effect.Effect<string, PaymentDeclined>;
}>()("pay#Payments") {}
export const chargeOrder = (
  amount: number,
): Effect.Effect<number, PaymentDeclined, Payments> =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.suspend(() => Payments.use(($s) => $s.charge(amount))),
      { times: 2 },
    );
    return amount;
  });

// Schema forms the plan needs but the tabs do not show.
export const Profile = Schema.Struct({
  name: Schema.String,
  nickname: Schema.optionalKey(Schema.String),
  maybe: Schema.Option(Schema.String),
  tags: Schema.Array(Schema.String),
  pair: Schema.Tuple([Schema.String, Schema.Number]),
  raw: Schema.Unknown,
});
export type Profile = typeof Profile.Type;
export const nick = (p: Profile): Option.Option<string> =>
  Option.fromUndefinedOr(p.nickname);

// Brand schema with '#' token.
export const OrderId = Schema.String.pipe(Schema.brand("pay#OrderId"));
export type OrderId = typeof OrderId.Type;

// Layer.succeed shape for the users-live.ts fixture.
export const UsersMemory: Layer.Layer<Users> = Layer.succeed(Users)({
  find: (id) =>
    Effect.succeed(
      id === "u1"
        ? Option.some({ id, name: "Ada", active: true })
        : Option.none(),
    ),
  save: () => Effect.succeed(undefined),
  all: () => Effect.succeed([]),
});

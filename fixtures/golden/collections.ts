// Generated from collections.eff by the Effective compiler. Do not edit.

import { Schema } from "effect";

const $Int = Schema.Finite.check(
  Schema.makeFilter(
    (value) => Number.isSafeInteger(value) || "expected a safe integer",
  ),
);

const $int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");
  return value;
};

export const Name = Schema.String;
export type Name = typeof Name.Type;

export const Amount = $Int;
export type Amount = typeof Amount.Type;

export const User = Schema.Struct({
  name: Schema.String,
  active: Schema.Boolean,
});
export type User = typeof User.Type;

export const activeNames = (
  users: ReadonlyArray<User>,
): ReadonlyArray<Name> => {
  const $p1: ReadonlyArray<User> = users;
  const $p2: ReadonlyArray<User> = $p1.filter((user) => user.active);
  return $p2.map((user) => user.name);
};

export const total = (amounts: ReadonlyArray<Amount>): Amount => {
  const $p1: ReadonlyArray<Amount> = amounts;
  return $p1.reduce<Amount>((sum, amount) => $int(sum + amount), 0);
};
//# sourceMappingURL=collections.ts.map

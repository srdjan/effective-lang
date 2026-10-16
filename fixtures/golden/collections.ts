// Generated from collections.eff by the Effective compiler. Do not edit.

import { Schema } from "effect";

const $int = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError("int overflow");
  return value;
};

export const User = Schema.Struct({
  name: Schema.String,
  active: Schema.Boolean,
});
export type User = typeof User.Type;

export const activeNames = (
  users: ReadonlyArray<User>,
): ReadonlyArray<string> => {
  const $p1: ReadonlyArray<User> = users;
  const $p2: ReadonlyArray<User> = $p1.filter((user) => user.active);
  return $p2.map((user) => user.name);
};

export const total = (amounts: ReadonlyArray<number>): number => {
  const $p1: ReadonlyArray<number> = amounts;
  return $p1.reduce((sum, amount) => $int(sum + amount), 0);
};
//# sourceMappingURL=collections.ts.map

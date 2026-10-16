import { Schema } from "effect";
export const Order = Schema.Struct({ id: Schema.String, status: Schema.Literals(["pending", "paid"]) });
export type Order = typeof Order.Type;
export const markPaid = (order: Order): Order => {
  const paid = { ...order, status: "paid" };
  return paid;
};
export const mk = (): readonly [string, number] => {
  const t = ["x", 1];
  return t;
};

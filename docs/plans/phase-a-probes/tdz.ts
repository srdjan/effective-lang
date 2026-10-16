import { Schema } from "effect";
export const Order = Schema.Struct({ id: OrderId, totalCents: Schema.Number });
export type Order = typeof Order.Type;
export const OrderId = Schema.String.pipe(Schema.brand("pay#OrderId"));
export type OrderId = typeof OrderId.Type;
export const limit: number = base + 1;
export const base: number = 1;

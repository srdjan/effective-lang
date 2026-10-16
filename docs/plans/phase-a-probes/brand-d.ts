import { Schema } from "effect";
export const OrderId = Schema.String.pipe(Schema.brand("pay#OrderId"));
export type OrderId = typeof OrderId.Type;
export const e: OrderId = OrderId.make("o1");

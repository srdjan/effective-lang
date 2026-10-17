// Generated from pay.eff by the Effective compiler. Do not edit.

import { Context, Effect, Option, Schema } from "effect";

const $Int = Schema.Finite.check(
  Schema.makeFilter(
    (value) => Number.isSafeInteger(value) || "expected a safe integer",
  ),
);

export const Cents = $Int;
export type Cents = typeof Cents.Type;

export const ChargeId = Schema.String;
export type ChargeId = typeof ChargeId.Type;

export const OrderId = Schema.String.pipe(Schema.brand("pay#OrderId"));
export type OrderId = typeof OrderId.Type;

export const Order = Schema.Struct({
  id: OrderId,
  totalCents: $Int,
  status: Schema.Literals(["pending", "paid"]),
});
export type Order = typeof Order.Type;

export class OrderNotFound extends Schema.TaggedError<OrderNotFound>()(
  "pay#OrderNotFound",
  { id: OrderId },
) {}

export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()(
  "pay#PaymentDeclined",
  { reason: Schema.String },
) {}

export class Orders extends Context.Service<Orders, {
  readonly find: (a: OrderId) => Effect.Effect<Option.Option<Order>>;
  readonly save: (a: Order) => Effect.Effect<void>;
}>()("pay#Orders") {}

export class Payments extends Context.Service<Payments, {
  readonly charge: (a: Cents) => Effect.Effect<ChargeId, PaymentDeclined>;
}>()("pay#Payments") {}

const findOrder = (id: OrderId): Effect.Effect<Order, OrderNotFound, Orders> =>
  Effect.gen(function* () {
    return yield* Option.match(yield* Orders.use(($s) => $s.find(id)), {
      onNone: () => Effect.fail(new OrderNotFound({ id })),
      onSome: (order) => Effect.succeed(order),
    });
  });

const chargeOrder = (order: Order): Effect.Effect<
  Order,
  PaymentDeclined,
  Payments
> =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.suspend(() => Payments.use(($s) => $s.charge(order.totalCents))),
      { times: 2 },
    );
    return order;
  });

const markPaid = (order: Order): Order => ({ ...order, status: "paid" });

const saveOrder = (order: Order): Effect.Effect<Order, never, Orders> =>
  Effect.gen(function* () {
    yield* Orders.use(($s) => $s.save(order));
    return order;
  });

export const pay = (id: OrderId): Effect.Effect<
  Order,
  OrderNotFound | PaymentDeclined,
  Orders | Payments
> =>
  Effect.gen(function* () {
    const $p1: OrderId = id;
    const $p2: Order = yield* findOrder($p1);
    const $p3: Order = yield* chargeOrder($p2);
    const $p4: Order = markPaid($p3);
    return yield* saveOrder($p4);
  });
//# sourceMappingURL=pay.ts.map

import { assert, assertEquals } from "@std/assert";
import { Cause, Effect, Exit, Schema } from "effect";
import { Cents, Fixed, InvalidTransition, Sum } from "./contracts.ts";
import {
  cancel,
  cancelAny,
  decodeOrder,
  describe,
  encodeOrder,
  fromInput,
  isOpen,
  pay,
  price,
  sampleRule,
  ship,
  stateOf,
  total,
} from "./orders.ts";

const pending = Effect.runSync(fromInput({ id: "o1", total: 1000 }));
const paid = pay(pending, { number: "R1" });
const shipped = ship(paid, { code: "T1" });
const cancelled = cancel(pending, { note: "changed mind" });
const states = [pending, paid, shipped, cancelled];

Deno.test("each transition returns the next state", () => {
  assertEquals(paid._tag, "contracts#Paid");
  assertEquals(paid.receipt.number, "R1");
  assertEquals(shipped._tag, "contracts#Shipped");
  assertEquals(shipped.tracking.code, "T1");
  assertEquals(cancelled._tag, "contracts#Cancelled");
  assertEquals(cancel(paid, { note: "late" })._tag, "contracts#Cancelled");
});

Deno.test("stateOf, describe, and isOpen cover each state", () => {
  assertEquals(states.map(stateOf), [
    "pending",
    "paid",
    "shipped",
    "cancelled",
  ]);
  assertEquals(states.map(describe), [
    "pending",
    "R1",
    "T1",
    "changed mind",
  ]);
  assertEquals(states.map(isOpen), [true, true, false, false]);
});

Deno.test("cancelAny fails with InvalidTransition for closed states", () => {
  const closed = [[shipped, "shipped"], [cancelled, "cancelled"]] as const;
  for (const [order, state] of closed) {
    const exit = Effect.runSyncExit(cancelAny(order, { note: "late" }));
    assert(Exit.isFailure(exit));
    const error = Cause.squash(exit.cause);
    assert(error instanceof InvalidTransition, String(error));
    assertEquals(error.state, state);
  }
  const ok = Effect.runSyncExit(cancelAny(paid, { note: "n" }));
  assert(Exit.isSuccess(ok));
});

Deno.test("price evaluates the sample rule built in source", () => {
  assertEquals(price(sampleRule, pending.total), 2500);
  assertEquals(price(sampleRule, Cents.make(100)), 350);
  assertEquals(total(pending, sampleRule), 3500);
});

Deno.test("price evaluates a rule tree built in TypeScript", () => {
  const rule = Sum.make({
    parts: [
      Fixed.make({ amount: Cents.make(50) }),
      Sum.make({ parts: [Fixed.make({ amount: Cents.make(7) })] }),
    ],
  });
  assertEquals(price(rule, pending.total), 57);
});

Deno.test("fromInput decodes valid input into Pending", () => {
  assertEquals(pending._tag, "contracts#Pending");
  assertEquals(pending.id, "o1");
  assertEquals(pending.total, 1000);
});

Deno.test("fromInput rejects invalid input with SchemaError", () => {
  const exit = Effect.runSyncExit(fromInput({ id: 1, total: "x" }));
  assert(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause);
  assert(error instanceof Schema.SchemaError, String(error));
});

Deno.test("encoded form keeps _tag and round-trips", () => {
  const tags = ["Pending", "Paid", "Shipped", "Cancelled"];
  states.forEach((order, index) => {
    const encoded = Effect.runSync(encodeOrder(order));
    assertEquals(encoded._tag, `contracts#${tags[index]}`);
    const json = JSON.parse(JSON.stringify(encoded));
    assertEquals(Effect.runSync(decodeOrder(json)), order);
  });
});

Deno.test("decode rejects JSON with a wrong or missing _tag", () => {
  const wrong = Effect.runSyncExit(
    decodeOrder({ _tag: "contracts#Nope", id: "o1", total: 1 }),
  );
  assert(Exit.isFailure(wrong));
  const missing = Effect.runSyncExit(decodeOrder({ id: "o1", total: 1 }));
  assert(Exit.isFailure(missing));
});

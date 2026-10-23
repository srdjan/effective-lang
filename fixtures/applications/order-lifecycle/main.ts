import { Effect } from "effect";
import { Capped, Cents, Fixed, Sum, Times } from "./contracts.ts";
import {
  cancelAny,
  describe,
  fromInput,
  pay,
  price,
  sampleRule,
  ship,
  stateOf,
} from "./orders.ts";

const pending = Effect.runSync(fromInput({ id: "o1", total: 1000 }));
const paid = pay(pending, { number: "R1" });
const shipped = ship(paid, { code: "T1" });
const hostRule = Sum.make({
  parts: [
    Fixed.make({ amount: Cents.make(50) }),
    Capped.make({
      rule: Times.make({ factor: 3 }),
      cap: Cents.make(2000),
    }),
  ],
});
const rejected = Effect.runSyncExit(cancelAny(shipped, { note: "late" }));
console.log(JSON.stringify({
  tags: [pending._tag, paid._tag, shipped._tag],
  states: [pending, paid, shipped].map(stateOf),
  described: [pending, paid, shipped].map(describe),
  sampleRulePrice: price(sampleRule, pending.total),
  hostRulePrice: price(hostRule, pending.total),
  rejected: rejected._tag,
}));

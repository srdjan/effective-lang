import { Effect } from "effect";
import { makeDriver } from "./driver.ts";
import { submit } from "./workflow.ts";
const driver = makeDriver();
const receipt = await Effect.runPromise(
  submit({ sku: "book", quantity: 2 }).pipe(Effect.provide(driver.layer)),
);
console.log(
  JSON.stringify({
    receipt,
    committed: driver.committed,
    active: driver.active.size,
  }),
);

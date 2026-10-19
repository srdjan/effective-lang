import { Effect } from "effect";
import { makeDriver } from "./driver.ts";
import { runProcessor } from "./processor.ts";
const driver = makeDriver();
await Effect.runPromise(runProcessor().pipe(Effect.provide(driver.layer)));
console.log(
  JSON.stringify({
    batches: driver.batches,
    active: driver.activeSessions.size,
  }),
);

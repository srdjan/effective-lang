import { Effect } from "effect";
import { makeDriver } from "./driver.ts";
import { runWorker } from "./worker.ts";

// The entry point supplies drivers and runs the source-owned worker.
const driver = makeDriver();
const report = await Effect.runPromise(
  runWorker({
    runs: 3,
    delayMillis: 5,
    retries: 2,
    retryMillis: 1,
  }).pipe(Effect.provide(driver.layer)),
);
console.log(JSON.stringify(report));

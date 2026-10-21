// Runs one chain through every pass in a fresh process and prints the diagnostic codes as JSON.
// Usage: deno run chain_cold_probe.ts <form> <links>

import { type ChainForm, chainSource, runAllPasses } from "./chain_helpers.ts";

const [form, links] = Deno.args;
console.log(
  JSON.stringify(runAllPasses(chainSource(form as ChainForm, Number(links)))),
);

// Regenerates fixtures/golden/<module>.ts from fixtures/examples.
// Run it with `deno task golden:update` after a deliberate change of the emitter.

import { emitExamples } from "../tests/helpers.ts";

const directory = new URL("../fixtures/golden/", import.meta.url);
Deno.mkdirSync(directory, { recursive: true });
for (const [name, module] of emitExamples()) {
  Deno.writeTextFileSync(new URL(`${name}.ts`, directory), module.text);
  console.log(`wrote fixtures/golden/${name}.ts`);
}

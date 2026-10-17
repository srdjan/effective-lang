// Regenerates fixtures/golden/<module>.ts from fixtures/examples and from
// fixtures/emit/traverse, the sixth golden module.
// Run it with `deno task golden:update` after a deliberate change of the emitter.

import { emitExamples, emitFiles, projectFiles } from "../tests/helpers.ts";

const directory = new URL("../fixtures/golden/", import.meta.url);
Deno.mkdirSync(directory, { recursive: true });
const traverse = emitFiles(projectFiles("emit/traverse"), ["traverse.eff"]);
for (const [name, module] of [...emitExamples(), ...traverse]) {
  Deno.writeTextFileSync(new URL(`${name}.ts`, directory), module.text);
  console.log(`wrote fixtures/golden/${name}.ts`);
}

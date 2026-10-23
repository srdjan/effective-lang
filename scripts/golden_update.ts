// Regenerates fixtures/golden/<module>.ts from fixtures/examples and from
// fixtures/emit/traverse, the sixth golden module. The companion module of the
// host interface goes to fixtures/golden/host/providers.effi.ts.
// Run it with `deno task golden:update` after a deliberate change of the emitter.

import { emitExamples, emitFiles, projectFiles } from "../tests/helpers.ts";

const directory = new URL("../fixtures/golden/", import.meta.url);
Deno.mkdirSync(directory, { recursive: true });
const traverse = emitFiles(projectFiles("emit/traverse"), ["traverse.eff"]);
for (const module of [...emitExamples().values(), ...traverse.values()]) {
  const file = new URL(module.path, directory);
  Deno.mkdirSync(new URL(".", file), { recursive: true });
  Deno.writeTextFileSync(file, module.text);
  console.log(`wrote fixtures/golden/${module.path}`);
}

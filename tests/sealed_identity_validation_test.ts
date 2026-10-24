import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  type ModuleIR,
  validateProject,
} from "../src/core/mod.ts";

function lowered(files: Readonly<Record<string, string>>) {
  const checked = checkProject(
    memoryHost({ "effektive.json": "{}", ...files }),
    "",
    ["main.eff"],
  );
  assert(checked.ok, JSON.stringify(checked));
  assertEquals(checked.value.diagnostics, []);
  const modules = lowerProject(checked.value);
  for (const result of modules.values()) assert(result.ok);
  return { project: checked.value.analysis.project, modules };
}

Deno.test("an imported sealed type cannot claim the consumer's identity", () => {
  const base = lowered({
    "lib.eff": "export type Positive = int\n",
    "main.eff":
      'import { Positive } from "./lib.eff"\nexport const make = (): Positive => Positive(1)\n',
  });
  const main = base.modules.get("main");
  assert(main?.ok);
  const forged = JSON.parse(
    JSON.stringify(main.value).replaceAll(
      "type:lib#Positive",
      "type:main#Positive",
    ),
  ) as ModuleIR;
  const declaration = forged.imports.flatMap((item) => item.types).find((
    item,
  ) => item.id === "type:main#Positive");
  assert(declaration?.definition.kind === "nominal");
  Object.assign(declaration.definition, { sealed: true });
  const modules = new Map(base.modules);
  modules.set("main", { ok: true, value: forged });
  const diagnostics = validateProject(base.project, modules).get("main") ?? [];
  assert(
    diagnostics.some((item) => item.code === "validation/001"),
    JSON.stringify(diagnostics),
  );
});

Deno.test("project validation binds an IR module to its lowered map key", () => {
  const base = lowered({
    "main.eff":
      "export sealed type Positive = int\nexport const make = (): Positive => Positive(1)\n",
  });
  const main = base.modules.get("main");
  assert(main?.ok);
  const forged = JSON.parse(
    JSON.stringify(main.value).replaceAll('"main"', '"other"').replaceAll(
      ":main#",
      ":other#",
    ),
  ) as ModuleIR;
  const modules = new Map(base.modules);
  modules.set("main", { ok: true, value: forged });
  const diagnostics = validateProject(base.project, modules).get("main") ?? [];
  assert(
    diagnostics.some((item) => item.code === "validation/001"),
    JSON.stringify(diagnostics),
  );
});

Deno.test("import payloads keep supporting types from a third module", () => {
  const base = lowered({
    "domain.eff":
      "export sealed type Positive = int\nexport const positive = (): Positive => Positive(1)\n",
    "lib.eff":
      'import { Positive, positive } from "./domain.eff"\nexport const read = (): Positive => positive()\n',
    "main.eff":
      'import { read } from "./lib.eff"\nconst result = () => read()\n',
  });
  for (
    const diagnostics of validateProject(base.project, base.modules).values()
  ) {
    assertEquals(diagnostics, []);
  }
});

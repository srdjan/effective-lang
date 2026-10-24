// The final record of a `layer` acquire body gets the method shapes of the
// service, so its method lambdas need no parameter annotations.

import { assert, assertEquals } from "@std/assert";
import type { CheckedProject } from "../src/core/mod.ts";
import type { ValueId } from "../src/core/ir.ts";
import { checkModule } from "./helpers.ts";

const SERVICE = `type Int = int
type Text = string
service Store {
  save(value: Int, label: Text): Text
  size(): Int
}
`;

const codes = (source: string): string[] =>
  checkModule(source, "main.eff").diagnostics.map((d) => d.code);

/** The shown parameter types of every arrow in a checked constant. */
function arrowParameters(project: CheckedProject, name: string): string[][] {
  const body = project.modules.get("main")?.functions.get(
    `value:main#${name}` as ValueId,
  );
  assert(body !== undefined, name);
  return [...body.table.facts.values()].flatMap((fact) =>
    fact.kind === "arrow"
      ? [fact.parameters.map((p) => project.table.show(p.type))]
      : []
  );
}

Deno.test("a layer method lambda takes its parameter types from the service", () => {
  const project = checkModule(
    `${SERVICE}const make = () => layer(Store, () => {
  const base = 1
  ({ save: (value, label) => label, size: () => base })
})
`,
    "main.eff",
  );
  assertEquals(project.diagnostics.map((d) => [d.code, d.message]), []);
  // The acquire arrow and `size` take none. Facts come in node order.
  assertEquals(
    arrowParameters(project, "make").map((p) => p.join(",")).sort(),
    ["", "", "Int,Text"],
  );
});

Deno.test("an annotated layer behaves as before", () => {
  assertEquals(
    codes(
      `${SERVICE}const make = () => layer(Store, () => ({ save: (value: Int, label: Text) => label, size: (): Int => 1 }))
`,
    ),
    [],
  );
  assertEquals(
    codes(
      `${SERVICE}const make = () => layer(Store, () => ({ save: (value: Text, label: Text) => label, size: () => 1 }))
`,
    ),
    ["type-mismatch/003"],
  );
});

Deno.test("a layer with a wrong method shape reports the record field", () => {
  assertEquals(
    codes(`${SERVICE}const make = () => layer(Store, () => ({ size: () => 1 }))
`),
    ["type-mismatch/005"],
  );
  assertEquals(
    codes(
      `${SERVICE}const make = () => layer(Store, () => ({ save: (value, label) => value, size: () => 1 }))
`,
    ),
    ["type-mismatch/003"],
  );
});

Deno.test("a layer whose record is not the final literal keeps the layer message", () => {
  const project = checkModule(
    `${SERVICE}const make = () => layer(Store, () => {
  const methods = { save: (value: Int, label: Text) => value, size: () => 1 }
  methods
})
`,
    "main.eff",
  );
  assertEquals(
    project.diagnostics.map((d) => [d.code, d.message]),
    [[
      "type-mismatch/010",
      "`layer` method save does not fit its service contract",
    ]],
  );
});

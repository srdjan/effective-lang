import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
const base = new URL(
  "../fixtures/applications/service-workflow/",
  import.meta.url,
);
const files = Object.fromEntries(
  ["effective.json", "contracts.eff", "host.effi", "workflow.eff"].map((
    name,
  ) => [name, Deno.readTextFileSync(new URL(name, base))]),
);
function checked(source = files["workflow.eff"]) {
  const result = checkProject(
    memoryHost({ ...files, "workflow.eff": source }),
    "",
    ["workflow.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
Deno.test("service workflow validates and retains provider requirements while discharging Store", () => {
  const project = checked();
  assertEquals(project.diagnostics, []);
  const lowered = lowerProject(project);
  for (const result of lowered.values()) {
    assert(result.ok, JSON.stringify(result));
  }
  for (
    const diagnostics of validateProject(project.analysis.project, lowered)
      .values()
  ) assertEquals(diagnostics, []);
});
Deno.test("service workflow rejects erased result, failure and retained service contracts", () => {
  for (
    const error of [
      "SchemaError",
      "InvalidOrder",
      "CatalogFailure",
      "StoreFailure",
    ]
  ) {
    const source = files["workflow.eff"].replace(
      "fails SchemaError | InvalidOrder | CatalogFailure | StoreFailure",
      "fails " +
        ["SchemaError", "InvalidOrder", "CatalogFailure", "StoreFailure"]
          .filter((name) => name !== error).join(" | "),
    );
    assert(
      checked(source).diagnostics.some((d) =>
        d.code === "failure-contract/001"
      ),
      error,
    );
  }
  for (const service of ["Catalog.price", "Runtime.database"]) {
    const source = files["workflow.eff"].replace(
      "uses Catalog.price | Runtime.database",
      "uses " +
        (service === "Catalog.price" ? "Runtime.database" : "Catalog.price"),
    );
    assert(
      checked(source).diagnostics.some((d) =>
        d.code === "requirement-contract/001"
      ),
      service,
    );
  }
  assert(
    checked(
      files["workflow.eff"].replace(
        "(input: unknown): Receipt",
        "(input: unknown): Int",
      ),
    ).diagnostics.some((d) => d.category === "type-mismatch"),
  );
});

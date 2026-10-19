import { assert, assertEquals } from "@std/assert";
import {
  checkProject,
  lowerProject,
  memoryHost,
  validateProject,
} from "../src/core/mod.ts";
const base = new URL(
  "../fixtures/applications/stream-processor/",
  import.meta.url,
);
const files = Object.fromEntries(
  ["effective.json", "contracts.eff", "processor.eff"].map((
    name,
  ) => [name, Deno.readTextFileSync(new URL(name, base))]),
);
const failures = ["InputFailure", "TransformFailure", "OutputFailure"];
const services = [
  "Input.open",
  "Input.next",
  "Input.close",
  "Transform.apply",
  "Output.open",
  "Output.write",
  "Output.close",
];
function checked(source = files["processor.eff"]) {
  const result = checkProject(
    memoryHost({ ...files, "processor.eff": source }),
    "",
    ["processor.eff"],
  );
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
Deno.test("stream processor validates linked IR with all deferred failure and service channels", () => {
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
Deno.test("stream processor rejects erased exported failure, service and result contracts", () => {
  const source = files["processor.eff"];
  const start = source.indexOf("export const runProcessor");
  const prefix = source.slice(0, start);
  const exported = source.slice(start);
  for (const failure of failures) {
    const erased = exported.replace(
      "fails " + failures.join(" | "),
      "fails " + failures.filter((name) => name !== failure).join(" | "),
    );
    assert(
      checked(prefix + erased).diagnostics.some((d) =>
        d.code === "failure-contract/001"
      ),
      failure,
    );
  }
  for (const service of services) {
    const erased = exported.replace(
      "uses " + services.join(" | "),
      "uses " + services.filter((name) => name !== service).join(" | "),
    );
    assert(
      checked(prefix + erased).diagnostics.some((d) =>
        d.code === "requirement-contract/001"
      ),
      service,
    );
  }
  assert(
    checked(prefix + exported.replace("(): void", "(): Int")).diagnostics.some((
      d,
    ) => d.category === "type-mismatch"),
  );
});

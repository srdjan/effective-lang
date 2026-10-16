// Tests for the synthetic module generator of the measurement harness. Each
// size must check with no diagnostics, lower, validate with no diagnostics,
// and emit. Generation must be deterministic.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  checkProject,
  emitProject,
  lowerProject,
  memoryHost,
  Program,
  validateProject,
} from "../src/core/mod.ts";
import {
  applyBodyEdit,
  applyInterfaceEdit,
  countDeclarations,
  type GeneratedProject,
  generateProject,
  generateSize,
  MIN_DECLARATIONS,
  SIZE_NAMES,
  SIZES,
} from "../bench/generate.ts";

function entriesOf(project: GeneratedProject): string[] {
  return [...project.sources.keys()].filter((p) => p.endsWith(".eff")).sort();
}

for (const size of SIZE_NAMES) {
  Deno.test(`the ${size} project checks, lowers, validates, and emits with no diagnostic`, () => {
    const project = generateSize(size);
    assertEquals(project.declarations, SIZES[size]);
    assertEquals(countDeclarations(project), SIZES[size]);
    const checked = checkProject(
      memoryHost(project.sources),
      "",
      entriesOf(project),
    );
    assert(checked.ok);
    assertEquals(
      checked.value.diagnostics.map((d) => `${d.span.source}: ${d.code}`),
      [],
    );
    const lowered = lowerProject(checked.value);
    for (const [name, result] of lowered) {
      assert(result.ok, `${name} does not lower`);
    }
    const validation = validateProject(checked.value.analysis.project, lowered);
    for (const [name, found] of validation) {
      assertEquals(found.map((d) => d.code), [], `${name} does not validate`);
    }
    const emitted = emitProject(lowered, {
      config: checked.value.analysis.project.config,
    });
    assertEquals(emitted.size, lowered.size);
    for (const [name, result] of emitted) {
      assert(result.ok, `${name} does not emit`);
    }
  });
}

Deno.test("generation is deterministic for a seed and differs between seeds", () => {
  const a = generateProject({ declarations: 120, seed: 7 });
  const b = generateProject({ declarations: 120, seed: 7 });
  assertEquals([...a.sources], [...b.sources]);
  assertEquals([...a.hostModules], [...b.hostModules]);
  const c = generateProject({ declarations: 120, seed: 8 });
  assertNotEquals([...a.sources], [...c.sources]);
});

Deno.test("the declaration count is exact for sizes that do not match a module share", () => {
  for (const declarations of [MIN_DECLARATIONS, 17, 61, 125]) {
    const project = generateProject({ declarations, seed: 3 });
    assertEquals(countDeclarations(project), declarations);
  }
});

Deno.test("the generator rejects a size below the minimum", () => {
  let message = "";
  try {
    generateProject({ declarations: MIN_DECLARATIONS - 1, seed: 1 });
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes("at least"));
});

Deno.test("the medium project uses the language features of the examples", () => {
  const project = generateSize("medium");
  const text = [...project.sources.values()].join("\n");
  const features: [string, RegExp][] = [
    ["brand", /Brand<string>/],
    ["error", /^export error /m],
    ["service", /^export service /m],
    ["provider", /^export provider /m],
    ["host import", /from "host:providers"/],
    ["explicit contract", /\n {2}fails \w+\n {2}uses /],
    ["inferred contract", /^const \w+ = \(\w+: \w+(, \w+: \w+)*\) =>/m],
    ["match", /\bmatch /],
    ["try and catch", /\btry \{[\s\S]*?\} catch \{/],
    ["retry", /\bretry\(/],
    ["provide", /\bprovide\(/],
    ["pipeline", /\|> /],
    ["map", /\|> map\(/],
    ["filter", /\|> filter\(/],
    ["fold", /\|> fold\(/],
    ["record spread", /\{ \.\.\.\w+,/],
    ["option", /Option<\w+>/],
    ["optional field", /\w+\?: string/],
  ];
  for (const [name, pattern] of features) {
    assert(pattern.test(text), `no ${name} in the medium project`);
  }
  assert(project.hostModules.has("store-live.ts"));
});

Deno.test("a body edit rechecks one module and an interface edit rechecks its importers", () => {
  const project = generateSize("medium");
  const program = new Program("");
  const first = program.update({ set: project.sources });
  assert(first.ok);
  assertEquals(first.value.diagnostics, []);
  const original = project.sources.get(project.edit.path) ?? "";

  const bodyText = applyBodyEdit(original, 2);
  assertNotEquals(bodyText, original);
  const body = program.update({ set: { [project.edit.path]: bodyText } });
  assert(body.ok);
  assertEquals(body.value.diagnostics, []);
  assertEquals(
    body.value.rechecked,
    [project.edit.path.replace(/\.eff$/, "")],
  );

  const interfaceText = applyInterfaceEdit(bodyText);
  assertNotEquals(interfaceText, bodyText);
  const changed = program.update({
    set: { [project.edit.path]: interfaceText },
  });
  assert(changed.ok);
  assertEquals(changed.value.diagnostics, []);
  assert(changed.value.rechecked.length > 1);
  assert(
    changed.value.rechecked.includes(
      project.edit.importer.replace(/\.eff$/, ""),
    ),
  );
  // A second interface edit toggles the type back and changes the interface again.
  const toggled = applyInterfaceEdit(interfaceText);
  assertNotEquals(toggled, interfaceText);
});

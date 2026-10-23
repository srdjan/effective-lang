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
  type Revision,
  revisionDelta,
  validateProject,
} from "../src/core/mod.ts";
import {
  allFiles,
  applyAliasEdit,
  applyBodyEdit,
  applyExamplesBodyEdit,
  applyInterfaceEdit,
  applyModeFlipEdit,
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
    ["nominal type", /^export nominal \w+ = string$/m],
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

// ------------------------------------------------------------------ edit scripts of the language server measurements

/** Loads the files into a program and returns it with its first revision. */
function loadedProgram(files: ReadonlyMap<string, string>): {
  program: Program;
  revision: Revision;
} {
  const program = new Program("");
  const first = program.update({ set: files });
  assert(first.ok);
  assertEquals(first.value.diagnostics, []);
  return { program, revision: first.value };
}

/** Applies each text in turn and checks the delta of every step. */
function replay(
  files: ReadonlyMap<string, string>,
  path: string,
  texts: readonly string[],
  expectInterface: boolean,
  expectMode: boolean,
): void {
  const module = path.replace(/\.eff$/, "");
  const loaded = loadedProgram(files);
  const program = loaded.program;
  let revision = loaded.revision;
  let previousText = files.get(path) ?? "";
  for (const text of texts) {
    assertNotEquals(text, previousText);
    const next = program.update({ set: { [path]: text } });
    assert(next.ok);
    assertEquals(next.value.diagnostics, []);
    const delta = revisionDelta(revision, next.value);
    assertEquals(delta.interfaceChanged.includes(module), expectInterface);
    assertEquals(delta.modeChanged.includes(module), expectMode);
    revision = next.value;
    previousText = text;
  }
}

Deno.test("the alias edit changes the interface of the edited module in both states", () => {
  const project = generateSize("small");
  const original = project.sources.get(project.edit.path) ?? "";
  const once = applyAliasEdit(original);
  const twice = applyAliasEdit(once);
  assertEquals(twice, original);
  replay(allFiles(project), project.edit.path, [once, twice], true, false);
});

Deno.test("the mode flip edit changes the mode map and the interface in both states", () => {
  const project = generateSize("small");
  const original = project.sources.get(project.edit.path) ?? "";
  const once = applyModeFlipEdit(original);
  assert(once.includes("retry(() => n + 1, { times: 1 })"));
  const twice = applyModeFlipEdit(once);
  assertEquals(twice, original);
  replay(allFiles(project), project.edit.path, [once, twice], true, true);
});

Deno.test("the examples body edit keeps the interface and the modes", () => {
  const files = new Map<string, string>();
  const root = new URL("../fixtures/examples/", import.meta.url);
  const read = (url: URL, prefix: string) => {
    for (const entry of Deno.readDirSync(url)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), url);
      if (entry.isDirectory) read(child, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, Deno.readTextFileSync(child));
    }
  };
  read(root, "");
  const original = files.get("users.eff") ?? "";
  const first = applyExamplesBodyEdit(original, 1);
  const second = applyExamplesBodyEdit(first, 2);
  assert(first.includes('UserMissing(error) => "Guest1"'));
  assert(second.includes('UserMissing(error) => "Guest2"'));
  replay(files, "users.eff", [first, second], false, false);
});

Deno.test("the body and header edits keep their behavior with the new prologue", () => {
  const project = generateSize("small");
  const original = project.sources.get(project.edit.path) ?? "";
  assert(original.includes("export const flip = (n: Int): Int => n + 1"));
  assert(original.includes("export type Amount = int"));
  assert(original.includes("export const scale = (a: Amount): Amount => a"));
  const body = applyBodyEdit(original, 2);
  replay(allFiles(project), project.edit.path, [body], false, false);
  const header = applyInterfaceEdit(original);
  assert(header.includes("export const extra: Num = 1"));
  replay(allFiles(project), project.edit.path, [header], true, false);
});

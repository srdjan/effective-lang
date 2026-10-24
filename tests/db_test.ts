import { TypeScriptOutputs } from "../src/core/typescript.ts";
const outputs = new TypeScriptOutputs();
// Tests for the program of part A7: the memo, the module cutoff, and the
// differential check against a run from scratch.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { Program, type Revision, revisionDelta } from "../src/core/db.ts";
import { emitProject } from "../src/core/typescript.ts";
import {
  buildSourceMap,
  serializeSourceMap,
} from "../src/core/emit/sourcemap.ts";
import { buildSpanTable, hostImportSpans } from "../src/core/emit/spans.ts";
import { serializeModule } from "../src/core/serialize.ts";
import { memoryHost } from "../src/core/source.ts";
import { lowerProject } from "../src/core/lower.ts";
import { exampleFiles } from "./helpers.ts";

type Files = Record<string, string>;

/** What a run from scratch gives for the files. Compared with the program. */
function fromScratch(files: Files): unknown {
  const entries = Object.keys(files).filter((p) => p.endsWith(".eff")).sort();
  const checked = checkProject(memoryHost(files), "", entries);
  if (!checked.ok) return { config: checked.error };
  const lowered = lowerProject(checked.value);
  const emitted = emitProject(lowered, {
    config: checked.value.analysis.project.config,
  });
  const imports = hostImportSpans(checked.value.analysis.project);
  const texts = new Map(Object.entries(files));
  const modules: Record<string, unknown> = {};
  for (const [name, result] of lowered) {
    const out = emitted.get(name);
    const ir = result.ok ? serializeModule(result.value) : result;
    const text = out?.ok ? out.value.text : out;
    const map = out?.ok
      ? buildSourceMap(buildSpanTable(out.value, imports.get(name)), texts)
      : out;
    modules[name] = {
      ir,
      text,
      map: map?.ok ? serializeSourceMap(map.value) : map,
    };
  }
  return { diagnostics: checked.value.diagnostics, modules };
}

/** What the revision of the program gives, in the same shape. */
function fromProgram(revision: Revision): unknown {
  const modules: Record<string, unknown> = {};
  for (const name of revision.moduleNames()) {
    const result = revision.lowered(name);
    const out = outputs.emitted(revision, name);
    if (result === undefined) continue;
    const ir = result.ok ? serializeModule(result.value) : result;
    const text = out?.ok ? out.value.text : out;
    const map = outputs.sourceMap(revision, name);
    modules[name] = {
      ir,
      text,
      map: map?.ok ? serializeSourceMap(map.value) : map,
    };
  }
  return { diagnostics: revision.diagnostics, modules };
}

/** Sorts the module keys, because the order of modules is not part of the comparison. */
function sortedKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const record = value as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = sortedKeys(record[key]);
  }
  return out;
}

class Session {
  readonly files: Files;
  readonly program = new Program("");
  last: Revision | undefined;

  constructor(files: Files) {
    this.files = { ...files };
  }

  /** Applies the change, starts a revision, and compares it with a run from scratch. */
  apply(set: Files, remove: readonly string[] = []): Revision {
    Object.assign(this.files, set);
    for (const path of remove) delete this.files[path];
    const result = this.program.update({ set, remove });
    const expected = fromScratch(this.files);
    assert(result.ok, JSON.stringify(result));
    assertEquals(
      sortedKeys(fromProgram(result.value)),
      sortedKeys(expected),
    );
    this.last = result.value;
    return result.value;
  }
}

const USERS = "users.eff";

Deno.test("incremental alias and brand edits equal fresh checks across dependents and removal", () => {
  const alias = "export type N = int\nexport const n: N = 1\n";
  const brand =
    "export nominal N = int\nexport type M = int\nexport const n: N = M(1)\n";
  const files = {
    "effektive.json": "{}",
    "a.eff": alias,
    "b.eff": 'import { N, n } from "./a.eff"\nexport const copy: N = n\n',
  };
  const session = new Session(files);
  assertEquals(session.apply(files).diagnostics, []);
  const branded = session.apply({ "a.eff": brand });
  assert(branded.diagnostics.some((d) => d.code === "type-mismatch/003"));
  assertEquals(
    session.apply({ "a.eff": brand.replace("= M(1)", "= N(1)") }).diagnostics,
    [],
  );
  assertEquals(session.apply({ "a.eff": alias }).diagnostics, []);
  session.apply({}, ["a.eff"]);
  const restored = session.apply({ "a.eff": brand });
  assert(restored.diagnostics.some((d) => d.code === "type-mismatch/003"));
  assertEquals(session.apply({ "a.eff": alias }).diagnostics, []);
});

// ------------------------------------------------------------------ the memo

Deno.test("the first revision checks every module in topological order", () => {
  const session = new Session(exampleFiles());
  const first = session.apply(exampleFiles());
  assertEquals(first.number, 1);
  assertEquals(first.rechecked, [
    "collections",
    "users",
    "host/providers",
    "log",
    "main",
    "pay",
  ]);
  assertEquals(first.diagnostics, []);
});

Deno.test("an update with no change rechecks nothing and keeps every tree", () => {
  const session = new Session(exampleFiles());
  const first = session.apply(exampleFiles());
  const second = session.apply({});
  assertEquals(second.rechecked, []);
  assertEquals(second.number, 2);
  for (const name of first.moduleNames()) {
    assert(
      first.checkedModule(name)?.tree === second.checkedModule(name)?.tree,
    );
    assert(first.checkedModule(name) === second.checkedModule(name));
  }
  // The lazy queries return the same objects.
  assert(first.lowered("main") === second.lowered("main"));
  assert(outputs.emitted(first, "main") === outputs.emitted(second, "main"));
});

Deno.test("a changed file gets a new tree, and the other files keep theirs", () => {
  const session = new Session(exampleFiles());
  const first = session.apply(exampleFiles());
  const text = exampleFiles()["pay.eff"] + "\n";
  const second = session.apply({ "pay.eff": text });
  assert(
    first.checkedModule("pay")?.tree !== second.checkedModule("pay")?.tree,
  );
  assert(
    first.checkedModule("log")?.tree === second.checkedModule("log")?.tree,
  );
});

// ------------------------------------------------------------------ cutoff (acceptance check 9)

Deno.test("a body edit in users.eff that keeps its interface does not recheck main.eff", () => {
  const files = exampleFiles();
  const session = new Session(files);
  const first = session.apply(files);
  const before = first.interfaceHash("users");
  assert(before !== undefined);
  const edited = files[USERS].replace(
    "None => fail(UserMissing({ id }))",
    "None => fail(UserMissing({ id: id }))",
  );
  assertNotEquals(edited, files[USERS]);
  const second = session.apply({ [USERS]: edited });
  assertEquals(second.interfaceHash("users"), before);
  assertEquals(second.rechecked, ["users"]);
  // main.eff keeps its checked module, its IR, and its emitted text.
  assert(first.checkedModule("main") === second.checkedModule("main"));
  assert(outputs.emitted(first, "main") === outputs.emitted(second, "main"));
});

Deno.test("a body edit that changes the length of users.eff below its types rechecks only users", () => {
  const files = exampleFiles();
  const session = new Session(files);
  const first = session.apply(files);
  const edited = files[USERS].replace(
    '"Guest"',
    '"Guest of the house"',
  );
  assertNotEquals(edited, files[USERS]);
  const second = session.apply({ [USERS]: edited });
  assertEquals(second.interfaceHash("users"), first.interfaceHash("users"));
  assertEquals(second.rechecked, ["users"]);
});

Deno.test("an interface edit in users.eff rechecks main.eff", () => {
  const files = exampleFiles();
  const session = new Session(files);
  const first = session.apply(files);
  const edited = files[USERS].replace(
    "fails StoreUnavailable\n  uses Users.all",
    "fails StoreUnavailable | UserMissing\n  uses Users.all",
  );
  assertNotEquals(edited, files[USERS]);
  const second = session.apply({ [USERS]: edited });
  assertNotEquals(
    second.interfaceHash("users"),
    first.interfaceHash("users"),
  );
  // pay, log, and collections do not reach users.
  assertEquals(second.rechecked, ["users", "host/providers", "main"]);
});

Deno.test("a comment above the types moves their spans, so the importers lower again but do not recheck", () => {
  const files = exampleFiles();
  const session = new Session(files);
  const first = session.apply(files);
  const mainBefore = first.checkedModule("main");
  const irBefore = first.lowered("main");
  const second = session.apply({ [USERS]: "// a comment\n" + files[USERS] });
  // The interface hash leaves spans out and stays equal.
  assertEquals(second.interfaceHash("users"), first.interfaceHash("users"));
  assertEquals(second.rechecked, ["users"]);
  // The checked declarations of main are reused, and its IR is lowered again
  // with the new spans; the session compares that IR with a run from scratch.
  assert(
    second.checkedModule("main")?.declarations === mainBefore?.declarations,
  );
  assert(second.lowered("main") !== irBefore);
});

// ------------------------------------------------------------------ the differential test

Deno.test("differential: a sequence of edits equals a run from scratch after each revision", () => {
  const files = exampleFiles();
  const session = new Session(files);
  session.apply(files);

  // A body edit in users.eff.
  const body = files[USERS].replace(
    "None => fail(UserMissing({ id }))",
    "None => fail(UserMissing({ id: id }))",
  );
  session.apply({ [USERS]: body });

  // An interface edit in users.eff.
  const iface = body.replace(
    "fails StoreUnavailable\n  uses Users.all",
    "fails StoreUnavailable | UserMissing\n  uses Users.all",
  );
  const edited = session.apply({ [USERS]: iface });
  assertEquals(edited.rechecked, ["users", "host/providers", "main"]);

  // A syntax error, then its fix.
  const broken = iface + "\nexport const broken = (\n";
  const withError = session.apply({ [USERS]: broken });
  assert(withError.diagnostics.some((d) => d.code.startsWith("syntax/")));
  const fixed = session.apply({ [USERS]: iface });
  assertEquals(fixed.diagnostics, []);

  // An edit above the types moves their spans, then it is undone.
  session.apply({ [USERS]: "// a comment\n" + iface });
  session.apply({ [USERS]: iface });

  // A new file that imports users.
  const extra = [
    'import { User } from "./users.eff"',
    "",
    "export const nameOf = (user: User): Text => user.name",
    "",
    "type Text = string",
    "",
  ].join("\n");
  const added = session.apply({ "extra.eff": extra });
  assertEquals(added.rechecked, ["extra"]);
  assertEquals(added.diagnostics, []);

  // A removed import: main.eff loses the import of the provider.
  const mainText = files["main.eff"];
  const noImport = mainText.replace(
    'import { UsersLive } from "host:providers"\n',
    "",
  );
  assertNotEquals(noImport, mainText);
  const missing = session.apply({ "main.eff": noImport });
  assert(missing.diagnostics.some((d) => d.code.startsWith("unknown-name/")));
  const restored = session.apply({ "main.eff": mainText });
  assertEquals(restored.diagnostics, []);

  // A removed file: users.eff disappears.
  const gone = session.apply({}, [USERS]);
  assert(gone.diagnostics.length > 0);
  const back = session.apply({ [USERS]: iface });
  assertEquals(back.diagnostics, []);

  // A removed file that nothing imports.
  const removedExtra = session.apply({}, ["extra.eff"]);
  assertEquals(removedExtra.moduleNames().includes("extra"), false);
});

Deno.test("differential: a broken project file is an error value, and a fix brings the program back", () => {
  const files = exampleFiles();
  const program = new Program("");
  const first = program.update({ set: files });
  assert(first.ok);
  const broken = program.update({ set: { "effektive.json": "{" } });
  assert(!broken.ok);
  assertEquals(broken.error.tag, "malformed-json");
  assertEquals(fromScratch({ ...files, "effektive.json": "{" }), {
    config: broken.error,
  });
  const fixed = program.update({
    set: { "effektive.json": files["effektive.json"] },
  });
  assert(fixed.ok);
  // Every module has the same key as before the break, so none is checked again.
  assertEquals(fixed.value.rechecked, []);
  assertEquals(
    sortedKeys(fromProgram(fixed.value)),
    sortedKeys(fromScratch(files)),
  );
});

Deno.test("a host registry change rechecks the importers of the host module", () => {
  const files = exampleFiles();
  const session = new Session(files);
  session.apply(files);
  const config = JSON.stringify({
    host: {
      providers: {
        interface: "./host/providers.effi",
        module: "./other/users-live.ts",
      },
    },
  });
  const second = session.apply({ "effektive.json": config });
  // The registry is part of every key, so every module checks again.
  assertEquals(second.rechecked.length, 6);
});

// ------------------------------------------------------------------ query counts

function updated(program: Program, set: Files = {}): Revision {
  const result = program.update({ set });
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

Deno.test("counts: a cold update parses and checks every module and lowers nothing", () => {
  const program = new Program("");
  assertEquals(program.counts, {
    parses: 0,
    checks: 0,
    lowerings: 0,
  });
  updated(program, exampleFiles());
  // Five .eff files and the .effi file that main.eff imports.
  assertEquals(program.counts, {
    parses: 6,
    checks: 6,
    lowerings: 0,
  });
});

Deno.test("counts: a body edit parses and checks one module, an interface edit checks its importers", () => {
  const files = exampleFiles();
  const program = new Program("");
  updated(program, files);
  const body = files[USERS].replace(
    "None => fail(UserMissing({ id }))",
    "None => fail(UserMissing({ id: id }))",
  );
  assertNotEquals(body, files[USERS]);
  updated(program, { [USERS]: body });
  assertEquals(program.counts, {
    parses: 7,
    checks: 7,
    lowerings: 0,
  });
  const iface = body.replace(
    "fails StoreUnavailable\n  uses Users.all",
    "fails StoreUnavailable | UserMissing\n  uses Users.all",
  );
  updated(program, { [USERS]: iface });
  // users, host/providers, and main check again.
  assertEquals(program.counts, {
    parses: 8,
    checks: 10,
    lowerings: 0,
  });
  // An update with no change adds nothing.
  updated(program);
  assertEquals(program.counts, {
    parses: 8,
    checks: 10,
    lowerings: 0,
  });
});

Deno.test("counts: lowerings and emits count once per module and revision, and not on a memo hit", () => {
  const outputs = new TypeScriptOutputs();
  const program = new Program("");
  const first = updated(program, exampleFiles());
  first.lowered("main");
  first.lowered("main");
  assertEquals(program.counts.lowerings, 1);
  assertEquals(outputs.counts.emits, 0);
  outputs.emitted(first, "main");
  outputs.emitted(first, "main");
  outputs.emitted(first, "pay");
  assertEquals(program.counts.lowerings, 2);
  assertEquals(outputs.counts.emits, 2);
  // The next revision reuses the memo entries of both modules.
  const second = updated(program);
  second.lowered("main");
  outputs.emitted(second, "main");
  outputs.emitted(second, "pay");
  assertEquals(program.counts.lowerings, 2);
  assertEquals(outputs.counts.emits, 2);
  // The counts are a snapshot: an earlier value does not change.
  const before = outputs.counts;
  outputs.emitted(second, "log");
  assertEquals(before.emits, 2);
  assertEquals(outputs.counts.emits, 3);
});

// ------------------------------------------------------------------ revision delta

const FLIP_PURE =
  "export const flip = (n: Int): Int => n + 1\n\ntype Int = int\n";
const FLIP_EFFECT =
  "export const flip = (n: Int): Int => retry(() => n + 1, { times: 1 })\n\ntype Int = int\n";

Deno.test("revisionDelta: no change and a body edit change nothing, an interface edit changes the interface", () => {
  const files = exampleFiles();
  const program = new Program("");
  const first = updated(program, files);
  const same = updated(program);
  assertEquals(revisionDelta(first, same), {
    interfaceChanged: [],
    modeChanged: [],
  });
  const body = files[USERS].replace(
    "None => fail(UserMissing({ id }))",
    "None => fail(UserMissing({ id: id }))",
  );
  const edited = updated(program, { [USERS]: body });
  assertEquals(revisionDelta(same, edited), {
    interfaceChanged: [],
    modeChanged: [],
  });
  const iface = body.replace(
    "fails StoreUnavailable\n  uses Users.all",
    "fails StoreUnavailable | UserMissing\n  uses Users.all",
  );
  const changed = updated(program, { [USERS]: iface });
  const delta = revisionDelta(edited, changed);
  assert(delta.interfaceChanged.includes("users"));
  assertEquals(delta.modeChanged, []);
  // The lists follow the module order of the later revision.
  const order = changed.moduleNames();
  assertEquals(
    delta.interfaceChanged,
    order.filter((name) => delta.interfaceChanged.includes(name)),
  );
});

Deno.test("revisionDelta: a mode flip appears in both lists", () => {
  const program = new Program("");
  const pure = updated(program, { "effektive.json": "{}", "m.eff": FLIP_PURE });
  assertEquals(pure.diagnostics, []);
  assertEquals([...pure.checkedModule("m")!.modes.values()], ["pure"]);
  const effect = updated(program, { "m.eff": FLIP_EFFECT });
  assertEquals(effect.diagnostics, []);
  assertEquals([...effect.checkedModule("m")!.modes.values()], ["effect"]);
  assertEquals(revisionDelta(pure, effect), {
    interfaceChanged: ["m"],
    modeChanged: ["m"],
  });
  assertEquals(revisionDelta(effect, pure), {
    interfaceChanged: ["m"],
    modeChanged: ["m"],
  });
});

Deno.test("revisionDelta: a module absent from the previous revision, or no previous revision, counts as changed", () => {
  const program = new Program("");
  const first = updated(program, exampleFiles());
  assertEquals(
    revisionDelta(undefined, first),
    {
      interfaceChanged: [...first.moduleNames()],
      modeChanged: [...first.moduleNames()],
    },
  );
  const extra = updated(program, {
    "extra.eff": "export const one = (): Int => 1\n\ntype Int = int\n",
  });
  assertEquals(revisionDelta(first, extra), {
    interfaceChanged: ["extra"],
    modeChanged: ["extra"],
  });
});

Deno.test("revision queries: path lookups, imports, declaration entries, and module order", () => {
  const result = new Program("").update({
    set: {
      "effektive.json": "{}",
      "a.eff": 'import { N, n } from "./b.eff"\nexport const copy: N = n\n',
      "b.eff": "export type N = int\nexport const n: N = 1\n",
    },
  });
  assert(result.ok, JSON.stringify(result));
  const revision = result.value;
  assertEquals(revision.diagnostics, []);

  // Discovery order follows the sorted entry paths. The checking order puts
  // the imported module first.
  assertEquals([...revision.moduleInfos()].map((info) => info.name), [
    "a",
    "b",
  ]);
  assertEquals(revision.moduleNames(), ["b", "a"]);

  assertEquals(revision.moduleInfoAt("a.eff")?.name, "a");
  assertEquals(revision.moduleInfoAt("b.eff")?.name, "b");
  assertEquals(revision.moduleInfoAt("c.eff"), undefined);
  assertEquals(revision.checkedModuleAt("a.eff"), revision.checkedModule("a"));
  assertEquals(revision.checkedModuleAt("c.eff"), undefined);

  assertEquals(revision.imports("a"), ["b"]);
  assertEquals(revision.imports("b"), []);
  assertEquals(revision.imports("missing"), []);

  assertEquals(revision.declEntry("type:b#N")?.name, "N");
  assertEquals(revision.declEntry("value:b#n")?.name, "n");
  assertEquals(revision.declEntry("type:b#Missing"), undefined);
  assertEquals(revision.declEntry("type:c#N"), undefined);
  assertEquals(revision.declEntry("not an id"), undefined);
});

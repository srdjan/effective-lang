// Tests for the program of part A7: the memo, the module cutoff, and the
// differential check against a run from scratch.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { checkProject } from "../src/core/check_project.ts";
import { Program, type Revision } from "../src/core/db.ts";
import { emitProject } from "../src/core/emit/emit.ts";
import {
  buildSourceMap,
  serializeSourceMap,
} from "../src/core/emit/sourcemap.ts";
import { buildSpanTable, hostImportSpans } from "../src/core/emit/spans.ts";
import { lowerProject } from "../src/core/lower.ts";
import { serializeModule } from "../src/core/serialize.ts";
import { memoryHost } from "../src/core/source.ts";
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
  for (const name of revision.effModuleNames()) {
    const result = revision.lowered(name);
    const out = revision.emitted(name);
    if (result === undefined) continue;
    const ir = result.ok ? serializeModule(result.value) : result;
    const text = out?.ok ? out.value.text : out;
    const map = revision.sourceMap(name);
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
  assert(first.emitted("main") === second.emitted("main"));
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
  assert(first.emitted("main") === second.emitted("main"));
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
    "export const nameOf = (user: User): string => user.name",
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
  const broken = program.update({ set: { "effective.json": "{" } });
  assert(!broken.ok);
  assertEquals(broken.error.tag, "malformed-json");
  assertEquals(fromScratch({ ...files, "effective.json": "{" }), {
    config: broken.error,
  });
  const fixed = program.update({
    set: { "effective.json": files["effective.json"] },
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
  const second = session.apply({ "effective.json": config });
  // The registry is part of every key, so every module checks again.
  assertEquals(second.rechecked.length, 6);
});

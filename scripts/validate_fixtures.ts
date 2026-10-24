// Generates fixtures/validate/ from the current lowering output. Each fixture
// is a lowered example IR with one mutation. The manifest names the expected
// validation code of each fixture.
//
// Run `deno task validate:update` after a deliberate change of the lowering or
// the validator. A test regenerates the files in memory and compares them with
// the files on disk, so the fixtures stay valid and current.

import { checkProject } from "../src/core/check_project.ts";
import { lowerProject } from "../src/core/lower.ts";
import { AREA, validateModule } from "../src/core/validate/index.ts";
import { diskHost, EXAMPLE_ENTRIES } from "../tests/helpers.ts";

type Obj = Record<string, unknown>;

export interface Fixture {
  /** File name under `fixtures/validate/`. */
  readonly file: string;
  /** The expected validation code. */
  readonly code: string;
  /** The area name. */
  readonly area: string;
  /** What the mutation does. */
  readonly mutation: string;
  /** The IR path that the first diagnostic names. */
  readonly path: string;
  /** Source identifier to the fixture path of its text, relative to `fixtures/`. */
  readonly sources: Readonly<Record<string, string>>;
  /** The mutated IR. */
  readonly ir: unknown;
}

// ------------------------------------------------------------------ JSON helpers

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return out;
}

function at(root: unknown, path: string): unknown {
  let current = root;
  for (const key of segments(path)) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) throw new Error(`${path}: not an array`);
      current = current[key];
    } else {
      if (!isObj(current)) throw new Error(`${path}: not an object`);
      current = current[key];
    }
  }
  return current;
}

function obj(root: unknown, path: string): Obj {
  const value = at(root, path);
  if (!isObj(value)) throw new Error(`${path}: not an object`);
  return value;
}

function arr(root: unknown, path: string): unknown[] {
  const value = at(root, path);
  if (!Array.isArray(value)) throw new Error(`${path}: not an array`);
  return value;
}

function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  if (last === undefined) throw new Error("empty path");
  let current = root;
  for (const key of parts) {
    current = typeof key === "number"
      ? (current as unknown[])[key]
      : (current as Obj)[key];
  }
  if (typeof last === "number") (current as unknown[])[last] = value;
  else (current as Obj)[last] = value;
}

function clone(value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return copy;
}

function declIndex(ir: unknown, name: string): number {
  const index = arr(ir, "declarations").findIndex((d) =>
    isObj(d) && d.name === name
  );
  if (index < 0) throw new Error(`no declaration ${name}`);
  return index;
}

/** Canonical JSON: sorted keys, two-space indentation, a trailing newline. */
function canonical(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${
      value.map((v) => `${inner}${canonical(v, inner)}`).join(",\n")
    }\n${indent}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const record = value as Obj;
  return `{\n${
    keys.map((k) =>
      `${inner}${JSON.stringify(k)}: ${canonical(record[k], inner)}`
    )
      .join(",\n")
  }\n${indent}}`;
}

// ------------------------------------------------------------------ bases

const STRING = { kind: "primitive", name: "string" };
const INT = { kind: "primitive", name: "int" };

function span(source: string, start: number, end: number) {
  return { source, start, end };
}

interface Bases {
  readonly modules: ReadonlyMap<string, unknown>;
  readonly texts: ReadonlyMap<string, string>;
}

function lowerBases(): Bases {
  const checked = checkProject(diskHost(), "examples", EXAMPLE_ENTRIES);
  if (!checked.ok) throw new Error(JSON.stringify(checked.error));
  const emptyEffect = checkProject(diskHost(), "ir", [
    "empty-effect.eff",
    "tagged.eff",
  ]);
  if (!emptyEffect.ok) throw new Error(JSON.stringify(emptyEffect.error));
  const modules = new Map<string, unknown>();
  for (const project of [checked.value, emptyEffect.value]) {
    for (const [name, result] of lowerProject(project)) {
      if (!result.ok) {
        throw new Error(`${name}: ${JSON.stringify(result.error)}`);
      }
      modules.set(name, clone(result.value));
    }
  }
  const texts = new Map<string, string>();
  for (const project of [checked.value, emptyEffect.value]) {
    for (const info of project.analysis.project.modules.values()) {
      texts.set(info.path, info.tree.text);
    }
  }
  return { modules, texts };
}

// ------------------------------------------------------------------ mutations

interface Mutation {
  readonly name: string;
  readonly area: keyof typeof AREA;
  readonly base: string;
  readonly mutation: string;
  /** The sources to supply, by source identifier. */
  readonly sources: readonly string[];
  /** Mutates the copy and returns the IR path that the first diagnostic names. */
  readonly apply: (ir: unknown) => string;
}

const LOG = ["log.eff"];
const EMPTY_EFFECT = ["empty-effect.eff"];
const TAGGED = ["tagged.eff"];
const MAIN = ["main.eff", "users.eff"];

const MUTATIONS: readonly Mutation[] = [
  {
    name: "identity-unknown-reference",
    area: "identity",
    base: "log",
    mutation:
      "The reference to the parameter message targets an unknown local.",
    sources: LOG,
    apply(ir) {
      const f = declIndex(ir, "log");
      const path = `declarations[${f}].body.arguments[0]`;
      setAt(ir, `${path}.target`, "local:log#log/missing");
      return `${path}.target`;
    },
  },
  {
    name: "identity-unknown-capability",
    area: "identity",
    base: "log",
    mutation: "The perform node names a capability that no service declares.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "log")}].body`;
      setAt(ir, `${path}.capability`, "cap:log#Console.println");
      return `${path}.capability`;
    },
  },
  {
    name: "identity-undeclared-export",
    area: "identity",
    base: "log",
    mutation: "The module exports an identity that it does not declare.",
    sources: LOG,
    apply(ir) {
      arr(ir, "exports").push("value:log#missing");
      return "exports[1]";
    },
  },
  {
    name: "identity-duplicate-declaration",
    area: "identity",
    base: "log",
    mutation: "The error declaration appears twice.",
    sources: LOG,
    apply(ir) {
      const declarations = arr(ir, "declarations");
      const count = declarations.length;
      declarations.push(clone(declarations[0]));
      return `declarations[${count}].id`;
    },
  },
  {
    name: "types-recorded-string",
    area: "types",
    base: "log",
    mutation:
      "The recorded type of the perform node is string instead of void.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "log")}].body`;
      setAt(ir, `${path}.type`, STRING);
      return `${path}.type`;
    },
  },
  {
    name: "types-literal-as-int",
    area: "types",
    base: "pay",
    mutation: 'The literal "paid" in markPaid is recorded as int.',
    sources: ["pay.eff"],
    apply(ir) {
      const path = `declarations[${
        declIndex(ir, "markPaid")
      }].body.fields[0].value`;
      setAt(ir, `${path}.type`, INT);
      return `${path}.type`;
    },
  },
  {
    name: "types-identity-mismatch",
    area: "types",
    base: "users",
    mutation:
      "The argument of Users.find in getUser is recorded as a Name, but the parameter is a UserId.",
    sources: ["users.eff"],
    apply(ir) {
      const f = declIndex(ir, "getUser");
      const path = `declarations[${f}].body.subject.arguments[0]`;
      setAt(ir, `${path}.type`, { kind: "named", id: "type:users#Name" });
      return `${path}.type`;
    },
  },
  {
    name: "types-binary-identity-result",
    area: "types",
    base: "collections",
    mutation:
      "The body of the fold callback is sum * 2 with the type Amount, and the node is recorded as int.",
    sources: ["collections.eff"],
    apply(ir) {
      const f = declIndex(ir, "total");
      const path = `declarations[${f}].body.result.arguments[2].body`;
      setAt(ir, `${path}.operator`, "*");
      setAt(ir, `${path}.right`, {
        kind: "literal",
        value: 2,
        type: { kind: "literal", value: 2 },
        execution: "pure",
        effects: { failures: [], requirements: [] },
        span: span("collections.eff", 0, 1),
      });
      setAt(ir, `${path}.type`, INT);
      return `${path}.type`;
    },
  },
  {
    name: "types-sealed-literal-foreign",
    area: "types",
    base: "main",
    mutation:
      "The imported UserId is sealed, so the literal argument of displayName in main flows into a foreign sealed identity.",
    sources: MAIN,
    apply(ir) {
      const imports = arr(ir, "imports");
      const users = imports.findIndex((i) => isObj(i) && i.module === "users");
      const types = arr(ir, `imports[${users}].types`);
      const t = types.findIndex((x) =>
        isObj(x) && x.id === "type:users#UserId"
      );
      const path = `imports[${users}].types[${t}].definition`;
      setAt(ir, `${path}.sealed`, true);
      return `declarations[${
        declIndex(ir, "main")
      }].body.job.body.arguments[0]`;
    },
  },
  {
    name: "types-record-into-tagged",
    area: "types",
    base: "tagged",
    mutation:
      "The record literal at Fixed in fixed has no construction: the nominal node is replaced by the record, which is recorded as Fixed.",
    sources: TAGGED,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "fixed")}].body`;
      const record = clone(at(ir, `${path}.value`));
      setAt(record, "type", { kind: "named", id: "type:tagged#Fixed" });
      setAt(ir, path, record);
      return `${path}.type`;
    },
  },
  {
    name: "types-untagged-name-pattern",
    area: "types",
    base: "tagged",
    mutation:
      "Fixed loses its tagged flag, so the name pattern Fixed in amountOf has no tagged member to match.",
    sources: TAGGED,
    apply(ir) {
      const f = declIndex(ir, "Fixed");
      delete obj(ir, `declarations[${f}].definition`).tagged;
      return `declarations[${declIndex(ir, "amountOf")}].body.arms[0].pattern`;
    },
  },
  {
    name: "contracts-dropped-failure",
    area: "contracts",
    base: "log",
    mutation: "The recorded failure set of the perform node is empty.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "log")}].body.effects`;
      setAt(ir, `${path}.failures`, []);
      return `${path}.failures`;
    },
  },
  {
    name: "contracts-body-exceeds-declaration",
    area: "contracts",
    base: "log",
    mutation:
      "The declared failure set of log is empty, but its body can fail.",
    sources: LOG,
    apply(ir) {
      const f = declIndex(ir, "log");
      setAt(ir, `declarations[${f}].type.effects.failures`, []);
      return `declarations[${f}].body`;
    },
  },
  {
    name: "execution-node-pure",
    area: "execution",
    base: "log",
    mutation: "The perform node is recorded as pure.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "log")}].body`;
      setAt(ir, `${path}.execution`, "pure");
      return `${path}.execution`;
    },
  },
  {
    name: "execution-function-pure",
    area: "execution",
    base: "empty-effect",
    mutation: "The empty-row effect function type is recorded as pure.",
    sources: EMPTY_EFFECT,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "empty")}].type`;
      setAt(ir, `${path}.execution`, "pure");
      return `${path}.execution`;
    },
  },
  {
    name: "recovery-absent-handler",
    area: "recovery",
    base: "users",
    mutation:
      "The catch of displayName gets a handler for an error that the protected block cannot raise.",
    sources: ["users.eff"],
    apply(ir) {
      const declarations = arr(ir, "declarations");
      const absent = {
        kind: "error",
        id: "error:users#Absent",
        name: "Absent",
        fields: [],
        span: span("users.eff", 0, 1),
      };
      declarations.unshift(absent);
      const f = declIndex(ir, "displayName");
      const path = `declarations[${f}].body`;
      const handlers = arr(ir, `${path}.handlers`);
      const first = obj(ir, `${path}.handlers[0]`);
      const binding = {
        id: "local:users#displayName/absent",
        name: "absent",
        type: { kind: "named", id: "error:users#Absent" },
        span: span("users.eff", 0, 1),
      };
      const body = clone(first.body);
      handlers.push({
        error: "error:users#Absent",
        binding,
        body,
        span: span("users.eff", 0, 1),
      });
      return `${path}.handlers[${handlers.length - 1}].error`;
    },
  },
  {
    name: "control-retry-negative",
    area: "control",
    base: "pay",
    mutation: "The retry count is -1.",
    sources: ["pay.eff"],
    apply(ir) {
      const path = `declarations[${
        declIndex(ir, "chargeOrder")
      }].body.steps[0].value`;
      setAt(ir, `${path}.times`, -1);
      return `${path}.times`;
    },
  },
  {
    name: "control-provide-job-with-parameter",
    area: "control",
    base: "main",
    mutation: "The provide job takes one parameter.",
    sources: MAIN,
    apply(ir) {
      const job = `declarations[${declIndex(ir, "main")}].body.job`;
      arr(ir, `${job}.parameters`).push({
        id: "local:main#main/extra",
        name: "extra",
        type: STRING,
        span: span("main.eff", 184, 186),
      });
      arr(ir, `${job}.type.parameters`).push(STRING);
      return `declarations[${declIndex(ir, "main")}].body.job`;
    },
  },
  {
    name: "initialization-constant-perform",
    area: "initialization",
    base: "log",
    mutation: "A module constant has a perform node as its initializer.",
    sources: LOG,
    apply(ir) {
      const declarations = arr(ir, "declarations");
      const f = declIndex(ir, "log");
      const perform = clone(at(ir, `declarations[${f}].body`));
      setAt(perform, "arguments[0]", {
        kind: "literal",
        value: "boot",
        type: STRING,
        execution: "pure",
        effects: { failures: [], requirements: [] },
        span: span("log.eff", 0, 1),
      });
      declarations.push({
        kind: "constant",
        id: "value:log#boot",
        name: "boot",
        type: { kind: "primitive", name: "unit" },
        value: perform,
        span: span("log.eff", 0, 1),
      });
      return `declarations[${declarations.length - 1}].value`;
    },
  },
  {
    name: "serialization-unsorted-set",
    area: "serialization",
    base: "main",
    mutation: "A failure set in an import payload is not sorted.",
    sources: MAIN,
    apply(ir) {
      const imports = arr(ir, "imports");
      const users = imports.findIndex((i) => isObj(i) && i.module === "users");
      const values = arr(ir, `imports[${users}].values`);
      const v = values.findIndex((x) =>
        isObj(x) && x.id === "value:users#getUser"
      );
      const path = `imports[${users}].values[${v}].type.effects.failures`;
      arr(ir, path).reverse();
      return path;
    },
  },
  {
    name: "serialization-span-past-end",
    area: "serialization",
    base: "log",
    mutation: "The span of the function body ends after the end of the source.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${declIndex(ir, "log")}].body.span`;
      setAt(ir, `${path}.end`, 100000);
      return path;
    },
  },
  {
    name: "serialization-unknown-source",
    area: "serialization",
    base: "log",
    mutation: "A span names a source that the module does not list.",
    sources: LOG,
    apply(ir) {
      const path = `declarations[${
        declIndex(ir, "log")
      }].body.arguments[0].span`;
      setAt(ir, `${path}.source`, "other.eff");
      return path;
    },
  },
];

// ------------------------------------------------------------------ build

export interface Built {
  /** File name to file text, including `manifest.json`. */
  readonly files: ReadonlyMap<string, string>;
}

/** The sources of a fixture: identifier to the fixture path of its text. */
const SOURCE_PATHS: Readonly<Record<string, string>> = {
  "collections.eff": "examples/collections.eff",
  "empty-effect.eff": "ir/empty-effect.eff",
  "log.eff": "examples/log.eff",
  "main.eff": "examples/main.eff",
  "users.eff": "examples/users.eff",
  "pay.eff": "examples/pay.eff",
  "tagged.eff": "ir/tagged.eff",
};

export function buildFixtures(): Built {
  const bases = lowerBases();
  const files = new Map<string, string>();
  const manifest: Obj[] = [];
  for (const m of MUTATIONS) {
    const base = bases.modules.get(m.base);
    if (base === undefined) throw new Error(`no base module ${m.base}`);
    const ir = clone(base);
    const path = m.apply(ir);
    const sources: Record<string, string> = {};
    for (const id of m.sources) sources[id] = SOURCE_PATHS[id];
    const file = `${m.name}.json`;
    const code = AREA[m.area];
    const found = validateModule(
      ir as Parameters<typeof validateModule>[0],
      new Map(m.sources.map((id) => [id, bases.texts.get(id) ?? ""])),
    );
    const codes = [...new Set(found.map((d) => d.code))];
    if (codes.length !== 1 || codes[0] !== code) {
      throw new Error(
        `${m.name}: expected only ${code}, got ${
          found.map((d) => `${d.code} ${d.message}`).join("; ")
        }`,
      );
    }
    files.set(file, canonical(ir) + "\n");
    manifest.push({
      file,
      code,
      area: m.area,
      mutation: m.mutation,
      path,
      sources,
    });
  }
  files.set("manifest.json", canonical({ fixtures: manifest }) + "\n");
  return { files };
}

if (import.meta.main) {
  const directory = new URL("../fixtures/validate/", import.meta.url);
  Deno.mkdirSync(directory, { recursive: true });
  const built = buildFixtures();
  for (const entry of Deno.readDirSync(directory)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      Deno.removeSync(new URL(entry.name, directory));
    }
  }
  for (const [name, text] of built.files) {
    Deno.writeTextFileSync(new URL(name, directory), text);
    console.log(`wrote fixtures/validate/${name}`);
  }
}

// The synthetic module generator for the measurements M2, M5, and M6.
//
// `generateProject` is a pure function. It returns the text of a valid
// Effektive project: `effektive.json`, one `base.eff` module, a chain of
// feature modules `m00.eff`, `m01.eff`, and so on, an `app.eff` module, the
// host interface file, and the TypeScript host module. The scale parameter is
// the number of declarations in the feature modules. The same options always
// give the same text, because a seeded generator makes every random choice.
//
// The feature modules use the features of the five examples: types, brands,
// errors, services, providers through the host module, explicit and inferred
// contracts, `match`, `try` and `catch`, `retry`, `provide`, pipelines with
// `map`, `filter`, and `fold`, records with spread, and options.

/** The number of feature declarations for each named size. */
export const SIZES = {
  small: 30,
  medium: 300,
  large: 3000,
} as const;

export type SizeName = keyof typeof SIZES;

export const SIZE_NAMES: readonly SizeName[] = ["small", "medium", "large"];

/** The most feature declarations in one feature module. */
export const DECLARATIONS_PER_MODULE = 60;

export interface GenerateOptions {
  /** The number of declarations in the feature modules. At least 8. */
  readonly declarations: number;
  /** The seed of the random choices. */
  readonly seed: number;
}

/** Where the edit scripts of the incremental measurement apply. */
export interface EditTarget {
  /** The feature module that the edits change. */
  readonly path: string;
  /** The path of the module that imports the edited module. */
  readonly importer: string;
}

export interface GeneratedProject {
  readonly declarations: number;
  readonly seed: number;
  /** The files that the program reads: `effektive.json`, `.eff`, and `.effi` files. */
  readonly sources: ReadonlyMap<string, string>;
  /** The TypeScript host modules, keyed by root-relative path. */
  readonly hostModules: ReadonlyMap<string, string>;
  /** The feature module names in import order. */
  readonly featureModules: readonly string[];
  readonly edit: EditTarget;
}

/** All files of the project: the sources and the host modules. */
export function allFiles(project: GeneratedProject): Map<string, string> {
  return new Map([...project.sources, ...project.hostModules]);
}

// ------------------------------------------------------------------ random

/** A small seeded generator (mulberry32). */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ fixed text

/**
 * The alias declarations that rule R1 requires. A primitive type can occur
 * only inside a type declaration. Each name has identity, so `base.eff`
 * declares each name once and every other module imports it.
 */
const ALIAS_LINES: readonly string[] = [
  `export type Int = int`,
  `export type Num = number`,
  `export type Text = string`,
];

const ALIASES = ALIAS_LINES.join("\n");

const BASE = `export nominal Id = string
export type Status = "open" | "done"
export type Item = {
  id: Id,
  name: string,
  qty: int,
  status: Status,
  tag?: string,
  note: Option<string>
}
export type Shape = { kind: "circle", radius: number } | { kind: "square", side: number }

export error NotFound = { id: Id }
export error Declined = { reason: string }

export service Store {
  find(id: Id): Option<Item> fails NotFound
  save(item: Item): void
  list(): Item[]
}

export service Gate {
  charge(amount: Int): Text fails Declined
}

${ALIASES}
`;

const CONFIG = `{
  "host": {
    "providers": {
      "interface": "./host/providers.effi",
      "module": "./store-live.ts"
    }
  }
}
`;

const PROVIDERS = `import { Gate, Store } from "../base.eff"
export provider StoreLive provides Store
export provider GateLive provides Gate
`;

const STORE_LIVE = `// Host module for the providers in host/providers.effi.
// It keeps no state. Every lookup finds nothing.

import { Effect, Layer, Option } from "effect";
import { Gate, Store } from "./base.ts";

export const StoreLive: Layer.Layer<Store> = Layer.succeed(Store)({
  find: (_id) => Effect.succeed(Option.none()),
  save: (_item) => Effect.sync(() => {}),
  list: () => Effect.succeed([]),
});

export const GateLive: Layer.Layer<Gate> = Layer.succeed(Gate)({
  charge: (amount) => Effect.succeed(String(amount)),
});
`;

// ------------------------------------------------------------------ templates

/** The names in a module that later declarations use. */
interface ModuleNames {
  /** An effectful lookup: `(id: Id): Item fails NotFound uses Store.find`. */
  readonly get: string;
  /** A pure function: `(item: Item): Item`. */
  readonly touch: string;
  /** The exported function of the previous module, if any. */
  readonly link: string | undefined;
}

interface Slot {
  /** A number that is unique in the project and makes names unique. */
  readonly n: number;
  readonly rng: () => number;
  readonly names: ModuleNames;
}

/** A template returns one or more declarations. The first one stands alone. */
type Template = (slot: Slot) => readonly string[];

function pick(rng: () => number, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

const TEMPLATES: readonly Template[] = [
  // A record spread with arithmetic, explicit contract.
  ({ n, rng }) => [
    `export const rec${n} = (item: Item, by: Int): Item =>
  ({ ...item, qty: item.qty + by + ${pick(rng, 1, 99)} })`,
  ],
  // An inferred pure helper and an exported user of it.
  ({ n, rng }) => [
    `const calc${n} = (x: Int, y: Int) => x * ${pick(rng, 2, 9)} + y`,
    `export const use${n} = (x: Int): Int => calc${n}(x, ${pick(rng, 1, 50)})`,
  ],
  // An inferred effectful helper and an exported user with an explicit contract.
  ({ n }) => [
    `const look${n} = (id: Id) => Store.find(id)`,
    `export const peek${n} = (id: Id): Option<Item>
  fails NotFound
  uses Store.find =>
  look${n}(id)`,
  ],
  // A match on an option.
  ({ n }) => [
    `export const get${n} = (id: Id): Item
  fails NotFound
  uses Store.find =>
  match Store.find(id) {
    Some(item) => item,
    None => fail(NotFound({ id }))
  }`,
  ],
  // A match on a literal union.
  ({ n, rng }) => [
    `export const label${n} = (s: Status, n: Int): Text =>
  match s {
    "open" => "open${pick(rng, 1, 99)}",
    "done" => "done"
  }`,
  ],
  // A match on a tagged record union.
  ({ n }) => [
    `export const extent${n} = (s: Shape): Num =>
  match s {
    { kind: "circle", ...c } => c.radius,
    { kind: "square", ...q } => q.side
  }`,
  ],
  // try and catch around an effectful call.
  ({ n, names }) => [
    `export const safe${n} = (id: Id): Text
  uses Store.find =>
  try {
    ${names.get}(id).name
  } catch {
    NotFound(e) => "none"
  }`,
  ],
  // retry with a service method that fails.
  ({ n, rng }) => [
    `export const charge${n} = (item: Item): Item
  fails Declined
  uses Gate.charge => {
  retry(() => Gate.charge(item.qty), { times: ${pick(rng, 1, 4)} })
  item
}`,
  ],
  // A pure pipeline with filter and map.
  ({ n, rng }) => [
    `export const names${n} = (items: Item[]): Text[] =>
  items
    |> filter((it) => it.qty > ${pick(rng, 1, 99)})
    |> map((it) => it.name)`,
  ],
  // A pure pipeline with fold.
  ({ n, rng }) => [
    `export const sum${n} = (items: Item[]): Int =>
  items |> fold(${pick(rng, 0, 9)}, (acc, it) => acc + it.qty)`,
  ],
  // An effectful pipeline from a service call.
  ({ n, rng }) => [
    `export const list${n} = (): Text[]
  uses Store.list =>
  Store.list()
    |> filter((it) => it.qty > ${pick(rng, 1, 99)})
    |> map((it) => it.name)`,
  ],
  // A pipeline of function stages.
  ({ n, names }) => [
    `export const flow${n} = (id: Id): Item
  fails NotFound
  uses Store.find =>
  id
    |> ${names.get}
    |> ${names.touch}`,
  ],
  // A block with bindings and a service call that returns void.
  ({ n, names }) => [
    `export const upd${n} = (id: Id, name: Text): Item
  fails NotFound
  uses Store.find | Store.save => {
  const item = ${names.get}(id)
  const next: Item = { ...item, name }
  Store.save(next)
  next
}`,
  ],
  // provide with a provider from the host module.
  ({ n, names }) => [
    `export const run${n} = (raw: Text): Text
  fails NotFound =>
  provide(StoreLive, () => ${names.get}(Id(raw)).name)`,
  ],
  // provide with a second provider.
  ({ n, rng }) => [
    `export const pay${n} = (item: Item): Item
  fails Declined =>
  provide(GateLive, () => {
    retry(() => Gate.charge(item.qty), { times: ${pick(rng, 1, 3)} })
    item
  })`,
  ],
  // A constant with an annotation.
  ({ n, rng }) => [`export const limit${n}: Int = ${pick(rng, 1, 9999)}`],
  // A conditional and a brand converted to another identity.
  ({ n, rng }) => [
    `export const tier${n} = (n: Int): Text =>
  if (n > ${pick(rng, 1, 99)}) { "high" } else { "low" }`,
    `export const raw${n} = (id: Id): Text => Text(id)`,
  ],
  // A record type with an optional field and an option field.
  ({ n }) => [
    `export type Row${n} = {
  id: Id,
  count: int,
  label?: string,
  note: Option<string>
}`,
  ],
  // A nominal type and an error type.
  ({ n }) => [
    `export nominal Tag${n} = string`,
    `export error Fail${n} = { message: string, code: int }`,
  ],
  // A function type alias and a function that returns a closure.
  ({ n, rng }) => [
    `export type Op${n} = (n: int) => int`,
    `export const adder${n} = (by: Int): Op${n} => (x) => x + by + ${
      pick(rng, 1, 9)
    }`,
  ],
  // A call into the previous module.
  ({ n, names }) =>
    names.link === undefined
      ? [`export const solo${n}: Int = ${n}`]
      : [`export const via${n} = (x: Int): Int => ${names.link}(x) + 1`],
];

// ------------------------------------------------------------------ the project

function moduleName(index: number): string {
  return `m${String(index).padStart(2, "0")}`;
}

/**
 * The feature declarations in the project. At least 8, because the prologue of
 * the edited module holds eight declarations and the edit functions need them.
 */
export const MIN_DECLARATIONS = 8;

/**
 * The first declarations of every feature module. They give the later
 * declarations their dependencies: `get`, `touch`, and the link function.
 */
function prologue(
  index: number,
  isEditModule: boolean,
): { names: ModuleNames; declarations: string[] } {
  const name = moduleName(index);
  const previous = index === 0 ? undefined : `link${index - 1}`;
  const names: ModuleNames = {
    get: `get${name}`,
    touch: `touch${name}`,
    link: previous,
  };
  const declarations = [
    `export const link${index} = (n: Int): Int => n + ${index + 1}`,
    `export const ${names.get} = (id: Id): Item
  fails NotFound
  uses Store.find =>
  match Store.find(id) {
    Some(item) => item,
    None => fail(NotFound({ id }))
  }`,
    `export const ${names.touch} = (item: Item): Item =>
  ({ ...item, qty: item.qty + ${index + 1} })`,
  ];
  if (isEditModule) {
    declarations.push(
      `export const bump = (n: Int): Int => n + 1`,
      `export const extra: Int = 1`,
      `export const flip = (n: Int): Int => n + 1`,
      `export type Amount = int`,
      `export const scale = (a: Amount): Amount => a`,
    );
  }
  return { names, declarations };
}

function importsOf(index: number): string {
  const lines = [
    `import { Declined, Gate, Id, Int, Item, NotFound, Num, Shape, Status, Store, Text } from "./base.eff"`,
    `import { GateLive, StoreLive } from "host:providers"`,
  ];
  if (index > 0) {
    lines.push(
      `import { link${index - 1} } from "./${moduleName(index - 1)}.eff"`,
    );
  }
  return lines.join("\n");
}

/** Generates a project. Pure and deterministic: equal options give equal text. */
export function generateProject(options: GenerateOptions): GeneratedProject {
  if (
    !Number.isInteger(options.declarations) ||
    options.declarations < MIN_DECLARATIONS
  ) {
    throw new Error(
      `declarations must be an integer of at least ${MIN_DECLARATIONS}`,
    );
  }
  const total = options.declarations;
  const rng = makeRandom(options.seed);
  const moduleCount = Math.ceil(total / DECLARATIONS_PER_MODULE);
  const editIndex = Math.floor(moduleCount / 2);
  const sources = new Map<string, string>();
  const featureModules: string[] = [];
  let unique = 0;
  let remaining = total;

  for (let index = 0; index < moduleCount; index++) {
    // Spread the declarations evenly over the modules.
    const share = Math.ceil(remaining / (moduleCount - index));
    remaining -= share;
    const opening = prologue(index, index === editIndex);
    const declarations = opening.declarations.slice(0, share);
    while (declarations.length < share) {
      const template = TEMPLATES[Math.floor(rng() * TEMPLATES.length)];
      if (template === undefined) throw new Error("no template");
      unique++;
      const made = template({ n: unique, rng, names: opening.names });
      declarations.push(...made.slice(0, share - declarations.length));
    }
    const name = moduleName(index);
    featureModules.push(name);
    sources.set(
      `${name}.eff`,
      `${importsOf(index)}\n\n${declarations.join("\n\n")}\n`,
    );
  }

  const last = moduleName(moduleCount - 1);
  sources.set("base.eff", BASE);
  sources.set(
    "app.eff",
    `import { Id, Int, Item, NotFound, Text } from "./base.eff"
import { StoreLive } from "host:providers"
import { get${last}, link${moduleCount - 1} } from "./${last}.eff"

export const main = (raw: Text): Text
  fails NotFound =>
  provide(StoreLive, () => get${last}(Id(raw)).name)

export const total = (n: Int): Int => link${moduleCount - 1}(n)
`,
  );
  sources.set("effektive.json", CONFIG);
  sources.set("host/providers.effi", PROVIDERS);

  const editName = moduleName(editIndex);
  return {
    declarations: total,
    seed: options.seed,
    sources,
    hostModules: new Map([["store-live.ts", STORE_LIVE]]),
    featureModules,
    edit: {
      path: `${editName}.eff`,
      importer: editIndex + 1 < moduleCount
        ? `${moduleName(editIndex + 1)}.eff`
        : "app.eff",
    },
  };
}

export function generateSize(size: SizeName, seed = 1): GeneratedProject {
  return generateProject({ declarations: SIZES[size], seed });
}

/**
 * The count of top-level declarations in the feature modules, from the text.
 * A declaration starts at the beginning of a line with `export`, `const`,
 * `type`, `error`, `service`, or `provider`.
 */
export function countDeclarations(project: GeneratedProject): number {
  let count = 0;
  for (const name of project.featureModules) {
    const text = project.sources.get(`${name}.eff`) ?? "";
    for (const line of text.split("\n")) {
      if (/^(export |const |type |error |service |provider )/.test(line)) {
        count++;
      }
    }
  }
  return count;
}

// ------------------------------------------------------------------ edits

/**
 * A body edit: changes a literal in the body of `bump`. The interface of the
 * module does not change. Revision `k` writes the literal `k`.
 */
export function applyBodyEdit(text: string, revision: number): string {
  return text.replace(
    /(export const bump = \(n: Int\): Int => n \+ )\d+/,
    `$1${revision}`,
  );
}

/**
 * An interface edit: toggles the annotated type of `extra` between the aliases
 * `Int` and `Num`. The two aliases are different named types, so each call
 * changes the interface hash of the module.
 */
export function applyInterfaceEdit(text: string): string {
  return text.replace(
    /export const extra: (Int|Num) = 1/,
    (_match, type: string) =>
      `export const extra: ${type === "Int" ? "Num" : "Int"} = 1`,
  );
}

/**
 * A mode flip edit: toggles the body of `flip` between `n + 1` and
 * `retry(() => n + 1, { times: 1 })`. Both forms check with no diagnostic. The
 * second has the mode `effect`, so each call changes the mode map and, because
 * the interface payload holds the mode, the interface hash of the module.
 */
export function applyModeFlipEdit(text: string): string {
  return text.replace(
    /(export const flip = \(n: Int\): Int => )(n \+ 1|retry\(\(\) => n \+ 1, \{ times: 1 \}\))/,
    (_match, head: string, body: string) =>
      `${head}${
        body === "n + 1" ? "retry(() => n + 1, { times: 1 })" : "n + 1"
      }`,
  );
}

/**
 * An alias edit: toggles the alias `Amount` between `int` and `number`. The
 * exported function `scale` names the alias in its parameter and its result, so
 * each call changes the interface hash of the module. Both states check with
 * no diagnostic, and no importer names the alias.
 */
export function applyAliasEdit(text: string): string {
  return text.replace(
    /export type Amount = (int|number)\n/,
    (_match, type: string) =>
      `export type Amount = ${type === "int" ? "number" : "int"}\n`,
  );
}

/**
 * The body edit for the five examples: changes the string literal of the
 * `UserMissing` handler in the body of `displayName` in `users.eff`. Revision
 * `k` writes `"Guest<k>"`. The interface of the module does not change.
 */
export function applyExamplesBodyEdit(text: string, revision: number): string {
  return text.replace(
    /(UserMissing\(error\) => "Guest)\d*"/,
    `$1${revision}"`,
  );
}

// ------------------------------------------------------------------ command line

/** Writes a generated project to a directory: `deno run bench/generate.ts <size> <dir>`. */
if (import.meta.main) {
  const [sizeArg, directory] = Deno.args;
  const size = SIZE_NAMES.find((name) => name === sizeArg);
  if (size === undefined || directory === undefined) {
    console.error(
      `usage: deno run --allow-write bench/generate.ts <${
        SIZE_NAMES.join("|")
      }> <directory>`,
    );
    Deno.exit(2);
  }
  const project = generateSize(size);
  for (const [path, text] of allFiles(project)) {
    const full = `${directory}/${path}`;
    Deno.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(full, text);
  }
  console.log(
    `wrote ${
      project.sources.size + project.hostModules.size
    } files to ${directory}`,
  );
}

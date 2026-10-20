// Records the observable compiler behavior of a git revision. Each hook records
// a hash of one result that the fast and slow test suites produce, including
// inline test sources and the results of subprocesses:
//   check          the diagnostic list of every `checkAnalysis` call
//   program        the diagnostic list of every successful `Program.update`
//   program-error  the `ConfigError` of every failed `Program.update`
//   lower          `serializeModule` of every `lowerModule` result
//   lower-error    the `LowerError` of every failed `lowerModule`
//   emit           the module of every `emitModule` success
//   emit-error     the `EmitError` of every failed `emitModule`
//   validate       the result of every `validateModule` call
//
// A `check`, `program`, or `validate` record also holds a hash of its input:
// the module paths and source texts, or the IR and its sources. Without it,
// every clean result gives the same record, and a new test with a clean program
// hides a program that gains a diagnostic. The other kinds write `-`, because
// their results already name their input.
//
// Run `deno task behavior:capture <base-rev> <head-rev>` before a refactor is
// merged. The script exports each revision into a temporary tree, adds the
// recording hooks there, runs the tests, and compares the two sorted record
// sets. A base record that is missing from the head means a behavior change;
// new head records come from added tests. With one revision, it prints the
// record set. The tree does not run the capture tests: they would run the
// capture again.

import type { Result } from "../src/core/mod.ts";

/** One text replacement that adds the recording hook to a source file. */
interface Hook {
  readonly path: string;
  readonly importLine: string;
  readonly anchor: string;
  readonly replacement: string;
}

/**
 * The text of the hook module. The records path is a string literal, so a
 * process that has write permission records without environment permission.
 */
function hookModule(records: string): string {
  return `// Behavior capture hook: written only into a temporary tree.
const RECORDS = ${JSON.stringify(records)};
function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b ^ c, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
export function capture(kind: string, value: unknown, input?: unknown): void {
  try {
    const text = JSON.stringify(value);
    const from = input === undefined ? "-" : hash(JSON.stringify(input));
    Deno.writeTextFileSync(RECORDS, \`\${kind} \${from} \${hash(text)} \${text.length}\\n\`, { append: true });
  } catch (cause) {
    throw new Error(\`behavior capture could not record to \${RECORDS}\`, { cause });
  }
}
`;
}

// A function hook replaces the text `export function name(` with a wrapper of
// the same name, and renames the original to `nameInner`. The wrapper takes the
// parameters and the result type of the original by type, so a change of the
// signature does not break the hook. The doc comment of the original stays
// above the wrapper. A method cannot be wrapped from outside, and a private
// method cannot be named in a type. So the method hook inserts a wrapper named
// `update` before the original, and renames the original to the public method
// `updateInner`. The anchor is only the method name at its indent. Each anchor
// must occur exactly once, and a missing anchor fails the capture.
const HOOKS: readonly Hook[] = [
  {
    path: "src/core/emit/emit.ts",
    importLine: 'import { capture } from "../capture_hook.ts";\n',
    anchor: "export function emitModule(",
    replacement: `export function emitModule(
  ...args: Parameters<typeof emitModuleInner>
): ReturnType<typeof emitModuleInner> {
  const result = emitModuleInner(...args);
  if (result.ok) capture("emit", result.value);
  else capture("emit-error", result.error);
  return result;
}

function emitModuleInner(`,
  },
  {
    path: "src/core/check_project.ts",
    importLine: 'import { capture } from "./capture_hook.ts";\n',
    anchor: "export function checkAnalysis(",
    replacement: `export function checkAnalysis(
  ...args: Parameters<typeof checkAnalysisInner>
): ReturnType<typeof checkAnalysisInner> {
  const result = checkAnalysisInner(...args);
  const [analysis] = args;
  capture(
    "check",
    result.diagnostics,
    [...analysis.project.modules.values()]
      .map((m) => [m.path, m.tree.text])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
  return result;
}

function checkAnalysisInner(`,
  },
  {
    path: "src/core/lower.ts",
    importLine:
      'import { capture } from "./capture_hook.ts";\nimport { serializeModule as captureSerialize } from "./serialize.ts";\n',
    anchor: "export function lowerModule(",
    replacement: `export function lowerModule(
  ...args: Parameters<typeof lowerModuleInner>
): ReturnType<typeof lowerModuleInner> {
  const result = lowerModuleInner(...args);
  if (result.ok) capture("lower", captureSerialize(result.value));
  else capture("lower-error", result.error);
  return result;
}

function lowerModuleInner(`,
  },
  {
    path: "src/core/db.ts",
    importLine: 'import { capture } from "./capture_hook.ts";\n',
    anchor: "\n  update(",
    replacement: `
  update(
    ...args: Parameters<Program["updateInner"]>
  ): ReturnType<Program["updateInner"]> {
    const result = this.updateInner(...args);
    const input = [...this.files].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    );
    if (result.ok) capture("program", result.value.diagnostics, input);
    else capture("program-error", result.error);
    return result;
  }

  updateInner(`,
  },
  {
    // The validator imports only its own files, so it gets its own hook copy.
    path: "src/core/validate/index.ts",
    importLine: 'import { capture } from "./capture_hook.ts";\n',
    anchor: "export function validateModule(",
    replacement: `export function validateModule(
  ...args: Parameters<typeof validateModuleInner>
): ReturnType<typeof validateModuleInner> {
  const result = validateModuleInner(...args);
  const [ir, sources] = args;
  capture("validate", result, [
    ir,
    [...sources].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ]);
  return result;
}

function validateModuleInner(`,
  },
];

/** The hook module paths, relative to the repository root. */
export const HOOK_PATHS: readonly string[] = [
  "src/core/capture_hook.ts",
  "src/core/validate/capture_hook.ts",
];

/**
 * The instrumented texts of the hooked source files and the hook modules. An
 * error names each hook whose anchor no longer occurs exactly once, so a change
 * of an entry point shows here and not as a silent empty capture. `records` is
 * the file that the hooks append to.
 */
export function instrumentSources(
  read: (path: string) => string,
  records: string,
): Result<ReadonlyMap<string, string>, readonly string[]> {
  const files = new Map<string, string>();
  const missing: string[] = [];
  for (const hook of HOOKS) {
    const text = read(hook.path);
    if (text.split(hook.anchor).length !== 2) {
      missing.push(`${hook.path}: ${hook.anchor.trim()}`);
      continue;
    }
    files.set(
      hook.path,
      hook.importLine + text.replace(hook.anchor, () => hook.replacement),
    );
  }
  if (missing.length > 0) return { ok: false, error: missing };
  const module = hookModule(records);
  for (const path of HOOK_PATHS) files.set(path, module);
  return { ok: true, value: files };
}

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The test runs of a capture. The runs leave out the capture tests: they read
 * the hook anchors, which the instrumented tree no longer has, and they would
 * run the capture again.
 */
const CAPTURE_TESTS: readonly (readonly string[])[] = [
  [
    "test",
    "--allow-all",
    "--ignore=**/*_slow_test.ts,tests/behavior_capture*_test.ts",
    "tests/",
  ],
  [
    "test",
    "--allow-all",
    "--permit-no-files",
    "--ignore=tests/behavior_capture*_test.ts",
    "tests/**/*_slow_test.ts",
  ],
];

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<boolean> {
  const result = await new Deno.Command(command, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const decoder = new TextDecoder();
    const output = decoder.decode(result.stdout) +
      decoder.decode(result.stderr);
    console.error(output.split("\n").slice(-40).join("\n"));
  }
  return result.success;
}

/** Captures one revision: its sorted records, or why the capture failed. */
async function captureRevision(
  revision: string,
): Promise<Result<readonly string[], string>> {
  const tree = Deno.makeTempDirSync({ prefix: "effective-capture-" });
  try {
    const archive = `${tree}.tar`;
    if (
      !await run("git", ["archive", "-o", archive, revision], ROOT) ||
      !await run("tar", ["-xf", archive, "-C", tree], ROOT)
    ) return { ok: false, error: `cannot export revision ${revision}` };
    Deno.removeSync(archive);
    const records = `${tree}/capture.records`;
    const files = instrumentSources(
      (path) => Deno.readTextFileSync(`${tree}/${path}`),
      records,
    );
    if (!files.ok) {
      return {
        ok: false,
        error: `hook anchors not found:\n${files.error.join("\n")}`,
      };
    }
    for (const [path, text] of files.value) {
      Deno.writeTextFileSync(`${tree}/${path}`, text);
    }
    const deno = Deno.execPath();
    for (const args of CAPTURE_TESTS) {
      if (!await run(deno, args, tree)) {
        return {
          ok: false,
          error: `tests failed at ${revision}: deno ${args.join(" ")}`,
        };
      }
    }
    return {
      ok: true,
      value: Deno.readTextFileSync(records).split("\n")
        .filter((l) => l !== "").sort(),
    };
  } finally {
    Deno.removeSync(tree, { recursive: true });
  }
}

/** Counts records by kind, such as `emit`, `check`, and `lower`. */
function summary(records: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const kind = record.split(" ", 1)[0];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ");
}

/** Removes each record of `remove` once from `from`, as a multiset. */
function difference(
  from: readonly string[],
  remove: readonly string[],
): string[] {
  const left = new Map<string, number>();
  for (const r of remove) left.set(r, (left.get(r) ?? 0) + 1);
  return from.filter((r) => {
    const n = left.get(r) ?? 0;
    if (n === 0) return true;
    left.set(r, n - 1);
    return false;
  });
}

if (import.meta.main) {
  const [base, head] = Deno.args;
  if (base === undefined || Deno.args.length > 2) {
    console.error(
      "usage: deno task behavior:capture <base-rev> [<head-rev>]",
    );
    Deno.exit(2);
  }
  const capture = async (revision: string) => {
    const result = await captureRevision(revision);
    if (!result.ok) {
      console.error(result.error);
      Deno.exit(1);
    }
    return result.value;
  };
  const before = await capture(base);
  console.log(`${base}: ${before.length} records (${summary(before)})`);
  if (head === undefined) {
    console.log(before.join("\n"));
    Deno.exit(0);
  }
  const after = await capture(head);
  console.log(`${head}: ${after.length} records (${summary(after)})`);
  const missing = difference(before, after);
  const added = difference(after, before);
  console.log(`new in ${head}: ${added.length} (${summary(added)})`);
  console.log(`missing in ${head}: ${missing.length}`);
  if (missing.length > 0) {
    console.log(missing.join("\n"));
    Deno.exit(1);
  }
}

// Records the observable compiler behavior of a git revision: a hash of every
// emitted module, every checker diagnostic list, and every validator result
// that the fast and slow test suites produce, including inline test sources.
//
// Run `deno task behavior:capture <base-rev> <head-rev>` before a refactor is
// merged. The script exports each revision into a temporary tree, adds a
// recording hook there, runs the tests, and compares the two sorted record sets.
// A base record that is missing from the head means a behavior change; new head
// records come from added tests. With one revision, it prints the record set.

import type { Result } from "../src/core/mod.ts";

/** One text replacement that adds the recording hook to a source file. */
interface Hook {
  readonly path: string;
  readonly importLine: string;
  readonly anchor: string;
  readonly replacement: string;
}

const HOOK_MODULE =
  `// Behavior capture hook: written only into a temporary tree.
function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b ^ c, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
export function capture(kind: string, value: unknown): void {
  let file: string | undefined;
  try { file = Deno.env.get("EFFECTIVE_CAPTURE"); } catch { return; }
  if (file === undefined) return;
  try {
    const text = JSON.stringify(value);
    Deno.writeTextFileSync(file, \`\${kind} \${hash(text)} \${text.length}\\n\`, { append: true });
  } catch { /* a process without write permission records nothing */ }
}
`;

const HOOKS: readonly Hook[] = [
  {
    path: "src/core/emit/emit.ts",
    importLine: 'import { capture } from "../capture_hook.ts";\n',
    anchor: "    return { ok: true, value: build(ir, context) };",
    replacement:
      '    const value = build(ir, context);\n    capture("emit", value);\n    return { ok: true, value };',
  },
  {
    path: "src/core/check_project.ts",
    importLine: 'import { capture } from "./capture_hook.ts";\n',
    anchor: "  return { ok: true, value: checkAnalysis(analysis.value) };",
    replacement:
      '  const value = checkAnalysis(analysis.value);\n  capture("check", value.diagnostics);\n  return { ok: true, value };',
  },
  {
    // The validator imports only its own files, so it gets its own hook copy.
    path: "src/core/validate/index.ts",
    importLine: 'import { capture } from "./capture_hook.ts";\n',
    anchor: "export function validateModule(",
    replacement:
      'export function validateModule(...args: Parameters<typeof validateModuleInner>): ReturnType<typeof validateModuleInner> {\n  const result = validateModuleInner(...args);\n  capture("validate", result);\n  return result;\n}\n\nfunction validateModuleInner(',
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
 * of an entry point shows here and not as a silent empty capture.
 */
export function instrumentSources(
  read: (path: string) => string,
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
      hook.importLine + text.replace(hook.anchor, hook.replacement),
    );
  }
  if (missing.length > 0) return { ok: false, error: missing };
  for (const path of HOOK_PATHS) files.set(path, HOOK_MODULE);
  return { ok: true, value: files };
}

const ROOT = new URL("..", import.meta.url).pathname;

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<boolean> {
  const result = await new Deno.Command(command, {
    args: [...args],
    cwd,
    env,
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
    const files = instrumentSources((path) =>
      Deno.readTextFileSync(`${tree}/${path}`)
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
    const records = `${tree}/capture.records`;
    const env = { EFFECTIVE_CAPTURE: records };
    const deno = Deno.execPath();
    for (
      const args of [
        ["test", "--allow-all", "--ignore=**/*_slow_test.ts", "tests/"],
        ["test", "--allow-all", "--permit-no-files", "tests/**/*_slow_test.ts"],
      ]
    ) {
      if (!await run(deno, args, tree, env)) {
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

/** Counts records by kind: `emit`, `check`, and `validate`. */
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

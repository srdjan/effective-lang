// The inputs of the M5 measurement: the emitted examples and the emitted
// synthetic projects, as maps of TypeScript files, and the error values of the
// measurement. Nothing here runs a type check.

import { errorMessage, Program } from "../src/core/mod.ts";
import type { Result } from "../src/core/source.ts";
import { generateProject } from "./generate.ts";

export type M5Error =
  | { readonly tag: "setup"; readonly message: string }
  | {
    readonly tag: "check-failed";
    readonly tool: string;
    readonly target: string;
    readonly code: number;
    readonly stderr: string;
  }
  | {
    readonly tag: "golden-mismatch";
    readonly target: string;
    readonly path: string;
  };

export function describeM5Error(error: M5Error): string {
  switch (error.tag) {
    case "setup":
      return `setup failed: ${error.message}`;
    case "check-failed":
      return `${error.tool} failed on ${error.target} with exit code ${error.code}:\n${
        error.stderr.split("\n").slice(0, 12).join("\n")
      }`;
    case "golden-mismatch":
      return `${error.target}: emitted ${error.path} differs from the golden file`;
  }
}

export interface M5SizeConfig {
  readonly name: string;
  readonly declarations: number;
}

/** The files of one check: generated and host TypeScript by root-relative path. */
export interface Target {
  readonly name: string;
  readonly files: ReadonlyMap<string, string>;
  /** The path that receives the unique comment. */
  readonly marked: string;
}

function readTree(
  root: string,
  relative: string,
  into: Map<string, string>,
): void {
  for (const entry of Deno.readDirSync(`${root}/${relative}`)) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory) readTree(root, child, into);
    else into.set(child, Deno.readTextFileSync(`${root}/${child}`));
  }
}

/** Emits every module of a project in memory. Returns the generated files by path. */
export function emitSources(
  sources: ReadonlyMap<string, string>,
): Result<Map<string, string>, M5Error> {
  const program = new Program("");
  const updated = program.update({ set: sources });
  if (!updated.ok) {
    return {
      ok: false,
      error: { tag: "setup", message: `project: ${updated.error.tag}` },
    };
  }
  const revision = updated.value;
  if (revision.diagnostics.length > 0) {
    const d = revision.diagnostics[0];
    return {
      ok: false,
      error: {
        tag: "setup",
        message:
          `${revision.diagnostics.length} diagnostics, first: ${d?.span.source}: ${d?.code}`,
      },
    };
  }
  const generated = new Map<string, string>();
  for (const name of revision.effModuleNames()) {
    const emitted = revision.emitted(name);
    if (emitted === undefined || !emitted.ok) {
      return {
        ok: false,
        error: { tag: "setup", message: `cannot emit ${name}` },
      };
    }
    generated.set(emitted.value.path, emitted.value.text);
  }
  return { ok: true, value: generated };
}

/** The five examples, emitted, with `users-live.ts`. The gate compares them with the golden files. */
export function exampleTarget(): Result<Target, M5Error> {
  const fixtures = new URL("../fixtures/", import.meta.url).pathname;
  const tree = new Map<string, string>();
  try {
    readTree(`${fixtures}examples`, "", tree);
  } catch (e) {
    return {
      ok: false,
      error: {
        tag: "setup",
        message: errorMessage(e),
      },
    };
  }
  const sources = new Map(
    [...tree].filter(([p]) =>
      p.endsWith(".eff") || p.endsWith(".effi") || p === "effective.json"
    ),
  );
  const generated = emitSources(sources);
  if (!generated.ok) return generated;
  const files = new Map(generated.value);
  for (const [path, text] of generated.value) {
    let golden: string;
    try {
      golden = Deno.readTextFileSync(`${fixtures}golden/${path}`);
    } catch (e) {
      return {
        ok: false,
        error: {
          tag: "setup",
          message: errorMessage(e),
        },
      };
    }
    if (golden !== text) {
      return {
        ok: false,
        error: { tag: "golden-mismatch", target: "examples", path },
      };
    }
  }
  const host = tree.get("users-live.ts");
  if (host === undefined) {
    return {
      ok: false,
      error: {
        tag: "setup",
        message: "fixtures/examples/users-live.ts is missing",
      },
    };
  }
  files.set("users-live.ts", host);
  return { ok: true, value: { name: "examples", files, marked: "main.ts" } };
}

export function syntheticTarget(
  size: M5SizeConfig,
  seed: number,
): Result<Target, M5Error> {
  const project = generateProject({ declarations: size.declarations, seed });
  const generated = emitSources(project.sources);
  if (!generated.ok) return generated;
  const files = new Map(generated.value);
  for (const [path, text] of project.hostModules) files.set(path, text);
  return {
    ok: true,
    value: { name: `synthetic ${size.name}`, files, marked: "app.ts" },
  };
}

/** Writes the files of a target. The marked file gets a unique comment at its end. */
export function writeTarget(
  directory: string,
  target: Target,
  mark: string,
): void {
  for (const [path, text] of target.files) {
    const full = `${directory}/${path}`;
    Deno.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(
      full,
      path === target.marked ? `${text}// bench ${mark}\n` : text,
    );
  }
}

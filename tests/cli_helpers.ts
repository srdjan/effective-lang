// In-memory doubles for the command-line tests: a file system in a map, a
// recorded `deno check` runner, and a scripted watch source.

import type {
  CliIo,
  DenoCheckRequest,
  DenoCheckRun,
  DirectoryEntry,
  FileFailure,
} from "../src/host/io.ts";
import type { ReadError, Result } from "../src/core/source.ts";

export interface MemoryIo {
  readonly io: CliIo;
  /** Every file, by the path that the CLI uses: the root joined with the relative path. */
  readonly files: Map<string, string>;
  /** Everything written to stdout and stderr, in order. */
  readonly out: string[];
  readonly err: string[];
  readonly checks: DenoCheckRequest[];
  /** Paths whose write fails. */
  readonly unwritable: Set<string>;
  /** Batches that `io.watch` yields. A batch may be a function that changes `files` first. */
  script: (() => readonly string[] | void)[];
  /** The output of the next `deno check`. */
  denoCheckStderr: string;
  denoCheckCode: number;
}

export interface MemoryOptions {
  readonly stderr?: string;
  readonly code?: number;
}

/** Makes an in-memory io. `files` maps full paths (root included) to texts. */
export function memoryIo(
  files: Readonly<Record<string, string>>,
  options: MemoryOptions = {},
): MemoryIo {
  const map = new Map(Object.entries(files));
  const state: Omit<MemoryIo, "io"> = {
    files: map,
    out: [],
    err: [],
    checks: [],
    unwritable: new Set(),
    script: [],
    denoCheckStderr: options.stderr ?? "",
    denoCheckCode: options.code ?? 0,
  };
  const prefixOf = (dir: string): string =>
    dir === "." || dir === "" ? "" : dir.replace(/\/+$/, "") + "/";
  const io: CliIo = {
    stdout: (text) => {
      state.out.push(text);
    },
    stderr: (text) => {
      state.err.push(text);
    },
    fs: {
      readText(path: string): Result<string, ReadError> {
        const text = map.get(path);
        return text === undefined
          ? { ok: false, error: { tag: "not-found", path } }
          : { ok: true, value: text };
      },
      writeText(path: string, text: string): Result<void, FileFailure> {
        if (state.unwritable.has(path)) {
          return { ok: false, error: { message: "permission denied" } };
        }
        map.set(path, text);
        return { ok: true, value: undefined };
      },
      remove(path: string): Result<void, FileFailure> {
        if (state.unwritable.has(path)) {
          return { ok: false, error: { message: "permission denied" } };
        }
        map.delete(path);
        return { ok: true, value: undefined };
      },
      kind(path: string) {
        if (map.has(path)) return "file";
        const prefix = prefixOf(path);
        for (const key of map.keys()) {
          if (key.startsWith(prefix) && key !== path) return "directory";
        }
        return "missing";
      },
      list(path: string): Result<readonly DirectoryEntry[], FileFailure> {
        const prefix = prefixOf(path);
        const found = new Map<string, boolean>();
        for (const key of map.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) found.set(rest, false);
          else found.set(rest.slice(0, slash), true);
        }
        return {
          ok: true,
          value: [...found].map(([name, isDirectory]) => ({
            name,
            isDirectory,
          })),
        };
      },
      absolute: (path) =>
        path === "." ? "/mem" : path.startsWith("/") ? path : `/mem/${path}`,
    },
    denoCheck(request): Promise<Result<DenoCheckRun, FileFailure>> {
      state.checks.push(request);
      return Promise.resolve({
        ok: true,
        value: { code: state.denoCheckCode, stderr: state.denoCheckStderr },
      });
    },
    watch(): AsyncIterable<readonly string[]> {
      const steps = state.script;
      return (async function* () {
        for (const step of steps) {
          const batch = step();
          yield batch ?? [];
        }
      })();
    },
  };
  return Object.assign(state, { io });
}

/** Joins the root to each relative path of a file set. */
export function under(
  root: string,
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    result[root === "." ? path : `${root}/${path}`] = text;
  }
  return result;
}

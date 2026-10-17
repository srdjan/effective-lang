// The real ports: the Deno file system, `deno check` as a subprocess, and
// `Deno.watchFs`. In the CLI, only this file and the wiring at the end of
// `main.ts` call Deno APIs.

import type { ReadError, Result } from "../core/source.ts";
import { debounceBatches } from "./events.ts";
import type {
  CliFs,
  CliIo,
  DenoCheckRequest,
  DenoCheckRun,
  DirectoryEntry,
  FileFailure,
} from "./io.ts";
import { isSourcePath } from "./workspace.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The real file system. The language server uses the same object. */
export const denoFs: CliFs = {
  readText(path: string): Result<string, ReadError> {
    try {
      return { ok: true, value: Deno.readTextFileSync(path) };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return { ok: false, error: { tag: "not-found", path } };
      }
      return {
        ok: false,
        error: { tag: "unreadable", path, message: messageOf(e) },
      };
    }
  },
  writeText(path: string, text: string): Result<void, FileFailure> {
    try {
      const slash = path.lastIndexOf("/");
      if (slash > 0) Deno.mkdirSync(path.slice(0, slash), { recursive: true });
      Deno.writeTextFileSync(path, text);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: { message: messageOf(e) } };
    }
  },
  kind(path: string): "file" | "directory" | "missing" {
    try {
      return Deno.statSync(path).isDirectory ? "directory" : "file";
    } catch {
      return "missing";
    }
  },
  list(path: string): Result<readonly DirectoryEntry[], FileFailure> {
    try {
      const entries: DirectoryEntry[] = [];
      for (const entry of Deno.readDirSync(path)) {
        // A link to a directory is a directory for the walk.
        const isDirectory = entry.isDirectory ||
          (entry.isSymlink &&
            denoFs.kind(`${path}/${entry.name}`) === "directory");
        entries.push({ name: entry.name, isDirectory });
      }
      return { ok: true, value: entries };
    } catch (e) {
      return { ok: false, error: { message: `${path}: ${messageOf(e)}` } };
    }
  },
  absolute(path: string): string {
    return Deno.realPathSync(path);
  },
};

/**
 * Runs `deno check` in the project directory. The generated configuration goes
 * to a temporary directory that the call removes, so the project directory
 * gets no new file. `--no-lock` keeps `deno check` from writing a lock file.
 */
async function denoCheck(
  request: DenoCheckRequest,
): Promise<Result<DenoCheckRun, FileFailure>> {
  let directory: string | undefined;
  try {
    directory = Deno.makeTempDirSync({ prefix: "effective-tsc-" });
    const config = `${directory}/deno.json`;
    Deno.writeTextFileSync(config, request.config);
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--no-lock", "--config", config, ...request.files],
      cwd: request.cwd,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: true,
      value: { code: output.code, stderr: decoder.decode(output.stderr) },
    };
  } catch (e) {
    return { ok: false, error: { message: messageOf(e) } };
  } finally {
    if (directory !== undefined) {
      try {
        Deno.removeSync(directory, { recursive: true });
      } catch {
        // The temporary directory stays; the system removes it later.
      }
    }
  }
}

/** The quiet time after the last file event before a rebuild starts. */
export const WATCH_DEBOUNCE_MS = 100;
/** A fallback rescan when the platform does not deliver file system events. */
const WATCH_POLL_MS = 1_000;

async function* sourceEvents(root: string): AsyncGenerator<readonly string[]> {
  const absolute = denoFs.absolute(root);
  const prefix = absolute.endsWith("/") ? absolute : `${absolute}/`;
  const watcher = Deno.watchFs(absolute, { recursive: true });
  const iterator = watcher[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const poll = new Promise<"poll">((resolve) => {
        timeout = setTimeout(() => resolve("poll"), WATCH_POLL_MS);
      });
      let result: IteratorResult<Deno.FsEvent> | "poll";
      try {
        result = await Promise.race([pending, poll]);
      } finally {
        clearTimeout(timeout);
      }
      if (result === "poll") {
        // The watch loop rescans, but an unchanged project prints nothing.
        yield [];
        continue;
      }
      if (result.done) return;
      pending = iterator.next();
      const relative = result.value.paths
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .filter(isSourcePath);
      if (relative.length > 0) yield relative;
    }
  } finally {
    watcher.close();
  }
}

export function denoIo(): CliIo {
  return {
    stdout: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    stderr: (text) => {
      Deno.stderr.writeSync(encoder.encode(text));
    },
    fs: denoFs,
    denoCheck,
    watch: (root) => debounceBatches(sourceEvents(root), WATCH_DEBOUNCE_MS),
  };
}
